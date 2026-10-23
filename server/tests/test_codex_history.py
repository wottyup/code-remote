from __future__ import annotations

import base64
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from codex_remote.app import (
    TurnImage,
    MESSAGE_IMAGE_RETENTION_SECONDS,
    cleanup_expired_message_images,
    detect_image_media_type,
    enrich_thread_images,
    enrich_user_message_item,
    prepare_message_image_directory,
    save_turn_images,
    workspace_image_preview,
)
from codex_remote.codex_history import CodexHistoryStore


class CodexHistoryStoreTests(unittest.TestCase):
    def test_compact_history_keeps_async_questions_before_turn_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            sessions = codex_home / "sessions"
            sessions.mkdir()
            questions = [{"title": "选择接下来的处理方式", "options": ["继续修改", "先查看效果"]}]
            events = [
                {"type": "session_meta", "payload": {"id": "question-thread"}},
                {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn", "item": {
                    "type": "AgentMessage", "id": "call-question", "phase": "final_answer", "delivery": "async",
                    "questions": questions, "content": [{"type": "Text", "text": "选择接下来的处理方式\n- 继续修改\n- 先查看效果"}],
                }}},
                {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn", "item": {
                    "type": "AgentMessage", "id": "progress", "content": [{"type": "Text", "text": "我继续检查其他模块。"}],
                }}},
            ]
            (sessions / "rollout-question-thread.jsonl").write_text(
                "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events), encoding="utf-8",
            )
            thread = CodexHistoryStore(codex_home).read_thread("question-thread", compact=True)
            self.assertEqual(thread["turns"][0]["status"], "inProgress")
            question = thread["turns"][0]["items"][0]
            self.assertEqual(question["questions"], questions)
            self.assertEqual(question["delivery"], "async")
            self.assertEqual(question["phase"], "final_answer")
            self.assertEqual(thread["turns"][0]["items"][1]["id"], "progress")

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

    def test_reads_recent_turns_from_synced_projection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            session_dir = codex_home / "sessions" / "2026" / "10" / "16"
            session_dir.mkdir(parents=True)
            session_id = "projected-tail-session"
            session_path = session_dir / "rollout-projected-tail-session.jsonl"
            session_path.write_text(json.dumps({
                "timestamp": "2026-10-16T01:00:00Z",
                "type": "session_meta",
                "payload": {"id": session_id, "cwd": "/workspace"},
            }) + "\n", encoding="utf-8")
            (codex_home / "session_index.jsonl").write_text(json.dumps({
                "id": session_id,
                "thread_name": "投影会话",
                "updated_at": "2026-10-16T01:03:00Z",
            }, ensure_ascii=False) + "\n", encoding="utf-8")

            with closing(sqlite3.connect(codex_home / "thread_history_1.sqlite")) as connection, connection:
                connection.executescript("""
                    CREATE TABLE thread_history_projection_state (
                        thread_id TEXT PRIMARY KEY,
                        next_rollout_byte_offset INTEGER NOT NULL,
                        next_rollout_ordinal INTEGER NOT NULL
                    );
                    CREATE TABLE thread_turns (
                        thread_id TEXT NOT NULL,
                        turn_id TEXT NOT NULL,
                        rollout_ordinal INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        error_json TEXT,
                        started_at INTEGER,
                        completed_at INTEGER,
                        duration_ms INTEGER,
                        first_user_item_id TEXT,
                        final_agent_item_id TEXT,
                        rollout_byte_offset INTEGER,
                        rollout_end_ordinal INTEGER,
                        rollout_end_byte_offset INTEGER,
                        root_turn_id TEXT,
                        PRIMARY KEY (thread_id, turn_id)
                    );
                    CREATE TABLE thread_items (
                        thread_id TEXT NOT NULL,
                        turn_id TEXT NOT NULL,
                        item_id TEXT NOT NULL,
                        rollout_ordinal INTEGER NOT NULL,
                        created_at_ms INTEGER NOT NULL,
                        item_json TEXT NOT NULL,
                        item_type TEXT NOT NULL DEFAULT '',
                        updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (thread_id, turn_id, item_id)
                    );
                """)
                connection.execute(
                    "INSERT INTO thread_history_projection_state VALUES (?, ?, ?)",
                    (session_id, session_path.stat().st_size, 10),
                )
                for index in range(1, 4):
                    turn_id = f"turn-{index}"
                    connection.execute(
                        "INSERT INTO thread_turns "
                        "(thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (session_id, turn_id, index * 10, "completed", 1_792_099_200 + index, 1_792_099_210 + index, 10_000),
                    )
                    for item_offset, item in enumerate((
                        {"type": "UserMessage", "id": f"user-{index}", "content": [{"type": "text", "text": f"问题 {index}"}]},
                        {"type": "AgentMessage", "id": f"agent-{index}", "text": f"回答 {index}"},
                    )):
                        connection.execute(
                            "INSERT INTO thread_items "
                            "(thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (session_id, turn_id, item["id"], index * 10 + item_offset, 1_792_099_200_000 + index, json.dumps(item), item["type"]),
                        )

            thread = CodexHistoryStore(codex_home).read_thread(session_id, tail_turns=2)

            self.assertIsNotNone(thread)
            assert thread is not None
            self.assertEqual(["turn-2", "turn-3"], [turn["id"] for turn in thread["turns"]])
            self.assertEqual(3, thread["totalTurns"])
            self.assertTrue(thread["historyPartial"])
            self.assertTrue(thread["historyWindowed"])
            self.assertEqual("问题 3", thread["preview"])
            self.assertEqual("userMessage", thread["turns"][-1]["items"][0]["type"])

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

    def test_previews_allowed_clipboard_image_by_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            clipboard_image = root / "codex-clipboard-preview.png"
            clipboard_image.write_bytes(b"\x89PNG\r\n\x1a\npreview")

            with patch("codex_remote.app.tempfile.gettempdir", return_value=directory):
                preview = workspace_image_preview(workspace, str(clipboard_image), root / "remote-images")

            self.assertEqual("image/png", preview["mediaType"])
            self.assertEqual("iVBORw0KGgpwcmV2aWV3", preview["data"])

    def test_image_preview_uses_file_signature_when_suffix_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            image = workspace / "copied-from-phone.png"
            content = b"\xff\xd8\xff" + b"jpeg-payload"
            image.write_bytes(content)

            preview = workspace_image_preview(workspace, image.name)

            self.assertEqual("image/jpeg", preview["mediaType"])
            self.assertEqual(base64.b64encode(content).decode("ascii"), preview["data"])

    def test_detects_heif_family_images_for_android_preview(self) -> None:
        self.assertEqual("image/heic", detect_image_media_type(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic"))
        self.assertEqual("image/avif", detect_image_media_type(b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avif"))

    def test_expired_persistent_images_are_not_embedded_or_previewed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_directory = prepare_message_image_directory(root)
            image_path = image_directory / "expired.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nexpired-image")
            expired_at = time.time() - MESSAGE_IMAGE_RETENTION_SECONDS - 1
            os.utime(image_path, (expired_at, expired_at))
            thread = {"turns": [{"items": [{"type": "userMessage", "content": [
                {"type": "localImage", "path": str(image_path), "mediaType": "image/png"},
            ]}]}]}

            enrich_thread_images(thread, image_directory)

            content = thread["turns"][0]["items"][0]["content"][0]
            self.assertNotIn("data", content)
            with self.assertRaises(HTTPException) as error:
                workspace_image_preview(root, str(image_path), image_directory)
            self.assertEqual(404, error.exception.status_code)

    def test_cleanup_deletes_only_expired_managed_image_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image_directory = prepare_message_image_directory(Path(directory))
            now = 1_800_000_000.0
            expired = image_directory / "expired.png"
            expired.write_bytes(b"old")
            os.utime(expired, (now - MESSAGE_IMAGE_RETENTION_SECONDS - 1,) * 2)
            recent = image_directory / "recent.jpg"
            recent.write_bytes(b"new")
            os.utime(recent, (now - MESSAGE_IMAGE_RETENTION_SECONDS + 1,) * 2)
            unrelated = image_directory / "notes.txt"
            unrelated.write_text("keep", encoding="utf-8")

            removed = cleanup_expired_message_images(image_directory, now=now)

            self.assertEqual(1, removed)
            self.assertFalse(expired.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(unrelated.exists())

    def test_upload_cleans_expired_images_before_checking_storage_quota(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image_directory = prepare_message_image_directory(Path(directory))
            expired = image_directory / "expired.png"
            expired.write_bytes(b"old-image")
            expired_at = time.time() - MESSAGE_IMAGE_RETENTION_SECONDS - 1
            os.utime(expired, (expired_at, expired_at))
            image = TurnImage(
                media_type="image/png",
                data=base64.b64encode(b"new-image").decode("ascii"),
            )

            saved = save_turn_images(
                [image], image_directory,
                max_storage_bytes=len(b"new-image"),
                storage_lock=threading.Lock(),
            )

            self.assertFalse(expired.exists())
            self.assertEqual([b"new-image"], [path.read_bytes() for path in saved])

    def test_persistent_image_quota_rejects_new_image_without_deleting_old_ones(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            image_directory = prepare_message_image_directory(state_directory)
            existing = image_directory / "old.png"
            existing.write_bytes(b"old-image")
            image = TurnImage(
                media_type="image/png",
                data=base64.b64encode(b"new-image").decode("ascii"),
            )

            with self.assertRaises(HTTPException) as error:
                save_turn_images(
                    [image], image_directory,
                    max_storage_bytes=existing.stat().st_size + 1,
                    storage_lock=threading.Lock(),
                )

            self.assertEqual(507, error.exception.status_code)
            self.assertEqual(b"old-image", existing.read_bytes())
            self.assertEqual([existing], list(image_directory.iterdir()))


if __name__ == "__main__":
    unittest.main()
