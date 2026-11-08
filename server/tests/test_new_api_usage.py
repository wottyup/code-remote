from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

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


if __name__ == "__main__":
    unittest.main()
