from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.middleware.gzip import GZipMiddleware

from codex_remote.app import create_app
from codex_remote.browser_payload import browser_event, browser_item, browser_thread, browser_thread_summary


class BrowserPayloadTests(unittest.TestCase):
    def test_history_discards_duplicate_tool_output_but_keeps_visible_content(self) -> None:
        output = "tool output\n" * 100_000
        message = {"id": "user", "type": "userMessage", "content": [
            {"type": "text", "text": "正文和文档附件"},
            {"type": "localImage", "data": "image-data", "mediaType": "image/png"},
        ]}
        diff = [{"path": "/workspace/file.py", "diff": "-before\n+after", "additions": 1, "deletions": 1}]
        original = {"id": "thread", "turns": [{"id": "turn", "status": "completed", "items": [
            message,
            {"id": "reasoning", "type": "reasoning", "summary": ["large historical reasoning"]},
            {"id": "command", "type": "commandExecution", "command": "cat file.py", "status": "completed",
             "stdout": output, "aggregated_output": output, "formatted_output": output},
            {"id": "edit", "type": "fileChange", "status": "completed", "changes": diff},
            {"id": "reply", "type": "agentMessage", "text": "完整回复", "content": [{"text": "完整回复"}]},
        ]}], "codexRemoteWorkspaceChanges": {"turn": diff}}
        result = browser_thread(original)
        items = result["turns"][0]["items"]
        self.assertEqual(items[0], message)
        self.assertNotIn("reasoning", [item["type"] for item in items])
        self.assertEqual(items[1]["command"], "cat file.py")
        self.assertEqual(items[2]["changes"], diff)
        self.assertEqual(items[3]["text"], "完整回复")
        self.assertEqual(result["codexRemoteWorkspaceChanges"], {"turn": diff})
        self.assertLess(len(json.dumps(result)), 1_500)
        original_command = next(item for item in original["turns"][0]["items"] if item.get("type") == "commandExecution")
        self.assertEqual(original_command["stdout"], output)

    def test_tool_paths_survive_without_sending_large_arguments_or_results(self) -> None:
        item = {"type": "mcpToolCall", "id": "tool", "server": "files", "tool": "write_file", "status": "completed",
                "arguments": {"file_path": "/workspace/file.py", "content": "a" * 2_000_000},
                "result": {"content": "b" * 2_000_000}}
        result = browser_item(item)
        self.assertEqual(result["arguments"], {"paths": [{"path": "/workspace/file.py"}]})
        self.assertEqual(result["tool"], "write_file")
        self.assertLess(len(json.dumps(result)), 300)

    def test_completed_turn_does_not_resend_every_item(self) -> None:
        event = {"type": "notification", "method": "turn/completed", "params": {"threadId": "background", "turn": {
            "id": "turn", "status": "completed", "completedAt": 123,
            "items": [{"type": "commandExecution", "stdout": "x" * 2_000_000}],
        }}}
        result = browser_event(event, thread_id="current", filter_thread=True)
        self.assertEqual(result["params"]["turn"], {"id": "turn", "status": "completed", "completedAt": 123})
        self.assertLess(len(json.dumps(result)), 250)

    def test_unused_deltas_and_background_details_are_not_transmitted(self) -> None:
        unused = {"type": "notification", "method": "item/commandExecution/outputDelta", "params": {"delta": "x" * 1_000_000}}
        self.assertIsNone(browser_event(unused))
        reply = {"type": "notification", "method": "item/agentMessage/delta", "params": {
            "threadId": "current", "turnId": "turn", "itemId": "reply", "delta": "完整增量",
        }}
        self.assertEqual(browser_event(reply, thread_id="current", filter_thread=True), reply)
        self.assertIsNone(browser_event(reply, thread_id="elsewhere", filter_thread=True))
        self.assertIsNone(browser_event(reply, thread_id=None, filter_thread=True))
        self.assertEqual(browser_event(reply), reply, "older clients retain compatible routing")

    def test_approval_and_delivery_receipts_are_preserved(self) -> None:
        for event in [
            {"type": "server_request", "request_id": 7, "method": "item/fileChange/requestApproval", "params": {"changes": "review me"}},
            {"type": "turn.delivery", "request_id": "message", "params": {"threadId": "other", "turnId": "turn"}},
        ]:
            self.assertEqual(browser_event(event, filter_thread=True), event)

    def test_list_summary_is_bounded_and_never_carries_turns(self) -> None:
        result = browser_thread_summary({"id": "thread", "name": "长" * 10_000, "preview": "文" * 1_000_000,
                                         "updatedAt": 123, "historyPartial": True, "historyWindowed": True,
                                         "totalTurns": 321,
                                         "turns": [{"items": ["large"]}]})
        self.assertNotIn("turns", result)
        self.assertLessEqual(len(result["name"]), 240)
        self.assertLessEqual(len(result["preview"]), 400)
        self.assertEqual(result["updatedAt"], 123)
        self.assertTrue(result["historyPartial"])
        self.assertTrue(result["historyWindowed"])
        self.assertEqual(result["totalTurns"], 321)


class BrowserEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_and_list_endpoints_project_payload_and_capture_revision_before_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            images = workspace / "images"
            images.mkdir()
            with patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(workspace / "auth.json")}), \
                 patch("codex_remote.app.tempfile.mkdtemp", return_value=str(images)):
                app = create_app(workspace)
            try:
                server = app.state.codex
                revision = ["before"]
                server.thread_history_revision = lambda _thread_id: revision[0]
                image_path = images / "message.png"
                image_path.write_bytes(b"history-image")
                original = {"id": "thread", "preview": "p" * 1_000, "turns": [
                    {"id": "turn", "items": [
                        {"id": "command", "type": "commandExecution", "command": "pwd", "stdout": "x" * 1_000_000},
                        {"id": "user", "type": "userMessage", "content": [
                            {"type": "localImage", "path": str(image_path), "mediaType": "image/png"},
                        ]},
                    ]},
                    {"id": "latest", "items": [{"id": "reply", "type": "agentMessage", "text": "最新回复"}]},
                ]}

                async def read(_thread_id, **_kwargs):
                    revision[0] = "after"
                    return original

                server.read_thread = read
                server.list_threads = AsyncMock(return_value=[original])
                # Several routes share a path; select the GET endpoint explicitly.
                read_endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", "") == "/api/v1/codex/threads/{thread_id}" and "GET" in route.methods)
                list_endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", "") == "/api/v1/codex/threads" and "GET" in route.methods)
                result = await read_endpoint("thread")
                self.assertEqual(result["historyRevision"], "before")
                self.assertNotIn("stdout", result["turns"][0]["items"][0])
                self.assertEqual(result["turns"][0]["items"][1]["content"][0]["data"], "aGlzdG9yeS1pbWFnZQ==")
                lightweight = await read_endpoint("thread", include_images=False)
                self.assertNotIn("data", lightweight["turns"][0]["items"][1]["content"][0])
                self.assertEqual(lightweight["turns"][0]["items"][1]["content"][0]["path"], str(image_path))
                tail = await read_endpoint("thread", include_images=False, tail_turns=1)
                self.assertTrue(tail["historyPartial"])
                self.assertEqual(2, tail["totalTurns"])
                self.assertEqual(["latest"], [turn["id"] for turn in tail["turns"]])
                self.assertNotIn("turns", (await list_endpoint())[0])
                self.assertTrue(any(middleware.cls is GZipMiddleware for middleware in app.user_middleware))
            finally:
                app.state.shared_state.close()
                await app.state.claude_code.close()
