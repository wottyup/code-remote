from __future__ import annotations

import asyncio
import difflib
import json
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from watchfiles import Change, DefaultFilter, awatch

logger = logging.getLogger(__name__)


class CodexRuntimeError(RuntimeError):
    pass


class CodexHandoffBusyError(CodexRuntimeError):
    """The remote App Server still has a turn that must not be interrupted."""


class CodexNoActiveTurnError(CodexRuntimeError):
    """A request that requires an active turn arrived after it had finished."""


ApprovalPolicy = Literal["on-request", "untrusted", "never"]


@dataclass
class WorkspaceChangeWatch:
    stop_event: asyncio.Event
    task: asyncio.Task[dict[str, str]]
    baseline: WorkspaceSnapshot


_IGNORED_WORKSPACE_PARTS = frozenset({
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "node_modules",
})

_WORKSPACE_DIFF_MAX_FILE_BYTES = 1_048_576
_WORKSPACE_DIFF_MAX_TOTAL_BYTES = 32 * 1_048_576
_WORKSPACE_DIFF_MAX_FILES = 20_000


@dataclass
class WorkspaceSnapshot:
    paths: frozenset[str]
    text_files: dict[str, bytes]
    complete: bool


@dataclass
class WorkspaceChangeCapture:
    changes: dict[str, str]
    baseline: WorkspaceSnapshot


def snapshot_workspace(workspace: Path) -> WorkspaceSnapshot:
    root = workspace.expanduser().resolve()
    paths: set[str] = set()
    text_files: dict[str, bytes] = {}
    total_bytes = 0
    complete = True

    def mark_incomplete(_error: OSError) -> None:
        nonlocal complete
        complete = False

    for directory, directory_names, file_names in os.walk(root, topdown=True, followlinks=False, onerror=mark_incomplete):
        current_directory = Path(directory)
        directory_names[:] = sorted(
            name for name in directory_names
            if name not in _IGNORED_WORKSPACE_PARTS
            and not (current_directory / name).is_symlink()
        )
        for name in sorted(file_names):
            if len(paths) >= _WORKSPACE_DIFF_MAX_FILES:
                complete = False
                break
            path = current_directory / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                relative = path.relative_to(root).as_posix()
                if any(part in _IGNORED_WORKSPACE_PARTS for part in Path(relative).parts):
                    continue
                paths.add(relative)
                size = path.stat().st_size
                if size > _WORKSPACE_DIFF_MAX_FILE_BYTES or total_bytes + size > _WORKSPACE_DIFF_MAX_TOTAL_BYTES:
                    continue
                content = path.read_bytes()
                if len(content) > _WORKSPACE_DIFF_MAX_FILE_BYTES or b'\0' in content:
                    continue
                content.decode('utf-8-sig')
                text_files[relative] = content
                total_bytes += len(content)
            except (OSError, UnicodeDecodeError):
                continue
        if not complete:
            break
    return WorkspaceSnapshot(paths=frozenset(paths), text_files=text_files, complete=complete)


def _read_workspace_text(workspace: Path, relative_path: str) -> bytes | None:
    root = workspace.expanduser().resolve()
    relative = Path(relative_path)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    if any(part in _IGNORED_WORKSPACE_PARTS for part in relative.parts):
        return None
    candidate = root / relative
    try:
        if candidate.is_symlink() or not candidate.is_file():
            return None
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
        if resolved.stat().st_size > _WORKSPACE_DIFF_MAX_FILE_BYTES:
            return None
        content = resolved.read_bytes()
        if len(content) > _WORKSPACE_DIFF_MAX_FILE_BYTES or b'\0' in content:
            return None
        content.decode('utf-8-sig')
        return content
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _workspace_text_diff(path: str, before: bytes, after: bytes) -> tuple[str, int, int] | None:
    try:
        old_lines = before.decode('utf-8-sig').splitlines()
        new_lines = after.decode('utf-8-sig').splitlines()
    except UnicodeDecodeError:
        return None
    diff_lines = list(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm=""))
    additions = sum(line.startswith('+') and not line.startswith('+++') for line in diff_lines)
    deletions = sum(line.startswith('-') and not line.startswith('---') for line in diff_lines)
    if additions == 0 and deletions == 0:
        return None
    return '\n'.join(diff_lines), additions, deletions


def merge_workspace_change(changes: dict[str, str], path: str, change: Change) -> None:
    """Keep the net file operation for one turn without exposing temporary writes."""
    next_kind = "add" if change == Change.added else "delete" if change == Change.deleted else "update"
    previous_kind = changes.get(path)
    if next_kind == "delete":
        if previous_kind == "add":
            changes.pop(path, None)
        else:
            changes[path] = "delete"
    elif next_kind == "add":
        changes[path] = "update" if previous_kind == "delete" else previous_kind or "add"
    elif previous_kind != "add":
        changes[path] = "update"


def workspace_change_entries(
    changes: dict[str, str],
    workspace: Path,
    baseline: WorkspaceSnapshot,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path, kind in sorted(changes.items()):
        entry: dict[str, Any] = {"path": path, "kind": kind}
        existed_before = path in baseline.paths
        before = baseline.text_files.get(path)
        after = None if kind == "delete" else _read_workspace_text(workspace, path)

        if kind == "delete":
            if before is not None:
                after = b""
        elif before is None and not existed_before and baseline.complete and after is not None:
            before = b""

        if before is not None and after is not None:
            diff = _workspace_text_diff(path, before, after)
            if diff:
                entry["diff"], entry["additions"], entry["deletions"] = diff
        entries.append(entry)
    return entries


class CodexAppServer:
    """Long-lived stdio JSON-RPC connection to the local Codex app-server."""

    def __init__(self, command: str, workspace: Path) -> None:
        self.command = command
        self.workspace = workspace.expanduser().resolve()
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._handoff_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._request_id = 1
        self._pending: dict[str | int, asyncio.Future[dict[str, Any]]] = {}
        self._server_requests: dict[str | int, dict[str, Any]] = {}
        self._active_turn_ids: dict[str, str] = {}
        self._last_completed_turn_ids: dict[str, str] = {}
        self._pending_turn_starts: dict[str, asyncio.Future[str | None]] = {}
        self._workspace_change_watches: dict[str, WorkspaceChangeWatch] = {}
        self._workspace_completion_tasks: dict[asyncio.Task[None], WorkspaceChangeWatch] = {}
        # Command-based edits do not always produce a native FileChange item.
        # Keep their watcher fallback per completed turn so a later turn never
        # replaces a card that belongs to an earlier reply in the same thread.
        self._workspace_change_results: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._initialized = False
        self._handed_off = False

    @property
    def connected(self) -> bool:
        return self._initialized and self._process is not None and self._process.returncode is None

    @property
    def handed_off(self) -> bool:
        return self._handed_off

    @property
    def has_active_turns(self) -> bool:
        return bool(self._active_turn_ids or self._pending_turn_starts)

    def status(self) -> dict[str, Any]:
        return {
            "available": self._resolve_executable() is not None,
            "connected": self.connected,
            "workspace": str(self.workspace),
            "handedOff": self._handed_off,
            "error": None,
        }

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers.add(queue)
        for request_id, request in self._server_requests.items():
            queue.put_nowait({
                "type": "server_request",
                "request_id": request_id,
                "method": request.get("method"),
                "params": request.get("params", {}),
            })
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    async def notify_threads_changed(self) -> None:
        await self._emit({"type": "threads.changed"})

    async def notify_turn_delivery(self, thread_id: str, request_id: str | None, turn_id: str | None) -> None:
        if request_id is None:
            return
        await self._emit({
            "type": "turn.delivery",
            "request_id": request_id,
            "params": {"threadId": thread_id, "turnId": turn_id},
        })

    async def connect(self) -> dict[str, Any]:
        await self._ensure_started()
        return self.status()

    async def handoff_to_local_codex(self) -> None:
        """Release the remote-owned App Server without stopping the web service.

        `thread/unsubscribe` has a long inactivity grace period, so immediate
        handoff requires ending this transport.  While handed off, ordinary
        requests are rejected so browser prefetch or reconnect activity cannot
        immediately create a new remote owner.
        """
        async with self._handoff_lock:
            if self.has_active_turns:
                raise CodexHandoffBusyError("网页端仍有 Codex 任务在运行，请先停止或等待回复完成后再交还。")
            self._handed_off = True
            try:
                await self.close()
            except Exception:
                self._handed_off = False
                raise

    async def reclaim_for_remote(self) -> dict[str, Any]:
        """Allow the web client to start a fresh App Server on its next request."""
        async with self._handoff_lock:
            self._handed_off = False
            return self.status()

    async def list_threads(self) -> list[dict[str, Any]]:
        result = await self.request("thread/list", {"limit": 100})
        items = result.get("data", result.get("threads", []))
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    async def read_thread(self, thread_id: str, *, include_turns: bool = True) -> dict[str, Any]:
        active_before = self._active_turn_ids.get(thread_id)
        result = await self.request("thread/read", {"threadId": thread_id, "includeTurns": include_turns})
        thread = result.get("thread")
        if not isinstance(thread, dict):
            raise CodexRuntimeError("Codex 没有返回该对话内容")
        turns = thread.get("turns")
        status = thread.get("status")
        status_type = status.get("type") if isinstance(status, dict) else None
        cached_turn_ended = isinstance(turns, list) and any(
            isinstance(turn, dict) and turn.get("id") == active_before
            and turn.get("status") in {"completed", "interrupted", "failed"}
            for turn in turns
        )
        if (
            active_before and self._active_turn_ids.get(thread_id) == active_before
            and thread_id not in self._pending_turn_starts
            and (status_type in {"idle", "notLoaded"} or cached_turn_ended)
        ):
            self._active_turn_ids.pop(thread_id, None)
        workspace_changes = self._workspace_change_results.get(thread_id, {})
        turn_ids = {
            turn.get("id")
            for turn in turns if isinstance(turn, dict) and isinstance(turn.get("id"), str)
        } if isinstance(turns, list) else set()
        matched_workspace_changes = {
            turn_id: changes
            for turn_id, changes in workspace_changes.items()
            if turn_id in turn_ids and changes
        }
        if matched_workspace_changes:
            thread["codexRemoteWorkspaceChanges"] = matched_workspace_changes
        return thread

    async def list_models(self) -> list[dict[str, Any]]:
        result = await self.request("model/list", {"limit": 100, "includeHidden": False})
        models = result.get("data", [])
        return [model for model in models if isinstance(model, dict)] if isinstance(models, list) else []

    async def start_thread(
        self,
        model: str | None = None,
        approval_policy: ApprovalPolicy | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(self.workspace),
            "serviceName": "codex_remote_web",
        }
        if model:
            params["model"] = model
        if approval_policy:
            params["approvalPolicy"] = approval_policy
            params["sandbox"] = "danger-full-access" if approval_policy == "never" else "workspace-write"
        result = await self.request("thread/start", params)
        thread = result.get("thread")
        if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
            raise CodexRuntimeError("Codex 没有返回新对话编号")
        return thread

    async def resume_thread(self, thread_id: str) -> dict[str, Any]:
        result = await self.request("thread/resume", {"threadId": thread_id})
        thread = result.get("thread")
        if not isinstance(thread, dict):
            raise CodexRuntimeError("Codex 无法恢复该对话")
        return thread

    async def set_thread_name(self, thread_id: str, name: str) -> None:
        await self.request("thread/name/set", {"threadId": thread_id, "name": name})

    async def _watch_workspace_changes(self, stop_event: asyncio.Event) -> dict[str, str]:
        changes: dict[str, str] = {}
        try:
            async for batch in awatch(
                self.workspace,
                watch_filter=DefaultFilter(),
                debounce=80,
                step=20,
                stop_event=stop_event,
                ignore_permission_denied=True,
            ):
                for change, changed_path in batch:
                    path = Path(changed_path)
                    try:
                        relative = path.resolve().relative_to(self.workspace)
                    except ValueError:
                        continue
                    if (
                        not relative.parts
                        or any(part in _IGNORED_WORKSPACE_PARTS for part in relative.parts)
                        or (change != Change.deleted and path.is_dir())
                    ):
                        continue
                    merge_workspace_change(changes, relative.as_posix(), change)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Unable to watch Codex workspace changes", exc_info=True)
        return changes

    async def _start_workspace_change_watch(self, thread_id: str) -> None:
        await self._stop_workspace_change_watch(thread_id)
        baseline = await asyncio.to_thread(snapshot_workspace, self.workspace)
        stop_event = asyncio.Event()
        task = asyncio.create_task(self._watch_workspace_changes(stop_event))
        self._workspace_change_watches[thread_id] = WorkspaceChangeWatch(stop_event=stop_event, task=task, baseline=baseline)
        # Let awatch register before turn/start can begin writing files.
        await asyncio.sleep(0)

    async def _stop_workspace_change_watch(self, thread_id: str, *, collect: bool = False) -> WorkspaceChangeCapture | None:
        watch = self._workspace_change_watches.pop(thread_id, None)
        if watch is None:
            return None
        return await self._collect_workspace_change_watch(watch, collect=collect)

    async def _collect_workspace_change_watch(self, watch: WorkspaceChangeWatch, *, collect: bool) -> WorkspaceChangeCapture:
        if collect:
            # Let the small debounce window flush the final write before closing.
            await asyncio.sleep(0.1)
        watch.stop_event.set()
        changes: dict[str, str] = {}
        try:
            changes = await asyncio.wait_for(watch.task, timeout=1)
        except TimeoutError:
            watch.task.cancel()
            try:
                await watch.task
            except asyncio.CancelledError:
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Unable to stop Codex workspace change watch", exc_info=True)
        return WorkspaceChangeCapture(changes=changes, baseline=watch.baseline)

    async def _complete_workspace_change_watch(self, thread_id: str, turn_id: str | None, watch: WorkspaceChangeWatch) -> None:
        try:
            capture = await self._collect_workspace_change_watch(watch, collect=True)
            changes = await asyncio.to_thread(workspace_change_entries, capture.changes, self.workspace, capture.baseline)
            # The detached watcher belongs only to this completed turn, even
            # when the next turn has already installed its own watcher.
            if not changes or not turn_id:
                return
            self._workspace_change_results.setdefault(thread_id, {})[turn_id] = changes
            await self._emit({
                "type": "notification",
                "method": "turn/workspaceChanges",
                "params": {"threadId": thread_id, "turnId": turn_id, "changes": changes},
            })
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Unable to collect completed workspace changes", exc_info=True)
        finally:
            watch.stop_event.set()
            if not watch.task.done():
                watch.task.cancel()
                try:
                    await watch.task
                except asyncio.CancelledError:
                    pass

    async def _clear_workspace_change_watches(self) -> None:
        tasks = tuple(self._workspace_completion_tasks)
        detached_watches = tuple(self._workspace_completion_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._workspace_completion_tasks.clear()
        # A task canceled before its first instruction never runs its finally
        # block; retain detached watchers until shutdown can close those too.
        for watch in detached_watches:
            watch.stop_event.set()
            if not watch.task.done():
                watch.task.cancel()
        await asyncio.gather(*(watch.task for watch in detached_watches), return_exceptions=True)
        for thread_id in tuple(self._workspace_change_watches):
            await self._stop_workspace_change_watch(thread_id)
        self._workspace_change_results.clear()

    async def start_turn(
        self,
        thread_id: str,
        prompt: str,
        image_paths: list[Path] | None = None,
        model: str | None = None,
        effort: str | None = None,
        approval_policy: ApprovalPolicy | None = None,
    ) -> dict[str, Any]:
        if len(prompt) > 32_000:
            raise CodexRuntimeError("消息不能超过 32000 个字符")
        images = image_paths or []
        if not prompt.strip() and not images:
            raise CodexRuntimeError("请填写消息或附加图片")
        input_items: list[dict[str, Any]] = []
        if prompt.strip():
            input_items.append({"type": "text", "text": prompt})
        input_items.extend({"type": "localImage", "path": str(path)} for path in images)
        params: dict[str, Any] = {"threadId": thread_id, "input": input_items}
        if model:
            params["model"] = model
        if effort:
            params["effort"] = effort
        if approval_policy:
            params["approvalPolicy"] = approval_policy
            params["sandboxPolicy"] = {
                "type": "dangerFullAccess" if approval_policy == "never" else "workspaceWrite",
            }
        pending_start = asyncio.get_running_loop().create_future()
        self._pending_turn_starts[thread_id] = pending_start
        try:
            await self._start_workspace_change_watch(thread_id)
            result = await self.request("turn/start", params)
            turn = result.get("turn")
            turn_id = turn.get("id") if isinstance(turn, dict) and isinstance(turn.get("id"), str) else None
            completed = isinstance(turn, dict) and turn.get("status") in {"completed", "interrupted", "failed"}
            if turn_id and not completed and self._last_completed_turn_ids.get(thread_id) != turn_id:
                self._active_turn_ids[thread_id] = turn_id
            if not pending_start.done():
                pending_start.set_result(turn_id)
            return result
        except (Exception, asyncio.CancelledError):
            await self._stop_workspace_change_watch(thread_id)
            if not pending_start.done():
                pending_start.set_result(None)
            raise
        finally:
            if self._pending_turn_starts.get(thread_id) is pending_start:
                self._pending_turn_starts.pop(thread_id, None)

    async def _active_turn_id(self, thread_id: str) -> str | None:
        active_turn_id = self._active_turn_ids.get(thread_id)
        if active_turn_id:
            return active_turn_id
        pending_start = self._pending_turn_starts.get(thread_id)
        if not pending_start:
            return None
        try:
            pending_turn_id = await asyncio.wait_for(asyncio.shield(pending_start), timeout=5)
        except TimeoutError:
            pending_turn_id = None
        if pending_turn_id and self._last_completed_turn_ids.get(thread_id) == pending_turn_id:
            pending_turn_id = None
        return self._active_turn_ids.get(thread_id) or pending_turn_id

    async def steer_turn(
        self,
        thread_id: str,
        prompt: str,
        image_paths: list[Path] | None = None,
    ) -> dict[str, Any]:
        """Append input to the current turn without starting a concurrent turn."""
        if len(prompt) > 32_000:
            raise CodexRuntimeError("消息不能超过 32000 个字符")
        images = image_paths or []
        if not prompt.strip() and not images:
            raise CodexRuntimeError("请填写消息或附加图片")
        active_turn_id = await self._active_turn_id(thread_id)
        if not active_turn_id:
            raise CodexNoActiveTurnError("Codex 当前没有可立即发送的回复")
        input_items: list[dict[str, Any]] = []
        if prompt.strip():
            input_items.append({"type": "text", "text": prompt})
        input_items.extend({"type": "localImage", "path": str(path)} for path in images)
        return await self.request("turn/steer", {
            "threadId": thread_id,
            "input": input_items,
            # Always use the runtime's ID, not a potentially stale browser ID.
            "expectedTurnId": active_turn_id,
        })

    async def interrupt(self, thread_id: str, turn_id: str | None = None) -> dict[str, Any]:
        active_turn_id = await self._active_turn_id(thread_id) or turn_id
        if not active_turn_id:
            raise CodexRuntimeError("Codex 当前没有可中断的任务")
        return await self.request("turn/interrupt", {"threadId": thread_id, "turnId": active_turn_id})

    async def answer_server_request(self, request_id: str | int, decision: str) -> None:
        if request_id not in self._server_requests:
            raise CodexRuntimeError("该审批请求已过期或已处理")
        if decision not in {"accept", "decline", "cancel"}:
            raise CodexRuntimeError("不支持的审批操作")
        self._server_requests.pop(request_id, None)
        await self._write({"id": request_id, "result": {"decision": decision}})

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._raise_if_handed_off()
        await self._ensure_started()
        return await self._request(method, params, timeout=90)

    async def close(self) -> None:
        process = self._process
        self._initialized = False
        self._server_requests.clear()
        self._active_turn_ids.clear()
        self._finish_pending_turn_starts()
        await self._clear_workspace_change_watches()
        if process is None:
            return
        if process.stdin and not process.stdin.is_closing():
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        await self._cancel_io_tasks()
        self._process = None
        self._fail_pending("Codex app-server 已关闭")

    async def _ensure_started(self) -> None:
        self._raise_if_handed_off()
        async with self._start_lock:
            self._raise_if_handed_off()
            if self.connected:
                return
            await self._stop_process()
            executable = self._resolve_executable()
            if not executable:
                raise CodexRuntimeError(f"找不到 Codex CLI：{self.command}")
            if not self.workspace.is_dir():
                raise CodexRuntimeError(f"工作目录不存在：{self.workspace}")
            try:
                process = await asyncio.create_subprocess_exec(
                    executable,
                    "app-server",
                    "--listen",
                    "stdio://",
                    cwd=self.workspace,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    # thread/read returns a whole conversation as one JSONL line.
                    # Keep enough room for large Codex histories; asyncio defaults to 64 KiB.
                    limit=64 * 1024 * 1024,
                )
            except OSError as error:
                raise CodexRuntimeError(f"无法启动 Codex app-server：{error}") from error

            self._process = process
            self._reader_task = asyncio.create_task(self._read_stdout(process))
            self._stderr_task = asyncio.create_task(self._read_stderr(process))
            try:
                await self._request("initialize", {
                    "clientInfo": {
                        "name": "codex_remote_web",
                        "title": "Codex Remote Web",
                        "version": "0.0.30",
                    },
                    "capabilities": {
                        "experimentalApi": False,
                        "requestAttestation": False,
                    },
                }, timeout=20)
                await self._write({"method": "initialized", "params": {}})
                self._initialized = True
                await self._emit({"type": "connection", **self.status()})
            except Exception as error:
                await self._stop_process()
                if isinstance(error, CodexRuntimeError):
                    raise
                raise CodexRuntimeError(f"Codex app-server 初始化失败：{error}") from error

    def _resolve_executable(self) -> str | None:
        candidates = [self.command]
        if os.name == "nt" and not Path(self.command).suffix:
            candidates.extend((f"{self.command}.cmd", f"{self.command}.exe"))
        for candidate in candidates:
            executable = shutil.which(candidate)
            if executable:
                return executable
        return None

    def _raise_if_handed_off(self) -> None:
        if self._handed_off:
            raise CodexRuntimeError("网页端已交还给本机 Codex，请先在网页端选择“重新接管”。")

    async def _request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        request_id = f"codex-remote-{self._request_id}"
        self._request_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({"id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError as error:
            raise CodexRuntimeError(f"Codex 请求超时：{method}") from error
        except (BrokenPipeError, ConnectionError, RuntimeError) as error:
            if isinstance(error, CodexRuntimeError):
                raise
            raise CodexRuntimeError(f"Codex 连接中断：{error}") from error
        finally:
            self._pending.pop(request_id, None)

    async def _write(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.returncode is not None or process.stdin is None:
            raise CodexRuntimeError("Codex app-server 未运行")
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        async with self._write_lock:
            process.stdin.write(data)
            await process.stdin.drain()

    async def _read_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout is not None
        try:
            while line := await process.stdout.readline():
                try:
                    message = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    logger.warning("Ignoring non-JSON stdout from Codex app-server")
                    continue
                await self._handle_message(message)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Codex app-server message reader stopped")
        finally:
            if process is self._process:
                self._initialized = False
                self._fail_pending("Codex app-server 已断开")
                await self._emit({
                    "type": "connection",
                    **self.status(),
                    "error": "Codex app-server 已断开",
                })

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr is not None
        try:
            while line := await process.stderr.readline():
                logger.info("Codex: %s", line.decode("utf-8", errors="replace").rstrip())
        except asyncio.CancelledError:
            raise

    async def _handle_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        request_id = message.get("id")
        method = message.get("method")
        if request_id in self._pending and not isinstance(method, str):
            future = self._pending[request_id]
            if future.done():
                return
            error = message.get("error")
            if error:
                detail = error.get("message", error) if isinstance(error, dict) else error
                future.set_exception(CodexRuntimeError(str(detail)))
            else:
                result = message.get("result", {})
                future.set_result(result if isinstance(result, dict) else {"value": result})
            return

        if not isinstance(method, str):
            return
        if request_id is not None:
            if method not in {
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
                "execCommandApproval",
                "applyPatchApproval",
            }:
                await self._write({
                    "id": request_id,
                    "error": {"code": -32601, "message": "This Codex Remote client does not support this request."},
                })
                return
            self._server_requests[request_id] = message
            await self._emit({
                "type": "server_request",
                "request_id": request_id,
                "method": method,
                "params": message.get("params", {}),
            })
        else:
            params = message.get("params", {})
            if not isinstance(params, dict):
                params = {}
            turn = params.get("turn")
            turn_id = turn.get("id") if isinstance(turn, dict) else params.get("turnId")
            if not isinstance(turn_id, str):
                turn_id = None
            thread_id = params.get("threadId")
            if not isinstance(thread_id, str) and isinstance(turn, dict):
                candidate = turn.get("threadId")
                thread_id = candidate if isinstance(candidate, str) else None
            # Some app-server item notifications carry only turnId. Resolve
            # that turn against the active-turn map before broadcasting so
            # multiple browser panes can route deltas to the right thread.
            if not isinstance(thread_id, str) and turn_id:
                thread_id = next(
                    (candidate_thread_id for candidate_thread_id, candidate_turn_id in self._active_turn_ids.items() if candidate_turn_id == turn_id),
                    None,
                )
            if isinstance(thread_id, str) and params.get("threadId") != thread_id:
                params = {**params, "threadId": thread_id}
            completed_thread_id: str | None = None
            completed_turn_id: str | None = turn_id
            if method == "turn/started" and thread_id and turn_id:
                self._active_turn_ids[thread_id] = turn_id
                pending_start = self._pending_turn_starts.get(thread_id)
                if pending_start and not pending_start.done():
                    pending_start.set_result(turn_id)
            elif method == "turn/completed":
                completed_thread_id = thread_id
                if turn_id and thread_id:
                    self._last_completed_turn_ids[thread_id] = turn_id
                    active_id = self._active_turn_ids.get(thread_id)
                    if active_id and active_id != turn_id:
                        # A delayed completion must not detach a newer watch.
                        completed_thread_id = None
                    if self._active_turn_ids.get(thread_id) == turn_id:
                        self._active_turn_ids.pop(thread_id, None)
                elif thread_id:
                    completed_turn_id = self._active_turn_ids.pop(thread_id, None)
                    if completed_turn_id:
                        self._last_completed_turn_ids[thread_id] = completed_turn_id
                elif turn_id:
                    for active_thread_id, active_turn_id in tuple(self._active_turn_ids.items()):
                        if active_turn_id == turn_id:
                            self._active_turn_ids.pop(active_thread_id, None)
                            completed_thread_id = active_thread_id
                            break
            if method == "turn/completed" and completed_thread_id:
                watch = self._workspace_change_watches.pop(completed_thread_id, None)
                if watch is not None:
                    # Never hold the JSON-RPC reader (or queue wake-up) behind
                    # filesystem debounce and potentially expensive diffs.
                    task = asyncio.create_task(self._complete_workspace_change_watch(completed_thread_id, completed_turn_id, watch))
                    self._workspace_completion_tasks[task] = watch
                    task.add_done_callback(lambda completed: self._workspace_completion_tasks.pop(completed, None))
            await self._emit({"type": "notification", "method": method, "params": params})

    async def _emit(self, event: dict[str, Any]) -> None:
        for queue in tuple(self._subscribers):
            queue.put_nowait(event)

    def _fail_pending(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexRuntimeError(message))

    def _finish_pending_turn_starts(self) -> None:
        for future in self._pending_turn_starts.values():
            if not future.done():
                future.set_result(None)
        self._pending_turn_starts.clear()

    async def _cancel_io_tasks(self) -> None:
        for task in (self._reader_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
        for task in (self._reader_task, self._stderr_task):
            if task:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._reader_task = None
        self._stderr_task = None

    async def _stop_process(self) -> None:
        process = self._process
        self._process = None
        self._initialized = False
        self._server_requests.clear()
        self._active_turn_ids.clear()
        self._last_completed_turn_ids.clear()
        self._finish_pending_turn_starts()
        await self._clear_workspace_change_watches()
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        await self._cancel_io_tasks()
        self._fail_pending("Codex app-server 正在重启")
