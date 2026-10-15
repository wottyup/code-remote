from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import sqlite3
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

CLAUDE_THREAD_PREFIX = "claude:"


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
    """Owns Claude Code CLI sessions and projects them into Codex Remote threads."""

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
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._interrupts: set[str] = set()
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
        }

    def list_threads(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM claude_threads ORDER BY updated_at DESC",
        ).fetchall()
        return [self._summary(row) for row in rows]

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
        row = self._row(thread_id)
        result = self._summary(row)
        if not include_turns:
            return result
        try:
            messages = json.loads(row["messages_json"])
        except (TypeError, json.JSONDecodeError):
            messages = []
        result["turns"] = self._turns(messages)
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
        if thread_id in self._tasks:
            await self.interrupt(thread_id)
            task = self._tasks.get(thread_id)
            if task:
                await asyncio.gather(task, return_exceptions=True)
        with self._connection:
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
    ) -> str:
        if not is_claude_thread_id(thread_id):
            raise ClaudeThreadNotFoundError("Claude Code 对话编号无效。")
        status = self.status()
        if not status["available"]:
            raise ClaudeCodeError(status["error"] or "Claude Code CLI 不可用。")
        if not prompt.strip() and not image_paths and not attachment_paths:
            raise ClaudeCodeError("请填写消息或附加文件。")
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
                    SET name = ?, preview = ?, updated_at = ?, running_turn_id = ?, messages_json = ?
                    WHERE thread_id = ?""",
                    (name, preview, created_at, turn_id, json.dumps(messages, ensure_ascii=False), thread_id),
                )
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
    ) -> None:
        assistant_item_id = f"assistant-{turn_id}"
        assistant_text = ""
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
            ]
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
                record_type = record.get("type")
                if record_type == "system" and record.get("subtype") == "init":
                    started = True
                    with self._connection:
                        self._connection.execute(
                            "UPDATE claude_threads SET started = 1 WHERE thread_id = ?", (thread_id,),
                        )
                elif record_type == "stream_event":
                    event = record.get("event")
                    if isinstance(event, dict):
                        delta = event.get("delta")
                        if event.get("type") == "content_block_delta" and isinstance(delta, dict) and delta.get("type") == "text_delta":
                            text = delta.get("text")
                            if isinstance(text, str) and text:
                                assistant_text += text
                                await self._emit_delta(thread_id, turn_id, assistant_item_id, text)
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
                    result = record.get("result")
                    if record.get("is_error") is True:
                        result_error = "Claude Code 执行失败，请检查本机 CLI 登录状态和权限设置后重试。"
                    elif isinstance(result, str) and result and not assistant_text:
                        assistant_text = result
                        await self._emit_delta(thread_id, turn_id, assistant_item_id, result)

            return_code = await process.wait()
            if thread_id in self._interrupts:
                result_error = None
            elif return_code != 0 and result_error is None:
                result_error = "Claude Code 执行失败，请检查本机 CLI 登录状态和权限设置后重试。"
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
        if text:
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
            return True

    @staticmethod
    async def _terminate_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
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
                await process.wait()

    async def close(self) -> None:
        for thread_id, process in tuple(self._processes.items()):
            self._interrupts.add(thread_id)
            if process.returncode is None:
                await self._terminate_process(process)
        for task in tuple(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*tuple(self._tasks.values()), return_exceptions=True)
        self._connection.close()
