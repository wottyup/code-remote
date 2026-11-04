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
MANAGED_PROVIDER = "code_remote_settings"
BEGIN_MARKER = "# BEGIN CODE REMOTE API CONFIG"
END_MARKER = "# END CODE REMOTE API CONFIG"
MANAGED_BLOCK = re.compile(
    rf"(?ms)^{re.escape(BEGIN_MARKER)}\r?\n.*?^{re.escape(END_MARKER)}(?:\r?\n|$)"
)
TABLE_HEADER = re.compile(r"^\s*\[{1,2}[^\]\r\n]+\]{1,2}\s*(?:#.*)?$")
ROOT_PROVIDER = re.compile(r"^\s*model_provider\s*=")


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
        self._lock = threading.Lock()

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
        provider = providers.get(MANAGED_PROVIDER, {})
        if not isinstance(provider, dict):
            raise NativeEngineConfigError("Codex 的托管提供方配置格式无效。")
        return provider

    @staticmethod
    def _claude_env(parsed: dict) -> dict:
        env = parsed.get("env", {})
        if not isinstance(env, dict):
            raise NativeEngineConfigError("Claude 的 env 配置格式无效。")
        return env

    def read(self, engine: str) -> dict[str, str | bool]:
        with self._lock:
            path = self._path(engine)
            data = self._read_bytes(path)
            _, parsed = self._parse(engine, data)
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
                "enabled": current_provider == MANAGED_PROVIDER,
                "currentProvider": current_provider if isinstance(current_provider, str) else "",
                "revision": self._revision(path, data),
            }
        env = self._claude_env(parsed)
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
        }

    @staticmethod
    def _codex_content(text: str, parsed: dict, url: str, key: str) -> bytes:
        matches = list(MANAGED_BLOCK.finditer(text))
        if len(matches) > 1 or text.count(BEGIN_MARKER) != len(matches) or text.count(END_MARKER) != len(matches):
            raise NativeEngineConfigError("Codex 托管配置块已被手动修改，请在本机修复后重试。")
        if not matches and MANAGED_PROVIDER in parsed.get("model_providers", {}):
            raise NativeEngineConfigError("Codex 的保留提供方名称已被占用，请在本机重命名该提供方。")
        if matches:
            match = matches[0]
            text = text[:match.start()] + text[match.end():]

        newline = "\r\n" if "\r\n" in text else "\n"
        lines = text.splitlines(keepends=True)
        root_end = next((index for index, line in enumerate(lines) if TABLE_HEADER.match(line)), len(lines))
        root_assignments = [index for index in range(root_end) if ROOT_PROVIDER.match(lines[index])]
        if len(root_assignments) > 1 or (parsed.get("model_provider") is not None and not root_assignments):
            raise NativeEngineConfigError("Codex 默认提供方的写法无法安全更新，请在本机编辑。")
        assignment = f'model_provider = "{MANAGED_PROVIDER}"{newline}'
        if root_assignments:
            lines[root_assignments[0]] = assignment
        else:
            lines.insert(root_end, assignment + newline)
        result = "".join(lines)
        if result and not result.endswith(("\n", "\r")):
            result += newline
        if result and not result.endswith(newline * 2):
            result += newline
        result += newline.join((
            BEGIN_MARKER,
            f"[model_providers.{MANAGED_PROVIDER}]",
            'name = "Code Remote API"',
            f"base_url = {json.dumps(url, ensure_ascii=False)}",
            f"experimental_bearer_token = {json.dumps(key, ensure_ascii=False)}",
            "requires_openai_auth = false",
            END_MARKER,
            "",
        ))
        try:
            updated = tomllib.loads(result)
        except tomllib.TOMLDecodeError as error:
            raise NativeEngineConfigError("Codex 配置格式无法安全更新，请在本机编辑。") from error
        if updated.get("model_provider") != MANAGED_PROVIDER:
            raise NativeEngineConfigError("Codex 默认提供方未能更新。")
        return result.encode("utf-8")

    @staticmethod
    def _claude_content(parsed: dict, url: str, key: str, auth_mode: str) -> bytes:
        updated = dict(parsed)
        env = dict(NativeEngineConfigStore._claude_env(parsed))
        env["ANTHROPIC_BASE_URL"] = url
        if auth_mode == "bearer":
            env["ANTHROPIC_AUTH_TOKEN"] = key
            env.pop("ANTHROPIC_API_KEY", None)
        else:
            env["ANTHROPIC_API_KEY"] = key
            env.pop("ANTHROPIC_AUTH_TOKEN", None)
        updated["env"] = env
        return (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    def save(
        self,
        engine: str,
        base_url: str,
        api_key: str,
        auth_mode: str,
        expected_revision: str,
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
                data = self._codex_content(text, parsed, url, key)
            else:
                env = self._claude_env(parsed)
                key_name = "ANTHROPIC_AUTH_TOKEN" if auth_mode == "bearer" else "ANTHROPIC_API_KEY"
                existing_key = env.get(key_name)
                key = entered_key or (existing_key if isinstance(existing_key, str) else "")
                if not key:
                    raise NativeEngineConfigError("请填写 Claude API 密钥；切换密钥方式时也需要重新填写。")
                data = self._claude_content(parsed, url, key, auth_mode)
            if len(data) > MAX_CONFIG_BYTES:
                raise NativeEngineConfigError("配置内容超过 512 KB，请在本机编辑。")
            if current == data:
                return {"engine": engine, "path": str(path), "revision": self._revision(path, data), "changed": False}
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
                    if self._revision(path, self._read_bytes(path)) != expected_revision:
                        raise NativeEngineConfigError("配置文件保存期间又被本机修改，请重新读取后再保存。", conflict=True)
                    os.replace(temporary_name, path)
                    if os.name == "nt":
                        os.chmod(path, 0o600)
                finally:
                    if os.path.exists(temporary_name):
                        os.unlink(temporary_name)
            except OSError as error:
                raise NativeEngineConfigError("保存本机配置失败，请检查文件权限。") from error
        return {"engine": engine, "path": str(path), "revision": self._revision(path, data), "changed": True}
