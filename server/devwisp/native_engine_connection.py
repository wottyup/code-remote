"""Small real model requests for native API configuration diagnostics."""

from __future__ import annotations

import asyncio
import json
import ssl
import time
from http.client import HTTPException as HTTPTransportError
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .native_engine_config import NativeEngineConfigError
from .native_engine_protocol import api_endpoint


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Credentials must never be forwarded to a redirected host.
        return None


def _endpoint(profile: dict) -> str:
    return api_endpoint(profile)


def _check_model(profile: dict, model: str) -> dict:
    started = time.monotonic()
    headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "DevWisp/1.0"}
    key = profile["apiKey"]
    if profile["authMode"] == "api_key":
        headers["x-api-key"] = key
    else:
        headers["Authorization"] = f"Bearer {key}"
    if profile["protocol"] == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
        payload = {"model": model, "max_tokens": 64, "messages": [{"role": "user", "content": "Reply only OK."}]}
    elif profile["protocol"] == "chat":
        payload = {"model": model, "max_completion_tokens": 128, "stream": False,
                   "messages": [{"role": "user", "content": "Reply only OK."}]}
    else:
        payload = {"model": model, "max_output_tokens": 128, "input": "Reply only OK.", "stream": False}
    request = Request(_endpoint(profile), data=json.dumps(payload).encode(), headers=headers, method="POST")
    ok = False
    message = ""
    try:
        opener = build_opener(_NoRedirect())
        try:
            response = opener.open(request, timeout=20)
        except HTTPError as error:
            if profile["protocol"] != "chat" or error.code != 400:
                raise
            error.close()
            payload["max_tokens"] = payload.pop("max_completion_tokens")
            request = Request(_endpoint(profile), data=json.dumps(payload).encode(), headers=headers, method="POST")
            response = opener.open(request, timeout=20)
        with response:
            body = response.read(256_001)
        if len(body) > 256_000:
            raise NativeEngineConfigError("接口响应超过限制。")
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise NativeEngineConfigError("接口返回了非预期的响应格式，请检查协议和地址。")
        if profile["protocol"] == "anthropic":
            content = parsed.get("content")
            ok = parsed.get("type") == "message" and isinstance(content, list) and any(
                isinstance(item, dict) and item.get("type") == "text" and item.get("text") for item in content
            )
        elif profile["protocol"] == "chat":
            choices = parsed.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
            response = choice.get("message") or {}
            ok = isinstance(response, dict) and bool(response.get("content")) and choice.get("finish_reason") in {"stop", "length"}
        else:
            output = parsed.get("output")
            ok = parsed.get("status") == "completed" and isinstance(output, list) and any(
                isinstance(item, dict) and item.get("type") == "message" and any(
                    isinstance(part, dict) and part.get("type") == "output_text" and part.get("text")
                    for part in (item.get("content") if isinstance(item.get("content"), list) else [])
                ) for item in output
            )
        if ok:
            message = "连接成功，模型已返回回复。"
        elif profile["protocol"] == "chat" and choice.get("finish_reason") == "length":
            ok = True
            message = "接口已连通，模型已接受请求；为控制用量，短测试在输出上限处结束。"
        elif parsed.get("status") == "incomplete":
            details = parsed.get("incomplete_details")
            if isinstance(details, dict) and details.get("reason") == "max_output_tokens" and isinstance(parsed.get("output"), list):
                ok = True
                message = "接口已连通，模型已接受请求；为控制用量，短测试在输出上限处结束。"
            else:
                message = "接口已响应，但未生成完整回复；请检查模型的输出限制。"
        else:
            message = "接口未返回符合所选协议的模型回复，请检查模型、协议及地址。"
    except HTTPError as error:
        code = error.code
        error.close()
        details = {
            400: "请求被拒绝，请检查协议、模型名称及模型参数支持情况。",
            401: "认证失败，请检查密钥和密钥传递方式。",
            403: "无访问权限，请检查密钥权限或网关限制。",
            404: "接口或模型不存在，请检查地址中的 /v1 和模型名称。",
            405: "接口不接受模型请求，请检查 API 地址。",
            429: "请求限流或额度不足，请稍后重试。",
        }
        message = f"HTTP {code}：" + ("接口要求重定向，请填写最终 API 地址。" if 300 <= code < 400 else details.get(code, "上游服务异常，请检查服务状态。"))
    except (TimeoutError,):
        message = "连接或模型回复超过 20 秒，请检查网络或稍后重试。"
    except (URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        message = "TLS 证书验证失败，请检查接口证书。" if isinstance(reason, ssl.SSLError) else "无法连接接口，请检查地址、端口和服务器网络。"
    except HTTPTransportError:
        message = "接口在回复完成前断开，请检查服务器网络或稍后重试。"
    except (ValueError, UnicodeError):
        message = "接口没有返回有效 JSON，请确认地址指向 API 服务。"
    except NativeEngineConfigError as error:
        message = str(error)
    return {"model": model, "ok": bool(ok), "latencyMs": round((time.monotonic() - started) * 1000), "message": message}


async def check_connection(profile: dict, semaphore: asyncio.Semaphore) -> dict:
    mappings = profile["models"]
    default = profile["model"]
    models = []
    if default:
        models.append(mappings.get(default, {}).get("model") or default)
    models.extend(entry["model"] for entry in mappings.values() if entry.get("model"))
    models = list(dict.fromkeys(models))
    if not models:
        raise NativeEngineConfigError("请填写默认模型或至少一个角色的实际请求模型，再测试连通性。")

    async def run(model: str) -> dict:
        async with semaphore:
            return await asyncio.to_thread(_check_model, profile, model)

    results = await asyncio.gather(*(run(model) for model in models))
    return {"ok": all(result["ok"] for result in results), "results": results}
