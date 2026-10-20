from __future__ import annotations

import json
import logging
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

logger = logging.getLogger(__name__)

_ANALYTICS_PATH = "/v0/management/monitoring/analytics"
_REQUEST_TIMEOUT_SECONDS = 20
_MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class CPAUsageError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def normalize_manager_base_url(value: str) -> str:
    trimmed = value.strip().rstrip("/")
    if not trimmed:
        raise CPAUsageError("请填写 Manager Server 地址。", status_code=422)
    try:
        parsed = urlsplit(trimmed)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("invalid scheme or host")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("credentials, query, and fragment are not allowed")
        # Accessing hostname also validates malformed bracketed IPv6 addresses.
        if not parsed.hostname:
            raise ValueError("missing host")
        parsed.port
    except ValueError as error:
        raise CPAUsageError("地址格式无效，请填写 Manager Server 的 http(s) 地址，不能带账号、密码、查询参数或片段。", status_code=422) from error
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


class CPAUsageSettingsStore:
    """Persist shared Manager credentials in the private Codex Remote SQLite state."""

    _metadata_key = "cpa_usage_settings"

    def __init__(self, state_store: Any) -> None:
        self.state_store = state_store

    def get_credentials(self) -> dict[str, str]:
        raw = self.state_store.get_metadata(self._metadata_key)
        if raw is None:
            return {"base_url": "", "management_key": ""}
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed shared CPA Manager settings")
            return {"base_url": "", "management_key": ""}
        if not isinstance(value, dict) or value.get("version") != 1:
            logger.warning("Ignoring unsupported shared CPA Manager settings")
            return {"base_url": "", "management_key": ""}
        base_url = value.get("base_url")
        management_key = value.get("management_key")
        if not isinstance(base_url, str) or not isinstance(management_key, str):
            return {"base_url": "", "management_key": ""}
        return {"base_url": base_url, "management_key": management_key}

    def save(self, base_url: str, management_key: str) -> None:
        self.state_store.set_metadata(self._metadata_key, json.dumps(
            {"version": 1, "base_url": base_url, "management_key": management_key},
            ensure_ascii=False,
            separators=(",", ":"),
        ))

    def clear(self) -> None:
        self.state_store.delete_metadata(self._metadata_key)


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def request_manager_analytics(
    base_url: str,
    management_key: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    url = f"{normalize_manager_base_url(base_url)}{_ANALYTICS_PATH}"
    request = Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {management_key}",
        },
        method="POST",
    )
    opener = build_opener(_NoRedirectHandler())
    try:
        with opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        if error.code == 401:
            raise CPAUsageError(
                "Manager 返回 HTTP 401：管理密钥未通过认证，请确认使用的是 CLIProxyAPI 的管理密钥。",
                status_code=502,
            ) from error
        if error.code == 403:
            raise CPAUsageError(
                "Manager 返回 HTTP 403：远程管理请求被拒绝。请检查 management.allow-remote 设置、来源 IP 限制或临时封禁。",
                status_code=502,
            ) from error
        if error.code == 404:
            raise CPAUsageError("没有找到用量分析接口。请确认是 CPA-Manager-Plus Full Mode 的服务地址和反向代理路径。", status_code=502) from error
        if error.code in {502, 503, 504}:
            raise CPAUsageError(f"Manager Server 暂时不可用（HTTP {error.code}）。", status_code=502) from error
        raise CPAUsageError(f"Manager Server 请求失败（HTTP {error.code}）。", status_code=502) from error
    except (URLError, TimeoutError, OSError) as error:
        raise CPAUsageError("无法连接 Manager Server。请检查地址、HTTPS 和服务器网络。", status_code=502) from error

    if len(body) > _MAX_RESPONSE_BYTES:
        raise CPAUsageError("Manager Server 返回的数据过大。", status_code=502)
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CPAUsageError("Manager Server 返回了无法识别的数据。", status_code=502) from error
    if not isinstance(value, dict):
        raise CPAUsageError("Manager Server 返回了无法识别的数据。", status_code=502)
    return value


def connection_probe_payload() -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    return {
        "from_ms": max(0, now_ms - 60_000),
        "to_ms": now_ms,
        "time_zone": "UTC",
        "include": {"filter_options": True, "filter_selectors": True},
    }
