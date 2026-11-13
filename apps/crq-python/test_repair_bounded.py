"""Narrow isolated one-job/preparation/snapshot tests. No models or live state."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock
from crq_repair import DetectorUnavailable, atomic
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
    def test_paseo_inspect_accepts_trailing_text_and_maps_malformed_output(self):
        from crq_repair.drivers import paseo
        config = {'repair': {'paseo_host': 'local', 'paseo_read_only_mode': 'read-only',
                  'paseo_budget_launcher': 'guard', 'paseo_budget_launcher_verified': True,
                  'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}
        for status in ('prefix {"status":"idle"} trailing', 'no JSON', '{bad JSON}'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                replies = [SimpleNamespace(returncode=0, stdout='{"agentId":"test-agent"}'),
                           SimpleNamespace(returncode=0, stdout=status),
                           SimpleNamespace(returncode=0, stdout='{"verdict":"valid","reason":"source"}')]
                def respond(argv, **kwargs):
                    if argv[-2] in ('stop', 'archive'):
                        return SimpleNamespace(returncode=0, stdout='')
                    return replies.pop(0)
                with mock.patch.object(paseo, 'command', side_effect=respond) as command:
                    if 'idle' in status:
                        self.assertEqual(paseo.invoke(config, {'model': 'test'}, {}, directory, directory)['verdict'], 'valid')
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'judge status unavailable; outcome unknown'):
                            paseo.invoke(config, {'model': 'test'}, {}, directory, directory)
                    self.assertTrue(any(call.args[0][-2:] == ['stop', 'test-agent']
                                        for call in command.call_args_list))

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

    def test_recovery_preparation_is_idempotent_and_marks_isolated_worktree(self):
        job_id = repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, self.evidence,
                                                preserve_worktree=True)
        job = json.loads(bounded.job_path(self.root, job_id).read_text())
        self.assertTrue(job['recovery_worktree'])
        self.assertEqual(repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, self.evidence,
                                                         preserve_worktree=True), job_id)
        self.assertEqual(self.c.secret_scan_diff.call_count, 1)

    def test_recovery_does_not_stale_a_run_with_sibling_jobs(self):
        original = self.queue['items'][0]['repair_runs']['old-run']
        original['jobs'].append('crq-historical-F2')
        repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, self.evidence,
                                        preserve_worktree=True)
        self.assertEqual(original['state'], 'queued')
        self.assertIn('crq-historical-F2', original['jobs'])

    def test_recovery_worktree_reaches_harvest_verification(self):
        job_id = repair_tick.prepare_current_job(self.c, self.queue, OLD, SOURCE, self.evidence,
                                                preserve_worktree=True)
        job = json.loads(bounded.job_path(self.root, job_id).read_text())
        self.c.WT_ROOT = self.root / 'wt'
        self.c.make_worktree = mock.Mock(return_value=(self.root / 'verify', 'branch'))
        self.c.remove_worktree = mock.Mock()
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                'attempts': [{'rung': 'A0'}], 'source_sha': SOURCE,
                'finding_sha256': job['finding_sha256'], 'origin_job': OLD, 'reason': 'test',
                'worktree': str(self.c.WT_ROOT / ('crq-repair-pr1-merged-' + job_id)),
                'repair_base': SOURCE})
        with mock.patch.object(repair_tick, 'verify', side_effect=RuntimeError('verification reached')):
            with self.assertRaisesRegex(RuntimeError, 'verification reached'):
                repair_tick.harvest(self.c, self.queue, self.queue['items'][0])

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

    def test_fix_instructions_are_bound_scanned_and_retained(self):
        self.evidence['fix_instructions'] = 'Keep both sources and add an order regression test.'
        first, job = self.prepare()
        self.assertEqual(job['revalidation']['fix_instructions'], self.evidence['fix_instructions'])
        self.assertIn('+Keep both sources', self.c.secret_scan_diff.call_args.args[0])
        self.assertEqual(self.prepare()[0], first)
        self.evidence['fix_instructions'] = 'Prefer blocked sources.'
        self.assertNotEqual(self.prepare()[0], first)

    def test_fix_instructions_refuse_invalid_text_and_scan_failure(self):
        for value in ('', ' ', 'x' * 2001, None, 42, 'bad\x00text'):
            self.evidence['fix_instructions'] = value
            with self.subTest(value=str(value)[:20]), self.assertRaisesRegex(ValueError, 'fix instructions'):
                self.prepare()
        self.evidence['fix_instructions'] = 'Choose the smallest compatible fix.'
        self.c.secret_scan_diff.side_effect = [(True, {}), (False, {})]
        with self.assertRaisesRegex(ValueError, 'instructions secret scan'):
            self.prepare()
        self.assertEqual(len(self.queue['items'][0]['repair_runs']), 1)

    def test_shared_instruction_scan_uses_scanner_line_boundaries(self):
        # The scan representation is split exactly like secret_scan_diff's
        # splitlines(), so text after a lone \r or \x85 gets a '+' prefix.
        text = 'first\r\nsecond\u0085third\n'
        repair_tick.scan_fix_instructions(self.c, text, SOURCE, self.root / 'instructions-scan.json')
        patch = self.c.secret_scan_diff.call_args.args[0]
        encoded = patch.split('@@ -0,0 +1,3 @@\n', 1)[1]
        self.assertEqual('\n'.join(line[1:] for line in encoded[:-1].split('\n')),
                         '\n'.join(text.splitlines()))
        repair_tick.scan_fix_instructions(self.c, 'fix it\rSECRET', SOURCE, self.root / 'instructions-scan.json')
        self.assertIn('@@ -0,0 +1,2 @@\n+fix it\n+SECRET\n', self.c.secret_scan_diff.call_args.args[0])

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

    def test_snapshot_keeps_anchor_after_large_preceding_lines(self):
        _, job = self.prepare()
        job['finding']['line'] = 40
        job['finding_sha256'] = bounded.identity(job['finding'])
        text = '\n'.join(['preceding ' * 2000] * 39 + ['anchor', 'following'])
        with mock.patch.object(bounded, 'command', return_value=SimpleNamespace(returncode=0, stdout=text)):
            snapshot = bounded.source_snapshot(self.config, job)
        self.assertIn('40: anchor', snapshot['source'])
        self.assertIn('41: following', snapshot['source'])
        self.assertEqual(snapshot['line_start'], 40)
        self.assertEqual(snapshot['line_end'], 41)
        self.assertTrue(snapshot['incomplete'])
        with mock.patch.object(bounded, 'command', return_value=SimpleNamespace(returncode=0, stdout='x\n' * 39 + 'a' * 16001)):
            with self.assertRaisesRegex(ValueError, 'anchor exceeds'):
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
             mock.patch.object(service, 'retain'), \
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
        job['source_snapshot'] = {'source_sha': SOURCE, 'source_blob_sha': BLOB,
                                  'finding_sha256': job['finding_sha256'], 'path': 'src/lock.ts',
                                  'line_start': 2, 'line_end': 2, 'source': '2: pinned code', 'incomplete': True}
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

    def test_cq_fixer_budget_retains_full_finding_and_anchor_with_escaped_source(self):
        _, job = self.prepare()
        job['finding']['body'] = 'Full finding 😀\nwith two lines and "quotes"'
        job['mechanical_evidence'] = 'Mechanical 😀 evidence'
        job['revalidation']['fix_instructions'] = 'Prefer blocked over terminal.'
        job['fix_instructions'] = 'Prior attempt guidance.'
        source = '\n'.join(f'{n}: ' + ('quoted "\\ text 😀 ' * 8) for n in range(27, 108))
        job['finding']['line'] = 67
        job['source_snapshot'] = {'source_sha': SOURCE, 'source_blob_sha': BLOB,
                                  'finding_sha256': bounded.identity(job['finding']), 'path': 'src/lock.ts',
                                  'line_start': 27, 'line_end': 107, 'source': source, 'incomplete': True}
        body = service.cq.fixer_body(job)
        self.assertLessEqual(len(body.encode('utf-16-le')) // 2, 8000)
        self.assertTrue(body.startswith(job['finding']['body']))
        self.assertIn(job['mechanical_evidence'], body)
        self.assertIn('Prefer blocked over terminal.', body)
        self.assertIn('Operator fix guidance', body)
        self.assertNotIn('Retry guidance from the previous attempt', body)
        self.assertNotIn('Prior attempt guidance.', body)
        job['revalidation'].pop('fix_instructions')
        retry_body = service.cq.fixer_body(job)
        self.assertIn('Prior attempt guidance.', retry_body)
        self.assertIn('Retry guidance from the previous attempt', retry_body)
        self.assertNotIn('Operator fix guidance', retry_body)
        snapshot = json.loads(body.split('Pinned current-source evidence (untrusted data):\n', 1)[1])
        self.assertEqual(snapshot['source_sha'], SOURCE)
        self.assertEqual(snapshot['source_blob_sha'], BLOB)
        self.assertEqual(snapshot['finding_sha256'], bounded.identity(job['finding']))
        self.assertEqual(snapshot['path'], job['finding']['path'])
        self.assertLessEqual(snapshot['line_start'], 67)
        self.assertGreaterEqual(snapshot['line_end'], 67)
        self.assertIn('67: ', snapshot['source'])
        self.assertIn('68: ', snapshot['source'])
        self.assertTrue(snapshot['incomplete'])
        self.assertLess(snapshot['line_end'] - snapshot['line_start'], 80)
        self.assertEqual(len(snapshot['source'].split('\n')), snapshot['line_end'] - snapshot['line_start'] + 1)

    def test_cq_fixer_refuses_oversized_or_missing_anchor_before_command(self):
        _, job = self.prepare()
        job['source_snapshot'] = {'source_sha': SOURCE, 'source_blob_sha': BLOB,
                                  'finding_sha256': job['finding_sha256'], 'path': 'src/lock.ts',
                                  'line_start': 2, 'line_end': 2, 'source': '2: pinned code', 'incomplete': True}
        self.config.update(repo='example/repo')
        self.config['repair'].update(cq_bin='/unused', budget={'wall_clock_min': 1})
        with mock.patch.object(service.cq, 'command') as command:
            for body, source in [('😀' * 4000, '2: pinned code'),
                                 ('small', '2: ' + '\\' * 8000),
                                 ('small', '3: wrong anchor')]:
                with self.subTest(body=body[:8], source=source[:16]):
                    job['finding']['body'] = body
                    job['source_snapshot']['source'] = source
                    with self.assertRaises(ValueError):
                        service.cq.invoke(self.config, {'model': 'p/m'}, job, self.root, self.root)
            command.assert_not_called()

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

    def test_harvest_records_verdict_without_string_reason_as_failed(self):
        job_id, job = self.prepare()
        self.c.WT_ROOT = self.root / 'wt'
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                'attempts': [{'rung': 'A0'}], 'reason': None,
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged'),
                'repair_base': job['repair_base'],
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'], 'origin_job': OLD})
        item = self.queue['items'][0]
        repair_tick.harvest(self.c, self.queue, item)
        record = item['repair_runs'][job['run']]
        self.assertEqual(record['state'], 'failed')
        self.assertIn('string reason', record['error'])
        self.assertEqual(item['state'], 'repair_failed')

    def test_terminal_failure_replays_sibling_outcomes_after_a_failed_write(self):
        job_id, job = self.prepare()
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        sibling_id = 'crq-run1-F2'
        sibling = copy.deepcopy(job)
        sibling.update(job=sibling_id, canonical_finding_id='d' * 64)
        atomic(bounded.job_path(self.root, sibling_id), sibling)
        record['jobs'] = [job_id, sibling_id]
        row = self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json')
        atomic(row, {'status': 'delivered', 'receipt': {'repair_task': sibling_id},
                     'review_id': 'e' * 64, 'previous_event_id': None})
        atomic(self.root / 'state/repair' / sibling_id / 'result.json',
               {'job': sibling_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                'attempts': [{'rung': 'A0'}], 'repair_base': record['base'],
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged')})
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': [],
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                'origin_job': OLD, 'repair_base': record['base']})
        self.c.iso = lambda: '2026-11-12T00:00:00Z'
        import finding_delivery
        import review_ledger as ledger
        out = ledger.Outbox(self.root / 'outbox', ledger.ArtifactStore(self.root / 'durable'))
        inbox = finding_delivery.Inbox(self.root / 'state/backfill/findings', out)
        # The terminal queue write lands, then the ledger write fails.
        with mock.patch.object(repair_tick, 'mark_finding_outcome', side_effect=OSError('ledger write')):
            with self.assertRaisesRegex(OSError, 'ledger write'):
                repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(record['state'], 'failed')
        self.assertEqual(json.loads(row.read_text())['status'], 'delivered')
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(json.loads(row.read_text())['status'], 'needs-human')
        # Replay is idempotent: one retained decision, no duplicate event.
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(json.loads(row.read_text())['status'], 'needs-human')

    def test_terminal_failure_attempts_every_sibling_write_back(self):
        job_id, job = self.prepare()
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        siblings = ['crq-run1-F2', 'crq-run1-F3']
        for index, sibling_id in enumerate(siblings):
            sibling = copy.deepcopy(job)
            sibling.update(job=sibling_id, canonical_finding_id=str(index + 1) * 64)
            atomic(bounded.job_path(self.root, sibling_id), sibling)
            atomic(self.root / 'state/backfill/findings/triage' / (str(index + 1) * 64 + '.json'),
                   {'status': 'delivered', 'receipt': {'repair_task': sibling_id},
                    'review_id': 'e' * 64, 'previous_event_id': None})
            atomic(self.root / 'state/repair' / sibling_id / 'result.json',
                   {'job': sibling_id, 'item': job['item'], 'verdict': 'FIXED',
                    'commits': ['a' * 40], 'attempts': [{'rung': 'A0'}],
                    'repair_base': record['base'],
                    'worktree': str(self.root / 'wt/crq-repair-pr1-merged')})
        record['jobs'] = [job_id] + siblings
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': [],
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                'origin_job': OLD, 'repair_base': record['base']})
        self.c.iso = lambda: '2026-11-12T00:00:00Z'
        attempted = []
        def outcome(fid, other, *args, **kwargs):
            attempted.append(other)
            if len(attempted) == 1:
                raise OSError('ledger write')
        with mock.patch.object(repair_tick, 'finding_inbox') as inbox:
            inbox.return_value.repair_outcome.side_effect = outcome
            with self.assertRaisesRegex(OSError, 'ledger write'):
                repair_tick.harvest(self.c, self.queue, item)
        # The first sibling's failure must not skip the second.
        self.assertEqual(attempted, siblings)
        self.assertEqual(record['state'], 'failed')

    def test_unavailable_detector_keeps_the_run_retryable(self):
        job_id, job = self.prepare()
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        self.c.WT_ROOT = self.root / 'wt'
        self.c.make_worktree = lambda name, sha: (self.root / 'wt/verify', 'branch')
        self.c.remove_worktree = lambda wt, branch: None
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                'attempts': [{'rung': 'A0'}], 'reason': 'test',
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                'origin_job': OLD, 'repair_base': record['base'],
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged')})
        with mock.patch.object(repair_tick, 'verify', side_effect=DetectorUnavailable(
                'hack detector did not pass: ' + str({'kind': 'import-error'}))):
            with self.assertRaises(DetectorUnavailable):
                repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(record['state'], 'queued')

    def test_terminal_failure_leaves_no_finding_bound_to_the_dead_run(self):
        job_id, job = self.prepare()
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        sibling_id = 'crq-run1-F2'
        sibling = copy.deepcopy(job)
        sibling.update(job=sibling_id, canonical_finding_id='d' * 64)
        atomic(bounded.job_path(self.root, sibling_id), sibling)
        record['jobs'] = [job_id, sibling_id]
        row = self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json')
        atomic(row, {'status': 'delivered', 'receipt': {'repair_task': sibling_id},
                     'review_id': 'e' * 64, 'previous_event_id': None})
        atomic(self.root / 'state/repair' / sibling_id / 'result.json',
               {'job': sibling_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': ['a' * 40],
                'attempts': [{'rung': 'A0'}], 'repair_base': record['base'],
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged')})
        # The first job's artifact is defective, so the run can never publish.
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'verdict': 'FIXED', 'commits': [],
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                'origin_job': OLD, 'repair_base': record['base']})
        self.c.iso = lambda: '2026-11-12T00:00:00Z'
        import finding_delivery
        import review_ledger as ledger
        out = ledger.Outbox(self.root / 'outbox', ledger.ArtifactStore(self.root / 'durable'))
        inbox = finding_delivery.Inbox(self.root / 'state/backfill/findings', out)
        with mock.patch.object(inbox, 'repair_outcome', wraps=inbox.repair_outcome) as outcome, \
             mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(record['state'], 'failed')
        self.assertEqual(json.loads(row.read_text())['status'], 'needs-human')
        sibling = [call for call in outcome.call_args_list if call.args[0] == 'd' * 64]
        self.assertEqual(len(sibling), 1)
        self.assertEqual(sibling[0].args[1], sibling_id)
        self.assertEqual(sibling[0].args[2], 'needs-human')
        self.assertIn('not published', sibling[0].args[3])

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

    def test_invalid_canonical_result_survives_ledger_and_queue_write_failures(self):
        import finding_delivery
        import review_ledger as ledger
        job_id, job = self.prepare()
        fid = 'd' * 64
        job['canonical_finding_id'] = fid
        atomic(bounded.job_path(self.root, job_id), job)
        row_path = self.root / 'state/backfill/findings/triage' / (fid + '.json')
        atomic(row_path, {'status': 'delivered', 'receipt': {'repair_task': job_id},
                          'review_id': 'e' * 64, 'previous_event_id': None})
        out = ledger.Outbox(self.root / 'outbox', ledger.ArtifactStore(self.root / 'durable'))
        inbox = finding_delivery.Inbox(self.root / 'state/backfill/findings', out)
        self.c.iso = lambda: '2026-11-12T00:00:00Z'
        result = {'job': job_id, 'item': job['item'], 'verdict': 'FIXED',
                  'commits': ['a' * 40], 'attempts': [],
                  'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                  'origin_job': OLD}
        path = self.root / 'state/repair' / job_id / 'result.json'
        atomic(path, result)
        self.c.save_queue(self.queue)
        def reload():
            self.queue = json.loads((self.root / 'state/queue.json').read_text())
            return self.queue['items'][0]
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            with mock.patch.object(self.c, 'save_queue', side_effect=OSError('queue write')), mock.patch.object(out, 'spool') as spool:
                with self.assertRaisesRegex(OSError, 'queue write'):
                    repair_tick.harvest(self.c, self.queue, self.queue['items'][0])
                spool.assert_not_called()
            # Keep the in-memory terminal record after the failed save. Replay
            # must persist it before touching the ledger, even without a reload.
            with mock.patch.object(self.c, 'save_queue', side_effect=OSError('terminal queue write')), mock.patch.object(out, 'spool') as spool:
                with self.assertRaisesRegex(OSError, 'terminal queue write'):
                    repair_tick.harvest(self.c, self.queue, self.queue['items'][0])
                spool.assert_not_called()
            item = self.queue['items'][0]
            def fail_spool(value):
                durable = json.loads((self.root / 'state/queue.json').read_text())['items'][0]
                self.assertEqual(durable['repair_runs'][job['run']]['state'], 'failed')
                self.assertEqual(durable['state'], 'repair_failed')
                raise OSError('ledger write')
            with mock.patch.object(out, 'spool', side_effect=fail_spool):
                with self.assertRaisesRegex(OSError, 'ledger write'):
                    repair_tick.harvest(self.c, self.queue, item)
            self.assertEqual(json.loads(row_path.read_text())['status'], 'delivered')
            item = reload()
            real_atomic = ledger.atomic
            def fail_row(filename, data):
                if filename == row_path:
                    raise OSError('triage row write')
                return real_atomic(filename, data)
            with mock.patch.object(ledger, 'atomic', side_effect=fail_row):
                with self.assertRaisesRegex(OSError, 'triage row write'):
                    repair_tick.harvest(self.c, self.queue, item)
            self.assertEqual(len(out.retained()), 1)
            self.assertEqual(json.loads(row_path.read_text())['status'], 'delivered')
            item = reload()
            repair_tick.harvest(self.c, self.queue, item)
            repair_tick.harvest(self.c, self.queue, item)
            self.assertEqual(json.loads(row_path.read_text())['status'], 'needs-retriage')
            self.assertEqual(len(out.retained()), 1)
            row = json.loads(row_path.read_text())
            row.update(status='needs-human', receipt={'repair_task': 'crq-new-owner-F1'})
            atomic(row_path, row)
            repair_tick.harvest(self.c, self.queue, item)
            self.assertEqual(json.loads(row_path.read_text()), row)
            self.assertEqual(len(out.retained()), 1)
            retained = item['repair_runs'][job['run']]['verdicts'][0]
            retained['item'] = 'wrong-item'
            with self.assertRaisesRegex(ValueError, 'outcome identity mismatch'):
                repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual(json.loads(path.read_text()), result)
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'dispatch') as paid:
            service.process(self.config, job, self.root / 'wt')
            service.process(self.config, job, self.root / 'wt')
            paid.assert_not_called()

    def test_terminal_canonical_failure_without_invalid_reason_is_not_replayed(self):
        job_id, job = self.prepare()
        job['canonical_finding_id'] = 'd' * 64
        atomic(bounded.job_path(self.root, job_id), job)
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        record.update(state='failed', verdicts=[{
            'job': job_id, 'item': item['id'], 'finding': job['finding'],
            'verdict': 'FAILED', 'reason': 'repair ladder exhausted'}])
        item['state'] = 'repair_failed'
        with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark:
            repair_tick.harvest(self.c, self.queue, item)
            mark.assert_not_called()

    def test_invalid_later_result_preserves_prior_verdicts(self):
        job_id, job = self.prepare()
        second = {**job, 'job': job_id + '-second'}
        atomic(bounded.job_path(self.root, second['job']), second)
        item = self.queue['items'][0]
        record = item['repair_runs'][job['run']]
        record['jobs'].append(second['job'])
        good = {'job': job_id, 'item': job['item'], 'verdict': 'NOT-FIXED', 'reason': 'test',
                'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
                'origin_job': OLD}
        atomic(self.root / 'state/repair' / job_id / 'result.json', good)
        atomic(self.root / 'state/repair' / second['job'] / 'result.json',
               {**good, 'job': second['job'], 'verdict': 'FIXED', 'commits': []})
        repair_tick.harvest(self.c, self.queue, item)
        self.assertEqual([v['job'] for v in record['verdicts']], record['jobs'])
        self.assertEqual([v['verdict'] for v in record['verdicts']], ['NOT-FIXED', 'FAILED'])

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
                        'attempts': [{'rung': rung}], 'reason': 'test', 'source_sha': job['source_sha'],
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

    def test_malformed_result_reconciles_canonical_failed_outcome(self):
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
            self.assertEqual(outcome.call_count, 2)
            self.assertEqual(outcome.call_args.args[:3], (fid, job_id, 'needs-retriage'))
            self.assertEqual(outcome.call_args.kwargs['failure_class'], 'exhausted')

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
