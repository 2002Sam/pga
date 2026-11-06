import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from pga import conversation_clipboard as cb


class ClipboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = patch.object(cb.memos, 'MEMO_DIR', Path(self.tmp.name) / 'memos')
        self.p.start()
        self.addCleanup(self.p.stop)
        self.uid = uuid.uuid4()

    def save(self, turns):
        return cb.create(self.uid, {'key': 'chat:source', 'title': '来源', 'turns': turns})

    def test_short_is_complete_and_immutable(self):
        rows = [{'role': 'user', 'text': '问题'}, {'role': 'agent', 'text': '回答'}]
        saved = self.save(rows)
        rows[1]['text'] = '后来修改的回答'
        got = cb.context(self.uid, 'pga://snapshot/' + saved['id'], [])
        self.assertIn('assistant: 回答', got)
        self.assertNotIn('后来修改', got)
        self.assertEqual(saved['mode'], 'full')

    def test_owner_isolation(self):
        saved = self.save([{'role': 'user', 'text': 'private'}])
        with self.assertRaises(ValueError):
            cb.context(uuid.uuid4(), 'pga://snapshot/' + saved['id'], [])

    def test_followup_retains_source_but_assistant_cannot_introduce_one(self):
        saved = self.save([{'role': 'user', 'text': '需要保留的信息'}])
        token = 'pga://snapshot/' + saved['id']
        self.assertIn('需要保留的信息', cb.context(self.uid, '继续', [{'role': 'user', 'text': token}]))
        self.assertEqual('', cb.context(self.uid, '继续', [{'role': 'assistant', 'text': token}]))
        self.assertEqual('', cb.context(self.uid, '继续', []))  # bounded history before paste

    def test_long_retrieves_old_chinese_fact_and_latest_three_rounds(self):
        rows = [{'role': 'user', 'text': '之前的数据库配置'}, {'role': 'assistant', 'text': '数据库端口是 6543'}]
        for i in range(20):
            rows += [{'role': 'user', 'text': f'问题{i}'}, {'role': 'assistant', 'text': '无关内容' * 500}]
        rows += [{'role': 'user', 'text': '最近一问'}, {'role': 'assistant', 'text': '最近一答'}]
        saved = self.save(rows)
        got = cb.context(self.uid, '数据库端口是什么 pga://snapshot/' + saved['id'], [])
        self.assertEqual(saved['mode'], 'knowledge')
        self.assertIn('数据库端口是 6543', got)
        self.assertIn('最近一答', got)
        self.assertIn('问题19', got)
        self.assertLess(len(got), 24000)
        self.assertEqual(len(json.loads((cb.directory(self.uid) / (saved['id'] + '.json')).read_text())['turns']), len(rows))

    def test_duplicate_refs_are_read_once(self):
        saved = self.save([{'role': 'user', 'text': 'unique-content'}])
        token = 'pga://snapshot/' + saved['id']
        self.assertEqual(cb.context(self.uid, token + token, []).count('unique-content'), 1)

    def test_invalid_payload_and_missing_snapshot_are_explicit_errors(self):
        for turns in ([], 'bad', [{'role': 'system', 'text': 'bad'}]):
            with self.assertRaises(ValueError):
                self.save(turns)
        with self.assertRaises(ValueError):
            cb.context(self.uid, 'pga://snapshot/' + 'a'*32, [])


if __name__ == '__main__':
    unittest.main()
