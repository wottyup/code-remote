from __future__ import annotations

import io
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from codex_remote.codex_proxy_usage import CodexProxyUsageError, fetch_usage, normalize_base_url


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
        with patch("codex_remote.codex_proxy_usage.build_opener", return_value=opener):
            result = fetch_usage("http://127.0.0.1:8080/", "private-key", "history", 48)
        self.assertEqual(result, {"data_points": []})
        self.assertEqual(opener.assertions, [
            ("http://127.0.0.1:8080/admin/usage-stats/history?granularity=hourly&hours=48", "Bearer private-key", 20),
        ])

    def test_auth_failure_does_not_expose_secret(self) -> None:
        class Opener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 401, "private-key", {}, io.BytesIO(b"private-key"))

        with patch("codex_remote.codex_proxy_usage.build_opener", return_value=Opener()):
            with self.assertRaises(CodexProxyUsageError) as raised:
                fetch_usage("http://127.0.0.1:8080", "private-key", "summary")
        self.assertNotIn("private-key", str(raised.exception))
        self.assertIn("API Key", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
