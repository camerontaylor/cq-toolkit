"""Automatic repair drain: selection, stale skip, GLM blackout. Real local Git, no models."""
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
from crq_repair import atomic
from crq_repair import bounded
import repair_tick

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_drain_under_test', ROOT / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
ROLES = {'fixer': {'driver': 'cq', 'model': 'zai/glm-5.3-flash'},
         'fixer_escalation': {'driver': 'cq', 'model': 'zai/glm-5.3'},
         'judge': {'driver': 'cq', 'model': 'zai/glm-5.3-flash'},
         'judge_critical': {'driver': 'cq', 'model': 'zai/glm-5.3'}}
BLACKOUT = {'tz': 'Asia/Singapore', 'days': [1, 2, 3, 4, 5], 'start': '14:00', 'end': '18:00'}


def utc(text):
    return dt.datetime.fromisoformat(text).replace(tzinfo=dt.timezone.utc)


class RepairDrainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.clone = self.root / 'clone'
        (self.clone / 'src').mkdir(parents=True)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.clone / 'src/kept.ts').write_text('one\ntwo\n')
        (self.clone / 'src/moved.ts').write_text('old\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'pin')
        self.pin = self.git('rev-parse', 'HEAD')
        (self.clone / 'src/moved.ts').write_text('new\n')
        self.git('commit', '-qam', 'main moved')
        self.tip = self.git('rev-parse', 'HEAD')
        # A local bare origin, so the drain's fetch --prune is real and offline.
        self.origin = self.root / 'origin.git'
        subprocess.run(['git', 'init', '-q', '--bare', str(self.origin)], check=True)
        self.git('remote', 'add', 'origin', str(self.origin))
        self.git('push', '-q', 'origin', self.tip + ':refs/heads/main')
        self.git('fetch', '-q', 'origin')
        self.config = {'clone': str(self.clone), 'worktree_root': str(self.root / 'wt'),
                       'repair': {'enabled': True, 'spend_authorization': 'offline-test-fixture-only',
                                  'max_rounds_per_pin': 2, 'blackout': BLACKOUT, 'roles': ROLES,
                                  'budget': {'wall_clock_min': 20, 'max_tokens': 400000,
                                             'max_output_tokens': 500000, 'max_context_tokens': 200000}}}
        self.queue = {'items': [
            self.item('pr1-merged', 'run1', ['crq-run1-F1', 'crq-run1-F2'], open_pr=False),
            self.item('pr2', 'run2', ['crq-run2-F1'], open_pr=True),
            self.item('pr3-merged', 'run3', ['crq-run3-F1'], open_pr=False, state='ready')]}
        self.job('crq-run1-F1', 'pr1-merged', 'run1', 'src/kept.ts')
        self.job('crq-run1-F2', 'pr1-merged', 'run1', 'src/moved.ts')
        self.job('crq-run2-F1', 'pr2', 'run2', 'src/kept.ts')
        self.job('crq-run3-F1', 'pr3-merged', 'run3', 'src/kept.ts')
        atomic(self.root / 'state/queue.json', self.queue)
        patcher = mock.patch.object(service, 'ROOT', self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_harvest_writeback_maps_nonfixed_outcomes(self):
        c = SimpleNamespace(STATE=self.root / 'state', iso=lambda: 'now')
        job = {'job': 'job', 'canonical_finding_id': 'finding'}
        with mock.patch('backfill_runtime.settings', return_value={'durable_artifact_root': str(self.root / 'artifacts')}), mock.patch('finding_delivery.Inbox') as inbox:
            for verdict, judge, expected in [('STALE', None, 'needs-retriage'),
                    ('FAILED', None, 'needs-human'), ('NOT-FIXED', {'verdict': 'invalid'}, 'dismissed'),
                    ('FIXED', None, 'fixed')]:
                repair_tick.mark_finding_outcome(c, job, {'verdict': verdict, 'judge': judge, 'reason': 'evidence'},
                                                self.tip if verdict == 'FIXED' else None)
                self.assertEqual(inbox.return_value.repair_outcome.call_args.args[2], expected)
            inbox.reset_mock()
            repair_tick.mark_finding_outcome(c, job, {'verdict': 'FIXED'})
            inbox.assert_not_called()

    def test_merge_reconciliation_marks_threadless_ledger_only_after_merge(self):
        job_id = 'crq-run1-F1'
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        record.update(fix_pr={'number': 99, 'url': 'https://github.com/example/repo/pull/99'},
                      verdicts=[{'job': job_id, 'verdict': 'FIXED', 'reason': 'verified'}])
        c = SimpleNamespace(STATE=self.root / 'state', iso=lambda: 'now',
                            pr_info=mock.Mock(return_value={'state': 'OPEN'}),
                            git=lambda *args: self.tip, is_ancestor=lambda *args: True)
        with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark:
            repair_tick.reconcile_fix_prs(c, self.queue)
            mark.assert_not_called()
            c.pr_info.return_value = {'state': 'MERGED', 'mergeCommit': {'oid': self.tip}}
            repair_tick.reconcile_fix_prs(c, self.queue)
            self.assertEqual(mark.call_args.args[3], self.tip)
            repair_tick.reconcile_fix_prs(c, self.queue)
            self.assertEqual(mark.call_count, 1)

    def test_fix_pr_provenance_includes_threadless_and_pr_sources(self):
        path = self.root / 'state/repair/inbox/crq-run1-F1.json'
        job = json.loads(path.read_text())
        job.update(canonical_finding_id='canonical-id', review_id='ledger-review-id', pr=0)
        atomic(path, job)
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo')
        body = '\n'.join(repair_tick.repair_provenance(c, self.queue['items'][0]['repair_runs']['run1'], 'run1'))
        for value in ('canonical-id', 'ledger-review-id', 'threadless', '/pull/1', 'crq-run1-F2', 'run1'):
            self.assertIn(value, body)

    def test_source_resolution_resumes_existing_publication_journal(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        job_id = record['jobs'][0]
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        job['source_thread_id'] = 'thread-node'
        atomic(path, job)
        record.update(publication={'head': self.tip}, fix_pr={'url': 'https://github.com/example/repo/pull/99'},
                      verdicts=[{'job': job_id, 'verdict': 'FIXED'}])
        atomic(self.root / 'state/repair' / job_id / 'publication.json', record['publication'])
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo', run=mock.Mock(),
                            gh_json=mock.Mock(side_effect=[[], {'data': {'resolveReviewThread': {'thread': {'isResolved': True}}}}]))
        repair_tick.publish_source_resolution(c, record, self.tip)
        repair_tick.publish_source_resolution(c, record, self.tip)
        self.assertEqual(c.run.call_count, 1)
        self.assertEqual(c.gh_json.call_count, 2)
        journal = json.loads((self.root / 'state/repair' / job_id / 'publication.json').read_text())
        self.assertEqual(journal['source_resolutions'], [job_id])
        self.assertIn('--body-file', c.run.call_args.args[0])

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.clone), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def item(self, item_id, run, jobs, open_pr, state='queued'):
        return {'id': item_id, 'pr': 1, 'kind': 'open' if open_pr else 'merged', 'state': 'repairing',
                'repair_runs': {run: {'jobs': jobs, 'pin': self.pin, 'base': self.pin, 'branch': None,
                                      'open_pr': open_pr, 'round': 1, 'state': state}}}

    def job(self, job_id, item, run, path, base=None, severity='major'):
        atomic(bounded.job_path(self.root, job_id), {
            'job': job_id, 'item': item, 'kind': 'merged', 'pr': 1, 'run': run, 'cycle': 1,
            'repair_base': base or self.pin, 'branch': None, 'repair_round': 1, 'prior': None,
            'recurrence': False,
            'finding': {'severity': severity, 'path': path, 'line': 1, 'body': 'Finding data'}})

    def commit_on(self, base, path, text):
        self.git('checkout', '-q', '--detach', base)
        (self.clone / path).write_text(text)
        self.git('add', path)
        self.git('commit', '-qm', 'change ' + path)
        return self.git('rev-parse', 'HEAD')

    def worktree(self, name='crq-repair-pr1-merged'):
        wt = self.root / 'wt' / name
        self.git('worktree', 'add', '-q', '--detach', str(wt), self.pin)
        return wt

    def past(self, job_id):
        path = self.root / 'state/repair' / job_id / 'result.json'
        data = json.loads(path.read_text())
        data['retry_after'] = '2000-01-01T00:00:00Z'
        atomic(path, data)

    def result(self, job_id):
        path = self.root / 'state/repair' / job_id / 'result.json'
        return json.loads(path.read_text()) if path.exists() else None

    def test_classification_binds_current_and_skips_superseded(self):
        status, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        self.assertEqual(status, 'run')
        self.assertEqual(job['source_sha'], self.pin)
        self.assertEqual(job['source_blob_sha'], self.git('rev-parse', self.pin + ':src/kept.ts'))
        self.assertEqual(job['finding_sha256'], bounded.identity(job['finding']))
        self.assertIsNone(job['origin_job'])
        status, _, reason = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F2')
        self.assertEqual((status, reason), ('stale', 'finding source changed on the default branch since the pin'))
        status, _, reason = bounded.drain_job(self.root, self.config, self.queue, 'crq-run2-F1')
        self.assertEqual((status, reason), ('stale', 'reviewed PR head is already on the default branch'))
        self.assertEqual(bounded.drain_job(self.root, self.config, self.queue, 'crq-run3-F1')[0], 'skip')
        self.assertEqual(bounded.drain_job(self.root, self.config, {'items': []}, 'crq-run1-F1')[0], 'skip')

    def test_started_job_resumes_even_if_now_superseded(self):
        atomic(self.root / 'state/repair/crq-run1-F2/progress.json', {'attempts': []})
        self.assertEqual(bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F2')[0], 'run')

    def test_drain_marks_stale_without_spend_and_processes_eligible_items(self):
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        self.assertEqual(process_item.call_count, 1)
        jobs = process_item.call_args.args[1]
        self.assertEqual([j['job'] for j in jobs], ['crq-run1-F1', 'crq-run1-F2'])
        self.assertEqual(jobs[0]['source_sha'], self.pin)
        for job_id in ('crq-run1-F2', 'crq-run2-F1'):
            result = self.result(job_id)
            self.assertEqual(result['verdict'], 'STALE')
            self.assertEqual(result['attempts'], [])
        self.assertIsNone(self.result('crq-run1-F1'))
        self.assertIsNone(self.result('crq-run3-F1'))

    def test_drain_does_nothing_inside_blackout(self):
        with mock.patch.object(service, 'blocked', return_value=True), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        process_item.assert_not_called()
        self.assertIsNone(self.result('crq-run1-F2'))

    def test_process_item_starts_no_finding_inside_blackout(self):
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        with mock.patch.object(service, 'blocked', return_value=True), \
             mock.patch.object(service, 'process') as process:
            service.process_item(self.config, [job])
        process.assert_not_called()

    def test_process_defers_attempt_inside_blackout_without_dispatch(self):
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        with mock.patch.object(service, 'blocked', return_value=True), \
             mock.patch.object(service.cq, 'invoke') as invoke:
            result = service.process(self.config, job, self.root / 'wt/crq-repair-pr1-merged')
        invoke.assert_not_called()
        self.assertTrue(result['retry_after'])
        self.assertEqual(result['next_rung'], 0)
        self.assertIn('blackout', result['reason'])

    def test_drained_snapshot_keeps_pin_while_base_chains(self):
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        job['repair_base'] = 'd' * 40  # predecessor commit of an earlier finding
        snapshot = bounded.source_snapshot(self.config, job)
        self.assertEqual(snapshot['source_sha'], self.pin)
        self.assertEqual(snapshot['source'], '1: one\n2: two')
        job['source_blob_sha'] = 'e' * 40
        with self.assertRaisesRegex(ValueError, 'blob'):
            bounded.source_snapshot(self.config, job)

    def test_blackout_window_is_singapore_weekday_afternoon(self):
        repair = {'blackout': BLACKOUT}
        self.assertTrue(service.blackout(repair, utc('2026-11-02T06:00:00')))   # Mon 14:00 SGT
        self.assertTrue(service.blackout(repair, utc('2026-11-02T09:59:00')))   # Mon 17:59 SGT
        self.assertFalse(service.blackout(repair, utc('2026-11-02T05:59:00')))  # Mon 13:59 SGT
        self.assertFalse(service.blackout(repair, utc('2026-11-02T10:00:00')))  # Mon 18:00 SGT
        self.assertFalse(service.blackout(repair, utc('2026-11-07T07:00:00')))  # Sat 15:00 SGT
        self.assertFalse(service.blackout({}, utc('2026-11-02T07:00:00')))

    def test_blackout_switch_suspends_window_and_blocked(self):
        off = {'blackout': {**BLACKOUT, 'enabled': False}, 'budget': {'wall_clock_min': 20}}
        on = {'blackout': {**BLACKOUT, 'enabled': True}, 'budget': {'wall_clock_min': 20}}
        inside = utc('2026-11-02T07:00:00')  # Mon 15:00 SGT
        self.assertFalse(service.blackout(off, inside))
        self.assertFalse(service.blocked(off, inside))
        self.assertTrue(service.blackout(on, inside))
        self.assertTrue(service.blocked(on, inside))

    def test_main_refuses_without_zai_key_and_inside_blackout(self):
        atomic(self.root / 'config.json', self.config)
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_not_called()
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'unused-fixture'}), \
             mock.patch.object(service, 'blocked', return_value=True), \
             mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_not_called()
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'unused-fixture'}), \
             mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_called_once()

    def test_backfill_job_ids_sort_without_finding_suffix(self):
        jobs = [{'job': 'crq-run1-F10', 'run': 'run1'}, {'job': 'crq-run1-F2', 'run': 'run1'},
                {'job': 'crq-backfill-abc', 'run': 'backfill-abc'}]
        self.assertEqual([j['job'] for j in sorted(jobs, key=service.finding_order)],
                         ['crq-backfill-abc', 'crq-run1-F2', 'crq-run1-F10'])

    def test_tick_harvests_stale_verdicts_as_done(self):
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item'):
            service.drain(self.config)
        c = SimpleNamespace(STATE=self.root / 'state')
        item = self.queue['items'][1]
        repair_tick.harvest(c, self.queue, item)
        self.assertEqual(item['repair_runs']['run2']['state'], 'done')
        self.assertEqual(item['state'], 'done')
        self.assertEqual(repair_tick.digest(self.root, self.queue)['verdicts']['stale'], 1)

    def test_open_pr_branch_gone_or_changed_source_is_stale(self):
        head = self.commit_on(self.pin, 'src/pr.ts', 'pr\n')
        self.queue['items'][1]['repair_runs']['run2'].update(base=head, pin=head, branch='feat/x')
        self.job('crq-run2-F1', 'pr2', 'run2', 'src/kept.ts', base=head)
        classify = lambda: bounded.drain_job(self.root, self.config, self.queue, 'crq-run2-F1')
        self.assertEqual(classify()[::2], ('stale', 'PR branch is gone from origin (closed or deleted)'))
        self.git('update-ref', 'refs/remotes/origin/feat/x', head)
        self.assertEqual(classify()[0], 'run')
        self.git('update-ref', 'refs/remotes/origin/feat/x', self.commit_on(head, 'src/other.ts', 'x\n'))
        self.assertEqual(classify()[0], 'run')
        self.git('update-ref', 'refs/remotes/origin/feat/x', self.commit_on(head, 'src/kept.ts', 'changed\n'))
        self.assertEqual(classify()[::2], ('stale', 'PR branch changed the finding source since the pin'))

    def test_drain_fetches_before_stale_checks(self):
        moved = self.commit_on(self.tip, 'src/kept.ts', 'fixed upstream\n')
        self.git('push', '-q', 'origin', moved + ':refs/heads/main')
        self.git('update-ref', 'refs/remotes/origin/main', self.tip)  # local view is behind
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        process_item.assert_not_called()
        self.assertEqual(self.result('crq-run1-F1')['verdict'], 'STALE')

    def test_drain_skips_pass_when_fetch_fails(self):
        self.git('remote', 'set-url', 'origin', str(self.root / 'missing.git'))
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        process_item.assert_not_called()
        self.assertIsNone(self.result('crq-run1-F2'))

    def test_drain_stops_pass_after_rate_limited_item(self):
        self.queue['items'].append(self.item('pr4-merged', 'run4', ['crq-run4-F1'], open_pr=False))
        self.job('crq-run4-F1', 'pr4-merged', 'run4', 'src/kept.ts')
        atomic(self.root / 'state/queue.json', self.queue)
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item', return_value='rate-limit') as process_item:
            service.drain(self.config)
        self.assertEqual(process_item.call_count, 1)
        self.assertEqual(process_item.call_args.args[1][0]['item'], 'pr1-merged')

    def test_process_item_stops_once_the_pause_marker_is_written(self):
        (self.root / 'wt/crq-repair-pr1-merged').mkdir(parents=True)
        jobs = [bounded.drain_job(self.root, self.config, self.queue, j)[1] for j in ('crq-run1-F1', 'crq-run1-F2')]

        def limited(config, job, wt):
            service.rate_limit_pause({'stop': 'rate-limit'}, job['job'])
            return {'retry_after': '2999-01-01T00:00:00Z', 'verdict': 'FAILED'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process', side_effect=limited) as process:
            self.assertEqual(service.process_item(self.config, jobs), 'rate-limit')
        self.assertEqual(process.call_count, 1)

    def test_rate_limit_pauses_every_item_until_the_window_ends(self):
        self.queue['items'].append(self.item('pr4-merged', 'run4', ['crq-run4-F1'], open_pr=False))
        self.job('crq-run4-F1', 'pr4-merged', 'run4', 'src/kept.ts')
        atomic(self.root / 'state/queue.json', self.queue)
        unchanged = {'stop': 'ok', 'changed': False, 'summary': 'no change warranted', 'commits': []}
        limited = {'stop': 'rate-limit', 'retry_after_ms': 3600000}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service.cq, 'invoke', side_effect=[limited, unchanged, unchanged]) as invoke:
            service.drain(self.config)  # first item hits the limit; pr4 is never reached
            self.assertEqual(invoke.call_count, 1)
            marker = json.loads((self.root / 'state/repair/rate-limited-until').read_text())
            until = dt.datetime.fromisoformat(marker['until'].replace('Z', '+00:00'))
            self.assertGreater(until, dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=55))
            self.assertEqual(self.result('crq-run1-F1')['retry_after'], marker['until'])
            self.assertIsNone(self.result('crq-run4-F1'))
            service.drain(self.config)  # inside the window: no model call for ANY item
            self.assertEqual(invoke.call_count, 1)
            self.assertIsNone(self.result('crq-run4-F1'))
            # The window ends: both the marker and the job's own retry time pass.
            atomic(self.root / 'state/repair/rate-limited-until', {**marker, 'until': '2000-01-01T00:00:00Z'})
            self.past('crq-run1-F1')
            service.drain(self.config)
        self.assertEqual(invoke.call_count, 3)
        for job_id in ('crq-run1-F1', 'crq-run4-F1'):
            result = self.result(job_id)
            self.assertEqual(result['verdict'], 'NOT-FIXED')
            self.assertNotIn('retry_after', result)

    def test_provider_fallback_persists_reset_and_skips_exhausted_zai(self):
        self.config['repair']['fallback_models'] = ['opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-flash']
        reset = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)).strftime('%Y-%m-%d %H:%M:%S')
        limited = {'stop': 'rate-limit', 'summary': 'Weekly/Monthly Limit Exhausted. Your limit will reset at ' + reset}
        success = {'stop': 'ok', 'changed': False}
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture', 'OPENCODE_GO_API_KEY': 'fixture', 'OPENCODE_GO_BASE_URL': 'https://fixture.invalid', 'DEEPSEEK_API_KEY': 'fixture'}), \
             mock.patch.object(service, '_dispatch', side_effect=[limited, success, success]) as dispatch:
            first = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root / 'attempt')
            self.assertEqual(first['model'], 'opencode-go/deepseek-v4.1-flash')
            service.dispatch(self.config, ROLES['judge'], {'run': 'r', 'job': 'j'}, self.clone, self.root / 'judge', judge=True)
            self.assertEqual([c.args[1]['model'] for c in dispatch.call_args_list],
                             ['zai/glm-5.3-flash', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash'])
            self.assertTrue(dispatch.call_args_list[-1].args[-1])
            self.assertGreater(service.provider_cooldowns()['zai'], (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)).isoformat())
            service.rate_limit_pause({}, 'old-global-marker')
            self.assertIsNone(service.dispatch_paused(self.config))

    def test_reset_offset_is_stored_as_utc(self):
        now = dt.datetime.now(dt.timezone.utc)
        reset = (now + dt.timedelta(days=2)).astimezone(dt.timezone(dt.timedelta(hours=-8)))
        until = service.remember_provider_limit('zai', {'summary': 'Your limit will reset at ' + reset.isoformat()})
        self.assertEqual(until, reset.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))

    def test_fallback_discards_throttled_fixers_partial_commits_and_files(self):
        self.config['repair']['fallback_models'] = ['deepseek/deepseek-flash']
        original = self.git('rev-parse', 'HEAD')
        def invoke(config, role, job, wt, directory, judge):
            if role['model'].startswith('zai/'):
                (wt / 'src/kept.ts').write_text('partial edit')
                self.git('commit', '-qam', 'partial fixer commit')
                (wt / 'partial-untracked').write_text('partial file')
                return {'stop': 'rate-limit'}
            self.assertEqual(self.git('rev-parse', 'HEAD'), original)
            self.assertEqual((wt / 'src/kept.ts').read_text(), 'one\ntwo\n')
            self.assertFalse((wt / 'partial-untracked').exists())
            return {'stop': 'ok', 'changed': False}
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture', 'DEEPSEEK_API_KEY': 'fixture'}), \
             mock.patch.object(service, '_dispatch', side_effect=invoke):
            result = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root)
        self.assertEqual(result['model'], 'deepseek/deepseek-flash')

    def test_remaining_wire_budget_is_integer_milliseconds(self):
        config = {'repair': {'budget': {'wall_clock_min': 0.123456789}}}
        budget = service.cq.budget(config, ROLES['fixer'])
        self.assertIsInstance(budget['wallClockMs'], int)
        self.assertEqual(budget['wallClockMs'], 7407)

    def test_all_providers_limited_defers_to_earliest_reset(self):
        self.config['repair']['fallback_models'] = ['opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-flash']
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture', 'OPENCODE_GO_API_KEY': 'fixture', 'OPENCODE_GO_BASE_URL': 'https://fixture.invalid', 'DEEPSEEK_API_KEY': 'fixture'}), \
             mock.patch.object(service, '_dispatch', side_effect=[{'stop': 'rate-limit', 'retry_after_ms': ms} for ms in [3600000, 1800000, 7200000]]) as dispatch:
            report = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root / 'attempt')
            self.assertEqual(dispatch.call_count, 3)
            self.assertEqual(report['stop'], 'rate-limit')
            self.assertTrue(1700000 < report['retry_after_ms'] <= 1800000)
            self.assertEqual(len(service.provider_cooldowns()), 3)
            again = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root / 'again')
            self.assertEqual(dispatch.call_count, 3)
            self.assertEqual(again['stop'], 'rate-limit')

    def test_non_quota_failure_does_not_spend_on_fallback(self):
        self.config['repair']['fallback_models'] = ['deepseek/deepseek-flash']
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture'}), \
             mock.patch.object(service, '_dispatch', return_value={'stop': 'error', 'summary': 'bad input'}) as dispatch:
            report = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root)
        self.assertEqual(report['stop'], 'error')
        self.assertEqual(dispatch.call_count, 1)

    def test_missing_fallback_credentials_are_not_dispatched(self):
        self.config['repair']['fallback_models'] = ['opencode-go/deepseek-v4.1-flash']
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture'}, clear=True), \
             mock.patch.object(service, '_dispatch', return_value={'stop': 'rate-limit'}) as dispatch:
            report = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root)
        self.assertEqual(report['stop'], 'rate-limit')
        self.assertEqual(dispatch.call_count, 1)

    def test_pause_defaults_to_30_minutes_and_is_never_shortened(self):
        now = dt.datetime.now(dt.timezone.utc)
        first = dt.datetime.fromisoformat(service.rate_limit_pause({}, 'j1').replace('Z', '+00:00'))
        self.assertTrue(now + dt.timedelta(minutes=29) < first <= now + dt.timedelta(minutes=31))
        second = service.rate_limit_pause({'retry_after_ms': 1000}, 'j2')
        self.assertEqual(dt.datetime.fromisoformat(second.replace('Z', '+00:00')), first)
        self.assertEqual(service.paused(), second)
        self.assertIsNone(service.paused(first + dt.timedelta(seconds=1)))

    def test_cq_driver_passes_provider_retry_time(self):
        out = json.dumps({'status': 'error', 'error': 'errorClass=rate-limit',
                          'providerSignals': {'httpStatus': 429, 'retryAfterMs': 5000}})
        self.config.update(repo='example/repo')
        self.config['repair']['cq_bin'] = '/unused/cli.js'
        job = {'job': 'crq-run1-F1', 'finding': {'path': 'src/kept.ts', 'line': 1, 'body': 'x'},
               'source_snapshot': {}}
        with mock.patch.object(service.cq, 'command',
                               return_value=SimpleNamespace(returncode=1, stdout=out, stderr='')):
            report = service.cq.invoke(self.config, ROLES['fixer'], job, self.root, self.root)
        self.assertEqual((report['stop'], report['retry_after_ms']), ('rate-limit', 5000))

    def test_drain_skips_pass_while_the_tick_holds_its_lock(self):
        self.config['repair']['tick_lock_wait_s'] = 0
        lock_path = self.root / 'state/tick.lock'
        with lock_path.open('w') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(service, 'blocked', return_value=False), \
                 mock.patch.object(service, 'command', wraps=service.command) as command, \
                 mock.patch.object(service, 'process_item') as process_item:
                service.drain(self.config)
            fcntl.flock(held, fcntl.LOCK_UN)
        command.assert_not_called()  # no fetch while the tick owns the clone
        process_item.assert_not_called()
        self.assertIsNone(self.result('crq-run1-F2'))
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        self.assertEqual(self.result('crq-run1-F2')['verdict'], 'STALE')

    def test_drain_waits_for_a_tick_that_releases_its_lock(self):
        # A path-triggered drain starts while the enqueuing tick still holds
        # tick.lock; it must wait for the release, not drop the pass.
        lock_path = self.root / 'state/tick.lock'
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        held = lock_path.open('w')
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer = threading.Timer(0.5, lambda: (fcntl.flock(held, fcntl.LOCK_UN), held.close()))
        timer.start()
        self.addCleanup(timer.cancel)
        self.config['repair']['tick_lock_wait_s'] = 10
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item'):
            service.drain(self.config)
        self.assertEqual(self.result('crq-run1-F2')['verdict'], 'STALE')

    def test_lock_wait_gives_up_after_its_bound(self):
        lock_path = self.root / 'state/tick.lock'
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open('w') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            start = time.monotonic()
            self.assertEqual(service.fetch_clone(self.config, lock_wait=0.3), 'crq tick holds tick.lock')
            self.assertLess(time.monotonic() - start, 5)

    def test_digest_ignores_jobs_the_drain_can_never_select(self):
        # The retired promotion run on the runner host: '+' is outside the job-id grammar
        # and promotion items are never harvested, so it pinned 'oldest' forever.
        promo = 'crq-signer-promo-7f440274a8+-F1'
        (self.root / 'state/repair/inbox' / (promo + '.json')).write_text(json.dumps(
            {'job': promo, 'item': 'promo-7f440274a8+', 'run': 'signer-promo-7f440274a8+'}))
        self.queue['items'].append({'id': 'promo-7f440274a8+', 'kind': 'promotion', 'state': 'done',
                                    'repair_runs': {'signer-promo-7f440274a8+': {
                                        'jobs': [promo], 'state': 'queued'}}})
        # A queued run's job left behind after its run went terminal is also
        # orphaned; publish_failed is the tick's to retry, never the drain's.
        self.queue['items'][2]['repair_runs']['run3']['state'] = 'publish_failed'
        # A promotion item's queued run with a valid id IS drainable (drain_job
        # does not filter on kind), so it counts as inbox work.
        self.queue['items'].append({'id': 'promo-ok', 'kind': 'promotion', 'state': 'done',
                                    'repair_runs': {'run6': {'jobs': ['crq-run6-F1'], 'state': 'queued',
                                                             'base': self.pin}}})
        self.job('crq-run6-F1', 'promo-ok', 'run6', 'src/kept.ts')
        digest = repair_tick.digest(self.root, self.queue)
        self.assertEqual(digest['inbox'], 4)  # run1 F1/F2, run2 F1 and run6 F1 still drain
        self.assertEqual(digest['orphaned'], 2)
        drainable = {j for j in bounded.drain_order(self.root)
                     if bounded.drain_job(self.root, self.config, self.queue, j)[2]
                     != 'no queued tick-owned repair run'}
        self.assertEqual(drainable, {'crq-run1-F1', 'crq-run1-F2', 'crq-run2-F1', 'crq-run6-F1'})
        for job_id in ('crq-run1-F1', 'crq-run1-F2', 'crq-run2-F1', 'crq-run6-F1'):
            service.mark_stale({'job': job_id, 'item': 'x'}, 'test')
        digest = repair_tick.digest(self.root, self.queue)
        self.assertEqual((digest['inbox'], digest['oldest_age_minutes']), (0, 0))

    def test_enqueue_refuses_run_ids_the_drain_cannot_select(self):
        rdir = self.root / 'runs/x'
        rdir.mkdir(parents=True)
        (rdir / 'review.ndjson').write_text(json.dumps(
            {'type': 'finding', 'severity': 'major', 'fileName': 'src/kept.ts', 'comment': 'x'}) + '\n')
        c = SimpleNamespace(REPO='o/r', item_repo=lambda item: 'o/r', CONFIG=self.config,
                            STATE=self.root / 'state', git=lambda *a, **k: '' if a[0] == 'rev-list' else self.tip)
        q = {'items': []}
        for run, queued in (('promo-7f440274a8+', False), ('pr9-20261106T000000Z', True)):
            item = {'id': 'pr9', 'pr': 9, 'kind': 'merged', 'state': 'reviewing'}
            meta = {'run_id': run, 'base': self.pin, 'head': self.tip}
            self.assertIs(repair_tick.enqueue(c, q, item, meta, rdir), queued)
            self.assertEqual(bounded.job_path(self.root, 'crq-' + run + '-F1').exists() if queued
                             else (self.root / 'state/repair/inbox' / ('crq-' + run + '-F1.json')).exists(),
                             queued)

    def test_enqueue_adopts_base_of_orphan_inbox_job(self):
        rdir = self.root / 'runs/x'
        rdir.mkdir(parents=True)
        finding = {'type': 'finding', 'severity': 'major', 'fileName': 'src/kept.ts', 'comment': 'x'}
        (rdir / 'review.ndjson').write_text(json.dumps(finding) + '\n')
        c = SimpleNamespace(REPO='o/r', item_repo=lambda item: 'o/r', CONFIG=self.config,
                            STATE=self.root / 'state', git=lambda *a, **k: '' if a[0] == 'rev-list' else self.tip)
        item = {'id': 'pr9', 'pr': 9, 'kind': 'merged', 'state': 'reviewing'}
        meta = {'run_id': 'pr9-20261106T000000Z', 'base': self.pin, 'head': self.tip}
        self.assertTrue(repair_tick.enqueue(c, {'items': []}, item, meta, rdir))
        path = self.root / 'state/repair/inbox/crq-pr9-20261106T000000Z-F1.json'
        job = json.loads(path.read_text())
        job['repair_base'] = 'orphan-base'
        path.write_text(json.dumps(job))
        item = {'id': 'pr9', 'pr': 9, 'kind': 'merged', 'state': 'reviewing'}
        self.assertTrue(repair_tick.enqueue(c, {'items': []}, item, meta, rdir))
        self.assertEqual(item['repair_runs'][meta['run_id']]['base'], 'orphan-base')

    def test_judge_deferred_by_blackout_resumes_without_repeating_fixer(self):
        self.job('crq-run1-F1', 'pr1-merged', 'run1', 'src/kept.ts', severity='critical')
        wt = self.worktree()
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        unchanged = {'stop': 'ok', 'changed': False, 'summary': 'no change warranted', 'commits': []}
        # First guard (fixer) is clear; the judge guard falls inside the blackout.
        with mock.patch.object(service, 'blocked', side_effect=[False, True]), \
             mock.patch.object(service.cq, 'invoke', return_value=unchanged) as invoke, \
             mock.patch.object(service.cq, 'judge') as judge:
            result = service.process(self.config, dict(job), wt)
        self.assertEqual(invoke.call_count, 1)
        judge.assert_not_called()
        self.assertIn('judge deferred', result['reason'])
        self.assertTrue(result['pending_judge'])
        self.assertTrue(result['retry_after'])
        self.past('crq-run1-F1')
        verdict = {'stop': 'ok', 'verdict': 'invalid', 'reason': 'not a defect'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service.cq, 'invoke') as invoke, \
             mock.patch.object(service.cq, 'judge', return_value=verdict) as judge:
            result = service.process(self.config, dict(job), wt)
        invoke.assert_not_called()
        self.assertEqual(judge.call_count, 1)
        self.assertEqual(judge.call_args.args[2]['fixer_reason'], 'no change warranted')
        self.assertEqual(result['verdict'], 'NOT-FIXED')
        self.assertNotIn('pending_judge', result)
        self.assertNotIn('retry_after', result)

    def test_harvest_publishes_fixed_findings_around_a_stale_one(self):
        jobs = ['crq-run5-F1', 'crq-run5-F2', 'crq-run5-F3']
        item = self.item('pr5-merged', 'run5', jobs, open_pr=False)
        self.queue['items'].append(item)
        for job_id in jobs:
            self.job(job_id, 'pr5-merged', 'run5', 'src/kept.ts')
        first, second = '1' * 40, '2' * 40
        wt = str(self.root / 'wt/crq-repair-pr5-merged')
        common = {'item': 'pr5-merged', 'attempts': [{'rung': 'A0'}], 'worktree': wt, 'reason': 'ok'}
        atomic(self.root / 'state/repair/crq-run5-F1/result.json',
               {**common, 'job': jobs[0], 'verdict': 'FIXED', 'repair_base': self.pin, 'commits': [first]})
        service.mark_stale({'job': jobs[1], 'item': 'pr5-merged', 'repair_base': self.pin}, 'superseded')
        atomic(self.root / 'state/repair/crq-run5-F3/result.json',
               {**common, 'job': jobs[2], 'verdict': 'FIXED', 'repair_base': first, 'commits': [second]})
        stub = self.root / 'stub'
        stub.mkdir()
        (stub / 'crq_repair.py').write_text('def mechanical(*args):\n    return {}\n')
        c = SimpleNamespace(STATE=self.root / 'state', WT_ROOT=self.root / 'wt', ROOT=stub,
                            CONFIG=self.config, make_worktree=mock.Mock(return_value=(self.root, 'b')),
                            remove_worktree=mock.Mock())
        with mock.patch.object(repair_tick, 'verify') as verify, \
             mock.patch.object(repair_tick, 'publish') as publish:
            repair_tick.harvest(c, self.queue, item)
        self.assertEqual([call.args[1] for call in verify.call_args_list], [self.pin, first])
        record = item['repair_runs']['run5']
        self.assertEqual([v['verdict'] for v in record['verdicts']], ['FIXED', 'STALE', 'FIXED'])
        fixed = publish.call_args.args[5]
        self.assertEqual([v['job'] for v in fixed], [jobs[0], jobs[2]])
        self.assertEqual(item['state'], 'done')

    def test_blocked_refuses_dispatch_whose_wall_clock_reaches_blackout(self):
        repair = {'blackout': BLACKOUT, 'budget': {'wall_clock_min': 20}}
        self.assertTrue(service.blocked(repair, utc('2026-11-02T05:45:00')))   # 13:45 + 20m
        self.assertFalse(service.blocked(repair, utc('2026-11-02T05:39:00')))  # ends 13:59
        self.assertTrue(service.blocked(repair, utc('2026-11-02T07:00:00')))
        self.assertFalse(service.blocked(repair, utc('2026-11-02T10:00:00')))  # 18:00

    def test_committed_config_enables_cq_with_provider_fallback(self):
        repair = json.loads((ROOT / 'config.json').read_text())['repair']
        self.assertIs(repair['enabled'], True)
        self.assertIsInstance(repair['spend_authorization'], str)
        self.assertIn('2026-11-08', repair['spend_authorization'])
        self.assertEqual(repair['fallback_models'], ['opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-flash'])
        self.assertEqual(repair['roles'], ROLES)
        self.assertEqual(repair['blackout'], {'enabled': False, **BLACKOUT})  # suspended 2026-11-02
        self.assertNotIn('peak', repair)
        # Owner 2026-11-06: output-only cap and a 200k context ceiling for cq;
        # max_tokens is read only by the (disabled) codex/paseo launchers.
        self.assertEqual(repair['budget'], {'wall_clock_min': 20, 'max_tokens': 400000,
                                            'max_output_tokens': 500000, 'max_context_tokens': 200000})
        self.assertEqual(repair['max_rounds_per_pin'], 2)


if __name__ == '__main__':
    unittest.main()
