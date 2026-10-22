from __future__ import annotations

import asyncio
import copy
import hashlib
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from codex_remote.device_chat import DeviceChatManager
from codex_remote.device_chat_sync import GROUP_PROMPT_PREFIX


def turn(identity="turn", *, prompt="继续测试", reply="已经完成", status="completed", started=None):
    return {"id": identity, "startedAt": started or datetime.now(timezone.utc).isoformat(), "status": status,
            "items": [{"id": f"{identity}-user", "type": "userMessage", "content": [{"type": "text", "text": prompt}]},
                      {"id": f"{identity}-answer", "type": "agentMessage", "text": reply}]}


class HistoryCodex:
    def __init__(self, workspace):
        self.workspace = workspace
        self.turns = []
        self.revision = 1
        self.queues = set()
        self.reads = []
        self.before_read = None

    async def subscribe(self):
        queue = asyncio.Queue()
        self.queues.add(queue)
        return queue

    def unsubscribe(self, queue):
        self.queues.discard(queue)

    def thread_history_revision(self, thread_id):
        return str(self.revision)

    async def read_thread(self, thread_id, *, tail_turns=None, **kwargs):
        self.reads.append(tail_turns)
        if self.before_read:
            await self.before_read()
        turns = self.turns[-tail_turns:] if tail_turns else self.turns
        return {"id": thread_id, "turns": copy.deepcopy(turns), "cwd": str(self.workspace)}


class DeviceChatBoundThreadSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "room.sqlite3"
        self.codex = HistoryCodex(Path(self.temp.name))
        self.manager = DeviceChatManager(self.path, self.codex)
        self.manager._save_config({"role": "host", "room": {"id": "room", "name": "群"}, "name": "Linux"})
        self.manager._upsert_member({"id": self.manager.node_id, "name": "Linux", "online": True})
        self.manager._upsert_member({"id": "win", "name": "win", "online": True})
        self.manager.connection.execute("INSERT INTO device_chat_threads(room_id,thread_id,manual) VALUES ('room','thread',1)")
        self.manager.connection.execute("INSERT INTO device_chat_sync_bindings(room_id,thread_id,since) VALUES ('room','thread',0)")
        self.sync = self.manager.thread_sync

    async def asyncTearDown(self):
        await self.manager.close()
        self.temp.cleanup()

    def messages(self, kind=None):
        return [e for e in self.manager.state()["messages"] if not kind or e["kind"] == kind]

    def notify(self, method, **params):
        self.sync.handle({"method": method, "params": {"threadId": "thread", "turnId": "turn", **params}})

    async def test_legacy_binding_recovers_followups_without_replaying_old_mentions(self):
        self.manager.connection.execute("DELETE FROM device_chat_sync_bindings")
        self.codex.turns = [turn("private", prompt="绑定前的内容"),
                            turn("group", prompt=GROUP_PROMPT_PREFIX + "\n群消息"),
                            turn("missed", reply="已推送\n@win"), turn("followup", reply="HTTP 地址也可用\n@win")]
        await self.sync.sync_history()
        self.assertEqual(["已推送\n@win", "HTTP 地址也可用\n@win"], [e["text"] for e in self.messages("assistant")])
        self.assertEqual(4, len(self.messages()))
        self.assertTrue(all(e["target_id"] is None for e in self.messages()))
        cursor = self.messages()[-1]["cursor"]
        await self.manager.close()
        self.manager = DeviceChatManager(self.path, self.codex)
        self.sync = self.manager.thread_sync
        await self.sync.sync_history()
        self.assertEqual(4, len(self.messages()))
        self.assertEqual(cursor, self.messages()[-1]["cursor"])

    async def test_live_followup_streams_and_final_mention_routes_once(self):
        await self.sync.sync_history()
        self.notify("item/started", item={"id": "turn-user", "type": "userMessage", "content": [{"type": "text", "text": "请通知 win"}]})
        self.notify("item/agentMessage/delta", itemId="turn-answer", delta="已经")
        await self.sync.flush_live()
        self.assertEqual("请通知 win", self.messages("user")[0]["text"])
        first = self.messages("assistant")[0]
        self.notify("item/agentMessage/delta", itemId="turn-answer", delta="完成\n@win")
        await self.sync.flush_live()
        partial = self.messages("assistant")[0]
        self.assertEqual(first["id"], partial["id"])
        self.assertGreater(partial["cursor"], first["cursor"])
        self.assertIsNone(partial["target_id"])
        self.notify("turn/completed", turn={"id": "turn", "status": "completed"})
        await self.sync.flush_live()
        final = self.messages("assistant")[0]
        self.assertEqual("win", final["target_id"])
        self.assertEqual(1, final["handoff_depth"])
        self.notify("turn/completed", turn={"id": "turn", "status": "completed"})
        await self.sync.flush_live()
        self.assertEqual(final["cursor"], self.messages("assistant")[0]["cursor"])
        self.assertEqual([], self.manager.connection.execute("SELECT * FROM device_chat_agent_jobs").fetchall())

    async def test_live_assistant_waits_for_user_and_recovers_it_from_unchanged_history_revision(self):
        await self.sync.sync_history()
        self.notify("item/agentMessage/delta", itemId="turn-answer", delta="正在处理")
        await self.sync.flush_live()
        self.assertEqual([], self.messages())

        # History can expose the user item without changing its revision yet.
        self.codex.turns = [turn(reply="", status="inProgress")]
        await self.sync.sync_history()
        messages = self.messages()
        self.assertEqual(["user", "assistant"], [message["kind"] for message in messages])
        self.assertEqual("继续测试", messages[0]["text"])
        self.assertEqual("正在处理", messages[1]["text"])
        self.assertLess(messages[0]["sequence"], messages[1]["sequence"])

        self.notify("item/agentMessage/delta", itemId="turn-answer", delta="完成")
        await self.sync.flush_live()
        self.assertEqual(["user", "assistant"], [message["kind"] for message in self.messages()])
        self.assertEqual("正在处理完成", self.messages("assistant")[0]["text"])

    async def test_external_history_changes_sync_without_browser_notifications(self):
        self.codex.turns = [turn(reply="开始检查", status="inProgress")]
        await self.sync.sync_history()
        first = self.messages("assistant")[0]
        self.codex.turns[0]["items"][1]["text"] = "已检查\n@win"
        self.codex.turns[0]["status"] = "completed"
        self.codex.revision += 1
        await self.sync.sync_history()
        final = self.messages("assistant")[0]
        self.assertEqual(first["id"], final["id"])
        self.assertEqual("win", final["target_id"])

    async def test_bound_thread_activity_survives_history_and_live_updates(self):
        self.codex.turns = [turn(reply="", status="inProgress")]
        self.codex.turns[0]["items"].append({"id": "command", "type": "commandExecution", "command": "pnpm test", "status": "inProgress"})
        await self.sync.sync_history()
        first = self.messages("assistant")[0]
        self.assertEqual("running", first["activity"]["state"])
        self.assertIn("commandExecution", [item["type"] for item in first["activity"]["items"]])
        self.notify("turn/workspaceChanges", changes=[{"path": "src/app.ts", "diff": "+fixed"}])
        await self.sync.flush_live()
        updated = self.messages("assistant")[0]
        self.assertEqual(first["id"], updated["id"])
        self.assertGreater(updated["cursor"], first["cursor"])
        self.assertEqual("fileChange", updated["activity"]["items"][-1]["type"])
        self.notify("turn/completed", turn={"id": "turn", "status": "completed"})
        await self.sync.flush_live()
        self.assertEqual("completed", self.messages("assistant")[0]["activity"]["state"])

    async def test_group_turns_and_unbound_thread_notifications_are_not_duplicated(self):
        self.sync.mark_group_turn("room", "thread", "group")
        self.codex.turns = [turn("group", prompt="无内部前缀的群消息"), turn("legacy", prompt=GROUP_PROMPT_PREFIX)]
        await self.sync.sync_history()
        self.notify("item/agentMessage/delta", threadId="unbound", itemId="answer", delta="其他聊天")
        await self.sync.flush_live()
        self.assertEqual([], self.messages())

    async def test_new_binding_does_not_publish_existing_private_history(self):
        self.sync.bind("room", "thread")
        self.codex.turns = [turn(started="2020-01-01T00:00:00Z")]
        await self.sync.sync_history()
        self.assertEqual([], self.messages())

    async def test_new_turn_in_binding_second_is_not_lost(self):
        stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        old = turn("old", started=stamp)
        self.sync.bind("room", "thread", [old])
        self.codex.turns = [old, turn("new", started=stamp)]
        await self.sync.sync_history()
        self.assertEqual(2, len(self.messages()))
        self.assertEqual("new", self.manager.connection.execute(
            "SELECT turn_id FROM device_chat_sync_turns WHERE origin='ordinary'").fetchone()[0])

    async def test_group_activity_does_not_advance_ordinary_sync_checkpoint(self):
        self.codex.turns = [turn()]
        self.manager._active_agent_thread_id = "thread"
        await self.sync.sync_history()
        self.assertEqual([], self.messages())
        self.manager._active_agent_thread_id = None
        await self.sync.sync_history()
        self.assertEqual(2, len(self.messages()))

    async def test_switch_during_read_does_not_publish_old_thread(self):
        self.codex.turns = [turn()]
        async def switch():
            self.manager.connection.execute("UPDATE device_chat_threads SET thread_id='other'")
        self.codex.before_read = switch
        await self.sync.sync_history()
        self.assertEqual([], self.messages())

    async def test_recovery_reads_full_history_if_checkpoint_is_outside_tail(self):
        self.codex.turns = [turn("first")]
        await self.sync.sync_history()
        self.codex.turns.extend(turn(str(i)) for i in range(105))
        self.codex.revision += 1
        await self.sync.sync_history()
        self.assertEqual(106, len(self.messages("assistant")))
        self.assertEqual([100, None], self.codex.reads[-2:])

    async def test_stale_history_does_not_replace_newer_live_body(self):
        self.codex.turns = [turn(reply="", status="inProgress")]
        await self.sync.sync_history()
        self.notify("item/agentMessage/delta", itemId="turn-answer", delta="流式正文")
        await self.sync.flush_live()
        self.codex.revision += 1
        await self.sync.sync_history()
        self.assertEqual("流式正文", self.messages("assistant")[0]["text"])

    async def test_listener_stops_and_releases_subscription(self):
        self.codex.turns = [turn()]
        await self.sync.start()
        for _ in range(30):
            if self.messages():
                break
            await asyncio.sleep(0.01)
        self.assertEqual(2, len(self.messages()))
        await self.sync.close()
        self.assertEqual(set(), self.codex.queues)
        await self.sync.start()
        await self.sync.close()  # Also covers cancellation before coroutine entry.
        self.assertEqual(set(), self.codex.queues)

    async def test_completed_job_status_is_repaired(self):
        await self.manager._publish_local_agent_event("status", "status:request", "Linux 正在处理这条群聊消息…")
        self.manager.connection.execute("INSERT INTO device_chat_agent_jobs VALUES ('request','complete','now')")
        self.manager._recover_completed_statuses()
        self.assertEqual("Linux 已处理完成。", self.messages("status")[0]["text"])

    async def test_peer_delivery_preserves_large_reply_and_does_not_restart_user_turn(self):
        host = DeviceChatManager(Path(self.temp.name) / "host.sqlite3", self.codex)
        try:
            host._save_config({"role": "host", "room": {"id": "room"}, "name": "win"})
            host._upsert_member({"id": self.manager.node_id, "name": "Linux", "online": True})
            host.connection.execute("UPDATE device_chat_members SET token_hash=? WHERE id=?",
                                    (hashlib.sha256(b"peer-token").hexdigest(), self.manager.node_id))
            self.manager._save_config({"role": "peer", "room": {"id": "room"}, "name": "Linux"})
            async def send(endpoint, payload):
                saved = await host.host_peer_event(self.manager.node_id, "peer-token", payload["event"])
                await self.manager._receive_event(saved)
                return saved
            self.manager._send_peer_http = send
            self.codex.turns = [turn(reply="详细日志" * 4000)]
            self.codex.turns[0]["items"].extend([
                {"id": "command", "type": "commandExecution", "command": "pnpm test", "status": "completed"},
                {"id": "change", "type": "fileChange", "status": "completed", "changes": [{"path": "src/app.ts", "diff": "+fixed"}]},
            ])
            await self.sync.sync_history()
            self.assertEqual("详细日志" * 4000, host._messages(10)[-1]["text"])
            self.assertEqual(["commandExecution", "fileChange"], [item["type"] for item in host._messages(10)[-1]["activity"]["items"][-2:]])
            self.assertEqual("src/app.ts", self.messages("assistant")[0]["activity"]["items"][-1]["changes"][0]["path"])
            self.assertEqual(2, len(self.messages()))
            self.assertEqual([], host.connection.execute("SELECT * FROM device_chat_agent_jobs").fetchall())
            self.assertEqual([], self.manager.connection.execute("SELECT * FROM device_chat_agent_jobs").fetchall())
        finally:
            await host.close()


if __name__ == "__main__":
    unittest.main()
