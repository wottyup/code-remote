from __future__ import annotations

import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from codex_remote.app import PairingAuth


class PairingAuthTests(unittest.TestCase):
    def test_windows_default_state_uses_local_app_data_or_configured_home(self) -> None:
        with (
            patch("codex_remote.app.os.name", "nt"),
            patch.dict(os.environ, {"LOCALAPPDATA": "C:/Users/test/AppData/Local"}, clear=False),
            patch.dict(os.environ, {"CODEX_REMOTE_HOME": "", "CODEX_REMOTE_AUTH_FILE": ""}, clear=False),
        ):
            self.assertEqual(
                Path("C:/Users/test/AppData/Local/CodexRemote/trusted-devices.json"),
                PairingAuth._default_state_path(),
            )
        with (
            patch("codex_remote.app.os.name", "nt"),
            patch.dict(os.environ, {"CODEX_REMOTE_HOME": "C:/UserWritable/RemoteData", "CODEX_REMOTE_AUTH_FILE": ""}, clear=False),
        ):
            self.assertEqual(
                Path("C:/UserWritable/RemoteData/trusted-devices.json"),
                PairingAuth._default_state_path(),
            )

    def test_windows_default_state_imports_legacy_tokens_into_writable_v2_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_path = root / "trusted-devices.json"
            state_path = root / "trusted-devices-v2.json"
            legacy_token = "legacy-browser-token"
            legacy_path.write_text(
                '{"version":1,"token_hashes":["' + PairingAuth._token_hash(legacy_token) + '"]}\n',
                encoding="utf-8",
            )

            with (
                patch.object(PairingAuth, "_default_state_path", return_value=state_path),
                patch.object(PairingAuth, "_legacy_state_paths", return_value=(legacy_path,)),
                patch.dict("os.environ", {}, clear=False),
            ):
                auth = PairingAuth()
                new_token = auth.pair(auth.code)

            self.assertTrue(auth.accepts(legacy_token))
            self.assertIsNotNone(new_token)
            restarted_process = PairingAuth(state_path)
            self.assertTrue(restarted_process.accepts(legacy_token))
            self.assertTrue(restarted_process.accepts(new_token))

    def test_windows_default_state_does_not_reimport_revoked_legacy_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_path = root / "trusted-devices.json"
            state_path = root / "trusted-devices-v2.json"
            legacy_token = "revoked-legacy-browser-token"
            legacy_path.write_text(
                '{"version":1,"token_hashes":["' + PairingAuth._token_hash(legacy_token) + '"]}\n',
                encoding="utf-8",
            )
            state_path.write_text('{"version":1,"token_hashes":[]}\n', encoding="utf-8")

            with (
                patch.object(PairingAuth, "_default_state_path", return_value=state_path),
                patch.object(PairingAuth, "_legacy_state_paths", return_value=(legacy_path,)),
                patch.dict("os.environ", {}, clear=False),
            ):
                auth = PairingAuth()

            self.assertFalse(auth.accepts(legacy_token))

    def test_windows_persistence_does_not_create_replace_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "trusted-devices.json"
            auth = PairingAuth(state_path)

            with (
                patch("codex_remote.app.os.name", "nt"),
                patch("codex_remote.app.tempfile.mkstemp", side_effect=AssertionError("must not use mkstemp")),
                patch("codex_remote.app.os.replace", side_effect=AssertionError("must not replace state file")),
            ):
                token = auth.pair(auth.code)

            self.assertIsNotNone(token)
            restarted_process = PairingAuth(state_path)
            self.assertTrue(restarted_process.accepts(token))

    def test_trusted_browser_token_survives_service_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "trusted-devices.json"
            first_process = PairingAuth(state_path)

            token = first_process.pair(first_process.code)

            self.assertIsNotNone(token)
            self.assertTrue(state_path.exists())
            self.assertNotIn(token, state_path.read_text(encoding="utf-8"))
            restarted_process = PairingAuth(state_path)
            self.assertTrue(restarted_process.accepts(token))

    def test_revoking_browser_token_persists_across_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "trusted-devices.json"
            auth = PairingAuth(state_path)
            token = auth.pair(auth.code)

            self.assertIsNotNone(token)
            self.assertTrue(auth.revoke(token))
            restarted_process = PairingAuth(state_path)
            self.assertFalse(restarted_process.accepts(token))


if __name__ == "__main__":
    unittest.main()
