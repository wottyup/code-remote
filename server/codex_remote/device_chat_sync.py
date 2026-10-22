"""Keep the room's bound Codex thread visible after a group turn ends."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from .device_chat_activity import project_activity

if TYPE_CHECKING:
    from .device_chat import DeviceChatManager

logger = logging.getLogger(__name__)
GROUP_PROMPT_PREFIX = "你正在通过 Code Remote 参加一个跨设备协作群聊。"
SYNC_INTERVAL = 0.35
FINISHED = {"completed", "interrupted", "failed"}


def _timestamp(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / 1000 if value > 10**12 else float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return 0.0


def _text(turn: dict[str, Any], kind: str) -> str:
    parts = []
    for item in turn.get("items", []):
        if item.get("type") != kind:
            continue
        if kind == "userMessage":
            text = "\n".join(part["text"] for part in item.get("content", [])
                             if isinstance(part, dict) and isinstance(part.get("text"), str))
        else:
            text = item.get("text", "")
        if text:
            parts.append(text)
    return "\n\n".join(parts)


class DeviceChatThreadSync:
    def __init__(self, manager: DeviceChatManager) -> None:
        self.manager = manager
        self.db = manager.connection
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS device_chat_sync_bindings (
                room_id TEXT NOT NULL, thread_id TEXT NOT NULL, since REAL NOT NULL,
                last_turn_id TEXT, PRIMARY KEY(room_id, thread_id)
            );
            CREATE TABLE IF NOT EXISTS device_chat_sync_turns (
                room_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
                origin TEXT NOT NULL, user_digest TEXT, assistant_digest TEXT,
                finished INTEGER NOT NULL DEFAULT 0, handoff_target TEXT,
                PRIMARY KEY(room_id, thread_id, turn_id)
            );
        """)
        self._task: asyncio.Task[None] | None = None
        self._queue: asyncio.Queue[dict[str, Any]] | None = None
        self._key: tuple[str, str] | None = None
        self._revision: str | None = None
        self._snapshots: dict[str, dict[str, Any]] = {}
        self._live: dict[str, dict[str, Any]] = {}
        self._eligible: set[str] = set()

    def binding(self) -> tuple[str, str] | None:
        config = self.manager._config()
        if not config:
            return None
        room_id = str(config["room"]["id"])
        thread_id = self.manager._thread_for_room(room_id)
        return (room_id, thread_id) if thread_id else None

    def bind(self, room_id: str, thread_id: str, previous: list[dict[str, Any]] | None = None) -> None:
        previous = previous or []
        since = min([float(int(time.time())), *[_timestamp(t.get("startedAt")) for t in previous
                    if t.get("status") not in FINISHED and _timestamp(t.get("startedAt"))]])
        self.db.execute(
            "INSERT INTO device_chat_sync_bindings(room_id,thread_id,since) VALUES (?,?,?) "
            "ON CONFLICT(room_id,thread_id) DO UPDATE SET since=excluded.since,last_turn_id=NULL",
            (room_id, thread_id, since),
        )
        # History timestamps can have second precision. Record existing ended
        # turns explicitly so a new turn in the same second is not lost.
        for turn in previous:
            if turn.get("status") in FINISHED and isinstance(turn.get("id"), str):
                self.db.execute("INSERT OR IGNORE INTO device_chat_sync_turns(room_id,thread_id,turn_id,origin) VALUES (?,?,?,'prior')",
                                (room_id, thread_id, turn["id"]))
        self._key = None

    def mark_group_turn(self, room_id: str, thread_id: str, turn_id: str) -> None:
        self.db.execute(
            "INSERT INTO device_chat_sync_turns(room_id,thread_id,turn_id,origin) VALUES (?,?,?,'group') "
            "ON CONFLICT(room_id,thread_id,turn_id) DO UPDATE SET origin='group' WHERE origin!='group'",
            (room_id, thread_id, turn_id),
        )

    async def start(self) -> None:
        if self._task is None:
            queue = await self.manager.codex.subscribe()
            self._queue = queue
            self._task = asyncio.create_task(self._run(queue))

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        if self._queue is not None:
            self.manager.codex.unsubscribe(self._queue)
            self._queue = None

    def _reset(self, key: tuple[str, str] | None) -> None:
        if key != self._key:
            self._key = key
            self._revision = None
            self._snapshots.clear()
            self._live.clear()
            self._eligible.clear()

    async def _run(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        deadline = time.monotonic()
        try:
            while True:
                self._reset(self.binding())
                if time.monotonic() >= deadline:
                    try:
                        await self.sync_history()
                        await self.flush_live()
                    except Exception:
                        logger.exception("Could not sync bound Codex thread to device chat")
                    deadline = time.monotonic() + SYNC_INTERVAL
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=max(0.001, deadline - time.monotonic()))
                    self.handle(event)
                except asyncio.TimeoutError:
                    pass
        finally:
            self.manager.codex.unsubscribe(queue)

    async def sync_history(self) -> None:
        key = self.binding()
        self._reset(key)
        if not key:
            return
        if self.manager._active_agent_thread_id == key[1]:
            return
        revision = self.manager.codex.thread_history_revision(key[1])
        if revision is not None and revision == self._revision:
            return
        binding = self.db.execute(
            "SELECT since,last_turn_id FROM device_chat_sync_bindings WHERE room_id=? AND thread_id=?", key,
        ).fetchone()
        thread = await self.manager.codex.read_thread(key[1], tail_turns=100 if binding else None, compact=True)
        if self.binding() != key:
            return
        turns = thread.get("turns", [])
        if binding and binding["last_turn_id"] and not any(t.get("id") == binding["last_turn_id"] for t in turns):
            thread = await self.manager.codex.read_thread(key[1], compact=True)
            if self.binding() != key:
                return
            turns = thread.get("turns", [])
        if not binding:
            # Existing installations had no binding timestamp. The first group
            # request after joining gives a conservative recovery boundary.
            member = self.db.execute("SELECT joined_at FROM device_chat_members WHERE id=?", (self.manager.node_id,)).fetchone()
            joined = _timestamp(member["joined_at"]) if member else 0
            starts = [_timestamp(t.get("startedAt")) for t in turns
                      if _text(t, "userMessage").startswith(GROUP_PROMPT_PREFIX)
                      and _timestamp(t.get("startedAt")) >= joined]
            since = min(starts) if starts else time.time()
            self.db.execute("INSERT INTO device_chat_sync_bindings(room_id,thread_id,since) VALUES (?,?,?)", (*key, since))
        else:
            since = float(binding["since"])
        self._snapshots = {t["id"]: t for t in turns if isinstance(t.get("id"), str)}
        workspace_changes = thread.get("codexRemoteWorkspaceChanges") or {}
        for turn in turns:
            if self.binding() != key:
                return
            turn_id = turn.get("id")
            if isinstance(workspace_changes, dict) and isinstance(workspace_changes.get(turn_id), list):
                turn = {**turn, "items": [*turn.get("items", []), {
                    "id": f"workspace-change-{turn_id}", "type": "fileChange", "status": "completed",
                    "changes": workspace_changes[turn_id],
                }]}
            if turn_id in self._live:
                if turn.get("status") not in FINISHED:
                    continue  # A persisted snapshot can lag live token deltas.
                self._live.pop(turn_id, None)
            if turn.get("status") not in FINISHED:
                self._eligible.add(turn_id)
            await self._sync_turn(key, since, turn)
        if self.binding() == key and self.manager._active_agent_thread_id != key[1]:
            latest = turns[-1].get("id") if turns else None
            if not binding or binding["last_turn_id"] != latest:
                self.db.execute("UPDATE device_chat_sync_bindings SET last_turn_id=? WHERE room_id=? AND thread_id=?",
                                (latest, *key))
            self._revision = revision

    def handle(self, notification: dict[str, Any]) -> None:
        key = self.binding()
        self._reset(key)
        params = notification.get("params") or {}
        if not key or params.get("threadId") != key[1]:
            return
        # The group executor already streams these turns using its reply ID.
        if self.manager._active_agent_thread_id == key[1]:
            return
        method = notification.get("method")
        if method not in {"turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "item/fileChange/patchUpdated", "turn/workspaceChanges"}:
            return
        snapshot = params.get("turn") or {}
        turn_id = params.get("turnId") or snapshot.get("id")
        if not isinstance(turn_id, str):
            return
        turn = self._live.setdefault(turn_id, copy.deepcopy(self._snapshots.get(turn_id, {
            "id": turn_id, "status": "inProgress", "items": [], "startedAt": datetime.now(timezone.utc).isoformat(),
        })))
        self._eligible.add(turn_id)
        if method in {"turn/started", "turn/completed"}:
            turn["status"] = snapshot.get("status", "completed" if method == "turn/completed" else "inProgress")
            for item in snapshot.get("items", []):
                self._put_item(turn, item)
        elif method == "item/agentMessage/delta":
            item_id = params.get("itemId") or "anonymous"
            item = next((i for i in turn["items"] if i.get("id") == item_id), None)
            if item is None:
                item = {"id": item_id, "type": "agentMessage", "text": ""}
                turn["items"].append(item)
            item["text"] += params.get("delta", "")
        else:
            if method in {"item/fileChange/patchUpdated", "turn/workspaceChanges"}:
                item_id = params.get("itemId") if method == "item/fileChange/patchUpdated" else f"workspace-change-{turn_id}"
                self._put_item(turn, {"id": item_id, "type": "fileChange", "status": "inProgress" if method == "item/fileChange/patchUpdated" else "completed", "changes": params.get("changes", [])})
            else:
                self._put_item(turn, params.get("item"))

    @staticmethod
    def _put_item(turn: dict[str, Any], item: Any) -> None:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return
        for index, previous in enumerate(turn["items"]):
            if previous.get("id") == item.get("id") or (previous.get("id") == "anonymous" and item.get("type") == "agentMessage"):
                turn["items"][index] = dict(item)
                return
        turn["items"].append(dict(item))

    async def flush_live(self) -> None:
        key = self.binding()
        if not key or key != self._key:
            return
        row = self.db.execute("SELECT since FROM device_chat_sync_bindings WHERE room_id=? AND thread_id=?", key).fetchone()
        if row:
            for turn in list(self._live.values()):
                if self.binding() != key:
                    return
                await self._sync_turn(key, float(row["since"]), turn)

    async def _sync_turn(self, key: tuple[str, str], since: float, turn: dict[str, Any]) -> None:
        from .device_chat import _handoff_target

        turn_id = turn.get("id")
        if not isinstance(turn_id, str) or _timestamp(turn.get("startedAt")) < since:
            return
        user = _text(turn, "userMessage")
        if user.startswith(GROUP_PROMPT_PREFIX):
            self.mark_group_turn(*key, turn_id)
            return
        row = self.db.execute("SELECT * FROM device_chat_sync_turns WHERE room_id=? AND thread_id=? AND turn_id=?", (*key, turn_id)).fetchone()
        if row and row["origin"] in {"group", "prior"}:
            return
        if self.manager._active_agent_thread_id == key[1]:
            return
        if not row:
            self.db.execute("INSERT INTO device_chat_sync_turns(room_id,thread_id,turn_id,origin) VALUES (?,?,?,'ordinary')", (*key, turn_id))
            row = self.db.execute("SELECT * FROM device_chat_sync_turns WHERE room_id=? AND thread_id=? AND turn_id=?", (*key, turn_id)).fetchone()
        finished = turn.get("status") in FINISHED
        if row["finished"] and not finished:
            return
        assistant = _text(turn, "agentMessage")
        activity = project_activity(turn.get("items", []), "completed" if finished else "running")
        target = row["handoff_target"]
        if finished and not row["finished"] and turn.get("status") == "completed" and turn_id in self._eligible:
            member = _handoff_target(assistant, self.manager._members(), self.manager.node_id)
            target = member["id"] if member else None
        digest_id = hashlib.sha256(json.dumps([self.manager.node_id, *key, turn_id]).encode()).hexdigest()[:40]
        for kind, text in (("user", user), ("assistant", assistant)):
            if not text and (kind == "user" or (not activity["items"] and finished and not row["assistant_digest"])):
                continue
            event = {"id": f"thread:{digest_id}:{kind}", "kind": kind, "sender_id": self.manager.node_id,
                     "target_id": target if kind == "assistant" else None, "text": text,
                     "created_at": datetime.fromtimestamp(_timestamp(turn.get("startedAt")), timezone.utc).isoformat()}
            if kind == "assistant" and target:
                event.update(handoff_root_id=event["id"], handoff_depth=1)
            if kind == "assistant":
                event["activity"] = activity
            digest = hashlib.sha256(json.dumps(event, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            if row[f"{kind}_digest"] == digest:
                continue
            if self.binding() != key:
                return
            await self.manager._publish_local_event(event)
            if self.binding() != key:
                return
            self.db.execute(f"UPDATE device_chat_sync_turns SET {kind}_digest=? WHERE room_id=? AND thread_id=? AND turn_id=?", (digest, *key, turn_id))
        if int(finished) != row["finished"] or target != row["handoff_target"]:
            self.db.execute("UPDATE device_chat_sync_turns SET finished=?,handoff_target=? WHERE room_id=? AND thread_id=? AND turn_id=?",
                            (int(finished), target, *key, turn_id))
        if finished:
            self._eligible.discard(turn_id)
