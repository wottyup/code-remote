from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
import unicodedata
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from watchfiles import awatch

from .browser_history_sync import BrowserHistorySync
from .browser_payload import browser_event, browser_thread, browser_thread_summary
from .claude_code import (
    ClaudeCodeError,
    ClaudeCodeServer,
    ClaudeThreadBusyError,
    ClaudeThreadNotFoundError,
    is_claude_thread_id,
)
from .codex_app_server import (
    ApprovalPolicy,
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
    CodexThreadBusyError,
    CodexThreadNotFoundError,
)
from .shared_state import QueueConflictError, SharedQueueService, SharedStateStore
from .terminal import TMUX_CLEANUP_INTERVAL_SECONDS, TerminalSession, cleanup_tmux_sessions

logger = logging.getLogger(__name__)

PAIRING_MAX_FAILED_ATTEMPTS = 3
PAIRING_LOCKOUT_SECONDS = 60


def resolve_default_workspace(
    project_root: Path,
    *,
    configured: Path | None = None,
) -> Path:
    """Use the app repository's parent so sibling repositories are accessible."""
    if configured is not None:
        return configured.expanduser().resolve()
    root = project_root.expanduser().resolve()
    return root.parent


async def watch_codex_history(app_server: CodexAppServer) -> None:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()
    sessions = codex_home / "sessions"
    watch_root = codex_home if codex_home.is_dir() else sessions
    if not watch_root.is_dir():
        return

    def is_session_change(_change: object, changed_path: str) -> bool:
        path = Path(changed_path).resolve()
        if path == codex_home or path == sessions:
            return True
        try:
            relative = path.relative_to(codex_home)
        except ValueError:
            return False
        return relative.name in {
            "session_index.jsonl", "state_5.sqlite", "state_5.sqlite-wal",
            "thread_history_1.sqlite", "thread_history_1.sqlite-wal",
        } or relative.suffix == ".jsonl" or not relative.suffix

    try:
        async for changes in awatch(watch_root, watch_filter=is_session_change, debounce=500):
            if changes:
                await app_server.notify_threads_changed()
    except asyncio.CancelledError:
        raise
    except OSError:
        logger.exception("Could not watch Codex session history")


async def watch_claude_history(claude_code: ClaudeCodeServer) -> None:
    """Import Claude Code session changes as soon as local JSONL files change."""
    projects = claude_code._native_home / "projects"
    if not projects.is_dir():
        return

    def is_session_change(_change: object, changed_path: str) -> bool:
        path = Path(changed_path)
        return path.suffix == ".jsonl" and path.parent.parent == projects

    try:
        async for changes in awatch(projects, watch_filter=is_session_change, debounce=150):
            if changes:
                claude_code.schedule_native_refresh()
    except asyncio.CancelledError:
        raise
    except OSError:
        logger.exception("Could not watch Claude Code session history")


class PairRequest(BaseModel):
    code: str = Field(min_length=6, max_length=12)


class PairingStateError(RuntimeError):
    """The local trusted-device state could not be safely updated."""


def normalize_pairing_code(value: str) -> str:
    """Normalize codes copied from terminals and mobile keyboards."""
    normalized = unicodedata.normalize("NFKC", value).upper()
    return "".join(character for character in normalized if not character.isspace() and character not in "-_\u200b\ufeff")


IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
IMAGE_MEDIA_TYPES = {extension: media_type for media_type, extension in IMAGE_EXTENSIONS.items()}
MAX_IMAGES_PER_TURN = 4
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024
MAX_STORED_IMAGE_BYTES = 2 * 1024 * 1024 * 1024
MESSAGE_IMAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60
MESSAGE_IMAGE_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_STAGED_PDF_BYTES = 512 * 1024 * 1024
PDF_ATTACHMENT_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_PDF_ATTACHMENTS_PER_TURN = 8
PDF_ATTACHMENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24,64}$")
ORIGINAL_DOCUMENT_EXTENSIONS = {".pdf", ".xls", ".xlsx", ".xlsm"}
ORIGINAL_DOCUMENT_MEDIA_TYPES = {
    "application/pdf",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/octet-stream",
}


@dataclass
class StoredPdfAttachment:
    attachment_id: str
    name: str
    path: Path
    size: int
    last_accessed_at: float


class PdfAttachmentStore:
    """Keeps original PDF and Excel files in a private, bounded directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.attachments: dict[str, StoredPdfAttachment] = {}

    @staticmethod
    def safe_name(name: str) -> str:
        leaf = name.replace("\\", "/").rsplit("/", 1)[-1]
        normalized = "".join(character for character in leaf if character.isprintable()).strip().strip(".")
        if not normalized or len(normalized) > 255 or Path(normalized).suffix.lower() not in ORIGINAL_DOCUMENT_EXTENSIONS:
            raise ValueError("请附加有效的 PDF 或 Excel 文件。")
        return normalized

    def _prune_expired(self, now: float) -> None:
        expired = [
            attachment_id
            for attachment_id, attachment in self.attachments.items()
            if now - attachment.last_accessed_at >= PDF_ATTACHMENT_TTL_SECONDS
        ]
        for attachment_id in expired:
            attachment = self.attachments.pop(attachment_id)
            with suppress(FileNotFoundError):
                attachment.path.unlink()

    def save(self, name: str, content: bytes) -> StoredPdfAttachment:
        now = time.time()
        self._prune_expired(now)
        safe_name = self.safe_name(name)
        if not content:
            raise ValueError("文件是空的。")
        if len(content) > MAX_PDF_BYTES:
            raise ValueError("单个原始文件不能超过 20 MB。")
        extension = Path(safe_name).suffix.lower()
        if extension == ".pdf" and b"%PDF-" not in content[:1024]:
            raise ValueError("文件内容不是有效的 PDF。")
        if extension in {".xlsx", ".xlsm"} and not content.startswith(b"PK"):
            raise ValueError("文件内容不是有效的 Excel 工作簿。")
        if extension == ".xls" and not content.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
            raise ValueError("文件内容不是有效的 Excel 工作簿。")
        current_size = sum(attachment.size for attachment in self.attachments.values())
        if current_size + len(content) > MAX_STAGED_PDF_BYTES:
            raise OverflowError("临时原始附件空间已满，请稍后重试。")

        attachment_id = secrets.token_urlsafe(24)
        path = self.directory / f"{attachment_id}{extension}"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
        attachment = StoredPdfAttachment(attachment_id, safe_name, path, len(content), now)
        self.attachments[attachment_id] = attachment
        return attachment

    def get(self, attachment_id: str) -> StoredPdfAttachment | None:
        now = time.time()
        self._prune_expired(now)
        if not PDF_ATTACHMENT_ID_PATTERN.fullmatch(attachment_id):
            return None
        attachment = self.attachments.get(attachment_id)
        if attachment is None:
            return None
        try:
            attachment.path.resolve().relative_to(self.directory.resolve())
            if not attachment.path.is_file() or attachment.path.stat().st_size != attachment.size:
                self.attachments.pop(attachment_id, None)
                return None
        except (OSError, ValueError):
            self.attachments.pop(attachment_id, None)
            return None
        attachment.last_accessed_at = now
        return attachment


class ThreadStartRequest(BaseModel):
    engine: Literal["codex", "claude-code"] = "codex"
    model: str | None = Field(default=None, max_length=200)
    approval_policy: ApprovalPolicy | None = None
    cwd: str | None = Field(default=None, max_length=4_096)
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class ThreadWorkspaceRequest(BaseModel):
    cwd: str = Field(min_length=1, max_length=4_096)


class ThreadSettingsUpdateRequest(BaseModel):
    approval_policy: ApprovalPolicy


class ThreadNameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=256)


class TurnImage(BaseModel):
    name: str = Field(default="image", min_length=1, max_length=255)
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data: str = Field(min_length=4)


class TurnRequest(BaseModel):
    prompt: str = Field(default="")
    images: list[TurnImage] = Field(default_factory=list, max_length=MAX_IMAGES_PER_TURN)
    pdf_attachments: list[str] = Field(default_factory=list, max_length=MAX_PDF_ATTACHMENTS_PER_TURN)
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=50)
    approval_policy: ApprovalPolicy | None = None
    claude_model: str | None = Field(default=None, max_length=200)
    claude_effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    claude_permission_mode: Literal["default", "manual", "acceptEdits", "auto", "dontAsk", "plan"] = "default"
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class SteerRequest(BaseModel):
    prompt: str = Field(default="")
    images: list[TurnImage] = Field(default_factory=list, max_length=MAX_IMAGES_PER_TURN)
    pdf_attachments: list[str] = Field(default_factory=list, max_length=MAX_PDF_ATTACHMENTS_PER_TURN)
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class QueuedImage(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    mediaType: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data: str = Field(min_length=4, max_length=12_000_000)


class QueuedDocument(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    content: str
    sourceFileId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{24,64}$")


class QueuedMessageRequest(BaseModel):
    id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    text: str
    requestText: str
    images: list[QueuedImage] = Field(default_factory=list, max_length=MAX_IMAGES_PER_TURN)
    documents: list[QueuedDocument] = Field(default_factory=list, max_length=MAX_PDF_ATTACHMENTS_PER_TURN)
    createdAt: str = Field(min_length=1, max_length=128)
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=50)
    approvalPolicy: ApprovalPolicy | None = None
    claudeModel: str | None = Field(default=None, max_length=200)
    claudeEffort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    claudePermissionMode: Literal["default", "manual", "acceptEdits", "auto", "dontAsk", "plan"] | None = None
    sendAttempt: dict[str, Any] | None = None


class QueueMessageIdRequest(BaseModel):
    message_id: str = Field(min_length=8, max_length=128)
    owner_id: str | None = Field(default=None, min_length=8, max_length=128)


class PinRequest(BaseModel):
    pinned: bool


class PinsInitializeRequest(BaseModel):
    thread_ids: list[str] = Field(default_factory=list, max_length=200)


async def read_limited_pdf_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_PDF_BYTES:
            raise OverflowError("单个 PDF 不能超过 20 MB。")
        chunks.append(chunk)
    return b"".join(chunks)


class ResumeRequest(BaseModel):
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    include_history: bool = True


class InterruptRequest(BaseModel):
    turn_id: str | None = Field(default=None, max_length=200)


class IdempotencyConflictError(RuntimeError):
    """A request ID was reused with a different payload."""


@dataclass
class IdempotentRequestEntry:
    fingerprint: str
    created_at: float
    task: asyncio.Task[dict[str, Any]]


class IdempotentRequestRegistry:
    """Share and briefly cache mutation results so mobile retries stay safe."""

    def __init__(self, ttl_seconds: float = 600, max_entries: int = 1_024) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._entries: dict[tuple[str, str, str], IdempotentRequestEntry] = {}
        self._lock = asyncio.Lock()

    def _prune_completed(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._entries.items()
            if entry.task.done() and now - entry.created_at >= self.ttl_seconds
        ]
        for key in expired:
            self._entries.pop(key, None)
        if len(self._entries) < self.max_entries:
            return
        completed = sorted(
            (
                (entry.created_at, key)
                for key, entry in self._entries.items()
                if entry.task.done()
            ),
        )
        for _, key in completed:
            if len(self._entries) < self.max_entries:
                break
            self._entries.pop(key, None)

    async def _remove_failed(
        self,
        key: tuple[str, str, str],
        task: asyncio.Task[dict[str, Any]],
    ) -> None:
        async with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry.task is task:
                self._entries.pop(key, None)

    def _discard_failed_when_done(
        self,
        key: tuple[str, str, str],
        task: asyncio.Task[dict[str, Any]],
    ) -> None:
        if not task.cancelled() and task.exception() is None:
            return
        entry = self._entries.get(key)
        if entry is not None and entry.task is task:
            self._entries.pop(key, None)

    async def run(
        self,
        operation: str,
        resource_id: str,
        request_id: str,
        fingerprint: str,
        callback: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        key = (operation, resource_id, request_id)
        async with self._lock:
            self._prune_completed(time.monotonic())
            entry = self._entries.get(key)
            if entry is not None:
                if not hmac.compare_digest(entry.fingerprint, fingerprint):
                    raise IdempotencyConflictError("请求编号已被另一条消息使用，请重新发送。")
                task = entry.task
            else:
                task = asyncio.create_task(callback())
                task.add_done_callback(
                    lambda completed, request_key=key: self._discard_failed_when_done(request_key, completed),
                )
                self._entries[key] = IdempotentRequestEntry(
                    fingerprint=fingerprint,
                    created_at=time.monotonic(),
                    task=task,
                )
        # Keep the mutation alive if the phone disconnects before the HTTP
        # response reaches it. A retry with the same ID will await this task.
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # The shared task keeps running. A retry can still join it and
            # receive the successful result after this requester disappears.
            raise
        except Exception:
            # Cache only successful mutations. A rejected operation must be
            # allowed to run again after its underlying state is repaired.
            await self._remove_failed(key, task)
            raise


def request_fingerprint(body: BaseModel) -> str:
    if hasattr(body, "model_dump"):
        payload = body.model_dump(mode="json", exclude={"request_id"})
    else:  # Pydantic 1 compatibility for older local environments.
        payload = body.dict(exclude={"request_id"})
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


WORKSPACE_TREE_MAX_ENTRIES = 400
WORKSPACE_TREE_MAX_PATH_LENGTH = 1_024
WORKSPACE_FILE_PREVIEW_MAX_BYTES = 1 * 1_024 * 1_024
WORKSPACE_FILE_PREVIEW_MAX_LINES = 20_000


class WorkspaceFileSaveRequest(BaseModel):
    cwd: str | None = Field(default=None, max_length=4_096)
    path: str = Field(min_length=1, max_length=WORKSPACE_TREE_MAX_PATH_LENGTH)
    content: str = Field(max_length=WORKSPACE_FILE_PREVIEW_MAX_BYTES)
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class WorkspaceEntryCreateRequest(BaseModel):
    cwd: str | None = Field(default=None, max_length=4_096)
    path: str = Field(min_length=1, max_length=WORKSPACE_TREE_MAX_PATH_LENGTH)
    kind: Literal["file", "directory"]


class WorkspaceEntryRenameRequest(BaseModel):
    cwd: str | None = Field(default=None, max_length=4_096)
    path: str = Field(min_length=1, max_length=WORKSPACE_TREE_MAX_PATH_LENGTH)
    name: str = Field(min_length=1, max_length=255)


class WorkspaceEntriesDeleteRequest(BaseModel):
    cwd: str | None = Field(default=None, max_length=4_096)
    paths: list[str] = Field(min_length=1, max_length=100)


class WorkspaceEntriesPasteRequest(BaseModel):
    cwd: str | None = Field(default=None, max_length=4_096)
    paths: list[str] = Field(min_length=1, max_length=100)
    destination: str = Field(default="", max_length=WORKSPACE_TREE_MAX_PATH_LENGTH)
    mode: Literal["copy", "move"]


def workspace_base_for_cwd(workspace: Path, raw_cwd: str | None) -> Path:
    """Resolve a browser-selected or thread working directory on the server host."""
    try:
        configured = workspace.expanduser().resolve()
        candidate = Path(raw_cwd).expanduser() if raw_cwd else configured
        if not candidate.is_absolute():
            candidate = configured / candidate
        candidate = candidate.resolve()
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="目录路径无效") from error
    if not candidate.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="工作目录不存在")
    return candidate


def workspace_path(base: Path, relative_path: str) -> Path:
    if len(relative_path) > WORKSPACE_TREE_MAX_PATH_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="路径过长")
    if "\x00" in relative_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="路径无效")
    candidate = (base / relative_path).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能访问工作目录以外的路径") from error
    return candidate


def workspace_entry_name(name: str) -> str:
    if name != name.strip() or name in {"", ".", ".."}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="名称不能为空，且首尾不能包含空格")
    if any(character in '<>:"/\\|?*' or ord(character) < 32 for character in name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="名称包含系统不支持的字符")
    if name.endswith((" ", ".")) or len(name.encode("utf-8")) > 255:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="名称过长或结尾无效")
    reserved = name.split(".", 1)[0].casefold()
    if reserved in {"con", "prn", "aux", "nul", *(f"com{index}" for index in range(1, 10)), *(f"lpt{index}" for index in range(1, 10))}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="该名称被系统保留")
    return name


def workspace_mutation_path(base: Path, relative_path: str, *, allow_root: bool = False, require_exists: bool = True) -> Path:
    if not relative_path:
        if allow_root:
            return base
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能操作工作区根目录")
    if len(relative_path) > WORKSPACE_TREE_MAX_PATH_LENGTH or "\x00" in relative_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="路径无效或过长")
    if relative_path.startswith(("/", "\\")) or (len(relative_path) > 1 and relative_path[1] == ":"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请使用工作目录内的相对路径")
    parts = relative_path.replace("\\", "/").split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="路径无效")
    candidate = base.joinpath(*parts)
    try:
        candidate.parent.resolve().relative_to(base)
        candidate.resolve(strict=False).relative_to(base)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能操作工作目录以外的路径") from error
    if candidate.is_symlink():
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="暂不支持修改符号链接")
    if require_exists and not candidate.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件或文件夹不存在")
    return candidate


def workspace_entry_payload(base: Path, candidate: Path) -> dict[str, Any]:
    kind = workspace_entry_kind(candidate)
    if kind is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件或文件夹不存在")
    try:
        relative_path = candidate.relative_to(base).as_posix()
        size = candidate.stat().st_size if kind == "file" else None
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法读取文件信息") from error
    return {"name": candidate.name, "path": relative_path, "kind": kind, "size": size}


def workspace_source_paths(base: Path, paths: list[str]) -> list[Path]:
    unique: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        candidate = workspace_mutation_path(base, path)
        key = os.path.normcase(str(candidate))
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    unique.sort(key=lambda item: len(item.parts))
    selected: list[Path] = []
    for candidate in unique:
        if any(candidate.is_relative_to(parent) for parent in selected):
            continue
        selected.append(candidate)
    return selected


def workspace_create_entry(base: Path, relative_path: str, kind: Literal["file", "directory"]) -> dict[str, Any]:
    parts = relative_path.replace("\\", "/").split("/")
    if parts:
        workspace_entry_name(parts[-1])
    candidate = workspace_mutation_path(base, relative_path, require_exists=False)
    if candidate.exists() or candidate.is_symlink():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同名文件或文件夹已存在")
    if not candidate.parent.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="上级文件夹不存在")
    try:
        if kind == "directory":
            candidate.mkdir()
        else:
            candidate.open("xb").close()
    except FileExistsError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同名文件或文件夹已存在") from error
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法创建，请检查工作区写入权限") from error
    return workspace_entry_payload(base, candidate)


def workspace_rename_entry(base: Path, relative_path: str, name: str) -> dict[str, Any]:
    source = workspace_mutation_path(base, relative_path)
    target = source.with_name(workspace_entry_name(name))
    if source == target:
        return {"oldPath": source.relative_to(base).as_posix(), "entry": workspace_entry_payload(base, source)}
    try:
        target.resolve(strict=False).relative_to(base)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能移动到工作目录以外") from error
    if target.exists() or target.is_symlink():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同名文件或文件夹已存在")
    try:
        source.rename(target)
    except FileExistsError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同名文件或文件夹已存在") from error
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法重命名，请检查工作区写入权限") from error
    return {"oldPath": relative_path.replace("\\", "/"), "entry": workspace_entry_payload(base, target)}


def workspace_delete_entries(base: Path, paths: list[str]) -> dict[str, Any]:
    sources = workspace_source_paths(base, paths)
    deleted = [source.relative_to(base).as_posix() for source in sources]
    for source in sorted(sources, key=lambda item: len(item.parts), reverse=True):
        try:
            if source.is_dir():
                shutil.rmtree(source)
            else:
                source.unlink()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"无法删除 {source.name}，请检查工作区写入权限") from error
    return {"deleted": deleted}


def workspace_copy_entry(source: Path, target: Path) -> None:
    if source.is_dir():
        try:
            shutil.copytree(source, target, symlinks=True)
        except FileExistsError:
            raise
        except OSError:
            with suppress(OSError):
                if target.is_dir() and not target.is_symlink():
                    shutil.rmtree(target)
                elif target.exists() or target.is_symlink():
                    target.unlink()
            raise
        return

    created = False
    try:
        with source.open("rb") as source_file, target.open("xb") as target_file:
            created = True
            shutil.copyfileobj(source_file, target_file)
        shutil.copystat(source, target)
    except OSError:
        if created:
            with suppress(OSError):
                target.unlink()
        raise


def workspace_paste_entries(
    base: Path,
    paths: list[str],
    destination_path: str,
    mode: Literal["copy", "move"],
) -> dict[str, Any]:
    destination = workspace_mutation_path(base, destination_path, allow_root=True)
    if not destination.is_dir():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="粘贴目标不是文件夹")
    sources = workspace_source_paths(base, paths)
    plans: list[tuple[Path, Path]] = []
    unchanged: list[Path] = []
    destination_resolved = destination.resolve()
    for source in sources:
        source_resolved = source.resolve()
        if source.is_dir() and (destination_resolved == source_resolved or destination_resolved.is_relative_to(source_resolved)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"不能把 {source.name} 粘贴到自身内部")
        target = destination / source.name
        if os.path.normcase(str(target)) == os.path.normcase(str(source)):
            if mode == "move":
                unchanged.append(source)
                continue
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"目标中已存在 {source.name}")
        if target.exists() or target.is_symlink():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"目标中已存在 {source.name}")
        plans.append((source, target))

    completed: list[tuple[Path, Path]] = []
    failure_cause: OSError | None = None
    try:
        for source, target in plans:
            if mode == "copy":
                workspace_copy_entry(source, target)
            else:
                shutil.move(str(source), str(target))
            completed.append((source, target))
    except FileExistsError as error:
        failure_cause = error
        detail = "粘贴时发现同名文件或文件夹，未覆盖原内容"
        failure = HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    except OSError as error:
        failure_cause = error
        failure = HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="粘贴失败，请检查工作区写入权限")
    else:
        entries = [workspace_entry_payload(base, target) for _, target in completed]
        entries.extend(workspace_entry_payload(base, source) for source in unchanged)
        changed_paths = [source.relative_to(base).as_posix() for source, _ in completed]
        return {"mode": mode, "entries": entries, "changedPaths": changed_paths}

    for source, target in reversed(completed):
        with suppress(OSError):
            if mode == "move":
                if not source.exists() and target.exists():
                    shutil.move(str(target), str(source))
            elif target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
    raise failure from failure_cause


def workspace_entry_kind(path: Path) -> str | None:
    try:
        if path.is_dir():
            return "directory"
        if path.is_file():
            return "file"
    except OSError:
        return None
    return None


def workspace_directory_tree(base: Path, relative_path: str = "", offset: int = 0) -> dict[str, Any]:
    directory = workspace_path(base, relative_path)
    if not directory.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="目录不存在")
    if offset < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="目录位置无效")
    entries: list[dict[str, Any]] = []
    try:
        children = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法读取目录") from error
    page_end = min(offset + WORKSPACE_TREE_MAX_ENTRIES, len(children))
    for child in children[offset:page_end]:
        try:
            child_path = workspace_path(base, str(child.relative_to(base)))
            kind = workspace_entry_kind(child_path)
            if kind is None:
                continue
            stat = child_path.stat()
        except (OSError, ValueError, HTTPException):
            continue
        entries.append({
            "name": child.name,
            "path": child_path.relative_to(base).as_posix(),
            "kind": kind,
            "size": stat.st_size if kind == "file" else None,
        })
    next_offset = page_end if page_end < len(children) else None
    return {
        "cwd": str(base),
        "path": directory.relative_to(base).as_posix() if directory != base else "",
        "entries": entries,
        "truncated": next_offset is not None,
        "nextOffset": next_offset,
    }


def workspace_text_line_count(content: str) -> int:
    line_count = content.count("\n") + content.count("\r") - content.count("\r\n")
    if content and not content.endswith(("\n", "\r")):
        line_count += 1
    return line_count


def workspace_file_preview(base: Path, relative_path: str) -> dict[str, str | int | bool]:
    if not relative_path or len(relative_path) > WORKSPACE_TREE_MAX_PATH_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="文件路径无效或过长")
    normalized_parts = relative_path.replace("\\", "/").split("/")
    if relative_path.startswith(("/", "\\")) or (len(relative_path) > 1 and relative_path[1] == ":"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请使用工作目录内的相对路径")
    if any(part in {"", ".", ".."} for part in normalized_parts):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="文件路径无效")
    candidate = workspace_path(base, relative_path)
    try:
        resolved_relative = candidate.relative_to(base)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能访问工作目录以外的文件") from error
    try:
        if not candidate.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件不存在")
        size = candidate.stat().st_size
        if size > WORKSPACE_FILE_PREVIEW_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 1 MB，暂不支持预览")
        with candidate.open("rb") as file:
            content_bytes = file.read(WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1)
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法读取该文件") from error
    if len(content_bytes) > WORKSPACE_FILE_PREVIEW_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 1 MB，暂不支持预览")
    if b"\x00" in content_bytes:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="二进制文件不支持预览")
    try:
        content = content_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="仅支持 UTF-8 文本文件预览") from error
    if workspace_text_line_count(content) > WORKSPACE_FILE_PREVIEW_MAX_LINES:
        raise HTTPException(status_code=413, detail="文件行数过多，暂不支持预览")
    return {
        "path": resolved_relative.as_posix(),
        "content": content,
        "size": len(content_bytes),
        "revision": hashlib.sha256(content_bytes).hexdigest(),
        "hasBom": content_bytes.startswith(b"\xef\xbb\xbf"),
    }


def workspace_image_preview(base: Path, relative_path: str, managed_image_root: Path | None = None) -> dict[str, str | int]:
    if not relative_path or len(relative_path) > WORKSPACE_TREE_MAX_PATH_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片路径无效或过长")
    is_absolute = relative_path.startswith(("/", "\\")) or (len(relative_path) > 1 and relative_path[1] == ":")
    if is_absolute:
        try:
            candidate = Path(relative_path).expanduser().resolve()
            allowed_root = managed_image_root.resolve() if managed_image_root is not None else None
            in_managed_image_root = allowed_root is not None and candidate.is_relative_to(allowed_root)
            in_codex_clipboard = (
                candidate.parent == Path(tempfile.gettempdir()).resolve()
                and candidate.stem.startswith("codex-clipboard-")
                and candidate.suffix.lower() in IMAGE_MEDIA_TYPES
            )
            if not in_managed_image_root and not in_codex_clipboard:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请使用工作目录内的相对路径")
        except HTTPException:
            raise
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能访问工作目录以外的图片") from error
    else:
        normalized_parts = relative_path.replace("\\", "/").split("/")
        if any(part in {"", ".", ".."} for part in normalized_parts):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片路径无效")
        candidate = workspace_path(base, relative_path)
    return _image_preview_payload(base, candidate, managed_image_root)


IMAGE_VIEW_PATH_KEYS = {
    "path", "filepath", "file_path", "filename", "target_path", "source_path",
    "imagepath", "image_path", "imagefile", "image_file",
}


def codex_image_view_paths(thread: dict[str, Any]) -> set[str]:
    turns = thread.get("turns")
    if not isinstance(turns, list):
        return set()
    paths: set[str] = set()
    for turn in turns:
        items = turn.get("items") if isinstance(turn, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type", "")).replace("-", "").replace("_", "").lower()
            if item_type != "imageview":
                continue
            stack: list[tuple[dict[str, Any], int]] = [(item, 0)]
            while stack:
                value, depth = stack.pop()
                if depth > 4:
                    continue
                for key, entry in value.items():
                    if key.lower() in IMAGE_VIEW_PATH_KEYS and isinstance(entry, str) and entry.strip():
                        paths.add(entry.strip())
                    elif isinstance(entry, dict):
                        stack.append((entry, depth + 1))
                    elif isinstance(entry, list):
                        stack.extend((child, depth + 1) for child in entry if isinstance(child, dict))
    return paths


def codex_viewed_image_preview(
    base: Path,
    path: str,
    thread: dict[str, Any],
    managed_image_root: Path | None = None,
) -> dict[str, str | int]:
    if not path or len(path) > WORKSPACE_TREE_MAX_PATH_LENGTH:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片路径无效或过长")
    if path.strip() not in codex_image_view_paths(thread):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="这张图片不在此 Codex 会话的查看记录中")
    try:
        is_absolute = path.startswith(("/", "\\")) or (len(path) > 1 and path[1] == ":")
        candidate = Path(path).expanduser().resolve() if is_absolute else (base / path).resolve()
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片路径无效") from error
    return _image_preview_payload(base, candidate, managed_image_root)


def _image_preview_payload(base: Path, candidate: Path, managed_image_root: Path | None) -> dict[str, str | int]:
    media_type = IMAGE_MEDIA_TYPES.get(candidate.suffix.lower())
    if media_type is None:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="仅支持 PNG、JPEG、WebP 和 GIF 图片")
    if managed_image_root is not None and is_expired_managed_message_image(candidate, managed_image_root):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="图片已过期")
    try:
        if not candidate.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="图片不存在")
        size = candidate.stat().st_size
        if size > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="图片超过 8 MB，暂不支持预览")
        with candidate.open("rb") as file:
            content = file.read(MAX_IMAGE_BYTES + 1)
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法读取该图片") from error
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 8 MB，暂不支持预览")
    signatures = {
        "image/png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": content.startswith(b"\xff\xd8\xff"),
        "image/webp": len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP",
        "image/gif": content.startswith((b"GIF87a", b"GIF89a")),
    }
    if not signatures.get(media_type, False):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="文件内容不是有效的受支持图片")
    return {
        "path": candidate.relative_to(base).as_posix() if candidate.is_relative_to(base) else candidate.name,
        "mediaType": media_type,
        "data": base64.b64encode(content).decode("ascii"),
        "size": len(content),
    }


def workspace_file_save(base: Path, relative_path: str, content: str, expected_revision: str) -> dict[str, str | int | bool]:
    current = workspace_file_preview(base, relative_path)
    current_revision = current["revision"]
    if not isinstance(current_revision, str) or not hmac.compare_digest(current_revision, expected_revision):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="文件已被其他操作修改，请重新读取后再保存")

    normalized_content = content.replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in normalized_content:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="文本内容不能包含二进制空字符")
    if workspace_text_line_count(normalized_content) > WORKSPACE_FILE_PREVIEW_MAX_LINES:
        raise HTTPException(status_code=413, detail="文件行数过多，最多支持 20,000 行")

    current_content = current["content"]
    line_ending = "\r\n" if isinstance(current_content, str) and "\r\n" in current_content else "\n"
    content_for_disk = normalized_content.replace("\n", line_ending) if line_ending != "\n" else normalized_content
    try:
        content_bytes = content_for_disk.encode("utf-8")
    except UnicodeEncodeError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="文件内容不是有效的 UTF-8 文本") from error
    if current.get("hasBom"):
        content_bytes = b"\xef\xbb\xbf" + content_bytes
    if len(content_bytes) > WORKSPACE_FILE_PREVIEW_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 1 MiB，暂不支持保存")

    candidate = workspace_path(base, relative_path)
    temporary_path: Path | None = None
    try:
        original_mode = stat.S_IMODE(candidate.stat().st_mode)
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".codex-remote-",
            suffix=".tmp",
            dir=candidate.parent,
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(content_bytes)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.chmod(temporary_path, original_mode)
        os.replace(temporary_path, candidate)
        temporary_path = None
    except OSError as error:
        if temporary_path is not None:
            with suppress(OSError):
                temporary_path.unlink()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无法保存该文件，请检查工作区写入权限") from error

    return workspace_file_preview(base, relative_path)


def prepare_message_image_directory(state_directory: Path) -> Path:
    image_directory = state_directory / "message-images"
    try:
        if image_directory.is_symlink():
            raise OSError("聊天图片目录不能是符号链接")
        image_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(image_directory, 0o700)
    except OSError as error:
        raise RuntimeError(f"无法准备聊天图片目录：{image_directory}：{error}") from error
    return image_directory.resolve()


def cleanup_expired_message_images(image_directory: Path, *, now: float | None = None) -> int:
    """Delete managed chat images whose creation time is more than 90 days old."""
    cutoff = (time.time() if now is None else now) - MESSAGE_IMAGE_RETENTION_SECONDS
    deleted = 0
    try:
        with os.scandir(image_directory) as entries:
            for entry in entries:
                if Path(entry.name).suffix.lower() not in IMAGE_MEDIA_TYPES:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mtime >= cutoff:
                        continue
                    (image_directory / entry.name).unlink()
                    deleted += 1
                except FileNotFoundError:
                    continue
                except OSError:
                    logger.warning("Could not remove expired chat image %s", entry.name, exc_info=True)
    except OSError as error:
        raise HTTPException(
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
            detail="无法清理过期聊天图片。",
        ) from error
    return deleted


def is_expired_managed_message_image(
    image_path: Path,
    image_directory: Path,
    *,
    now: float | None = None,
) -> bool:
    """Avoid serving expired images even before the periodic cleanup runs."""
    try:
        image_root = image_directory.resolve()
        resolved_path = image_path.resolve()
        if not resolved_path.is_relative_to(image_root):
            return False
        if resolved_path.suffix.lower() not in IMAGE_MEDIA_TYPES:
            return False
        cutoff = (time.time() if now is None else now) - MESSAGE_IMAGE_RETENTION_SECONDS
        return resolved_path.stat().st_mtime < cutoff
    except (OSError, RuntimeError, ValueError):
        return True


def stored_image_directory_size(image_directory: Path) -> int:
    total = 0
    try:
        with os.scandir(image_directory) as entries:
            for entry in entries:
                if Path(entry.name).suffix.lower() not in IMAGE_MEDIA_TYPES:
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                total += entry.stat(follow_symlinks=False).st_size
    except OSError as error:
        raise HTTPException(
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
            detail="无法检查聊天图片存储空间。",
        ) from error
    return total


def save_turn_images(
    images: list[TurnImage],
    image_directory: Path,
    *,
    max_storage_bytes: int | None = None,
    storage_lock: threading.Lock | None = None,
) -> list[Path]:
    paths: list[Path] = []
    total_size = 0
    try:
        decoded_images: list[tuple[TurnImage, bytes]] = []
        for image in images:
            try:
                encoded = image.data.encode("ascii")
                content = base64.b64decode(encoded, validate=True)
            except (UnicodeEncodeError, binascii.Error, ValueError) as error:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="图片数据格式无效") from error
            if not content or len(content) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="单张图片不能超过 8 MB")
            total_size += len(content)
            if total_size > MAX_TOTAL_IMAGE_BYTES:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="单条消息的图片总大小不能超过 24 MB")
            decoded_images.append((image, content))

        def write_images() -> None:
            for image, content in decoded_images:
                path = image_directory / f"{secrets.token_hex(16)}{IMAGE_EXTENSIONS[image.media_type]}"
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    with os.fdopen(descriptor, "wb") as output:
                        output.write(content)
                except Exception:
                    with suppress(FileNotFoundError):
                        path.unlink()
                    raise
                paths.append(path)

        if storage_lock is None:
            if decoded_images:
                cleanup_expired_message_images(image_directory)
            if decoded_images and max_storage_bytes is not None and stored_image_directory_size(image_directory) + total_size > max_storage_bytes:
                raise HTTPException(
                    status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
                    detail="聊天图片存储空间已满，请先清理服务器数据后再上传。",
                )
            write_images()
        else:
            with storage_lock:
                if decoded_images:
                    cleanup_expired_message_images(image_directory)
                if decoded_images and max_storage_bytes is not None and stored_image_directory_size(image_directory) + total_size > max_storage_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
                        detail="聊天图片存储空间已满，请先清理服务器数据后再上传。",
                    )
                write_images()
        return paths
    except Exception:
        for path in paths:
            with suppress(FileNotFoundError):
                path.unlink()
        raise


def prompt_with_original_pdfs(
    prompt: str,
    attachment_ids: list[str],
    store: PdfAttachmentStore,
    *,
    path_overrides: dict[str, Path] | None = None,
) -> str:
    blocks: list[str] = []
    seen: set[str] = set()
    for attachment_id in attachment_ids:
        if attachment_id in seen:
            continue
        seen.add(attachment_id)
        attachment = store.get(attachment_id)
        if attachment is None:
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="PDF 临时附件已失效，请重新添加 PDF 后发送。",
            )
        encoded_name = quote(attachment.name, safe="")
        path = str((path_overrides or {}).get(attachment_id, attachment.path).resolve())
        kind = "PDF" if attachment.path.suffix.lower() == ".pdf" else "Excel 工作簿"
        blocks.append(
            f"[[CODEX_REMOTE_FILE_BEGIN id={attachment.attachment_id} name={encoded_name}]]\n"
            f'用户附加的原始{kind}文件名："{attachment.name}"\n'
            f"网页上传后生成的临时读取副本路径：`{path}`\n"
            "这个临时路径只用于读取附件，不是用户文件的原始目录，也不能作为输出目录或‘放回原路径’的目标。"
            "需要保存结果时，先检查当前消息以及本会话此前的用户消息，使用用户最近一次明确给出的绝对目录。"
            "例如用户此前或当前写了 `D:\\111codex`，即使本条消息只说‘放回原路径’，也应保存到 `D:\\111codex`。"
            "只有整段会话都没有明确目录时，才询问保存目录；禁止写入上述临时附件目录。"
            f"请使用本机可用工具直接读取这个{kind}原件，并根据实际读取到的内容回答；不要使用或假设网页端已经提取了完整内容。"
            "如果无法访问或解析这个文件，请明确说明，不要猜测内容。\n"
            f"[[CODEX_REMOTE_FILE_END id={attachment.attachment_id}]]"
        )
    if not blocks:
        return prompt
    combined = "\n\n".join(([prompt.strip()] if prompt.strip() else []) + blocks)
    return combined


def prepare_claude_turn_files(
    prompt: str,
    images: list[TurnImage],
    attachment_ids: list[str],
    store: PdfAttachmentStore,
    temporary_root: Path,
) -> tuple[Path | None, str, list[Path], list[Path]]:
    """Stage this turn's attachments in a private directory visible only to its CLI process."""
    if not images and not attachment_ids:
        return None, prompt, [], []

    turn_directory = Path(tempfile.mkdtemp(prefix="claude-turn-", dir=temporary_root))
    try:
        image_paths = save_turn_images(images, turn_directory)
        attachment_paths: list[Path] = []
        path_overrides: dict[str, Path] = {}
        seen: set[str] = set()
        for attachment_id in attachment_ids:
            if attachment_id in seen:
                continue
            seen.add(attachment_id)
            attachment = store.get(attachment_id)
            if attachment is None:
                raise HTTPException(
                    status_code=status.HTTP_410_GONE,
                    detail="PDF 临时附件已失效，请重新添加 PDF 后发送。",
                )
            staged_path = turn_directory / f"attachment-{attachment_id}{attachment.path.suffix.lower()}"
            shutil.copyfile(attachment.path, staged_path)
            os.chmod(staged_path, 0o600)
            attachment_paths.append(staged_path)
            path_overrides[attachment_id] = staged_path
        staged_prompt = prompt_with_original_pdfs(
            prompt,
            attachment_ids,
            store,
            path_overrides=path_overrides,
        )
        return turn_directory, staged_prompt, image_paths, attachment_paths
    except Exception:
        shutil.rmtree(turn_directory, ignore_errors=True)
        raise


def enrich_thread_images(thread: dict[str, Any], image_directory: Path) -> dict[str, Any]:
    """Embed managed chat images so a refreshed thread can render them."""
    image_root = image_directory.resolve()
    system_temp_root = Path(tempfile.gettempdir()).resolve()
    turns = thread.get("turns")
    if not isinstance(turns, list):
        return thread
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        items = turn.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or item.get("type") != "userMessage":
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict) or part.get("type") not in {"localImage", "local_image"}:
                    continue
                raw_path = part.get("path")
                if not isinstance(raw_path, str) or not raw_path:
                    continue
                try:
                    image_path = Path(raw_path).expanduser().resolve()
                    in_remote_image_directory = image_path.is_relative_to(image_root)
                    is_codex_clipboard_image = (
                        image_path.parent == system_temp_root
                        and image_path.stem.startswith("codex-clipboard-")
                        and image_path.suffix.lower() in IMAGE_MEDIA_TYPES
                    )
                    if not in_remote_image_directory and not is_codex_clipboard_image:
                        continue
                    if in_remote_image_directory and is_expired_managed_message_image(image_path, image_root):
                        continue
                    if not image_path.is_file():
                        continue
                    if image_path.stat().st_size > MAX_IMAGE_BYTES:
                        continue
                    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
                except (OSError, ValueError):
                    continue
                media_type = part.get("mediaType")
                if not isinstance(media_type, str) or media_type not in IMAGE_EXTENSIONS:
                    media_type = IMAGE_MEDIA_TYPES.get(image_path.suffix.lower())
                if media_type is None:
                    continue
                part["name"] = part.get("name") if isinstance(part.get("name"), str) else image_path.name
                part["mediaType"] = media_type
                part["data"] = data
    return thread


def enrich_user_message_item(item: dict[str, Any], image_directory: Path) -> dict[str, Any]:
    """Embed permitted local images in one live app-server user item."""
    item_type = item.get("type")
    if not isinstance(item_type, str) or item_type.replace("-", "").replace("_", "").lower() != "usermessage":
        return item
    wrapper = {"turns": [{"items": [{**item, "type": "userMessage"}]}]}
    enrich_thread_images(wrapper, image_directory)
    return wrapper["turns"][0]["items"][0]


def tail_thread_history(response: dict[str, Any], limit: int | None) -> dict[str, Any]:
    """Return a bounded first screen while retaining a full-history sync revision."""
    if limit is None:
        return response
    turns = response.get("turns")
    if not isinstance(turns, list):
        return response
    bounded_limit = max(1, min(limit, 100))
    if len(turns) <= bounded_limit:
        return response
    visible_turns = turns[-bounded_limit:]
    visible_ids = {turn.get("id") for turn in visible_turns if isinstance(turn, dict) and isinstance(turn.get("id"), str)}
    result = {**response, "turns": visible_turns, "historyPartial": True, "totalTurns": len(turns)}
    workspace_changes = response.get("codexRemoteWorkspaceChanges")
    if isinstance(workspace_changes, dict):
        result["codexRemoteWorkspaceChanges"] = {
            turn_id: changes for turn_id, changes in workspace_changes.items() if turn_id in visible_ids
        }
    return result


class PairingAuth:
    def __init__(self, state_path: Path | None = None) -> None:
        self.code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        configured_path = os.environ.get("CODEX_REMOTE_AUTH_FILE")
        self.state_path = state_path or self._default_state_path()
        state_exists = self.state_path.is_file()
        self.token_hashes = self._load_token_hashes(self.state_path)
        if state_path is None and not configured_path and not state_exists:
            for legacy_path in self._legacy_state_paths():
                if legacy_path.resolve() != self.state_path.resolve():
                    self.token_hashes.update(self._load_token_hashes(legacy_path))
        self.failed_attempts = 0
        self.blocked_until = 0.0

    @staticmethod
    def _default_state_path() -> Path:
        configured_path = os.environ.get("CODEX_REMOTE_AUTH_FILE")
        if configured_path:
            return Path(configured_path).expanduser()
        if os.name == "nt":
            configured_home = os.environ.get("CODEX_REMOTE_HOME")
            if configured_home:
                remote_home = Path(configured_home).expanduser()
            else:
                local_app_data = os.environ.get("LOCALAPPDATA")
                remote_home = (
                    Path(local_app_data) / "CodexRemote"
                    if local_app_data
                    else Path.home() / ".codex-remote"
                )
            return remote_home / "trusted-devices.json"
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return codex_home / "codex-remote" / "trusted-devices.json"

    @staticmethod
    def _legacy_state_paths() -> tuple[Path, ...]:
        if os.name != "nt":
            return ()
        project_root = Path(__file__).resolve().parents[2]
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return (
            project_root / ".codex-remote" / "trusted-devices-v2.json",
            project_root / ".codex-remote" / "trusted-devices.json",
            codex_home / "codex-remote" / "trusted-devices.json",
        )

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _load_token_hashes(state_path: Path) -> set[str]:
        try:
            raw_state = state_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return set()
        except OSError as error:
            logger.warning("Could not read Codex Remote trusted-device state: %s", error)
            return set()

        try:
            parsed_state = json.loads(raw_state)
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed Codex Remote trusted-device state")
            return set()
        if not isinstance(parsed_state, dict) or parsed_state.get("version") != 1:
            logger.warning("Ignoring unsupported Codex Remote trusted-device state")
            return set()
        token_hashes = parsed_state.get("token_hashes")
        if not isinstance(token_hashes, list):
            return set()
        return {
            token_hash
            for token_hash in token_hashes
            if isinstance(token_hash, str)
            and len(token_hash) == 64
            and all(character in "0123456789abcdef" for character in token_hash)
        }

    def _save_token_hashes(self) -> None:
        try:
            self.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if os.name == "nt":
                with self.state_path.open("w", encoding="utf-8") as state_file:
                    json.dump({"version": 1, "token_hashes": sorted(self.token_hashes)}, state_file)
                    state_file.write("\n")
                    state_file.flush()
                    os.fsync(state_file.fileno())
                os.chmod(self.state_path, 0o600)
                return
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=f".{self.state_path.name}.", suffix=".tmp", dir=self.state_path.parent,
            )
            try:
                os.chmod(temporary_path, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as state_file:
                    json.dump({"version": 1, "token_hashes": sorted(self.token_hashes)}, state_file)
                    state_file.write("\n")
                    state_file.flush()
                    os.fsync(state_file.fileno())
                os.replace(temporary_path, self.state_path)
                os.chmod(self.state_path, 0o600)
            except Exception:
                with suppress(FileNotFoundError):
                    os.unlink(temporary_path)
                raise
        except OSError as error:
            raise PairingStateError("无法安全保存受信任设备授权。") from error

    def pair(self, code: str) -> str | None:
        if time.monotonic() < self.blocked_until:
            return None
        if not hmac.compare_digest(normalize_pairing_code(code), self.code):
            self.failed_attempts += 1
            if self.failed_attempts >= PAIRING_MAX_FAILED_ATTEMPTS:
                self.failed_attempts = 0
                self.blocked_until = time.monotonic() + PAIRING_LOCKOUT_SECONDS
            return None
        self.failed_attempts = 0
        token = secrets.token_urlsafe(32)
        token_hash = self._token_hash(token)
        self.token_hashes.add(token_hash)
        try:
            self._save_token_hashes()
        except PairingStateError:
            self.token_hashes.discard(token_hash)
            raise
        return token

    def retry_after_seconds(self) -> int:
        return max(0, math.ceil(self.blocked_until - time.monotonic()))

    def accepts(self, token: str | None) -> bool:
        if not token:
            return False
        token_hash = self._token_hash(token)
        return any(hmac.compare_digest(token_hash, known_hash) for known_hash in self.token_hashes)

    def revoke(self, token: str) -> bool:
        token_hash = self._token_hash(token)
        if token_hash not in self.token_hashes:
            return False
        self.token_hashes.remove(token_hash)
        try:
            self._save_token_hashes()
        except PairingStateError:
            self.token_hashes.add(token_hash)
            raise
        return True


def create_app(workspace: Path | None = None, codex_command: str | None = None) -> FastAPI:
    project_root = Path(__file__).resolve().parents[2]
    configured_workspace = resolve_default_workspace(
        project_root,
        configured=workspace or (Path(os.environ["CODEX_REMOTE_WORKSPACE"]) if os.environ.get("CODEX_REMOTE_WORKSPACE") else None),
    )
    app_server = CodexAppServer(
        codex_command or os.environ.get("CODEX_REMOTE_COMMAND", "codex"),
        configured_workspace,
    )
    auth = PairingAuth()
    try:
        auth.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"无法准备 Codex Remote 用户数据目录：{auth.state_path.parent}：{error}") from error
    state_path = Path(os.environ.get("CODEX_REMOTE_STATE_FILE", str(auth.state_path.parent / "shared-state.sqlite3"))).expanduser()
    shared_state = SharedStateStore(state_path)
    claude_code = ClaudeCodeServer(
        os.environ.get("CODEX_REMOTE_CLAUDE_COMMAND", "claude"),
        configured_workspace,
        state_path.parent / "claude-code.sqlite3",
        app_server._emit,
    )
    idempotent_requests = IdempotentRequestRegistry()
    image_directory = prepare_message_image_directory(auth.state_path.parent)
    image_storage_lock = threading.Lock()
    runtime_directory = Path(tempfile.mkdtemp(prefix="codex-remote-runtime-", dir=auth.state_path.parent))
    pdf_attachments = PdfAttachmentStore(runtime_directory / "pdf-attachments")
    terminal_sessions: set[TerminalSession] = set()

    async def reap_tmux_terminal_sessions() -> None:
        while True:
            try:
                protected_sessions = {
                    session.tmux_session_name
                    for session in terminal_sessions
                    if session.tmux_session_name is not None
                }
                await cleanup_tmux_sessions(protected_sessions)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Could not clean idle tmux terminal sessions")
            await asyncio.sleep(TMUX_CLEANUP_INTERVAL_SECONDS)

    async def reap_expired_message_images() -> None:
        while True:
            await asyncio.sleep(MESSAGE_IMAGE_CLEANUP_INTERVAL_SECONDS)
            try:
                deleted = await asyncio.to_thread(cleanup_expired_message_images, image_directory)
                if deleted:
                    logger.info("Removed %d expired chat image(s)", deleted)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Could not clean expired chat images")

    async def send_queued_turn(thread_id: str, payload: dict[str, Any], steer: bool) -> str | None:
        images = [TurnImage(name=image["name"], media_type=image["mediaType"], data=image["data"]) for image in payload["images"]]
        pdf_ids = [document["sourceFileId"] for document in payload.get("documents", []) if document.get("sourceFileId")]
        if is_claude_thread_id(thread_id):
            turn_directory, prompt, image_paths, attachment_paths = prepare_claude_turn_files(
                payload["requestText"], images, pdf_ids, pdf_attachments, runtime_directory,
            )
            try:
                turn_id = await claude_code.start_turn(
                    thread_id,
                    prompt,
                    display_prompt=payload["requestText"] or ("已附加图片" if images else "已附加文件"),
                    image_paths=image_paths,
                    attachment_paths=attachment_paths,
                    temporary_directory=turn_directory,
                    request_id=payload["id"],
                    model=payload.get("claudeModel"),
                    effort=payload.get("claudeEffort"),
                    permission_mode=payload.get("claudePermissionMode"),
                )
            except Exception:
                if turn_directory is not None:
                    shutil.rmtree(turn_directory, ignore_errors=True)
                raise
            await app_server.notify_turn_delivery(thread_id, payload["id"], turn_id)
            return turn_id
        if steer:
            result = await steer_turn(thread_id, SteerRequest(
                prompt=payload["requestText"], images=images, pdf_attachments=pdf_ids, request_id=payload["id"],
            ))
        else:
            result = await start_turn(thread_id, TurnRequest(
                prompt=payload["requestText"], images=images, pdf_attachments=pdf_ids,
                model=payload.get("model"), effort=payload.get("effort"),
                approval_policy=payload.get("approvalPolicy"), request_id=payload["id"],
            ))
        return result.get("turn_id")

    shared_queue = SharedQueueService(shared_state, app_server, send_queued_turn, claude_code)

    async def thread_workspace_for_turn(thread_id: str) -> Path:
        bound_cwd = shared_state.thread_workspace(thread_id)
        if bound_cwd:
            try:
                return workspace_base_for_cwd(app_server.workspace, bound_cwd)
            except HTTPException as error:
                raise CodexRuntimeError(f"聊天绑定的工作目录不可用：{error.detail}") from error
        thread = await app_server.read_thread(thread_id, include_turns=False)
        try:
            return workspace_base_for_cwd(app_server.workspace, thread.get("cwd"))
        except HTTPException as error:
            raise CodexRuntimeError(f"聊天工作目录不可用：{error.detail}") from error

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        print(f"\nCodex Remote 配对码：{auth.code}\n", flush=True)
        try:
            deleted = await asyncio.to_thread(cleanup_expired_message_images, image_directory)
            if deleted:
                logger.info("Removed %d expired chat image(s) at startup", deleted)
        except Exception:
            logger.exception("Could not clean expired chat images at startup")
        history_watcher = asyncio.create_task(watch_codex_history(app_server))
        claude_history_watcher = asyncio.create_task(watch_claude_history(claude_code))
        claude_code.schedule_native_refresh()
        image_reaper = asyncio.create_task(reap_expired_message_images())
        terminal_reaper = asyncio.create_task(reap_tmux_terminal_sessions())
        shared_queue.start()
        try:
            yield
        finally:
            image_reaper.cancel()
            with suppress(asyncio.CancelledError):
                await image_reaper
            terminal_reaper.cancel()
            with suppress(asyncio.CancelledError):
                await terminal_reaper
            await shared_queue.close()
            await claude_code.close()
            for terminal_session in tuple(terminal_sessions):
                await terminal_session.close()
            history_watcher.cancel()
            with suppress(asyncio.CancelledError):
                await history_watcher
            claude_history_watcher.cancel()
            with suppress(asyncio.CancelledError):
                await claude_history_watcher
            await app_server.close()
            shared_state.close()
            shutil.rmtree(runtime_directory, ignore_errors=True)

    app = FastAPI(title="Codex Remote", version="0.43.0-dev.2", lifespan=lifespan)
    app.state.codex = app_server
    app.state.claude_code = claude_code
    app.state.auth = auth
    app.state.idempotent_requests = idempotent_requests
    app.state.pdf_attachments = pdf_attachments
    app.state.message_image_directory = image_directory
    app.state.shared_state = shared_state
    app.state.shared_queue = shared_queue
    browser_history_sync = BrowserHistorySync()
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def require_pairing(request: Request, call_next):
        if request.url.path.startswith("/api/v1/") and request.url.path != "/api/v1/pair":
            authorization = request.headers.get("authorization", "")
            token = authorization.removeprefix("Bearer ").strip()
            if not auth.accepts(token):
                return JSONResponse({"detail": "需要配对码"}, status_code=status.HTTP_401_UNAUTHORIZED)
        return await call_next(request)

    async def run_idempotent_request(
        operation: str,
        resource_id: str,
        request_id: str | None,
        body: BaseModel,
        callback: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        if request_id is None:
            return await callback()
        try:
            return await idempotent_requests.run(
                operation,
                resource_id,
                request_id,
                request_fingerprint(body),
                callback,
            )
        except IdempotencyConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ready"}

    @app.post("/api/v1/pair")
    async def pair(request: PairRequest) -> dict[str, str]:
        try:
            token = auth.pair(request.code)
        except PairingStateError as error:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error
        if token is None:
            retry_after = auth.retry_after_seconds()
            if retry_after > 0:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="配对尝试次数已达上限，配对已暂停",
                    headers={"Retry-After": str(retry_after)},
                )
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="配对码错误")
        return {"token": token}

    @app.post("/api/v1/unpair")
    async def unpair(request: Request) -> dict[str, bool]:
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        try:
            auth.revoke(token)
        except PairingStateError as error:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error
        return {"unpaired": True}

    @app.get("/api/v1/codex/status")
    async def codex_status() -> dict[str, Any]:
        runtime_status = app_server.status()
        if not runtime_status["available"]:
            runtime_status["error"] = f"找不到 Codex CLI：{app_server.command}"
        return runtime_status

    @app.get("/api/v1/claude/status")
    async def claude_status() -> dict[str, Any]:
        return claude_code.status()

    @app.get("/api/v1/codex/workspace/tree")
    async def workspace_tree(cwd: str | None = None, path: str = "", offset: int = 0) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, cwd)
        return workspace_directory_tree(base, path, offset)

    @app.get("/api/v1/codex/workspace/file")
    async def workspace_file(cwd: str | None = None, path: str = "") -> dict[str, str | int | bool]:
        base = workspace_base_for_cwd(app_server.workspace, cwd)
        return workspace_file_preview(base, path)

    @app.get("/api/v1/codex/workspace/image")
    async def workspace_image(cwd: str | None = None, path: str = "") -> dict[str, str | int]:
        base = workspace_base_for_cwd(app_server.workspace, cwd)
        return workspace_image_preview(base, path, image_directory)

    @app.get("/api/v1/codex/threads/{thread_id}/viewed-image")
    async def codex_viewed_image(thread_id: str, path: str = "") -> dict[str, str | int]:
        if is_claude_thread_id(thread_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到 Codex 会话")
        try:
            thread = await app_server.read_thread(thread_id)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        is_absolute = path.startswith(("/", "\\")) or (len(path) > 1 and path[1] == ":")
        if is_absolute:
            base = app_server.workspace
        else:
            cwd = shared_state.thread_workspace(thread_id) or thread.get("cwd")
            base = workspace_base_for_cwd(app_server.workspace, cwd)
        return codex_viewed_image_preview(base, path, thread, image_directory)

    @app.post("/api/v1/codex/workspace/file")
    async def save_workspace_file(request: WorkspaceFileSaveRequest) -> dict[str, str | int | bool]:
        base = workspace_base_for_cwd(app_server.workspace, request.cwd)
        return workspace_file_save(base, request.path, request.content, request.revision)

    @app.post("/api/v1/codex/workspace/entries")
    async def create_workspace_entry(request: WorkspaceEntryCreateRequest) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, request.cwd)
        return workspace_create_entry(base, request.path, request.kind)

    @app.patch("/api/v1/codex/workspace/entry")
    async def rename_workspace_entry(request: WorkspaceEntryRenameRequest) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, request.cwd)
        return workspace_rename_entry(base, request.path, request.name)

    @app.post("/api/v1/codex/workspace/delete")
    async def delete_workspace_entries(request: WorkspaceEntriesDeleteRequest) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, request.cwd)
        return workspace_delete_entries(base, request.paths)

    @app.post("/api/v1/codex/workspace/paste")
    async def paste_workspace_entries(request: WorkspaceEntriesPasteRequest) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, request.cwd)
        return workspace_paste_entries(base, request.paths, request.destination, request.mode)

    @app.get("/api/v1/codex/threads")
    async def list_threads() -> list[dict[str, Any]]:
        claude_code.schedule_native_refresh()
        claude_threads = claude_code.list_threads()
        try:
            threads = await app_server.list_threads()
            workspaces = shared_state.thread_workspaces()
            result = []
            for thread in threads:
                thread_id = thread.get("id")
                summary = browser_thread_summary(thread)
                if isinstance(thread_id, str):
                    revision = app_server.thread_history_revision(thread_id)
                    if revision is not None:
                        summary["historyRevision"] = revision
                    if thread_id in workspaces:
                        summary["cwd"] = workspaces[thread_id]
                result.append(summary)
            return [*result, *claude_threads]
        except CodexRuntimeError as error:
            logger.warning("Could not list Codex threads while returning Claude Code chats: %s", error)
            return claude_threads

    @app.get("/api/v1/codex/models")
    async def list_models() -> list[dict[str, Any]]:
        try:
            return await app_server.list_models()
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/handoff")
    async def handoff_to_local_codex() -> dict[str, bool]:
        try:
            await app_server.handoff_to_local_codex()
            return {"handedOff": True}
        except CodexHandoffBusyError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/reclaim")
    async def reclaim_for_remote() -> dict[str, Any]:
        try:
            return await app_server.reclaim_for_remote()
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads", status_code=status.HTTP_201_CREATED)
    async def create_thread(body: ThreadStartRequest) -> dict[str, Any]:
        async def create() -> dict[str, Any]:
            cwd = workspace_base_for_cwd(app_server.workspace, body.cwd) if body.cwd else None
            if body.engine == "claude-code":
                return await claude_code.create_thread(cwd)
            return await app_server.start_thread(
                body.model.strip() or None if body.model else None,
                body.approval_policy,
                cwd=cwd,
            )

        try:
            return await run_idempotent_request(
                "thread.start",
                "new",
                body.request_id,
                body,
                create,
            )
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        except ClaudeCodeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.get("/api/v1/codex/threads/{thread_id}")
    async def read_thread(
        thread_id: str,
        since: str | None = None,
        include_images: bool = True,
        tail_turns: int | None = None,
    ) -> dict[str, Any]:
        if is_claude_thread_id(thread_id):
            try:
                claude_code.schedule_native_refresh()
                thread = await claude_code.read_thread(thread_id)
                response = browser_history_sync.response(thread, since)
                return tail_thread_history(response, tail_turns if since is None else None)
            except ClaudeThreadNotFoundError as error:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        try:
            # Capture before reading: a concurrent append must leave this
            # response stale, rather than claiming to contain the new data.
            revision = app_server.thread_history_revision(thread_id)
            thread = browser_thread(await app_server.read_thread(thread_id, tail_turns=tail_turns))
            if revision is not None:
                thread["historyRevision"] = revision
            bound_cwd = shared_state.thread_workspace(thread_id)
            if bound_cwd:
                thread = {**thread, "cwd": bound_cwd}
            response = browser_history_sync.response(thread, since)
            response = tail_thread_history(response, tail_turns if since is None else None)
            return enrich_thread_images(response, image_directory) if include_images else response
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.delete("/api/v1/codex/threads/{thread_id}")
    async def delete_thread(thread_id: str) -> dict[str, Any]:
        if not thread_id or len(thread_id) > 512:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="聊天编号无效。")
        try:
            await shared_queue.delete_thread(thread_id)
            await app_server._emit({"type": "remote.pins.changed", "threadId": thread_id, "pinned": False})
            return {"thread_id": thread_id, "deleted": True, "thread_ids": shared_state.pins()}
        except CodexThreadBusyError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except CodexThreadNotFoundError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        except ClaudeCodeError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/workspace")
    async def bind_thread_workspace(thread_id: str, body: ThreadWorkspaceRequest) -> dict[str, str]:
        cwd = workspace_base_for_cwd(app_server.workspace, body.cwd)
        if is_claude_thread_id(thread_id):
            try:
                result = await claude_code.set_workspace(thread_id, cwd)
                shared_state.set_thread_workspace(thread_id, result["cwd"])
                return result
            except ClaudeCodeError as error:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        try:
            await app_server.read_thread(thread_id, include_turns=False)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        shared_state.set_thread_workspace(thread_id, str(cwd))
        await app_server.notify_threads_changed()
        return {"thread_id": thread_id, "cwd": str(cwd)}

    @app.post("/api/v1/codex/threads/{thread_id}/name")
    async def rename_thread(thread_id: str, body: ThreadNameRequest) -> dict[str, str]:
        name = " ".join(body.name.split())
        if not name:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="会话名称不能为空。")
        if len(name) > 72:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="会话名称不能超过 72 个字符。")
        if any(unicodedata.category(character) == "Cc" for character in name):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="会话名称不能包含控制字符。")
        if is_claude_thread_id(thread_id):
            try:
                return await claude_code.rename_thread(thread_id, name)
            except ClaudeCodeError as error:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        try:
            await app_server.set_thread_name(thread_id, name)
            return {"thread_id": thread_id, "name": name}
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/settings")
    async def update_thread_settings(thread_id: str, body: ThreadSettingsUpdateRequest) -> dict[str, Any]:
        if is_claude_thread_id(thread_id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Claude Code 对话使用本机 Claude Code 的权限设置。")
        try:
            return await app_server.update_thread_approval_policy(thread_id, body.approval_policy)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.get("/api/v1/codex/queue/{thread_id}")
    async def read_queued_messages(thread_id: str) -> dict[str, Any]:
        return {"queue": shared_state.queue(thread_id), "paused": shared_state.is_paused(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/submit")
    async def submit_message(thread_id: str, body: QueuedMessageRequest) -> dict[str, Any]:
        if not body.requestText.strip() and not body.images and not body.documents:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="消息不能为空。")
        try:
            sent = await shared_queue.submit(thread_id, body.model_dump(exclude_none=True))
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        return {"sent": sent, "queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/enqueue")
    async def enqueue_message(thread_id: str, body: QueuedMessageRequest) -> dict[str, Any]:
        if not body.requestText.strip() and not body.images and not body.documents:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="排队消息不能为空。")
        try:
            inserted = shared_state.enqueue(thread_id, body.model_dump(exclude_none=True))
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        if inserted:
            await shared_queue.changed(thread_id)
        return {"queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/edit/begin")
    async def begin_queued_edit(thread_id: str, body: QueueMessageIdRequest) -> dict[str, Any]:
        try:
            shared_state.edit(thread_id, body.message_id, True, body.owner_id or "legacy")
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await shared_queue.changed(thread_id)
        return {"queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/edit/end")
    async def end_queued_edit(thread_id: str, body: QueueMessageIdRequest) -> dict[str, Any]:
        try:
            shared_state.edit(thread_id, body.message_id, False, body.owner_id or "legacy")
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await shared_queue.changed(thread_id)
        return {"queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/edit/renew")
    async def renew_queued_edit(thread_id: str, body: QueueMessageIdRequest) -> dict[str, bool]:
        try:
            shared_state.renew_edit(thread_id, body.message_id, body.owner_id or "legacy")
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        return {"renewed": True}

    @app.post("/api/v1/codex/queue/{thread_id}/edit/update")
    async def update_queued_message(thread_id: str, body: QueuedMessageRequest) -> dict[str, Any]:
        if not body.requestText.strip() and not body.images and not body.documents:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="排队消息不能为空。")
        try:
            shared_state.update(thread_id, body.id, body.model_dump(exclude_none=True))
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await shared_queue.changed(thread_id)
        return {"queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/remove")
    async def remove_queued_message(thread_id: str, body: QueueMessageIdRequest) -> dict[str, Any]:
        try:
            shared_state.remove(thread_id, body.message_id)
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        await shared_queue.changed(thread_id)
        return {"queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/send-now")
    async def send_queued_message_now(thread_id: str, body: QueueMessageIdRequest) -> dict[str, Any]:
        try:
            sent = await shared_queue.send_now(thread_id, body.message_id)
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        return {"sent": sent, "queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/queue/{thread_id}/start-if-idle")
    async def start_queued_message_if_idle(thread_id: str, body: QueueMessageIdRequest) -> dict[str, Any]:
        try:
            # An explicit user click may prioritize any queued item. Automatic
            # queue advancement remains FIFO in SharedQueueService.advance().
            sent = await shared_queue.send_now(thread_id, body.message_id, allow_steer=False)
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        return {"sent": sent, "queue": shared_state.queue(thread_id)}

    @app.get("/api/v1/codex/pins")
    async def read_pins() -> dict[str, list[str]]:
        return {"thread_ids": shared_state.pins()}

    @app.post("/api/v1/codex/pins/initialize")
    async def initialize_pins(body: PinsInitializeRequest) -> dict[str, list[str]]:
        ids = [item for item in body.thread_ids if item and len(item) <= 512]
        previous = shared_state.pins()
        pins = shared_state.initialize_pins(ids)
        if pins != previous:
            await app_server._emit({"type": "remote.pins.changed"})
        return {"thread_ids": pins}

    @app.post("/api/v1/codex/threads/{thread_id}/pin")
    async def set_thread_pin(thread_id: str, body: PinRequest) -> dict[str, list[str]]:
        if len(thread_id) > 512:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="对话编号过长。")
        shared_state.set_pin(thread_id, body.pinned)
        await app_server._emit({"type": "remote.pins.changed", "threadId": thread_id, "pinned": body.pinned})
        return {"thread_ids": shared_state.pins()}

    @app.post("/api/v1/codex/pdf-attachments")
    async def upload_pdf_attachment(request: Request) -> dict[str, Any]:
        media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type not in ORIGINAL_DOCUMENT_MEDIA_TYPES:
            raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="只支持上传 PDF 或 Excel 原件。")
        name = request.query_params.get("name", "")
        try:
            PdfAttachmentStore.safe_name(name)
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_PDF_BYTES:
                    raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="单个 PDF 不能超过 20 MB。")
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PDF 上传长度无效。")
        try:
            content = await read_limited_pdf_body(request)
            attachment = pdf_attachments.save(name, content)
        except OverflowError as error:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
        return {"attachment_id": attachment.attachment_id, "name": attachment.name, "size": attachment.size}

    @app.post("/api/v1/codex/threads/{thread_id}/resume")
    async def resume_thread(thread_id: str, body: ResumeRequest | None = None) -> dict[str, Any]:
        if is_claude_thread_id(thread_id):
            try:
                thread = await claude_code.read_thread(thread_id)
                if body is not None and not body.include_history:
                    return {key: value for key, value in thread.items() if key != "turns"}
                return thread
            except ClaudeThreadNotFoundError as error:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

        async def resume() -> dict[str, Any]:
            bound_cwd = shared_state.thread_workspace(thread_id)
            cwd = workspace_base_for_cwd(app_server.workspace, bound_cwd) if bound_cwd else None
            thread = await app_server.resume_thread(thread_id, cwd=cwd)
            if cwd is not None:
                thread = {**thread, "cwd": str(cwd)}
            # Sending needs the resume acknowledgement, not another copy of
            # the entire history. Keep legacy clients' full response intact.
            if body is not None and not body.include_history:
                return {key: value for key, value in thread.items() if key != "turns"}
            return thread

        try:
            if body is None:
                return await resume()
            return await run_idempotent_request(
                "thread.resume",
                thread_id,
                body.request_id,
                body,
                resume,
            )
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/turns")
    async def start_turn(thread_id: str, body: TurnRequest) -> dict[str, Any]:
        prompt = body.prompt.strip()
        if not prompt and not body.images and not body.pdf_attachments:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请填写消息或附加图片")

        if is_claude_thread_id(thread_id):
            async def start_claude_turn() -> dict[str, Any]:
                turn_directory, turn_prompt, image_paths, attachment_paths = prepare_claude_turn_files(
                    prompt, body.images, body.pdf_attachments, pdf_attachments, runtime_directory,
                )
                try:
                    turn_id = await claude_code.start_turn(
                        thread_id,
                        turn_prompt,
                        display_prompt=prompt or ("已附加图片" if body.images else "已附加文件"),
                        image_paths=image_paths,
                        attachment_paths=attachment_paths,
                        temporary_directory=turn_directory,
                        request_id=body.request_id,
                        model=body.claude_model,
                        effort=body.claude_effort,
                        permission_mode=body.claude_permission_mode,
                    )
                except Exception:
                    if turn_directory is not None:
                        shutil.rmtree(turn_directory, ignore_errors=True)
                    raise
                await app_server.notify_turn_delivery(thread_id, body.request_id, turn_id)
                return {"turn_id": turn_id}

            try:
                return await run_idempotent_request(
                    "turn.start", thread_id, body.request_id, body, start_claude_turn,
                )
            except ClaudeThreadBusyError as error:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
            except ClaudeThreadNotFoundError as error:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
            except ClaudeCodeError as error:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

        async def start() -> dict[str, Any]:
            image_paths = save_turn_images(
                body.images, image_directory,
                max_storage_bytes=MAX_STORED_IMAGE_BYTES,
                storage_lock=image_storage_lock,
            )
            try:
                turn_prompt = prompt_with_original_pdfs(prompt, body.pdf_attachments, pdf_attachments)
                cwd = await thread_workspace_for_turn(thread_id)
                result = await app_server.start_turn(
                    thread_id,
                    turn_prompt,
                    image_paths,
                    body.model.strip() or None if body.model else None,
                    body.effort.strip() or None if body.effort else None,
                    body.approval_policy,
                    cwd,
                )
                turn = result.get("turn", {})
                turn_id = turn.get("id") if isinstance(turn, dict) else None
                await app_server.notify_turn_delivery(thread_id, body.request_id, turn_id)
                return {"turn_id": turn_id}
            except Exception:
                for path in image_paths:
                    with suppress(FileNotFoundError):
                        path.unlink()
                raise

        try:
            return await run_idempotent_request(
                "turn.start",
                thread_id,
                body.request_id,
                body,
                start,
            )
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/interrupt")
    async def interrupt_turn(thread_id: str, body: InterruptRequest | None = None) -> dict[str, bool]:
        try:
            return {"interrupted": await shared_queue.pause_thread(thread_id, body.turn_id if body else None)}
        except ClaudeThreadNotFoundError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/continue")
    async def continue_interrupted_turn(thread_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = None
        if is_claude_thread_id(thread_id):
            try:
                payload = QueuedMessageRequest.model_validate(body).model_dump(exclude_none=True)
            except ValidationError as error:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error.errors()) from error
        try:
            turn_id = await shared_queue.continue_paused(thread_id, payload)
        except QueueConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except (CodexRuntimeError, ClaudeCodeError) as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        return {"continued": True, "turn_id": turn_id, "queue": shared_state.queue(thread_id)}

    @app.post("/api/v1/codex/threads/{thread_id}/stop")
    async def stop_interrupted_turn(thread_id: str) -> dict[str, bool]:
        try:
            await shared_queue.stop_thread(thread_id)
        except ClaudeThreadNotFoundError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except (CodexRuntimeError, ClaudeCodeError) as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        return {"stopped": True}

    @app.post("/api/v1/codex/threads/{thread_id}/steer")
    async def steer_turn(thread_id: str, body: SteerRequest) -> dict[str, str | None]:
        prompt = body.prompt.strip()
        if not prompt and not body.images and not body.pdf_attachments:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请填写消息或附加图片")

        async def steer() -> dict[str, Any]:
            image_paths = save_turn_images(
                body.images, image_directory,
                max_storage_bytes=MAX_STORED_IMAGE_BYTES,
                storage_lock=image_storage_lock,
            )
            try:
                turn_prompt = prompt_with_original_pdfs(prompt, body.pdf_attachments, pdf_attachments)
                result = await app_server.steer_turn(thread_id, turn_prompt, image_paths)
                turn_id = result.get("turnId")
                if not isinstance(turn_id, str):
                    turn = result.get("turn")
                    turn_id = turn.get("id") if isinstance(turn, dict) and isinstance(turn.get("id"), str) else None
                await app_server.notify_turn_delivery(thread_id, body.request_id, turn_id)
                return {"turn_id": turn_id}
            except Exception:
                for path in image_paths:
                    with suppress(FileNotFoundError):
                        path.unlink()
                raise

        try:
            return await run_idempotent_request(
                "turn.steer",
                thread_id,
                body.request_id,
                body,
                steer,
            )
        except CodexNoActiveTurnError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.websocket("/api/v1/codex/ws")
    async def codex_websocket(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except WebSocketDisconnect:
            return
        except (TimeoutError, ValueError):
            with suppress(WebSocketDisconnect):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="client hello required")
            return
        if (
            not isinstance(hello, dict)
            or hello.get("type") != "codex.client.hello"
            or hello.get("protocol_version") != 1
            or not auth.accepts(hello.get("token"))
        ):
            with suppress(WebSocketDisconnect):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid pairing token or protocol")
            return

        filter_thread = "thread_id" in hello
        subscribed_thread_id = hello.get("thread_id") if isinstance(hello.get("thread_id"), str) else None
        queue = await app_server.subscribe()
        send_lock = asyncio.Lock()
        tasks: list[asyncio.Task[None]] = []

        async def send_event(event: dict[str, Any]) -> None:
            async with send_lock:
                await websocket.send_json(event)

        async def send_events() -> None:
            while True:
                event = browser_event(await queue.get(), thread_id=subscribed_thread_id, filter_thread=filter_thread)
                if event is None:
                    continue
                if event.get("method") in {"item/started", "item/completed"}:
                    params = event.get("params")
                    item = params.get("item") if isinstance(params, dict) else None
                    if isinstance(item, dict):
                        event = {
                            **event,
                            "params": {
                                **params,
                                "item": enrich_user_message_item(item, image_directory),
                            },
                        }
                await send_event(event)

        async def receive_events() -> None:
            nonlocal subscribed_thread_id, filter_thread
            while True:
                payload = await websocket.receive_json()
                if isinstance(payload, dict) and payload.get("type") == "ping":
                    ping_id = payload.get("id")
                    if isinstance(ping_id, str) and 0 < len(ping_id) <= 64:
                        await send_event({"type": "pong", "id": ping_id})
                    continue
                if isinstance(payload, dict) and payload.get("type") == "thread.subscribe":
                    requested_thread_id = payload.get("thread_id")
                    if requested_thread_id is None or (isinstance(requested_thread_id, str) and len(requested_thread_id) <= 512):
                        subscribed_thread_id = requested_thread_id
                        filter_thread = True
                    continue
                if not isinstance(payload, dict) or payload.get("type") != "approval.response":
                    with suppress(WebSocketDisconnect):
                        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="unsupported client message")
                    return
                request_id = payload.get("request_id")
                decision = payload.get("decision")
                if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                    continue
                if not isinstance(decision, str) or decision not in {"accept", "decline", "cancel"}:
                    continue
                try:
                    await app_server.answer_server_request(request_id, decision)
                except CodexRuntimeError as error:
                    await send_event({"type": "error", "message": str(error)})

        try:
            try:
                runtime_status = await app_server.connect()
            except CodexRuntimeError as error:
                runtime_status = app_server.status()
                runtime_status["error"] = str(error)
            await send_event({"type": "connection", **runtime_status, "threadSubscriptions": True, "heartbeats": True})
            tasks = [asyncio.create_task(send_events()), asyncio.create_task(receive_events())]
            # A failed writer must also release its reader and subscription.
            # Otherwise a dead browser can keep accumulating queued events.
            done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                await task
        except (WebSocketDisconnect, OSError, RuntimeError, ValueError):
            pass
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            app_server.unsubscribe(queue)
            with suppress(WebSocketDisconnect, RuntimeError, OSError):
                await websocket.close()

    @app.websocket("/api/v1/codex/terminal")
    async def terminal_websocket(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except WebSocketDisconnect:
            return
        except (TimeoutError, ValueError):
            with suppress(WebSocketDisconnect):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="terminal hello required")
            return
        if (
            not isinstance(hello, dict)
            or hello.get("type") != "terminal.connect"
            or not isinstance(hello.get("token"), str)
            or not auth.accepts(hello.get("token"))
        ):
            with suppress(WebSocketDisconnect):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid pairing token or protocol")
            return

        thread_id = hello.get("threadId")
        if thread_id is not None and (
            not isinstance(thread_id, str)
            or not thread_id
            or len(thread_id) > 512
        ):
            await websocket.send_json({"type": "error", "message": "终端聊天标识无效。"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        raw_cwd = hello.get("cwd")
        if raw_cwd is not None and not isinstance(raw_cwd, str):
            await websocket.send_json({"type": "error", "message": "终端工作目录无效。"})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        try:
            cwd = workspace_base_for_cwd(app_server.workspace, raw_cwd)
            terminal_session = await TerminalSession.create(
                cwd,
                hello.get("columns", 100),
                hello.get("rows", 30),
                thread_id=thread_id,
            )
        except HTTPException as error:
            await websocket.send_json({"type": "error", "message": str(error.detail)})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        except Exception as error:
            logger.warning("Could not start local terminal: %s", error)
            with suppress(WebSocketDisconnect, RuntimeError):
                await websocket.send_json({"type": "error", "message": str(error) or "无法启动本机终端。"})
                await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
            return

        terminal_sessions.add(terminal_session)
        send_lock = asyncio.Lock()

        async def send_json(payload: dict[str, Any]) -> None:
            async with send_lock:
                await websocket.send_json(payload)

        async def send_output() -> None:
            await send_json({
                "type": "ready",
                "cwd": str(cwd),
                "shell": terminal_session.shell_name,
                "persistent": terminal_session.persistent,
            })
            while True:
                output = await terminal_session.read()
                if not output:
                    break
                async with send_lock:
                    await websocket.send_bytes(output)
            await send_json({"type": "exit"})

        async def receive_input() -> None:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    return
                text = message.get("text")
                if not isinstance(text, str):
                    continue
                try:
                    payload = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(payload, dict):
                    continue
                if payload.get("type") == "input" and isinstance(payload.get("data"), str):
                    await terminal_session.write(payload["data"])
                elif payload.get("type") == "resize":
                    await terminal_session.resize(payload.get("columns"), payload.get("rows"))
                elif payload.get("type") == "close":
                    return

        output_task = asyncio.create_task(send_output())
        input_task = asyncio.create_task(receive_input())
        tasks = (output_task, input_task)
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for task in tasks:
                with suppress(Exception, asyncio.CancelledError):
                    task.result()
            terminal_sessions.discard(terminal_session)
            await terminal_session.close()
            with suppress(Exception):
                await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)

    return app
