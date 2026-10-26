from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import shutil
import signal
import sqlite3
import time
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from .claude_native_history import scan_native_sessions
from .claude_stream import ClaudeReplyText

logger = logging.getLogger(__name__)

CLAUDE_THREAD_PREFIX = "claude:"
CLAUDE_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}
CLAUDE_PERMISSION_MODES = {"default", "manual", "acceptEdits", "auto", "dontAsk", "plan"}


class ClaudeCodeError(RuntimeError):
    pass


class ClaudeThreadBusyError(ClaudeCodeError):
    pass


class ClaudeThreadNotFoundError(ClaudeCodeError):
    pass


def is_claude_thread_id(thread_id: str) -> bool:
    if not thread_id.startswith(CLAUDE_THREAD_PREFIX):
        return False
    try:
        uuid.UUID(thread_id.removeprefix(CLAUDE_THREAD_PREFIX))
        return True
    except (ValueError, AttributeError):
        return False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ClaudeCodeServer:
    """Owns Claude Code CLI sessions and projects them into Code Remote threads."""

    def __init__(
        self,
        command: str,
        workspace: Path,
        database_path: Path,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        self.command = command
        self.workspace = workspace.resolve()
        self.database_path = database_path
        self.emit = emit
        self._lock = asyncio.Lock()
        self._native_refresh_lock = asyncio.Lock()
        self._next_native_scan_at = 0.0
        self._native_refresh_task: asyncio.Task[None] | None = None
        self._native_refresh_pending = False
        self._native_home = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")).expanduser().resolve()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._interrupts: set[str] = set()
        self._live_replies: dict[str, dict[str, Any]] = {}
        self._database_path_parent_ready()
        self._connection = sqlite3.connect(database_path, check_same_thread=False)
        with suppress(OSError):
            os.chmod(database_path, 0o600)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute(
            """CREATE TABLE IF NOT EXISTS claude_threads (
                thread_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                preview TEXT NOT NULL,
                cwd TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started INTEGER NOT NULL DEFAULT 0,
                running_turn_id TEXT,
                messages_json TEXT NOT NULL DEFAULT '[]'
            )"""
        )
        columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(claude_threads)")}
        if "native_source" not in columns:
            self._connection.execute("ALTER TABLE claude_threads ADD COLUMN native_source TEXT")
        if "native_mtime_ns" not in columns:
            self._connection.execute("ALTER TABLE claude_threads ADD COLUMN native_mtime_ns INTEGER")
        self._connection.execute(
            "CREATE TABLE IF NOT EXISTS claude_native_hidden (session_id TEXT PRIMARY KEY)",
        )
        self._recover_interrupted_turns()
        self._connection.commit()

    def _database_path_parent_ready(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _recover_interrupted_turns(self) -> None:
        rows = self._connection.execute(
            "SELECT thread_id, messages_json, running_turn_id FROM claude_threads WHERE running_turn_id IS NOT NULL",
        ).fetchall()
        for row in rows:
            try:
                messages = json.loads(row["messages_json"])
            except (TypeError, json.JSONDecodeError):
                messages = []
            if not isinstance(messages, list):
                messages = []
            turn_id = row["running_turn_id"]
            messages.append({
                "id": f"assistant-{turn_id}",
                "role": "assistant",
                "text": "Claude Code 在服务重启时中断了回复，请继续发送消息。",
                "createdAt": _now(),
                "completedAt": _now(),
                "turnId": turn_id,
                "status": "stopped",
            })
            self._connection.execute(
                "UPDATE claude_threads SET running_turn_id = NULL, messages_json = ? WHERE thread_id = ?",
                (json.dumps(messages, ensure_ascii=False), row["thread_id"]),
            )

    async def _notify_threads_changed(self) -> None:
        await self.emit({"type": "claude.threads.changed"})

    def _executable(self) -> str | None:
        executable = shutil.which(self.command) if not Path(self.command).is_absolute() else self.command
        return executable if executable and Path(executable).is_file() else None

    def status(self) -> dict[str, Any]:
        available = self._executable() is not None
        return {
            "available": available,
            "error": None if available else "找不到 Claude Code CLI。",
        }

    def _row(self, thread_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM claude_threads WHERE thread_id = ?", (thread_id,),
        ).fetchone()
        if row is None:
            raise ClaudeThreadNotFoundError("找不到这条 Claude Code 对话。")
        return row

    @staticmethod
    def _summary(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["thread_id"],
            "engine": "claude-code",
            "name": row["name"],
            "preview": row["preview"],
            "cwd": row["cwd"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "status": {"type": "active" if row["running_turn_id"] else "idle"},
            "historyRevision": (
                f"native:{row['native_mtime_ns']}" if row["native_source"]
                else f"remote:{row['updated_at']}:{row['running_turn_id'] or ''}"
            ),
        }

    def list_threads(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM claude_threads ORDER BY updated_at DESC",
        ).fetchall()
        return [self._summary(row) for row in rows]

    def schedule_native_refresh(self) -> None:
        """Refresh imported Claude sessions off the HTTP request path."""
        self._native_refresh_pending = True
        if self._native_refresh_task is not None and not self._native_refresh_task.done():
            return
        self._native_refresh_task = asyncio.create_task(self._refresh_pending_native_threads())

    async def _refresh_pending_native_threads(self) -> None:
        while self._native_refresh_pending:
            self._native_refresh_pending = False
            await self.refresh_native_threads()

    async def refresh_native_threads(self) -> None:
        """Import local CLI sessions without changing Claude Code's own files."""
        async with self._native_refresh_lock:
            delay = self._next_native_scan_at - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            self._next_native_scan_at = time.monotonic() + 1
            known = {
                row["session_id"]: (row["native_source"], row["native_mtime_ns"])
                for row in self._connection.execute(
                    "SELECT session_id, native_source, native_mtime_ns FROM claude_threads",
                )
            }
            hidden = {
                row["session_id"] for row in self._connection.execute(
                    "SELECT session_id FROM claude_native_hidden",
                )
            }
            sessions = await asyncio.to_thread(
                scan_native_sessions, self._native_home, self.workspace, known, hidden,
            )
            if not sessions:
                return
            changed_threads: set[str] = set()
            async with self._lock:
                with self._connection:
                    for session in sessions:
                        if self._connection.execute(
                            "SELECT 1 FROM claude_native_hidden WHERE session_id = ?",
                            (session["session_id"],),
                        ).fetchone():
                            continue
                        row = self._connection.execute(
                            "SELECT * FROM claude_threads WHERE session_id = ?",
                            (session["session_id"],),
                        ).fetchone()
                        if row is not None:
                            if row["running_turn_id"]:
                                continue
                            try:
                                current_messages = json.loads(row["messages_json"])
                            except (TypeError, json.JSONDecodeError):
                                current_messages = []
                            if not isinstance(current_messages, list):
                                current_messages = []
                            imported_messages = json.loads(session["messages_json"])
                            def message_key(item: dict[str, Any]) -> tuple[str, str, str]:
                                return (
                                    str(item.get("role", "")),
                                    " ".join(str(item.get("text", "")).split()),
                                    str(item.get("createdAt", "")),
                                )

                            existing_keys = collections.Counter(
                                message_key(item) for item in current_messages if isinstance(item, dict)
                            )
                            additions: list[dict[str, Any]] = []
                            for item in imported_messages:
                                if not isinstance(item, dict):
                                    continue
                                key = message_key(item)
                                if existing_keys[key]:
                                    existing_keys[key] -= 1
                                else:
                                    additions.append(item)
                            if not additions and row["native_mtime_ns"] == session["native_mtime_ns"]:
                                continue
                            merged_messages = sorted(
                                [*current_messages, *additions],
                                key=lambda item: item.get("createdAt") if isinstance(item.get("createdAt"), str) else "",
                            )
                            display_name = row["name"]
                            last_message = merged_messages[-1] if merged_messages else {}
                            preview = str(last_message.get("text", ""))[:400] or session["preview"]
                            self._connection.execute(
                                """UPDATE claude_threads
                                SET name = ?, preview = ?, updated_at = ?, messages_json = ?,
                                    native_source = ?, native_mtime_ns = ?
                                WHERE session_id = ?""",
                                (display_name or "Claude Code 对话", preview, session["updated_at"],
                                 json.dumps(merged_messages, ensure_ascii=False), session["native_source"],
                                 session["native_mtime_ns"], session["session_id"]),
                            )
                        else:
                            self._connection.execute(
                                """INSERT INTO claude_threads
                                (thread_id, session_id, name, preview, cwd, created_at,
                                 updated_at, started, messages_json, native_source, native_mtime_ns)
                                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                                (session["thread_id"], session["session_id"], session["name"],
                                 session["preview"], session["cwd"], session["created_at"],
                                 session["updated_at"], session["messages_json"],
                                 session["native_source"], session["native_mtime_ns"]),
                            )
                        changed_threads.add(session["thread_id"])
            for thread_id in changed_threads:
                await self.emit({
                    "type": "thread.history.changed", "threadId": thread_id,
                    "revision": self._summary(self._row(thread_id))["historyRevision"],
                })
            if changed_threads:
                await self._notify_threads_changed()

    async def create_thread(self, cwd: Path | None = None) -> dict[str, Any]:
        status = self.status()
        if not status["available"]:
            raise ClaudeCodeError(status["error"] or "Claude Code CLI 不可用。")
        workspace = cwd.resolve() if cwd else self.workspace
        if not workspace.is_dir():
            raise ClaudeCodeError("Claude Code 对话的工作目录不可用。")
        thread_id = f"{CLAUDE_THREAD_PREFIX}{uuid.uuid4()}"
        session_id = thread_id.removeprefix(CLAUDE_THREAD_PREFIX)
        created_at = _now()
        with self._connection:
            self._connection.execute(
                """INSERT INTO claude_threads
                (thread_id, session_id, name, preview, cwd, created_at, updated_at, messages_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, '[]')""",
                (thread_id, session_id, "新对话", "", str(workspace), created_at, created_at),
            )
        await self._notify_threads_changed()
        return self._summary(self._row(thread_id))

    async def read_thread(self, thread_id: str, *, include_turns: bool = True) -> dict[str, Any]:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        # Known sessions are indexed by the thread list refresh. Avoid scanning
        # every native project file again when opening one specific session.
        row = self._row(thread_id)
        result = self._summary(row)
        if not include_turns:
            return result
        try:
            messages = json.loads(row["messages_json"])
        except (TypeError, json.JSONDecodeError):
            messages = []
        result["turns"] = self._turns(messages)
        running_turn_id = row["running_turn_id"]
        if running_turn_id:
            turn = next((turn for turn in result["turns"] if turn["id"] == running_turn_id), None)
            if turn is not None:
                turn["status"] = "inProgress"
                turn.pop("completedAt", None)
                reply = self._live_replies.get(thread_id)
                if reply and reply["turnId"] == running_turn_id and reply["text"]:
                    turn["items"].append({
                        "id": reply["id"], "type": "agentMessage", "text": reply["text"],
                        "createdAt": reply["createdAt"], "status": "inProgress",
                    })
        return result

    @staticmethod
    def _turns(messages: Any) -> list[dict[str, Any]]:
        if not isinstance(messages, list):
            return []
        turns: list[dict[str, Any]] = []
        by_id: dict[str, dict[str, Any]] = {}
        for message in messages:
            if not isinstance(message, dict):
                continue
            turn_id = message.get("turnId")
            role = message.get("role")
            if not isinstance(turn_id, str) or role not in {"user", "assistant"}:
                continue
            turn = by_id.get(turn_id)
            if turn is None:
                turn = {
                    "id": turn_id,
                    "status": "completed",
                    "startedAt": message.get("createdAt"),
                    "completedAt": message.get("completedAt"),
                    "items": [],
                }
                by_id[turn_id] = turn
                turns.append(turn)
            item: dict[str, Any] = {
                "id": message.get("id"),
                "type": "userMessage" if role == "user" else "agentMessage",
                "createdAt": message.get("createdAt"),
            }
            if role == "user":
                item["content"] = [{"type": "text", "text": message.get("text", "")}]
            else:
                item["text"] = message.get("text", "")
                turn["completedAt"] = message.get("completedAt")
                turn["status"] = message.get("status", "completed")
            turn["items"].append(item)
        return turns

    async def rename_thread(self, thread_id: str, name: str) -> dict[str, str]:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        self._row(thread_id)
        with self._connection:
            self._connection.execute(
                "UPDATE claude_threads SET name = ?, updated_at = ? WHERE thread_id = ?",
                (name, _now(), thread_id),
            )
        await self._notify_threads_changed()
        return {"thread_id": thread_id, "name": name}

    async def set_workspace(self, thread_id: str, cwd: Path) -> dict[str, str]:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        if not cwd.is_dir():
            raise ClaudeCodeError("Claude Code 对话的工作目录不可用。")
        self._row(thread_id)
        with self._connection:
            self._connection.execute(
                "UPDATE claude_threads SET cwd = ?, updated_at = ? WHERE thread_id = ?",
                (str(cwd.resolve()), _now(), thread_id),
            )
        await self._notify_threads_changed()
        return {"thread_id": thread_id, "cwd": str(cwd.resolve())}

    async def delete_thread(self, thread_id: str) -> None:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        row = self._row(thread_id)
        if thread_id in self._tasks:
            await self.interrupt(thread_id)
            task = self._tasks.get(thread_id)
            if task:
                await asyncio.gather(task, return_exceptions=True)
        with self._connection:
            self._connection.execute(
                "INSERT OR IGNORE INTO claude_native_hidden(session_id) VALUES (?)",
                (row["session_id"],),
            )
            cursor = self._connection.execute(
                "DELETE FROM claude_threads WHERE thread_id = ?", (thread_id,),
            )
        if cursor.rowcount == 0:
            raise ClaudeThreadNotFoundError("找不到这条 Claude Code 对话。")
        await self._notify_threads_changed()

    async def active_turn_id(self, thread_id: str) -> str | None:
        if not is_claude_thread_id(thread_id):
            return None
        return self._row(thread_id)["running_turn_id"]

    async def start_turn(
        self,
        thread_id: str,
        prompt: str,
        *,
        display_prompt: str | None = None,
        image_paths: list[Path] | None = None,
        attachment_paths: list[Path] | None = None,
        temporary_directory: Path | None = None,
        request_id: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        permission_mode: str | None = None,
    ) -> str:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        status = self.status()
        if not status["available"]:
            raise ClaudeCodeError(status["error"] or "Claude Code CLI 不可用。")
        if not prompt.strip() and not image_paths and not attachment_paths:
            raise ClaudeCodeError("请填写消息或附加文件。")
        if effort is not None and effort not in CLAUDE_EFFORT_LEVELS:
            raise ClaudeCodeError("Claude Code 思考等级无效。")
        if permission_mode is not None and permission_mode not in CLAUDE_PERMISSION_MODES:
            raise ClaudeCodeError("Claude Code 权限模式无效。")
        async with self._lock:
            row = self._row(thread_id)
            if row["running_turn_id"]:
                raise ClaudeThreadBusyError("Claude Code 正在回复，请稍后再发送。")
            turn_id = request_id or str(uuid.uuid4())
            try:
                uuid.UUID(turn_id)
            except ValueError:
                turn_id = str(uuid.uuid4())
            created_at = _now()
            display_text = display_prompt if display_prompt is not None else prompt
            try:
                messages = json.loads(row["messages_json"])
            except (TypeError, json.JSONDecodeError):
                messages = []
            if not isinstance(messages, list):
                messages = []
            user_message_id = f"user-{turn_id}"
            messages.append({
                "id": user_message_id,
                "role": "user",
                "text": display_text,
                "createdAt": created_at,
                "turnId": turn_id,
            })
            preview = " ".join(display_text.split())[:400]
            name = row["name"]
            if name == "新对话" and preview:
                name = preview[:72]
            with self._connection:
                self._connection.execute(
                    """UPDATE claude_threads
                    SET name = ?, preview = ?, updated_at = ?, running_turn_id = ?, messages_json = ?,
                        native_source = NULL, native_mtime_ns = NULL
                    WHERE thread_id = ?""",
                    (name, preview, created_at, turn_id, json.dumps(messages, ensure_ascii=False), thread_id),
                )
            self._live_replies[thread_id] = {
                "id": f"assistant-{turn_id}", "turnId": turn_id, "text": "", "createdAt": created_at,
            }
            await self.emit({
                "type": "notification",
                "method": "turn/started",
                "params": {"threadId": thread_id, "turn": {
                    "id": turn_id, "threadId": thread_id, "status": "inProgress", "startedAt": created_at,
                }},
            })
            await self.emit({
                "type": "notification",
                "method": "item/started",
                "params": {"threadId": thread_id, "turnId": turn_id, "item": {
                    "id": user_message_id,
                    "type": "userMessage",
                    "status": "completed",
                    "createdAt": created_at,
                    "content": [{"type": "text", "text": display_text}],
                }},
            })
            self._interrupts.discard(thread_id)
            self._tasks[thread_id] = asyncio.create_task(self._run_turn(
                thread_id,
                turn_id,
                prompt,
                list(image_paths or []),
                list(attachment_paths or []),
                temporary_directory,
                model.strip() if model else None,
                effort,
                permission_mode,
            ))
            return turn_id

    async def _run_turn(
        self,
        thread_id: str,
        turn_id: str,
        prompt: str,
        image_paths: list[Path],
        attachment_paths: list[Path],
        temporary_directory: Path | None,
        model: str | None,
        effort: str | None,
        permission_mode: str | None,
    ) -> None:
        assistant_item_id = f"assistant-{turn_id}"
        assistant_text = ""
        reply_text = ClaudeReplyText()
        tool_items: dict[str, dict[str, Any]] = {}
        result_error: str | None = None
        completed_at = _now()
        process: asyncio.subprocess.Process | None = None
        try:
            row = self._row(thread_id)
            started = bool(row["started"])
            cwd = Path(row["cwd"])
            if not cwd.is_dir():
                raise ClaudeCodeError("Claude Code 对话的工作目录已不可用。")
            if image_paths:
                image_list = "\n".join(f"- {path}" for path in image_paths)
                prompt = (
                    f"{prompt.rstrip()}\n\n用户附加了以下图片，请使用 Claude Code 的 Read 工具查看图片内容后再回答：\n{image_list}"
                )
            command = self._executable()
            if command is None:
                raise ClaudeCodeError("找不到 Claude Code CLI。")
            args = [
                str(command), "--print", "--output-format", "stream-json", "--include-partial-messages",
                "--verbose",
            ]
            if model and model != "default":
                args.extend(["--model", model])
            if effort:
                args.extend(["--effort", effort])
            if permission_mode and permission_mode != "default":
                args.extend(["--permission-mode", permission_mode])
            args.extend(["--resume", row["session_id"]] if started else ["--session-id", row["session_id"]])
            for directory in {path.parent.resolve() for path in [*image_paths, *attachment_paths] if path.exists()}:
                args.extend(["--add-dir", str(directory)])
            kwargs: dict[str, Any] = {
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                # CLI diagnostics can contain private prompts or tool output.
                # Keep them out of logs and the remote browser.
                "stderr": asyncio.subprocess.DEVNULL,
                "cwd": cwd,
                "limit": 8 * 1024 * 1024,
            }
            if os.name != "nt":
                kwargs["start_new_session"] = True
            process = await asyncio.create_subprocess_exec(*args, **kwargs)
            self._processes[thread_id] = process
            if process.stdin:
                process.stdin.write(prompt.encode("utf-8") + b"\n")
                await process.stdin.drain()
                process.stdin.close()
                with suppress(BrokenPipeError, ConnectionResetError):
                    await process.stdin.wait_closed()
            if thread_id in self._interrupts:
                await self._terminate_process(process)

            assert process.stdout is not None
            received_init = False
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(record, dict):
                    continue
                next_text = reply_text.consume(record)
                if next_text != assistant_text:
                    if next_text.startswith(assistant_text):
                        await self._emit_delta(thread_id, turn_id, assistant_item_id, next_text[len(assistant_text):])
                    else:
                        reply = self._live_replies.get(thread_id)
                        if reply and reply["turnId"] == turn_id:
                            reply["text"] = next_text
                        await self.emit({
                            "type": "notification", "method": "item/completed",
                            "params": {"threadId": thread_id, "turnId": turn_id, "item": {
                                "id": assistant_item_id, "type": "agentMessage", "text": next_text,
                            }},
                        })
                    assistant_text = next_text
                record_type = record.get("type")
                if record_type == "system" and record.get("subtype") == "init":
                    received_init = True
                    started = True
                    with self._connection:
                        self._connection.execute(
                            "UPDATE claude_threads SET started = 1 WHERE thread_id = ?", (thread_id,),
                        )
                elif record_type == "assistant":
                    message = record.get("message")
                    content = message.get("content") if isinstance(message, dict) else None
                    if isinstance(content, list):
                        for block in content:
                            if not isinstance(block, dict):
                                continue
                            if block.get("type") == "tool_use":
                                tool_id = block.get("id")
                                name = block.get("name")
                                inputs = block.get("input")
                                if isinstance(tool_id, str) and isinstance(name, str):
                                    item = self._tool_item(tool_id, name, inputs)
                                    tool_items[tool_id] = item
                                    await self.emit({
                                        "type": "notification", "method": "item/started",
                                        "params": {"threadId": thread_id, "turnId": turn_id, "item": item},
                                    })
                elif record_type == "user":
                    message = record.get("message")
                    content = message.get("content") if isinstance(message, dict) else None
                    if isinstance(content, list):
                        for block in content:
                            if not isinstance(block, dict) or block.get("type") != "tool_result":
                                continue
                            tool_id = block.get("tool_use_id")
                            if isinstance(tool_id, str) and tool_id in tool_items:
                                item = {**tool_items[tool_id], "status": "completed"}
                                await self.emit({
                                    "type": "notification", "method": "item/completed",
                                    "params": {"threadId": thread_id, "turnId": turn_id, "item": item},
                                })
                                tool_items.pop(tool_id, None)
                elif record_type == "result":
                    if record.get("is_error") is True:
                        result_error = "Claude Code 请求失败，请检查模型、登录状态或权限设置。"

            return_code = await process.wait()
            if thread_id in self._interrupts:
                result_error = None
            elif return_code != 0 and result_error is None:
                result_error = (
                    "Claude Code 请求失败，请检查模型、登录状态或权限设置。"
                    if received_init else "Claude Code CLI 启动失败，请检查本机 CLI 参数与配置。"
                )
            elif not assistant_text and result_error is None:
                result_error = "Claude Code 没有返回回复，请检查本机 CLI 和权限设置。"
        except asyncio.CancelledError:
            if process and process.returncode is None:
                await self._terminate_process(process)
            result_error = None
            raise
        except Exception:
            # Do not log raw subprocess output, user prompts, or inherited auth data.
            logger.exception("Claude Code turn failed for %s", thread_id)
            result_error = "Claude Code 无法完成回复，请检查本机 CLI 和工作目录。"
        finally:
            completed_at = _now()
            if process and process.returncode is None:
                await self._terminate_process(process)
            self._processes.pop(thread_id, None)
            if temporary_directory is not None:
                shutil.rmtree(temporary_directory, ignore_errors=True)
            status = "stopped" if thread_id in self._interrupts else "failed" if result_error else "completed"
            final_text = assistant_text
            if result_error and not final_text:
                final_text = result_error
                with suppress(Exception):
                    await self._emit_delta(thread_id, turn_id, assistant_item_id, final_text)
            with suppress(Exception):
                await self._finish_turn(thread_id, turn_id, assistant_item_id, final_text, completed_at, status)
            reply = self._live_replies.get(thread_id)
            if reply and reply["turnId"] == turn_id:
                self._live_replies.pop(thread_id, None)
            self._interrupts.discard(thread_id)
            current_task = asyncio.current_task()
            if self._tasks.get(thread_id) is current_task:
                self._tasks.pop(thread_id, None)

    @staticmethod
    def _tool_item(tool_id: str, name: str, inputs: Any) -> dict[str, Any]:
        if name == "Bash" and isinstance(inputs, dict):
            return {
                "id": tool_id, "type": "commandExecution", "status": "inProgress",
                "command": inputs.get("command", ""),
            }
        return {
            "id": tool_id, "type": "dynamicToolCall", "status": "inProgress",
            "server": "Claude Code", "tool": name, "arguments": inputs if isinstance(inputs, dict) else {},
        }

    async def _emit_delta(self, thread_id: str, turn_id: str, item_id: str, delta: str) -> None:
        reply = self._live_replies.get(thread_id)
        if reply and reply["turnId"] == turn_id:
            reply["text"] += delta
        await self.emit({
            "type": "notification", "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "itemId": item_id, "delta": delta},
        })

    async def _finish_turn(
        self,
        thread_id: str,
        turn_id: str,
        assistant_item_id: str,
        text: str,
        completed_at: str,
        status: str,
    ) -> None:
        row = self._row(thread_id)
        try:
            messages = json.loads(row["messages_json"])
        except (TypeError, json.JSONDecodeError):
            messages = []
        if not isinstance(messages, list):
            messages = []
        if text or status != "completed":
            messages.append({
                "id": assistant_item_id,
                "role": "assistant",
                "text": text,
                "createdAt": completed_at,
                "completedAt": completed_at,
                "turnId": turn_id,
                "status": status,
            })
        preview = row["preview"]
        if text.strip():
            preview = " ".join(text.split())[:400]
        with self._connection:
            self._connection.execute(
                """UPDATE claude_threads SET preview = ?, updated_at = ?, running_turn_id = NULL,
                messages_json = ? WHERE thread_id = ?""",
                (preview, completed_at, json.dumps(messages, ensure_ascii=False), thread_id),
            )
        await self._notify_threads_changed()
        item = {"id": assistant_item_id, "type": "agentMessage", "text": text, "status": status}
        await self.emit({
            "type": "notification", "method": "item/completed",
            "params": {"threadId": thread_id, "turnId": turn_id, "item": item},
        })
        await self.emit({
            "type": "notification", "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {
                "id": turn_id, "threadId": thread_id, "status": status, "completedAt": completed_at,
            }},
        })

    async def interrupt(self, thread_id: str, turn_id: str | None = None) -> bool:
        async with self._lock:
            row = self._row(thread_id)
            active_turn_id = row["running_turn_id"]
            if not active_turn_id or (turn_id and turn_id != active_turn_id):
                return False
            self._interrupts.add(thread_id)
            process = self._processes.get(thread_id)
            if process and process.returncode is None:
                await self._terminate_process(process)
            task = self._tasks.get(thread_id)
            if task and not task.done():
                # A Claude child can keep stdout open after the CLI exits.
                # Cancel the reader so its finally block publishes completion.
                task.cancel()
            return True

    @staticmethod
    async def _terminate_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt" and getattr(process, "pid", None):
            try:
                killer = await asyncio.create_subprocess_exec(
                    "taskkill.exe", "/PID", str(process.pid), "/T", "/F",
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(killer.wait(), timeout=5)
                await asyncio.wait_for(process.wait(), timeout=3)
                return
            except (OSError, TimeoutError, ProcessLookupError):
                pass
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except (ProcessLookupError, PermissionError):
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except TimeoutError:
            with suppress(ProcessLookupError, PermissionError):
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            with suppress(Exception):
                await asyncio.wait_for(process.wait(), timeout=3)

    async def close(self) -> None:
        if self._native_refresh_task is not None and not self._native_refresh_task.done():
            self._native_refresh_task.cancel()
            await asyncio.gather(self._native_refresh_task, return_exceptions=True)
        for thread_id, process in tuple(self._processes.items()):
            self._interrupts.add(thread_id)
            if process.returncode is None:
                await self._terminate_process(process)
        for task in tuple(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*tuple(self._tasks.values()), return_exceptions=True)
        self._connection.close()
