import tempfile
import tomllib
import unittest
from pathlib import Path

from codex_remote.native_engine_config import NativeEngineConfigStore, NativeEngineConfigError


class CodexProviderPreservationTests(unittest.TestCase):
    def test_updates_only_active_provider_credentials(self):
        text = '''model_provider = "sevencn" # keep identity
model = "existing-model"
[model_providers.sevencn]
name = "Seven"
base_url = "https://old.example/v1"
experimental_bearer_token = "old-test-key"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 7
[model_providers.other]
base_url = "https://other.example"
'''
        before = tomllib.loads(text)
        result = NativeEngineConfigStore._codex_content(text, before, 'https://new.example/v1', 'new-test-key')
        after = tomllib.loads(result.decode())
        self.assertEqual(after['model_provider'], 'sevencn')
        self.assertIn('model_provider = "sevencn" # keep identity', result.decode())
        before['model_providers']['sevencn'].update(base_url='https://new.example/v1', experimental_bearer_token='new-test-key')
        self.assertEqual(after, before)

    def test_repeated_save_retains_current_key_and_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.toml'
            path.write_text('model_provider = "sevencn"\n[model_providers.sevencn]\nname = "Seven"\nwire_api = "responses"\n')
            store = NativeEngineConfigStore(path, Path(directory) / 'claude.json')
            store.save('codex', 'https://one.example', 'test-key', 'bearer', store.read('codex')['revision'])
            store.save('codex', 'https://two.example', '', 'bearer', store.read('codex')['revision'])
            current = store.read('codex')
            self.assertEqual(current['currentProvider'], 'sevencn')
            self.assertTrue(current['enabled'])
            self.assertEqual(current['baseUrl'], 'https://two.example')
            self.assertEqual(tomllib.loads(path.read_text())['model_providers']['sevencn']['experimental_bearer_token'], 'test-key')

    def test_default_and_quoted_provider_names(self):
        for text, name in [('', 'openai'), ('model_provider = "my.provider"\n[model_providers."my.provider"]\nname = "Mine"\n', 'my.provider')]:
            with self.subTest(name=name):
                result = NativeEngineConfigStore._codex_content(text, tomllib.loads(text), 'https://new.example', 'test-key', 'chosen-model')
                parsed = tomllib.loads(result.decode())
                self.assertEqual(parsed.get('model_provider', 'openai'), name)
                self.assertEqual('model_provider' in parsed, 'model_provider' in tomllib.loads(text))
                self.assertEqual(parsed['model'], 'chosen-model')
                self.assertEqual(parsed['model_providers'][name]['base_url'], 'https://new.example')

    def test_preserves_legacy_managed_block_and_other_providers(self):
        text = '''model_provider = "code_remote_settings"
# BEGIN CODE REMOTE API CONFIG
[model_providers.code_remote_settings]
name = "Code Remote API"
base_url = "https://old.example"
experimental_bearer_token = "old-test-key"
wire_api = "responses"
requires_openai_auth = false
# END CODE REMOTE API CONFIG
'''
        result = NativeEngineConfigStore._codex_content(text, tomllib.loads(text), 'https://new.example', 'test-key')
        self.assertIn('# END CODE REMOTE API CONFIG', result.decode())
        self.assertEqual(tomllib.loads(result.decode())['model_provider'], 'code_remote_settings')

    def test_rejects_header_hidden_in_multiline_string(self):
        text = '''model_provider = "sevencn"
notes = """
[model_providers.sevencn]
base_url = "https://fake.example"
"""
'''
        with self.assertRaises(NativeEngineConfigError):
            NativeEngineConfigStore._codex_content(text, tomllib.loads(text), 'https://new.example', 'test-key')
