"""Private, revision-checked API profiles for the native coding engines."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from .native_engine_config import (
    CLAUDE_MODEL_ROLES, NATIVE_PROTOCOLS, NativeEngineConfigError, NativeEngineConfigStore,
)
from .native_engine_protocol import PROTOCOLS, normalize_base_url

if TYPE_CHECKING:
    from .native_engine_gateway import NativeEngineGateway

PROFILE_FIELDS = ("baseUrl", "apiKey", "authMode", "protocol", "model", "models")
MAX_PROFILES = 30


def _text(value: object, label: str, limit: int = 256) -> str:
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise NativeEngineConfigError(f"{label}格式无效或过长。")
    return value.strip()


class NativeEngineProfiles:
    def __init__(self, directory: Path, native: NativeEngineConfigStore, gateway: NativeEngineGateway | None = None) -> None:
        self.directory = directory
        self.native = native
        self.gateway = gateway
        self._lock = threading.RLock()

    def _load(self, engine: str) -> tuple[Path, bytes | None, dict, dict]:
        source = self.native.profile_source(engine)
        if self.gateway:
            source = self.gateway.restore(engine, source)
        path = (self.directory / f"native-{engine}-profiles.json").resolve()
        data = self.native._read_bytes(path)
        if data is None:
            profiles = []
            if source["baseUrl"]:
                profiles.append({
                    "id": "local", "name": "本机当前配置",
                    **{field: copy.deepcopy(source[field]) for field in PROFILE_FIELDS},
                })
            return path, data, {"version": 1, "preferredActiveId": "local" if profiles else None, "profiles": profiles}, source
        try:
            library = json.loads(data)
            if not isinstance(library, dict) or library.get("version") != 1 or not isinstance(library.get("profiles"), list):
                raise ValueError()
            if len(library["profiles"]) > MAX_PROFILES:
                raise ValueError()
            ids = set()
            for profile in library["profiles"]:
                if not isinstance(profile, dict) or not isinstance(profile.get("id"), str) or profile["id"] in ids:
                    raise ValueError()
                ids.add(profile["id"])
                for field in ("name", *PROFILE_FIELDS):
                    if field == "models":
                        if not isinstance(profile.get(field), dict):
                            raise ValueError()
                        for role, entry in profile[field].items():
                            if role not in CLAUDE_MODEL_ROLES or not isinstance(entry, dict) or any(
                                not isinstance(entry.get(name, ""), str) for name in ("model", "displayName")
                            ):
                                raise ValueError()
                    elif not isinstance(profile.get(field), str):
                        raise ValueError()
        except (ValueError, TypeError, UnicodeDecodeError):
            raise NativeEngineConfigError("已保存的配置库格式无效，请在本机修复后重试。") from None
        return path, data, library, source

    def _revision(self, path: Path, data: bytes | None, source: dict) -> str:
        revision = self.native._revision(path, data)
        # Until the first save, the imported profile is a view of the native
        # file. Changes to that source must invalidate an open editor as well.
        if data is None:
            revision = hashlib.sha256(f"{revision}:{source['revision']}".encode()).hexdigest()
        return revision

    @staticmethod
    def _active_id(library: dict, source: dict) -> str | None:
        matches = [profile["id"] for profile in library["profiles"] if all(
            profile.get(field) == source.get(field) for field in PROFILE_FIELDS
        )]
        preferred = library.get("preferredActiveId")
        return preferred if preferred in matches else next(iter(matches), None)

    def _public(self, path: Path, data: bytes | None, library: dict, source: dict) -> dict:
        return {
            **{key: value for key, value in source.items() if key != "apiKey" and not key.startswith("_")},
            "profilesRevision": self._revision(path, data, source),
            "supportedProtocols": ["responses", "anthropic", "chat"],
            "activeProfileId": self._active_id(library, source),
            "profiles": [
                {**{key: value for key, value in profile.items() if key != "apiKey"}, "hasKey": bool(profile.get("apiKey"))}
                for profile in library["profiles"]
            ],
        }

    def read(self, engine: str) -> dict:
        with self._lock:
            return self._public(*self._load(engine))

    def _draft(self, engine: str, draft: dict, library: dict) -> dict:
        profile_id = draft.get("profileId")
        existing = next((item for item in library["profiles"] if item["id"] == profile_id), None)
        if profile_id and existing is None:
            raise NativeEngineConfigError("该配置已被删除，请重新读取。", conflict=True)
        protocol = draft.get("protocol")
        if protocol not in PROTOCOLS:
            raise NativeEngineConfigError("不支持的接口协议。")
        name = _text(draft.get("name", ""), "配置名称", 80)
        if not name:
            raise NativeEngineConfigError("请填写配置名称。")
        model = _text(draft.get("model", ""), "默认模型")
        if engine == "codex" and not model:
            raise NativeEngineConfigError("请填写 Codex 默认模型的实际请求名称。")
        if engine == "claude" and protocol != "anthropic" and not model:
            raise NativeEngineConfigError("跨协议连接请填写默认模型，也可以填写已配置映射的角色名。")
        key = self.native._api_key(self.native._api_key(draft.get("apiKey", "")) or (existing or {}).get("apiKey", ""))
        if not key:
            raise NativeEngineConfigError("请填写此配置的 API 密钥。")
        auth_mode = draft.get("authMode", "bearer")
        if auth_mode not in {"bearer", "api_key"}:
            raise NativeEngineConfigError("不支持的密钥传递方式。")
        mappings = {}
        if engine == "claude":
            models = draft.get("models", {})
            if not isinstance(models, dict) or any(role not in CLAUDE_MODEL_ROLES for role in models):
                raise NativeEngineConfigError("模型映射角色无效。")
            for role in CLAUDE_MODEL_ROLES:
                entry = models.get(role, {})
                if not isinstance(entry, dict):
                    raise NativeEngineConfigError("模型映射格式无效。")
                mappings[role] = {
                    "model": _text(entry.get("model", ""), f"{role.title()} 请求模型"),
                    "displayName": _text(entry.get("displayName", ""), f"{role.title()} 显示名称", 80),
                }
        url = normalize_base_url(self.native._api_url(draft.get("baseUrl", "")), protocol)
        return {
            "id": profile_id or uuid.uuid4().hex,
            "name": name,
            "baseUrl": url,
            "apiKey": key,
            "authMode": auth_mode,
            "protocol": protocol,
            "model": model,
            "models": mappings,
        }

    def _check_revision(self, path: Path, data: bytes | None, source: dict, expected: str) -> None:
        if expected != self._revision(path, data, source):
            raise NativeEngineConfigError("配置已在其他页面或本机被修改，请重新读取后再保存。", conflict=True)

    def save(self, engine: str, draft: dict, expected: str, *, apply: bool, expected_native: str | None) -> dict:
        with self._lock:
            path, data, library, source = self._load(engine)
            self._check_revision(path, data, source, expected)
            if apply and source["revision"] != expected_native:
                raise NativeEngineConfigError("本机 CLI 配置已被修改，请重新读取后再应用。", conflict=True)
            profile = self._draft(engine, draft, library)
            profiles = library["profiles"]
            if any(item["id"] != profile["id"] and item["name"].casefold() == profile["name"].casefold() for item in profiles):
                raise NativeEngineConfigError("已有同名配置，请换一个配置名称。")
            index = next((i for i, item in enumerate(profiles) if item["id"] == profile["id"]), None)
            if index is None:
                if len(profiles) >= MAX_PROFILES:
                    raise NativeEngineConfigError(f"每种引擎最多保存 {MAX_PROFILES} 套配置。")
                profiles.append(profile)
            else:
                profiles[index] = profile
            if apply:
                library["preferredActiveId"] = profile["id"]
            encoded = (json.dumps(library, ensure_ascii=False, indent=2) + "\n").encode()
            self.native.atomic_write(path, encoded, self.native._revision(path, data))
            result: dict = {"profileId": profile["id"], "changed": False, "applied": False}
            if apply:
                prepared = None
                try:
                    if self.gateway:
                        prepared = self.gateway.prepare(engine, profile, source)
                    elif protocol_requires_gateway(engine, profile):
                        raise NativeEngineConfigError("此服务尚未启用本机协议转换，请更新并重启后端。")
                    else:
                        prepared = profile
                    saved = self.native.save(
                        engine, prepared["baseUrl"], prepared["apiKey"], prepared["authMode"],
                        expected_native or "", profile["model"], profile["models"],
                    )
                    result.update(changed=saved["changed"], applied=True)
                except NativeEngineConfigError as error:
                    if self.gateway and prepared:
                        self.gateway.discard_prepared(prepared)
                    # The reusable profile is already safely stored. Report the
                    # partial outcome so the UI never retries a create blindly.
                    result["applyError"] = f"配置已保存，但未应用到 CLI：{error}"
            result["config"] = self.read(engine)
            return result

    def delete(self, engine: str, profile_id: str, expected: str) -> dict:
        with self._lock:
            path, data, library, source = self._load(engine)
            self._check_revision(path, data, source, expected)
            if self._active_id(library, source) == profile_id:
                raise NativeEngineConfigError("请先应用另一套配置，再删除当前正在使用的配置。")
            if not any(item["id"] == profile_id for item in library["profiles"]):
                raise NativeEngineConfigError("该配置已被删除，请重新读取。", conflict=True)
            library["profiles"] = [item for item in library["profiles"] if item["id"] != profile_id]
            if library.get("preferredActiveId") == profile_id:
                library["preferredActiveId"] = None
            encoded = (json.dumps(library, ensure_ascii=False, indent=2) + "\n").encode()
            self.native.atomic_write(path, encoded, self.native._revision(path, data))
            return self.read(engine)

    def connection_draft(self, engine: str, draft: dict, expected: str) -> dict:
        with self._lock:
            path, data, library, source = self._load(engine)
            self._check_revision(path, data, source, expected)
            return self._draft(engine, draft, library)


def protocol_requires_gateway(engine: str, profile: dict) -> bool:
    return profile["protocol"] != NATIVE_PROTOCOLS[engine] or (engine == "codex" and profile["authMode"] != "bearer")
