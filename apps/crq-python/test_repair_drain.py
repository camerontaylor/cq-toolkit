"""Automatic repair drain: selection, stale skip, GLM blackout. Real local Git, no models."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
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
        self.git('update-ref', 'refs/remotes/origin/main', self.tip)
        self.config = {'clone': str(self.clone), 'worktree_root': str(self.root / 'wt'),
                       'repair': {'enabled': True, 'spend_authorization': 'offline-test-fixture-only',
                                  'max_rounds_per_pin': 2, 'blackout': BLACKOUT, 'roles': ROLES,
                                  'budget': {'wall_clock_min': 20, 'max_tokens': 400000}}}
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

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.clone), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def item(self, item_id, run, jobs, open_pr, state='queued'):
        return {'id': item_id, 'pr': 1, 'kind': 'open' if open_pr else 'merged', 'state': 'repairing',
                'repair_runs': {run: {'jobs': jobs, 'pin': self.pin, 'base': self.pin, 'branch': None,
                                      'open_pr': open_pr, 'round': 1, 'state': state}}}

    def job(self, job_id, item, run, path):
        atomic(bounded.job_path(self.root, job_id), {
            'job': job_id, 'item': item, 'kind': 'merged', 'pr': 1, 'run': run, 'cycle': 1,
            'repair_base': self.pin, 'branch': None, 'repair_round': 1, 'prior': None, 'recurrence': False,
            'finding': {'severity': 'major', 'path': path, 'line': 1, 'body': 'Finding data'}})

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
        with mock.patch.object(service, 'blackout', return_value=False), \
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
        with mock.patch.object(service, 'blackout', return_value=True), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        process_item.assert_not_called()
        self.assertIsNone(self.result('crq-run1-F2'))

    def test_process_item_starts_no_finding_inside_blackout(self):
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        with mock.patch.object(service, 'blackout', return_value=True), \
             mock.patch.object(service, 'process') as process:
            service.process_item(self.config, [job])
        process.assert_not_called()

    def test_process_defers_attempt_inside_blackout_without_dispatch(self):
        _, job, _ = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')
        with mock.patch.object(service, 'blackout', return_value=True), \
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

    def test_main_refuses_without_zai_key_and_inside_blackout(self):
        atomic(self.root / 'config.json', self.config)
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_not_called()
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'unused-fixture'}), \
             mock.patch.object(service, 'blackout', return_value=True), \
             mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_not_called()
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'unused-fixture'}), \
             mock.patch.object(service, 'blackout', return_value=False), \
             mock.patch.object(service, 'drain') as drain:
            service.main([])
        drain.assert_called_once()

    def test_backfill_job_ids_sort_without_finding_suffix(self):
        jobs = [{'job': 'crq-run1-F10', 'run': 'run1'}, {'job': 'crq-run1-F2', 'run': 'run1'},
                {'job': 'crq-backfill-abc', 'run': 'backfill-abc'}]
        self.assertEqual([j['job'] for j in sorted(jobs, key=service.finding_order)],
                         ['crq-backfill-abc', 'crq-run1-F2', 'crq-run1-F10'])

    def test_tick_harvests_stale_verdicts_as_done(self):
        with mock.patch.object(service, 'blackout', return_value=False), \
             mock.patch.object(service, 'process_item'):
            service.drain(self.config)
        c = SimpleNamespace(STATE=self.root / 'state')
        item = self.queue['items'][1]
        repair_tick.harvest(c, self.queue, item)
        self.assertEqual(item['repair_runs']['run2']['state'], 'done')
        self.assertEqual(item['state'], 'done')
        self.assertEqual(repair_tick.digest(self.root, self.queue)['verdicts']['stale'], 1)

    def test_committed_config_is_cq_glm_only_and_enabled(self):
        repair = json.loads((ROOT / 'config.json').read_text())['repair']
        self.assertIs(repair['enabled'], True)
        self.assertIsInstance(repair['spend_authorization'], str)
        self.assertIn('2026-11-02', repair['spend_authorization'])
        self.assertEqual(repair['roles'], ROLES)
        self.assertEqual(repair['blackout'], BLACKOUT)
        self.assertNotIn('peak', repair)
        self.assertEqual(repair['budget'], {'wall_clock_min': 20, 'max_tokens': 400000})
        self.assertEqual(repair['max_rounds_per_pin'], 2)


if __name__ == '__main__':
    unittest.main()
