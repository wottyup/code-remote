"""Durable, narrowly scoped approvals for MCP tool-call confirmations."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any


_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_TOOL_PROMPT = re.compile(
    r'Allow the (?P<server>[A-Za-z0-9_.-]{1,128}) MCP server to run tool "(?P<tool>[A-Za-z0-9_.-]{1,128})"\?'
)


class MCPApprovalError(ValueError):
    pass


class MCPApprovalNotFoundError(MCPApprovalError):
    pass


def mcp_tool_confirmation(params: dict[str, Any]) -> dict[str, str] | None:
    """Recognize only Codex's empty-form confirmation for a specific MCP tool."""
    mode = params.get("mode")
    if not isinstance(mode, str) or mode not in {"form", "openai/form", "openaiForm"}:
        return None
    server_name = params.get("serverName")
    message = params.get("message")
    if not isinstance(server_name, str) or not isinstance(message, str):
        return None
    match = _TOOL_PROMPT.fullmatch(message)
    if match is None or match.group("server") != server_name:
        return None
    schema = params.get("requestedSchema")
    if schema is not True:
        if not isinstance(schema, dict) or schema.get("type") != "object" or schema.get("properties") != {}:
            return None
        if schema.get("required") not in (None, []):
            return None
        # Other validation keywords can make an empty answer invalid even
        # though the form has no visible fields.
        if set(schema) - {"$schema", "type", "properties", "required", "title", "description", "additionalProperties"}:
            return None
    return {"serverName": server_name, "toolName": match.group("tool")}


class MCPApprovalStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _read(self) -> list[dict[str, str]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError) as error:
            raise MCPApprovalError("无法读取 MCP 授权配置。") from error
        if not isinstance(data, list):
            raise MCPApprovalError("MCP 授权配置格式无效。")
        grants: list[dict[str, str]] = []
        for item in data:
            if not isinstance(item, dict):
                raise MCPApprovalError("MCP 授权配置格式无效。")
            grant_id, scope = item.get("id"), item.get("scope")
            server_name, tool_name = item.get("serverName"), item.get("toolName")
            if (not isinstance(grant_id, str) or not isinstance(server_name, str)
                    or _NAME.fullmatch(server_name) is None or not isinstance(scope, str) or scope not in {"tool", "server"}
                    or (scope == "tool" and (not isinstance(tool_name, str) or _NAME.fullmatch(tool_name) is None))
                    or (scope == "server" and tool_name is not None)):
                raise MCPApprovalError("MCP 授权配置格式无效。")
            grants.append({"id": grant_id, "scope": scope, "serverName": server_name,
                           **({"toolName": tool_name} if scope == "tool" else {})})
        return grants

    def _write(self, grants: list[dict[str, str]]) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".mcp-approvals-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(grants, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def list(self) -> list[dict[str, str]]:
        with self._lock:
            return self._read()

    def allows(self, server_name: str, tool_name: str) -> bool:
        with self._lock:
            return any(
                grant["serverName"] == server_name
                and (grant["scope"] == "server" or grant.get("toolName") == tool_name)
                for grant in self._read()
            )

    def add(self, server_name: str, tool_name: str, scope: str) -> dict[str, str]:
        if (scope not in {"tool", "server"} or _NAME.fullmatch(server_name) is None
                or _NAME.fullmatch(tool_name) is None):
            raise MCPApprovalError("MCP 授权范围无效。")
        with self._lock:
            grants = self._read()
            existing = next((grant for grant in grants if grant["scope"] == scope
                             and grant["serverName"] == server_name
                             and (scope == "server" or grant.get("toolName") == tool_name)), None)
            if existing is not None:
                return existing
            grant = {"id": str(uuid.uuid4()), "scope": scope, "serverName": server_name,
                     **({"toolName": tool_name} if scope == "tool" else {})}
            self._write([*grants, grant])
            return grant

    def revoke(self, grant_id: str) -> None:
        with self._lock:
            grants = self._read()
            remaining = [grant for grant in grants if grant["id"] != grant_id]
            if len(remaining) == len(grants):
                raise MCPApprovalNotFoundError("找不到这条 MCP 授权。")
            self._write(remaining)
