"""Read Codex Proxy's fixed admin usage endpoints for a paired browser."""

from __future__ import annotations

import json
import math
import socket
import ssl
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class CodexProxyUsageError(ValueError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalize_base_url(value: str) -> str:
    url = value.strip().rstrip("/")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise CodexProxyUsageError("Codex Proxy 地址无效，请检查主机和端口。") from error
    if (parsed.scheme not in {"http", "https"} or not hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or any(char.isspace() for char in url)):
        raise CodexProxyUsageError("请填写 Codex Proxy 的 http(s) 服务地址，不包含账号、查询参数或片段。")
    _ = port
    return url


def fetch_usage(base_url: str, api_key: str, kind: str, hours: int = 24) -> dict:
    base = normalize_base_url(base_url)
    if not api_key or not api_key.strip():
        raise CodexProxyUsageError("请填写 Codex Proxy 控制面板登录密码。")
    if kind not in {"summary", "history", "client-keys"}:
        raise CodexProxyUsageError("不支持的用量查询类型。")
    if kind == "history" and not 1 <= hours <= 744:
        raise CodexProxyUsageError("查询时间范围无效。")

    if kind == "summary":
        path = "/admin/usage-stats/summary"
    elif kind == "client-keys":
        path = "/admin/client-keys"
    else:
        path = "/admin/usage-stats/history?" + urlencode({"granularity": "hourly", "hours": hours})
    # Passwords containing spaces or non-ASCII characters cannot reliably be
    # passed in a Bearer header. The dashboard accepts them as JSON instead.
    use_session = not all(0x21 <= ord(character) <= 0x7e for character in api_key)
    cookies = CookieJar()
    opener = build_opener(_NoRedirect(), HTTPCookieProcessor(cookies)) if use_session else build_opener(_NoRedirect())
    logged_in = False
    login_in_progress = False
    try:
        headers = {"Accept": "application/json", "User-Agent": "DevWisp/1.0"}
        if use_session:
            login_in_progress = True
            login = Request(base + "/auth/dashboard-login", data=json.dumps({"password": api_key}).encode("utf-8"),
                            headers={**headers, "Content-Type": "application/json"}, method="POST")
            with opener.open(login, timeout=20) as response:
                login_body = response.read(65537)
            if len(login_body) > 65536:
                raise CodexProxyUsageError("Codex Proxy 登录响应超过大小限制。")
            login_result = json.loads(login_body)
            if not isinstance(login_result, dict) or login_result.get("success") is not True or not any(cookie.name == "_codex_session" for cookie in cookies):
                raise CodexProxyUsageError("Codex Proxy 登录未成功，请检查后台登录密码。")
            logged_in = True
            login_in_progress = False
        else:
            headers["Authorization"] = f"Bearer {api_key}"
        request = Request(base + path, headers=headers, method="GET")
        with opener.open(request, timeout=20) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise CodexProxyUsageError("Codex Proxy 用量数据超过大小限制。")
        result = json.loads(body)
        if not isinstance(result, dict) or (kind == "history" and not isinstance(result.get("data_points"), list)):
            raise CodexProxyUsageError("Codex Proxy 返回了无法识别的用量数据。")
        if kind == "client-keys":
            keys = result.get("keys")
            if not isinstance(keys, list):
                raise CodexProxyUsageError("Codex Proxy 返回了无法识别的 Client Key 数据。")
            sanitized = []
            for item in keys:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                    raise CodexProxyUsageError("Codex Proxy 返回了无效的 Client Key 数据。")
                values = (item.get("used_tokens"), item.get("used_cost_usd"), item.get("request_count"))
                try:
                    valid = all(isinstance(value, (int, float)) and not isinstance(value, bool)
                                and math.isfinite(value) and 0 <= value <= 2**53 - 1 for value in values)
                except OverflowError:
                    valid = False
                if not valid:
                    raise CodexProxyUsageError("Codex Proxy 返回了无效的 Client Key 用量。")
                sanitized.append({
                    "id": item["id"],
                    "name": item.get("name") if isinstance(item.get("name"), str) else "",
                    "used_tokens": item["used_tokens"],
                    "used_cost_usd": item["used_cost_usd"],
                    "request_count": item["request_count"],
                    "last_used_at": item.get("last_used_at") if isinstance(item.get("last_used_at"), str) else None,
                })
            return {"keys": sanitized}
        return result
    except HTTPError as error:
        code = error.code
        error.close()
        if code in {301, 302, 303, 307, 308}:
            message = "接口发生重定向，请填写最终服务地址。"
        elif code in {401, 403}:
            message = "Codex Proxy 登录密码（主 API Key）无效，或没有读取管理接口的权限。"
        elif code == 404:
            message = ("当前 Codex Proxy 未提供后台登录接口，请检查版本。" if login_in_progress
                       else "当前 Codex Proxy 未提供 Client Key 统计接口，请检查版本。" if kind == "client-keys"
                       else "没有找到 Codex Proxy 用量接口，请检查服务地址和版本。")
        elif code == 429:
            message = "Codex Proxy 登录或查询过于频繁，请稍后重试。"
        else:
            message = f"Codex Proxy 请求失败（HTTP {code}）。"
        raise CodexProxyUsageError(message) from error
    except (TimeoutError, socket.timeout) as error:
        raise CodexProxyUsageError("连接 Codex Proxy 超时。") from error
    except URLError as error:
        reason = error.reason
        message = ("Codex Proxy 的 TLS 证书验证失败。" if isinstance(reason, ssl.SSLError)
                   else "连接 Codex Proxy 超时。" if isinstance(reason, TimeoutError)
                   else "无法连接 Codex Proxy，请检查地址和网络。")
        raise CodexProxyUsageError(message) from error
    except OSError as error:
        raise CodexProxyUsageError("无法连接 Codex Proxy，请检查地址和网络。") from error
    except (ValueError, UnicodeError) as error:
        if isinstance(error, CodexProxyUsageError):
            raise
        raise CodexProxyUsageError("Codex Proxy 没有返回有效 JSON。") from error
    finally:
        if logged_in:
            try:
                logout = Request(base + "/auth/dashboard-logout", data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
                with opener.open(logout, timeout=2) as response:
                    response.read(1024)
            except (OSError, ValueError):
                pass
