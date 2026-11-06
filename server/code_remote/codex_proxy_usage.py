"""Read Codex Proxy's fixed admin usage endpoints for a paired browser."""

from __future__ import annotations

import json
import socket
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


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
    if not api_key.strip() or any(character.isspace() for character in api_key.strip()):
        raise CodexProxyUsageError("请填写 Codex Proxy 的主 Proxy API Key。")
    if kind not in {"summary", "history"}:
        raise CodexProxyUsageError("不支持的用量查询类型。")
    if kind == "history" and not 1 <= hours <= 744:
        raise CodexProxyUsageError("查询时间范围无效。")

    path = "/admin/usage-stats/summary" if kind == "summary" else "/admin/usage-stats/history?" + urlencode({
        "granularity": "hourly", "hours": hours,
    })
    request = Request(base + path, headers={
        "Accept": "application/json", "Authorization": f"Bearer {api_key.strip()}", "User-Agent": "CodeRemote/1.0",
    }, method="GET")
    try:
        with build_opener(_NoRedirect()).open(request, timeout=20) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise CodexProxyUsageError("Codex Proxy 用量数据超过大小限制。")
        result = json.loads(body)
        if not isinstance(result, dict) or (kind == "history" and not isinstance(result.get("data_points"), list)):
            raise CodexProxyUsageError("Codex Proxy 返回了无法识别的用量数据。")
        return result
    except HTTPError as error:
        code = error.code
        error.close()
        if code in {301, 302, 303, 307, 308}:
            message = "接口发生重定向，请填写最终服务地址。"
        elif code in {401, 403}:
            message = "主 Proxy API Key 无效，或没有读取管理接口的权限。"
        elif code == 404:
            message = "没有找到 Codex Proxy 用量接口，请检查服务地址和版本。"
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
