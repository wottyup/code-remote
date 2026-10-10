from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import tempfile
import time
import unicodedata
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from watchfiles import awatch

from .codex_app_server import (
    ApprovalPolicy,
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
)

logger = logging.getLogger(__name__)


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
        return relative.name == "session_index.jsonl" or relative.suffix == ".jsonl" or not relative.suffix

    try:
        async for changes in awatch(watch_root, watch_filter=is_session_change, debounce=500):
            if changes:
                await app_server.notify_threads_changed()
    except asyncio.CancelledError:
        raise
    except OSError:
        logger.exception("Could not watch Codex session history")


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


class ThreadStartRequest(BaseModel):
    model: str | None = Field(default=None, max_length=200)
    approval_policy: ApprovalPolicy | None = None
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class TurnImage(BaseModel):
    name: str = Field(default="image", min_length=1, max_length=255)
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data: str = Field(min_length=4)


class TurnRequest(BaseModel):
    prompt: str = Field(default="", max_length=32_000)
    images: list[TurnImage] = Field(default_factory=list, max_length=MAX_IMAGES_PER_TURN)
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=50)
    approval_policy: ApprovalPolicy | None = None
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class SteerRequest(BaseModel):
    prompt: str = Field(default="", max_length=32_000)
    images: list[TurnImage] = Field(default_factory=list, max_length=MAX_IMAGES_PER_TURN)
    request_id: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


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


def workspace_file_preview(base: Path, relative_path: str) -> dict[str, str | int]:
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
    line_count = content.count("\n") + content.count("\r") - content.count("\r\n")
    if content and not content.endswith(("\n", "\r")):
        line_count += 1
    if line_count > WORKSPACE_FILE_PREVIEW_MAX_LINES:
        raise HTTPException(status_code=413, detail="文件行数过多，暂不支持预览")
    return {"path": resolved_relative.as_posix(), "content": content, "size": len(content_bytes)}


def save_turn_images(images: list[TurnImage], image_directory: Path) -> list[Path]:
    paths: list[Path] = []
    total_size = 0
    try:
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
            path = image_directory / f"{secrets.token_hex(16)}{IMAGE_EXTENSIONS[image.media_type]}"
            path.write_bytes(content)
            paths.append(path)
        return paths
    except Exception:
        for path in paths:
            with suppress(FileNotFoundError):
                path.unlink()
        raise


def enrich_thread_images(thread: dict[str, Any], image_directory: Path) -> dict[str, Any]:
    """Embed images created by this process so a refreshed thread can render them."""
    image_root = image_directory.resolve()
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
                if not isinstance(part, dict) or part.get("type") != "localImage":
                    continue
                raw_path = part.get("path")
                if not isinstance(raw_path, str) or not raw_path:
                    continue
                try:
                    image_path = Path(raw_path).expanduser().resolve()
                    image_path.relative_to(image_root)
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
            project_root = Path(__file__).resolve().parents[2]
            return project_root / ".codex-remote" / "trusted-devices-v2.json"
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return codex_home / "codex-remote" / "trusted-devices.json"

    @staticmethod
    def _legacy_state_paths() -> tuple[Path, ...]:
        if os.name != "nt":
            return ()
        project_root = Path(__file__).resolve().parents[2]
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return (
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
            if self.failed_attempts >= 8:
                self.failed_attempts = 0
                self.blocked_until = time.monotonic() + 60
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
    configured_workspace = workspace or Path(os.environ.get("CODEX_REMOTE_WORKSPACE", project_root))
    app_server = CodexAppServer(
        codex_command or os.environ.get("CODEX_REMOTE_COMMAND", "codex"),
        configured_workspace,
    )
    auth = PairingAuth()
    idempotent_requests = IdempotentRequestRegistry()
    image_directory = Path(tempfile.mkdtemp(prefix="codex-remote-images-"))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        print(f"\nCodex Remote 配对码：{auth.code}\n", flush=True)
        history_watcher = asyncio.create_task(watch_codex_history(app_server))
        try:
            yield
        finally:
            history_watcher.cancel()
            with suppress(asyncio.CancelledError):
                await history_watcher
            await app_server.close()
            shutil.rmtree(image_directory, ignore_errors=True)

    app = FastAPI(title="Codex Remote", version="0.0.30", lifespan=lifespan)
    app.state.codex = app_server
    app.state.auth = auth
    app.state.idempotent_requests = idempotent_requests
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST"],
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
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="配对码无效或尝试次数过多")
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

    @app.get("/api/v1/codex/workspace/tree")
    async def workspace_tree(cwd: str | None = None, path: str = "", offset: int = 0) -> dict[str, Any]:
        base = workspace_base_for_cwd(app_server.workspace, cwd)
        return workspace_directory_tree(base, path, offset)

    @app.get("/api/v1/codex/workspace/file")
    async def workspace_file(cwd: str | None = None, path: str = "") -> dict[str, str | int]:
        base = workspace_base_for_cwd(app_server.workspace, cwd)
        return workspace_file_preview(base, path)

    @app.get("/api/v1/codex/threads")
    async def list_threads() -> list[dict[str, Any]]:
        try:
            return await app_server.list_threads()
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

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
            return await app_server.start_thread(
                body.model.strip() or None if body.model else None,
                body.approval_policy,
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

    @app.get("/api/v1/codex/threads/{thread_id}")
    async def read_thread(thread_id: str) -> dict[str, Any]:
        try:
            thread = await app_server.read_thread(thread_id)
            return enrich_thread_images(thread, image_directory)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/resume")
    async def resume_thread(thread_id: str, body: ResumeRequest | None = None) -> dict[str, Any]:
        async def resume() -> dict[str, Any]:
            thread = await app_server.resume_thread(thread_id)
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
        if not prompt and not body.images:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请填写消息或附加图片")

        async def start() -> dict[str, Any]:
            image_paths = save_turn_images(body.images, image_directory)
            try:
                result = await app_server.start_turn(
                    thread_id,
                    prompt,
                    image_paths,
                    body.model.strip() or None if body.model else None,
                    body.effort.strip() or None if body.effort else None,
                    body.approval_policy,
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
            await app_server.interrupt(thread_id, body.turn_id if body else None)
            return {"interrupted": True}
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/steer")
    async def steer_turn(thread_id: str, body: SteerRequest) -> dict[str, str | None]:
        prompt = body.prompt.strip()
        if not prompt and not body.images:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请填写消息或附加图片")

        async def steer() -> dict[str, Any]:
            image_paths = save_turn_images(body.images, image_directory)
            try:
                result = await app_server.steer_turn(thread_id, prompt, image_paths)
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
        except (TimeoutError, ValueError, WebSocketDisconnect):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="client hello required")
            return
        if (
            not isinstance(hello, dict)
            or hello.get("type") != "codex.client.hello"
            or hello.get("protocol_version") != 1
            or not auth.accepts(hello.get("token"))
        ):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid pairing token or protocol")
            return

        queue = await app_server.subscribe()
        try:
            runtime_status = await app_server.connect()
        except CodexRuntimeError as error:
            runtime_status = app_server.status()
            runtime_status["error"] = str(error)
        await websocket.send_json({"type": "connection", **runtime_status})

        async def send_events() -> None:
            while True:
                await websocket.send_json(await queue.get())

        writer = asyncio.create_task(send_events())
        try:
            while True:
                payload = await websocket.receive_json()
                if not isinstance(payload, dict) or payload.get("type") != "approval.response":
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
                    await websocket.send_json({"type": "error", "message": str(error)})
        except WebSocketDisconnect:
            pass
        finally:
            writer.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await writer
            app_server.unsubscribe(queue)

    return app
