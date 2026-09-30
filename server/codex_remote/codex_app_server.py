from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class CodexRuntimeError(RuntimeError):
    pass


class CodexAppServer:
    """Long-lived stdio JSON-RPC connection to the local Codex app-server."""

    def __init__(self, command: str, workspace: Path) -> None:
        self.command = command
        self.workspace = workspace.expanduser().resolve()
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._request_id = 1
        self._pending: dict[str | int, asyncio.Future[dict[str, Any]]] = {}
        self._server_requests: dict[str | int, dict[str, Any]] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._initialized = False

    @property
    def connected(self) -> bool:
        return self._initialized and self._process is not None and self._process.returncode is None

    def status(self) -> dict[str, Any]:
        return {
            "available": shutil.which(self.command) is not None,
            "connected": self.connected,
            "workspace": str(self.workspace),
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

    async def connect(self) -> dict[str, Any]:
        await self._ensure_started()
        return self.status()

    async def list_threads(self) -> list[dict[str, Any]]:
        result = await self.request("thread/list", {"limit": 100})
        items = result.get("data", result.get("threads", []))
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    async def read_thread(self, thread_id: str) -> dict[str, Any]:
        result = await self.request("thread/read", {"threadId": thread_id, "includeTurns": True})
        thread = result.get("thread")
        if not isinstance(thread, dict):
            raise CodexRuntimeError("Codex 没有返回该对话内容")
        return thread

    async def list_models(self) -> list[dict[str, Any]]:
        result = await self.request("model/list", {"limit": 100, "includeHidden": False})
        models = result.get("data", [])
        return [model for model in models if isinstance(model, dict)] if isinstance(models, list) else []

    async def start_thread(self, model: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(self.workspace),
            "serviceName": "codex_remote_web",
        }
        if model:
            params["model"] = model
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

    async def start_turn(
        self,
        thread_id: str,
        prompt: str,
        image_paths: list[Path] | None = None,
        model: str | None = None,
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
        return await self.request("turn/start", params)

    async def interrupt(self, thread_id: str) -> dict[str, Any]:
        return await self.request("turn/interrupt", {"threadId": thread_id})

    async def answer_server_request(self, request_id: str | int, decision: str) -> None:
        if request_id not in self._server_requests:
            raise CodexRuntimeError("该审批请求已过期或已处理")
        if decision not in {"accept", "decline", "cancel"}:
            raise CodexRuntimeError("不支持的审批操作")
        self._server_requests.pop(request_id, None)
        await self._write({"id": request_id, "result": {"decision": decision}})

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_started()
        return await self._request(method, params, timeout=90)

    async def close(self) -> None:
        process = self._process
        self._initialized = False
        if process is None:
            return
        self._server_requests.clear()
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
        async with self._start_lock:
            if self.connected:
                return
            await self._stop_process()
            executable = shutil.which(self.command)
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
                        "version": "0.0.16",
                    },
                    "capabilities": {
                        "experimentalApi": False,
                        "requestAttestation": False,
                    },
                }, timeout=20)
                await self._write({"method": "initialized", "params": {}})
                self._initialized = True
                await self._emit({"type": "connection", "connected": True, "workspace": str(self.workspace)})
            except Exception as error:
                await self._stop_process()
                if isinstance(error, CodexRuntimeError):
                    raise
                raise CodexRuntimeError(f"Codex app-server 初始化失败：{error}") from error

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
                await self._emit({"type": "connection", "connected": False, "error": "Codex app-server 已断开"})

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
            await self._emit({"type": "notification", "method": method, "params": message.get("params", {})})

    async def _emit(self, event: dict[str, Any]) -> None:
        for queue in tuple(self._subscribers):
            queue.put_nowait(event)

    def _fail_pending(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexRuntimeError(message))

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
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        await self._cancel_io_tasks()
        self._fail_pending("Codex app-server 正在重启")
