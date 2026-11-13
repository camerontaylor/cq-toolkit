"""Focused receipt lineage checks for tick-owned retry preparation."""
import copy
import contextlib
import fcntl
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import sys
from unittest import mock

from crq_repair import atomic, bounded
import repair_tick
import review_receipt
import finding_delivery
import crq


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


class FixedRevalidationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fid = 'f' * 64
        self.job_id = 'crq-run-F1'
        self.job = {'job': self.job_id, 'item': 'item', 'run': 'run',
                    'canonical_finding_id': self.fid, 'review_id': 'e' * 64,
                    'finding': {'path': 'src/a.py', 'line': 1, 'body': 'defect'}}
        atomic(bounded.job_path(self.root, self.job_id), self.job)
        self.row_path = self.root / 'state/backfill/findings/triage' / (self.fid + '.json')
        self.row = {'canonical_id': self.fid, 'status': 'delivered',
                    'receipt': {'repair_task': self.job_id}, 'review_id': self.job['review_id'],
                    'finding': {'id': self.fid}, 'previous_event_id': None}
        atomic(self.row_path, self.row)
        publication = {'head': 'a' * 40, 'commits': ['a' * 40], 'target': 'a' * 40,
                       'branch': 'fix', 'open_pr': False}
        self.record = {'state': 'published', 'jobs': [self.job_id], 'publication': publication,
                       'fix_pr': {'number': 99},
                       'verdicts': [{'job': self.job_id, 'verdict': 'FIXED', 'reason': 'old reason'}]}
        self.item = {'id': 'item', 'kind': 'merged', 'repair_runs': {'run': self.record}}
        self.queue = {'items': [self.item]}
        self.journal = self.root / 'state/repair' / self.job_id / 'publication.json'
        atomic(self.journal, publication)
        self.info = {'number': 99, 'state': 'MERGED', 'headRefOid': 'b' * 40,
                     'mergeCommit': {'oid': 'c' * 40}}
        self.c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state',
            CONFIG={'repair': {}}, iso=lambda: '2026-11-13T08:00:00Z',
            git=mock.Mock(side_effect=lambda *args: 'd' * 40 if args[0] == 'rev-parse' else 'src/a.py\0'),
            pr_info=mock.Mock(return_value=self.info), ensure_commit=mock.Mock(return_value=True),
            is_ancestor=mock.Mock(return_value=True), save_queue=mock.Mock())
        self.entry = mock.Mock(return_value=('100644', 'blob', '1' * 40))
        patcher = mock.patch.object(repair_tick, 'repair_source_entry', self.entry)
        patcher.start()
        self.addCleanup(patcher.stop)
        sources = {'src/a.py': {k: ['100644', 'blob', '1' * 40]
                              for k in ('published', 'actual', 'current')}}
        self.evidence = {'job': self.job_id, 'item': 'item', 'run': 'run',
            'finding_sha256': bounded.identity(self.job['finding']), 'pr': 99,
            'published_head': 'a' * 40, 'actual_head': 'b' * 40,
            'merge_commit': 'c' * 40, 'source_sha': 'd' * 40, 'sources': sources,
            'verdict': 'fixed', 'canonical_finding_id': self.fid, 'canonical_status': 'delivered',
            'reviewer': 'named-reviewer',
            'reason': 'revalidated: containment at merge head could not be re-established. '
                      'Disposition rests on named-reviewer attested source observations.'}

    def attest(self, evidence=None):
        repair_tick.record_fixed_publication_evidence(
            self.c, self.queue, self.job_id, self.evidence if evidence is None else evidence)

    def assert_refused(self, message, evidence=None):
        before = self.journal.read_bytes()
        queue = copy.deepcopy(self.queue)
        with self.assertRaisesRegex(ValueError, message):
            self.attest(evidence)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertEqual(self.queue, queue)
        self.c.save_queue.assert_not_called()

    def test_canonical_journal_and_unchanged_replay(self):
        self.attest()
        self.attest()
        saved = json.loads(self.journal.read_text())['fixed_revalidation']
        self.assertEqual(saved, self.evidence)
        self.assertEqual(saved['canonical_finding_id'], self.fid)
        self.assertEqual(saved['canonical_status'], 'delivered')

    def test_row_guards_refuse_without_writes(self):
        for status in ('fixed', 'dismissed', 'confirmed', 'needs-human', None):
            with self.subTest(status=status):
                atomic(self.row_path, {**self.row, 'status': status})
                self.assert_refused('canonical finding status is not delivered')
        for change, message in (({'receipt': {'repair_task': 'other'}}, 'repair task mismatch'),
                                ({'receipt': {}}, 'repair task mismatch'),
                                ({'canonical_id': '0' * 64}, 'canonical finding identity mismatch')):
            with self.subTest(change=change):
                atomic(self.row_path, {**self.row, **change})
                self.assert_refused(message)

    def test_malformed_id_and_missing_row(self):
        for fid in ('../escape', 'F' * 64, 'f' * 63, ['f']):
            with self.subTest(fid=fid):
                atomic(bounded.job_path(self.root, self.job_id), {**self.job, 'canonical_finding_id': fid})
                self.assert_refused('canonical finding id malformed')
        atomic(bounded.job_path(self.root, self.job_id), self.job)
        self.row_path.rename(self.row_path.with_suffix('.saved'))
        self.assert_refused('canonical finding triage row missing')

    def test_evidence_binding_and_reason_guards(self):
        for key in ('published_head', 'actual_head', 'merge_commit', 'source_sha',
                    'canonical_finding_id', 'canonical_status', 'sources'):
            with self.subTest(key=key):
                self.assert_refused('fixed revalidation binding changed', {**self.evidence, key: '0' * 40})
        self.assert_refused('reason must start with revalidated:', {**self.evidence, 'reason': 'verified'})
        for key in ('reviewer', 'reason'):
            for value in ('', ' ', 'x' * 4001, None):
                with self.subTest(key=key, value_length=len(value or '')):
                    self.assert_refused('named revalidation reviewer and concrete reason required',
                                        {**self.evidence, key: value})

    def test_changed_observations_refuse_replay_without_rewriting(self):
        self.attest()
        self.c.save_queue.reset_mock()
        self.entry.return_value = ('100644', 'blob', '2' * 40)
        self.assert_refused('fixed revalidation binding changed')

    def test_advanced_row_refuses_replay(self):
        self.attest()
        self.c.save_queue.reset_mock()
        atomic(self.row_path, {**self.row, 'status': 'fixed'})
        self.assert_refused('fixed revalidation binding changed')

    def test_legacy_expected_evidence_and_reason_unchanged(self):
        job = dict(self.job)
        job.pop('canonical_finding_id')
        atomic(bounded.job_path(self.root, self.job_id), job)
        evidence = dict(self.evidence)
        evidence.pop('canonical_finding_id')
        evidence.pop('canonical_status')
        evidence['reason'] = 'legacy concrete reason without prefix'
        expected = repair_tick.fixed_publication_evidence(
            self.c, self.item, 'run', self.record, self.info, evidence)
        self.assertEqual(expected, {k: v for k, v in evidence.items() if k not in ('reviewer', 'reason')})
        self.attest(evidence)

    def test_reconciliation_publishes_real_canonical_fixed_event_and_projects_next_tick(self):
        retained = []
        publication = mock.Mock(retained=lambda: retained, spool=retained.append)
        inbox = finding_delivery.Inbox(self.row_path.parent.parent, publication)
        self.attest()
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox), \
             mock.patch.object(repair_tick, 'publish_source_resolution', side_effect=[RuntimeError('offline'), None]) as feedback:
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            self.assertEqual(json.loads(self.row_path.read_text())['status'], 'fixed')
            self.assertNotIn('fix_merged', self.record)
            self.assertEqual(self.record['source_publication_error'], 'offline')
            self.assertEqual(self.record['validated_merge_head']['fixed_revalidation'], self.evidence)
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            self.assertIn('fix_merged', self.record)
            self.assertIn('canonical_fixed_events', self.record['validated_merge_head'])
            self.assertEqual(feedback.call_count, 2)
        self.assertEqual(len(retained), 1)
        payload = retained[0]['payload']
        self.assertEqual(payload['action'], 'fixed')
        self.assertEqual(payload['evidence']['verification'], self.evidence['reason'])
        self.assertEqual(payload['evidence']['fixing_commit'], self.info['mergeCommit']['oid'])

    def test_cli_accepts_canonical_job_and_held_lock_exits_three_without_writes(self):
        evidence_path = self.root / 'evidence.json'
        atomic(evidence_path, self.evidence)
        lock_path = self.root / 'state/tick.lock'
        with mock.patch.multiple(crq, ROOT=self.root, STATE=self.c.STATE, LOCK=lock_path), \
             mock.patch.object(sys, 'argv', ['crq', 'repair-revalidate-fixed', self.job_id,
                                           '--revalidation', str(evidence_path)]), \
             mock.patch.object(crq, 'load_queue', return_value=self.queue), \
             mock.patch.object(crq, 'pr_info', self.c.pr_info), \
             mock.patch.object(crq, 'git', self.c.git), \
             mock.patch.object(crq, 'ensure_commit', self.c.ensure_commit), \
             mock.patch.object(crq, 'is_ancestor', self.c.is_ancestor), \
             mock.patch.object(crq, 'save_queue', self.c.save_queue):
            self.assertEqual(crq.main(), 0)
            self.assertEqual(json.loads(self.journal.read_text())['fixed_revalidation'], self.evidence)
            self.c.save_queue.reset_mock()
            with lock_path.open('w') as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
                with contextlib.redirect_stderr(io.StringIO()), \
                     mock.patch.object(repair_tick, 'record_fixed_publication_evidence') as record:
                    self.assertEqual(crq.main(), 3)
                record.assert_not_called()
                self.c.save_queue.assert_not_called()
                self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, before)
