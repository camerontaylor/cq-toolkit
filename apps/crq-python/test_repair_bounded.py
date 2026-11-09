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
                                     SOURCE if args == ('rev-parse', 'origin/main') else BLOB).start()
        self.addCleanup(mock.patch.stopall)
        self.c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state', CONFIG=self.config,
                                 CLONE=Path('/unused'), iso=lambda: 'now', run=mock.Mock(return_value=SimpleNamespace(stdout='\nfirst\nsecond\n')),
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
        self.assertEqual(job['source']['run'], 'old-run')
        self.assertEqual(job['source_sha'], SOURCE)
        self.assertEqual(job['repair_base'], SOURCE)
        self.assertIsNone(job['cycle'])
        self.assertEqual(bounded.job_path(self.root, OLD).read_bytes(), old_bytes)
        self.assertEqual(self.queue['items'][0]['repair_runs']['old-run'], original)
        self.assertNotIn('cycles', self.queue['items'][0])
        self.assertFalse(self.config['repair']['enabled'])
        self.assertEqual(self.prepare()[0], job_id)
        self.assertEqual(self.c.secret_scan_diff.call_count, 1)

    def test_prepared_canonical_retry_transfers_durable_delivery_ownership(self):
        self.old['canonical_finding_id'] = 'canonical'
        atomic(bounded.job_path(self.root, OLD), self.old)
        self.c.iso = lambda: 'now'
        inbox = mock.Mock()
        def handoff(fid, previous, job, at):
            self.assertEqual((fid, previous, at), ('canonical', OLD, 'now'))
            self.assertEqual(json.loads(bounded.job_path(self.root, job['job']).read_text()), job)
        inbox.handoff.side_effect = handoff
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            job_id, job = self.prepare()
            self.assertEqual(self.prepare()[0], job_id)
        self.assertEqual(inbox.handoff.call_count, 2)
        self.assertEqual(self.queue['items'][0]['repair_runs']['old-run']['state'], 'stale')

    def test_preparation_scans_full_source_at_real_path(self):
        self.prepare()
        patch = self.c.secret_scan_diff.call_args.args[0]
        self.assertIn('+++ b/src/lock.ts', patch)
        self.assertIn('+first\n+second', patch)

    def test_legacy_minor_is_not_prepared_or_drained(self):
        self.old['finding']['severity'] = 'minor'
        self.evidence['finding_sha256'] = bounded.identity(self.old['finding'])
        atomic(bounded.job_path(self.root, OLD), self.old)
        with self.assertRaisesRegex(ValueError, 'canonical minor'):
            self.prepare()
        status, _, reason = bounded.drain_job(self.root, self.config, self.queue, OLD)
        self.assertEqual(status, 'skip')
        self.assertIn('canonical minor', reason)

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
        with self.assertRaisesRegex(ValueError, 'current default-branch tip'):
            self.prepare()

    def test_round_ceiling_remains_authoritative(self):
        self.config['repair']['max_rounds_per_pin'] = 0
        with self.assertRaisesRegex(ValueError, 'ceiling'):
            self.prepare()

    def test_backfill_round_limit_is_per_finding_not_shared_placeholder_pr(self):
        self.old.update(pr=0, canonical_finding_id='finding-a')
        self.queue['items'][0]['pr'] = 0
        self.queue['items'][0]['repair_runs']['old-run']['pin'] = SOURCE
        self.queue['items'].append({'id': 'backfill-finding-b', 'pr': 0, 'repair_runs': {
            'b1': {'pin': SOURCE}, 'b2': {'pin': SOURCE}}})
        atomic(bounded.job_path(self.root, OLD), self.old)
        with mock.patch.object(repair_tick, 'finding_inbox'):
            self.prepare()
        new_evidence = {**self.evidence, 'reason': 'Independent revalidation of the same finding.'}
        with self.assertRaisesRegex(ValueError, 'ceiling'):
            repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, new_evidence)

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

    def test_prepared_selector_requires_current_delivered_canonical_owner(self):
        job_id, job = self.prepare()
        fid = 'd' * 64
        job['canonical_finding_id'] = fid
        atomic(bounded.job_path(self.root, job_id), job)
        row_path = self.root / 'state/backfill/findings/triage' / (fid + '.json')
        row = {'status': 'delivered', 'receipt': {'repair_task': job_id}}
        atomic(row_path, row)
        self.assertEqual(bounded.select_job(self.root, self.config, job_id, SOURCE,
                                           self.evidence['finding_sha256'])['job'], job_id)
        for status in ('superseded', 'dismissed', 'confirmed', 'needs-human', 'fixed'):
            with self.subTest(status=status):
                atomic(row_path, {**row, 'status': status})
                with self.assertRaisesRegex(ValueError, 'canonical'):
                    bounded.select_job(self.root, self.config, job_id, SOURCE, self.evidence['finding_sha256'])
        atomic(row_path, {**row, 'receipt': {'repair_task': 'newer-job'}})
        with self.assertRaisesRegex(ValueError, 'canonical'):
            bounded.select_job(self.root, self.config, job_id, SOURCE, self.evidence['finding_sha256'])
        atomic(self.root / 'state/repair' / job_id / 'progress.json', {'attempts': ['historical']})
        self.assertEqual(bounded.drain_job(self.root, self.config, self.queue, job_id)[0], 'skip')
        for content in ('[]', '{"status":"delivered","receipt":null}', 'broken'):
            row_path.write_text(content)
            self.assertEqual(bounded.drain_job(self.root, self.config, self.queue, job_id)[0], 'skip')
        row_path.unlink()
        self.assertEqual(bounded.drain_job(self.root, self.config, self.queue, job_id)[0], 'skip')

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

    def test_service_disabled_or_partial_selector_never_dispatch(self):
        atomic(self.root / 'config.json', self.config)
        with mock.patch.object(service, 'ROOT', self.root), \
             mock.patch.object(service, 'process_item') as dispatch, mock.patch.object(service, 'drain') as drain:
            service.main([])
            for authorization in (None, '', '  ', True):
                self.config['repair'].update(enabled=True, spend_authorization=authorization)
                atomic(self.root / 'config.json', self.config)
                service.main([])
            self.config['repair'].update(enabled=True, spend_authorization='offline-test-fixture-only')
            atomic(self.root / 'config.json', self.config)
            service.main(['--job', OLD])
            dispatch.assert_not_called()
            drain.assert_not_called()

    def test_service_without_selector_drains(self):
        self.config['repair'].update(enabled=True, spend_authorization='offline-test-fixture-only')
        atomic(self.root / 'config.json', self.config)
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_called_once_with(self.config)

    def test_process_preserves_finding_digest_and_delivers_snapshot(self):
        _, job = self.prepare()
        role = {'driver': 'cq', 'model': 'zai/glm-5.3-flash'}
        self.config['repair']['roles'] = {name: role for name in
                                         ('fixer', 'fixer_escalation', 'judge', 'judge_critical')}
        report = {'stop': 'ok', 'changed': False, 'summary': 'No change warranted', 'commits': []}
        with mock.patch.object(service, 'ROOT', self.root), \
             mock.patch.object(service, 'git', side_effect=lambda wt, *args: SOURCE if args[0] == 'rev-parse' else ''), \
             mock.patch.object(bounded, 'command', return_value=SimpleNamespace(returncode=0, stdout='first\nsecond\n')), \
             mock.patch.object(service.cq, 'invoke', return_value=report) as invoke:
            result = service.process(self.config, job, self.root)
        sent = invoke.call_args.args[2]
        self.assertEqual(bounded.identity(sent['finding']), self.evidence['finding_sha256'])
        self.assertEqual(sent['source_snapshot']['source_sha'], SOURCE)
        self.assertIn('mechanical_evidence', sent)
        self.assertEqual(result['verdict'], 'NOT-FIXED')
        self.assertEqual(result['source_sha'], SOURCE)

    def test_cq_fixer_payload_contains_snapshot_and_mechanical_context(self):
        _, job = self.prepare()
        job['source_snapshot'] = {'source_sha': SOURCE, 'source': '2: pinned code'}
        job['mechanical_evidence'] = 'Earlier verification failed'
        self.config.update(repo='example/repo')
        self.config['repair'].update(cq_bin='/unused/cli.js', budget={'max_output_tokens': 8000, 'max_context_tokens': 9000, 'wall_clock_min': 2})
        response = SimpleNamespace(returncode=0, stdout='{"status":"ok","value":{"changed":false}}', stderr='')
        with mock.patch.object(service.cq, 'command', return_value=response) as cmd:
            service.cq.invoke(self.config, {'model': 'zai/glm-5.3-flash'}, job, self.root, self.root)
        item_arg = next(arg for arg in cmd.call_args.args[0] if arg.startswith('--item='))
        body = json.loads(item_arg.split('=', 1)[1])['body']
        self.assertIn(SOURCE, body)
        self.assertIn('2: pinned code', body)
        self.assertIn('Earlier verification failed', body)
        # Operating instructions belong to the SDK's trusted prompt, not the
        # untrusted finding body. The adapter still sends the same permissions.
        self.assertNotIn('Shell: the bash tool', body)
        self.assertNotIn('Anything else is denied', body)
        harness_arg = next(arg for arg in cmd.call_args.args[0] if arg.startswith('--harness='))
        harness = json.loads(harness_arg.split('=', 1)[1])
        self.assertEqual(harness, service.cq.HARNESS)
        self.assertEqual(harness['tools']['run']['commandPatterns'],
                         ['git ' + name for name in ('add', 'commit', 'status', 'diff', 'log', 'rev-parse')]
                         + service.cq.SEARCH_PATTERNS)

    def test_harvest_records_wrong_prepared_source_binding_as_failed(self):
        job_id, job = self.prepare()
        result = {'job': job_id, 'item': job['item'], 'verdict': 'NOT-FIXED',
                  'reason': 'test', 'source_sha': HISTORICAL,
                  'finding_sha256': job['finding_sha256'], 'origin_job': OLD}
        atomic(self.root / 'state/repair' / job_id / 'result.json', result)
        item = self.queue['items'][0]
        repair_tick.harvest(self.c, self.queue, item)
        record = item['repair_runs'][job['run']]
        self.assertEqual(record['state'], 'failed')
        self.assertIn('source/evidence binding', record['error'])
        self.assertEqual(item['state'], 'repair_failed')
        self.assertEqual(item['last_error'], 'repair_failed; needs human')

    def test_harvest_records_fixed_without_commits_as_failed(self):
        job_id, job = self.prepare()
        self.c.WT_ROOT = self.root / 'wt'
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': [],
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged'), 'reason': 'test',
                'repair_base': job['repair_base'], 'attempts': [{'rung': 'A0'}],
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'], 'origin_job': OLD})
        item = self.queue['items'][0]
        repair_tick.harvest(self.c, self.queue, item)
        record = item['repair_runs'][job['run']]
        self.assertEqual(record['state'], 'failed')
        self.assertIn('without valid commits', record['error'])
        self.assertEqual(item['state'], 'repair_failed')

    def test_bad_fixed_attempts_fail_once_across_ticks(self):
        for attempts in (None, [], [{}], [{'rung': 'A3'}], 'invalid'):
            with self.subTest(attempts=attempts):
                job_id, job = self.prepare()
                item = self.queue['items'][0]
                record = item['repair_runs'][job['run']]
                record['state'] = 'queued'
                result = {'job': job_id, 'item': job['item'], 'verdict': 'FIXED',
                          'commits': ['a' * 40], 'attempts': attempts, 'reason': 'test',
                          'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                          'origin_job': OLD, 'worktree': str(self.root / 'wt/crq-repair-pr1-merged'),
                          'repair_base': job['repair_base']}
                atomic(self.root / 'state/repair' / job_id / 'result.json', result)
                with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark:
                    repair_tick.harvest(self.c, self.queue, item)
                    repair_tick.harvest(self.c, self.queue, item)
                    self.assertEqual(mark.call_count, 1)
                    self.assertEqual(mark.call_args.args[2]['verdict'], 'FAILED')
                self.assertEqual(record['state'], 'failed')
                self.assertIn('valid final attempt rung', record['error'])
                self.assertEqual(item['state'], 'repair_failed')

    def test_valid_fixed_rungs_reach_git_verification(self):
        job_id, job = self.prepare()
        self.c.WT_ROOT = self.root / 'wt'
        self.c.make_worktree = mock.Mock(return_value=(self.root / 'verify', 'branch'))
        self.c.remove_worktree = mock.Mock()
        item = self.queue['items'][0]
        for rung in ('A0', 'A1', 'A2'):
            with self.subTest(rung=rung):
                atomic(self.root / 'state/repair' / job_id / 'result.json',
                       {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                        'attempts': [{'rung': rung}], 'source_sha': job['source_sha'],
                        'finding_sha256': job['finding_sha256'], 'origin_job': OLD,
                        'worktree': str(self.c.WT_ROOT / 'crq-repair-pr1-merged'),
                        'repair_base': job['repair_base']})
                with mock.patch.object(repair_tick, 'verify', side_effect=RuntimeError('verification reached')):
                    with self.assertRaisesRegex(RuntimeError, 'verification reached'):
                        repair_tick.harvest(self.c, self.queue, item)
                self.assertEqual(item['repair_runs'][job['run']]['state'], 'queued')

    def test_harvest_retains_malformed_json_and_fails_the_prepared_run(self):
        job_id, job = self.prepare()
        result = self.root / 'state/repair' / job_id / 'result.json'
        result.parent.mkdir(parents=True, exist_ok=True)
        result.write_text('{broken')
        item = self.queue['items'][0]
        repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(item['repair_runs'][job['run']]['state'], 'failed')
        self.assertEqual(result.read_text(), '{broken')

    def test_malformed_result_writes_canonical_failed_outcome_once(self):
        job_id, job = self.prepare()
        fid = 'd' * 64
        job['canonical_finding_id'] = fid
        atomic(bounded.job_path(self.root, job_id), job)
        atomic(self.root / 'state/backfill/findings/triage' / (fid + '.json'),
               {'status': 'delivered', 'receipt': {'repair_task': job_id}})
        result = self.root / 'state/repair' / job_id / 'result.json'
        result.parent.mkdir(parents=True, exist_ok=True)
        result.write_text('{broken')
        item = self.queue['items'][0]
        with mock.patch.object(repair_tick, 'finding_inbox') as inbox:
            repair_tick.harvest(self.c, self.queue, item)
            repair_tick.harvest(self.c, self.queue, item)
            outcome = inbox.return_value.repair_outcome
            outcome.assert_called_once()
            self.assertEqual(outcome.call_args.args[:3], (fid, job_id, 'needs-human'))

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
