from __future__ import annotations

import asyncio
import difflib
import json
import logging
import os
import sqlite3
import shutil
import subprocess
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from watchfiles import Change, DefaultFilter, awatch
from .codex_history import CodexHistoryStore

logger = logging.getLogger(__name__)


_SHARED_DAEMON_FALLBACK_MARKERS = (
    "daemon.lock",
    "daemon operation lock",
    "daemon state directory",
    "app-server-control.sock",
    "app-server control socket",
    "failed to connect to socket",
    "unrecognized subcommand 'daemon'",
)
_WINDOWS_ACCESS_DENIED_MARKERS = ("os error 5", "os error 10013", "access is denied", "permission denied", "拒绝访问")
_SHARED_DAEMON_FALLBACK_MESSAGE = (
    "Windows 共享 Codex app-server 不可用，已切换到兼容运行时；"
    "网页会话会尝试同步到本机 Codex 历史；若主索引不可写，桌面侧栏暂时不会显示这些会话。"
)


class CodexRuntimeError(RuntimeError):
    pass


class CodexHandoffBusyError(CodexRuntimeError):
    """The remote App Server still has a turn that must not be interrupted."""


class CodexNoActiveTurnError(CodexRuntimeError):
    """A request that requires an active turn arrived after it had finished."""


class CodexThreadBusyError(CodexRuntimeError):
    """A destructive thread operation was requested while its turn is active."""


class CodexThreadNotFoundError(CodexRuntimeError):
    """A requested thread no longer exists in Codex history."""


ApprovalPolicy = Literal["on-request", "untrusted", "never"]


@dataclass
class WorkspaceChangeWatch:
    stop_event: asyncio.Event
    task: asyncio.Task[WorkspaceSnapshot]
    baseline: WorkspaceSnapshot
    workspace: Path


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
    metadata: dict[str, tuple[int, int, int]] = field(default_factory=dict)


@dataclass
class WorkspaceChangeCapture:
    changes: dict[str, str]
    baseline: WorkspaceSnapshot
    after: WorkspaceSnapshot | None = None


def snapshot_workspace(workspace: Path) -> WorkspaceSnapshot:
    root = workspace.expanduser().resolve()
    paths: set[str] = set()
    text_files: dict[str, bytes] = {}
    metadata: dict[str, tuple[int, int, int]] = {}
    total_bytes = 0
    complete = True
    pending = [(str(root), "")]
    while pending:
        directory, prefix = pending.pop()
        try:
            with os.scandir(directory) as entries:
                entries = sorted(entries, key=lambda entry: entry.name)
        except OSError:
            complete = False
            continue
        next_directories: list[tuple[str, str]] = []
        for entry in entries:
            if len(paths) >= _WORKSPACE_DIFF_MAX_FILES:
                complete = False
                break
            try:
                if entry.name in _IGNORED_WORKSPACE_PARTS:
                    continue
                relative = prefix + entry.name
                if entry.is_dir(follow_symlinks=False):
                    next_directories.append((entry.path, relative + "/"))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                paths.add(relative)
                stat = entry.stat(follow_symlinks=False)
                size = stat.st_size
                metadata[relative] = (stat.st_mtime_ns, stat.st_ctime_ns, size)
                if size > _WORKSPACE_DIFF_MAX_FILE_BYTES or total_bytes + size > _WORKSPACE_DIFF_MAX_TOTAL_BYTES:
                    continue
                with open(entry.path, "rb") as source:
                    content = source.read(_WORKSPACE_DIFF_MAX_FILE_BYTES + 1)
                if len(content) > _WORKSPACE_DIFF_MAX_FILE_BYTES or b'\0' in content:
                    continue
                content.decode('utf-8-sig')
                text_files[relative] = content
                total_bytes += len(content)
            except OSError:
                complete = False
                continue
            except UnicodeDecodeError:
                continue
        if len(paths) >= _WORKSPACE_DIFF_MAX_FILES:
            complete = False
            break
        pending.extend(reversed(next_directories))
    return WorkspaceSnapshot(paths=frozenset(paths), text_files=text_files, complete=complete, metadata=metadata)


def workspace_snapshot_changes(before: WorkspaceSnapshot, after: WorkspaceSnapshot) -> dict[str, str]:
    changes: dict[str, str] = {}
    # A truncated scan cannot prove that a missing path did not exist.
    if before.complete:
        changes.update((path, "add") for path in after.paths - before.paths)
    if after.complete:
        changes.update((path, "delete") for path in before.paths - after.paths)
    for path in before.paths & after.paths:
        if path in before.text_files and path in after.text_files:
            modified = before.text_files[path] != after.text_files[path]
        else:
            modified = before.metadata.get(path) != after.metadata.get(path)
        if modified:
            changes[path] = "update"
    return changes


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
    after_snapshot: WorkspaceSnapshot | None = None,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path, kind in sorted(changes.items()):
        entry: dict[str, Any] = {"path": path, "kind": kind}
        existed_before = path in baseline.paths
        before = baseline.text_files.get(path)
        after = None if kind == "delete" else (
            after_snapshot.text_files.get(path) if after_snapshot is not None else _read_workspace_text(workspace, path)
        )

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
        self._history_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()
        configured_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
        self._runtime_home = (
            Path(configured_runtime_home).expanduser().resolve()
            if configured_runtime_home
            else self._history_home
        )
        self._use_shared_daemon = os.name == "nt" and configured_runtime_home is None
        default_history_home = (Path.home() / ".codex").resolve()
        self._fallback_runtime_home = (
            Path(__file__).resolve().parents[2] / ".codex-remote" / "app-server-home"
            if os.name == "nt" and configured_runtime_home is None
            else None
        )
        self._legacy_runtime_home = (
            self._fallback_runtime_home
            if os.name == "nt"
            and configured_runtime_home is None
            and self._history_home == default_history_home
            else None
        )
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._history_sync_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._handoff_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._runtime_history_lock = asyncio.Lock()
        self._request_id = 1
        self._pending: dict[str | int, asyncio.Future[dict[str, Any]]] = {}
        self._server_requests: dict[str | int, dict[str, Any]] = {}
        self._active_turn_ids: dict[str, str] = {}
        self._last_completed_turn_ids: dict[str, str] = {}
        self._pending_turn_starts: dict[str, asyncio.Future[str | None]] = {}
        self._workspace_change_watches: dict[str, WorkspaceChangeWatch] = {}
        self._workspace_completion_tasks: dict[asyncio.Task[None], WorkspaceChangeWatch] = {}
        self._runtime_thread_sync_tasks: set[asyncio.Task[None]] = set()
        # Command-based edits do not always produce a native FileChange item.
        # Keep their watcher fallback per completed turn so a later turn never
        # replaces a card that belongs to an earlier reply in the same thread.
        self._workspace_change_results: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._initialized = False
        self._handed_off = False
        self._last_error: str | None = None
        self._runtime_mode = (
            "shared"
            if self._use_shared_daemon
            else "isolated"
            if configured_runtime_home
            else "direct"
        )
        self._fallback_reason: str | None = None
        self._recent_stderr: list[str] = []
        self._history = CodexHistoryStore(self._history_home)

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
            "runtimeMode": self._runtime_mode,
            "runtimeMessage": _SHARED_DAEMON_FALLBACK_MESSAGE if self._runtime_mode == "isolated-fallback" else None,
            "fallbackReason": self._fallback_reason,
            "error": self._last_error,
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
        self._history.invalidate()
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
        history_items = self._history.list_threads()
        if not self.connected and history_items:
            return history_items
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        app_server_error: CodexRuntimeError | None = None
        for _ in range(20):
            params: dict[str, Any] = {
                "limit": 100,
                "sortKey": "updated_at",
                "sortDirection": "desc",
            }
            if cursor:
                params["cursor"] = cursor
            try:
                result = await self.request("thread/list", params)
            except CodexRuntimeError as error:
                if items:
                    app_server_error = error
                    break
                try:
                    result = await self.request("thread/list", {"limit": 100})
                except CodexRuntimeError:
                    app_server_error = error
                    break
            page = result.get("data", result.get("threads", []))
            if not isinstance(page, list):
                break
            items.extend(item for item in page if isinstance(item, dict))
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor or not page:
                break
            cursor = next_cursor

        merged: dict[str, dict[str, Any]] = {
            item["id"]: item
            for item in history_items
            if isinstance(item.get("id"), str)
        }
        for item in items:
            thread_id = item.get("id")
            if not isinstance(thread_id, str):
                continue
            merged[thread_id] = {**merged.get(thread_id, {}), **item}
        if merged:
            return list(merged.values())
        if app_server_error is not None:
            raise app_server_error
        return []

    async def read_thread(self, thread_id: str, *, include_turns: bool = True) -> dict[str, Any]:
        active_before = self._active_turn_ids.get(thread_id)
        history_thread = self._history.read_thread(thread_id)
        runtime_turn_id = self._active_turn_ids.get(thread_id)
        thread: dict[str, Any] | None = None
        read_error: CodexRuntimeError | None = None
        if runtime_turn_id is None and isinstance(history_thread, dict):
            thread = history_thread
        else:
            try:
                result = await self.request("thread/read", {"threadId": thread_id, "includeTurns": include_turns})
                candidate = result.get("thread")
                if isinstance(candidate, dict):
                    thread = candidate
            except CodexRuntimeError as error:
                read_error = error

        if isinstance(history_thread, dict):
            server_turns = thread.get("turns") if thread is not None else None
            history_turns = history_thread.get("turns")
            if thread is None or (
                runtime_turn_id is None
                and isinstance(history_turns, list)
                and history_turns
            ) or (
                isinstance(server_turns, list)
                and not server_turns
                and isinstance(history_turns, list)
                and history_turns
            ):
                thread = history_thread

        if thread is None:
            if read_error is not None:
                raise read_error
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

    async def delete_thread(self, thread_id: str) -> None:
        try:
            summary = await self.read_thread(thread_id, include_turns=False)
        except CodexRuntimeError as error:
            raise CodexThreadNotFoundError("找不到要删除的聊天。") from error
        status = summary.get("status")
        status_type = status.get("type") if isinstance(status, dict) else None
        if await self._active_turn_id(thread_id) or status_type in {"active", "inProgress", "running", "started"}:
            raise CodexThreadBusyError("该聊天仍在回复中，请等待完成或停止回复后再删除。")

        await self._prepare_runtime_thread(thread_id)
        try:
            await self.request("thread/delete", {"threadId": thread_id})
        except CodexRuntimeError as error:
            detail = str(error).casefold()
            if any(marker in detail for marker in ("active", "running", "in progress", "busy", "正在运行", "回复中")):
                raise CodexThreadBusyError("该聊天仍在回复中，请等待完成或停止回复后再删除。") from error
            if any(marker in detail for marker in ("not found", "unknown thread", "找不到")):
                raise CodexThreadNotFoundError("找不到要删除的聊天。") from error
            raise

        # An explicitly isolated runtime owns a synchronized copy. The native
        # request removes that copy; remove the verified source record as well
        # so desktop Codex and future runtime reseeds do not restore it.
        if self._runtime_home != self._history_home:
            try:
                self._history.delete_thread(thread_id)
            except OSError as error:
                raise CodexRuntimeError(str(error)) from error
        self._forget_thread_runtime_state(thread_id)
        await self.notify_threads_changed()

    def _forget_thread_runtime_state(self, thread_id: str) -> None:
        self._active_turn_ids.pop(thread_id, None)
        self._last_completed_turn_ids.pop(thread_id, None)
        self._workspace_change_results.pop(thread_id, None)
        self._history.invalidate()

    async def list_models(self) -> list[dict[str, Any]]:
        configured_models = self._configured_models()
        if configured_models:
            return configured_models
        try:
            result = await self.request("model/list", {"limit": 100, "includeHidden": False})
            models = result.get("data", [])
            if isinstance(models, list) and models:
                return [model for model in models if isinstance(model, dict)]
        except CodexRuntimeError:
            pass
        return self._configured_models()

    def _configured_models(self) -> list[dict[str, Any]]:
        config_path = self._history_home / "config.toml"
        try:
            config_text = config_path.read_text(encoding="utf-8")
        except OSError:
            return []
        catalog_path: Path | None = None
        for line in config_text.splitlines():
            if line.strip().startswith("model_catalog_json") and "=" in line:
                raw_path = line.split("=", 1)[1].strip().strip('"').strip("'")
                catalog_path = Path(raw_path).expanduser()
                if not catalog_path.is_absolute():
                    catalog_path = config_path.parent / catalog_path
                break
        if catalog_path is None:
            return []
        try:
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        models = catalog.get("models") if isinstance(catalog, dict) else None
        if not isinstance(models, list):
            return []
        configured_default = None
        for line in config_text.splitlines():
            if line.strip().startswith("model ="):
                configured_default = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
        result: list[dict[str, Any]] = []
        for entry in models:
            if not isinstance(entry, dict) or entry.get("visibility") != "list":
                continue
            model_id = entry.get("slug")
            if not isinstance(model_id, str) or not model_id:
                continue
            efforts = entry.get("supported_reasoning_levels")
            supported = [
                {"reasoningEffort": item.get("effort"), "description": item.get("description")}
                for item in efforts
                if isinstance(item, dict) and isinstance(item.get("effort"), str)
            ] if isinstance(efforts, list) else []
            result.append({
                "id": model_id,
                "model": model_id,
                "displayName": entry.get("display_name") or model_id,
                "description": entry.get("description"),
                "supportedReasoningEfforts": supported,
                "defaultReasoningEffort": entry.get("default_reasoning_level"),
                "inputModalities": entry.get("input_modalities") or ["text"],
                "isDefault": model_id == configured_default,
            })
        if result and not any(model["isDefault"] for model in result):
            result[0]["isDefault"] = True
        return result

    async def start_thread(
        self,
        model: str | None = None,
        approval_policy: ApprovalPolicy | None = None,
        cwd: Path | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(cwd or self.workspace),
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
        thread_cwd = thread.get("cwd")
        if not isinstance(thread_cwd, str) or not thread_cwd.strip():
            thread_cwd = str(cwd or self.workspace)
        return {**thread, "cwd": thread_cwd}

    async def resume_thread(self, thread_id: str, cwd: Path | None = None) -> dict[str, Any]:
        await self._prepare_runtime_thread(thread_id)
        if self._runtime_home != self._history_home and not self._database_has_thread(
            self._runtime_home / "thread_history_1.sqlite", thread_id,
        ):
            raise CodexRuntimeError("本机 Codex 历史数据库没有该对话，无法在隔离运行时中恢复。")
        params: dict[str, Any] = {"threadId": thread_id}
        if cwd is not None:
            params["cwd"] = str(cwd)
        result = await self.request("thread/resume", params)
        thread = result.get("thread")
        if not isinstance(thread, dict):
            raise CodexRuntimeError("Codex 无法恢复该对话")
        return {**thread, "cwd": str(cwd)} if cwd is not None else thread

    async def set_thread_name(self, thread_id: str, name: str) -> None:
        await self.request("thread/name/set", {"threadId": thread_id, "name": name})

    async def _watch_workspace_changes(self, stop_event: asyncio.Event, workspace: Path) -> WorkspaceSnapshot:
        # Native file-change events already supply live progress. This fallback
        # is used only after completion, so no recursive OS watcher is needed.
        await stop_event.wait()
        return await asyncio.to_thread(snapshot_workspace, workspace)

    async def _start_workspace_change_watch(self, thread_id: str, workspace: Path | None = None) -> None:
        await self._stop_workspace_change_watch(thread_id)
        watch_workspace = (workspace or self.workspace).expanduser().resolve()
        baseline = await asyncio.to_thread(snapshot_workspace, watch_workspace)
        stop_event = asyncio.Event()
        task = asyncio.create_task(self._watch_workspace_changes(stop_event, watch_workspace))
        self._workspace_change_watches[thread_id] = WorkspaceChangeWatch(
            stop_event=stop_event, task=task, baseline=baseline, workspace=watch_workspace,
        )

    async def _stop_workspace_change_watch(self, thread_id: str, *, collect: bool = False) -> WorkspaceChangeCapture | None:
        watch = self._workspace_change_watches.pop(thread_id, None)
        if watch is None:
            return None
        return await self._collect_workspace_change_watch(watch, collect=collect)

    async def _collect_workspace_change_watch(self, watch: WorkspaceChangeWatch, *, collect: bool) -> WorkspaceChangeCapture:
        watch.stop_event.set()
        if not collect:
            watch.task.cancel()
            await asyncio.gather(watch.task, return_exceptions=True)
            return WorkspaceChangeCapture(changes={}, baseline=watch.baseline)
        try:
            after = await watch.task
            return WorkspaceChangeCapture(
                changes=workspace_snapshot_changes(watch.baseline, after), baseline=watch.baseline, after=after,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Unable to stop Codex workspace change watch", exc_info=True)
        return WorkspaceChangeCapture(changes={}, baseline=watch.baseline)

    async def _complete_workspace_change_watch(self, thread_id: str, turn_id: str | None, watch: WorkspaceChangeWatch) -> None:
        try:
            capture = await self._collect_workspace_change_watch(watch, collect=True)
            changes = await asyncio.to_thread(workspace_change_entries, capture.changes, watch.workspace, capture.baseline, capture.after)
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
        cwd: Path | None = None,
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
            if cwd is not None:
                await self.resume_thread(thread_id, cwd)
            await self._start_workspace_change_watch(thread_id, cwd)
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
            await self._start_with_shared_fallback(executable)
            self._last_error = None
            self._schedule_runtime_history_sync()
            await self._emit({"type": "connection", **self.status()})

    async def _start_with_shared_fallback(self, executable: str) -> None:
        try:
            await self._start_runtime(executable)
        except CodexRuntimeError as error:
            if not self._should_fallback_from_shared_daemon(error):
                self._last_error = str(error)
                raise
            await self._stop_process()
            if "managed standalone codex install not found at" in str(error).casefold():
                # Missing daemon packaging does not imply that the main history
                # is inaccessible. Keep the same home so desktop and web use
                # Codex's own history and sidebar indexes in both directions.
                self._use_shared_daemon = False
                self._runtime_mode = "direct"
                self._fallback_reason = str(error)
                logger.info("Managed daemon unavailable; using stdio with the main Codex home")
            else:
                self._activate_isolated_fallback(error)
            fallback_executable = self._resolve_executable() or executable
            try:
                await self._start_runtime(fallback_executable)
            except CodexRuntimeError as fallback_error:
                self._last_error = str(fallback_error)
                raise

    async def _start_runtime(self, executable: str) -> None:
        self._recent_stderr.clear()
        try:
            self._seed_runtime_database()
            child_environment = self._app_server_environment()
            if self._use_shared_daemon:
                await self._ensure_shared_daemon(executable, child_environment)
            arguments = self._app_server_arguments(executable)
            process_options = {
                "cwd": self.workspace,
                "env": child_environment,
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                "stderr": asyncio.subprocess.PIPE,
                # thread/read returns a whole conversation as one JSONL line.
                # Keep enough room for large Codex histories; asyncio defaults to 64 KiB.
                "limit": 64 * 1024 * 1024,
            }
            if os.name == "nt" and executable.lower().endswith((".cmd", ".bat")):
                process = await asyncio.create_subprocess_shell(
                    subprocess.list2cmdline(arguments),
                    **process_options,
                )
            else:
                process = await asyncio.create_subprocess_exec(*arguments, **process_options)
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
                    "version": "0.2.0-dev.6",
                },
                "capabilities": {
                    "experimentalApi": False,
                    "requestAttestation": False,
                },
            }, timeout=20)
            await self._write({"method": "initialized", "params": {}})
            self._initialized = True
        except Exception as error:
            recent_stderr = "\n".join(self._recent_stderr)
            await self._stop_process()
            if isinstance(error, CodexRuntimeError):
                if recent_stderr:
                    raise CodexRuntimeError(f"{error}：{recent_stderr}") from error
                raise
            raise CodexRuntimeError(f"Codex app-server 初始化失败：{error}") from error

    def _should_fallback_from_shared_daemon(self, error: CodexRuntimeError) -> bool:
        if not self._use_shared_daemon or self._fallback_runtime_home is None:
            return False
        detail = "\n".join((str(error), *self._recent_stderr)).casefold()
        if any(marker in detail for marker in (
            "unrecognized subcommand 'daemon'",
            "managed standalone codex install not found at",
        )):
            return True
        has_private_runtime_path = any(
            marker.casefold() in detail
            for marker in _SHARED_DAEMON_FALLBACK_MARKERS
            if marker != "unrecognized subcommand 'daemon'"
        )
        return has_private_runtime_path and any(marker.casefold() in detail for marker in _WINDOWS_ACCESS_DENIED_MARKERS)

    def _activate_isolated_fallback(self, error: CodexRuntimeError) -> None:
        fallback_home = self._fallback_runtime_home
        if fallback_home is None:
            raise error
        self._runtime_home = fallback_home
        self._use_shared_daemon = False
        self._runtime_mode = "isolated-fallback"
        self._fallback_reason = str(error)
        logger.warning("%s Cause: %s", _SHARED_DAEMON_FALLBACK_MESSAGE, error)

    def _app_server_arguments(self, executable: str) -> list[str]:
        if self._use_shared_daemon:
            return [executable, "app-server", "proxy"]
        return [executable, "app-server", "--listen", "stdio://"]

    async def _ensure_shared_daemon(self, executable: str, child_environment: dict[str, str]) -> None:
        """Start Codex's user-level shared App Server before attaching its stdio proxy."""
        arguments = [executable, "app-server", "daemon", "start"]
        process_options = {
            "cwd": self.workspace,
            "env": child_environment,
            "stdin": asyncio.subprocess.DEVNULL,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "limit": 1024 * 1024,
        }
        try:
            if os.name == "nt" and executable.lower().endswith((".cmd", ".bat")):
                process = await asyncio.create_subprocess_shell(
                    subprocess.list2cmdline(arguments),
                    **process_options,
                )
            else:
                process = await asyncio.create_subprocess_exec(*arguments, **process_options)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
            except TimeoutError as error:
                process.kill()
                await process.wait()
                raise CodexRuntimeError("启动共享 Codex app-server 超时") from error
        except OSError as error:
            raise CodexRuntimeError(f"无法启动共享 Codex app-server：{error}") from error

        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()
            if not detail:
                detail = stdout.decode("utf-8", errors="replace").strip()
            suffix = f"：{detail}" if detail else ""
            raise CodexRuntimeError(f"共享 Codex app-server 启动失败{suffix}")

    async def _prepare_runtime_thread(self, thread_id: str) -> None:
        """Make a local Codex thread visible when a separate runtime home is configured."""
        if self._runtime_home == self._history_home:
            return
        async with self._runtime_history_lock:
            self._runtime_home.mkdir(mode=0o700, parents=True, exist_ok=True)
            runtime_database = self._runtime_home / "thread_history_1.sqlite"
            if not self._database_has_thread(runtime_database, thread_id):
                if self.connected:
                    await self._stop_process()
                self._seed_runtime_database(force=True)
            await self._copy_thread_rollout(thread_id)

    def _seed_runtime_database(self, force: bool = False) -> None:
        source = self._history_home / "thread_history_1.sqlite"
        target = self._runtime_home / "thread_history_1.sqlite"
        # In shared-home mode source and target are the same database. Seeding
        # it would unlink the user's Codex database before trying to copy it.
        if source.resolve() == target.resolve():
            return
        if not source.is_file():
            return
        if not force and target.is_file() and self._database_has_threads(target):
            return
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        for suffix in ("", "-shm", "-wal"):
            target_path = Path(f"{target}{suffix}")
            try:
                target_path.unlink()
            except FileNotFoundError:
                pass
        source_connection: sqlite3.Connection | None = None
        target_connection: sqlite3.Connection | None = None
        try:
            source_connection = sqlite3.connect(
                f"file:{source.as_posix()}?mode=ro", uri=True, timeout=30,
            )
            target_connection = sqlite3.connect(target, timeout=30)
            source_connection.backup(target_connection)
            target_connection.commit()
        except sqlite3.Error as error:
            raise CodexRuntimeError(f"无法准备 Codex 历史数据库：{error}") from error
        finally:
            if target_connection is not None:
                target_connection.close()
            if source_connection is not None:
                source_connection.close()

    @staticmethod
    def _database_has_threads(path: Path) -> bool:
        try:
            with sqlite3.connect(path, timeout=5) as connection:
                return connection.execute("select 1 from thread_history_projection_state limit 1").fetchone() is not None
        except sqlite3.Error:
            return False

    @staticmethod
    def _database_has_thread(path: Path, thread_id: str) -> bool:
        if not path.is_file():
            return False
        try:
            with sqlite3.connect(path, timeout=5) as connection:
                return connection.execute(
                    "select 1 from thread_history_projection_state where thread_id = ? limit 1",
                    (thread_id,),
                ).fetchone() is not None
        except sqlite3.Error:
            return False

    async def _copy_thread_rollout(self, thread_id: str) -> None:
        source = self._find_thread_rollout(self._history_home, thread_id)
        if source is None or not source.is_file():
            return
        try:
            relative = source.relative_to(self._history_home)
        except ValueError:
            return
        target = self._runtime_home / relative
        if target.is_file() and target.stat().st_size == source.stat().st_size:
            return
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
        try:
            shutil.copy2(source, temporary)
            try:
                os.replace(temporary, target)
            except PermissionError:
                # Windows Codex app-server may keep an older rollout open.
                # Close our runtime before replacing that handle's target.
                if self.has_active_turns:
                    raise
                if self.connected:
                    await self._stop_process()
                os.replace(temporary, target)
        except OSError as error:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise CodexRuntimeError(f"无法准备 Codex 对话历史：{error}") from error

    async def _sync_runtime_thread(self, thread_id: str) -> None:
        if self._runtime_home == self._history_home:
            return
        try:
            changed = await asyncio.to_thread(self._sync_runtime_thread_to_history, thread_id)
        except Exception as error:
            logger.warning("Unable to sync Codex Remote thread %s: %s", thread_id, error)
            return
        if changed:
            self._history.invalidate()

    def _schedule_runtime_thread_sync(self, thread_id: str) -> None:
        task = asyncio.create_task(self._sync_runtime_thread(thread_id))
        self._runtime_thread_sync_tasks.add(task)
        task.add_done_callback(self._runtime_thread_sync_tasks.discard)

    def _schedule_runtime_history_sync(self) -> None:
        source_home = (
            self._runtime_home
            if self._runtime_home != self._history_home
            else self._legacy_runtime_home
        )
        if source_home is None or not source_home.is_dir():
            return
        if self._history_sync_task is not None and not self._history_sync_task.done():
            return
        self._history_sync_task = asyncio.create_task(self._sync_runtime_created_history(source_home))

    async def _sync_runtime_created_history(self, source_home: Path) -> None:
        try:
            changed = await asyncio.to_thread(self._sync_runtime_created_history_to_main, source_home)
        except OSError as error:
            logger.warning("Unable to sync existing Codex Remote history: %s", error)
            return
        if changed:
            self._history.invalidate()
            await self._emit({"type": "threads.changed"})

    def _sync_runtime_created_history_to_main(self, source_home: Path) -> bool:
        changed = False
        for directory_name in ("sessions", "archived_sessions"):
            root = source_home / directory_name
            if not root.is_dir():
                continue
            for source in root.rglob("*.jsonl"):
                if not self._is_remote_created_rollout(source):
                    continue
                try:
                    copied = self._sync_runtime_rollout(source, source_home)
                    indexed = self._sync_runtime_thread_index(source, source_home)
                    changed = copied or indexed or changed
                except OSError as error:
                    logger.warning("Unable to sync Codex Remote rollout %s: %s", source, error)
        return changed

    @staticmethod
    def _is_remote_created_rollout(path: Path) -> bool:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                envelope = json.loads(handle.readline())
        except (OSError, json.JSONDecodeError):
            return False
        payload = envelope.get("payload") if isinstance(envelope, dict) else None
        return isinstance(payload, dict) and payload.get("originator") == "codex_remote_web"

    def _sync_runtime_thread_to_history(self, thread_id: str) -> bool:
        source = self._find_thread_rollout(self._runtime_home, thread_id)
        if source is None:
            return False
        copied = self._sync_runtime_rollout(source, self._runtime_home)
        indexed = self._sync_runtime_thread_index(source, self._runtime_home)
        return copied or indexed

    def _sync_runtime_thread_index(self, source: Path, source_home: Path) -> bool:
        """Register a copied web session in the desktop sidebar's state index.

        The index is optional for the web client.  When Windows only grants
        read access to the desktop state database, the rollout stays intact
        and a later launch with write access can fill in the missing row.
        """
        if not self._is_remote_created_rollout(source):
            return False
        try:
            relative = source.resolve().relative_to(source_home)
        except ValueError:
            return False
        if not relative.parts or relative.parts[0] != "sessions":
            return False
        target = self._history_home / relative
        source_db = source_home / "state_5.sqlite"
        target_db = self._history_home / "state_5.sqlite"
        if not source_db.is_file() or not target_db.is_file() or not target.is_file():
            return False
        try:
            if target.stat().st_size != source.stat().st_size or not self._file_is_prefix(target, source):
                return False
            with source.open("r", encoding="utf-8") as handle:
                envelope = json.loads(handle.readline())
            payload = envelope.get("payload", {})
            thread_id = payload.get("id") or payload.get("session_id")
            if not isinstance(thread_id, str):
                return False
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return False

        try:
            with closing(sqlite3.connect(target_db, timeout=5)) as connection:
                with closing(sqlite3.connect(source_db, timeout=5)) as runtime_connection:
                    main_columns = connection.execute("PRAGMA main.table_info(threads)").fetchall()
                    runtime_columns = runtime_connection.execute("PRAGMA table_info(threads)").fetchall()
                    if not main_columns or main_columns != runtime_columns:
                        logger.warning("Skipping Codex Remote index sync: desktop and runtime schemas differ")
                        return False
                    columns = [column[1] for column in main_columns]
                    if "originator" not in columns or "rollout_path" not in columns or "history_mode" not in columns:
                        return False
                    row = runtime_connection.execute(
                        "SELECT * FROM threads WHERE id = ? AND originator = ?",
                        (thread_id, "codex_remote_web"),
                    ).fetchone()
                    if row is None:
                        return False
                    values = list(row)
                    values[columns.index("rollout_path")] = str(target)
                    values[columns.index("history_mode")] = "legacy"
                    for field in ("project_id", "thread_section_id", "section_position", "section_entered_at_ms"):
                        if field in columns:
                            values[columns.index(field)] = None
                    placeholders = ",".join("?" for _ in columns)
                    cursor = connection.execute(
                        f"INSERT INTO main.threads VALUES ({placeholders}) ON CONFLICT(id) DO NOTHING",
                        values,
                    )
                    connection.commit()
                    return cursor.rowcount > 0
        except sqlite3.Error as error:
            logger.warning("Unable to index Codex Remote thread %s in desktop history: %s", thread_id, error)
            return False

    @staticmethod
    def _find_thread_rollout(codex_home: Path, thread_id: str) -> Path | None:
        candidates: list[Path] = []
        for directory_name in ("sessions", "archived_sessions"):
            root = codex_home / directory_name
            if not root.is_dir():
                continue
            candidates.extend(
                path
                for path in root.rglob("*.jsonl")
                if thread_id in path.name
            )
        if not candidates:
            return None
        return max(candidates, key=lambda path: path.stat().st_mtime_ns)

    def _sync_runtime_rollout(self, source: Path, source_home: Path) -> bool:
        try:
            relative = source.resolve().relative_to(source_home)
        except ValueError:
            return False
        if not relative.parts or relative.parts[0] != "sessions":
            return False

        target = self._history_home / relative
        if target.is_file():
            source_size = source.stat().st_size
            target_size = target.stat().st_size
            if source_size == target_size:
                if self._file_is_prefix(target, source):
                    return False
                logger.warning("Not overwriting divergent Codex history: %s", target)
                return False
            if source_size < target_size:
                if not self._file_is_prefix(source, target):
                    logger.warning("Not overwriting divergent Codex history: %s", target)
                return False
            if not self._file_is_prefix(target, source):
                logger.warning("Not overwriting divergent Codex history: %s", target)
                return False

        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = target.parent / f".{target.name}.codex-remote-{uuid.uuid4().hex}.tmp"
        try:
            with source.open("rb") as source_file, temporary.open("xb") as temporary_file:
                shutil.copyfileobj(source_file, temporary_file)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary, target)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        return True

    @staticmethod
    def _file_is_prefix(prefix: Path, full: Path) -> bool:
        if prefix.stat().st_size > full.stat().st_size:
            return False
        with prefix.open("rb") as prefix_file, full.open("rb") as full_file:
            while chunk := prefix_file.read(1024 * 1024):
                if full_file.read(len(chunk)) != chunk:
                    return False
        return True

    def _app_server_environment(self) -> dict[str, str]:
        """Use the main Codex home unless isolation is explicitly configured.

        An explicit CODEX_REMOTE_APP_SERVER_HOME keeps mutable state separate while
        the main home remains the source for configuration and imported history.
        """
        if self._runtime_home == self._history_home:
            child_environment = os.environ.copy()
            child_environment["CODEX_HOME"] = str(self._history_home)
            return child_environment

        self._runtime_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        for filename in ("config.toml", "auth.json", "models-custom.json"):
            source = self._history_home / filename
            target = self._runtime_home / filename
            if source.is_file() and source.resolve() != target.resolve():
                try:
                    shutil.copy2(source, target)
                except OSError as error:
                    raise CodexRuntimeError(f"无法准备 Codex app-server 配置：{error}") from error
        child_environment = os.environ.copy()
        child_environment["CODEX_HOME"] = str(self._runtime_home)
        return child_environment

    def _resolve_executable(self) -> str | None:
        # The shared-daemon protocol is part of the managed Windows CLI.  npm
        # shims and editor-bundled binaries can report a similar version while
        # resolving a different command set at runtime, so use the managed
        # executable whenever it is installed.
        if self._use_shared_daemon or self._runtime_mode == "isolated-fallback":
            managed = self._history_home / "packages" / "app-server-daemon" / "current" / "bin" / "codex.exe"
            if managed.is_file():
                return str(managed)
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
                error = CodexRuntimeError("Codex app-server 已断开")
                self._last_error = str(error)
                self._fail_pending(str(error))
                await self._emit({"type": "connection", **self.status()})

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr is not None
        try:
            while line := await process.stderr.readline():
                detail = line.decode("utf-8", errors="replace").rstrip()
                if detail:
                    self._recent_stderr.append(detail)
                    del self._recent_stderr[:-12]
                    logger.info("Codex: %s", detail)
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
                    # filesystem scans and potentially expensive diffs.
                    task = asyncio.create_task(self._complete_workspace_change_watch(completed_thread_id, completed_turn_id, watch))
                    self._workspace_completion_tasks[task] = watch
                    task.add_done_callback(lambda completed: self._workspace_completion_tasks.pop(completed, None))
                self._schedule_runtime_thread_sync(completed_thread_id)
            elif method == "thread/deleted" and thread_id:
                self._forget_thread_runtime_state(thread_id)
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
        current_task = asyncio.current_task()
        tasks = tuple(task for task in (self._reader_task, self._stderr_task) if task and task is not current_task)
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
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
