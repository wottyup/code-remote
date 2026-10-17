"""Durable, single-authority queue and sidebar pins for paired devices."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .codex_app_server import CodexAppServer, CodexRuntimeError
from .claude_code import ClaudeCodeServer, is_claude_thread_id

logger = logging.getLogger(__name__)
EDIT_LEASE_SECONDS = 600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class QueueConflictError(RuntimeError):
    pass


class SharedStateStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, isolation_level=None)
        if os.name != "nt":
            os.chmod(path, 0o600)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS queued_messages (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE NOT NULL,
                thread_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                editing INTEGER NOT NULL DEFAULT 0,
                edit_owner TEXT,
                edit_started_at TEXT,
                attempt_at TEXT
            );
            CREATE INDEX IF NOT EXISTS queued_messages_thread ON queued_messages(thread_id, sequence);
            CREATE TABLE IF NOT EXISTS queue_receipts (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                delivered_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue_barriers (thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS queue_blocks (thread_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS paused_threads (thread_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS pinned_threads (thread_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS thread_workspaces (thread_id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS state_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(queued_messages)")}
        if "edit_owner" not in columns:
            self.connection.execute("ALTER TABLE queued_messages ADD COLUMN edit_owner TEXT")
        if "edit_started_at" not in columns:
            self.connection.execute("ALTER TABLE queued_messages ADD COLUMN edit_started_at TEXT")
        # An editor from an older process cannot renew its lock after a restart.
        self.connection.execute(
            "UPDATE queued_messages SET editing = 0, edit_owner = NULL WHERE editing = 1 AND edit_started_at IS NULL"
        )
        # A process may have died after Codex accepted a turn but before it
        # received an acknowledgement. Never turn such an item into "pending".
        self.connection.execute("UPDATE queued_messages SET state = 'unverified' WHERE state = 'sending'")
        # No Codex request is made until claim(), so an interrupted submission
        # decision can safely return to the waiting queue after a restart.
        self.connection.execute("UPDATE queued_messages SET state = 'pending' WHERE state = 'submitting'")

    def close(self) -> None:
        self.connection.close()

    def thread_ids(self) -> list[str]:
        rows = self.connection.execute("SELECT DISTINCT thread_id FROM queued_messages").fetchall()
        return [row[0] for row in rows]

    def queue(self, thread_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT payload, state, editing, attempt_at FROM queued_messages WHERE thread_id = ? ORDER BY sequence",
            (thread_id,),
        ).fetchall()
        result = []
        for row in rows:
            payload = json.loads(row["payload"])
            payload["deliveryState"] = row["state"]
            if row["state"] in {"sending", "unverified"}:
                payload["sendAttempt"] = payload.get("sendAttempt") or {"at": row["attempt_at"] or _now()}
            payload["editing"] = bool(row["editing"])
            result.append(payload)
        if result:
            block = self.connection.execute("SELECT reason FROM queue_blocks WHERE thread_id = ?", (thread_id,)).fetchone()
            if block:
                result[0]["blockedReason"] = block["reason"]
        return result

    def enqueue(self, thread_id: str, payload: dict[str, Any], *, submitting: bool = False) -> bool:
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        existing = self.connection.execute("SELECT thread_id, payload FROM queued_messages WHERE id = ?", (payload["id"],)).fetchone()
        if existing:
            if existing["thread_id"] != thread_id or existing["payload"] != serialized:
                raise QueueConflictError("这条排队消息的编号已用于其它内容。")
            return False
        receipt = self.connection.execute("SELECT thread_id, fingerprint FROM queue_receipts WHERE id = ?", (payload["id"],)).fetchone()
        if receipt:
            if receipt["thread_id"] != thread_id or receipt["fingerprint"] != hashlib.sha256(serialized.encode()).hexdigest():
                raise QueueConflictError("这条排队消息的编号已用于其它内容。")
            return False
        if self.connection.execute("SELECT COUNT(*) FROM queued_messages WHERE thread_id = ?", (thread_id,)).fetchone()[0] >= 30:
            raise QueueConflictError("每条对话最多保留 30 条排队消息。")
        attempt = payload.get("sendAttempt")
        self.connection.execute(
            "INSERT INTO queued_messages(id, thread_id, payload, state, attempt_at) VALUES (?, ?, ?, ?, ?)",
            (payload["id"], thread_id, serialized, "unverified" if attempt else "submitting" if submitting else "pending", attempt.get("at") if attempt else None),
        )
        return True

    def finish_submission(self, thread_id: str, message_id: str) -> None:
        self.connection.execute(
            "UPDATE queued_messages SET state = 'pending' WHERE thread_id = ? AND id = ? AND state = 'submitting'",
            (thread_id, message_id),
        )

    def update(self, thread_id: str, message_id: str, payload: dict[str, Any]) -> None:
        row = self.connection.execute(
            "SELECT payload, state, editing FROM queued_messages WHERE thread_id = ? AND id = ?", (thread_id, message_id),
        ).fetchone()
        if not row or row["state"] != "pending" or not row["editing"]:
            raise QueueConflictError("这条排队消息已发送或不在编辑状态。")
        original = json.loads(row["payload"])
        payload["id"] = message_id
        payload["createdAt"] = original["createdAt"]
        self.connection.execute(
            "UPDATE queued_messages SET payload = ? WHERE id = ?",
            (json.dumps(payload, ensure_ascii=False, separators=(",", ":")), message_id),
        )

    def edit(self, thread_id: str, message_id: str, editing: bool, owner: str = "legacy") -> None:
        if editing:
            row = self.connection.execute(
                "SELECT editing, edit_owner, state FROM queued_messages WHERE thread_id = ? AND id = ?",
                (thread_id, message_id),
            ).fetchone()
            if row and row["state"] == "pending" and row["editing"] and row["edit_owner"] == owner:
                return
            changed = self.connection.execute(
                "UPDATE queued_messages SET editing = 1, edit_owner = ?, edit_started_at = ? WHERE thread_id = ? AND id = ? AND state = 'pending' AND editing = 0",
                (owner, _now(), thread_id, message_id),
            ).rowcount
        else:
            existing = self.connection.execute(
                "SELECT 1 FROM queued_messages WHERE thread_id = ? AND id = ?",
                (thread_id, message_id),
            ).fetchone()
            if not existing:
                return
            changed = self.connection.execute(
                "UPDATE queued_messages SET editing = 0, edit_owner = NULL, edit_started_at = NULL WHERE thread_id = ? AND id = ? AND editing = 1",
                (thread_id, message_id),
            ).rowcount
            if not changed and self.connection.execute(
                "SELECT 1 FROM queued_messages WHERE thread_id = ? AND id = ? AND editing = 0",
                (thread_id, message_id),
            ).fetchone():
                return
        if not changed:
            raise QueueConflictError("这条排队消息已变更，请刷新后重试。")

    def renew_edit(self, thread_id: str, message_id: str, owner: str) -> None:
        changed = self.connection.execute(
            "UPDATE queued_messages SET edit_started_at = ? WHERE thread_id = ? AND id = ? AND state = 'pending' AND editing = 1 AND edit_owner = ?",
            (_now(), thread_id, message_id, owner),
        ).rowcount
        if not changed:
            raise QueueConflictError("排队消息的编辑占用已失效，请重新打开编辑。")

    def expire_stale_edits(self) -> list[str]:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=EDIT_LEASE_SECONDS)).isoformat()
        rows = self.connection.execute(
            "SELECT DISTINCT thread_id FROM queued_messages WHERE editing = 1 AND edit_started_at < ?", (cutoff,),
        ).fetchall()
        if rows:
            self.connection.execute(
                "UPDATE queued_messages SET editing = 0, edit_owner = NULL, edit_started_at = NULL WHERE editing = 1 AND edit_started_at < ?",
                (cutoff,),
            )
        return [row[0] for row in rows]

    def remove(self, thread_id: str, message_id: str) -> None:
        existing = self.connection.execute(
            "SELECT state FROM queued_messages WHERE thread_id = ? AND id = ?", (thread_id, message_id),
        ).fetchone()
        if not existing:
            return
        if existing["state"] == "sending":
            raise QueueConflictError("这条排队消息正在发送或已不存在。")
        changed = self.connection.execute(
            "DELETE FROM queued_messages WHERE thread_id = ? AND id = ? AND state != 'sending'",
            (thread_id, message_id),
        ).rowcount
        if not changed:
            raise QueueConflictError("这条排队消息正在发送或已不存在。")

    def claim(self, thread_id: str, message_id: str) -> dict[str, Any] | None:
        attempt_at = _now()
        changed = self.connection.execute(
            "UPDATE queued_messages SET state = 'sending', attempt_at = ? WHERE thread_id = ? AND id = ? AND state IN ('pending', 'submitting') AND editing = 0",
            (attempt_at, thread_id, message_id),
        ).rowcount
        if not changed:
            return None
        row = self.connection.execute("SELECT payload FROM queued_messages WHERE id = ?", (message_id,)).fetchone()
        return json.loads(row["payload"])

    def unverified(self, message_id: str) -> None:
        self.connection.execute("UPDATE queued_messages SET state = 'unverified' WHERE id = ?", (message_id,))

    def delivered(self, thread_id: str, message_id: str, turn_id: str | None, *, new_turn: bool) -> None:
        row = self.connection.execute("SELECT payload FROM queued_messages WHERE thread_id = ? AND id = ?", (thread_id, message_id)).fetchone()
        if not row:
            return
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.execute(
                "INSERT OR IGNORE INTO queue_receipts(id, thread_id, fingerprint, delivered_at) VALUES (?, ?, ?, ?)",
                (message_id, thread_id, hashlib.sha256(row["payload"].encode()).hexdigest(), _now()),
            )
            self.connection.execute("DELETE FROM queued_messages WHERE thread_id = ? AND id = ?", (thread_id, message_id))
            if new_turn and turn_id:
                self.connection.execute(
                    "INSERT INTO queue_barriers(thread_id, turn_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET turn_id = excluded.turn_id",
                    (thread_id, turn_id),
                )

    def barrier(self, thread_id: str) -> str | None:
        row = self.connection.execute("SELECT turn_id FROM queue_barriers WHERE thread_id = ?", (thread_id,)).fetchone()
        return row["turn_id"] if row else None

    def clear_barrier(self, thread_id: str) -> None:
        self.connection.execute("DELETE FROM queue_barriers WHERE thread_id = ?", (thread_id,))

    def set_barrier(self, thread_id: str, turn_id: str) -> None:
        self.connection.execute(
            "INSERT INTO queue_barriers(thread_id, turn_id) VALUES (?, ?) "
            "ON CONFLICT(thread_id) DO UPDATE SET turn_id = excluded.turn_id",
            (thread_id, turn_id),
        )

    def is_paused(self, thread_id: str) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM paused_threads WHERE thread_id = ?", (thread_id,),
        ).fetchone() is not None

    def set_paused(self, thread_id: str, paused: bool) -> None:
        if paused:
            self.connection.execute("INSERT OR IGNORE INTO paused_threads(thread_id) VALUES (?)", (thread_id,))
        else:
            self.connection.execute("DELETE FROM paused_threads WHERE thread_id = ?", (thread_id,))

    def set_block(self, thread_id: str, reason: str | None) -> bool:
        current = self.connection.execute("SELECT reason FROM queue_blocks WHERE thread_id = ?", (thread_id,)).fetchone()
        if (current["reason"] if current else None) == reason:
            return False
        if reason:
            self.connection.execute(
                "INSERT INTO queue_blocks(thread_id, reason) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET reason = excluded.reason",
                (thread_id, reason),
            )
        else:
            self.connection.execute("DELETE FROM queue_blocks WHERE thread_id = ?", (thread_id,))
        return True

    def was_delivered(self, thread_id: str, message_id: str) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM queue_receipts WHERE thread_id = ? AND id = ?", (thread_id, message_id),
        ).fetchone() is not None

    def pins(self) -> list[str]:
        return [row[0] for row in self.connection.execute("SELECT thread_id FROM pinned_threads ORDER BY thread_id")]

    def initialize_pins(self, thread_ids: list[str]) -> list[str]:
        if not thread_ids:
            return self.pins()
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            initialized = self.connection.execute("SELECT value FROM state_metadata WHERE key = 'pins_initialized'").fetchone()
            if not initialized:
                self.connection.executemany("INSERT OR IGNORE INTO pinned_threads(thread_id) VALUES (?)", ((thread_id,) for thread_id in thread_ids))
                self.connection.execute("INSERT INTO state_metadata(key, value) VALUES ('pins_initialized', '1')")
        return self.pins()

    def set_pin(self, thread_id: str, pinned: bool) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.execute("INSERT OR IGNORE INTO state_metadata(key, value) VALUES ('pins_initialized', '1')")
            if pinned:
                self.connection.execute("INSERT OR IGNORE INTO pinned_threads(thread_id) VALUES (?)", (thread_id,))
            else:
                self.connection.execute("DELETE FROM pinned_threads WHERE thread_id = ?", (thread_id,))

    def thread_workspace(self, thread_id: str) -> str | None:
        row = self.connection.execute("SELECT cwd FROM thread_workspaces WHERE thread_id = ?", (thread_id,)).fetchone()
        return row["cwd"] if row else None

    def thread_workspaces(self) -> dict[str, str]:
        return {
            row["thread_id"]: row["cwd"]
            for row in self.connection.execute("SELECT thread_id, cwd FROM thread_workspaces")
        }

    def set_thread_workspace(self, thread_id: str, cwd: str) -> None:
        self.connection.execute(
            "INSERT INTO thread_workspaces(thread_id, cwd) VALUES (?, ?) "
            "ON CONFLICT(thread_id) DO UPDATE SET cwd = excluded.cwd",
            (thread_id, cwd),
        )

    def delete_thread(self, thread_id: str) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            for table in (
                "queued_messages",
                "queue_receipts",
                "queue_barriers",
                "queue_blocks",
                "paused_threads",
                "pinned_threads",
                "thread_workspaces",
            ):
                self.connection.execute(f"DELETE FROM {table} WHERE thread_id = ?", (thread_id,))


def _turn_status(turn: dict[str, Any]) -> str:
    value = turn.get("status")
    return value.replace("-", "").replace("_", "").lower() if isinstance(value, str) else ""


class SharedQueueService:
    def __init__(
        self,
        store: SharedStateStore,
        codex: CodexAppServer,
        send: Callable[[str, dict[str, Any], bool], Awaitable[str | None]],
        claude: ClaudeCodeServer | None = None,
    ) -> None:
        self.store = store
        self.codex = codex
        self.send = send
        self.claude = claude
        self._wake = asyncio.Event()
        self._locks: dict[str, asyncio.Lock] = {}
        self._runner: asyncio.Task[None] | None = None
        self._listener: asyncio.Task[None] | None = None
        self._closed = False

    def _lock(self, thread_id: str) -> asyncio.Lock:
        return self._locks.setdefault(thread_id, asyncio.Lock())

    async def changed(self, thread_id: str) -> None:
        self._wake.set()
        await self.codex._emit({"type": "remote.queue.changed", "threadId": thread_id})

    async def delete_thread(self, thread_id: str) -> None:
        async with self._lock(thread_id):
            if is_claude_thread_id(thread_id) and self.claude is not None:
                await self.claude.delete_thread(thread_id)
            else:
                await self.codex.delete_thread(thread_id)
            self.store.delete_thread(thread_id)
            await self.changed(thread_id)

    async def _read_thread(self, thread_id: str, *, include_turns: bool = True) -> dict[str, Any]:
        if is_claude_thread_id(thread_id) and self.claude is not None:
            return await self.claude.read_thread(thread_id, include_turns=include_turns)
        return await self.codex.read_thread(thread_id, include_turns=include_turns)

    async def _active_turn_id(self, thread_id: str) -> str | None:
        if is_claude_thread_id(thread_id) and self.claude is not None:
            return await self.claude.active_turn_id(thread_id)
        return await self.codex._active_turn_id(thread_id)

    async def _resume_thread(self, thread_id: str) -> None:
        if not (is_claude_thread_id(thread_id) and self.claude is not None):
            await self.codex.resume_thread(thread_id)

    async def _block(self, thread_id: str, reason: str | None) -> None:
        if self.store.set_block(thread_id, reason):
            await self.changed(thread_id)

    async def pause_thread(self, thread_id: str, turn_id: str | None = None) -> bool:
        async with self._lock(thread_id):
            self.store.set_paused(thread_id, True)
            try:
                if is_claude_thread_id(thread_id) and self.claude is not None:
                    interrupted = await self.claude.interrupt(thread_id, turn_id)
                else:
                    await self.codex.interrupt(thread_id, turn_id)
                    interrupted = True
            except Exception:
                self.store.set_paused(thread_id, False)
                raise
            if not interrupted:
                self.store.set_paused(thread_id, False)
            await self.changed(thread_id)
            return interrupted

    async def continue_paused(self, thread_id: str, payload: dict[str, Any] | None = None) -> str:
        async with self._lock(thread_id):
            if not self.store.is_paused(thread_id):
                raise QueueConflictError("当前回复未处于暂停状态。")
            if await self._active_turn_id(thread_id):
                raise QueueConflictError("上一条回复仍在停止中，请稍后再继续。")
            await self._resume_thread(thread_id)
            if is_claude_thread_id(thread_id) and self.claude is not None:
                if not payload or not payload.get("requestText", "").strip():
                    raise QueueConflictError("Claude 续接需要提供内容。")
                turn_id = await self.send(thread_id, payload, False)
            else:
                # Codex accepts an empty input turn after interruption. It
                # continues from thread context without a synthetic user item.
                result = await self.codex.start_turn(thread_id, "", allow_empty=True)
                turn = result.get("turn")
                turn_id = turn.get("id") if isinstance(turn, dict) else None
            if not turn_id:
                raise RuntimeError("对话引擎未确认续接的回复轮次")
            self.store.set_barrier(thread_id, turn_id)
            self.store.set_paused(thread_id, False)
            self.store.set_block(thread_id, None)
            await self.changed(thread_id)
            return turn_id

    async def stop_thread(self, thread_id: str) -> None:
        """Cancel a pending continuation, interrupting a racing new turn first."""
        async with self._lock(thread_id):
            active_turn = await self._active_turn_id(thread_id)
            if active_turn:
                if is_claude_thread_id(thread_id) and self.claude is not None:
                    await self.claude.interrupt(thread_id, active_turn)
                else:
                    await self.codex.interrupt(thread_id, active_turn)
            self.store.set_paused(thread_id, False)
            await self.changed(thread_id)

    def start(self) -> None:
        self._runner = asyncio.create_task(self._run())
        self._listener = asyncio.create_task(self._listen())

    async def close(self) -> None:
        self._closed = True
        self._wake.set()
        tasks = tuple(task for task in (self._runner, self._listener) if task is not None)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _listen(self) -> None:
        events = await self.codex.subscribe()
        try:
            while True:
                event = await events.get()
                if event.get("type") == "notification" and event.get("method") == "turn/completed":
                    self._wake.set()
                elif event.get("type") == "connection" and event.get("connected"):
                    self._wake.set()
        finally:
            self.codex.unsubscribe(events)

    async def _run(self) -> None:
        while not self._closed:
            self._wake.clear()
            for thread_id in self.store.expire_stale_edits():
                await self.changed(thread_id)
            for thread_id in self.store.thread_ids():
                try:
                    await self.advance(thread_id)
                except asyncio.CancelledError:
                    raise
                except CodexRuntimeError as error:
                    # A disconnected App Server must not lose or double-send
                    # the queue; the next wake or periodic check retries.
                    logger.debug("Queue waits for Codex thread %s: %s", thread_id, error)
                except Exception:
                    logger.exception("Could not advance queued thread %s", thread_id)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=15)
            except TimeoutError:
                pass

    async def advance(self, thread_id: str) -> None:
        async with self._lock(thread_id):
            queue = self.store.queue(thread_id)
            is_claude = is_claude_thread_id(thread_id) and self.claude is not None
            if not queue or self.store.is_paused(thread_id) or queue[0].get("editing") or queue[0].get("sendAttempt") or (self.codex.handed_off and not is_claude):
                return
            summary = await self._read_thread(thread_id, include_turns=False)
            if await self._active_turn_id(thread_id):
                return
            summary_status = summary.get("status")
            if isinstance(summary_status, dict) and summary_status.get("type") in {"active", "inProgress", "running", "started"}:
                return
            # Recovery of an existing queue still checks the last turn and
            # barrier; an explicit new submission may release a stopped turn.
            thread = await self._read_thread(thread_id)
            turns = thread.get("turns") if isinstance(thread.get("turns"), list) else []
            latest = turns[-1] if turns and isinstance(turns[-1], dict) else None
            barrier = self.store.barrier(thread_id)
            if barrier:
                waited = next((turn for turn in turns if isinstance(turn, dict) and turn.get("id") == barrier), None)
                if not waited:
                    await self._block(thread_id, "等待确认上一条回复，暂不自动发送")
                    return
                waited_status = _turn_status(waited)
                if waited_status not in {"completed", "complete", "success"}:
                    if waited_status not in {"inprogress", "running", "started"}:
                        await self._block(thread_id, "上一条回复未正常完成，请手动检查后点击立即发送")
                    return
                self.store.clear_barrier(thread_id)
            if latest and _turn_status(latest) not in {"completed", "complete", "success"}:
                if _turn_status(latest) not in {"inprogress", "running", "started"}:
                    await self._block(thread_id, "上一条回复未正常完成，请手动检查后点击立即发送")
                return
            if not latest and isinstance(thread.get("status"), dict):
                status = thread["status"].get("type")
                if status not in {None, "idle", "notLoaded"}:
                    return
            if await self._active_turn_id(thread_id):
                return
            await self._block(thread_id, None)
            # Resume before claiming. A failed resume cannot create a delivery
            # ambiguity and leaves the item safely pending.
            if not isinstance(summary_status, dict) or summary_status.get("type") != "idle":
                await self._resume_thread(thread_id)
            payload = self.store.claim(thread_id, queue[0]["id"])
            if not payload:
                return
            await self.changed(thread_id)
            await self._send_claimed(thread_id, payload, new_turn=True)

    async def _send_claimed(self, thread_id: str, payload: dict[str, Any], *, new_turn: bool) -> bool:
        try:
            turn_id = await self.send(thread_id, payload, not new_turn)
            if not turn_id:
                raise RuntimeError("对话引擎未确认消息所属的回复轮次")
        except asyncio.CancelledError:
            self.store.unverified(payload["id"])
            await self.changed(thread_id)
            raise
        except Exception:
            logger.exception("Queued message %s delivery is unverified", payload["id"])
            self.store.unverified(payload["id"])
            await self.changed(thread_id)
            return False
        self.store.delivered(thread_id, payload["id"], turn_id, new_turn=new_turn)
        self.store.set_block(thread_id, None)
        await self.changed(thread_id)
        return True

    async def send_now(self, thread_id: str, message_id: str, *, allow_steer: bool = True, require_head: bool = False) -> bool:
        async with self._lock(thread_id):
            return await self._send_now(thread_id, message_id, allow_steer=allow_steer, require_head=require_head)

    async def submit(self, thread_id: str, payload: dict[str, Any]) -> bool:
        # Enqueue and decide under the same lock: the background worker must
        # not claim a new submission while this request is checking idle state.
        async with self._lock(thread_id):
            self.store.enqueue(thread_id, payload, submitting=True)
            try:
                if self.store.is_paused(thread_id):
                    return False
                if self.codex.handed_off and not (is_claude_thread_id(thread_id) and self.claude is not None):
                    return False
                return await self._send_now(thread_id, payload["id"], allow_steer=False, require_head=True)
            except CodexRuntimeError:
                await self._block(thread_id, "暂时无法确认 Codex 状态，连接恢复后自动发送")
                return False
            finally:
                self.store.finish_submission(thread_id, payload["id"])
                await self.changed(thread_id)

    async def _send_now(self, thread_id: str, message_id: str, *, allow_steer: bool, require_head: bool) -> bool:
        if self.store.was_delivered(thread_id, message_id):
            return True
        queue = self.store.queue(thread_id)
        candidate = next((item for item in queue if item["id"] == message_id), None)
        if require_head and (not queue or queue[0]["id"] != message_id):
            return False
        if not candidate or candidate.get("editing") or candidate.get("sendAttempt"):
            if require_head:
                return False
            raise QueueConflictError("这条排队消息正在编辑、发送或等待核对。")

        # Do not load a whole long conversation just to ask whether it is busy.
        # read_thread also reconciles a cached active ID against this snapshot.
        is_claude = is_claude_thread_id(thread_id) and self.claude is not None
        thread = await self._read_thread(thread_id, include_turns=False)
        status = thread.get("status")
        status_type = status.get("type") if isinstance(status, dict) else None
        if status_type == "notLoaded":
            # A notLoaded summary is not an idle verdict. Resume once to ask
            # the local App Server for the real turn state before queueing.
            await self._resume_thread(thread_id)
            thread = await self._read_thread(thread_id, include_turns=False)
            status = thread.get("status")
            status_type = status.get("type") if isinstance(status, dict) else None
        active_turn = await self._active_turn_id(thread_id)
        busy = status_type in {"active", "inProgress", "running", "started"}
        if busy and not active_turn and not is_claude:
            active_turn = await self.codex.recover_active_turn_id(thread_id)
        if not active_turn and status_type not in {"idle", "notLoaded"}:
            # Older App Server versions may omit the summary status. Fall back
            # conservatively rather than treating an unknown status as idle.
            if not busy:
                thread = await self._read_thread(thread_id)
                status = thread.get("status")
                status_type = status.get("type") if isinstance(status, dict) else None
                turns = thread.get("turns") if isinstance(thread.get("turns"), list) else []
                latest = turns[-1] if turns and isinstance(turns[-1], dict) else None
                busy = status_type in {"active", "inProgress", "running", "started"} or bool(
                    latest and _turn_status(latest) in {"inprogress", "running", "started"}
                )
                active_turn = await self._active_turn_id(thread_id)
                if not busy and not active_turn and (
                    (latest is not None and _turn_status(latest) not in {"completed", "complete", "success", "interrupted", "failed"})
                    or (latest is None and status_type not in {None, "idle", "notLoaded"})
                ):
                    await self._block(thread_id, "等待确认 Codex 的回复状态，暂不自动发送")
                    return False
        if (active_turn or busy) and (not allow_steer or is_claude):
            return False
        if busy and not active_turn:
            await self._block(thread_id, "正在确认当前回复，暂时无法立即发送；确认后可重试")
            return False
        if not active_turn and status_type != "idle":
            await self._resume_thread(thread_id)
        payload = self.store.claim(thread_id, message_id)
        if not payload:
            raise QueueConflictError("这条排队消息正在编辑、发送或等待核对。")
        self.store.set_paused(thread_id, False)
        await self.changed(thread_id)
        if not active_turn:
            self.store.clear_barrier(thread_id)
        self.store.set_block(thread_id, None)
        return await self._send_claimed(thread_id, payload, new_turn=not bool(active_turn))
