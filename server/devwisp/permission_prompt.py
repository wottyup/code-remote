"""Bridge headless Claude Code permission prompts to the web UI."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import sys
import tempfile
import threading
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

PERMISSION_REQUEST_TIMEOUT_SECONDS = 600.0
MAX_BROKER_REQUEST_BYTES = 65_536
MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024
MCP_SERVER_NAME = "devwisp_permission"
MCP_TOOL_NAME = "request_permission"
MCP_TOOL_FULL_NAME = f"mcp__{MCP_SERVER_NAME}__{MCP_TOOL_NAME}"


class PermissionPromptError(RuntimeError):
    pass


@dataclass
class _PendingPermission:
    future: asyncio.Future[bool]
    writer: asyncio.StreamWriter
    params: dict[str, str]


class PermissionPromptBroker:
    """Unix-socket broker that waits for a web decision for each pending request."""

    def __init__(
        self,
        socket_path: Path,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        self.socket_path = socket_path
        self.emit = emit
        self._server: asyncio.AbstractServer | None = None
        self._pending: dict[str, _PendingPermission] = {}

    def pending_requests(self) -> list[dict[str, str]]:
        return [dict(entry.params) for entry in self._pending.values() if not entry.future.done()]

    async def start(self) -> None:
        if os.name == "nt":
            return
        self.socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            existing = os.lstat(self.socket_path)
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISSOCK(existing.st_mode):
                raise PermissionPromptError("权限接管 socket 路径已被占用。")
            self.socket_path.unlink()
        self._server = await asyncio.start_unix_server(
            self._handle_client,
            path=str(self.socket_path),
            limit=MAX_BROKER_REQUEST_BYTES,
        )
        os.chmod(self.socket_path, 0o600)

    async def close(self) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for entry in pending:
            if not entry.future.done():
                entry.future.set_result(False)
            with suppress(Exception):
                entry.writer.close()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        self.socket_path.unlink(missing_ok=True)

    async def respond(self, permission_id: str, thread_id: str, allow: bool) -> None:
        key = f"{thread_id}:{permission_id}"
        entry = self._pending.get(key)
        if entry is None:
            raise PermissionPromptError("该权限请求不存在或已超时。")
        if entry.future.done():
            raise PermissionPromptError("该权限请求已经处理。")
        entry.future.set_result(allow)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        pending_key: str | None = None
        params: dict[str, str] | None = None
        disconnect: asyncio.Task[bytes] | None = None
        allowed = False
        response: dict[str, Any] = {"allowed": False}
        try:
            peer = writer.get_extra_info("socket")
            if hasattr(socket, "SO_PEERCRED") and peer is not None:
                import struct

                _, peer_uid, _ = struct.unpack(
                    "3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                )
                if peer_uid != os.getuid():
                    raise PermissionPromptError("权限 hook 客户端身份无效。")

            raw = await asyncio.wait_for(reader.readline(), timeout=5)
            if not raw or len(raw) > MAX_BROKER_REQUEST_BYTES:
                raise PermissionPromptError("权限 hook 请求格式无效。")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise PermissionPromptError("权限 hook 请求格式无效。")
            permission_id = request.get("permissionId")
            thread_id = request.get("threadId")
            if not isinstance(permission_id, str) or not permission_id or len(permission_id) > 128:
                raise PermissionPromptError("权限 hook 请求缺少有效标识。")
            if not isinstance(thread_id, str) or not thread_id or len(thread_id) > 256:
                raise PermissionPromptError("权限 hook 请求缺少有效聊天标识。")

            key = f"{thread_id}:{permission_id}"
            if key in self._pending:
                raise PermissionPromptError("权限 hook 请求标识重复。")
            future = asyncio.get_running_loop().create_future()
            params = {
                "threadId": thread_id,
                "permissionId": permission_id,
                "toolName": _bounded_text(request.get("toolName"), 128),
                "command": _bounded_text(request.get("command"), 16_000),
                "filePath": _bounded_text(request.get("filePath"), 4_096),
                "cwd": _bounded_text(request.get("cwd"), 4_096),
                "reason": _bounded_text(request.get("reason"), 1_000),
            }
            self._pending[key] = _PendingPermission(future, writer, params)
            pending_key = key
            await self.emit({"type": "claude/permission/request", "params": params})
            disconnect = asyncio.create_task(reader.read(1))
            done, _ = await asyncio.wait(
                {future, disconnect},
                timeout=PERMISSION_REQUEST_TIMEOUT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if future in done:
                allowed = future.result()
            response = {"allowed": allowed}
        except (PermissionPromptError, ValueError, OSError, RuntimeError, asyncio.TimeoutError) as error:
            response = {"allowed": False, "error": str(error)}
        except Exception:
            response = {"allowed": False, "error": "权限 hook 调用失败。"}
        finally:
            if pending_key is not None:
                entry = self._pending.pop(pending_key, None)
                if entry is not None and not entry.future.done():
                    entry.future.cancel()
            if disconnect is not None:
                disconnect.cancel()
                await asyncio.gather(disconnect, return_exceptions=True)
            if params is not None:
                with suppress(Exception):
                    await self.emit({
                        "type": "claude/permission/resolved",
                        "params": {
                            "threadId": params["threadId"],
                            "permissionId": params["permissionId"],
                        },
                    })
            try:
                writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()


def _bounded_text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _request_summary(hook_input: dict[str, Any]) -> dict[str, str]:
    tool_name = _bounded_text(hook_input.get("tool_name"), 128)
    tool_input = hook_input.get("input", hook_input.get("tool_input"))
    if not isinstance(tool_input, dict):
        tool_input = {}

    command = _bounded_text(tool_input.get("command"), 16_000) if tool_name == "Bash" else ""
    file_path = ""
    if not command:
        for key in ("file_path", "notebook_path", "path"):
            value = tool_input.get(key)
            if isinstance(value, str):
                file_path = _bounded_text(value, 4_096)
                break

    reason = _bounded_text(hook_input.get("reason"), 1_000)
    if not reason:
        reason = _bounded_text(tool_input.get("description"), 1_000)
    if not reason:
        reason = f"Claude Code 请求使用 {tool_name or '工具'}。"
    return {
        "toolName": tool_name,
        "command": command,
        "filePath": file_path,
        "cwd": _bounded_text(hook_input.get("cwd"), 4_096) or _bounded_text(
            os.environ.get("DEVWISP_PERMISSION_CWD"), 4_096
        ),
        "reason": reason,
    }


def _hook_request(summary: dict[str, str]) -> bool:
    socket_path = os.environ.get("DEVWISP_PERMISSION_SOCKET")
    thread_id = os.environ.get("DEVWISP_PERMISSION_THREAD")
    if not socket_path or not thread_id:
        return False

    request = {
        "permissionId": uuid4().hex,
        "threadId": thread_id,
        **summary,
    }
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(PERMISSION_REQUEST_TIMEOUT_SECONDS + 10)
        connection.connect(socket_path)
        connection.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        with connection.makefile("rb") as response_file:
            line = response_file.readline(MAX_BROKER_REQUEST_BYTES)
    if not line:
        return False
    response = json.loads(line)
    return isinstance(response, dict) and response.get("allowed") is True


def _write_hook_decision(allow: bool) -> None:
    result = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow" if allow else "deny"},
        },
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def permission_prompt_main() -> None:
    """Run the Claude command hook and return its PermissionRequest decision."""
    allowed = False
    try:
        raw = sys.stdin.buffer.read(MAX_HOOK_INPUT_BYTES + 1)
        if not raw or len(raw) > MAX_HOOK_INPUT_BYTES:
            raise PermissionPromptError("Claude 权限请求内容为空或过大。")
        hook_input = json.loads(raw)
        if not isinstance(hook_input, dict):
            raise PermissionPromptError("Claude 权限请求格式无效。")
        allowed = _hook_request(_request_summary(hook_input))
    except Exception:
        # A missing broker, malformed request, timeout, or transport failure
        # must deny the tool call rather than silently allow it.
        allowed = False
    _write_hook_decision(allowed)


def _mcp_permission_decision(arguments: Any) -> dict[str, str]:
    if not isinstance(arguments, dict):
        return {"behavior": "deny", "message": "权限请求格式无效；操作未执行。"}
    summary = _request_summary(arguments)
    if not summary["toolName"]:
        return {"behavior": "deny", "message": "权限请求缺少工具名称；操作未执行。"}
    try:
        allowed = _hook_request(summary)
    except Exception:
        allowed = False
    if allowed:
        return {"behavior": "allow"}
    return {"behavior": "deny", "message": "用户拒绝或审批超时；操作未执行。"}


def permission_mcp_server_main() -> None:
    """Serve the headless CLI's permission prompt as a stdio MCP tool."""
    write_lock = threading.Lock()

    def send(message: dict[str, Any]) -> None:
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with write_lock:
            sys.stdout.write(encoded + "\n")
            sys.stdout.flush()

    def handle_call(message_id: Any, arguments: Any) -> None:
        decision = _mcp_permission_decision(arguments)
        send({
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {
                "content": [{
                    "type": "text",
                    "text": json.dumps(decision, ensure_ascii=False, separators=(",", ":")),
                }],
            },
        })

    while True:
        raw = sys.stdin.buffer.readline(MAX_HOOK_INPUT_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_HOOK_INPUT_BYTES:
            return
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(message, dict):
            continue
        message_id = message.get("id")
        method = message.get("method")
        params = message.get("params")
        if method == "initialize" and message_id is not None:
            protocol_version = params.get("protocolVersion") if isinstance(params, dict) else None
            send({
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {
                    "protocolVersion": protocol_version or "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": MCP_SERVER_NAME, "version": "1.0.0"},
                },
            })
        elif method == "tools/list" and message_id is not None:
            send({
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {
                    "tools": [{
                        "name": MCP_TOOL_NAME,
                        "description": "Request the user's approval before Claude Code runs a tool.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tool_name": {"type": "string"},
                                "input": {"type": "object", "additionalProperties": True},
                                "tool_use_id": {"type": "string"},
                            },
                            "required": ["tool_name", "input", "tool_use_id"],
                        },
                    }],
                },
            })
        elif method == "tools/call" and message_id is not None:
            if not isinstance(params, dict) or params.get("name") != MCP_TOOL_NAME:
                send({
                    "jsonrpc": "2.0",
                    "id": message_id,
                    "error": {"code": -32602, "message": "Unknown permission tool."},
                })
                continue
            arguments = params.get("arguments")
            threading.Thread(
                target=handle_call,
                args=(message_id, arguments),
                daemon=True,
            ).start()
        elif method == "ping" and message_id is not None:
            send({"jsonrpc": "2.0", "id": message_id, "result": {}})
        elif message_id is not None:
            send({
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {"code": -32601, "message": "Method not found."},
            })


def remove_legacy_permission_hook(native_home: Path) -> bool:
    """Remove only the stale hook this feature previously wrote globally."""
    settings_path = native_home / "settings.json"
    try:
        settings_stat = settings_path.stat()
        settings = json.loads(settings_path.read_text("utf-8"))
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return False
    if not isinstance(settings, dict):
        return False
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return False
    registrations = hooks.get("PermissionPrompt")
    if not isinstance(registrations, list):
        return False

    module_path = str(Path(__file__).resolve())
    removed = False
    remaining_registrations: list[Any] = []
    for registration in registrations:
        if not isinstance(registration, dict) or not isinstance(registration.get("hooks"), list):
            remaining_registrations.append(registration)
            continue
        remaining_hooks = []
        for hook in registration["hooks"]:
            command = hook.get("command") if isinstance(hook, dict) else None
            if isinstance(command, str) and module_path in command:
                removed = True
            else:
                remaining_hooks.append(hook)
        if remaining_hooks:
            remaining_registrations.append({**registration, "hooks": remaining_hooks})

    if not removed:
        return False
    if remaining_registrations:
        hooks["PermissionPrompt"] = remaining_registrations
    else:
        hooks.pop("PermissionPrompt", None)
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=native_home,
            prefix=".settings.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, stat.S_IMODE(settings_stat.st_mode))
        os.replace(temporary_path, settings_path)
    except OSError as error:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise PermissionPromptError(f"移除旧的 Claude 权限 hook 失败：{error}") from error
    return True


if __name__ == "__main__":
    if "--mcp-server" in sys.argv[1:]:
        permission_mcp_server_main()
    else:
        permission_prompt_main()
