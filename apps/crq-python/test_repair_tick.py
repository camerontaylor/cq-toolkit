"""Focused receipt lineage checks for tick-owned retry preparation."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

from crq_repair import atomic, bounded
import repair_tick
import review_receipt


class PreparedReceiptLineageTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = 'a' * 40
        self.old_id = 'crq-historical-F1'
        self.finding = {'path': 'src/lock.ts', 'line': 2, 'severity': 'major',
                        'body': 'Normalized finding'}
        self.document = {'findings': [{**self.finding, 'raw_detail': 'Receipt-only metadata'}]}
        self.receipt_id = review_receipt.digest(self.document)
        atomic(self.root / 'state/receipts' / (self.receipt_id + '.json'), self.document)
        old = {'job': self.old_id, 'run': 'old-run', 'item': 'receipt-item',
               'kind': 'merged', 'finding': self.finding}
        atomic(bounded.job_path(self.root, self.old_id), old)
        self.item = {'id': old['item'], 'kind': review_receipt.KIND,
                     'receipt_id': self.receipt_id, 'repair_runs': {
                         'old-run': {'jobs': [self.old_id], 'pin': 'b' * 40,
                                     'receipt_id': self.receipt_id, 'state': 'queued'}}}
        self.queue = {'items': [self.item]}
        self.evidence = {'source_sha': self.source, 'source_blob_sha': 'c' * 40,
                         'finding_sha256': bounded.identity(self.finding),
                         'verdict': 'still-valid', 'reviewer': 'independent-test-reviewer',
                         'reason': 'The pinned source still contains the reported defect.'}
        self.c = SimpleNamespace(
            ROOT=self.root, STATE=self.root / 'state', CLONE=Path('/unused'),
            CONFIG={'clone': '/unused', 'repair': {'max_rounds_per_pin': 2}},
            run=mock.Mock(return_value=SimpleNamespace(stdout='source\n')),
            secret_scan_diff=mock.Mock(return_value=(True, {})), save_queue=mock.Mock())
        patcher = mock.patch.object(bounded, 'git', side_effect=lambda clone, *args:
                                    self.source if args == ('rev-parse', 'origin/main') else 'c' * 40)
        patcher.start()
        self.addCleanup(patcher.stop)

    def prepare(self):
        return repair_tick.prepare_current_job(self.c, self.queue, self.old_id,
                                               self.source, self.evidence)

    def test_rejects_different_or_missing_historical_receipt_before_writing(self):
        record = self.item['repair_runs']['old-run']
        for receipt_id in ('d' * 64, None):
            with self.subTest(receipt_id=receipt_id):
                if receipt_id is None:
                    record.pop('receipt_id', None)
                else:
                    record['receipt_id'] = receipt_id
                before = copy.deepcopy(self.queue)
                with self.assertRaisesRegex(ValueError, 'different receipt'):
                    self.prepare()
                self.assertEqual(self.queue, before)
                self.assertEqual(list((self.root / 'state/repair/inbox').glob('*.json')),
                                 [bounded.job_path(self.root, self.old_id)])
                self.c.run.assert_not_called()
                self.c.secret_scan_diff.assert_not_called()
                self.c.save_queue.assert_not_called()

    def test_same_receipt_accepts_normalized_finding_and_is_idempotent(self):
        job_id = self.prepare()
        record = self.item['repair_runs'][json.loads(bounded.job_path(self.root, job_id).read_text())['run']]
        self.assertEqual(record['receipt_id'], self.receipt_id)
        self.assertEqual(record['receipt_findings'], [review_receipt.digest(self.document['findings'][0])])
        self.assertEqual(record['repair_findings'], [review_receipt.digest(self.finding)])
        self.assertNotEqual(record['receipt_findings'], record['repair_findings'])
        self.assertEqual(self.prepare(), job_id)
        self.c.save_queue.assert_called_once()

    def test_changed_receipt_rejects_even_an_existing_prepared_retry(self):
        self.prepare()
        self.item['receipt_id'] = 'd' * 64
        with self.assertRaisesRegex(ValueError, 'different receipt'):
            self.prepare()
