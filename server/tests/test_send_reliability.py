from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from code_remote.app import ResumeRequest, SteerRequest, TurnRequest, create_app
from code_remote.codex_app_server import CodexRuntimeError


class SendReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        workspace = Path(self.directory.name)
        images = workspace / "images"
        images.mkdir()
        with (
            patch.dict(os.environ, {"CODE_REMOTE_AUTH_FILE": str(workspace / "auth.json")}),
            patch("code_remote.app.tempfile.mkdtemp", return_value=str(images)),
        ):
            self.app = create_app(workspace)
        self.addCleanup(self.app.state.shared_state.close)
        self.addAsyncCleanup(self.app.state.claude_code.close)
        self.server = self.app.state.codex
        self.server.read_thread = AsyncMock(return_value={"cwd": str(workspace)})

    def endpoint(self, path: str):
        return next(route.endpoint for route in self.app.routes if getattr(route, "path", None) == path)

    async def test_compact_resume_does_not_return_or_cache_large_history(self) -> None:
        history = [{"id": "old-turn", "items": [{"text": "history" * 100_000}]}]
        original = {"id": "thread-one", "cwd": "/workspace", "turns": history}
        self.server.resume_thread = AsyncMock(return_value=original)
        resume = self.endpoint("/api/v1/codex/threads/{thread_id}/resume")
        body = ResumeRequest(request_id="resume-regression-001", include_history=False)

        result = await resume("thread-one", body)
        retry = await resume("thread-one", body)

        self.assertEqual(result, {"id": "thread-one", "cwd": "/workspace"})
        self.assertEqual(retry, result)
        self.assertIs(original["turns"], history)
        self.server.resume_thread.assert_awaited_once_with("thread-one", cwd=None)
        entry = next(iter(self.app.state.idempotent_requests._entries.values()))
        self.assertNotIn("turns", entry.task.result())

    async def test_legacy_resume_still_returns_history(self) -> None:
        original = {"id": "thread-one", "turns": [{"id": "old-turn"}]}
        self.server.resume_thread = AsyncMock(return_value=original)
        resume = self.endpoint("/api/v1/codex/threads/{thread_id}/resume")

        self.assertEqual(await resume("thread-one"), original)
        self.assertEqual(await resume("thread-one", ResumeRequest()), original)

    async def test_concurrent_send_retries_start_only_one_turn_and_emit_exact_receipt(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def start(*_args):
            entered.set()
            await release.wait()
            return {"turn": {"id": "turn-one"}}

        self.server.start_turn = AsyncMock(side_effect=start)
        queue = await self.server.subscribe()
        send = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")
        body = TurnRequest(prompt="继续", request_id="queued-regression-001")
        first = asyncio.create_task(send("thread-one", body))
        await asyncio.wait_for(entered.wait(), 1)
        second = asyncio.create_task(send("thread-one", body))
        await asyncio.sleep(0)
        release.set()

        self.assertEqual(await asyncio.gather(first, second), [{"turn_id": "turn-one"}] * 2)
        self.server.start_turn.assert_awaited_once()
        self.assertEqual(queue.get_nowait(), {
            "type": "turn.delivery",
            "request_id": "queued-regression-001",
            "params": {"threadId": "thread-one", "turnId": "turn-one"},
        })
        self.assertTrue(queue.empty())

    async def test_disconnected_http_request_still_emits_receipt_and_retains_success_for_retry(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def start(*_args):
            entered.set()
            await release.wait()
            return {"turn": {"id": "turn-one"}}

        self.server.start_turn = AsyncMock(side_effect=start)
        queue = await self.server.subscribe()
        send = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")
        body = TurnRequest(prompt="继续", request_id="queued-regression-001")
        first = asyncio.create_task(send("thread-one", body))
        await asyncio.wait_for(entered.wait(), 1)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()

        receipt = await asyncio.wait_for(queue.get(), 1)
        self.assertEqual(receipt["request_id"], body.request_id)
        self.assertEqual(receipt["params"], {"threadId": "thread-one", "turnId": "turn-one"})
        self.assertEqual(await send("thread-one", body), {"turn_id": "turn-one"})
        self.server.start_turn.assert_awaited_once()
        self.assertTrue(queue.empty())

    async def test_rejected_send_does_not_emit_a_delivery_receipt(self) -> None:
        self.server.start_turn = AsyncMock(side_effect=CodexRuntimeError("active writer"))
        queue = await self.server.subscribe()
        send = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")

        with self.assertRaises(HTTPException) as rejected:
            await send("thread-one", TurnRequest(prompt="继续", request_id="queued-regression-001"))

        self.assertEqual(rejected.exception.status_code, 503)
        self.assertTrue(queue.empty())

    async def test_steered_message_also_emits_an_exact_delivery_receipt(self) -> None:
        self.server.steer_turn = AsyncMock(return_value={"turnId": "turn-one"})
        queue = await self.server.subscribe()
        steer = self.endpoint("/api/v1/codex/threads/{thread_id}/steer")
        body = SteerRequest(prompt="补充要求", request_id="queued-steer-regression")

        self.assertEqual(await steer("thread-one", body), {"turn_id": "turn-one"})
        self.assertEqual(queue.get_nowait(), {
            "type": "turn.delivery",
            "request_id": body.request_id,
            "params": {"threadId": "thread-one", "turnId": "turn-one"},
        })

    def existing_queue_message(self) -> list[dict]:
        store = self.app.state.shared_state
        store.enqueue("thread-one", {
            "id": "already-queued-001", "text": "queued", "requestText": "queued",
            "images": [], "createdAt": "2026-11-06T00:00:00Z",
        })
        return store.queue("thread-one")

    async def test_direct_steer_preserves_queue_and_translated_original(self) -> None:
        original_queue = self.existing_queue_message()
        self.server.steer_turn = AsyncMock(return_value={"turnId": "turn-one"})
        steer = self.endpoint("/api/v1/codex/threads/{thread_id}/steer")
        body = SteerRequest(
            prompt="Check logs", translated_text="Check logs", original_text="检查日志",
            request_id="direct-steer-001", direct=True,
        )
        self.assertEqual(await steer("thread-one", body), {"turn_id": "turn-one"})
        self.assertEqual(await steer("thread-one", body), {"turn_id": "turn-one"})
        self.server.steer_turn.assert_awaited_once()
        self.assertEqual(self.app.state.shared_state.queue("thread-one"), original_queue)
        self.assertEqual(self.app.state.shared_state.translated_user_messages("thread-one"), [{
            "requestId": body.request_id, "turnId": "turn-one", "sentText": "Check logs", "originalText": "检查日志",
        }])

    async def test_direct_start_bypasses_queue_and_keeps_original_text(self) -> None:
        original_queue = self.existing_queue_message()
        self.server._active_turn_id = AsyncMock(return_value=None)
        self.server.start_turn = AsyncMock(return_value={"turn": {"id": "turn-new"}})
        start = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")
        body = TurnRequest(
            prompt="Check logs", translated_text="Check logs", original_text="检查日志",
            request_id="direct-start-001", direct=True,
        )
        self.assertEqual(await start("thread-one", body), {"turn_id": "turn-new"})
        self.assertEqual(self.app.state.shared_state.queue("thread-one"), original_queue)
        self.assertEqual(self.app.state.shared_state.translated_user_messages("thread-one")[0]["originalText"], "检查日志")

    async def test_direct_start_waits_for_queue_lock_and_rejects_a_busy_turn(self) -> None:
        original_queue = self.existing_queue_message()
        self.server._active_turn_id = AsyncMock(return_value="turn-busy")
        self.server.start_turn = AsyncMock()
        start = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")
        lock = self.app.state.shared_queue.delivery_lock("thread-one")
        await lock.acquire()
        try:
            pending = asyncio.create_task(start("thread-one", TurnRequest(prompt="urgent", request_id="direct-race-001", direct=True)))
            await asyncio.sleep(0.02)
            self.server._active_turn_id.assert_not_awaited()
        finally:
            lock.release()
        with self.assertRaises(HTTPException) as error:
            await pending
        self.assertEqual(error.exception.status_code, 409)
        self.server.start_turn.assert_not_awaited()
        self.assertEqual(self.app.state.shared_state.queue("thread-one"), original_queue)

    async def test_busy_claude_direct_start_does_not_queue_or_interrupt(self) -> None:
        thread_id = f"claude:{uuid.uuid4()}"
        claude = self.app.state.claude_code
        start = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")
        with patch.object(claude, "active_turn_id", AsyncMock(return_value="active")), patch.object(claude, "start_turn", AsyncMock()) as start_claude:
            with self.assertRaises(HTTPException) as error:
                await start(thread_id, TurnRequest(prompt="urgent", request_id="direct-claude-001", direct=True))
        self.assertEqual(error.exception.status_code, 409)
        start_claude.assert_not_awaited()
        self.assertEqual(self.app.state.shared_state.queue(thread_id), [])

    async def test_translation_metadata_failure_does_not_retry_an_accepted_steer(self) -> None:
        self.server.steer_turn = AsyncMock(return_value={"turnId": "turn-one"})
        steer = self.endpoint("/api/v1/codex/threads/{thread_id}/steer")
        body = SteerRequest(
            prompt="Check logs", translated_text="Check logs", original_text="检查日志",
            request_id="direct-metadata-001", direct=True,
        )
        with patch.object(self.app.state.shared_state, "record_translated_user_message", side_effect=OSError("storage")), self.assertLogs("code_remote.app", level="ERROR"):
            self.assertEqual(await steer("thread-one", body), {"turn_id": "turn-one"})
            self.assertEqual(await steer("thread-one", body), {"turn_id": "turn-one"})
        self.server.steer_turn.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
