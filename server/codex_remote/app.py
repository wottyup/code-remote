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
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from watchfiles import awatch

from .codex_app_server import ApprovalPolicy, CodexAppServer, CodexRuntimeError

logger = logging.getLogger(__name__)


async def watch_codex_history(app_server: CodexAppServer) -> None:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()
    sessions = codex_home / "sessions"
    watch_root = sessions if sessions.is_dir() else codex_home
    if not watch_root.is_dir():
        return

    def is_session_change(_change: object, changed_path: str) -> bool:
        path = Path(changed_path).resolve()
        if path == sessions:
            return True
        try:
            relative = path.relative_to(sessions)
        except ValueError:
            return False
        return relative.suffix == ".jsonl" or not relative.suffix

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
        self.state_path = state_path or self._default_state_path()
        self.token_hashes = self._load_token_hashes()
        self.failed_attempts = 0
        self.blocked_until = 0.0

    @staticmethod
    def _default_state_path() -> Path:
        configured_path = os.environ.get("CODEX_REMOTE_AUTH_FILE")
        if configured_path:
            return Path(configured_path).expanduser()
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return codex_home / "codex-remote" / "trusted-devices.json"

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _load_token_hashes(self) -> set[str]:
        try:
            raw_state = self.state_path.read_text(encoding="utf-8")
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
        if not hmac.compare_digest(code.strip().upper(), self.code):
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

    app = FastAPI(title="Codex Remote", version="0.0.20", lifespan=lifespan)
    app.state.codex = app_server
    app.state.auth = auth
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

    @app.post("/api/v1/codex/threads", status_code=status.HTTP_201_CREATED)
    async def create_thread(body: ThreadStartRequest) -> dict[str, Any]:
        try:
            return await app_server.start_thread(
                body.model.strip() or None if body.model else None,
                body.approval_policy,
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
    async def resume_thread(thread_id: str) -> dict[str, Any]:
        try:
            return await app_server.resume_thread(thread_id)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/turns")
    async def start_turn(thread_id: str, body: TurnRequest) -> dict[str, Any]:
        prompt = body.prompt.strip()
        if not prompt and not body.images:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请填写消息或附加图片")
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
            return {"turn_id": turn.get("id") if isinstance(turn, dict) else None}
        except CodexRuntimeError as error:
            for path in image_paths:
                with suppress(FileNotFoundError):
                    path.unlink()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/interrupt")
    async def interrupt_turn(thread_id: str) -> dict[str, bool]:
        try:
            await app_server.interrupt(thread_id)
            return {"interrupted": True}
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
