from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from codex_remote.app import ResumeRequest, SteerRequest, TurnRequest, create_app
from codex_remote.codex_app_server import CodexRuntimeError


class SendReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        workspace = Path(self.directory.name)
        images = workspace / "images"
        images.mkdir()
        with (
            patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(workspace / "auth.json")}),
            patch("codex_remote.app.tempfile.mkdtemp", return_value=str(images)),
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


if __name__ == "__main__":
    unittest.main()
