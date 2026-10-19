from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from codex_remote.codex_history import CodexHistoryStore
from codex_remote.browser_history_sync import BrowserHistorySync


class HistoryFreshnessTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.path = self.home / 'sessions' / 'rollout-chat.jsonl'
        self.path.parent.mkdir()
        self.append({'type': 'session_meta', 'payload': {'id': 'chat', 'cwd': '/workspace'}})
        self.db = self.home / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.executescript('''
                CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER);
                CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
                    error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, root_turn_id TEXT);
                CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
                    created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER,
                    PRIMARY KEY (thread_id, turn_id, item_id));
            ''')
            conn.execute('INSERT INTO thread_history_projection_state VALUES (?, ?)', ('chat', self.path.stat().st_size))
            for i in range(1, 4):
                conn.execute('INSERT INTO thread_turns VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL)',
                             ('chat', f'turn-{i}', i, 'inProgress' if i == 3 else 'completed', 1792099200 + i))
                item = {'id': f'user-{i}', 'type': 'UserMessage', 'content': [{'type': 'text', 'text': f'question {i}'}]}
                conn.execute('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                             ('chat', f'turn-{i}', item['id'], i, 1792099200000 + i, json.dumps(item), item['type'], i))
        self.store = CodexHistoryStore(self.home)

    def append(self, event: dict) -> None:
        with self.path.open('ab') as stream:
            stream.write((json.dumps(event) + '\n').encode())

    def event(self, kind: str, turn_id: str = 'turn-3', **extra) -> None:
        self.append({'type': 'event_msg', 'timestamp': '2026-10-19T10:00:00Z',
                     'payload': {'type': kind, 'turn_id': turn_id, **extra}})

    def test_small_projection_lag_replays_user_message_and_completion(self) -> None:
        self.event('item_completed', item={'id': 'new-user', 'type': 'UserMessage', 'content': [{'text': 'latest prompt'}]})
        self.event('task_complete')
        thread = self.store.read_thread('chat', tail_turns=2, compact=True)
        self.assertEqual(['turn-2', 'turn-3'], [turn['id'] for turn in thread['turns']])
        self.assertEqual('new-user', thread['turns'][-1]['items'][-1]['id'])
        self.assertEqual('completed', thread['turns'][-1]['status'])
        self.assertEqual('latest prompt', thread['preview'])
        self.assertEqual(self.store.thread_revision('chat'), thread['historyRevision'])
        self.assertEqual(3, thread['totalTurns'])

    def test_partial_last_record_is_not_claimed_as_a_complete_message(self) -> None:
        self.event('turn_aborted')
        record = json.dumps({'type': 'event_msg', 'payload': {'type': 'item_completed', 'turn_id': 'turn-3',
                           'item': {'id': 'partial-user', 'type': 'UserMessage', 'content': [{'text': 'hello'}]}}}).encode()
        with self.path.open('ab') as stream:
            stream.write(record[:len(record) // 2])
        first = self.store.read_thread('chat', tail_turns=1, compact=True)
        self.assertEqual('interrupted', first['turns'][0]['status'])
        self.assertNotIn('partial-user', [item['id'] for item in first['turns'][0]['items']])
        with self.path.open('ab') as stream:
            stream.write(record[len(record) // 2:] + b'\n')
        second = self.store.read_thread('chat', tail_turns=1, compact=True)
        self.assertNotEqual(first['historyRevision'], second['historyRevision'])
        self.assertEqual('partial-user', second['turns'][0]['items'][-1]['id'])

    def test_tail_replay_trims_window_and_counts_new_turns(self) -> None:
        self.event('task_complete')
        self.event('task_started', 'turn-4')
        self.event('user_message', 'turn-4', message='new turn')
        thread = self.store.read_thread('chat', tail_turns=2, compact=True)
        self.assertEqual(['turn-3', 'turn-4'], [turn['id'] for turn in thread['turns']])
        self.assertEqual(4, thread['totalTurns'])
        self.assertTrue(thread['historyPartial'])
        self.assertEqual('new turn', thread['preview'])

    def test_full_compact_history_reuses_and_invalidates_item_cache(self) -> None:
        first = self.store.read_thread('chat', compact=True)
        self.assertEqual(3, len(first['turns']))
        self.assertNotIn('historyWindowed', first)
        # Enrichment of returned messages must not modify cached native content.
        first['turns'][-1]['items'][0]['content'][0]['text'] = 'changed by caller'
        same = self.store.read_thread('chat', compact=True)
        self.assertEqual('question 3', same['turns'][-1]['items'][0]['content'][0]['text'])
        with closing(sqlite3.connect(self.db)) as conn, conn:
            replacement = {'id': 'user-3', 'type': 'UserMessage', 'content': [{'text': 'updated'}]}
            conn.execute('UPDATE thread_items SET item_json = ?, updated_at_ordinal = 99 WHERE item_id = ?',
                         (json.dumps(replacement), 'user-3'))
        updated = self.store.read_thread('chat', compact=True)
        self.assertEqual('updated', updated['turns'][-1]['items'][0]['content'][0]['text'])

    def test_replayed_item_replaces_projection_entry_with_same_id(self) -> None:
        self.event('item_completed', item={'id': 'user-3', 'type': 'UserMessage', 'content': [{'text': 'corrected'}]})
        thread = self.store.read_thread('chat', compact=True)
        items = thread['turns'][-1]['items']
        self.assertEqual(['user-3'], [item['id'] for item in items])
        self.assertEqual('corrected', items[0]['content'][0]['text'])

    def test_delta_contains_completion_and_user_added_after_projection(self) -> None:
        sync = BrowserHistorySync()
        initial = sync.response(self.store.read_thread('chat', compact=True), None)
        self.event('item_completed', item={'id': 'new-user', 'type': 'UserMessage', 'content': [{'text': 'hi'}]})
        self.event('task_complete')
        delta = sync.response(self.store.read_thread('chat', compact=True), initial['historySync']['revision'])
        self.assertEqual(['turn-3'], [turn['id'] for turn in delta['turns']])
        self.assertEqual('completed', delta['turns'][0]['status'])
        self.assertEqual(['new-user'], [item['id'] for item in delta['turns'][0]['items']])
        self.assertEqual(initial['historySync']['revision'], delta['historySync']['baseRevision'])
