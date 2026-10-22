from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from codex_remote.device_chat import MAX_AUTO_HANDOFFS, DeviceChatManager, _can_handoff, _handoff_target


class _FakeCodex:
    workspace: Path

    def __init__(self, workspace: Path, reply: str) -> None:
        self.workspace = workspace
        self.reply = reply
        self.notifications: asyncio.Queue[dict[str, object]] = asyncio.Queue()

    async def start_thread(self, *, cwd: Path) -> dict[str, str]:
        return {"id": "thread-id"}

    async def set_thread_name(self, thread_id: str, name: str) -> None:
        return None

    async def subscribe(self) -> asyncio.Queue[dict[str, object]]:
        return self.notifications

    def unsubscribe(self, queue: asyncio.Queue[dict[str, object]]) -> None:
        return None

    async def start_turn(self, thread_id: str, prompt: str, *, cwd: Path) -> dict[str, object]:
        self.notifications.put_nowait({
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": "turn-id", "delta": self.reply},
        })
        self.notifications.put_nowait({
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turnId": "turn-id", "turn": {"id": "turn-id", "status": "completed"}},
        })
        return {"turn": {"id": "turn-id"}}


class DeviceChatHandoffTargetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.members = [
            {"id": "linux-id", "name": "Linux", "online": True},
            {"id": "windows-id", "name": "Windows", "online": True},
        ]

    def test_routes_only_an_exact_final_standalone_mention(self) -> None:
        self.assertEqual(
            "windows-id",
            _handoff_target("我检查完了。\n\n@Windows", self.members, "linux-id")["id"],
        )

    def test_ordinary_mentions_and_code_examples_do_not_route(self) -> None:
        self.assertIsNone(_handoff_target("请让 @Windows 看一下。\n我先给结论。", self.members, "linux-id"))
        self.assertIsNone(_handoff_target("```text\n@Windows\n```", self.members, "linux-id"))

    def test_offline_self_and_ambiguous_members_do_not_route(self) -> None:
        offline = [{**self.members[1], "online": False}]
        self.assertIsNone(_handoff_target("@Windows", offline, "linux-id"))
        self.assertIsNone(_handoff_target("@Linux", self.members, "linux-id"))
        ambiguous = [*self.members, {"id": "windows-2", "name": "Windows", "online": True}]
        self.assertIsNone(_handoff_target("@Windows", ambiguous, "linux-id"))


class DeviceChatAgentSchedulingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = DeviceChatManager(Path(self.temp_dir.name) / "device-chat.sqlite3", object())
        self.manager._save_config({"role": "host", "room": {"id": "room-id"}, "name": "Linux"})
        self.manager._upsert_member({"id": self.manager.node_id, "name": "Linux", "online": True})
        self.manager._upsert_member({"id": "windows-id", "name": "Windows", "online": True})
        self.launched: list[dict[str, object]] = []
        self.manager._launch_agent = self.launched.append

    def tearDown(self) -> None:
        self.manager.connection.close()
        self.temp_dir.cleanup()

    def test_remote_assistant_handoff_to_this_node_is_scheduled_once(self) -> None:
        event = {
            "id": "handoff-message",
            "kind": "assistant",
            "sender_id": "windows-id",
            "target_id": self.manager.node_id,
            "handoff_root_id": "user-message",
            "handoff_depth": 1,
        }
        self.manager._schedule_agent(event)
        self.manager._schedule_agent(event)
        self.assertEqual(["handoff-message"], [item["id"] for item in self.launched])

    def test_self_messages_and_handoffs_over_the_limit_are_not_scheduled(self) -> None:
        base = {
            "kind": "assistant",
            "target_id": self.manager.node_id,
            "handoff_root_id": "user-message",
        }
        self.manager._schedule_agent({**base, "id": "self-message", "sender_id": self.manager.node_id, "handoff_depth": 1})
        self.manager._schedule_agent({**base, "id": "over-limit", "sender_id": "windows-id", "handoff_depth": MAX_AUTO_HANDOFFS + 1})
        self.manager._schedule_agent({**base, "id": "at-limit", "sender_id": "windows-id", "handoff_depth": MAX_AUTO_HANDOFFS})
        self.assertEqual(["at-limit"], [item["id"] for item in self.launched])

    def test_next_handoff_cannot_be_started_after_current_depth_reaches_limit(self) -> None:
        self.assertTrue(_can_handoff(MAX_AUTO_HANDOFFS - 1))
        self.assertFalse(_can_handoff(MAX_AUTO_HANDOFFS))
        self.assertFalse(_can_handoff(True))

    def test_user_message_still_requires_explicit_targeting(self) -> None:
        untargeted = {"id": "broadcast", "kind": "user", "sender_id": "user-id", "target_id": None}
        targeted = {"id": "directed", "kind": "user", "sender_id": "user-id", "target_id": self.manager.node_id}
        self.manager._schedule_agent(untargeted)
        self.manager._schedule_agent(targeted)
        self.assertEqual(["directed"], [item["id"] for item in self.launched])

    def test_completed_codex_reply_persists_a_routed_handoff(self) -> None:
        self.manager.codex = _FakeCodex(Path(self.temp_dir.name), "Windows 需要检查一下。\n@Windows")
        event = {
            "id": "user-message",
            "kind": "user",
            "sender_id": "human-id",
            "sender_name": "我",
            "target_id": self.manager.node_id,
            "text": "请分析问题，需要的话交给 Windows 看。",
        }

        asyncio.run(self.manager._execute_agent(event))

        reply = next(message for message in self.manager._messages(20) if message["id"] == "reply:user-message")
        self.assertEqual("windows-id", reply["target_id"])
        self.assertEqual("Windows", reply["target_name"])
        self.assertEqual("user-message", reply["handoff_root_id"])
        self.assertEqual(1, reply["handoff_depth"])

    def test_handoff_limit_publishes_a_stop_status_and_keeps_reply_local(self) -> None:
        self.manager.codex = _FakeCodex(Path(self.temp_dir.name), "继续处理。\n@Windows")
        event = {
            "id": "handoff-four",
            "kind": "assistant",
            "sender_id": "mac-id",
            "sender_name": "Mac",
            "target_id": self.manager.node_id,
            "handoff_root_id": "user-message",
            "handoff_depth": MAX_AUTO_HANDOFFS,
            "text": "请继续。",
        }

        asyncio.run(self.manager._execute_agent(event))

        messages = self.manager._messages(20)
        reply = next(message for message in messages if message["id"] == "reply:handoff-four")
        self.assertEqual(self.manager.node_id, reply["target_id"])
        self.assertNotIn("handoff_depth", reply)
        self.assertTrue(any(message["id"] == "status:handoff-limit:handoff-four" for message in messages))


if __name__ == "__main__":
    unittest.main()
