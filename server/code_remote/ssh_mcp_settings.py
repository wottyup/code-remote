"""Private SSH profile and credential storage plus Codex launcher configuration."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import threading
from contextlib import suppress
from pathlib import Path
from typing import Any


SSH_MCP_SERVER_NAME = "code_remote_ssh_mcp"
_PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


class SshMcpSettingsError(ValueError):
    pass


class SshMcpSettingsStore:
    """Store non-secret SSH profiles and generate ssh-mcp's private TOML config."""

    def __init__(self, state_directory: Path) -> None:
        self.directory = state_directory / "ssh-mcp"
        self.profile_path = self.directory / "profiles.json"
        self.credentials_path = self.directory / "credentials.json"
        self.config_path = self.directory / "config.toml"
        self.project_root = Path(__file__).resolve().parents[2]
        self._lock = threading.RLock()

    def _entrypoint(self) -> Path:
        return self.project_root / "node_modules" / "ssh-mcp" / "build" / "index.js"

    @staticmethod
    def _node_command() -> str | None:
        configured = os.environ.get("CODE_REMOTE_NODE_COMMAND", "node")
        return shutil.which(configured)

    def status(self) -> dict[str, Any]:
        profiles = self.list_profiles()
        available = self._node_command() is not None and self._entrypoint().is_file()
        return {
            "profiles": profiles,
            "available": available,
            "configured": bool(profiles),
            "claudeSupported": False,
        }

    def list_profiles(self) -> list[dict[str, Any]]:
        with self._lock:
            if self.directory.is_symlink() or self.profile_path.is_symlink() or self.credentials_path.is_symlink():
                raise SshMcpSettingsError("SSH MCP 配置不能通过符号链接读取。")
            try:
                content = self.profile_path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return []
            except OSError as error:
                raise SshMcpSettingsError("无法读取 SSH MCP 配置。") from error
            try:
                document = json.loads(content)
            except json.JSONDecodeError as error:
                raise SshMcpSettingsError("SSH MCP 配置格式无效，请重新保存。") from error
            profiles = document.get("profiles") if isinstance(document, dict) else None
            if not isinstance(profiles, list) or not all(isinstance(profile, dict) for profile in profiles):
                raise SshMcpSettingsError("SSH MCP 配置格式无效，请重新保存。")
            credentials = self._read_credentials()
            safe_profiles = []
            for profile in profiles:
                safe_profile = dict(profile)
                safe_profile.pop("password", None)
                safe_profile["hasPassword"] = (
                    safe_profile.get("auth") == "password" and safe_profile.get("name") in credentials
                )
                safe_profiles.append(safe_profile)
            return safe_profiles

    def save(
        self,
        profiles: list[dict[str, Any]],
        passwords: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if len(profiles) > 32:
            raise SshMcpSettingsError("最多可配置 32 台 SSH 服务器。")
        names: set[str] = set()
        password_env_names: set[str] = set()
        for profile in profiles:
            name = profile.get("name")
            if not isinstance(name, str) or _PROFILE_NAME.fullmatch(name) is None:
                raise SshMcpSettingsError("服务器名称只能包含英文字母、数字、连字符和下划线。")
            folded_name = name.casefold()
            if folded_name in names:
                raise SshMcpSettingsError("服务器名称不能重复。")
            names.add(folded_name)
            if profile.get("auth") == "password":
                env_name = re.sub(r"[^A-Z0-9]", "_", name.upper())
                if env_name in password_env_names:
                    raise SshMcpSettingsError("密码认证的服务器名称不能重复。")
                password_env_names.add(env_name)

        with self._lock:
            if self.directory.is_symlink():
                raise SshMcpSettingsError("SSH MCP 配置目录不能是符号链接。")
            if not profiles:
                for path in (self.profile_path, self.credentials_path, self.config_path):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as error:
                        raise SshMcpSettingsError("无法移除 SSH MCP 配置。") from error
                return self.status()

            previous_credentials = self._read_credentials()
            supplied_passwords = passwords or {}
            next_credentials: dict[str, str] = {}
            safe_profiles: list[dict[str, Any]] = []
            for profile in profiles:
                name = profile["name"]
                safe_profile = dict(profile)
                safe_profile.pop("password", None)
                safe_profile.pop("hasPassword", None)
                if profile.get("auth") == "password":
                    password = supplied_passwords.get(name) or previous_credentials.get(name)
                    if not password:
                        raise SshMcpSettingsError("请填写 SSH 登录密码。")
                    next_credentials[name] = password
                safe_profiles.append(safe_profile)

            try:
                if next_credentials:
                    self._atomic_write(
                        self.credentials_path,
                        json.dumps({"version": 1, "passwords": next_credentials}, ensure_ascii=False, indent=2).encode("utf-8"),
                    )
                else:
                    self.credentials_path.unlink(missing_ok=True)
                self._atomic_write(
                    self.profile_path,
                    json.dumps({"profiles": safe_profiles}, ensure_ascii=False, indent=2).encode("utf-8"),
                )
            except OSError as error:
                try:
                    if previous_credentials:
                        self._atomic_write(
                            self.credentials_path,
                            json.dumps({"version": 1, "passwords": previous_credentials}, ensure_ascii=False, indent=2).encode("utf-8"),
                        )
                    else:
                        self.credentials_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise SshMcpSettingsError("无法保存 SSH MCP 配置。") from error
            return self.status()

    def _read_credentials(self) -> dict[str, str]:
        if self.directory.is_symlink() or self.credentials_path.is_symlink():
            raise SshMcpSettingsError("SSH MCP 凭据不能通过符号链接读取。")
        try:
            content = self.credentials_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as error:
            raise SshMcpSettingsError("无法读取 SSH MCP 凭据。") from error
        try:
            document = json.loads(content)
        except json.JSONDecodeError as error:
            raise SshMcpSettingsError("SSH MCP 凭据格式无效，请重新保存。") from error
        passwords = document.get("passwords") if isinstance(document, dict) and document.get("version") == 1 else None
        if not isinstance(passwords, dict) or not all(isinstance(name, str) and isinstance(value, str) for name, value in passwords.items()):
            raise SshMcpSettingsError("SSH MCP 凭据格式无效，请重新保存。")
        return passwords

    def codex_server_config(self) -> dict[str, Any] | None:
        with self._lock:
            profiles = self.list_profiles()
            if not profiles:
                return None
            node = self._node_command()
            entrypoint = self._entrypoint()
            if node is None or not entrypoint.is_file():
                raise SshMcpSettingsError("SSH MCP 运行依赖不可用，请在 Code Remote 工作区执行 pnpm install。")
            self._atomic_write(self.config_path, self._serialize(profiles).encode("utf-8"))
            package_parent = str(Path(__file__).resolve().parents[1])
            python_path = os.pathsep.join(filter(None, (package_parent, os.environ.get("PYTHONPATH", ""))))
            return {
                "command": sys.executable,
                "args": ["-m", "code_remote.ssh_mcp_launcher"],
                "env": {
                    "PYTHONPATH": python_path,
                    "CODE_REMOTE_SSH_MCP_STATE_DIRECTORY": str(self.directory.parent),
                    "CODE_REMOTE_SSH_MCP_NODE": node,
                    "CODE_REMOTE_SSH_MCP_ENTRYPOINT": str(entrypoint),
                },
            }

    def runtime_password_environment(self) -> dict[str, str]:
        with self._lock:
            profiles = self.list_profiles()
            credentials = self._read_credentials()
            env: dict[str, str] = {}
            for profile in profiles:
                if profile.get("auth") != "password":
                    continue
                name = profile["name"]
                password = credentials.get(name)
                if not password:
                    raise SshMcpSettingsError("请重新保存 SSH 密码配置。")
                env_name = re.sub(r"[^A-Z0-9]", "_", name.upper())
                env[f"SSH_MCP_{env_name}_PASSWORD"] = password
            return env

    def _atomic_write(self, path: Path, content: bytes) -> None:
        if self.directory.is_symlink():
            raise SshMcpSettingsError("SSH MCP 配置目录不能是符号链接。")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with suppress(OSError):
            os.chmod(self.directory, 0o700)
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{path.name}-", suffix=".tmp", dir=self.directory,
        )
        try:
            with suppress(OSError):
                os.chmod(temporary_path, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, path)
            with suppress(OSError):
                os.chmod(path, 0o600)
        finally:
            with suppress(OSError):
                os.unlink(temporary_path)

    @staticmethod
    def _toml_string(value: str) -> str:
        # JSON string escaping is a compatible subset of TOML basic-string escaping.
        return json.dumps(value, ensure_ascii=False)

    @classmethod
    def _serialize(cls, profiles: list[dict[str, Any]]) -> str:
        quote = cls._toml_string
        lines = [
            "[defaults]",
            f"defaultProfile = {quote(profiles[0]['name'])}",
            'approvalMode = "ask-all"',
            "",
        ]
        string_fields = (
            ("name", "name"),
            ("host", "host"),
            ("user", "user"),
            ("auth", "auth"),
            ("group", "group"),
            ("role", "role"),
            ("approvalPolicy", "approvalPolicy"),
            ("keyRef", "keyRef"),
            ("trustedHostKey", "trustedHostKey"),
            ("workdir", "workdir"),
        )
        for profile in profiles:
            lines.append("[[profiles]]")
            for key, source in string_fields:
                value = profile.get(source)
                if isinstance(value, str) and value.strip():
                    lines.append(f"{key} = {quote(value.strip())}")
            port = profile.get("port", 22)
            read_only = profile.get("readOnly", True)
            lines.append(f"port = {int(port)}")
            lines.append(f"readOnly = {'true' if read_only else 'false'}")
            lines.append("")
        return "\n".join(lines)
