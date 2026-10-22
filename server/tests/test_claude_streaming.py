from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from codex_remote.claude_code import ClaudeCodeServer


class ControlledOutput:
    def __init__(self) -> None:
        self.lines: asyncio.Queue[bytes] = asyncio.Queue()
        self.waiting = asyncio.Event()

    async def readline(self) -> bytes:
        self.waiting.set()
        line = await self.lines.get()
        self.waiting.clear()
        return line

    async def send(self, record: dict) -> None:
        self.waiting.clear()
        await self.lines.put(json.dumps(record).encode() + b"\n")
        # Reaching the next read proves this record has been handled. The
        # process remains open, so no test can pass by waiting for result/EOF.
        await asyncio.wait_for(self.waiting.wait(), 1)


class FakeProcess:
    def __init__(self) -> None:
        self.stdout = ControlledOutput()
        self.stdin = None
        self.returncode = None

    async def wait(self) -> int:
        self.returncode = 0
        return 0


class ClaudeStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        workspace = Path(self.directory.name)
        self.events: list[dict] = []

        async def emit(event: dict) -> None:
            self.events.append(event)

        self.server = ClaudeCodeServer(sys.executable, workspace, workspace / "claude.sqlite3", emit)
        self.process = FakeProcess()
        self.spawn = patch("codex_remote.claude_code.asyncio.create_subprocess_exec", AsyncMock(return_value=self.process))
        self.spawn.start()
        self.addCleanup(self.spawn.stop)
        self.thread = await self.server.create_thread()
        self.turn_id = await self.server.start_turn(self.thread["id"], "hello")
        await asyncio.wait_for(self.process.stdout.waiting.wait(), 1)
        self.events.clear()

    async def asyncTearDown(self) -> None:
        await self.process.stdout.lines.put(b"")
        await asyncio.wait_for(asyncio.gather(*tuple(self.server._tasks.values())), 2)
        await self.server.close()

    async def event(self, event: dict) -> None:
        await self.process.stdout.send({"type": "stream_event", "event": event})

    async def message(self, message_id: str, text: str, *, record_id: str | None = None) -> None:
        await self.process.stdout.send({
            "type": "assistant", "uuid": record_id or str(uuid.uuid4()),
            "message": {"id": message_id, "content": [{"type": "text", "text": text}]},
        })

    def visible_text(self) -> str:
        text = ""
        for event in self.events:
            if event.get("method") == "item/agentMessage/delta":
                text += event["params"]["delta"]
            elif event.get("method") == "item/completed" and event["params"]["item"]["type"] == "agentMessage":
                text = event["params"]["item"]["text"]
        return text

    async def test_running_history_never_marks_turn_completed(self) -> None:
        history = await self.server.read_thread(self.thread["id"])
        self.assertEqual(history["status"]["type"], "active")
        self.assertEqual(history["turns"][-1]["status"], "inProgress")
        self.assertNotIn("completedAt", history["turns"][-1])

    async def test_reconnect_history_contains_received_text_while_cli_is_still_open(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        await self.event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "already visible"}})
        history = await self.server.read_thread(self.thread["id"])
        items = history["turns"][-1]["items"]
        self.assertEqual([item["text"] for item in items if item["type"] == "agentMessage"], ["already visible"])
        self.assertEqual(history["turns"][-1]["status"], "inProgress")

    async def test_full_assistant_text_is_emitted_before_result(self) -> None:
        await self.message("reply-1", "ready before the CLI finishes")
        self.assertEqual(self.visible_text(), "ready before the CLI finishes")
        self.assertIsNone(self.process.returncode)

    async def test_nonempty_content_block_start_is_visible_immediately(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        await self.event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "initial "}})
        await self.event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "answer"}})
        await self.message("reply-1", "initial answer")
        self.assertEqual(self.visible_text(), "initial answer")

    async def test_partial_and_full_records_do_not_duplicate_and_next_reply_is_not_lost(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        await self.event({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "First "}})
        await self.message("reply-1", "First reply.", record_id="snapshot-1")
        await self.message("reply-1", "First reply.", record_id="snapshot-1")
        await self.process.stdout.send({"type": "assistant", "message": {"id": "tool-message", "content": [
            {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "sample.txt"}},
        ]}})
        await self.message("reply-2", "Second reply.")
        await self.process.stdout.send({"type": "result", "result": "Second reply.", "is_error": False})
        self.assertEqual(self.visible_text(), "First reply.\n\nSecond reply.")
        self.assertTrue(any(event.get("method") == "item/started" for event in self.events))

    async def test_repeated_words_in_distinct_messages_are_preserved(self) -> None:
        await self.message("reply-1", "Done.")
        await self.message("reply-2", "Done.")
        self.assertEqual(self.visible_text(), "Done.\n\nDone.")

    async def test_result_repairs_a_missing_tail_without_repeating_partial_text(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        await self.event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}})
        await self.process.stdout.send({"type": "result", "result": "Hello world", "is_error": False})
        self.assertEqual(self.visible_text(), "Hello world")
        await self.process.stdout.lines.put(b"")
        await asyncio.wait_for(asyncio.gather(*tuple(self.server._tasks.values())), 2)
        history = await self.server.read_thread(self.thread["id"])
        self.assertEqual(history["turns"][-1]["status"], "completed")
        self.assertEqual(history["turns"][-1]["items"][-1]["text"], "Hello world")
        self.assertNotIn(self.thread["id"], self.server._live_replies)

    async def test_multiple_text_blocks_and_subagent_events_keep_main_reply_in_order(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        for index, text in [(1, "First paragraph."), (3, "Second paragraph.")]:
            await self.event({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})
            await self.event({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}})
            await self.message("reply-1", text)
        await self.process.stdout.send({
            "type": "assistant", "parent_tool_use_id": "subagent",
            "message": {"id": "nested-reply", "content": [{"type": "text", "text": "internal output"}]},
        })
        self.assertEqual(self.visible_text(), "First paragraph.\n\nSecond paragraph.")

    async def test_completed_blocks_and_trimmed_result_do_not_duplicate_text(self) -> None:
        await self.event({"type": "message_start", "message": {"id": "reply-1"}})
        await self.message("reply-1", "Same paragraph.")
        await self.event({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})
        await self.message("reply-1", "Same paragraph.\n")
        await self.process.stdout.send({"type": "result", "result": "Same paragraph.\n\nSame paragraph.", "is_error": False})
        self.assertEqual(self.visible_text(), "Same paragraph.\n\nSame paragraph.\n")


class ClaudeNativeRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        workspace = Path(self.directory.name)
        self.emit = AsyncMock()
        self.server = ClaudeCodeServer(sys.executable, workspace, workspace / "claude.sqlite3", self.emit)
        self.addAsyncCleanup(self.server.close)

    async def test_native_change_emits_targeted_history_notification(self) -> None:
        session_id = str(uuid.uuid4())
        session = {
            "thread_id": f"claude:{session_id}", "session_id": session_id, "name": "sample",
            "preview": "reply", "cwd": str(self.server.workspace),
            "created_at": "2026-10-22T00:00:00Z", "updated_at": "2026-10-22T00:00:01Z",
            "messages_json": "[]", "native_source": "/native/session.jsonl", "native_mtime_ns": 123,
        }
        with patch("codex_remote.claude_code.scan_native_sessions", return_value=[session]):
            await self.server.refresh_native_threads()
        changes = [call.args[0] for call in self.emit.await_args_list if call.args[0]["type"] == "thread.history.changed"]
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["threadId"], session["thread_id"])
        history = await self.server.read_thread(session["thread_id"])
        self.assertEqual(changes[0]["revision"], history["historyRevision"])

    async def test_change_during_throttle_is_deferred_instead_of_dropped(self) -> None:
        self.server._next_native_scan_at = time.monotonic() + 0.02
        with patch("codex_remote.claude_code.scan_native_sessions", return_value=[]) as scan:
            self.server.schedule_native_refresh()
            await asyncio.wait_for(self.server._native_refresh_task, 1)
        scan.assert_called_once()

    async def test_change_during_scan_gets_a_trailing_refresh(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def refresh() -> None:
            entered.set()
            await release.wait()

        with patch.object(self.server, "refresh_native_threads", AsyncMock(side_effect=refresh)) as refresh_mock:
            self.server.schedule_native_refresh()
            await asyncio.wait_for(entered.wait(), 1)
            self.server.schedule_native_refresh()
            release.set()
            await asyncio.wait_for(self.server._native_refresh_task, 1)
        self.assertEqual(refresh_mock.await_count, 2)


if __name__ == "__main__":
    unittest.main()
