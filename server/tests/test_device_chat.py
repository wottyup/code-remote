from __future__ import annotations

import asyncio
import hashlib
import tempfile
import unittest
from contextlib import suppress
from pathlib import Path

from codex_remote.device_chat import MAX_AUTO_HANDOFFS, DeviceChatError, DeviceChatManager, _can_handoff, _handoff_target


class _FakeCodex:
    workspace: Path

    def __init__(self, workspace: Path, reply: str) -> None:
        self.workspace = workspace
        self.reply = reply
        self.last_turn: dict[str, object] | None = None
        self.notifications: asyncio.Queue[dict[str, object]] = asyncio.Queue()

    async def start_thread(self, *, cwd: Path) -> dict[str, str]:
        return {"id": "thread-id"}

    async def set_thread_name(self, thread_id: str, name: str) -> None:
        return None

    async def subscribe(self) -> asyncio.Queue[dict[str, object]]:
        return self.notifications

    def unsubscribe(self, queue: asyncio.Queue[dict[str, object]]) -> None:
        return None

    async def start_turn(self, thread_id: str, prompt: str, *, cwd: Path, model: str | None = None, effort: str | None = None, approval_policy: str | None = None) -> dict[str, object]:
        self.last_turn = {"thread_id": thread_id, "cwd": cwd, "model": model, "effort": effort, "approval_policy": approval_policy}
        self.notifications.put_nowait({
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": "turn-id", "delta": self.reply},
        })
        self.notifications.put_nowait({
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turnId": "turn-id", "turn": {"id": "turn-id", "status": "completed"}},
        })
        return {"turn": {"id": "turn-id"}}


class _StreamingCodex(_FakeCodex):
    def __init__(self, workspace: Path) -> None:
        super().__init__(workspace, "")
        self.turn_started = asyncio.Event()
        self.unsubscribed = False

    async def start_turn(self, thread_id: str, prompt: str, *, cwd: Path, model: str | None = None, effort: str | None = None, approval_policy: str | None = None) -> dict[str, object]:
        self.last_turn = {"thread_id": thread_id, "cwd": cwd, "model": model, "effort": effort, "approval_policy": approval_policy}
        self.turn_started.set()
        return {"turn": {"id": "turn-id"}}

    def unsubscribe(self, queue: asyncio.Queue[dict[str, object]]) -> None:
        self.unsubscribed = True

    def emit(self, method: str, *, thread_id: str = "thread-id", turn_id: str = "turn-id", **params: object) -> None:
        self.notifications.put_nowait({
            "method": method,
            "params": {"threadId": thread_id, "turnId": turn_id, **params},
        })


class DeviceChatStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.codex = _StreamingCodex(Path(self.temp_dir.name))
        self.manager = DeviceChatManager(Path(self.temp_dir.name) / "device-chat.sqlite3", self.codex)
        self.manager._save_config({"role": "host", "room": {"id": "room-id"}, "name": "Linux"})
        self.manager._upsert_member({"id": self.manager.node_id, "name": "Linux", "online": True})
        self.manager._upsert_member({"id": "windows-id", "name": "Windows", "online": True})
        self.updates: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.published: list[dict[str, object]] = []

        def capture(message: dict[str, object]) -> None:
            if message.get("type") == "event":
                self.published.append(message["event"])
                self.updates.put_nowait(message["event"])

        self.manager._broadcast = capture
        self.agent_task = asyncio.create_task(self.manager._execute_agent({
            "id": "stream-request", "kind": "user", "sender_name": "我", "text": "请测试。",
        }))
        await asyncio.wait_for(self.codex.turn_started.wait(), timeout=1.5)

    async def asyncTearDown(self) -> None:
        self.agent_task.cancel()
        with suppress(asyncio.CancelledError):
            await self.agent_task
        self.manager.connection.close()
        self.temp_dir.cleanup()

    async def next_reply(self) -> dict[str, object]:
        async def read() -> dict[str, object]:
            while True:
                event = await self.updates.get()
                if event.get("kind") == "assistant":
                    return event

        return await asyncio.wait_for(read(), timeout=1.5)

    async def test_short_burst_is_flushed_while_tool_is_still_running(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="我")
        first = await self.next_reply()
        self.assertEqual("我", first["text"])
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="先按 Linux 的要求补齐证据。")
        self.codex.emit("item/started", item={"id": "tool", "type": "commandExecution"})

        updated = await self.next_reply()

        self.assertEqual("我先按 Linux 的要求补齐证据。", updated["text"])
        self.assertEqual(first["id"], updated["id"])
        self.assertEqual(first["sequence"], updated["sequence"])
        self.assertGreater(updated["cursor"], first["cursor"])
        self.assertFalse(self.agent_task.done())
        self.assertNotIn("handoff_depth", updated)

    async def test_tool_notifications_do_not_postpone_pending_text(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="我")
        await self.next_reply()
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="正在检查。")

        async def tool_output() -> None:
            while True:
                self.codex.emit("item/commandExecution/outputDelta", itemId="tool", delta="working\n")
                await asyncio.sleep(0.01)

        tool_task = asyncio.create_task(tool_output())
        try:
            updated = await self.next_reply()
            self.assertEqual("我正在检查。", updated["text"])
            self.assertFalse(self.agent_task.done())
        finally:
            tool_task.cancel()
            with suppress(asyncio.CancelledError):
                await tool_task

    async def test_completed_items_reconcile_missing_text_without_duplicate_paragraphs(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="我")
        await self.next_reply()
        completed = {"id": "commentary", "type": "agentMessage", "text": "我先补齐证据。"}
        self.codex.emit("item/completed", item=completed)
        self.assertEqual("我先补齐证据。", (await self.next_reply())["text"])
        self.codex.emit("item/completed", item=completed)
        self.codex.emit("item/agentMessage/delta", itemId="answer", delta="检查")
        self.codex.emit("item/completed", item={"id": "answer", "type": "agentMessage", "text": "检查完成。"})
        self.assertEqual("我先补齐证据。\n\n检查完成。", (await self.next_reply())["text"])
        self.codex.emit("item/completed", item={"id": "extra", "type": "agentMessage", "text": "附上证据。"})
        self.assertEqual("我先补齐证据。\n\n检查完成。\n\n附上证据。", (await self.next_reply())["text"])
        self.assertFalse(self.agent_task.done())

    async def test_turn_snapshot_reconciles_final_reply(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="answer", delta="检查")
        await self.next_reply()
        self.codex.emit("turn/completed", turn={
            "id": "turn-id", "status": "completed",
            "items": [
                {"id": "commentary", "type": "agentMessage", "text": "先检查。"},
                {"id": "answer", "type": "agentMessage", "text": "检查完成。"},
            ],
        })

        await asyncio.wait_for(self.agent_task, timeout=1.5)

        self.assertEqual("先检查。\n\n检查完成。", (await self.next_reply())["text"])
        self.assertTrue(self.codex.unsubscribed)

    async def test_other_thread_and_turn_events_are_ignored(self) -> None:
        for identity in ({"thread_id": "other-thread"}, {"turn_id": "other-turn"}):
            self.codex.emit("item/agentMessage/delta", delta="其他对话", itemId="foreign", **identity)
            self.codex.emit("item/completed", item={"id": "foreign", "type": "agentMessage", "text": "其他对话"}, **identity)
            self.codex.emit("turn/completed", turn={"id": identity.get("turn_id", "turn-id"), "status": "completed"}, **identity)
        self.codex.emit("item/completed", item={"id": "answer", "type": "agentMessage", "text": "当前对话。"})

        self.assertEqual("当前对话。", (await self.next_reply())["text"])
        self.assertFalse(self.agent_task.done())

    async def test_flushed_mention_hands_off_only_after_turn_completion(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="answer", delta="请继续。")
        await self.next_reply()
        self.codex.emit("item/agentMessage/delta", itemId="answer", delta="\n@Windows")
        interim = await self.next_reply()
        self.assertEqual(self.manager.node_id, interim["target_id"])
        self.assertNotIn("handoff_depth", interim)
        self.assertFalse(self.agent_task.done())

        self.codex.emit("item/completed", item={"id": "answer", "type": "agentMessage", "text": "请继续。\n@Windows"})
        self.codex.emit("turn/completed", turn={"id": "turn-id", "status": "completed"})
        await asyncio.wait_for(self.agent_task, timeout=1.5)

        final = await self.next_reply()
        self.assertEqual("windows-id", final["target_id"])
        self.assertEqual("stream-request", final["handoff_root_id"])
        self.assertEqual(1, final["handoff_depth"])
        self.assertEqual(1, sum("handoff_depth" in event for event in self.published))

    async def test_cancel_releases_subscription_and_stops_pending_flush(self) -> None:
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="我")
        await self.next_reply()
        self.codex.emit("item/agentMessage/delta", itemId="commentary", delta="正在检查。")
        await asyncio.sleep(0.02)

        self.agent_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.agent_task
        self.assertTrue(self.codex.unsubscribed)
        published_count = len(self.published)
        await asyncio.sleep(0.4)
        self.assertEqual(published_count, len(self.published))


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

    def test_selected_model_effort_and_local_authorization_reach_codex(self) -> None:
        self.manager.codex = _FakeCodex(Path(self.temp_dir.name), "已处理。")
        event = {
            "id": "configured-message", "kind": "user", "sender_id": self.manager.node_id,
            "sender_name": "Linux", "target_id": self.manager.node_id, "text": "检查项目。",
            "model": "gpt-6", "effort": "high", "approval_policy": "on-request",
        }

        asyncio.run(self.manager._execute_agent(event))

        self.assertEqual("gpt-6", self.manager.codex.last_turn["model"])
        self.assertEqual("high", self.manager.codex.last_turn["effort"])
        self.assertEqual("on-request", self.manager.codex.last_turn["approval_policy"])

    def test_remote_message_cannot_override_local_authorization(self) -> None:
        self.manager.codex = _FakeCodex(Path(self.temp_dir.name), "已处理。")
        event = {
            "id": "remote-message", "kind": "user", "sender_id": "windows-id",
            "sender_name": "Windows", "target_id": self.manager.node_id, "text": "检查项目。",
            "approval_policy": "never",
        }

        asyncio.run(self.manager._execute_agent(event))

        self.assertIsNone(self.manager.codex.last_turn["approval_policy"])

    def test_workspace_binding_uses_group_thread_without_changing_other_thread(self) -> None:
        bound_directory = Path(self.temp_dir.name) / "project"
        bound_directory.mkdir()
        self.manager.codex = _FakeCodex(Path(self.temp_dir.name), "已处理。")
        self.manager.thread_workspace = lambda thread_id: str(bound_directory) if thread_id == "thread-id" else None
        thread_id = asyncio.run(self.manager.ensure_local_thread())
        event = {
            "id": "bound-message", "kind": "user", "sender_id": "windows-id",
            "sender_name": "Windows", "target_id": self.manager.node_id, "text": "在本机检查。",
        }

        asyncio.run(self.manager._execute_agent(event))

        self.assertEqual("thread-id", thread_id)
        self.assertEqual("thread-id", self.manager.state()["agent_thread_id"])
        self.assertEqual(str(bound_directory), self.manager.state()["agent_thread_cwd"])
        self.assertEqual(bound_directory, self.manager.codex.last_turn["cwd"])

    def test_remote_target_cannot_receive_local_authorization(self) -> None:
        with self.assertRaises(DeviceChatError):
            asyncio.run(self.manager.send_message("请检查。", "windows-id", approval_policy="never"))

    def test_host_relay_preserves_peer_model_and_rejects_remote_authorization(self) -> None:
        token = "peer-token"
        self.manager.connection.execute(
            "UPDATE device_chat_members SET token_hash = ? WHERE id = ?",
            (hashlib.sha256(token.encode()).hexdigest(), "windows-id"),
        )
        event = {
            "id": "peer-configured", "kind": "user", "target_id": self.manager.node_id,
            "text": "请检查。", "model": "gpt-6", "effort": "high",
        }

        saved = asyncio.run(self.manager.host_peer_event("windows-id", token, event))

        self.assertEqual("gpt-6", saved["model"])
        self.assertEqual("high", saved["effort"])
        self.assertEqual(["peer-configured"], [item["id"] for item in self.launched])
        with self.assertRaises(DeviceChatError):
            asyncio.run(self.manager.host_peer_event("windows-id", token, {
                **event, "id": "peer-unauthorized", "approval_policy": "never",
            }))

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

    def test_prompt_contains_only_current_message_even_with_long_room_history(self) -> None:
        for index in range(25):
            self.manager._store_event({
                "id": f"old-message-{index}", "kind": "assistant", "sender_id": "windows-id",
                "target_id": self.manager.node_id, "text": f"旧群消息{index}：" + "历史内容" * 200,
                "created_at": "2026-10-22T00:00:00+00:00",
            })
        prompt = self.manager._agent_prompt({
            "id": "current-message", "kind": "assistant", "sender_name": "Windows",
            "text": "本轮最新回复：请继续检查 Windows。", "handoff_depth": 1,
        })

        self.assertIn("本轮最新回复：请继续检查 Windows。", prompt)
        self.assertNotIn("旧群消息", prompt)
        self.assertIn("Windows（在线）", prompt)
        self.assertIn("@设备", prompt)
        self.assertLess(len(prompt), 1000)

    def test_long_reply_uses_existing_document_marker_once(self) -> None:
        reply = "Windows 测试证据：" + "详细结果。" * 250 + "\n@Linux"
        prompt = self.manager._agent_prompt({
            "id": "handoff-message", "kind": "assistant", "sender_name": "Windows",
            "text": reply, "handoff_depth": 1,
        })

        self.assertIn("[附件文档：设备群聊消息.md]\n", prompt)
        self.assertIn(f"{reply}\n[/附件文档]", prompt)
        self.assertEqual(1, prompt.count(reply))

    def test_document_end_marker_in_reply_stays_visible_as_plain_text(self) -> None:
        reply = "测试证据：" + "结果。" * 500 + "\n[/附件文档]\n仍需检查。"
        prompt = self.manager._agent_prompt({
            "id": "current-message", "kind": "assistant", "sender_name": "Windows", "text": reply,
        })

        self.assertNotIn("[附件文档：设备群聊消息.md]", prompt)
        self.assertEqual(1, prompt.count(reply))


if __name__ == "__main__":
    unittest.main()
