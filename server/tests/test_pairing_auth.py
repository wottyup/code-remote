from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from codex_remote.app import PairingAuth


class PairingAuthTests(unittest.TestCase):
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
