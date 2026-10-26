"""Server-owned SSH configuration, bounded execution journal, and MCP tools."""

from __future__ import annotations

import json
import ipaddress
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Iterator


MAX_OUTPUT = 64 * 1024
MAX_COMMAND = 8192
_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$")
_USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
INSPECTIONS = {
    "uptime": "uptime",
    "disk": "df -h",
    "memory": "free -h",
    "processes": "ps aux --sort=-%cpu | head -n 20",
    "failed_services": "systemctl --failed --no-pager",
}


class SSHConfigurationError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_server(value: dict[str, Any], *, server_id: str | None = None) -> dict[str, Any]:
    name = str(value.get("name", "")).strip()
    host = str(value.get("host", "")).strip()
    user = str(value.get("user", "")).strip()
    identity = str(value.get("identityFile", "") or "").strip()
    try:
        port = int(value.get("port", 22))
    except (TypeError, ValueError) as error:
        raise SSHConfigurationError("端口必须是 1 到 65535 的整数。") from error
    if not name or len(name) > 80:
        raise SSHConfigurationError("服务器名称须为 1 到 80 个字符。")
    try:
        ipaddress.ip_address(host)
        valid_host = True
    except ValueError:
        valid_host = bool(_HOST.fullmatch(host)) and ".." not in host
    if not valid_host:
        raise SSHConfigurationError("主机地址格式无效。")
    if not _USER.fullmatch(user):
        raise SSHConfigurationError("SSH 用户名格式无效。")
    if not 1 <= port <= 65535:
        raise SSHConfigurationError("端口必须是 1 到 65535 的整数。")
    if identity and (not Path(identity).is_absolute() or "\x00" in identity or len(identity) > 1024):
        raise SSHConfigurationError("密钥路径必须是本机绝对路径。")
    return {
        "id": server_id or str(uuid.uuid4()), "name": name, "host": host,
        "port": port, "user": user, "identityFile": identity,
        "enabled": bool(value.get("enabled", True)),
        "allowInspect": bool(value.get("allowInspect", True)),
        "allowExecute": bool(value.get("allowExecute", False)),
    }


class SSHServerStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return []
            except (OSError, json.JSONDecodeError) as error:
                raise SSHConfigurationError(f"无法读取 SSH 服务器配置：{error}") from error
            if not isinstance(data, list):
                raise SSHConfigurationError("SSH 服务器配置格式无效。")
            return [item for item in data if isinstance(item, dict)]

    def get(self, server_id: str) -> dict[str, Any]:
        server = next((item for item in self.list() if item.get("id") == server_id), None)
        if server is None:
            raise SSHConfigurationError("找不到这台服务器。")
        return server

    def save(self, value: dict[str, Any], server_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            servers = self.list()
            if server_id and not any(item.get("id") == server_id for item in servers):
                raise SSHConfigurationError("找不到这台服务器。")
            server = validate_server(value, server_id=server_id)
            if any(item.get("name", "").casefold() == server["name"].casefold() and item.get("id") != server["id"] for item in servers):
                raise SSHConfigurationError("服务器名称已存在。")
            servers = [item for item in servers if item.get("id") != server["id"]] + [server]
            self._write(servers)
            return server

    def delete(self, server_id: str) -> None:
        with self._lock:
            servers = self.list()
            remaining = [item for item in servers if item.get("id") != server_id]
            if len(remaining) == len(servers):
                raise SSHConfigurationError("找不到这台服务器。")
            self._write(remaining)

    def _write(self, servers: list[dict[str, Any]]) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".ssh-servers-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(servers, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


class SSHJournal:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""CREATE TABLE IF NOT EXISTS contexts (
                context TEXT PRIMARY KEY, thread_id TEXT NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS active_turns (
                thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, context TEXT NOT NULL, thread_id TEXT,
                turn_id TEXT, server_id TEXT NOT NULL, server_name TEXT NOT NULL,
                command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL,
                exit_code INTEGER, started_at TEXT NOT NULL, finished_at TEXT)""")
            conn.execute("CREATE INDEX IF NOT EXISTS ssh_operations_thread ON operations(thread_id, started_at)")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=5)
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def register_context(self, context: str, thread_id: str) -> None:
        with self._connect() as conn:
            conn.execute("INSERT OR REPLACE INTO contexts(context, thread_id) VALUES (?, ?)", (context, thread_id))
            conn.execute("UPDATE operations SET thread_id = ? WHERE context = ? AND thread_id IS NULL", (thread_id, context))

    def set_active_turn(self, thread_id: str, turn_id: str | None) -> None:
        with self._connect() as conn:
            if turn_id:
                conn.execute("INSERT OR REPLACE INTO active_turns(thread_id, turn_id) VALUES (?, ?)", (thread_id, turn_id))
            else:
                conn.execute("DELETE FROM active_turns WHERE thread_id = ?", (thread_id,))

    def start(self, context: str, server: dict[str, Any], command: str, turn_id: str | None = None) -> str:
        operation_id = str(uuid.uuid4())
        with self._connect() as conn:
            row = conn.execute("SELECT thread_id FROM contexts WHERE context = ?", (context,)).fetchone()
            thread_id = row[0] if row else None
            if thread_id and not turn_id:
                active = conn.execute("SELECT turn_id FROM active_turns WHERE thread_id = ?", (thread_id,)).fetchone()
                turn_id = active[0] if active else None
            conn.execute("""INSERT INTO operations
                (id, context, thread_id, turn_id, server_id, server_name, command, status, output, started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '', ?)""",
                (operation_id, context, thread_id, turn_id, server["id"], server["name"], command, _now()))
        return operation_id

    def append(self, operation_id: str, chunk: str) -> None:
        with self._connect() as conn:
            conn.execute("""UPDATE operations SET output = substr(output || ?, 1, ?) WHERE id = ?""",
                         (chunk, MAX_OUTPUT, operation_id))

    def finish(self, operation_id: str, exit_code: int | None, error: str | None = None) -> None:
        with self._connect() as conn:
            if error:
                conn.execute("UPDATE operations SET output = substr(output || ?, 1, ?) WHERE id = ?",
                             ("\n" + error, MAX_OUTPUT, operation_id))
            conn.execute("""UPDATE operations SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?""",
                         ("completed" if exit_code == 0 else "failed", exit_code, _now(), operation_id))

    def list_for_thread(self, thread_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""SELECT id, turn_id, server_name, command, status, output,
                exit_code, started_at, finished_at FROM operations
                WHERE thread_id = ? ORDER BY started_at DESC LIMIT 100""", (thread_id,)).fetchall()
        return [dict(row) for row in reversed(rows)]


def ssh_arguments(server: dict[str, Any], command: str) -> list[str]:
    args = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "NumberOfPasswordPrompts=0", "-o", "ConnectTimeout=8",
            "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
            "-p", str(server["port"])]
    if server["identityFile"]:
        args.extend(["-i", server["identityFile"], "-o", "IdentitiesOnly=yes"])
    args.extend(["--", f"{server['user']}@{server['host']}", command])
    return args


def run_ssh(store: SSHServerStore, journal: SSHJournal | None, context: str,
            server_id: str, command: str, *, permission: str, turn_id: str | None = None,
            allow_disabled: bool = False,
            timeout: int = 120) -> dict[str, Any]:
    server = store.get(server_id)  # Read for every call, including after permission changes.
    if not server.get("enabled") and not allow_disabled:
        raise SSHConfigurationError("这台服务器已停用。")
    if permission and not server.get(permission):
        raise SSHConfigurationError("这台服务器未允许此操作。")
    if not command.strip() or len(command) > MAX_COMMAND or "\x00" in command:
        raise SSHConfigurationError("远程命令不能为空，且不能超过 8192 个字符。")
    if server["identityFile"] and not Path(server["identityFile"]).is_file():
        raise SSHConfigurationError("本机 SSH 密钥文件不存在。")
    operation_id = journal.start(context, server, command, turn_id) if journal else None
    output: list[str] = []
    output_length = 0
    process: subprocess.Popen[bytes] | None = None
    timed_out = False
    try:
        process = subprocess.Popen(ssh_arguments(server, command), stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        chunks: Queue[bytes | None] = Queue()

        def read_output() -> None:
            assert process is not None and process.stdout is not None
            while chunk := process.stdout.read1(2048):
                chunks.put(chunk)
            chunks.put(None)

        threading.Thread(target=read_output, daemon=True).start()
        deadline = time.monotonic() + timeout
        while True:
            if time.monotonic() >= deadline:
                timed_out = True
                process.terminate()
                break
            try:
                chunk = chunks.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
            except Empty:
                continue
            if chunk is None:
                break
            text = chunk.decode("utf-8", errors="replace")
            if output_length < MAX_OUTPUT:
                kept = text[:MAX_OUTPUT - output_length]
                output.append(kept)
                output_length += len(kept)
                if journal and operation_id:
                    journal.append(operation_id, kept)
        try:
            exit_code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            exit_code = process.wait(timeout=2)
        error = "执行超时。" if timed_out else None
        if journal and operation_id:
            journal.finish(operation_id, exit_code if not timed_out else None, error)
        return {"operationId": operation_id, "server": server["name"], "command": command,
                "output": "".join(output), "exitCode": None if timed_out else exit_code,
                "error": error, "truncated": output_length >= MAX_OUTPUT}
    except Exception as error:
        if process is not None and process.poll() is None:
            process.terminate()
        if journal and operation_id:
            journal.finish(operation_id, None, str(error))
        raise


def _mcp_tool_result(value: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": is_error}


def mcp_main() -> None:
    store = SSHServerStore(Path(os.environ["CODE_REMOTE_SSH_CONFIG"]))
    journal = SSHJournal(Path(os.environ["CODE_REMOTE_SSH_JOURNAL"]))
    context = os.environ.get("CODE_REMOTE_SSH_CONTEXT", "")
    turn_id = os.environ.get("CODE_REMOTE_SSH_TURN_ID")
    tools = [
        {"name": "list_servers", "description": "列出 Code Remote 已启用的远程 SSH 服务器及授权能力。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "inspect_server", "description": "在获准的服务器上运行固定的只读诊断。结果会显示在聊天操作记录中。", "inputSchema": {
            "type": "object", "properties": {"server_id": {"type": "string"},
                "check": {"type": "string", "enum": list(INSPECTIONS)}}, "required": ["server_id", "check"]}},
        {"name": "execute_command", "description": "在获准执行命令的服务器上通过 SSH 运行 shell 命令。输出和退出码会显示在聊天中；不要打印密码、令牌或私钥。", "inputSchema": {
            "type": "object", "properties": {"server_id": {"type": "string"}, "command": {"type": "string", "maxLength": MAX_COMMAND}},
            "required": ["server_id", "command"]}},
    ]
    for line in sys.stdin.buffer:
        request: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or "id" not in request:
                continue
            method = request.get("method")
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2024-11-05"),
                          "capabilities": {"tools": {"listChanged": False}},
                          "serverInfo": {"name": "code-remote-ssh", "version": "1.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tools}
            elif method == "tools/call":
                name = params.get("name")
                args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
                if name == "list_servers":
                    result = _mcp_tool_result({"servers": [
                        {"id": item["id"], "name": item["name"], "allowInspect": item["allowInspect"],
                         "allowExecute": item["allowExecute"]}
                        for item in store.list() if item.get("enabled")]})
                elif name == "inspect_server":
                    check = args.get("check")
                    if check not in INSPECTIONS:
                        raise SSHConfigurationError("不支持该诊断项。")
                    value = run_ssh(store, journal, context, str(args.get("server_id", "")), INSPECTIONS[check],
                                    permission="allowInspect", turn_id=turn_id, timeout=30)
                    result = _mcp_tool_result(value, is_error=value["exitCode"] != 0)
                elif name == "execute_command":
                    value = run_ssh(store, journal, context, str(args.get("server_id", "")),
                                    str(args.get("command", "")), permission="allowExecute", turn_id=turn_id)
                    result = _mcp_tool_result(value, is_error=value["exitCode"] != 0)
                else:
                    raise SSHConfigurationError("未知 SSH 工具。")
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}, ensure_ascii=False), flush=True)
        except Exception as error:
            if isinstance(request, dict) and "id" in request:
                result = _mcp_tool_result({"error": str(error)}, is_error=True)
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    mcp_main()
