from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from devwisp.permission_prompt import PermissionPromptBroker, PermissionPromptError


class PermissionPromptBrokerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.events: asyncio.Queue[dict] = asyncio.Queue()
        self.broker = PermissionPromptBroker(Path(self.directory.name) / "permission.sock", self.events.put)
        self.writers: list[asyncio.StreamWriter] = []
        await self.broker.start()

    async def asyncTearDown(self) -> None:
        for writer in self.writers:
            writer.close()
            await writer.wait_closed()
        await self.broker.close()
        await asyncio.sleep(0)
        self.directory.cleanup()

    async def request(self, permission_id: str = "permission", thread_id: str = "claude:thread"):
        reader, writer = await asyncio.open_unix_connection(str(self.broker.socket_path))
        self.writers.append(writer)
        writer.write((json.dumps({
            "permissionId": permission_id, "threadId": thread_id,
            "toolName": "Read", "filePath": "/etc/hostname", "cwd": "/workspace",
        }) + "\n").encode())
        await writer.drain()
        return reader, writer

    async def event(self, event_type: str) -> dict:
        event = await asyncio.wait_for(self.events.get(), timeout=2)
        self.assertEqual(event["type"], event_type)
        return event["params"]

    async def test_request_is_recoverable_until_decided_and_snapshot_is_detached(self) -> None:
        reader, _ = await self.request()
        params = await self.event("claude/permission/request")
        snapshot = self.broker.pending_requests()
        self.assertEqual(snapshot, [params])
        snapshot[0]["filePath"] = "modified by caller"
        self.assertEqual(self.broker.pending_requests()[0]["filePath"], "/etc/hostname")

        await self.broker.respond("permission", "claude:thread", True)
        self.assertEqual(self.broker.pending_requests(), [])
        response = json.loads(await asyncio.wait_for(reader.readline(), timeout=2))
        self.assertEqual(response, {"allowed": True})
        self.assertEqual(await self.event("claude/permission/resolved"), {
            "threadId": "claude:thread", "permissionId": "permission",
        })

    async def test_deny_and_concurrent_requests_do_not_drop_other_threads(self) -> None:
        first, _ = await self.request("first", "claude:one")
        await self.event("claude/permission/request")
        second, _ = await self.request("second", "claude:two")
        await self.event("claude/permission/request")
        self.assertEqual(len(self.broker.pending_requests()), 2)

        await self.broker.respond("first", "claude:one", False)
        self.assertEqual(json.loads(await first.readline()), {"allowed": False})
        await self.event("claude/permission/resolved")
        self.assertEqual([item["permissionId"] for item in self.broker.pending_requests()], ["second"])
        with self.assertRaises(PermissionPromptError):
            await self.broker.respond("second", "claude:one", True)

        await self.broker.respond("second", "claude:two", True)
        self.assertEqual(json.loads(await second.readline()), {"allowed": True})
        await self.event("claude/permission/resolved")

    async def test_timeout_denies_and_removes_recoverable_request(self) -> None:
        with patch("devwisp.permission_prompt.PERMISSION_REQUEST_TIMEOUT_SECONDS", 0.02):
            reader, _ = await self.request()
            await self.event("claude/permission/request")
            self.assertEqual(json.loads(await reader.readline()), {"allowed": False})
        await self.event("claude/permission/resolved")
        self.assertEqual(self.broker.pending_requests(), [])
        with self.assertRaises(PermissionPromptError):
            await self.broker.respond("permission", "claude:thread", True)

    async def test_disconnected_cli_removes_pending_request_without_waiting_for_timeout(self) -> None:
        _, writer = await self.request()
        await self.event("claude/permission/request")
        writer.close()
        await writer.wait_closed()
        await self.event("claude/permission/resolved")
        self.assertEqual(self.broker.pending_requests(), [])

    async def test_failed_emit_does_not_leave_a_recoverable_request(self) -> None:
        async def fail_emit(event: dict) -> None:
            raise RuntimeError("delivery failed")

        self.broker.emit = fail_emit
        reader, _ = await self.request()
        response = json.loads(await asyncio.wait_for(reader.readline(), timeout=2))
        self.assertFalse(response["allowed"])
        self.assertEqual(self.broker.pending_requests(), [])

    async def test_duplicate_id_does_not_resolve_the_original_request(self) -> None:
        first, _ = await self.request()
        await self.event("claude/permission/request")
        duplicate, _ = await self.request()
        response = json.loads(await asyncio.wait_for(duplicate.readline(), timeout=2))
        self.assertFalse(response["allowed"])
        self.assertEqual(len(self.broker.pending_requests()), 1)
        self.assertTrue(self.events.empty())
        await self.broker.respond("permission", "claude:thread", False)
        self.assertEqual(json.loads(await first.readline()), {"allowed": False})
        await self.event("claude/permission/resolved")


if __name__ == "__main__":
    unittest.main()
