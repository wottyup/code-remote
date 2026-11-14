"""Manage the local Codex and Claude Code API settings without exposing keys."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import tomllib
from pathlib import Path
from urllib.parse import urlsplit


MAX_CONFIG_BYTES = 512 * 1024
MAX_KEY_BYTES = 8 * 1024
TABLE_HEADER = re.compile(r"^\s*\[{1,2}[^\]\r\n]+\]{1,2}\s*(?:#.*)?$")
CLAUDE_MODEL_ROLES = ("sonnet", "opus", "fable", "haiku")
NATIVE_PROTOCOLS = {"codex": "responses", "claude": "anthropic"}


class NativeEngineConfigError(Exception):
    def __init__(self, message: str, *, conflict: bool = False) -> None:
        super().__init__(message)
        self.conflict = conflict


def _reject_json_constant(_: str) -> None:
    raise ValueError("JSON 中不能使用非有限数字。")


class NativeEngineConfigStore:
    def __init__(self, codex_path: Path, claude_path: Path) -> None:
        # Resolve symlinks for every read/write, so a retargeted link changes
        # the revision and an atomic replace does not remove the link itself.
        self._paths = {
            "codex": codex_path.expanduser().absolute(),
            "claude": claude_path.expanduser().absolute(),
        }
        self._lock = threading.RLock()

    def _path(self, engine: str) -> Path:
        try:
            return self._paths[engine].resolve()
        except KeyError as error:
            raise NativeEngineConfigError("不支持的引擎配置。") from error

    @staticmethod
    def _revision(path: Path, data: bytes | None) -> str:
        digest = hashlib.sha256()
        digest.update(os.fsencode(path))
        digest.update(b"\x00")
        digest.update(data if data is not None else b"\x00missing")
        return digest.hexdigest()

    @staticmethod
    def _read_bytes(path: Path) -> bytes | None:
        try:
            if not path.exists():
                return None
            if not path.is_file():
                raise NativeEngineConfigError("配置路径不是普通文件。")
            with path.open("rb") as source:
                data = source.read(MAX_CONFIG_BYTES + 1)
            if len(data) > MAX_CONFIG_BYTES:
                raise NativeEngineConfigError("配置文件超过 512 KB，请在本机编辑。")
            return data
        except OSError as error:
            raise NativeEngineConfigError("读取本机配置失败，请检查文件权限。") from error

    @staticmethod
    def _parse(engine: str, data: bytes | None) -> tuple[str, dict]:
        try:
            text = data.decode("utf-8-sig") if data is not None else ("" if engine == "codex" else "{}")
        except UnicodeDecodeError as error:
            raise NativeEngineConfigError("配置文件不是 UTF-8 编码，请在本机编辑。") from error
        try:
            parsed = (
                tomllib.loads(text)
                if engine == "codex"
                else json.loads(text, parse_constant=_reject_json_constant)
            )
        except (tomllib.TOMLDecodeError, json.JSONDecodeError, ValueError) as error:
            label = "TOML" if engine == "codex" else "JSON"
            raise NativeEngineConfigError(f"本机 {label} 配置格式无效，请先在本机修复。") from error
        if not isinstance(parsed, dict):
            raise NativeEngineConfigError("配置文件顶层必须是对象。")
        return text, parsed

    @staticmethod
    def _api_url(value: str) -> str:
        url = value.strip().rstrip("/")
        if len(url) > 2048:
            raise NativeEngineConfigError("API 地址过长。")
        try:
            parsed = urlsplit(url)
            valid = (
                parsed.scheme in {"http", "https"}
                and bool(parsed.hostname)
                and parsed.port != 0
                and not parsed.username
                and not parsed.password
                and not parsed.query
                and not parsed.fragment
            )
        except ValueError:
            valid = False
        if not valid or any(character.isspace() for character in url):
            raise NativeEngineConfigError("请输入不含账号、查询参数的 HTTP 或 HTTPS API 地址。")
        return url

    @staticmethod
    def _api_key(value: str) -> str:
        key = value.strip()
        if len(key.encode("utf-8")) > MAX_KEY_BYTES or any(ord(character) < 32 for character in key):
            raise NativeEngineConfigError("API 密钥格式无效或超过 8 KB。")
        return key

    @staticmethod
    def _codex_provider(parsed: dict) -> dict:
        providers = parsed.get("model_providers", {})
        if not isinstance(providers, dict):
            raise NativeEngineConfigError("Codex 的 model_providers 配置格式无效。")
        provider_name = parsed.get("model_provider", "openai")
        if not isinstance(provider_name, str) or not provider_name:
            raise NativeEngineConfigError("Codex 提供方名称无效。")
        provider = providers.get(provider_name, {})
        if not isinstance(provider, dict):
            raise NativeEngineConfigError("Codex 的托管提供方配置格式无效。")
        return provider

    @staticmethod
    def _claude_env(parsed: dict) -> dict:
        env = parsed.get("env", {})
        if not isinstance(env, dict):
            raise NativeEngineConfigError("Claude 的 env 配置格式无效。")
        return env

    def read(self, engine: str) -> dict:
        with self._lock:
            path = self._path(engine)
            data = self._read_bytes(path)
            _, parsed = self._parse(engine, data)
        if "model" in parsed and not isinstance(parsed["model"], str):
            raise NativeEngineConfigError("本机默认模型名称必须是文本。")
        if engine == "codex":
            provider = self._codex_provider(parsed)
            current_provider = parsed.get("model_provider", "openai")
            return {
                "engine": engine,
                "path": str(path),
                "exists": data is not None,
                "baseUrl": provider.get("base_url") if isinstance(provider.get("base_url"), str) else "",
                "hasKey": isinstance(provider.get("experimental_bearer_token"), str) and bool(provider.get("experimental_bearer_token")),
                "authMode": "bearer",
                "enabled": bool(provider.get("base_url") and provider.get("experimental_bearer_token")),
                "currentProvider": current_provider if isinstance(current_provider, str) else "",
                "revision": self._revision(path, data),
                "protocol": provider.get("wire_api", "responses"),
                "model": parsed.get("model", ""),
                "models": {},
            }
        env = self._claude_env(parsed)
        model_keys = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", *[
            f"ANTHROPIC_DEFAULT_{role.upper()}_MODEL{suffix}"
            for role in CLAUDE_MODEL_ROLES for suffix in ("", "_NAME")
        ]]
        if any(name in env and not isinstance(env[name], str) for name in model_keys):
            raise NativeEngineConfigError("Claude 的模型映射和显示名称必须是文本。")
        auth_mode = "api_key" if env.get("ANTHROPIC_API_KEY") and not env.get("ANTHROPIC_AUTH_TOKEN") else "bearer"
        key_name = "ANTHROPIC_AUTH_TOKEN" if auth_mode == "bearer" else "ANTHROPIC_API_KEY"
        return {
            "engine": engine,
            "path": str(path),
            "exists": data is not None,
            "baseUrl": env.get("ANTHROPIC_BASE_URL") if isinstance(env.get("ANTHROPIC_BASE_URL"), str) else "",
            "hasKey": isinstance(env.get(key_name), str) and bool(env.get(key_name)),
            "authMode": auth_mode,
            "enabled": bool(env.get("ANTHROPIC_BASE_URL") and env.get(key_name)),
            "currentProvider": "Anthropic Messages",
            "revision": self._revision(path, data),
            "protocol": "anthropic",
            "model": env.get("ANTHROPIC_MODEL") or parsed.get("model") or env.get("ANTHROPIC_DEFAULT_MODEL") or "",
            "models": {
                role: {
                    "model": env.get(f"ANTHROPIC_DEFAULT_{role.upper()}_MODEL", ""),
                    "displayName": env.get(f"ANTHROPIC_DEFAULT_{role.upper()}_MODEL_NAME", ""),
                } for role in CLAUDE_MODEL_ROLES
            },
        }

    def profile_source(self, engine: str) -> dict:
        """Private snapshot for importing/matching profiles. Never return to clients."""
        with self._lock:
            result = self.read(engine)
            path = self._path(engine)
            data = self._read_bytes(path)
            if self._revision(path, data) != result["revision"]:
                raise NativeEngineConfigError("本机配置正在被修改，请稍后重新读取。", conflict=True)
            _, parsed = self._parse(engine, data)
            if engine == "codex":
                provider = self._codex_provider(parsed)
                key = provider.get("experimental_bearer_token", "")
            else:
                env = self._claude_env(parsed)
                key = env.get("ANTHROPIC_API_KEY" if result["authMode"] == "api_key" else "ANTHROPIC_AUTH_TOKEN", "")
            result["apiKey"] = key if isinstance(key, str) else ""
            return result

    def claude_model_options(self) -> list[dict[str, str]]:
        config = self.read("claude")
        default = config["model"]
        mappings = config["models"]
        default_name = mappings.get(default, {}).get("displayName") or default
        return [
            {"value": "default", "label": f"本机默认 · {default_name}" if default_name else "本机默认模型"},
            *[{
                "value": role,
                "label": mappings[role]["displayName"] or f"Claude {role.title()}",
                "model": mappings[role]["model"] or role,
            } for role in CLAUDE_MODEL_ROLES],
        ]

    @staticmethod
    def _codex_content(text: str, parsed: dict, url: str, key: str, model: str | None = None) -> bytes:
        provider_name = parsed.get("model_provider", "openai")
        if not isinstance(provider_name, str) or not provider_name:
            raise NativeEngineConfigError("Codex 提供方名称无效。")
        provider = NativeEngineConfigStore._codex_provider(parsed)
        newline = "\r\n" if "\r\n" in text else "\n"
        if text and not text.endswith(("\n", "\r")):
            text += newline
        lines = text.splitlines(keepends=True)
        if model is not None:
            root_end = next((index for index, line in enumerate(lines) if TABLE_HEADER.match(line)), len(lines))
            model_assignments = [index for index in range(root_end) if re.match(r"^\s*model\s*=", lines[index])]
            if len(model_assignments) > 1 or ("model" in parsed and not model_assignments):
                raise NativeEngineConfigError("Codex 默认模型的写法无法安全更新，请在本机编辑。")
            model_line = f"model = {json.dumps(model, ensure_ascii=False)}{newline}"
            if model_assignments:
                lines[model_assignments[0]] = model_line
            else:
                lines.insert(root_end, model_line)
        # Locate the exact provider table with the TOML parser, including quoted
        # names. Validate the full result before writing to reject misleading
        # headers or assignments inside multiline strings.
        headers = [index for index, line in enumerate(lines) if TABLE_HEADER.match(line)]
        target = []
        for index in headers:
            try:
                header = tomllib.loads(lines[index] + "\n__devwisp_probe__ = true\n")
            except tomllib.TOMLDecodeError:
                continue
            if header == {"model_providers": {provider_name: {"__devwisp_probe__": True}}}:
                target.append(index)
        if len(target) > 1:
            raise NativeEngineConfigError("Codex 提供方配置无法安全更新，请在本机编辑。")
        changes = {"base_url": url, "experimental_bearer_token": key}
        if target:
            start = target[0]
            end = next((index for index in headers if index > start), len(lines))
            section = lines[start + 1:end]
            for field, value in changes.items():
                assignments = [index for index, line in enumerate(section)
                               if re.match(rf"^\s*{field}\s*=", line)]
                if len(assignments) > 1 or (field in provider and not assignments):
                    raise NativeEngineConfigError("Codex 提供方字段无法安全更新，请在本机编辑。")
                assignment = f"{field} = {json.dumps(value, ensure_ascii=False)}{newline}"
                if assignments:
                    section[assignments[0]] = assignment
                else:
                    section.append(assignment)
            lines[start + 1:end] = section
        else:
            if provider:
                raise NativeEngineConfigError("Codex 提供方配置无法安全更新，请在本机编辑。")
            changes.update(name=provider_name, wire_api="responses", requires_openai_auth=False)
            lines.append(newline + f"[model_providers.{json.dumps(provider_name, ensure_ascii=False)}]" + newline)
            lines.extend(f"{field} = {json.dumps(value, ensure_ascii=False)}{newline}"
                         for field, value in changes.items())
        result = "".join(lines)
        try:
            updated = tomllib.loads(result)
        except tomllib.TOMLDecodeError as error:
            raise NativeEngineConfigError("Codex 配置格式无法安全更新，请在本机编辑。") from error
        expected = dict(parsed)
        providers = dict(parsed.get("model_providers", {}))
        providers[provider_name] = {**provider, **changes}
        expected["model_providers"] = providers
        if model is not None:
            expected["model"] = model
        if updated != expected:
            raise NativeEngineConfigError("Codex 配置包含无法安全更新的写法，请在本机编辑。")
        return result.encode("utf-8")

    @staticmethod
    def _claude_content(parsed: dict, url: str, key: str, auth_mode: str, model: str | None = None, models: dict | None = None) -> bytes:
        updated = dict(parsed)
        env = dict(NativeEngineConfigStore._claude_env(parsed))
        env["ANTHROPIC_BASE_URL"] = url
        if auth_mode == "bearer":
            env["ANTHROPIC_AUTH_TOKEN"] = key
            env.pop("ANTHROPIC_API_KEY", None)
        else:
            env["ANTHROPIC_API_KEY"] = key
            env.pop("ANTHROPIC_AUTH_TOKEN", None)
        if model is not None:
            # A saved settings.model or a legacy env override must not mask the
            # newly selected default. Both native interactive and print sessions
            # read the same setting; an explicit --model still takes precedence.
            for name in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL"):
                env.pop(name, None)
            if model:
                updated["model"] = model
                env["ANTHROPIC_MODEL"] = model
            else:
                updated.pop("model", None)
        if models is not None:
            for role in CLAUDE_MODEL_ROLES:
                mapping = models.get(role, {})
                for suffix, field in (("", "model"), ("_NAME", "displayName")):
                    name = f"ANTHROPIC_DEFAULT_{role.upper()}_MODEL{suffix}"
                    if mapping.get(field):
                        env[name] = mapping[field]
                    else:
                        env.pop(name, None)
        updated["env"] = env
        return (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    def save(
        self,
        engine: str,
        base_url: str,
        api_key: str,
        auth_mode: str,
        expected_revision: str,
        model: str | None = None,
        models: dict | None = None,
    ) -> dict[str, str | bool]:
        url = self._api_url(base_url)
        entered_key = self._api_key(api_key)
        if engine == "claude" and auth_mode not in {"bearer", "api_key"}:
            raise NativeEngineConfigError("不支持的 Claude 密钥方式。")
        with self._lock:
            path = self._path(engine)
            current = self._read_bytes(path)
            text, parsed = self._parse(engine, current)
            if self._revision(path, current) != expected_revision:
                raise NativeEngineConfigError("配置文件已在本机被修改，请重新读取后再保存。", conflict=True)
            if engine == "codex":
                existing_key = self._codex_provider(parsed).get("experimental_bearer_token")
                key = entered_key or (existing_key if isinstance(existing_key, str) else "")
                if not key:
                    raise NativeEngineConfigError("请填写 Codex API 密钥。")
                data = self._codex_content(text, parsed, url, key, model)
            else:
                env = self._claude_env(parsed)
                key_name = "ANTHROPIC_AUTH_TOKEN" if auth_mode == "bearer" else "ANTHROPIC_API_KEY"
                existing_key = env.get(key_name)
                key = entered_key or (existing_key if isinstance(existing_key, str) else "")
                if not key:
                    raise NativeEngineConfigError("请填写 Claude API 密钥；切换密钥方式时也需要重新填写。")
                data = self._claude_content(parsed, url, key, auth_mode, model, models)
            if len(data) > MAX_CONFIG_BYTES:
                raise NativeEngineConfigError("配置内容超过 512 KB，请在本机编辑。")
            if current == data:
                return {"engine": engine, "path": str(path), "revision": self._revision(path, data), "changed": False}
            self.atomic_write(path, data, expected_revision)
        return {"engine": engine, "path": str(path), "revision": self._revision(path, data), "changed": True}

    @classmethod
    def atomic_write(cls, path: Path, data: bytes, expected_revision: str) -> None:
        if len(data) > MAX_CONFIG_BYTES:
            raise NativeEngineConfigError("配置内容超过 512 KB。")
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
            try:
                if os.name != "nt":
                    os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as temporary:
                    temporary.write(data)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                if cls._revision(path, cls._read_bytes(path)) != expected_revision:
                    raise NativeEngineConfigError("配置保存期间已被修改，请重新读取后再保存。", conflict=True)
                os.replace(temporary_name, path)
                if os.name == "nt":
                    os.chmod(path, 0o600)
            finally:
                if os.path.exists(temporary_name):
                    os.unlink(temporary_name)
        except OSError as error:
            raise NativeEngineConfigError("保存本机配置失败，请检查文件权限。") from error
