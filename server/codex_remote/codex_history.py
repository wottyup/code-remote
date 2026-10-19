from __future__ import annotations

import json
import logging
import mimetypes
import sqlite3
import threading
from collections import OrderedDict
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .browser_payload import browser_item


MAX_PREVIEW_LENGTH = 4_000
SUMMARY_SCAN_LINES = 120
logger = logging.getLogger(__name__)


def _short_text(value: str, limit: int = MAX_PREVIEW_LENGTH) -> str:
    text = " ".join(value.split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for part in value:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def _iso_time(value: Any) -> str | None:
    if isinstance(value, str):
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return value
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1_000
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _event_time(envelope: dict[str, Any], payload: dict[str, Any]) -> str | None:
    result = _iso_time(envelope.get("timestamp"))
    if result:
        return result
    for key in ("completed_at_ms", "started_at_ms", "completed_at", "started_at"):
        result = _iso_time(payload.get(key))
        if result:
            return result
    return None


def _normalise_item(item: dict[str, Any]) -> dict[str, Any]:
    result = dict(item)
    item_type = item.get("type")
    type_map = {
        "UserMessage": "userMessage",
        "AgentMessage": "agentMessage",
        "Reasoning": "reasoning",
        "FileChange": "fileChange",
        "CommandExecution": "commandExecution",
        "McpToolCall": "mcpToolCall",
    }
    if isinstance(item_type, str):
        result["type"] = type_map.get(item_type, item_type[:1].lower() + item_type[1:])
    content = result.get("content")
    if isinstance(content, list) and result.get("type") == "userMessage":
        normalized_content: list[Any] = []
        for part in content:
            if not isinstance(part, dict) or part.get("type") not in {"local_image", "localImage"}:
                normalized_content.append(part)
                continue
            normalized_part = {**part, "type": "localImage"}
            image_path = part.get("path")
            if isinstance(image_path, str):
                normalized_part.setdefault("name", Path(image_path).name)
                media_type, _ = mimetypes.guess_type(image_path)
                if media_type in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                    normalized_part.setdefault("mediaType", media_type)
            normalized_content.append(normalized_part)
        result["content"] = normalized_content
    if result.get("type") == "agentMessage" and not isinstance(result.get("text"), str):
        text = _text_from_content(result.get("content"))
        if text:
            result["text"] = text
    return result


class CodexHistoryStore:
    """Read Codex's on-disk session index and JSONL history as a compatibility fallback."""

    def __init__(self, codex_home: Path) -> None:
        self.codex_home = codex_home.expanduser().resolve()
        self.sessions = self.codex_home / "sessions"
        self.archived_sessions = self.codex_home / "archived_sessions"
        self.session_index = self.codex_home / "session_index.jsonl"
        self.state_index = self.codex_home / "state_5.sqlite"
        self.history_index = self.codex_home / "thread_history_1.sqlite"
        self._path_index: dict[str, Path] | None = None
        self._index_entries: dict[str, dict[str, Any]] | None = None
        self._projection_lock = threading.RLock()
        self._browser_items: OrderedDict[tuple[str, str, str, int], dict[str, Any]] = OrderedDict()

    def list_threads(self) -> list[dict[str, Any]]:
        entries = self._load_index_entries()
        path_index = self._load_path_index()
        threads = self._load_state_threads(path_index)

        for session_id, entry in entries.items():
            path = path_index.get(session_id)
            if path is not None:
                threads.setdefault(session_id, self._thread_summary(session_id, entry, path))

        for session_id, path in path_index.items():
            if session_id in threads:
                continue
            summary = self._read_file_summary(path)
            if summary is None:
                continue
            file_id = summary.get("id") or summary.get("session_id") or session_id
            if not isinstance(file_id, str) or file_id in threads:
                continue
            thread = self._thread_summary(file_id, summary, path)
            if path.is_relative_to(self.archived_sessions):
                thread["archived"] = True
            threads[file_id] = thread

        return list(threads.values())

    def _load_state_threads(self, path_index: dict[str, Path]) -> dict[str, dict[str, Any]]:
        """Read the desktop sidebar index without modifying Codex's database."""
        if not self.state_index.is_file():
            return {}
        try:
            with closing(sqlite3.connect(f"file:{self.state_index.as_posix()}?mode=ro", uri=True, timeout=5)) as connection:
                rows = connection.execute(
                    "SELECT id, title, name, preview, cwd, created_at_ms, updated_at_ms, archived "
                    "FROM threads"
                ).fetchall()
        except sqlite3.Error:
            return {}
        threads: dict[str, dict[str, Any]] = {}
        for thread_id, title, name, preview, cwd, created_at, updated_at, archived in rows:
            if not isinstance(thread_id, str):
                continue
            path = path_index.get(thread_id)
            if path is None:
                continue
            display_name = next((value for value in (name, title, preview) if isinstance(value, str) and value.strip()), thread_id)
            threads[thread_id] = {
                "id": thread_id,
                "sessionId": thread_id,
                "name": display_name,
                "preview": preview if isinstance(preview, str) else "",
                "cwd": cwd if isinstance(cwd, str) else None,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "path": str(path),
                "archived": bool(archived),
                "status": {"type": "notLoaded"},
            }
        return threads

    def invalidate(self) -> None:
        self._path_index = None
        self._index_entries = None

    def thread_revision(self, thread_id: str) -> str | None:
        path = self._load_path_index().get(thread_id)
        if path is None:
            return None
        try:
            info = path.stat()
        except OSError:
            return None
        return f"{info.st_mtime_ns}:{info.st_size}"

    def delete_thread(self, thread_id: str) -> bool:
        path = self._load_path_index().get(thread_id)
        if path is None:
            return False
        try:
            resolved = path.resolve(strict=True)
            if not any(resolved.is_relative_to(root.resolve()) for root in (self.sessions, self.archived_sessions)):
                raise OSError("聊天记录路径超出 Codex 历史目录")
            path.unlink()
        except OSError as error:
            raise OSError(f"无法删除 Codex 聊天记录：{error}") from error

        self.invalidate()
        self._delete_thread_database_rows(self.state_index, thread_id, {
            "thread_spawn_edges": "parent_thread_id = ? OR child_thread_id = ?",
            "threads": "id = ?",
        })
        self._delete_thread_database_rows(self.codex_home / "thread_history_1.sqlite", thread_id, {
            "thread_items": "thread_id = ?",
            "thread_realtime_items": "thread_id = ?",
            "thread_turns": "thread_id = ?",
            "thread_history_projection_state": "thread_id = ?",
        })
        return True

    @staticmethod
    def _delete_thread_database_rows(path: Path, thread_id: str, filters: dict[str, str]) -> None:
        if not path.is_file():
            return
        try:
            with closing(sqlite3.connect(path, timeout=30)) as connection:
                with connection:
                    connection.execute("PRAGMA foreign_keys = ON")
                    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                    for table, condition in filters.items():
                        if table not in tables:
                            continue
                        parameters = (thread_id, thread_id) if condition.count("?") == 2 else (thread_id,)
                        connection.execute(f"DELETE FROM {table} WHERE {condition}", parameters)
        except sqlite3.Error:
            # The rollout is the source of truth and is already gone. A
            # running desktop process may temporarily hold an index lock.
            logger.warning("Could not remove deleted thread %s from %s", thread_id, path, exc_info=True)

    def read_thread(self, thread_id: str, *, tail_turns: int | None = None, compact: bool = False) -> dict[str, Any] | None:
        path = self._load_path_index().get(thread_id)
        if path is None:
            return None

        entries = self._load_index_entries()
        index_entry = entries.get(thread_id, {})
        try:
            source_stat = path.stat()
        except OSError:
            return None
        source_revision = f"{source_stat.st_mtime_ns}:{source_stat.st_size}"
        projected = None
        if tail_turns is not None or compact:
            with self._projection_lock:
                projected = self._read_projected_tail(thread_id, path, index_entry, tail_turns, compact=compact)
        offset = projected.pop("_rolloutOffset") if projected is not None else 0
        if projected is not None and offset == source_stat.st_size:
            return {**projected, "historyRevision": source_revision}
        turns: dict[str, dict[str, Any]] = {turn["id"]: turn for turn in projected["turns"]} if projected else {}
        turn_order: list[str] = list(turns)
        projected_turn_count = len(turns)
        session_meta: dict[str, Any] = (self._read_file_summary(path) or {}) if projected else {}
        latest_time: str | None = projected.get("updatedAt") if projected else None
        latest_user_text = projected.get("preview", "") if projected else ""
        first_time: str | None = None
        model: str | None = None
        active_turn_id: str | None = turn_order[-1] if turn_order else None

        try:
            lines = path.open("rb")
            lines.seek(offset)
        except OSError:
            return None

        with lines:
            for raw_line in lines:
                # A writer may have only appended part of the next JSONL record.
                if not raw_line.endswith(b"\n"):
                    break
                try:
                    envelope = json.loads(raw_line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    continue
                if not isinstance(envelope, dict):
                    continue
                payload = envelope.get("payload")
                if not isinstance(payload, dict):
                    payload = {}
                timestamp = _event_time(envelope, payload)
                if timestamp:
                    first_time = first_time or timestamp
                    latest_time = timestamp

                if envelope.get("type") == "session_meta":
                    session_meta = payload
                    continue
                if envelope.get("type") == "turn_context":
                    candidate_model = payload.get("model")
                    if isinstance(candidate_model, str) and candidate_model:
                        model = candidate_model

                event_type = payload.get("type")
                turn_id = payload.get("turn_id")
                if event_type == "task_started":
                    active_turn_id = turn_id if isinstance(turn_id, str) else None
                elif event_type in {"user_message", "agent_message"} and not isinstance(turn_id, str):
                    # Recent Codex JSONL logs omit turn_id from message events;
                    # associate them with the task_started event currently in flight.
                    turn_id = active_turn_id
                if not isinstance(turn_id, str):
                    continue
                turn = turns.get(turn_id)
                if turn is None:
                    turn = {
                        "id": turn_id,
                        "rootTurnId": payload.get("root_turn_id"),
                        "items": [],
                        "status": "inProgress",
                        "error": None,
                        "startedAt": timestamp,
                        "completedAt": None,
                        "durationMs": None,
                    }
                    turns[turn_id] = turn
                    turn_order.append(turn_id)
                elif turn.get("startedAt") is None and timestamp:
                    turn["startedAt"] = timestamp

                if event_type == "item_completed":
                    item = payload.get("item")
                    if not isinstance(item, dict):
                        continue
                    normalised = _normalise_item(item)
                    normalised.setdefault("createdAt", timestamp)
                    if compact:
                        if normalised.get("type") in {"reasoning", "plan"}:
                            continue
                        normalised = browser_item(normalised)
                    item_id = normalised.get("id")
                    existing_index = next((index for index, existing in enumerate(turn["items"])
                                           if isinstance(item_id, str) and existing.get("id") == item_id), None)
                    if existing_index is None:
                        turn["items"].append(normalised)
                    else:
                        turn["items"][existing_index] = normalised
                    if normalised.get("type") == "userMessage":
                        text = _text_from_content(normalised.get("content"))
                        if text:
                            latest_user_text = text
                elif event_type == "user_message":
                    message = payload.get("message")
                    message = message if isinstance(message, str) else ""
                    content: list[dict[str, Any]] = []
                    if message:
                        content.append({"type": "text", "text": message})
                    images = payload.get("images")
                    if isinstance(images, list):
                        for index, image in enumerate(images):
                            if not isinstance(image, str) or not image.startswith("data:image/"):
                                continue
                            header, separator, data = image.partition(",")
                            if not separator or ";base64" not in header:
                                continue
                            media_type = header[5:].split(";", 1)[0]
                            content.append({
                                "type": "localImage",
                                "name": f"image-{index + 1}",
                                "mediaType": media_type,
                                "data": data,
                            })
                    client_id = payload.get("client_id")
                    turn["items"].append({
                        "type": "userMessage",
                        "id": client_id if isinstance(client_id, str) else f"{turn_id}-user-{len(turn['items'])}",
                        "content": content,
                        "createdAt": timestamp,
                    })
                    if message:
                        latest_user_text = message
                elif event_type == "agent_message":
                    message = payload.get("message")
                    if isinstance(message, str) and message:
                        turn["items"].append({
                            "type": "agentMessage",
                            "id": f"{turn_id}-agent-{len(turn['items'])}",
                            "text": message,
                            "phase": payload.get("phase"),
                            "createdAt": timestamp,
                        })
                elif event_type == "task_complete":
                    turn["status"] = "completed"
                    turn["completedAt"] = _iso_time(payload.get("completed_at")) or timestamp
                    turn["durationMs"] = payload.get("duration_ms")
                    if active_turn_id == turn_id:
                        active_turn_id = None
                elif event_type in {"turn_aborted", "turn_failed"}:
                    turn["status"] = "interrupted" if event_type == "turn_aborted" else "failed"
                    turn["completedAt"] = timestamp
                    if active_turn_id == turn_id:
                        active_turn_id = None

        turns_list = [turns[turn_id] for turn_id in turn_order]
        total_turns = (projected["totalTurns"] - projected_turn_count if projected else 0) + len(turns_list)
        if tail_turns is not None:
            turns_list = turns_list[-max(1, min(int(tail_turns), 100)):]
        session_id = session_meta.get("id") or thread_id
        cwd = session_meta.get("cwd")
        title = index_entry.get("thread_name")
        if not isinstance(title, str) or not title.strip():
            title = _short_text(latest_user_text, 240) or thread_id
        updated_at = index_entry.get("updated_at") if isinstance(index_entry.get("updated_at"), str) else latest_time
        created_at = session_meta.get("timestamp") if isinstance(session_meta.get("timestamp"), str) else first_time
        return {
            "id": thread_id,
            "sessionId": session_id,
            "name": title,
            "preview": _short_text(latest_user_text or title),
            "cwd": cwd if isinstance(cwd, str) else None,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "path": str(path),
            "originator": session_meta.get("originator"),
            "source": session_meta.get("source"),
            "cliVersion": session_meta.get("cli_version"),
            "model": model,
            "status": {"type": turns_list[-1].get("status", "completed")} if turns_list else {"type": "notLoaded"},
            "turns": turns_list,
            "historyRevision": source_revision,
            **({"historyWindowed": True, "totalTurns": total_turns,
                "historyPartial": total_turns > len(turns_list)} if tail_turns is not None else {}),
        }

    def _read_projected_tail(
        self,
        thread_id: str,
        path: Path,
        index_entry: dict[str, Any],
        limit: int | None,
        *,
        compact: bool = False,
    ) -> dict[str, Any] | None:
        """Read a bounded history window from Codex's own rollout projection.

        The caller replays every complete JSONL record beyond the projection's
        offset. A byte-size threshold cannot decide whether history is fresh.
        """
        if not self.history_index.is_file():
            return None
        bounded_limit = max(1, min(int(limit), 100)) if limit is not None else -1
        try:
            rollout_size = path.stat().st_size
            with closing(sqlite3.connect(
                f"file:{self.history_index.as_posix()}?mode=ro", uri=True, timeout=5,
            )) as connection:
                connection.row_factory = sqlite3.Row
                # Keep the cursor, turn headers and items on one SQLite snapshot.
                connection.execute("BEGIN")
                projection = connection.execute(
                    "SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ?",
                    (thread_id,),
                ).fetchone()
                if projection is None:
                    return None
                projection_offset = int(projection["next_rollout_byte_offset"])
                if projection_offset < 0 or projection_offset > rollout_size:
                    return None
                total_turns = int(connection.execute(
                    "SELECT COUNT(*) FROM thread_turns WHERE thread_id = ?",
                    (thread_id,),
                ).fetchone()[0])
                turn_rows = list(connection.execute(
                    """SELECT turn_id, rollout_ordinal, status, error_json, started_at,
                              completed_at, duration_ms, root_turn_id
                       FROM thread_turns
                       WHERE thread_id = ?
                       ORDER BY rollout_ordinal DESC
                       LIMIT ?""",
                    (thread_id, bounded_limit),
                ))
                if total_turns > 0 and not turn_rows:
                    return None
                turn_rows.reverse()
                turn_ids = [row["turn_id"] for row in turn_rows]
                items_by_turn: dict[str, list[dict[str, Any]]] = {turn_id: [] for turn_id in turn_ids}
                if turn_ids:
                    compact_filter = "AND lower(item_type) NOT IN ('reasoning', 'plan')" if compact else ""
                    payload_column = "" if compact else ", item_json"
                    item_rows = connection.execute(
                        f"""SELECT turn_id, item_id, created_at_ms, updated_at_ordinal {payload_column}
                            FROM thread_items
                            WHERE thread_id = ? AND turn_id IN (
                                SELECT turn_id FROM thread_turns WHERE thread_id = ?
                                ORDER BY rollout_ordinal DESC LIMIT ?
                            ) {compact_filter}
                            ORDER BY rollout_ordinal, updated_at_ordinal""",
                        (thread_id, thread_id, bounded_limit),
                    )
                    for row in item_rows:
                        key = (thread_id, row["turn_id"], row["item_id"], row["updated_at_ordinal"])
                        cached = self._browser_items.get(key) if compact else None
                        if cached is not None:
                            self._browser_items.move_to_end(key)
                            items_by_turn[row["turn_id"]].append(browser_item(cached))
                            continue
                        raw = connection.execute(
                            "SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?",
                            (thread_id, row["turn_id"], row["item_id"]),
                        ).fetchone()[0] if compact else row["item_json"]
                        try:
                            item = json.loads(raw)
                        except (json.JSONDecodeError, TypeError):
                            continue
                        if not isinstance(item, dict):
                            continue
                        normalized = _normalise_item(item)
                        normalized.setdefault("createdAt", _iso_time(row["created_at_ms"]))
                        if compact:
                            normalized = browser_item(normalized)
                            self._browser_items[key] = normalized
                            while len(self._browser_items) > 20_000:
                                self._browser_items.popitem(last=False)
                        items_by_turn[row["turn_id"]].append(browser_item(normalized) if compact else normalized)
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return None

        turns: list[dict[str, Any]] = []
        latest_time: str | None = None
        for row in turn_rows:
            error: Any = None
            if isinstance(row["error_json"], str) and row["error_json"]:
                try:
                    error = json.loads(row["error_json"])
                except json.JSONDecodeError:
                    error = row["error_json"]
            started_at = _iso_time(row["started_at"])
            completed_at = _iso_time(row["completed_at"])
            latest_time = completed_at or started_at or latest_time
            turns.append({
                "id": row["turn_id"],
                "rootTurnId": row["root_turn_id"],
                "items": items_by_turn.get(row["turn_id"], []),
                "status": row["status"],
                "error": error,
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": row["duration_ms"],
            })

        session_meta = self._read_file_summary(path) or {}
        latest_user_text = ""
        for turn in reversed(turns):
            for item in reversed(turn["items"]):
                if item.get("type") != "userMessage":
                    continue
                latest_user_text = _text_from_content(item.get("content"))
                if latest_user_text:
                    break
            if latest_user_text:
                break
        title = index_entry.get("thread_name")
        if not isinstance(title, str) or not title.strip():
            title = _short_text(latest_user_text, 240) or thread_id
        updated_at = index_entry.get("updated_at") if isinstance(index_entry.get("updated_at"), str) else latest_time
        created_at = session_meta.get("timestamp") if isinstance(session_meta.get("timestamp"), str) else None
        result: dict[str, Any] = {
            "id": thread_id,
            "sessionId": session_meta.get("id") or session_meta.get("session_id") or thread_id,
            "name": title,
            "preview": _short_text(latest_user_text or title),
            "cwd": session_meta.get("cwd") if isinstance(session_meta.get("cwd"), str) else None,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "path": str(path),
            "originator": session_meta.get("originator"),
            "source": session_meta.get("source"),
            "cliVersion": session_meta.get("cli_version"),
            "status": {"type": turns[-1].get("status", "completed")} if turns else {"type": "notLoaded"},
            "turns": turns,
            "totalTurns": total_turns,
            "_rolloutOffset": projection_offset,
        }
        if limit is not None:
            result["historyWindowed"] = True
            result["historyPartial"] = total_turns > len(turns)
        return result

    def _thread_summary(self, session_id: str, entry: dict[str, Any], path: Path | None) -> dict[str, Any]:
        title = entry.get("thread_name")
        if not isinstance(title, str) or not title.strip():
            title = session_id
        result: dict[str, Any] = {
            "id": session_id,
            "sessionId": session_id,
            "name": title,
            "preview": _short_text(title),
            "updatedAt": entry.get("updated_at") or entry.get("timestamp"),
            "createdAt": entry.get("created_at") or entry.get("timestamp"),
            "path": str(path) if path else None,
            "status": {"type": "notLoaded"},
        }
        return result

    def _load_index_entries(self) -> dict[str, dict[str, Any]]:
        if self._index_entries is not None:
            return self._index_entries
        entries: dict[str, dict[str, Any]] = {}
        try:
            lines = self.session_index.open("r", encoding="utf-8", errors="replace")
        except OSError:
            self._index_entries = entries
            return entries
        with lines:
            for raw_line in lines:
                try:
                    value = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(value, dict) or not isinstance(value.get("id"), str):
                    continue
                entries[value["id"]] = value
        self._index_entries = entries
        return entries

    def _load_path_index(self) -> dict[str, Path]:
        if self._path_index is not None:
            return self._path_index
        paths: dict[str, Path] = {}
        for directory in (self.sessions, self.archived_sessions):
            if not directory.is_dir():
                continue
            for path in directory.rglob("*.jsonl"):
                try:
                    with path.open("r", encoding="utf-8", errors="replace") as handle:
                        first_line = handle.readline()
                    envelope = json.loads(first_line)
                except (OSError, json.JSONDecodeError):
                    continue
                payload = envelope.get("payload") if isinstance(envelope, dict) else None
                if not isinstance(payload, dict):
                    continue
                file_id = payload.get("id") or payload.get("session_id")
                if isinstance(file_id, str):
                    paths[file_id] = path
        self._path_index = paths
        return paths

    def _read_file_summary(self, path: Path) -> dict[str, Any] | None:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for _ in range(SUMMARY_SCAN_LINES):
                    raw_line = handle.readline()
                    if not raw_line:
                        break
                    try:
                        envelope = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(envelope, dict):
                        continue
                    payload = envelope.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    if envelope.get("type") == "session_meta":
                        result = dict(payload)
                        result["path"] = str(path)
                        return result
        except OSError:
            return None
        return None
