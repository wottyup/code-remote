"""LAN room relay for independent Code Remote + Codex nodes."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import sqlite3
import time
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener

from websockets.asyncio.client import connect as websocket_connect

from .codex_app_server import CodexAppServer, CodexNoActiveTurnError, CodexRuntimeError

logger = logging.getLogger(__name__)
INVITE_TTL_SECONDS = 300
MAX_CHAT_MESSAGE_LENGTH = 12_000
MAX_AUTO_HANDOFFS = 4
AGENT_REPLY_FLUSH_INTERVAL_SECONDS = 0.35
DOCUMENT_MESSAGE_MIN_LENGTH = 1_200
DOCUMENT_END_MARKER = "[/附件文档]"
INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class DeviceChatError(RuntimeError):
    pass


class DeviceChatHttpError(DeviceChatError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _handoff_target(text: str, members: list[dict[str, Any]], sender_id: str) -> dict[str, Any] | None:
    """Resolve an explicit final @device line to one other online room member."""
    last_line: str | None = None
    last_line_is_plain_text = False
    inside_code_fence = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            inside_code_fence = not inside_code_fence
            last_line = line
            last_line_is_plain_text = False
        elif line:
            last_line = line
            last_line_is_plain_text = not inside_code_fence
    if not last_line or not last_line_is_plain_text or not last_line.startswith("@"):
        return None
    requested_name = last_line[1:].strip().casefold()
    if not requested_name:
        return None
    matches = [
        member for member in members
        if member.get("id") != sender_id
        and bool(member.get("online"))
        and isinstance(member.get("name"), str)
        and member["name"].strip().casefold() == requested_name
    ]
    return matches[0] if len(matches) == 1 else None


def _can_handoff(depth: Any) -> bool:
    return isinstance(depth, int) and not isinstance(depth, bool) and 0 <= depth < MAX_AUTO_HANDOFFS


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _safe_name(value: str) -> str:
    name = " ".join(value.split()).strip()
    if not name:
        raise DeviceChatError("设备名称不能为空。")
    return name[:40]


def _room_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        _ = parsed.port
    except ValueError as error:
        raise DeviceChatError("房间地址格式无效，请检查主机名和端口。") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise DeviceChatError("请输入可从另一台设备访问的 http:// 或 https:// 地址。")
    try:
        is_loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        is_loopback = parsed.hostname.casefold() == "localhost" or parsed.hostname.casefold().endswith(".localhost")
    if is_loopback:
        raise DeviceChatError("房间地址不能使用 localhost 或回环 IP；请填另一台设备能访问的穿透域名或网络地址。")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise DeviceChatError("地址只填写网页的域名或 IP 和端口，例如 https://room.example.com。")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


class DeviceChatManager:
    """Stores one room locally and relays guest nodes through the host node."""

    def __init__(self, path: Path, codex: CodexAppServer, thread_workspace: Callable[[str], str | None] | None = None) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        if os.name != "nt":
            os.chmod(path, 0o600)
        self.connection.row_factory = sqlite3.Row
        self.thread_workspace = thread_workspace or (lambda _thread_id: None)
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS device_chat_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS device_chat_members (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT, online INTEGER NOT NULL DEFAULT 0,
                joined_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_chat_invites (
                code_hash TEXT PRIMARY KEY, expires_at REAL NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS device_chat_messages (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_chat_outbox (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS device_chat_agent_jobs (
                message_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_chat_threads (
                room_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, cwd TEXT
            );
        """)
        if "cwd" not in {row["name"] for row in self.connection.execute("PRAGMA table_info(device_chat_threads)")}:
            self.connection.execute("ALTER TABLE device_chat_threads ADD COLUMN cwd TEXT")
        thread_columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(device_chat_threads)")}
        if "manual" not in thread_columns:
            self.connection.execute("ALTER TABLE device_chat_threads ADD COLUMN manual INTEGER NOT NULL DEFAULT 0")
        message_columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(device_chat_messages)")}
        if "cursor" not in message_columns:
            self.connection.execute("ALTER TABLE device_chat_messages ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0")
            room_config = self._config()
            if room_config and room_config.get("role") == "peer":
                # Ask the room host for a full snapshot once after upgrading a
                # peer database; its locally saved stream may be incomplete.
                self.connection.execute("UPDATE device_chat_messages SET cursor = 0")
            else:
                max_sequence = int(self.connection.execute("SELECT COALESCE(MAX(sequence), 0) FROM device_chat_messages").fetchone()[0])
                self.connection.execute(
                    "UPDATE device_chat_messages SET cursor = sequence + ?",
                    (max_sequence + 1,),
                )
        self.connection.execute("CREATE INDEX IF NOT EXISTS idx_device_chat_messages_cursor ON device_chat_messages(cursor)")
        self.codex = codex
        self.node_id = self._get_metadata("node_id")
        if not self.node_id:
            self.node_id = str(uuid.uuid4())
            self._set_metadata("node_id", self.node_id)
        current_cursor = int(self._get_metadata("message_cursor") or "0")
        stored_cursor = int(self.connection.execute("SELECT COALESCE(MAX(cursor), 0) FROM device_chat_messages").fetchone()[0])
        if stored_cursor > current_cursor:
            self._set_metadata("message_cursor", str(stored_cursor))
        self._connections: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._client_task: asyncio.Task[None] | None = None
        self._outbox_task: asyncio.Task[None] | None = None
        self._agent_tasks: set[asyncio.Task[None]] = set()
        self._agent_lock = asyncio.Lock()
        self._active_agent_thread_id: str | None = None
        self._closed = False
        self._schedule_pending_jobs()

    def _get_metadata(self, key: str) -> str | None:
        row = self.connection.execute("SELECT value FROM device_chat_metadata WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def _set_metadata(self, key: str, value: str) -> None:
        self.connection.execute(
            "INSERT INTO device_chat_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _config(self) -> dict[str, Any] | None:
        raw = self._get_metadata("room_config")
        if not raw:
            return None
        try:
            config = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed device chat state")
            self._set_metadata("room_config", "")
            return None
        return config if isinstance(config, dict) else None

    def _save_config(self, config: dict[str, Any] | None) -> None:
        self._set_metadata("room_config", json.dumps(config, ensure_ascii=False, separators=(",", ":")) if config else "")

    def _schedule_pending_jobs(self) -> None:
        self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'pending' WHERE state = 'running'")
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        for row in self.connection.execute(
            "SELECT m.payload FROM device_chat_agent_jobs j JOIN device_chat_messages m ON m.id = j.message_id WHERE j.state = 'pending'"
        ).fetchall():
            with suppress(json.JSONDecodeError):
                event = json.loads(row["payload"])
                self._launch_agent(event)

    async def start(self) -> None:
        self._closed = False
        config = self._config()
        if config and config.get("role") == "host":
            self.connection.execute("UPDATE device_chat_members SET online = 0 WHERE id != ?", (self.node_id,))
            self.connection.execute("UPDATE device_chat_members SET online = 1 WHERE id = ?", (self.node_id,))
        elif config and config.get("role") == "peer":
            self._set_local_online(self.node_id, False)
            self._start_peer_connection()
            if not self._outbox_task or self._outbox_task.done():
                self._outbox_task = asyncio.create_task(self._outbox_flush_loop())
        self._schedule_pending_jobs()

    async def close(self) -> None:
        self._closed = True
        if self._client_task:
            self._client_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._client_task
            self._client_task = None
        if self._outbox_task:
            self._outbox_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._outbox_task
            self._outbox_task = None
        for task in tuple(self._agent_tasks):
            task.cancel()
        if self._agent_tasks:
            await asyncio.gather(*self._agent_tasks, return_exceptions=True)
        self.connection.close()

    def _start_peer_connection(self) -> None:
        if self._closed or (self._client_task and not self._client_task.done()):
            return
        self._client_task = asyncio.create_task(self._peer_connection_loop())

    async def create_or_invite(self, name: str) -> dict[str, Any]:
        cleaned_name = _safe_name(name)
        config = self._config()
        if config and config.get("role") != "host":
            raise DeviceChatError("本机已加入其他设备创建的房间，请先退出再创建。")
        if not config:
            config = {
                "role": "host",
                "room": {"id": str(uuid.uuid4()), "name": "设备协作群聊", "host_id": self.node_id, "host_name": cleaned_name},
                "name": cleaned_name,
            }
            self._save_config(config)
            self.connection.execute(
                "INSERT OR REPLACE INTO device_chat_members(id, name, token_hash, online, joined_at) VALUES (?, ?, NULL, 1, ?)",
                (self.node_id, cleaned_name, _now()),
            )
        else:
            config["name"] = cleaned_name
            config["room"]["host_name"] = cleaned_name
            self._save_config(config)
            self.connection.execute("UPDATE device_chat_members SET name = ?, online = 1 WHERE id = ?", (cleaned_name, self.node_id))
        code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(12))
        self.connection.execute("DELETE FROM device_chat_invites WHERE expires_at < ? OR consumed = 1", (time.time(),))
        self.connection.execute(
            "INSERT INTO device_chat_invites(code_hash, expires_at, consumed) VALUES (?, ?, 0)",
            (_token_hash(code), time.time() + INVITE_TTL_SECONDS),
        )
        return {"state": self.state(), "invite_code": code, "expires_in": INVITE_TTL_SECONDS}

    async def join_room(self, host_url: str, code: str, name: str) -> dict[str, Any]:
        if self._config():
            raise DeviceChatError("本机已经加入一个设备群聊，请先退出。")
        url = _room_url(host_url)
        payload = {"code": code.strip().upper(), "device_id": self.node_id, "name": _safe_name(name)}
        response = await asyncio.to_thread(self._post_json, f"{url}/api/v1/device-chat/join-peer", payload, None)
        room = response.get("room")
        token = response.get("token")
        members = response.get("members")
        if not isinstance(room, dict) or not isinstance(token, str) or not isinstance(members, list):
            raise DeviceChatError("房间服务返回了无法识别的加入信息。")
        config = {"role": "peer", "room": room, "name": payload["name"], "host_url": url, "host_token": token}
        self._save_config(config)
        self.connection.execute("DELETE FROM device_chat_members")
        for member in members:
            self._upsert_member(member)
        self._upsert_member({"id": self.node_id, "name": payload["name"], "online": False})
        self.connection.execute("DELETE FROM device_chat_messages")
        self.connection.execute("DELETE FROM device_chat_outbox")
        self._start_peer_connection()
        if not self._outbox_task or self._outbox_task.done():
            self._outbox_task = asyncio.create_task(self._outbox_flush_loop())
        return self.state()

    async def create_invite(self, name: str | None = None) -> dict[str, Any]:
        config = self._config()
        if not config or config.get("role") != "host":
            raise DeviceChatError("只有房间创建设备可以生成加入码。")
        return await self.create_or_invite(name or config.get("name", "本机 Codex"))

    async def accept_join(self, code: str, device_id: str, name: str) -> dict[str, Any]:
        config = self._config()
        if not config or config.get("role") != "host":
            raise DeviceChatError("该设备当前没有可加入的房间。")
        cleaned_code = code.strip().upper()
        row = self.connection.execute(
            "SELECT code_hash, expires_at, consumed FROM device_chat_invites WHERE code_hash = ?",
            (_token_hash(cleaned_code),),
        ).fetchone()
        if not row or row["consumed"] or float(row["expires_at"]) < time.time():
            raise DeviceChatError("加入码无效、已使用或已过期，请让房间设备重新生成。")
        if not device_id or len(device_id) > 80 or device_id == self.node_id:
            raise DeviceChatError("设备标识无效。")
        existing = self.connection.execute("SELECT id FROM device_chat_members WHERE id = ?", (device_id,)).fetchone()
        if existing:
            raise DeviceChatError("这台设备已经在房间里。")
        token = secrets.token_urlsafe(32)
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            consumed = self.connection.execute(
                "UPDATE device_chat_invites SET consumed = 1 WHERE code_hash = ? AND consumed = 0 AND expires_at > ?",
                (row["code_hash"], time.time()),
            )
            if consumed.rowcount != 1:
                raise DeviceChatError("加入码无效、已使用或已过期，请让房间设备重新生成。")
            self.connection.execute(
                "INSERT INTO device_chat_members(id, name, token_hash, online, joined_at) VALUES (?, ?, ?, 0, ?)",
                (device_id, _safe_name(name), _token_hash(token), _now()),
            )
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        member = {"id": device_id, "name": _safe_name(name), "online": False}
        self._broadcast({"type": "member_upsert", "member": member})
        room = {**config["room"]}
        members = self._members()
        return {"room": room, "members": members, "token": token}

    def authenticate_peer(self, device_id: str, token: str) -> bool:
        config = self._config()
        if not config or config.get("role") != "host" or device_id == self.node_id:
            return False
        row = self.connection.execute("SELECT token_hash FROM device_chat_members WHERE id = ?", (device_id,)).fetchone()
        known = str(row["token_hash"]) if row and row["token_hash"] else ""
        return bool(known and token and hmac.compare_digest(known, _token_hash(token)))

    async def connect_peer(self, device_id: str, token: str, last_cursor: int) -> tuple[asyncio.Queue[dict[str, Any]], dict[str, Any]]:
        if not self.authenticate_peer(device_id, token):
            raise DeviceChatError("设备节点授权无效。")
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._connections[device_id] = queue
        self._set_member_online(device_id, True)
        snapshot = {
            "type": "snapshot",
            "room": self._config()["room"],
            "members": self._members(),
            "events": self._messages_after(max(0, last_cursor)),
        }
        return queue, snapshot

    def disconnect_peer(self, device_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        if self._connections.get(device_id) is queue:
            self._connections.pop(device_id, None)
            if self._member_exists(device_id):
                self._set_member_online(device_id, False)

    async def send_message(self, text: str, target_id: str | None, model: str | None = None, effort: str | None = None, approval_policy: str | None = None) -> dict[str, Any]:
        content = text.strip()
        if not content:
            raise DeviceChatError("请输入群聊消息。")
        if len(content) > MAX_CHAT_MESSAGE_LENGTH:
            raise DeviceChatError("单条群聊消息不能超过 12000 个字符。")
        config = self._config()
        if not config:
            raise DeviceChatError("请先创建或加入一个设备群聊。")
        if target_id and not self._member_exists(target_id):
            raise DeviceChatError("被点名的设备已不在房间内，请刷新成员列表。")
        event = {
            "id": str(uuid.uuid4()), "kind": "user", "sender_id": self.node_id,
            "target_id": target_id or None, "text": content, "created_at": _now(),
        }
        event.update(self._turn_preferences(model, effort))
        if approval_policy is not None:
            if target_id != self.node_id or approval_policy not in {"on-request", "untrusted", "never"}:
                raise DeviceChatError("只能在本机设备上设置群聊授权。")
            event["approval_policy"] = approval_policy
        if config.get("role") == "host":
            saved = self._store_event(event)
            self._broadcast({"type": "event", "event": saved})
            self._schedule_agent(saved)
            return saved
        return await self._send_to_host(event)

    async def host_peer_event(self, device_id: str, token: str, raw_event: dict[str, Any]) -> dict[str, Any]:
        if not self.authenticate_peer(device_id, token):
            raise DeviceChatError("设备节点授权无效。")
        kind = raw_event.get("kind")
        if kind not in {"user", "assistant", "status", "error"}:
            raise DeviceChatError("不支持的群聊事件类型。")
        event_id = raw_event.get("id")
        if not isinstance(event_id, str) or not event_id or len(event_id) > 120:
            raise DeviceChatError("消息编号无效。")
        text = raw_event.get("text")
        if not isinstance(text, str) or len(text) > MAX_CHAT_MESSAGE_LENGTH:
            raise DeviceChatError("消息内容无效或过长。")
        target_id = raw_event.get("target_id")
        if target_id is not None and (not isinstance(target_id, str) or not self._member_exists(target_id)):
            raise DeviceChatError("消息目标设备不存在。")
        member = self.connection.execute("SELECT name FROM device_chat_members WHERE id = ?", (device_id,)).fetchone()
        event = {
            "id": event_id, "kind": kind, "sender_id": device_id, "sender_name": str(member["name"]),
            "target_id": target_id, "text": text, "created_at": str(raw_event.get("created_at") or _now()),
        }
        if kind == "user":
            event.update(self._turn_preferences(raw_event.get("model"), raw_event.get("effort")))
            approval_policy = raw_event.get("approval_policy")
            if approval_policy is not None:
                if device_id != target_id or approval_policy not in {"on-request", "untrusted", "never"}:
                    raise DeviceChatError("只能在本机设备上设置群聊授权。")
                event["approval_policy"] = approval_policy
        if kind == "assistant" and ("handoff_root_id" in raw_event or "handoff_depth" in raw_event):
            root_id = raw_event.get("handoff_root_id")
            depth = raw_event.get("handoff_depth")
            if (
                not isinstance(root_id, str) or not root_id or len(root_id) > 120
                or not isinstance(depth, int) or isinstance(depth, bool)
                or not 1 <= depth <= MAX_AUTO_HANDOFFS
            ):
                raise DeviceChatError("设备接力信息无效。")
            event["handoff_root_id"] = root_id
            event["handoff_depth"] = depth
        if kind in {"assistant", "status", "error"} and target_id is not None:
            target = self.connection.execute("SELECT name FROM device_chat_members WHERE id = ?", (target_id,)).fetchone()
            event["target_name"] = str(target["name"]) if target else None
        saved = self._store_event(event)
        self._broadcast({"type": "event", "event": saved})
        if kind in {"user", "assistant"}:
            self._schedule_agent(saved)
        return saved

    @staticmethod
    def _turn_preferences(model: Any, effort: Any) -> dict[str, str]:
        preferences: dict[str, str] = {}
        for key, value, limit in (("model", model, 200), ("effort", effort, 50)):
            if value is None or value == "":
                continue
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise DeviceChatError(f"群聊{key}设置无效。")
            preferences[key] = value.strip()
        return preferences

    async def leave_peer(self, device_id: str, token: str) -> None:
        if not self.authenticate_peer(device_id, token):
            raise DeviceChatError("设备节点授权无效。")
        queue = self._connections.get(device_id)
        if queue:
            queue.put_nowait({"type": "member_removed", "device_id": device_id})
        self.connection.execute("DELETE FROM device_chat_members WHERE id = ?", (device_id,))
        self._broadcast({"type": "member_removed", "device_id": device_id})

    async def leave(self) -> None:
        config = self._config()
        if not config:
            return
        if config.get("role") == "peer":
            await self._send_peer_http("leave-peer", {})
            if self._client_task:
                self._client_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._client_task
                self._client_task = None
            if self._outbox_task:
                self._outbox_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._outbox_task
                self._outbox_task = None
        else:
            self._broadcast({"type": "room_closed"})
        self._clear_room()

    def state(self, after_cursor: int | None = None) -> dict[str, Any]:
        config = self._config()
        if not config:
            return {"node_id": self.node_id, "room": None, "members": [], "messages": [], "connected": False}
        agent_thread_id = self._thread_for_room(str(config["room"]["id"]))
        agent_thread_cwd = self.thread_workspace(agent_thread_id) if agent_thread_id else None
        if agent_thread_id and not agent_thread_cwd:
            row = self.connection.execute(
                "SELECT cwd FROM device_chat_threads WHERE room_id = ?", (str(config["room"]["id"]),),
            ).fetchone()
            agent_thread_cwd = str(row["cwd"]) if row and row["cwd"] else None
        return {
            "node_id": self.node_id,
            "role": config.get("role"),
            "room": config.get("room"),
            "members": self._members(),
            "messages": self._messages_for_state(after_cursor),
            "local_thread_id": self._manual_thread_for_room(str(config["room"]["id"])),
            "agent_thread_id": agent_thread_id,
            "agent_thread_cwd": agent_thread_cwd,
            "connected": config.get("role") == "host" or bool(getattr(self, "_peer_connected", False)),
        }

    def _manual_thread_for_room(self, room_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT thread_id FROM device_chat_threads WHERE room_id = ? AND manual = 1", (room_id,),
        ).fetchone()
        return str(row["thread_id"]) if row else None

    def _agent_has_work(self) -> bool:
        pending = self.connection.execute(
            "SELECT 1 FROM device_chat_agent_jobs WHERE state IN ('pending', 'running') LIMIT 1"
        ).fetchone()
        return bool(self._active_agent_thread_id or self._agent_lock.locked() or pending)

    async def select_local_thread(self, thread_id: str | None) -> dict[str, Any]:
        config = self._config()
        if not config:
            raise DeviceChatError("请先创建或加入设备群聊。")
        if self._agent_has_work():
            raise DeviceChatError("本机 Codex 正在处理群聊消息，请等回复完成后切换聊天。")
        room_id = str(config["room"]["id"])
        if thread_id is None:
            self.connection.execute("DELETE FROM device_chat_threads WHERE room_id = ? AND manual = 1", (room_id,))
        else:
            if not thread_id or len(thread_id) > 512 or thread_id.startswith("claude:"):
                raise DeviceChatError("只能选择本机的 Codex 聊天。")
            try:
                thread = await self.codex.read_thread(thread_id, include_turns=False)
            except CodexRuntimeError as error:
                raise DeviceChatError(f"无法读取所选 Codex 聊天：{error}") from error
            if thread.get("id") != thread_id:
                raise DeviceChatError("所选 Codex 聊天不存在。")
            if self._agent_has_work():
                raise DeviceChatError("本机 Codex 正在处理群聊消息，请等回复完成后切换聊天。")
            selected_cwd = thread.get("cwd")
            self.connection.execute(
                "INSERT INTO device_chat_threads(room_id, thread_id, manual, cwd) VALUES (?, ?, 1, ?) "
                "ON CONFLICT(room_id) DO UPDATE SET thread_id = excluded.thread_id, manual = 1, cwd = excluded.cwd",
                (room_id, thread_id, selected_cwd if isinstance(selected_cwd, str) else None),
            )
        return self.state()

    async def ensure_local_thread(self) -> str:
        config = self._config()
        if not config:
            raise DeviceChatError("请先创建或加入设备群聊。")
        if self._agent_has_work():
            raise DeviceChatError("本机 Codex 正在处理群聊消息，请等回复完成后绑定目录。")
        return await self.ensure_local_thread_for_agent(config["room"], str(config.get("name", "本机 Codex")))

    async def ensure_local_thread_for_agent(self, room: dict[str, Any], name: str) -> str:
        room_id = str(room["id"])
        existing = self._thread_for_room(room_id)
        if existing:
            return existing
        thread = await self.codex.start_thread(cwd=self.codex.workspace)
        thread_id = str(thread["id"])
        self.connection.execute(
            "INSERT INTO device_chat_threads(room_id, thread_id, cwd) VALUES (?, ?, ?) ON CONFLICT(room_id) DO NOTHING",
            (room_id, thread_id, str(self.codex.workspace)),
        )
        with suppress(CodexRuntimeError):
            await self.codex.set_thread_name(thread_id, f"设备群聊 · {room.get('name', '群聊')} · {name}")
        return self._thread_for_room(room_id) or thread_id

    def _members(self) -> list[dict[str, Any]]:
        return [
            {"id": str(row["id"]), "name": str(row["name"]), "online": bool(row["online"])}
            for row in self.connection.execute("SELECT id, name, online FROM device_chat_members ORDER BY joined_at, id")
        ]

    def _member_exists(self, device_id: str) -> bool:
        return self.connection.execute("SELECT 1 FROM device_chat_members WHERE id = ?", (device_id,)).fetchone() is not None

    def _upsert_member(self, member: dict[str, Any]) -> None:
        device_id, name = member.get("id"), member.get("name")
        if not isinstance(device_id, str) or not isinstance(name, str):
            return
        self.connection.execute(
            "INSERT INTO device_chat_members(id, name, online, joined_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, online = excluded.online",
            (device_id, name, int(bool(member.get("online"))), _now()),
        )

    def _set_member_online(self, device_id: str, online: bool) -> None:
        self.connection.execute("UPDATE device_chat_members SET online = ? WHERE id = ?", (int(online), device_id))
        self._broadcast({"type": "presence", "device_id": device_id, "online": online})

    def _broadcast(self, event: dict[str, Any]) -> None:
        for queue in tuple(self._connections.values()):
            queue.put_nowait(event)

    def _messages(self, limit: int) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT sequence, cursor, payload FROM device_chat_messages ORDER BY sequence DESC LIMIT ?", (limit,),
        ).fetchall()
        return [{**json.loads(row["payload"]), "sequence": int(row["sequence"]), "cursor": int(row["cursor"])} for row in reversed(rows)]

    def _messages_after(self, cursor: int) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT sequence, cursor, payload FROM device_chat_messages WHERE cursor > ? ORDER BY cursor", (cursor,),
        ).fetchall()
        return [{**json.loads(row["payload"]), "sequence": int(row["sequence"]), "cursor": int(row["cursor"])} for row in rows]

    def _messages_for_state(self, after_cursor: int | None) -> list[dict[str, Any]]:
        messages = self._messages(500) if after_cursor is None else self._messages_after(max(0, after_cursor))
        config = self._config() or {}
        pending_rows = self.connection.execute("SELECT payload, delivered FROM device_chat_outbox ORDER BY created_at").fetchall()
        for row in pending_rows:
            with suppress(json.JSONDecodeError):
                event = json.loads(row["payload"])
                sender = self.connection.execute(
                    "SELECT name FROM device_chat_members WHERE id = ?", (event.get("sender_id"),),
                ).fetchone()
                messages.append({
                    **event,
                    "sender_name": str(sender["name"]) if sender else str(config.get("name", "本机 Codex")),
                    "sequence": -1,
                    "cursor": -1,
                    "delivery_state": "pending" if not row["delivered"] else "syncing" if row["delivered"] == 1 else "error",
                })
        return messages

    def _advance_message_cursor(self, requested: int | None = None) -> int:
        current = int(self._get_metadata("message_cursor") or "0")
        cursor = current + 1 if requested is None else requested
        self._set_metadata("message_cursor", str(max(current, cursor)))
        return cursor

    def _store_event(
        self, event: dict[str, Any], sequence: int | None = None, cursor: int | None = None,
    ) -> dict[str, Any]:
        if cursor is None and isinstance(event.get("cursor"), int):
            cursor = int(event["cursor"])
        event = {
            key: value for key, value in event.items()
            if key not in {"sequence", "cursor"} and (key not in {"sender_name", "target_name"} or value is not None)
        }
        if not isinstance(event.get("sender_name"), str):
            row = self.connection.execute("SELECT name FROM device_chat_members WHERE id = ?", (event.get("sender_id"),)).fetchone()
            event["sender_name"] = str(row["name"]) if row else "未知设备"
        target_id = event.get("target_id")
        if target_id and not isinstance(event.get("target_name"), str):
            row = self.connection.execute("SELECT name FROM device_chat_members WHERE id = ?", (target_id,)).fetchone()
            if row:
                event["target_name"] = str(row["name"])
        existing = self.connection.execute("SELECT sequence, cursor, payload FROM device_chat_messages WHERE id = ?", (event["id"],)).fetchone()
        serialized = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        if existing:
            previous = json.loads(existing["payload"])
            if previous.get("sender_id") != event.get("sender_id") or previous.get("kind") != event.get("kind"):
                raise DeviceChatError("消息编号已被房间中的其他消息占用。")
            event["created_at"] = previous.get("created_at") or event["created_at"]
            serialized = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            next_sequence = sequence if sequence is not None else int(existing["sequence"])
            existing_cursor = int(existing["cursor"])
            if serialized == existing["payload"]:
                next_cursor = max(existing_cursor, cursor or 0)
                if next_cursor > existing_cursor:
                    self.connection.execute("UPDATE device_chat_messages SET cursor = ? WHERE id = ?", (next_cursor, event["id"]))
                if cursor is not None:
                    self._advance_message_cursor(cursor)
                return {**event, "sequence": next_sequence, "cursor": next_cursor}
            next_cursor = self._advance_message_cursor(cursor)
            self.connection.execute(
                "UPDATE device_chat_messages SET sequence = ?, cursor = ?, payload = ? WHERE id = ?",
                (next_sequence, next_cursor, serialized, event["id"]),
            )
            return {**event, "sequence": next_sequence, "cursor": next_cursor}
        next_cursor = self._advance_message_cursor(cursor)
        if sequence is None:
            inserted = self.connection.execute(
                "INSERT INTO device_chat_messages(id, cursor, payload) VALUES (?, ?, ?)",
                (event["id"], next_cursor, serialized),
            )
            sequence = int(inserted.lastrowid)
        else:
            self.connection.execute(
                "INSERT INTO device_chat_messages(sequence, id, cursor, payload) VALUES (?, ?, ?, ?)",
                (sequence, event["id"], next_cursor, serialized),
            )
        return {**event, "sequence": sequence, "cursor": next_cursor}

    def _schedule_agent(self, event: dict[str, Any]) -> None:
        config = self._config()
        if not config or event.get("target_id") != self.node_id:
            return
        kind = event.get("kind")
        if kind == "assistant":
            depth = event.get("handoff_depth")
            if (
                event.get("sender_id") == self.node_id
                or not isinstance(depth, int) or isinstance(depth, bool)
                or not 1 <= depth <= MAX_AUTO_HANDOFFS
                or not isinstance(event.get("handoff_root_id"), str)
            ):
                return
        elif kind != "user":
            return
        cursor = self.connection.execute(
            "INSERT OR IGNORE INTO device_chat_agent_jobs(message_id, state, updated_at) VALUES (?, 'pending', ?)",
            (event["id"], _now()),
        )
        if cursor.rowcount == 0:
            return
        active_thread_id = self._active_agent_thread_id
        if active_thread_id and self.codex.can_interrupt_thread(active_thread_id) and not (event.get("model") or event.get("effort") or event.get("approval_policy")):
            task = asyncio.create_task(self._steer_agent(event, active_thread_id))
            self._agent_tasks.add(task)
            task.add_done_callback(self._agent_tasks.discard)
            return
        self._launch_agent(event)

    def _launch_agent(self, event: dict[str, Any]) -> None:
        task = asyncio.create_task(self._run_agent(event))
        self._agent_tasks.add(task)
        task.add_done_callback(self._agent_tasks.discard)

    async def _run_agent(self, event: dict[str, Any]) -> None:
        async with self._agent_lock:
            await self._execute_agent(event)

    async def _steer_agent(self, event: dict[str, Any], thread_id: str) -> None:
        message_id = str(event["id"])
        status_id = f"status:followup:{message_id}"
        self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'running', updated_at = ? WHERE message_id = ?", (_now(), message_id))
        config = self._config() or {}
        name = str(config.get("name", "本机 Codex"))
        try:
            await self._publish_local_agent_event("status", status_id, f"{name} 收到追加指示，正在当前回复中处理…")
            await self.codex.steer_turn(
                thread_id,
                f"用户在你处理群聊任务期间追加了一条指示。来自 {event.get('sender_name', '房间成员')}：\n{event.get('text', '')}\n请在当前回复中纳入这条指示。",
            )
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'complete', updated_at = ? WHERE message_id = ?", (_now(), message_id))
        except asyncio.CancelledError:
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'pending', updated_at = ? WHERE message_id = ?", (_now(), message_id))
            raise
        except CodexNoActiveTurnError:
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'pending', updated_at = ? WHERE message_id = ?", (_now(), message_id))
            with suppress(Exception):
                await self._publish_local_agent_event("status", status_id, f"{name} 刚完成当前回复，将在下一轮处理追加指示…")
            self._launch_agent(event)
        except Exception as error:
            with suppress(Exception):
                await self._publish_local_agent_event("error", f"reply:{message_id}", f"{name} 无法追加处理：{str(error)[:600]}")
                await self._publish_local_agent_event("status", status_id, f"{name} 未能接收追加指示。")
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'failed', updated_at = ? WHERE message_id = ?", (_now(), message_id))

    async def _publish_local_agent_event(
        self,
        kind: str,
        event_id: str,
        text: str,
        *,
        target_id: str | None = None,
        handoff_root_id: str | None = None,
        handoff_depth: int | None = None,
    ) -> None:
        config = self._config()
        if not config:
            return
        event = {
            "id": event_id, "kind": kind, "sender_id": self.node_id,
            "target_id": target_id or self.node_id, "text": text, "created_at": _now(),
        }
        if handoff_root_id is not None and handoff_depth is not None:
            event["handoff_root_id"] = handoff_root_id
            event["handoff_depth"] = handoff_depth
        if config.get("role") == "host":
            saved = self._store_event(event)
            self._broadcast({"type": "event", "event": saved})
            if kind == "assistant":
                self._schedule_agent(saved)
        else:
            await self._send_to_host(event)

    async def _execute_agent(self, event: dict[str, Any]) -> None:
        message_id = str(event["id"])
        status_id = f"status:{message_id}"
        reply_id = f"reply:{message_id}"
        self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'running', updated_at = ? WHERE message_id = ?", (_now(), message_id))
        config = self._config()
        if not config:
            return
        room = config["room"]
        name = str(config.get("name", "本机 Codex"))
        reply = ""
        turn_id: str | None = None
        thread_id: str | None = None

        handoff_root_id = str(event.get("handoff_root_id") or event["id"])
        handoff_depth = event.get("handoff_depth", 0)
        if not isinstance(handoff_depth, int) or isinstance(handoff_depth, bool):
            handoff_depth = 0

        async def publish(
            kind: str,
            event_id: str,
            text: str,
            *,
            target_id: str | None = None,
            handoff_root_id: str | None = None,
            handoff_depth: int | None = None,
        ) -> None:
            await self._publish_local_agent_event(
                kind,
                event_id,
                text,
                target_id=target_id,
                handoff_root_id=handoff_root_id,
                handoff_depth=handoff_depth,
            )

        try:
            await publish("status", status_id, f"{name} 正在处理这条群聊消息…")
            thread_id = await self.ensure_local_thread_for_agent(room, name)
            self._active_agent_thread_id = thread_id
            prompt = self._agent_prompt(event)
            thread_cwd = self.codex.workspace
            bound_cwd = self.thread_workspace(thread_id)
            if bound_cwd:
                thread_cwd = Path(bound_cwd)
            elif self._manual_thread_for_room(str(room["id"])):
                selected_thread = await self.codex.read_thread(thread_id, include_turns=False)
                selected_cwd = selected_thread.get("cwd")
                if isinstance(selected_cwd, str) and selected_cwd.strip():
                    thread_cwd = Path(selected_cwd)
            queue = await self.codex.subscribe()
            try:
                response = await self.codex.start_turn(
                    thread_id, prompt, model=event.get("model"), effort=event.get("effort"),
                    approval_policy=event.get("approval_policy") if event.get("sender_id") == self.node_id else None,
                    cwd=thread_cwd,
                )
                turn = response.get("turn") if isinstance(response, dict) else None
                turn_id = turn.get("id") if isinstance(turn, dict) and isinstance(turn.get("id"), str) else None
                reply_parts: dict[str | None, str] = {}
                last_published_reply = ""
                last_publish = time.monotonic() - AGENT_REPLY_FLUSH_INTERVAL_SECONDS

                async def flush_reply() -> None:
                    nonlocal last_publish, last_published_reply
                    if reply and reply != last_published_reply:
                        # Only the final turn publication may carry a handoff.
                        await publish("assistant", reply_id, reply)
                        last_published_reply = reply
                        last_publish = time.monotonic()

                def complete_reply_item(item: Any) -> None:
                    nonlocal reply
                    if not isinstance(item, dict):
                        return
                    item_type = str(item.get("type", "")).replace("_", "").replace("-", "").lower()
                    text = item.get("text")
                    if item_type != "agentmessage" or not isinstance(text, str) or not text:
                        return
                    item_id = item.get("id") if isinstance(item.get("id"), str) else None
                    if item_id is not None and item_id not in reply_parts and None in reply_parts:
                        # Reconcile anonymous deltas once the item ID is known.
                        reply_parts[item_id] = reply_parts.pop(None)
                    reply_parts[item_id] = text
                    reply = "\n\n".join(part for part in reply_parts.values() if part)

                while True:
                    timeout = 1800.0
                    if reply != last_published_reply:
                        timeout = last_publish + AGENT_REPLY_FLUSH_INTERVAL_SECONDS - time.monotonic()
                        if timeout <= 0:
                            await flush_reply()
                            continue
                    try:
                        notification = await asyncio.wait_for(queue.get(), timeout=timeout)
                    except asyncio.TimeoutError:
                        if reply != last_published_reply:
                            # A short burst can end before the throttle window.
                            # Flush its tail even while Codex is busy with tools.
                            await flush_reply()
                            continue
                        raise
                    if notification.get("type") == "server_request":
                        request_params = notification.get("params") if isinstance(notification.get("params"), dict) else {}
                        if request_params.get("threadId") == thread_id:
                            await publish("status", status_id, f"{name} 正在等待本机 Code Remote 批准操作；可在本机聊天列表打开设备群聊对话处理。")
                        continue
                    params = notification.get("params") if isinstance(notification.get("params"), dict) else {}
                    if params.get("threadId") != thread_id:
                        continue
                    notification_turn = params.get("turnId")
                    turn = params.get("turn")
                    if not notification_turn and isinstance(turn, dict):
                        notification_turn = turn.get("id")
                    if turn_id and notification_turn and notification_turn != turn_id:
                        continue
                    method = notification.get("method")
                    if method == "item/agentMessage/delta" and isinstance(params.get("delta"), str):
                        item_id = params.get("itemId") if isinstance(params.get("itemId"), str) else None
                        reply_parts[item_id] = reply_parts.get(item_id, "") + params["delta"]
                        reply = "\n\n".join(part for part in reply_parts.values() if part)
                    elif method == "item/completed":
                        complete_reply_item(params.get("item"))
                        await flush_reply()
                    elif method == "turn/completed":
                        status_value = turn.get("status") if isinstance(turn, dict) else None
                        if status_value == "failed":
                            detail = turn.get("error") if isinstance(turn, dict) else None
                            raise DeviceChatError(str(detail or "Codex 执行失败。"))
                        items = turn.get("items") if isinstance(turn, dict) else None
                        if isinstance(items, list):
                            ordered_parts: dict[str | None, str] = {}
                            for item in items:
                                complete_reply_item(item)
                                item_id = item.get("id") if isinstance(item, dict) else None
                                if isinstance(item_id, str) and item_id in reply_parts:
                                    ordered_parts[item_id] = reply_parts[item_id]
                            reply_parts = {**ordered_parts, **reply_parts}
                            reply = "\n\n".join(part for part in reply_parts.values() if part)
                        break
            finally:
                self.codex.unsubscribe(queue)
            if reply:
                handoff = _handoff_target(reply, self._members(), self.node_id)
                next_depth = handoff_depth + 1
                handoff_id = handoff_root_id if handoff and _can_handoff(handoff_depth) else None
                if handoff and not _can_handoff(handoff_depth):
                    await publish(
                        "status",
                        f"status:handoff-limit:{message_id}",
                        f"自动接力已达到 {MAX_AUTO_HANDOFFS} 次上限。需要继续时，请由你重新 @ 一台设备。",
                    )
                await publish(
                    "assistant",
                    reply_id,
                    reply,
                    target_id=handoff["id"] if handoff_id else None,
                    handoff_root_id=handoff_id,
                    handoff_depth=next_depth if handoff_id else None,
                )
            else:
                await publish("status", status_id, f"{name} 已处理完成。")
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'complete', updated_at = ? WHERE message_id = ?", (_now(), message_id))
        except asyncio.CancelledError:
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'pending', updated_at = ? WHERE message_id = ?", (_now(), message_id))
            raise
        except Exception as error:
            logger.info("Device chat Codex turn failed for %s: %s", message_id, error)
            with suppress(Exception):
                await publish("error", reply_id, f"{name} 执行失败：{str(error)[:600]}")
                await publish("status", status_id, f"{name} 已停止处理。")
            self.connection.execute("UPDATE device_chat_agent_jobs SET state = 'failed', updated_at = ? WHERE message_id = ?", (_now(), message_id))
        finally:
            if thread_id and self._active_agent_thread_id == thread_id:
                self._active_agent_thread_id = None

    def _thread_for_room(self, room_id: str) -> str | None:
        row = self.connection.execute("SELECT thread_id FROM device_chat_threads WHERE room_id = ?", (room_id,)).fetchone()
        return str(row["thread_id"]) if row else None

    def _agent_prompt(self, event: dict[str, Any]) -> str:
        config = self._config() or {}
        sender = str(event.get("sender_name", "房间成员"))
        content = str(event.get("text", ""))
        if len(content) >= DOCUMENT_MESSAGE_MIN_LENGTH and DOCUMENT_END_MARKER not in content:
            attachment_text = content.rstrip("\r\n")
            content = f"[附件文档：设备群聊消息.md]\n{attachment_text}\n{DOCUMENT_END_MARKER}"
        members = [
            f"- {member['name']}（{'在线' if member['online'] else '离线'}）"
            for member in self._members()
            if member["id"] != self.node_id
        ]
        member_context = "\n".join(members) or "（没有其他设备）"
        handoff_depth = event.get("handoff_depth", 0)
        can_handoff = _can_handoff(handoff_depth)
        handoff_instruction = (
            "如果确实需要另一台在线设备继续处理，请在回复最后单独一行写出 @设备准确名称；这会自动交给那台设备。"
            if can_handoff
            else f"本轮自动接力已达到 {MAX_AUTO_HANDOFFS} 次上限，不要再添加 @设备行；直接给出当前结论。"
        )
        return (
            "你正在通过 Code Remote 参加一个跨设备协作群聊。当前消息被明确发给本机设备。\n"
            f"本机设备：{config.get('name', '本机 Codex')}。房间：{config.get('room', {}).get('name', '设备协作群聊')}。\n\n"
            f"其他设备：\n{member_context}\n\n"
            f"当前来自 {sender} 的点名消息：\n{content}\n\n"
            "请直接处理这条消息并给出群聊可见的答复。若需要用户批准、缺少信息或无法执行，请明确说明。\n"
            f"{handoff_instruction} 仅使用在线设备的准确名称；普通提及设备不触发接力。"
        )

    async def _send_to_host(self, event: dict[str, Any]) -> dict[str, Any]:
        try:
            saved = await self._send_peer_http("peer-event", {"event": event})
        except DeviceChatHttpError as error:
            if 400 <= error.status_code < 500 and error.status_code not in {408, 429}:
                raise
            logger.debug("Queued device chat event for reconnect: %s", error)
            return self._queue_outbox_event(event)
        except Exception as error:
            logger.debug("Queued device chat event for reconnect: %s", error)
            return self._queue_outbox_event(event)
        if not isinstance(saved, dict) or not isinstance(saved.get("id"), str):
            return self._queue_outbox_event(event)
        self.connection.execute("UPDATE device_chat_outbox SET delivered = 1 WHERE id = ?", (event["id"],))
        return saved

    def _queue_outbox_event(self, event: dict[str, Any]) -> dict[str, Any]:
        serialized = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        self.connection.execute(
            "INSERT INTO device_chat_outbox(id, payload, created_at, delivered) VALUES (?, ?, ?, 0) "
            "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, delivered = 0",
            (event["id"], serialized, _now()),
        )
        return {**event, "sequence": -1, "delivery_state": "pending"}

    async def _outbox_flush_loop(self) -> None:
        while not self._closed:
            await asyncio.sleep(2)
            config = self._config()
            if not config or config.get("role") != "peer":
                return
            rows = self.connection.execute("SELECT id, payload FROM device_chat_outbox WHERE delivered = 0 ORDER BY created_at").fetchall()
            for row in rows:
                try:
                    event = json.loads(row["payload"])
                    response = await self._send_peer_http("peer-event", {"event": event})
                    if response.get("id") != row["id"]:
                        break
                    self.connection.execute("UPDATE device_chat_outbox SET delivered = 1 WHERE id = ?", (row["id"],))
                except asyncio.CancelledError:
                    raise
                except DeviceChatHttpError as error:
                    if 400 <= error.status_code < 500 and error.status_code not in {408, 429}:
                        self.connection.execute("UPDATE device_chat_outbox SET delivered = 2 WHERE id = ?", (row["id"],))
                        continue
                    logger.debug("Device chat outbox is waiting for the host: %s", error)
                    break
                except Exception as error:
                    logger.debug("Device chat outbox is waiting for the host: %s", error)
                    break

    async def _send_peer_http(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        config = self._config()
        if not config or config.get("role") != "peer":
            raise DeviceChatError("本机没有连接到房间设备。")
        return await asyncio.to_thread(
            self._post_json,
            f"{config['host_url']}/api/v1/device-chat/{endpoint}",
            payload,
            (self.node_id, str(config["host_token"])),
        )

    @staticmethod
    def _post_json(url: str, payload: dict[str, Any], identity: tuple[str, str] | None) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if identity:
            headers["X-Code-Remote-Node"] = identity[0]
            headers["X-Code-Remote-Token"] = identity[1]
        request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        try:
            with build_opener(ProxyHandler({})).open(request, timeout=12) as response:
                raw = response.read(2_000_000)
        except HTTPError as error:
            detail = ""
            with suppress(Exception):
                body = json.loads(error.read(100_000).decode("utf-8"))
                detail = str(body.get("detail", "")) if isinstance(body, dict) else ""
            raise DeviceChatHttpError(detail or f"房间设备返回 HTTP {error.code}。", error.code) from error
        except (URLError, TimeoutError, OSError) as error:
            raise DeviceChatError(f"连接失败：{error}") from error
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DeviceChatError("房间设备返回的数据格式无效。") from error
        if not isinstance(value, dict):
            raise DeviceChatError("房间设备返回的数据格式无效。")
        return value

    async def _peer_connection_loop(self) -> None:
        while not self._closed:
            config = self._config()
            if not config or config.get("role") != "peer":
                return
            host = urlsplit(str(config["host_url"]))
            scheme = "wss" if host.scheme == "https" else "ws"
            uri = urlunsplit((scheme, host.netloc, "/api/v1/device-chat/node", "", ""))
            self._peer_connected = False
            try:
                async with websocket_connect(uri, proxy=None, open_timeout=8, ping_interval=20, ping_timeout=20, close_timeout=2, max_size=2_000_000) as websocket:
                    last_cursor = int(self.connection.execute("SELECT COALESCE(MAX(cursor), 0) FROM device_chat_messages").fetchone()[0])
                    last_sequence = int(self.connection.execute("SELECT COALESCE(MAX(sequence), 0) FROM device_chat_messages").fetchone()[0])
                    if last_cursor == 0:
                        last_sequence = 0
                    await websocket.send(json.dumps({
                        "type": "hello", "device_id": self.node_id,
                        "token": config["host_token"], "last_cursor": last_cursor, "last_sequence": last_sequence,
                    }))
                    self._peer_connected = True
                    self._set_local_online(self.node_id, True)
                    async for raw in websocket:
                        if not isinstance(raw, str):
                            continue
                        try:
                            message = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(message, dict):
                            await self._receive_host_message(message)
                        if self._closed or not self._config():
                            return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.debug("Device chat host connection failed: %s", error)
            finally:
                self._peer_connected = False
                self._set_local_online(self.node_id, False)
            await asyncio.sleep(3)

    async def _receive_host_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "snapshot":
            room, members, events = message.get("room"), message.get("members"), message.get("events")
            config = self._config()
            if config and isinstance(room, dict):
                config["room"] = room
                self._save_config(config)
            if isinstance(members, list):
                for member in members:
                    if isinstance(member, dict):
                        self._upsert_member(member)
            if isinstance(events, list):
                for event in events:
                    if isinstance(event, dict):
                        await self._receive_event(event)
        elif kind == "event" and isinstance(message.get("event"), dict):
            await self._receive_event(message["event"])
        elif kind == "presence":
            self._set_local_online(str(message.get("device_id", "")), bool(message.get("online")))
        elif kind == "member_upsert" and isinstance(message.get("member"), dict):
            self._upsert_member(message["member"])
        elif kind == "member_removed":
            device_id = str(message.get("device_id", ""))
            self.connection.execute("DELETE FROM device_chat_members WHERE id = ?", (device_id,))
            if device_id == self.node_id:
                self._clear_room()
        elif kind == "room_closed":
            self._clear_room()

    async def _receive_event(self, event: dict[str, Any]) -> None:
        saved = self._store_event(
            event,
            sequence=int(event.get("sequence", 0)) or None,
            cursor=int(event.get("cursor", 0)) or None,
        )
        self.connection.execute("DELETE FROM device_chat_outbox WHERE id = ?", (event["id"],))
        self._schedule_agent(saved)

    def _set_local_online(self, device_id: str, online: bool) -> None:
        if self._member_exists(device_id):
            self.connection.execute("UPDATE device_chat_members SET online = ? WHERE id = ?", (int(online), device_id))

    def _clear_room(self) -> None:
        self._save_config(None)
        self.connection.execute("DELETE FROM device_chat_members")
        self.connection.execute("DELETE FROM device_chat_invites")
        self.connection.execute("DELETE FROM device_chat_messages")
        self.connection.execute("DELETE FROM device_chat_outbox")
        self.connection.execute("DELETE FROM device_chat_agent_jobs")
        self.connection.execute("DELETE FROM device_chat_threads")
        self._peer_connected = False
