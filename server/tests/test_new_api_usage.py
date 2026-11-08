from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from code_remote.app import NewAPIUsageRequest, create_app
from code_remote.new_api_usage import NewAPIUsageError, fetch_usage


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class NewAPIUsageTests(unittest.TestCase):
    def test_reads_only_status_and_scoped_usage_with_bearer_token(self) -> None:
        class Opener:
            def __init__(self):
                self.calls = []

            def open(self, request, timeout):
                self.calls.append((request.full_url, request.get_header("Authorization"), timeout))
                if request.full_url.endswith("/api/status"):
                    payload = {"success": True, "data": {"enable_data_export": True, "quota_per_unit": 500000}}
                else:
                    payload = {"success": True, "data": [{"created_at": 1700000000, "count": 2, "token_used": 25, "quota": 50}]}
                return _Response(json.dumps(payload).encode())

        opener = Opener()
        with patch("code_remote.new_api_usage.build_opener", return_value=opener):
            result = fetch_usage("https://example.com/new-api/", "nap_secret", 1700000000, 1700003600)
        self.assertEqual(result["quota_per_unit"], 500000)
        self.assertEqual(result["rows"][0]["token_used"], 25)
        self.assertEqual(opener.calls, [
            ("https://example.com/new-api/api/status", "Bearer nap_secret", 25),
            ("https://example.com/new-api/api/data/self?start_timestamp=1700000000&end_timestamp=1700003600", "Bearer nap_secret", 25),
        ])

    def test_empty_aggregate_is_valid_and_disabled_statistics_are_rejected(self) -> None:
        class Opener:
            def __init__(self, enabled):
                self.enabled = enabled
                self.calls = 0

            def open(self, request, timeout):
                self.calls += 1
                data = {"enable_data_export": self.enabled, "quota_per_unit": 500000} if self.calls == 1 else None
                return _Response(json.dumps({"success": True, "data": data}).encode())

        enabled = Opener(True)
        with patch("code_remote.new_api_usage.build_opener", return_value=enabled):
            self.assertEqual(fetch_usage("http://localhost:3000", "nap_secret", 1700000000, 1700003600)["rows"], [])
        disabled = Opener(False)
        with patch("code_remote.new_api_usage.build_opener", return_value=disabled):
            with self.assertRaisesRegex(NewAPIUsageError, "开启数据导出"):
                fetch_usage("http://localhost:3000", "nap_secret", 1700000000, 1700003600)
        self.assertEqual(disabled.calls, 1)

    def test_rc21_legacy_token_requires_user_id_header_for_personal_usage(self) -> None:
        class Opener:
            def __init__(self):
                self.calls = []

            def open(self, request, timeout):
                self.calls.append(request)
                if request.full_url.endswith('/api/status'):
                    return _Response(json.dumps({'success': True, 'data': {'enable_data_export': True, 'quota_per_unit': 500000}}).encode())
                if request.get_header('Authorization') != 'Bearer legacy_secret' or request.get_header('New-api-user') != '17':
                    raise HTTPError(request.full_url, 401, 'unauthorized', {}, io.BytesIO())
                return _Response(json.dumps({'success': True, 'data': [{'created_at': 1700000000, 'count': 2, 'token_used': 25, 'quota': 50}]}).encode())

        opener = Opener()
        with patch('code_remote.new_api_usage.build_opener', return_value=opener):
            result = fetch_usage('https://example.com', 'legacy_secret', 1700000000, 1700003600, ' 17 ')
            self.assertEqual(result['rows'][0]['token_used'], 25)
            self.assertIsNone(opener.calls[0].get_header('New-api-user'))
            self.assertEqual(opener.calls[1].get_header('New-api-user'), '17')
            self.assertNotIn('legacy_secret', opener.calls[1].full_url)
            with self.assertRaisesRegex(NewAPIUsageError, '用户 ID'):
                fetch_usage('https://example.com', 'legacy_secret', 1700000000, 1700003600)

    def test_rejects_invalid_user_id_before_any_upstream_request(self) -> None:
        with patch('code_remote.new_api_usage.build_opener') as opener:
            for user_id in ('0', '01', '-1', '1\r\nInjected: yes', '１２', '9' * 19):
                with self.subTest(user_id=user_id), self.assertRaisesRegex(NewAPIUsageError, '用户 ID'):
                    fetch_usage('https://example.com', 'legacy_secret', 1700000000, 1700003600, user_id)
            opener.assert_not_called()

    def test_rc21_rejection_in_successful_http_response_does_not_leak_token(self) -> None:
        class Opener:
            def open(self, request, timeout):
                data = {'success': True, 'data': {'enable_data_export': True, 'quota_per_unit': 500000}}
                if '/api/data/self?' in request.full_url:
                    data = {'success': False, 'message': 'legacy_secret'}
                return _Response(json.dumps(data).encode())

        with patch('code_remote.new_api_usage.build_opener', return_value=Opener()):
            with self.assertRaises(NewAPIUsageError) as raised:
                fetch_usage('https://example.com', 'legacy_secret', 1700000000, 1700003600, '17')
        self.assertIn('用户 ID', str(raised.exception))
        self.assertNotIn('legacy_secret', str(raised.exception))

    def test_rejects_invalid_time_and_hides_secret_on_auth_failure(self) -> None:
        with self.assertRaises(NewAPIUsageError):
            fetch_usage("http://localhost:3000", "nap_secret", 1700003600, 1700000000)

        class Opener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 403, "nap_secret", {}, io.BytesIO(b"nap_secret"))

        with patch("code_remote.new_api_usage.build_opener", return_value=Opener()):
            with self.assertRaises(NewAPIUsageError) as raised:
                fetch_usage("http://localhost:3000", "nap_secret", 1700000000, 1700003600)
        self.assertNotIn("nap_secret", str(raised.exception))
        self.assertIn("usage:read", str(raised.exception))


class NewAPIUsageEndpointTests(unittest.IsolatedAsyncioTestCase):
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
        self.endpoint = next(route.endpoint for route in self.app.routes if getattr(route, 'path', None) == '/api/v1/codex/usage/new-api')

    async def test_request_body_reaches_rc21_upstream_with_user_id(self) -> None:
        class Opener:
            def open(self, request, timeout):
                if request.full_url.endswith('/api/status'):
                    data = {'enable_data_export': True, 'quota_per_unit': 500000}
                else:
                    if request.get_header('New-api-user') != '17' or request.get_header('Authorization') != 'Bearer legacy_secret':
                        raise HTTPError(request.full_url, 401, 'unauthorized', {}, io.BytesIO())
                    data = [{'created_at': 1700000000, 'count': 2, 'token_used': 25, 'quota': 50}]
                return _Response(json.dumps({'success': True, 'data': data}).encode())

        body = NewAPIUsageRequest(baseUrl='https://example.com', accessToken='legacy_secret', userId='17', startTimestamp=1700000000, endTimestamp=1700003600)
        with patch('code_remote.new_api_usage.build_opener', return_value=Opener()):
            result = await self.endpoint(body)
        self.assertEqual(result['rows'][0]['token_used'], 25)
        self.assertEqual(NewAPIUsageRequest(baseUrl='https://example.com', accessToken='nap_secret', startTimestamp=1700000000, endTimestamp=1700003600).userId, '')


if __name__ == "__main__":
    unittest.main()
