from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from codex_remote.app import PinRequest, PinsInitializeRequest, QueueMessageIdRequest, QueuedMessageRequest, create_app
from codex_remote.shared_state import QueueConflictError, SharedQueueService, SharedStateStore


def message(message_id: str, text: str) -> dict[str, object]:
    return {
        "id": message_id,
        "text": text,
        "requestText": text,
        "images": [],
        "documents": [],
        "createdAt": "2026-10-13T00:00:00Z",
    }


class SharedStateStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "shared.sqlite3"
        self.store = SharedStateStore(self.path)
        self.addCleanup(self.store.close)

    def test_ordered_queue_and_receipt_prevent_duplicate_after_delivery(self) -> None:
        first = message("queued-first", "first")
        second = message("queued-second", "second")
        self.assertTrue(self.store.enqueue("thread", first))
        self.assertTrue(self.store.enqueue("thread", second))
        self.assertFalse(self.store.enqueue("thread", first))
        self.assertEqual([item["id"] for item in self.store.queue("thread")], ["queued-first", "queued-second"])

        self.assertEqual(self.store.claim("thread", "queued-first"), first)
        self.store.delivered("thread", "queued-first", "turn-first", new_turn=True)
        self.assertFalse(self.store.enqueue("thread", first))
        self.assertEqual(self.store.barrier("thread"), "turn-first")
        self.assertEqual([item["id"] for item in self.store.queue("thread")], ["queued-second"])
        with self.assertRaises(QueueConflictError):
            self.store.enqueue("thread", message("queued-first", "different content"))

    def test_crash_after_claim_keeps_message_unverified(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.store.claim("thread", "queued-first")
        self.store.close()
        self.store = SharedStateStore(self.path)
        self.addCleanup(self.store.close)
        self.assertIsNotNone(self.store.queue("thread")[0]["sendAttempt"])
        self.assertIsNone(self.store.claim("thread", "queued-first"))

    def test_edit_blocks_claim_and_pins_are_shared(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.store.edit("thread", "queued-first", True, "owner-one")
        self.store.edit("thread", "queued-first", True, "owner-one")
        with self.assertRaises(QueueConflictError):
            self.store.edit("thread", "queued-first", True, "owner-two")
        self.assertIsNone(self.store.claim("thread", "queued-first"))
        updated = message("queued-first", "edited")
        self.store.update("thread", "queued-first", updated)
        self.assertTrue(self.store.queue("thread")[0]["editing"])
        self.store.edit("thread", "queued-first", False, "owner-one")
        self.assertEqual(self.store.claim("thread", "queued-first")["text"], "edited")

        self.assertEqual(self.store.initialize_pins(["thread-one"]), ["thread-one"])
        self.store.set_pin("thread-one", False)
        self.assertEqual(self.store.initialize_pins(["thread-one", "thread-two"]), [])
        self.store.set_pin("thread-two", True)
        self.assertEqual(self.store.pins(), ["thread-two"])


class SharedQueueServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = SharedStateStore(Path(self.directory.name) / "shared.sqlite3")
        self.addCleanup(self.store.close)
        self.codex = AsyncMock()
        self.codex.handed_off = False
        self.codex._active_turn_id.return_value = None
        self.codex.resume_thread.return_value = {"id": "thread"}
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "inProgress"}]}
        self.send = AsyncMock(side_effect=["turn-one", "turn-two"])
        self.service = SharedQueueService(self.store, self.codex, self.send)

    async def test_phone_can_sleep_while_service_advances_fifo_after_completion(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.store.enqueue("thread", message("queued-second", "second"))
        await self.service.advance("thread")
        self.send.assert_not_awaited()

        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "completed"}]}
        await self.service.advance("thread")
        self.assertEqual(self.send.await_args_list[0].args[:2], ("thread", message("queued-first", "first")))
        self.assertEqual(self.store.barrier("thread"), "turn-one")
        await self.service.advance("thread")
        self.assertEqual(self.send.await_count, 1)

        self.codex.read_thread.return_value = {"turns": [
            {"id": "original", "status": "completed"},
            {"id": "turn-one", "status": "completed"},
        ]}
        await self.service.advance("thread")
        self.assertEqual(self.send.await_count, 2)
        self.assertEqual(self.store.queue("thread"), [])

    async def test_interrupted_turn_and_active_edit_pause_queue(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "interrupted"}]}
        await self.service.advance("thread")
        self.send.assert_not_awaited()
        self.assertIn("未正常完成", self.store.queue("thread")[0]["blockedReason"])
        self.store.edit("thread", "queued-first", True)
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "completed"}]}
        await self.service.advance("thread")
        self.send.assert_not_awaited()
        self.store.edit("thread", "queued-first", False)
        await self.service.advance("thread")
        self.send.assert_awaited_once()

    async def test_unknown_delivery_is_not_retried(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex.read_thread.return_value = {"turns": []}
        self.send.side_effect = RuntimeError("connection lost after send")
        with self.assertLogs("codex_remote.shared_state", level="ERROR"):
            await self.service.advance("thread")
        await self.service.advance("thread")
        self.assertEqual(self.send.await_count, 1)
        self.assertIsNotNone(self.store.queue("thread")[0]["sendAttempt"])

    async def test_idle_submit_never_steers_a_running_turn(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex._active_turn_id.return_value = "running-turn"
        self.assertFalse(await self.service.send_now("thread", "queued-first", allow_steer=False, require_head=True))
        self.send.assert_not_awaited()
        self.assertEqual(len(self.store.queue("thread")), 1)

        self.codex._active_turn_id.return_value = None
        self.codex.read_thread.return_value = {"turns": [{"id": "stopped-turn", "status": "interrupted"}]}
        self.assertTrue(await self.service.send_now("thread", "queued-first", allow_steer=False, require_head=True))
        self.send.assert_awaited_once()
        self.assertFalse(self.send.await_args.args[2])

    async def test_concurrent_advances_claim_only_once(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex.read_thread.return_value = {"turns": []}
        entered = asyncio.Event()
        release = asyncio.Event()

        async def send(_thread: str, _payload: dict[str, object], _steer: bool) -> str:
            entered.set()
            await release.wait()
            return "turn-one"

        self.service.send = AsyncMock(side_effect=send)
        first = asyncio.create_task(self.service.advance("thread"))
        await asyncio.wait_for(entered.wait(), 1)
        second = asyncio.create_task(self.service.advance("thread"))
        release.set()
        await asyncio.gather(first, second)
        self.service.send.assert_awaited_once()

    async def test_background_worker_sends_without_any_browser_connection(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "completed"}]}
        self.codex.subscribe = AsyncMock(return_value=asyncio.Queue())
        self.codex.unsubscribe = Mock()
        self.service.start()
        try:
            for _ in range(100):
                if self.send.await_count:
                    break
                await asyncio.sleep(0.01)
            self.send.assert_awaited_once()
            self.assertEqual(self.store.queue("thread"), [])
        finally:
            await self.service.close()


class SharedQueueEndpointTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        with patch.dict(os.environ, {
            "CODEX_REMOTE_AUTH_FILE": str(root / "auth.json"),
            "CODEX_REMOTE_STATE_FILE": str(root / "state.sqlite3"),
        }):
            self.app = create_app(root)
        self.addCleanup(self.app.state.shared_state.close)

    def endpoint(self, path: str):
        return next(route.endpoint for route in self.app.routes if getattr(route, "path", None) == path)

    async def test_queue_edit_and_pin_endpoints_share_persisted_state(self) -> None:
        enqueue = self.endpoint("/api/v1/codex/queue/{thread_id}/enqueue")
        read = self.endpoint("/api/v1/codex/queue/{thread_id}")
        begin = self.endpoint("/api/v1/codex/queue/{thread_id}/edit/begin")
        update = self.endpoint("/api/v1/codex/queue/{thread_id}/edit/update")
        end = self.endpoint("/api/v1/codex/queue/{thread_id}/edit/end")
        remove = self.endpoint("/api/v1/codex/queue/{thread_id}/remove")
        body = QueuedMessageRequest(**message("queued-first", "first"))
        await enqueue("thread", body)
        self.assertEqual((await read("thread"))["queue"][0]["text"], "first")
        await begin("thread", QueueMessageIdRequest(message_id="queued-first"))
        await update("thread", QueuedMessageRequest(**message("queued-first", "edited")))
        await end("thread", QueueMessageIdRequest(message_id="queued-first"))
        self.assertEqual((await read("thread"))["queue"][0]["text"], "edited")
        await remove("thread", QueueMessageIdRequest(message_id="queued-first"))
        self.assertEqual((await read("thread"))["queue"], [])

        initialize = self.endpoint("/api/v1/codex/pins/initialize")
        set_pin = self.endpoint("/api/v1/codex/threads/{thread_id}/pin")
        read_pins = self.endpoint("/api/v1/codex/pins")
        await initialize(PinsInitializeRequest(thread_ids=["thread"]))
        self.assertEqual((await read_pins())["thread_ids"], ["thread"])
        await set_pin("thread", PinRequest(pinned=False))
        await initialize(PinsInitializeRequest(thread_ids=["thread"]))
        self.assertEqual((await read_pins())["thread_ids"], [])


if __name__ == "__main__":
    unittest.main()
