from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from codex_remote.app import PinRequest, PinsInitializeRequest, QueueMessageIdRequest, QueuedMessageRequest, create_app
from codex_remote.codex_app_server import CodexAppServer, CodexRuntimeError
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

    def test_sqlite_permissions_follow_the_host_platform(self) -> None:
        self.store.close()
        with patch("codex_remote.shared_state.os.chmod") as chmod:
            self.store = SharedStateStore(self.path)
        self.addCleanup(self.store.close)
        if os.name == "nt":
            chmod.assert_not_called()
        else:
            chmod.assert_called_once_with(self.path, 0o600)

    def test_crash_after_claim_keeps_message_unverified(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.store.claim("thread", "queued-first")
        self.store.close()
        self.store = SharedStateStore(self.path)
        self.addCleanup(self.store.close)
        self.assertIsNotNone(self.store.queue("thread")[0]["sendAttempt"])
        self.assertIsNone(self.store.claim("thread", "queued-first"))

    def test_restart_before_claim_restores_submission_as_safe_pending(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"), submitting=True)
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "submitting")
        self.assertNotIn("sendAttempt", self.store.queue("thread")[0])
        self.store.close()
        self.store = SharedStateStore(self.path)
        self.addCleanup(self.store.close)
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "pending")
        self.assertIsNotNone(self.store.claim("thread", "queued-first"))

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

    async def test_paused_codex_continues_without_user_message_before_queue(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.codex.start_turn.return_value = {"turn": {"id": "continued-turn"}}
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "interrupted"}]}

        self.assertTrue(await self.service.pause_thread("thread", "original"))
        self.assertTrue(self.store.is_paused("thread"))
        await self.service.advance("thread")
        self.send.assert_not_awaited()

        self.assertEqual(await self.service.continue_paused("thread"), "continued-turn")
        self.codex.start_turn.assert_awaited_once_with("thread", "", allow_empty=True)
        self.send.assert_not_awaited()
        self.assertFalse(self.store.is_paused("thread"))
        self.assertEqual(self.store.barrier("thread"), "continued-turn")
        self.assertEqual([item["id"] for item in self.store.queue("thread")], ["queued-first"])

        self.codex.read_thread.return_value = {"turns": [{"id": "continued-turn", "status": "completed"}]}
        await self.service.advance("thread")
        self.send.assert_awaited_once()

    async def test_second_stop_clears_pause_without_sending_queue(self) -> None:
        self.store.enqueue("thread", message("queued-first", "first"))
        self.store.set_paused("thread", True)
        self.codex.read_thread.return_value = {"turns": [{"id": "original", "status": "interrupted"}]}

        await self.service.stop_thread("thread")
        self.assertFalse(self.store.is_paused("thread"))
        await self.service.advance("thread")
        self.send.assert_not_awaited()
        self.assertIn("未正常完成", self.store.queue("thread")[0]["blockedReason"])

    async def test_stop_racing_with_continuation_interrupts_new_turn(self) -> None:
        self.store.set_paused("thread", True)
        self.codex.start_turn.return_value = {"turn": {"id": "continued-turn"}}
        await self.service.continue_paused("thread")
        self.codex._active_turn_id.return_value = "continued-turn"

        await self.service.stop_thread("thread")
        self.codex.interrupt.assert_awaited_once_with("thread", "continued-turn")
        self.assertFalse(self.store.is_paused("thread"))

    async def test_failed_continuation_can_retry_but_success_cannot_duplicate(self) -> None:
        self.store.set_paused("thread", True)
        self.codex.start_turn.side_effect = [RuntimeError("engine unavailable"), {"turn": {"id": "continued-turn"}}]

        with self.assertRaisesRegex(RuntimeError, "engine unavailable"):
            await self.service.continue_paused("thread")
        self.assertTrue(self.store.is_paused("thread"))
        self.assertEqual(await self.service.continue_paused("thread"), "continued-turn")
        with self.assertRaises(QueueConflictError):
            await self.service.continue_paused("thread")
        self.assertEqual(self.codex.start_turn.await_count, 2)

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

    async def test_submission_queues_an_active_turn_on_every_platform(self) -> None:
        self.codex.read_thread.return_value = {"status": {"type": "inProgress"}}
        self.codex._active_turn_id.return_value = "running-turn"

        self.assertFalse(await self.service.submit("thread", message("queued-next", "send this next")))

        self.assertEqual([item["id"] for item in self.store.queue("thread")], ["queued-next"])
        self.send.assert_not_awaited()

    async def test_idle_submission_is_never_published_as_waiting(self) -> None:
        deciding = asyncio.Event()
        release_decision = asyncio.Event()
        sending = asyncio.Event()
        release_send = asyncio.Event()
        snapshots: list[list[str]] = []

        async def read_thread(*_args: object, **_kwargs: object) -> dict[str, object]:
            deciding.set()
            await release_decision.wait()
            return {"id": "thread", "status": {"type": "idle"}}

        async def send(*_args: object) -> str:
            sending.set()
            await release_send.wait()
            return "new-turn"

        async def record_event(_event: object) -> None:
            snapshots.append([item["deliveryState"] for item in self.store.queue("thread")])

        self.codex.read_thread.side_effect = read_thread
        self.codex._emit.side_effect = record_event
        self.service.send.side_effect = send
        submit = asyncio.create_task(self.service.submit("thread", message("direct", "send directly")))
        await asyncio.wait_for(deciding.wait(), 1)
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "submitting")
        worker = asyncio.create_task(self.service.advance("thread"))
        release_decision.set()
        await asyncio.wait_for(sending.wait(), 1)
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "sending")
        release_send.set()
        self.assertTrue(await submit)
        await worker

        self.assertTrue(snapshots)
        self.assertTrue(all("pending" not in snapshot for snapshot in snapshots))
        self.assertEqual(self.store.queue("thread"), [])
        self.codex.read_thread.assert_awaited_once_with("thread", include_turns=False)
        self.codex.resume_thread.assert_not_awaited()
        self.service.send.assert_awaited_once()

    async def test_confirmed_idle_clears_stale_active_id_and_starts_directly(self) -> None:
        codex = CodexAppServer("codex", Path(self.directory.name))
        codex._active_turn_ids["thread"] = "already-completed"
        codex.request = AsyncMock(return_value={"thread": {"id": "thread", "status": {"type": "idle"}}})
        service = SharedQueueService(self.store, codex, self.send)

        self.assertTrue(await service.submit("thread", message("direct", "new message")))
        self.assertIsNone(await codex._active_turn_id("thread"))
        codex.request.assert_awaited_once_with("thread/read", {"threadId": "thread", "includeTurns": False})
        self.send.assert_awaited_once()

    async def test_busy_summary_stays_pending_without_loading_history(self) -> None:
        self.codex.read_thread.return_value = {"status": {"type": "active"}}
        self.assertFalse(await self.service.submit("thread", message("wait", "wait for reply")))
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "pending")
        self.codex.read_thread.assert_awaited_once_with("thread", include_turns=False)
        self.send.assert_not_awaited()

    async def test_unknown_runtime_state_is_not_treated_as_idle(self) -> None:
        self.codex.read_thread.return_value = {"status": {"type": "systemError"}}
        self.assertFalse(await self.service.submit("thread", message("wait", "confirm state first")))
        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "pending")
        self.assertIn("等待确认", self.store.queue("thread")[0]["blockedReason"])
        self.send.assert_not_awaited()

    async def test_not_loaded_thread_is_resumed_before_claiming(self) -> None:
        self.codex.read_thread.side_effect = [
            {"status": {"type": "notLoaded"}},
            {"status": {"type": "idle"}},
        ]

        async def resume(_thread_id: str) -> dict[str, object]:
            self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "submitting")
            return {"id": "thread"}

        self.codex.resume_thread.side_effect = resume
        self.assertTrue(await self.service.submit("thread", message("direct", "new message")))
        self.codex.resume_thread.assert_awaited_once_with("thread")
        self.codex.read_thread.assert_has_awaits([
            unittest.mock.call("thread", include_turns=False),
            unittest.mock.call("thread", include_turns=False),
        ])

    async def test_not_loaded_thread_that_resumes_as_busy_stays_queued(self) -> None:
        self.codex.read_thread.side_effect = [
            {"status": {"type": "notLoaded"}},
            {"status": {"type": "inProgress"}},
        ]
        self.codex._active_turn_id.side_effect = [None, "live-turn"]

        self.assertFalse(await self.service.submit("thread", message("wait", "wait for current reply")))

        self.assertEqual(self.store.queue("thread")[0]["deliveryState"], "pending")
        self.service.send.assert_not_awaited()

    async def test_concurrent_submit_retry_and_worker_do_not_duplicate(self) -> None:
        self.codex.read_thread.return_value = {"status": {"type": "idle"}}
        payload = message("direct", "same submission")
        first, second, _ = await asyncio.gather(
            self.service.submit("thread", payload),
            self.service.submit("thread", payload),
            self.service.advance("thread"),
        )
        self.assertTrue(first and second)
        self.send.assert_awaited_once()

    async def test_unknown_delivery_is_visible_and_blocks_later_submission(self) -> None:
        self.codex.read_thread.return_value = {"status": {"type": "idle"}}
        self.send.side_effect = RuntimeError("lost acknowledgement")
        with self.assertLogs("codex_remote.shared_state", level="ERROR"):
            self.assertFalse(await self.service.submit("thread", message("first", "may have arrived")))
        self.assertFalse(await self.service.submit("thread", message("second", "must not overtake")))
        queue = self.store.queue("thread")
        self.assertEqual([item["deliveryState"] for item in queue], ["unverified", "pending"])
        self.assertIn("sendAttempt", queue[0])
        self.send.assert_awaited_once()

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
        self.addAsyncCleanup(self.app.state.claude_code.close)
        self.app.state.codex.read_thread = AsyncMock(return_value={"status": {"type": "idle"}})

    def endpoint(self, path: str):
        return next(route.endpoint for route in self.app.routes if getattr(route, "path", None) == path)

    async def test_continue_endpoint_accepts_empty_codex_request(self) -> None:
        continue_turn = self.endpoint("/api/v1/codex/threads/{thread_id}/continue")
        codex = self.app.state.codex
        codex._active_turn_id = AsyncMock(return_value=None)
        codex.resume_thread = AsyncMock(return_value={"id": "thread"})
        codex.start_turn = AsyncMock(return_value={"turn": {"id": "continued-turn"}})
        self.app.state.shared_state.set_paused("thread", True)

        result = await continue_turn("thread", None)

        self.assertEqual(result, {"continued": True, "turn_id": "continued-turn", "queue": []})
        codex.start_turn.assert_awaited_once_with("thread", "", allow_empty=True)

    async def test_stop_endpoint_clears_paused_state(self) -> None:
        stop = self.endpoint("/api/v1/codex/threads/{thread_id}/stop")
        self.app.state.codex._active_turn_id = AsyncMock(return_value=None)
        self.app.state.shared_state.set_paused("thread", True)

        self.assertEqual(await stop("thread"), {"stopped": True})
        self.assertFalse(self.app.state.shared_state.is_paused("thread"))

    async def test_idle_submit_starts_immediately_and_retry_does_not_send_twice(self) -> None:
        submit = self.endpoint("/api/v1/codex/queue/{thread_id}/submit")
        codex = self.app.state.codex
        codex._active_turn_id = AsyncMock(return_value=None)
        codex.read_thread = AsyncMock(return_value={"turns": [{"id": "previous", "status": "completed"}]})
        codex.resume_thread = AsyncMock(return_value={"id": "thread"})
        self.app.state.shared_queue.send = AsyncMock(return_value="new-turn")
        body = QueuedMessageRequest(**message("queued-idle", "send directly"))

        first = await submit("thread", body)
        retry = await submit("thread", body)

        self.assertEqual(first, {"sent": True, "queue": []})
        self.assertEqual(retry, first)
        self.app.state.shared_queue.send.assert_awaited_once()
        self.assertFalse(self.app.state.shared_queue.send.await_args.args[2])

    async def test_paused_idle_claude_new_submit_clears_pause_and_sends(self) -> None:
        submit = self.endpoint("/api/v1/codex/queue/{thread_id}/submit")
        claude = self.app.state.claude_code
        claude._active_turn_id = AsyncMock(return_value=None)
        claude.active_turn_id = AsyncMock(return_value=None)
        claude.read_thread = AsyncMock(return_value={
            "status": {"type": "idle"},
            "turns": [{"id": "stopped-turn", "status": "stopped"}],
        })
        self.app.state.shared_state.set_paused("claude:12345678-1234-4234-8234-123456789abc", True)
        self.app.state.shared_state.set_barrier("claude:12345678-1234-4234-8234-123456789abc", "stopped-turn")
        self.app.state.shared_queue.send = AsyncMock(return_value="fresh-turn")

        result = await submit(
            "claude:12345678-1234-4234-8234-123456789abc",
            QueuedMessageRequest(**message("claude-after-stop", "send now")),
        )

        self.assertTrue(result["sent"])
        self.assertEqual(result["queue"], [])
        self.assertFalse(self.app.state.shared_state.is_paused("claude:12345678-1234-4234-8234-123456789abc"))
        self.app.state.shared_queue.send.assert_awaited_once()

    async def test_busy_submit_and_later_messages_preserve_fifo(self) -> None:
        submit = self.endpoint("/api/v1/codex/queue/{thread_id}/submit")
        codex = self.app.state.codex
        codex._active_turn_id = AsyncMock(return_value="running-turn")
        self.app.state.shared_queue.send = AsyncMock(return_value="new-turn")

        first = await submit("thread", QueuedMessageRequest(**message("queued-first", "first")))
        codex._active_turn_id.return_value = None
        second = await submit("thread", QueuedMessageRequest(**message("queued-second", "second")))

        self.assertFalse(first["sent"])
        self.assertFalse(second["sent"])
        self.assertEqual([item["id"] for item in second["queue"]], ["queued-first", "queued-second"])
        self.app.state.shared_queue.send.assert_not_awaited()

    async def test_submit_does_not_skip_an_edited_queue_head(self) -> None:
        submit = self.endpoint("/api/v1/codex/queue/{thread_id}/submit")
        store = self.app.state.shared_state
        store.enqueue("thread", message("queued-first", "being edited"))
        store.edit("thread", "queued-first", True, "owner-one")
        self.app.state.shared_queue.send = AsyncMock(return_value="new-turn")

        result = await submit("thread", QueuedMessageRequest(**message("queued-second", "later")))

        self.assertFalse(result["sent"])
        self.assertEqual([item["id"] for item in result["queue"]], ["queued-first", "queued-second"])
        self.app.state.shared_queue.send.assert_not_awaited()

    async def test_unavailable_codex_keeps_submitted_message_durable(self) -> None:
        submit = self.endpoint("/api/v1/codex/queue/{thread_id}/submit")
        self.app.state.codex._active_turn_id = AsyncMock(side_effect=CodexRuntimeError("temporarily offline"))
        body = QueuedMessageRequest(**message("queued-offline", "wait safely"))

        result = await submit("thread", body)

        self.assertFalse(result["sent"])
        self.assertEqual([item["id"] for item in result["queue"]], ["queued-offline"])

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
