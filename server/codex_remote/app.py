from __future__ import annotations

import asyncio
import hmac
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from watchfiles import awatch

from .codex_app_server import CodexAppServer, CodexRuntimeError

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


class PairingAuth:
    def __init__(self) -> None:
        self.code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        self.tokens: set[str] = set()
        self.failed_attempts = 0
        self.blocked_until = 0.0

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
        self.tokens.add(token)
        return token

    def accepts(self, token: str | None) -> bool:
        if not token:
            return False
        return any(hmac.compare_digest(token, known) for known in self.tokens)


def create_app(workspace: Path | None = None, codex_command: str | None = None) -> FastAPI:
    project_root = Path(__file__).resolve().parents[2]
    configured_workspace = workspace or Path(os.environ.get("CODEX_REMOTE_WORKSPACE", project_root))
    app_server = CodexAppServer(
        codex_command or os.environ.get("CODEX_REMOTE_COMMAND", "codex"),
        configured_workspace,
    )
    auth = PairingAuth()

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

    app = FastAPI(title="Codex Remote", version="0.0.3", lifespan=lifespan)
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
        token = auth.pair(request.code)
        if token is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="配对码无效或尝试次数过多")
        return {"token": token}

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

    @app.post("/api/v1/codex/threads", status_code=status.HTTP_201_CREATED)
    async def create_thread() -> dict[str, Any]:
        try:
            return await app_server.start_thread()
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.get("/api/v1/codex/threads/{thread_id}")
    async def read_thread(thread_id: str) -> dict[str, Any]:
        try:
            return await app_server.read_thread(thread_id)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/resume")
    async def resume_thread(thread_id: str) -> dict[str, Any]:
        try:
            return await app_server.resume_thread(thread_id)
        except CodexRuntimeError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/api/v1/codex/threads/{thread_id}/turns")
    async def start_turn(thread_id: str, body: dict[str, Any]) -> dict[str, Any]:
        prompt = body.get("prompt")
        if not isinstance(prompt, str):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="prompt must be text")
        try:
            result = await app_server.start_turn(thread_id, prompt)
            turn = result.get("turn", {})
            return {"turn_id": turn.get("id") if isinstance(turn, dict) else None}
        except CodexRuntimeError as error:
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
