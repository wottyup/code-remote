"""Read New API's own usage aggregate through two fixed upstream endpoints."""

from __future__ import annotations

import json
import math
import socket
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .codex_proxy_usage import normalize_base_url


MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class NewAPIUsageError(ValueError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_json(base_url: str, access_token: str, path: str, user_id: str = "") -> dict:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "DevWisp/1.0",
    }
    if user_id:
        headers["New-Api-User"] = user_id
    request = Request(base_url + path, headers=headers, method="GET")
    try:
        with build_opener(_NoRedirect()).open(request, timeout=25) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise NewAPIUsageError("New API 统计数据超过大小限制。")
        result = json.loads(body)
        if isinstance(result, dict) and result.get("success") is False and path.startswith("/api/data/self"):
            message = result.get("message")
            if isinstance(message, str) and ("time range cannot exceed" in message.lower() or "时间跨度不能超过" in message):
                raise NewAPIUsageError("New API 拒绝查询时间范围，请检查服务端日志保留天数。")
            raise NewAPIUsageError("New API 未能读取用量，请检查面板访问令牌、用户 ID 和统计权限。")
        if not isinstance(result, dict) or result.get("success") is not True:
            raise NewAPIUsageError("New API 未返回有效的服务状态，请检查服务地址和运行状态。")
        return result
    except HTTPError as error:
        code = error.code
        error.close()
        if code in {301, 302, 303, 307, 308}:
            message = "New API 接口发生重定向，请填写最终服务地址。"
        elif code in {401, 403}:
            message = "New API 授权失败：请检查面板访问令牌和用户 ID；新版令牌需要 usage:read 权限。"
        elif code == 404:
            message = "没有找到 New API 用量接口，请检查服务地址和版本。"
        elif code == 400:
            message = "New API 拒绝查询时间范围，请检查服务端日志保留天数。"
        else:
            message = f"New API 请求失败（HTTP {code}）。"
        raise NewAPIUsageError(message) from error
    except (TimeoutError, socket.timeout) as error:
        raise NewAPIUsageError("连接 New API 超时。") from error
    except URLError as error:
        reason = error.reason
        message = ("New API 的 TLS 证书验证失败。" if isinstance(reason, ssl.SSLError)
                   else "连接 New API 超时。" if isinstance(reason, TimeoutError)
                   else "无法连接 New API，请检查地址和网络。")
        raise NewAPIUsageError(message) from error
    except OSError as error:
        raise NewAPIUsageError("无法连接 New API，请检查地址和网络。") from error
    except (ValueError, UnicodeError) as error:
        if isinstance(error, NewAPIUsageError):
            raise
        raise NewAPIUsageError("New API 没有返回有效 JSON。") from error


def fetch_usage(base_url: str, access_token: str, start_timestamp: int, end_timestamp: int, user_id: str = "") -> dict:
    try:
        base = normalize_base_url(base_url)
    except ValueError as error:
        raise NewAPIUsageError(str(error).replace("Codex Proxy", "New API")) from error
    secret = access_token.strip()
    if not secret or any(character.isspace() for character in secret):
        raise NewAPIUsageError("请填写 New API 面板访问令牌，不是登录密码。")
    user_id = user_id.strip()
    if user_id and (not user_id.isascii() or not user_id.isdecimal() or user_id.startswith("0") or len(user_id) > 18):
        raise NewAPIUsageError("New API 用户 ID 应为正整数。")
    if start_timestamp <= 0 or end_timestamp < start_timestamp or end_timestamp - start_timestamp > 32 * 86400:
        raise NewAPIUsageError("New API 查询时间范围无效。")

    status = _read_json(base, secret, "/api/status").get("data")
    if not isinstance(status, dict):
        raise NewAPIUsageError("New API 未返回服务状态。")
    if status.get("enable_data_export") is not True:
        raise NewAPIUsageError("New API 未开启数据统计，请在其后台开启数据导出。")
    quota_per_unit = status.get("quota_per_unit")
    if (not isinstance(quota_per_unit, (int, float)) or isinstance(quota_per_unit, bool)
            or not math.isfinite(quota_per_unit) or quota_per_unit <= 0):
        raise NewAPIUsageError("New API 返回了无效的额度换算设置。")

    query = urlencode({"start_timestamp": start_timestamp, "end_timestamp": end_timestamp})
    rows = _read_json(base, secret, f"/api/data/self?{query}", user_id).get("data")
    if rows is None:
        rows = []  # New API serializes an empty Go slice as null.
    if not isinstance(rows, list):
        raise NewAPIUsageError("New API 未返回有效的用量列表。")
    return {"rows": rows, "quota_per_unit": quota_per_unit}
