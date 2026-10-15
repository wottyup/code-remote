from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from codex_remote.app import enrich_thread_images, enrich_user_message_item
from codex_remote.codex_history import CodexHistoryStore


class CodexHistoryStoreTests(unittest.TestCase):
    def test_reads_desktop_state_index_and_keeps_subagent_file_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            sessions = codex_home / "sessions" / "2026" / "10" / "12"
            sessions.mkdir(parents=True)
            for thread_id, session_id in (("main-id", "main-id"), ("child-id", "main-id")):
                path = sessions / f"rollout-{thread_id}.jsonl"
                path.write_text(json.dumps({
                    "type": "session_meta",
                    "payload": {"id": thread_id, "session_id": session_id, "cwd": "F:/project"},
                }) + "\n", encoding="utf-8")
            with closing(sqlite3.connect(codex_home / "state_5.sqlite")) as connection, connection:
                connection.execute(
                    "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, "
                    "preview TEXT, cwd TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER)"
                )
                connection.execute(
                    "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("child-id", "Child title", None, "Child preview", "F:/project", 1, 2, 0),
                )

            store = CodexHistoryStore(codex_home)
            threads = {thread["id"]: thread for thread in store.list_threads()}
            self.assertEqual({"main-id", "child-id"}, set(threads))
            self.assertEqual("Child title", threads["child-id"]["name"])
            self.assertEqual(2, threads["child-id"]["updatedAt"])
            self.assertEqual("child-id", store.read_thread("child-id")["id"])
            self.assertEqual("child-id", store.read_thread("child-id")["sessionId"])

    def test_lists_archived_session_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            archived = codex_home / "archived_sessions"
            archived.mkdir()
            (archived / "rollout-archived-id.jsonl").write_text(
                json.dumps({"type": "session_meta", "payload": {"id": "archived-id"}}) + "\n",
                encoding="utf-8",
            )
            store = CodexHistoryStore(codex_home)
            self.assertEqual(["archived-id"], [thread["id"] for thread in store.list_threads()])
            self.assertTrue(store.list_threads()[0]["archived"])
            self.assertEqual("archived-id", store.read_thread("archived-id")["id"])

    def test_ignores_index_entries_without_session_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            (codex_home / "session_index.jsonl").write_text(
                json.dumps({"id": "missing-id", "thread_name": "Missing"}) + "\n",
                encoding="utf-8",
            )
            self.assertEqual([], CodexHistoryStore(codex_home).list_threads())

    def test_lists_index_entries_and_reads_jsonl_turns(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            session_dir = codex_home / "sessions" / "2026" / "10" / "01"
            session_dir.mkdir(parents=True)
            session_id = "01test-session"
            session_path = session_dir / "rollout-2026-10-01T12-00-00-01test-session.jsonl"
            lines = [
                {"timestamp": "2026-10-01T04:00:00Z", "type": "session_meta", "payload": {"session_id": session_id, "cwd": "F:\\\\1code", "originator": "codex_vscode"}},
                {"timestamp": "2026-10-01T04:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn-1", "item": {"type": "UserMessage", "id": "item-1", "content": [{"type": "text", "text": "你好"}]}}},
                {"timestamp": "2026-10-01T04:00:02Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn-1", "item": {"type": "AgentMessage", "id": "item-2", "content": [{"type": "Text", "text": "你好，我在。"}]}}},
                {"timestamp": "2026-10-01T04:00:03Z", "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "completed_at": "2026-10-01T04:00:03Z"}},
            ]
            session_path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8")
            (codex_home / "session_index.jsonl").write_text(json.dumps({"id": session_id, "thread_name": "测试会话", "updated_at": "2026-10-01T04:00:03Z"}, ensure_ascii=False) + "\n", encoding="utf-8")

            store = CodexHistoryStore(codex_home)
            threads = store.list_threads()
            self.assertEqual([session_id], [thread["id"] for thread in threads])
            self.assertEqual("测试会话", threads[0]["name"])

            thread = store.read_thread(session_id)
            self.assertIsNotNone(thread)
            assert thread is not None
            self.assertEqual("F:\\\\1code", thread["cwd"])
            self.assertEqual(1, len(thread["turns"]))
            self.assertEqual("userMessage", thread["turns"][0]["items"][0]["type"])
            self.assertEqual("agentMessage", thread["turns"][0]["items"][1]["type"])
            self.assertEqual("你好，我在。", thread["turns"][0]["items"][1]["text"])

    def test_reads_message_events_without_turn_ids_in_active_turn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            session_dir = codex_home / "sessions" / "2026" / "10" / "12"
            session_dir.mkdir(parents=True)
            session_id = "event-format-session"
            session_path = session_dir / "rollout-event-format-session.jsonl"
            lines = [
                {"timestamp": "2026-10-12T02:36:42Z", "type": "session_meta", "payload": {"id": session_id, "cwd": "F:/project"}},
                {"timestamp": "2026-10-12T02:36:43Z", "type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-1", "root_turn_id": "turn-1"}},
                {"timestamp": "2026-10-12T02:36:43Z", "type": "event_msg", "payload": {"type": "user_message", "client_id": "user-1", "message": "读取不到聊天", "images": ["data:image/png;base64,aGVsbG8="]}},
                {"timestamp": "2026-10-12T02:36:53Z", "type": "event_msg", "payload": {"type": "agent_message", "message": "正在检查历史解析。", "phase": "commentary"}},
                {"timestamp": "2026-10-12T02:36:53Z", "type": "response_item", "payload": {"type": "message", "id": "assistant-1", "role": "assistant", "content": [{"type": "output_text", "text": "正在检查历史解析。"}]}},
                {"timestamp": "2026-10-12T02:37:00Z", "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "completed_at": "2026-10-12T02:37:00Z"}},
            ]
            session_path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8")

            thread = CodexHistoryStore(codex_home).read_thread(session_id)

            self.assertIsNotNone(thread)
            assert thread is not None
            self.assertEqual("读取不到聊天", thread["preview"])
            self.assertEqual("completed", thread["turns"][0]["status"])
            self.assertEqual(
                [("userMessage", [{"type": "text", "text": "读取不到聊天"}, {"type": "localImage", "name": "image-1", "mediaType": "image/png", "data": "aGVsbG8="}]), ("agentMessage", "正在检查历史解析。")],
                [(item["type"], item.get("content", item.get("text"))) for item in thread["turns"][0]["items"]],
            )

    def test_normalizes_native_local_image_history_items(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            session_dir = codex_home / "sessions" / "2026" / "10" / "14"
            session_dir.mkdir(parents=True)
            session_path = session_dir / "rollout-native-image.jsonl"
            lines = [
                {"type": "session_meta", "payload": {"id": "native-image-session"}},
                {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-image"}},
                {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn-image", "item": {
                    "type": "UserMessage",
                    "id": "user-image",
                    "content": [
                        {"type": "text", "text": "图片消息"},
                        {"type": "local_image", "path": "C:/Users/user/AppData/Local/Temp/codex-clipboard-example.png"},
                        {"type": "image", "image_url": "data:image/png;base64,aGVsbG8="},
                    ],
                }}},
            ]
            session_path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")

            thread = CodexHistoryStore(codex_home).read_thread("native-image-session")

            assert thread is not None
            content = thread["turns"][0]["items"][0]["content"]
            self.assertEqual("localImage", content[1]["type"])
            self.assertEqual("codex-clipboard-example.png", content[1]["name"])
            self.assertEqual("image/png", content[1]["mediaType"])
            self.assertEqual("image", content[2]["type"])
            self.assertEqual("data:image/png;base64,aGVsbG8=", content[2]["image_url"])

    def test_embeds_only_codex_clipboard_images_from_system_temp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clipboard_image = root / "codex-clipboard-example.png"
            clipboard_image.write_bytes(b"image-bytes")
            unrelated_image = root / "private-image.png"
            unrelated_image.write_bytes(b"private-bytes")
            thread = {"turns": [{"items": [{"type": "userMessage", "content": [
                {"type": "localImage", "path": str(clipboard_image)},
                {"type": "localImage", "path": str(unrelated_image)},
            ]}]}]}

            with patch("codex_remote.app.tempfile.gettempdir", return_value=directory):
                enrich_thread_images(thread, root / "remote-images")

            content = thread["turns"][0]["items"][0]["content"]
            self.assertEqual("aW1hZ2UtYnl0ZXM=", content[0]["data"])
            self.assertEqual("image/png", content[0]["mediaType"])
            self.assertNotIn("data", content[1])

    def test_embeds_allowed_clipboard_image_in_live_user_event_item(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clipboard_image = root / "codex-clipboard-live.png"
            clipboard_image.write_bytes(b"live-image")
            item = {
                "type": "userMessage",
                "content": [{"type": "local_image", "path": str(clipboard_image)}],
            }

            with patch("codex_remote.app.tempfile.gettempdir", return_value=directory):
                enriched = enrich_user_message_item(item, root / "remote-images")

            self.assertEqual("bGl2ZS1pbWFnZQ==", enriched["content"][0]["data"])


if __name__ == "__main__":
    unittest.main()
