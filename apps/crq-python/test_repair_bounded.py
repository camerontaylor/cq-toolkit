"""Narrow isolated one-job/preparation/snapshot tests. No models or live state."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock
from crq_repair import atomic
from crq_repair import bounded
import repair_tick

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_service_under_test', ROOT / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
SOURCE = 'a' * 40
HISTORICAL = 'b' * 40
BLOB = 'c' * 40
OLD = 'crq-historical-F1'


class BoundedRepairTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {'clone': '/unused', 'repair': {'enabled': False, 'spend_authorization': None,
                       'roles': {}, 'max_rounds_per_pin': 2}}
        self.old = {'job': OLD, 'run': 'old-run', 'item': 'pr1-merged', 'pr': 1,
                    'kind': 'merged', 'repair_base': HISTORICAL,
                    'finding': {'path': 'src/lock.ts', 'line': 2, 'severity': 'major', 'body': 'Finding data'}}
        self.queue = {'items': [{'id': self.old['item'], 'pr': 1, 'kind': 'merged', 'state': 'done',
                                'repair_runs': {'old-run': {'jobs': [OLD], 'base': HISTORICAL,
                                                          'pin': HISTORICAL, 'state': 'queued'}}}]}
        atomic(bounded.job_path(self.root, OLD), self.old)
        self.evidence = {'source_sha': SOURCE, 'source_blob_sha': BLOB,
                         'finding_sha256': bounded.identity(self.old['finding']),
                         'verdict': 'still-valid', 'reviewer': 'independent-test-reviewer',
                         'reason': 'Pinned source retains the unstable initialization metadata comparison.'}
        self.git = mock.patch.object(bounded, 'git', side_effect=lambda clone, *args:
                                     SOURCE if args == ('rev-parse', 'origin/merge-queue') else BLOB).start()
        self.addCleanup(mock.patch.stopall)
        self.c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state', CONFIG=self.config,
                                 CLONE=Path('/unused'), run=mock.Mock(return_value=SimpleNamespace(stdout='\nfirst\nsecond\n')),
                                 secret_scan_diff=mock.Mock(return_value=(True, {})),
                                 save_queue=lambda q: atomic(self.root / 'state/queue.json', q))

    def prepare(self):
        job_id = repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, self.evidence)
        return job_id, json.loads(bounded.job_path(self.root, job_id).read_text())

    def test_prepare_creates_new_job_without_repinning_history_or_claiming_review(self):
        old_bytes = bounded.job_path(self.root, OLD).read_bytes()
        original = copy.deepcopy(self.queue['items'][0]['repair_runs']['old-run'])
        job_id, job = self.prepare()
        self.assertNotEqual(job_id, OLD)
        self.assertEqual(job['origin_job'], OLD)
        self.assertEqual(job['source_sha'], SOURCE)
        self.assertEqual(job['repair_base'], SOURCE)
        self.assertIsNone(job['cycle'])
        self.assertEqual(bounded.job_path(self.root, OLD).read_bytes(), old_bytes)
        self.assertEqual(self.queue['items'][0]['repair_runs']['old-run'], original)
        self.assertNotIn('cycles', self.queue['items'][0])
        self.assertFalse(self.config['repair']['enabled'])
        self.assertEqual(self.prepare()[0], job_id)
        self.assertEqual(self.c.secret_scan_diff.call_count, 1)

    def test_preparation_scans_full_source_at_real_path(self):
        self.prepare()
        patch = self.c.secret_scan_diff.call_args.args[0]
        self.assertIn('+++ b/src/lock.ts', patch)
        self.assertIn('+first\n+second', patch)

    def test_secret_scan_refusal_enrolls_nothing(self):
        self.c.secret_scan_diff.return_value = (False, {})
        with self.assertRaisesRegex(ValueError, 'secret scan'):
            self.prepare()
        self.assertEqual(len(self.queue['items'][0]['repair_runs']), 1)
        self.assertEqual(len(list((self.root / 'state/repair/inbox').glob('*.json'))), 1)

    def test_stale_source_and_unbound_evidence_refuse(self):
        for key in ('source_sha', 'source_blob_sha', 'finding_sha256', 'verdict', 'reviewer', 'reason'):
            evidence = {**self.evidence, key: ''}
            with self.subTest(key=key), self.assertRaises(ValueError):
                repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, evidence)
        self.git.side_effect = lambda *args: HISTORICAL
        with self.assertRaisesRegex(ValueError, 'current queue tip'):
            self.prepare()

    def test_round_ceiling_remains_authoritative(self):
        self.config['repair']['max_rounds_per_pin'] = 0
        with self.assertRaisesRegex(ValueError, 'ceiling'):
            self.prepare()

    def test_historical_job_requires_tick_owned_lineage(self):
        self.queue['items'][0]['repair_runs'] = {}
        with self.assertRaisesRegex(ValueError, 'tick-owned'):
            self.prepare()

    def test_selector_reads_only_named_prepared_job(self):
        job_id, job = self.prepare()
        unrelated = self.root / 'state/repair/inbox/crq-unrelated-F1.json'
        unrelated.write_text('invalid unrelated JSON must never be read')
        before = unrelated.read_bytes()
        selected = bounded.select_job(self.root, self.config, job_id, SOURCE, self.evidence['finding_sha256'])
        self.assertEqual(selected, job)
        self.assertEqual(unrelated.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'historical jobs'):
            bounded.select_job(self.root, self.config, OLD, SOURCE, self.evidence['finding_sha256'])

    def test_wrong_digest_and_orphan_prepared_job_refuse(self):
        job_id, _ = self.prepare()
        with self.assertRaisesRegex(ValueError, 'digest'):
            bounded.select_job(self.root, self.config, job_id, SOURCE, 'wrong')
        atomic(self.root / 'state/queue.json', {'items': []})
        with self.assertRaisesRegex(ValueError, 'tick-owned'):
            bounded.select_job(self.root, self.config, job_id, SOURCE, self.evidence['finding_sha256'])

    def test_job_and_source_path_containment(self):
        for name in ('../other', 'crq-../../other', '', 'crq-a/b'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                bounded.job_path(self.root, name)
        for path in ('/etc/file', '../file', 'src/../file', 'src/file\n+++ b/escape', ''):
            with self.subTest(path=path), self.assertRaises(ValueError):
                bounded.source_path({'path': path})
        link = self.root / 'state/repair/inbox/crq-link-F1.json'
        link.symlink_to(bounded.job_path(self.root, OLD))
        with self.assertRaises(ValueError):
            bounded.job_path(self.root, 'crq-link-F1')

    def test_snapshot_uses_pinned_git_object_and_keeps_line_numbers(self):
        _, job = self.prepare()
        with mock.patch.object(bounded, 'command', return_value=SimpleNamespace(returncode=0, stdout='\nfirst\nsecond\n')) as cmd:
            snapshot = bounded.source_snapshot(self.config, job)
        self.assertEqual(snapshot['source_sha'], SOURCE)
        self.assertEqual(snapshot['finding_sha256'], self.evidence['finding_sha256'])
        self.assertEqual(snapshot['source'], '1: \n2: first\n3: second')
        self.assertFalse(snapshot['incomplete'])
        self.assertEqual(cmd.call_args.args[0], ['git', 'show', SOURCE + ':src/lock.ts'])

    def test_snapshot_bounds_and_unknown_context_fail_closed_advice(self):
        _, job = self.prepare()
        text = '\n'.join('x' * 1000 for _ in range(200))
        with mock.patch.object(bounded, 'command', return_value=SimpleNamespace(returncode=0, stdout=text)):
            snapshot = bounded.source_snapshot(self.config, job)
        self.assertLessEqual(len(snapshot['source']), 16000)
        self.assertTrue(snapshot['incomplete'])
        self.assertIn('unsure', snapshot['instruction'])
        job['finding']['body'] = 'tampered'
        with self.assertRaisesRegex(ValueError, 'binding'):
            bounded.source_snapshot(self.config, job)

    def test_service_disabled_and_unselected_never_dispatch(self):
        atomic(self.root / 'config.json', self.config)
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'process_item') as dispatch:
            service.main([])
            self.config['repair'].update(enabled=True, spend_authorization='offline-test-fixture-only')
            atomic(self.root / 'config.json', self.config)
            service.main([])
            dispatch.assert_not_called()

    def test_service_dispatches_one_selected_job_without_inbox_enumeration(self):
        job_id, job = self.prepare()
        self.config['repair'].update(enabled=True, spend_authorization='offline-test-fixture-only')
        atomic(self.root / 'config.json', self.config)
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'process_item') as dispatch:
            service.main(['--job', job_id, '--source-sha', SOURCE,
                          '--finding-sha256', self.evidence['finding_sha256']])
        dispatch.assert_called_once_with(self.config, [job])


if __name__ == '__main__':
    unittest.main()
