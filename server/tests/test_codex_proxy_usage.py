from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

from code_remote.app import CodexProxyUsageRequest, create_app
from code_remote.codex_proxy_usage import CodexProxyUsageError, fetch_usage, normalize_base_url


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class CodexProxyUsageTests(unittest.TestCase):
    def test_rejects_unsafe_or_invalid_service_addresses(self) -> None:
        for address in ("file:///etc/passwd", "http://user:secret@example.com", "http://example.com/?key=secret", "http://[bad", "http://example.com:bad"):
            with self.subTest(address=address), self.assertRaises(CodexProxyUsageError):
                normalize_base_url(address)

    def test_requests_only_fixed_history_path_with_bearer_key(self) -> None:
        class Opener:
            def open(self, request, timeout):
                self_url = request.full_url
                self.assertions.append((self_url, request.get_header("Authorization"), timeout))
                return _Response(json.dumps({"data_points": []}).encode())

            def __init__(self):
                self.assertions = []

        opener = Opener()
        with patch("code_remote.codex_proxy_usage.build_opener", return_value=opener):
            result = fetch_usage("http://127.0.0.1:8080/", "private-key", "history", 48)
        self.assertEqual(result, {"data_points": []})
        self.assertEqual(opener.assertions, [
            ("http://127.0.0.1:8080/admin/usage-stats/history?granularity=hourly&hours=48", "Bearer private-key", 20),
        ])

    def test_auth_failure_does_not_expose_secret(self) -> None:
        class Opener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 401, "private-key", {}, io.BytesIO(b"private-key"))

        with patch("code_remote.codex_proxy_usage.build_opener", return_value=Opener()):
            with self.assertRaises(CodexProxyUsageError) as raised:
                fetch_usage("http://127.0.0.1:8080", "private-key", "summary")
        self.assertNotIn("private-key", str(raised.exception))
        self.assertIn("API Key", str(raised.exception))

    def test_client_key_usage_returns_only_safe_statistics(self) -> None:
        class Opener:
            def open(self, request, timeout):
                self.request = request
                return _Response(json.dumps({'keys': [{
                    'id': 'ck_1', 'name': 'Alice', 'status': 'active', 'used_tokens': 123,
                    'used_cost_usd': 0.02, 'request_count': 3, 'last_used_at': None,
                    'key': 'full_client_secret', 'key_masked': 'sk-...secret',
                }]}).encode())

        opener = Opener()
        with patch('code_remote.codex_proxy_usage.build_opener', return_value=opener):
            result = fetch_usage('https://example.com/proxy', 'admin-secret', 'client-keys')
        self.assertEqual(opener.request.full_url, 'https://example.com/proxy/admin/client-keys')
        self.assertEqual(opener.request.get_header('Authorization'), 'Bearer admin-secret')
        self.assertEqual(result['keys'][0]['used_tokens'], 123)
        self.assertNotIn('key', result['keys'][0])
        self.assertNotIn('key_masked', result['keys'][0])
        self.assertNotIn('full_client_secret', json.dumps(result))

    def test_invalid_client_key_counts_are_not_reported_as_zero(self) -> None:
        class Opener:
            def open(self, request, timeout):
                return _Response(json.dumps({'keys': [{'id': 'ck_1', 'used_tokens': None, 'used_cost_usd': 0.1, 'request_count': 2}]}).encode())

        with patch('code_remote.codex_proxy_usage.build_opener', return_value=Opener()):
            with self.assertRaisesRegex(CodexProxyUsageError, 'Client Key 用量'):
                fetch_usage('https://example.com', 'admin-secret', 'client-keys')

    def test_old_upstream_without_client_key_endpoint_has_specific_error(self) -> None:
        class Opener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 404, 'missing', {}, io.BytesIO())

        with patch('code_remote.codex_proxy_usage.build_opener', return_value=Opener()):
            with self.assertRaisesRegex(CodexProxyUsageError, '未提供 Client Key 统计接口'):
                fetch_usage('https://example.com', 'admin-secret', 'client-keys')

    def test_dashboard_password_with_spaces_and_unicode_uses_session_and_logs_out(self) -> None:
        events = []
        password = ' 密码 123 '

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                if self.path == '/auth/dashboard-login':
                    events.append('login')
                    if body.get('password') != password:
                        self.send_response(401)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header('Set-Cookie', '_codex_session=test-session; HttpOnly; Path=/')
                elif self.path == '/auth/dashboard-logout' and self.headers.get('Cookie') == '_codex_session=test-session':
                    events.append('logout')
                    self.send_response(200)
                else:
                    self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"success":true}')

            def do_GET(self):
                events.append(self.path)
                if self.path != '/admin/client-keys' or self.headers.get('Cookie') != '_codex_session=test-session':
                    self.send_response(401)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"keys":[]}')

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            self.assertEqual(fetch_usage(base, password, 'client-keys'), {'keys': []})
            self.assertEqual(events, ['login', '/admin/client-keys', 'logout'])
            with self.assertRaises(CodexProxyUsageError) as raised:
                fetch_usage(base, '错误 密码', 'client-keys')
            self.assertNotIn('错误 密码', str(raised.exception))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


class CodexProxyUsageEndpointTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        runtime = root / 'runtime'
        runtime.mkdir()
        with (
            patch.dict(os.environ, {'CODE_REMOTE_AUTH_FILE': str(root / 'auth.json')}),
            patch('code_remote.app.tempfile.mkdtemp', return_value=str(runtime)),
        ):
            self.app = create_app(root)
        self.addCleanup(self.app.state.shared_state.close)
        self.addAsyncCleanup(self.app.state.claude_code.close)
        self.endpoint = next(route.endpoint for route in self.app.routes if getattr(route, 'path', None) == '/api/v1/codex/usage/codex-proxy/{kind}')

    async def test_client_key_route_forwards_request_and_filters_secrets(self) -> None:
        class Opener:
            def open(self, request, timeout):
                if not request.full_url.endswith('/admin/client-keys') or request.get_header('Authorization') != 'Bearer admin-secret':
                    raise HTTPError(request.full_url, 401, 'unauthorized', {}, io.BytesIO())
                return _Response(json.dumps({'keys': [{'id': 'ck_1', 'name': 'Alice', 'used_tokens': 25,
                                                       'used_cost_usd': 0.1, 'request_count': 2, 'key': 'secret-client-key'}]}).encode())

        body = CodexProxyUsageRequest(baseUrl='https://example.com', apiKey='admin-secret')
        with patch('code_remote.codex_proxy_usage.build_opener', return_value=Opener()):
            result = await self.endpoint('client-keys', body)
        self.assertEqual(result['keys'][0]['used_tokens'], 25)
        self.assertNotIn('secret-client-key', json.dumps(result))
        parameters = self.app.openapi()['paths']['/api/v1/codex/usage/codex-proxy/{kind}']['post']['parameters']
        kind = next(parameter for parameter in parameters if parameter['name'] == 'kind')
        self.assertIn('client-keys', kind['schema']['enum'])


if __name__ == "__main__":
    unittest.main()
