from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_PREVIEW_LENGTH = 4_000
SUMMARY_SCAN_LINES = 120


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
        self.session_index = self.codex_home / "session_index.jsonl"
        self._path_index: dict[str, Path] | None = None
        self._index_entries: dict[str, dict[str, Any]] | None = None

    def list_threads(self) -> list[dict[str, Any]]:
        entries = self._load_index_entries()
        path_index = self._load_path_index()
        threads: dict[str, dict[str, Any]] = {}

        for session_id, entry in entries.items():
            threads[session_id] = self._thread_summary(session_id, entry, path_index.get(session_id))

        indexed_ids = set(threads)
        for session_id, path in path_index.items():
            if session_id in indexed_ids:
                continue
            summary = self._read_file_summary(path)
            if summary is None:
                continue
            root_id = summary.get("session_id") or session_id
            if not isinstance(root_id, str) or root_id in threads:
                continue
            threads[root_id] = self._thread_summary(root_id, summary, path)

        return list(threads.values())

    def invalidate(self) -> None:
        self._path_index = None
        self._index_entries = None

    def read_thread(self, thread_id: str) -> dict[str, Any] | None:
        path = self._load_path_index().get(thread_id)
        if path is None:
            return None

        entries = self._load_index_entries()
        index_entry = entries.get(thread_id, {})
        turns: dict[str, dict[str, Any]] = {}
        turn_order: list[str] = []
        session_meta: dict[str, Any] = {}
        latest_time: str | None = None
        latest_user_text = ""
        first_time: str | None = None
        model: str | None = None

        try:
            lines = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            return None

        with lines:
            for raw_line in lines:
                try:
                    envelope = json.loads(raw_line)
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
                    item_id = normalised.get("id")
                    if isinstance(item_id, str) and any(existing.get("id") == item_id for existing in turn["items"]):
                        continue
                    turn["items"].append(normalised)
                    if normalised.get("type") == "userMessage":
                        text = _text_from_content(normalised.get("content"))
                        if text:
                            latest_user_text = text
                elif event_type == "task_complete":
                    turn["status"] = "completed"
                    turn["completedAt"] = _iso_time(payload.get("completed_at")) or timestamp
                    turn["durationMs"] = payload.get("duration_ms")
                elif event_type in {"turn_aborted", "turn_failed"}:
                    turn["status"] = "failed"
                    turn["completedAt"] = timestamp

        turns_list = [turns[turn_id] for turn_id in turn_order]
        session_id = session_meta.get("session_id") or session_meta.get("id") or thread_id
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
        }

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
        if self.sessions.is_dir():
            for path in self.sessions.rglob("*.jsonl"):
                try:
                    with path.open("r", encoding="utf-8", errors="replace") as handle:
                        first_line = handle.readline()
                    envelope = json.loads(first_line)
                except (OSError, json.JSONDecodeError):
                    continue
                payload = envelope.get("payload") if isinstance(envelope, dict) else None
                if not isinstance(payload, dict):
                    continue
                session_id = payload.get("session_id")
                file_id = payload.get("id")
                for candidate in (session_id, file_id):
                    if not isinstance(candidate, str):
                        continue
                    previous = paths.get(candidate)
                    if previous is None or candidate == file_id:
                        paths[candidate] = path
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
