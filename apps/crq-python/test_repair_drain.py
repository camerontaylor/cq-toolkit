"""Automatic repair drain: selection, stale skip, GLM blackout. Real local Git, no models."""
import datetime as dt
import copy
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
import finding_delivery
import review_ledger as ledger
from test_backfill_accounting import Fixture
from test_review_ledger import rehash

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

    def test_concurrent_items_are_bounded_and_environment_isolated(self):
        self.config['repair']['max_concurrent_items'] = 10
        stats = self.root / 'workers.json'
        atomic(stats, {'active': 0, 'peak': 0, 'finished': []})
        def worker(config, item, jobs):
            with service.correlation({'run': item, 'job': item}, False):
                with service.cooldown_write():
                    data = json.loads(stats.read_text())
                    data['active'] += 1
                    data['peak'] = max(data['peak'], data['active'])
                    atomic(stats, data)
                time.sleep(0.1)
                with service.cooldown_write():
                    data = json.loads(stats.read_text())
                    data['active'] -= 1
                    data['finished'].append([item, os.environ['CQ_RUN_ID']])
                    atomic(stats, data)
        names = [str(n) for n in range(14)]
        with mock.patch.object(service, 'drain_item', side_effect=worker), mock.patch.object(service, 'blocked', return_value=False):
            service.drain_items(self.config, {n: [] for n in names}, names)
        data = json.loads(stats.read_text())
        self.assertGreater(data['peak'], 1)
        self.assertLessEqual(data['peak'], 10)
        self.assertEqual(data['active'], 0)
        self.assertEqual(sorted(data['finished']), sorted([[n, n] for n in names]))

    def test_concurrent_pause_stops_admission_and_drains_paid_worker(self):
        self.config['repair']['max_concurrent_items'] = 2
        def worker(config, item, jobs):
            if item == 'pause':
                service.rate_limit_pause({}, item)
                return 'rate-limit'
            time.sleep(0.1)
            (self.root / item).touch()
        names = ['pause', 'paid', 'never']
        with mock.patch.object(service, 'drain_item', side_effect=worker), mock.patch.object(service, 'blocked', return_value=False):
            service.drain_items(self.config, {n: [] for n in names}, names)
        self.assertFalse((self.root / 'never').exists())
        self.assertIsNotNone(service.paused())

    def test_fork_failure_reaps_admitted_worker_before_returning(self):
        self.config['repair']['max_concurrent_items'] = 2
        fork = os.fork
        calls = []
        def launch():
            calls.append(True)
            if len(calls) == 2:
                raise OSError('fixture fork failure')
            return fork()
        def worker(config, item, jobs):
            time.sleep(0.1)
            (self.root / 'finished').touch()
        with mock.patch.object(service.os, 'fork', side_effect=launch), mock.patch.object(service, 'drain_item', side_effect=worker), mock.patch.object(service, 'blocked', return_value=False):
            with self.assertRaisesRegex(OSError, 'fixture fork failure'):
                service.drain_items(self.config, {'a': [], 'b': []}, ['a', 'b'])
        self.assertTrue((self.root / 'finished').exists())

    def test_worker_crash_stops_further_admission_and_reaps_other_worker(self):
        self.config['repair']['max_concurrent_items'] = 2
        def worker(config, item, jobs):
            if item == 'crash':
                deadline = time.monotonic() + 2
                while not (self.root / 'paid-started').exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                os._exit(9)
            (self.root / 'paid-started').touch()
            time.sleep(0.1)
            (self.root / item).touch()
        names = ['crash', 'paid', 'never']
        with mock.patch.object(service, 'drain_item', side_effect=worker), mock.patch.object(service, 'blocked', return_value=False):
            service.drain_items(self.config, {n: [] for n in names}, names)
        self.assertTrue((self.root / 'paid').exists())
        self.assertFalse((self.root / 'never').exists())

    def test_interrupt_drains_admitted_children_without_new_admission(self):
        self.config['repair']['max_concurrent_items'] = 2
        reap = service.reap_item
        calls = []
        def interrupted(active):
            calls.append(True)
            if len(calls) == 1:
                raise KeyboardInterrupt()
            return reap(active)
        def worker(config, item, jobs):
            time.sleep(0.1)
            (self.root / item).touch()
        names = ['a', 'b', 'never']
        with mock.patch.object(service, 'reap_item', side_effect=interrupted), mock.patch.object(service, 'drain_item', side_effect=worker), mock.patch.object(service, 'blocked', return_value=False):
            with self.assertRaises(KeyboardInterrupt):
                service.drain_items(self.config, {n: [] for n in names}, names)
        self.assertTrue((self.root / 'a').exists())
        self.assertTrue((self.root / 'b').exists())
        self.assertFalse((self.root / 'never').exists())

    def test_fallback_observes_another_items_new_provider_cooldown(self):
        self.config['repair']['fallback_models'] = ['deepseek/deepseek-flash']
        calls = []
        def invoke(config, role, job, wt, directory, judge):
            calls.append(role['model'])
            # A different worker exhausts the fallback while this call is live.
            service.remember_provider_limit('deepseek', {'retry_after_ms': 60000})
            return {'stop': 'rate-limit', 'retry_after_ms': 60000}
        with mock.patch.object(service, 'provider_ready', return_value=True), mock.patch.object(service, '_dispatch', side_effect=invoke):
            report = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root / 'attempt')
        self.assertEqual(calls, [ROLES['fixer']['model']])
        self.assertEqual(report['stop'], 'rate-limit')

    def test_reap_aggregates_success_and_crash_before_replacement(self):
        active = {100: 'successful', 101: 'crashed'}
        with mock.patch.object(service.os, 'waitpid', side_effect=[(100, 0), (101, 9)]):
            self.assertTrue(service.reap_item(active))
        self.assertEqual(active, {})

    def test_admission_checks_exited_workers_even_below_capacity(self):
        self.config['repair']['max_concurrent_items'] = 10
        with mock.patch.object(service.os, 'fork', return_value=100), mock.patch.object(service.os, 'waitpid', return_value=(100, 9)), mock.patch.object(service, 'blocked', return_value=False):
            with mock.patch.object(service, 'drain_item') as work:
                service.drain_items(self.config, {'a': [], 'b': []}, ['a', 'b'])
        work.assert_not_called()

    def test_concurrency_config_refuses_invalid_limits(self):
        for limit in (True, 0, 11, 2.5, '10', None):
            self.config['repair']['max_concurrent_items'] = limit
            with self.assertRaisesRegex(ValueError, 'max_concurrent_items'):
                service.drain_items(self.config, {}, [])

    def test_concurrent_provider_updates_do_not_lose_other_provider(self):
        pids = []
        for provider in ('zai', 'deepseek'):
            pid = os.fork()
            if pid == 0:
                service.remember_provider_limit(provider, {'retry_after_ms': 60000})
                os._exit(0)
            pids.append(pid)
        for pid in pids:
            self.assertEqual(os.waitpid(pid, 0)[1], 0)
        self.assertEqual(set(service.provider_cooldowns()), {'zai', 'deepseek'})

    def test_harvest_writeback_maps_nonfixed_outcomes(self):
        c = SimpleNamespace(STATE=self.root / 'state', CONFIG=self.config, iso=lambda: 'now')
        job = {'job': 'job', 'canonical_finding_id': 'finding'}
        with mock.patch('backfill_runtime.settings', return_value={'durable_artifact_root': str(self.root / 'artifacts')}), mock.patch('finding_delivery.Inbox') as inbox:
            for verdict, judge, expected in [('STALE', None, 'needs-retriage'),
                    ('FAILED', None, 'needs-retriage'), ('NOT-FIXED', {'verdict': 'invalid'}, 'needs-retriage'),
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

    def test_source_failure_is_retained_without_aborting_reconciliation(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        record.update(fix_pr={'number': 99}, verdicts=[])
        c = SimpleNamespace(iso=lambda: 'now', git=lambda *args: self.tip,
                            is_ancestor=lambda *args: True,
                            pr_info=lambda n: {'state': 'MERGED', 'mergeCommit': {'oid': self.tip}})
        with mock.patch.object(repair_tick, 'publish_source_resolution', side_effect=RuntimeError('forge exhausted')):
            repair_tick.reconcile_fix_prs(c, self.queue)
        self.assertEqual(record['source_publication_error'], 'forge exhausted')
        self.assertNotIn('fix_merged', record)
        errors = repair_tick.digest(self.root, self.queue)['source_publication_errors']
        self.assertEqual(errors, [{'item': item['id'], 'run': 'run1', 'error': 'forge exhausted'}])
        with mock.patch.object(repair_tick, 'publish_source_resolution'):
            repair_tick.reconcile_fix_prs(c, self.queue)
        self.assertEqual(record['fix_merged'], 'now')
        self.assertNotIn('source_publication_error', record)

    def test_unverifiable_head_mismatch_cannot_mark_prepared_finding_fixed(self):
        record = self.queue['items'][0]['repair_runs']['run1']
        record.update(fix_pr={'number': 99}, publication={'head': self.pin})
        c = SimpleNamespace(pr_info=lambda n: {'state': 'MERGED', 'headRefOid': self.tip,
                                              'mergeCommit': {'oid': self.tip}},
                            git=lambda *args: self.tip, is_ancestor=lambda *args: True)
        with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark:
            repair_tick.reconcile_fix_prs(c, self.queue)
            mark.assert_not_called()
        self.assertNotIn('fix_merged', record)

    def test_review_descendant_requires_unchanged_repaired_source_blobs(self):
        def commit_files(base, files):
            self.git('checkout', '-q', '--detach', base)
            for name, text in files.items():
                path = self.clone / name
                if text is None:
                    path.unlink()
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text)
            self.git('add', '-A')
            self.git('commit', '-qm', 'review evidence fixture')
            return self.git('rev-parse', 'HEAD')
        test_path = 'test/scripts/fix.test.ts'
        base = commit_files(self.tip, {'src/helper.ts': 'old helper\n', test_path: 'old test\n',
                                      'settings.json': 'old config\n', 'docs/fix.md': 'old docs\n',
                                      'src/obsolete.ts': 'obsolete implementation\n'})
        published = commit_files(base, {'src/kept.ts': 'fixed implementation\n', 'src/helper.ts': 'fixed helper\n',
                                        test_path: 'new regression test\n', 'settings.json': 'fixed config\n',
                                        'docs/fix.md': 'fixed docs\n', 'src/added.ts': 'new helper\n', 'src/obsolete.ts': None})
        formatted = commit_files(published, {test_path: ' new regression test \n'})
        extra_file = commit_files(published, {'review-format.txt': 'format-only unrelated file\n'})
        reverted = commit_files(published, {'src/kept.ts': 'one\ntwo\n'})
        helper_reverted = commit_files(published, {'src/helper.ts': 'old helper\n'})
        other_changed = commit_files(published, {'src/moved.ts': 'changed second finding source\n'})
        config_changed = commit_files(published, {'settings.json': 'review config change\n'})
        docs_changed = commit_files(published, {'docs/fix.md': 'review docs change\n'})
        restored = commit_files(published, {'src/obsolete.ts': 'obsolete implementation\n'})
        removed_added = commit_files(published, {'src/added.ts': None})
        first_job = self.root / 'state/repair/inbox/crq-run1-F1.json'
        job = json.loads(first_job.read_text())
        job['canonical_finding_id'] = 'd' * 64
        item = self.queue['items'][0]
        jobs = ['crq-run1-F1', 'crq-run1-F2']
        publication = {'head': published, 'commits': [published]}
        journal = self.root / 'state/repair' / jobs[0] / 'publication.json'
        atomic(journal, publication)
        original = journal.read_bytes()
        c = SimpleNamespace(STATE=self.root / 'state', iso=lambda: 'now', git=self.git,
                            is_ancestor=lambda a, b: subprocess.run(
                                ['git', '-C', str(self.clone), 'merge-base', '--is-ancestor', a, b],
                                capture_output=True).returncode == 0)
        cases = [(formatted, True, 'src/kept.ts'), (extra_file, True, 'src/kept.ts')]
        cases += [(head, False, 'src/kept.ts') for head in
                  (reverted, helper_reverted, other_changed, config_changed, docs_changed, restored, removed_added, self.tip)]
        cases.append((formatted, False, test_path))  # A test-file anchor is never exempt.
        for actual, allowed, anchor in cases:
            with self.subTest(actual=actual, anchor=anchor):
                job['finding']['path'] = anchor
                atomic(first_job, job)
                self.git('update-ref', 'refs/remotes/origin/main', actual)
                record = {'jobs': jobs, 'fix_pr': {'number': 99}, 'publication': dict(publication),
                          'verdicts': [{'job': j, 'verdict': 'FIXED'} for j in jobs]}
                item['repair_runs'] = {'run1': record}
                c.pr_info = lambda n: {'state': 'MERGED', 'headRefOid': actual, 'mergeCommit': {'oid': actual}}
                with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark, \
                     mock.patch.object(repair_tick, 'publish_source_resolution') as source:
                    repair_tick.reconcile_fix_prs(c, self.queue)
                self.assertEqual(mark.call_count, 2 if allowed else 0)
                self.assertEqual(source.call_count, 1 if allowed else 0)
                self.assertEqual('fix_merged' in record, allowed)
                self.assertEqual(record['publication']['head'], published)
                self.assertEqual(journal.read_bytes(), original)
                if allowed:
                    proof = record['validated_merge_head']
                    expected = {'src/kept.ts', 'src/moved.ts', 'src/helper.ts', 'settings.json',
                                'docs/fix.md', 'src/added.ts', 'src/obsolete.ts'}
                    self.assertEqual((proof['published_head'], proof['actual_head'], proof['merge_commit']),
                                     (published, actual, actual))
                    self.assertEqual(set(proof['source_blobs']), expected)
                    self.assertEqual(proof['compared_paths'], sorted(expected))
                    self.assertEqual(proof['excluded_test_paths'], [test_path])
                    self.assertIsNone(proof['source_blobs']['src/obsolete.ts'])
                    self.assertEqual(proof['source_blobs']['src/helper.ts'], self.git('rev-parse', published + ':src/helper.ts'))
                else:
                    self.assertIn('source_publication_error', record)

    def test_descendant_without_published_commit_metadata_requires_revalidation(self):
        record = {'publication': {'head': self.pin}, 'verdicts': [{'job': 'crq-run1-F1', 'verdict': 'FIXED'}]}
        c = SimpleNamespace(is_ancestor=lambda *args: True)
        with self.assertRaisesRegex(ValueError, 'commits unavailable'):
            repair_tick.merge_head_evidence(c, record, self.tip)

    def test_exact_publication_head_retains_shortcut(self):
        c = SimpleNamespace(git=mock.Mock(), is_ancestor=mock.Mock())
        proof = repair_tick.merge_head_evidence(c, {'publication': {'head': self.tip}}, self.tip)
        self.assertEqual(proof['actual_head'], self.tip)
        c.git.assert_not_called()
        c.is_ancestor.assert_not_called()

    def test_fix_pr_provenance_includes_threadless_and_pr_sources(self):
        path = self.root / 'state/repair/inbox/crq-run1-F1.json'
        job = json.loads(path.read_text())
        job.update(canonical_finding_id='canonical-id', review_id='ledger-review-id', pr=0)
        atomic(path, job)
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo')
        body = '\n'.join(repair_tick.repair_provenance(c, self.queue['items'][0]['repair_runs']['run1'], 'run1'))
        for value in ('canonical-id', 'ledger-review-id', 'threadless', '/pull/1', 'crq-run1-F2', 'run1'):
            self.assertIn(value, body)

    def test_prepared_fix_pr_provenance_retains_original_cli_review_run(self):
        job_id = 'crq-run1-F1'
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        job.update(run='revalidated-current', source={'run': 'original-cli-review'})
        atomic(path, job)
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo')
        body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        self.assertIn('| `original-cli-review` |', body)
        self.assertNotIn('`revalidated-current`', body)
        job['review_id'] = 'ledger-event'
        atomic(path, job)
        body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        self.assertIn('| `ledger-event` |', body)
        self.assertNotIn('`original-cli-review`', body)

    def test_canonical_provenance_links_retained_review_at_its_recorded_date(self):
        import finding_delivery
        import review_ledger as ledger
        from test_review_ledger import review, rehash, SHA
        store = ledger.ArtifactStore(self.root / 'durable')
        finding = finding_delivery.normalize('crq-runner-app', 'source-run', {
            'severity': 'major', 'path': 'src/a.ts', 'blob': SHA, 'intervals': [[1, 1]],
            'title': 'Issue', 'body': 'Details'})
        value = review([store.put(b'retained source')], findings=[finding])
        value['occurred_at'] = '2023-12-07T10:00:00Z'
        rehash(value)
        outbox = ledger.Outbox(self.root / 'publication', store)
        outbox.spool(value)
        outbox.acknowledge(value, {value['id']})
        self.assertEqual(outbox.pending(), [])
        job_id = 'crq-run1-F1'
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        job.update(canonical_finding_id=finding['id'], review_id=value['id'], pr=0)
        atomic(path, job)
        c = SimpleNamespace(STATE=self.root / 'state', REPO=ledger.REPO)
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=SimpleNamespace(publication=outbox)):
            body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        expected = 'https://github.com/' + ledger.REPO + '/blob/cq/review-ledger/records/2023/12/' + value['id'] + '.json'
        self.assertIn(expected, body)
        self.assertIn(finding['id'], body)
        self.assertIn(value['id'], body)

    def test_missing_retained_review_uses_existing_local_locator(self):
        job_id = 'crq-run1-F1'
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        fid = 'd' * 64
        job.update(canonical_finding_id=fid, review_id='e' * 64, pr=0)
        atomic(path, job)
        row_path = self.root / 'state/backfill/findings/triage' / (fid + '.json')
        atomic(row_path, {'status': 'delivered'})
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo')
        inbox = SimpleNamespace(publication=SimpleNamespace(retained=lambda: []))
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        self.assertIn('state/backfill/findings/triage/' + fid + '.json', body)
        self.assertNotIn('/blob/cq/review-ledger/', body)
        row_path.unlink()
        with mock.patch.object(repair_tick, 'finding_inbox', side_effect=OSError('unavailable')):
            body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        self.assertIn('state/repair/inbox/' + job_id + '.json', body)
        self.assertNotIn('/blob/cq/review-ledger/', body)

    def test_threadless_cli_provenance_locates_existing_source_artifact(self):
        job_id = 'crq-run1-F1'
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        job.update(pr=0, run='revalidated-current', source={'run': 'original-run'})
        atomic(path, job)
        raw = self.root / 'state/runs/original-run/review.ndjson'
        raw.parent.mkdir(parents=True)
        raw.write_text('retained source')
        c = SimpleNamespace(STATE=self.root / 'state', REPO='example/repo')
        body = '\n'.join(repair_tick.repair_provenance(c, {'jobs': [job_id]}, 'repair-run'))
        self.assertIn('state/runs/original-run/review.ndjson', body)
        self.assertIn('| `original-run` |', body)
        self.assertNotIn('https://', body)

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

    def test_enqueue_preserves_explicit_source_ids_and_published_ordinal(self):
        rdir = self.root / 'runs/source'
        rdir.mkdir(parents=True)
        events = [{'type': 'finding', 'severity': 'minor', 'fileName': 'other', 'comment': 'minor'},
                  {'type': 'finding', 'severity': 'major', 'fileName': 'src/kept.ts', 'comment': 'major',
                   'id': 'vendor-id', 'source_id': 'source-id', 'review_id': 'review-id', 'thread_id': 'thread-node'}]
        (rdir / 'review.ndjson').write_text('\n'.join(json.dumps(e) for e in events))
        c = SimpleNamespace(REPO='o/r', item_repo=lambda item: 'o/r', CONFIG=self.config,
                            STATE=self.root / 'state', git=lambda *a, **k: '' if a[0] == 'rev-list' else self.tip)
        item = {'id': 'pr9', 'pr': 9, 'kind': 'merged', 'state': 'reviewing'}
        meta = {'run_id': 'source-run', 'base': self.pin, 'head': self.tip}
        self.assertTrue(repair_tick.enqueue(c, {'items': []}, item, meta, rdir))
        job = json.loads((self.root / 'state/repair/inbox/crq-source-run-F1.json').read_text())
        self.assertEqual(job['source'], {'id': 'vendor-id', 'source_id': 'source-id',
                                         'review_id': 'review-id', 'thread_id': 'thread-node', 'finding_number': 2, 'run': 'source-run'})
        self.assertNotIn('_source', job['finding'])
        self.assertEqual(repair_tick.source_thread(c, job), 'thread-node')
        job.pop('source')
        job_path = self.root / 'state/repair/inbox/crq-source-run-F1.json'
        atomic(job_path, job)
        self.assertTrue(repair_tick.enqueue(c, {'items': []}, item, meta, rdir))
        self.assertEqual(json.loads(job_path.read_text())['source']['thread_id'], 'thread-node')

    def test_source_thread_lookup_pages_and_refuses_ambiguous_matches(self):
        job = {'pr': 9, 'run': 'run1', 'finding': {'path': 'src/kept.ts'}, 'source': {'finding_number': 2}}
        def page(threads):
            return {'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': threads}}}}}
        def thread(tid, run='run1', path='src/kept.ts'):
            return {'id': tid, 'comments': {'nodes': [{'path': path,
                    'body': '**crq finding F2 [major]** issue\n<sub>crq run `' + run + '`, line 1</sub>'}]}}
        c = SimpleNamespace(REPO='o/r', gh_json=mock.Mock(return_value=[page([thread('wrong', run='run2')]), page([thread('right')])]))
        self.assertEqual(repair_tick.source_thread(c, job), 'right')
        revalidated = {**job, 'run': 'new-run', 'source': {**job['source'], 'run': 'run1'}}
        self.assertEqual(repair_tick.source_thread(c, revalidated), 'right')
        self.assertIn('--paginate', c.gh_json.call_args.args[0])
        c.gh_json.return_value = [page([thread('right'), thread('duplicate')])]
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            repair_tick.source_thread(c, job)
        c.gh_json.return_value = [page([])]
        self.assertIsNone(repair_tick.source_thread(c, job))
        self.assertIsNone(repair_tick.source_thread(c, {**job, 'pr': 0}))

    def test_same_pr_publication_reconciles_only_after_validated_merge(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        job_id = record['jobs'][0]
        record['verdicts'] = [{'job': job_id, 'verdict': 'FIXED'}]
        publication = {'open_pr': True, 'head': self.tip, 'branch': 'branch', 'commits': [self.tip]}
        c = SimpleNamespace(STATE=self.root / 'state', REPO='o/r', save_queue=lambda q: None,
                            iso=lambda: 'now', git=lambda *args: self.tip, is_ancestor=lambda *args: True,
                            pr_info=mock.Mock(return_value={'state': 'OPEN'}))
        repair_tick.finalize_publication(c, self.queue, item, 'run1', record, publication)
        self.assertEqual(record['fix_pr']['number'], item['pr'])
        with mock.patch.object(repair_tick, 'mark_finding_outcome') as mark, mock.patch.object(repair_tick, 'publish_source_resolution'):
            repair_tick.reconcile_fix_prs(c, self.queue)
            mark.assert_not_called()
            c.pr_info.return_value = {'state': 'MERGED', 'headRefOid': self.tip, 'mergeCommit': {'oid': self.tip}}
            repair_tick.reconcile_fix_prs(c, self.queue)
            self.assertEqual(mark.call_args.args[3], self.tip)

    def test_obsolete_generation_cannot_harvest_or_publish(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        job_id = record['jobs'][0]
        job_path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(job_path.read_text())
        job['canonical_finding_id'] = 'd' * 64
        atomic(job_path, job)
        atomic(self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json'),
               {'status': 'delivered', 'receipt': {'repair_task': 'newer-generation'}})
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': item['id'], 'verdict': 'FIXED'})
        with mock.patch.object(repair_tick, 'publish') as publish:
            repair_tick.harvest(SimpleNamespace(STATE=self.root / 'state'), self.queue, item)
            publish.assert_not_called()
        self.assertEqual(record['state'], 'stale')
        self.assertEqual(item['state'], 'done')

    def test_dispatch_rechecks_canonical_state_between_jobs(self):
        self.worktree()
        jobs = [json.loads((self.root / 'state/repair/inbox' / (j + '.json')).read_text())
                for j in ('crq-run1-F1', 'crq-run1-F2')]
        fid = 'd' * 64
        jobs[1]['canonical_finding_id'] = fid
        row_path = self.root / 'state/backfill/findings/triage' / (fid + '.json')
        row = {'status': 'delivered', 'receipt': {'repair_task': jobs[1]['job']}}
        atomic(row_path, row)
        def process(*args):
            atomic(row_path, {**row, 'status': 'dismissed'})
            return {'verdict': 'NOT-FIXED'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch_paused', return_value=None), \
             mock.patch.object(service, 'process', side_effect=process) as model:
            service.process_item(self.config, jobs)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(model.call_args.args[1]['job'], 'crq-run1-F1')
        with mock.patch.object(service, 'source_snapshot') as snapshot, mock.patch.object(service.cq, 'invoke') as provider:
            with self.assertRaisesRegex(ValueError, 'canonical'):
                service._dispatch(self.config, {'driver': 'cq'}, jobs[1], self.root,
                                  self.root / 'dispatch', judge=False)
            snapshot.assert_not_called()
            provider.assert_not_called()

    def test_recovery_job_uses_separate_worktree_and_preserves_original(self):
        original = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (original / 'src/kept.ts').write_text('retained staged edit\n')
        subprocess.run(['git', 'add', 'src/kept.ts'], cwd=original, check=True)
        job = json.loads(bounded.job_path(self.root, 'crq-run1-F1').read_text())
        job['recovery_worktree'] = True
        job['job'] = 'crq-recovery-F1'
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch_paused', return_value=None), \
             mock.patch.object(service, 'process', return_value={'verdict': 'NOT-FIXED'}) as process:
            service.process_item(self.config, [job])
        self.assertEqual(process.call_args.args[2].name, 'crq-repair-pr1-merged-crq-recovery-F1')
        self.assertEqual((original / 'src/kept.ts').read_text(), 'retained staged edit\n')
        self.assertIn('src/kept.ts', subprocess.run(['git', 'diff', '--cached', '--name-only'], cwd=original,
                                                    check=True, capture_output=True, text=True).stdout)

    def test_sibling_failure_cannot_contaminate_next_finding(self):
        jobs = [json.loads(bounded.job_path(self.root, name).read_text())
                for name in ('crq-run1-F1', 'crq-run1-F2')]
        seen = []
        def process(config, job, wt):
            seen.append(wt)
            if len(seen) == 1:
                (wt / 'src/kept.ts').write_text('first finding partial\n')
                return {'verdict': 'FAILED'}
            self.assertEqual((wt / 'src/kept.ts').read_text(), 'one\ntwo\n')
            return {'verdict': 'NOT-FIXED'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch_paused', return_value=None), \
             mock.patch.object(service, 'process', side_effect=process):
            service.process_item(self.config, jobs)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1])
        self.assertEqual((seen[0] / 'src/kept.ts').read_text(), 'first finding partial\n')

    def test_edited_failed_attempt_is_archived_before_next_rung(self):
        job = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')[1]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        def dispatch(config, role, current, tree, directory, judge=False):
            if directory.name == 'A0':
                (tree / 'src/kept.ts').write_text('staged partial\n')
                subprocess.run(['git', 'add', 'src/kept.ts'], cwd=tree, check=True)
                (tree / 'new-file').write_text('untracked partial')
                return {'stop': 'error', 'summary': 'no_outcome'}
            self.assertEqual((tree / 'src/kept.ts').read_text(), 'one\ntwo\n')
            self.assertFalse((tree / 'new-file').exists())
            if directory.name == 'A1':
                (tree / 'src/kept.ts').write_text('second staged partial\n')
                subprocess.run(['git', 'add', 'src/kept.ts'], cwd=tree, check=True)
                return {'stop': 'error', 'summary': 'no_outcome again'}
            self.assertTrue(tree.name.endswith('-A2'))
            return {'stop': 'ok', 'changed': False, 'summary': 'no change'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', side_effect=dispatch):
            result = service.process(self.config, job, wt)
        self.assertEqual(result['verdict'], 'NOT-FIXED')
        paths = list((self.root / 'state/repair' / job['job'] / 'A0').glob('retained-*/manifest.json'))
        self.assertEqual(len(paths), 1)
        self.assertIn('+staged partial', (paths[0].parent / 'staged.patch').read_text())
        import tarfile
        with tarfile.open(paths[0].parent / 'untracked.tar') as tar:
            self.assertEqual(tar.extractfile('new-file').read(), b'untracked partial')
        second = list((self.root / 'state/repair' / job['job'] / 'A1').glob('retained-*/manifest.json'))
        self.assertEqual(len(second), 1)
        self.assertIn('+second staged partial', (second[0].parent / 'staged.patch').read_text())

    def test_explicit_fixer_owner_decision_is_preserved(self):
        job = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')[1]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        report = {'stop': 'error', 'worker_disposition': 'needs_human',
                  'summary': 'A disruptive architecture choice is required'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', return_value=report):
            result = service.process(self.config, job, wt)
        self.assertEqual(result['failure_class'], 'owner-decision')
        self.assertEqual(result['verdict'], 'FAILED')
        self.assertNotIn('dispatch_pending', result)

    def test_stops_are_classified_without_inference_from_protected_path(self):
        job = {'repair_base': self.tip, 'finding': {'path': 'policy/protected-paths.json'}}
        for stop in ('rate-limit', 'configuration'):
            self.assertEqual(service.failure_class_for_stop(self.config, job, {'stop': stop}), 'transient')
        for stop in ('error', 'budget'):
            self.assertEqual(service.failure_class_for_stop(self.config, job, {'stop': stop}), 'exhausted')

    def test_failed_retention_never_resets_the_worktree(self):
        job = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')[1]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (wt / 'src/kept.ts').write_text('do not lose\n')
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'retain', side_effect=OSError('disk full')), \
             mock.patch.object(service, 'dispatch') as dispatch:
            result = service.process(self.config, job, wt)
        self.assertEqual(result['verdict'], 'FAILED')
        self.assertIn('retention failed', result['reason'])
        self.assertEqual((wt / 'src/kept.ts').read_text(), 'do not lose\n')
        dispatch.assert_not_called()

    def test_interrupted_retention_failure_is_visible_and_sibling_runs(self):
        jobs = [bounded.drain_job(self.root, self.config, self.queue, name)[1]
                for name in ('crq-run1-F1', 'crq-run1-F2')]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (wt / 'src/kept.ts').write_text('preserve interrupted work\n')
        atomic(self.root / 'state/repair/crq-run1-F1/progress.json', {
            **jobs[0], 'worktree': str(wt), 'verdict': 'FAILED', 'attempts': [],
            'dispatch_pending': {'rung': 'A0'}})
        real_process = service.process
        def run(config, job, tree):
            if job['job'] == 'crq-run1-F1':
                return real_process(config, job, tree)
            return {'verdict': 'NOT-FIXED'}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch_paused', return_value=None), \
             mock.patch.object(service, 'retain', side_effect=OSError('disk full')), \
             mock.patch.object(service, 'process', side_effect=run) as process, \
             mock.patch.object(service, 'dispatch') as dispatch:
            service.process_item(self.config, jobs)
        result = json.loads((self.root / 'state/repair/crq-run1-F1/result.json').read_text())
        self.assertIn('retention failed: disk full', result['reason'])
        self.assertEqual(process.call_count, 2)
        self.assertEqual((wt / 'src/kept.ts').read_text(), 'preserve interrupted work\n')
        dispatch.assert_not_called()

    def test_cleanup_requires_clean_owned_archived_terminal_tree(self):
        from crq_repair.retain import cleanup_harvested, retain
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (wt / 'src/kept.ts').write_text('committed fix\n')
        subprocess.run(['git', 'commit', '-qam', 'fix'], cwd=wt, check=True)
        directory = self.root / 'state/repair/crq-run1-F1'
        result = {'verdict': 'FIXED', 'repair_base': self.pin, 'worktree': str(wt)}
        args = (self.clone, self.root / 'wt', directory, 'pr1-merged', 'crq-run1-F1', result)
        self.assertFalse(cleanup_harvested(*args))
        retain(wt, self.pin, directory / 'final')
        (wt / 'untracked').write_text('keep')
        self.assertFalse(cleanup_harvested(*args))
        (wt / 'untracked').unlink()
        self.assertFalse(cleanup_harvested(self.clone, self.root / 'wt', directory,
                                           'pr1-merged', 'crq-run1-F2', result))
        alternate = self.worktree('crq-repair-pr1-merged-crq-run1-F1-A2')
        (alternate / 'src/moved.ts').write_text('another committed fix\n')
        subprocess.run(['git', 'commit', '-qam', 'other fix'], cwd=alternate, check=True)
        retain(alternate, self.pin, directory / 'A2')
        self.assertTrue(cleanup_harvested(*args, alternate=True))
        self.assertFalse(alternate.exists())
        self.assertTrue(cleanup_harvested(*args))
        self.assertFalse(cleanup_harvested(*args))

    def test_harvest_cleans_only_after_terminal_record_is_present(self):
        from crq_repair.retain import retain
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (wt / 'src/kept.ts').write_text('finished fix\n')
        subprocess.run(['git', 'commit', '-qam', 'fix'], cwd=wt, check=True)
        directory = self.root / 'state/repair/crq-run1-F1'
        retain(wt, self.pin, directory / 'final')
        result = {'job': 'crq-run1-F1', 'verdict': 'FIXED', 'repair_base': self.pin, 'worktree': str(wt)}
        item = self.queue['items'][0]
        item['repair_runs']['run1'].update(state='done', verdicts=[result])
        c = SimpleNamespace(STATE=self.root / 'state', WT_ROOT=self.root / 'wt', CLONE=self.clone)
        repair_tick.harvest(c, self.queue, item, dry=True)
        self.assertTrue(wt.exists())
        repair_tick.harvest(c, self.queue, item)
        self.assertFalse(wt.exists())

    def test_unchanged_contract_verifies_and_preserves_source_evidence(self):
        (self.clone / 'src/kept.ts').write_text('\n  one\n\n')
        self.git('commit', '-qam', 'leading blank lines')
        self.pin = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', self.pin + ':refs/heads/main')
        self.git('fetch', '-q', 'origin')
        self.queue['items'][0]['repair_runs']['run1']['base'] = self.pin
        job_id = 'crq-run1-F1'
        self.job(job_id, 'pr1-merged', 'run1', 'src/kept.ts')
        job = bounded.drain_job(self.root, self.config, self.queue, job_id)[1]
        wt = self.worktree('crq-repair-pr1-merged-' + job_id)
        report = {'stop': 'ok', 'changed': False, 'disposition': 'unchanged_with_reason',
                  'summary': 'No defect in pinned code', 'evidence': [{'path': 'src/kept.ts', 'line': 2}]}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', return_value=report) as dispatch:
            result = service.process(self.config, job, wt)
        self.assertEqual(result['verdict'], 'NOT-FIXED')
        self.assertEqual(result['unchanged_evidence'][0]['target'], self.pin)
        self.assertEqual(result['unchanged_evidence'][0]['quoted_text'], '  one')
        dispatch.assert_called_once()

    def test_unchanged_critical_keeps_required_judge_and_unresolved_defect(self):
        job_id = 'crq-run1-F1'
        self.job(job_id, 'pr1-merged', 'run1', 'src/kept.ts', severity='critical')
        job = bounded.drain_job(self.root, self.config, self.queue, job_id)[1]
        wt = self.worktree('crq-repair-pr1-merged-' + job_id)
        report = {'stop': 'ok', 'changed': False, 'disposition': 'unchanged_with_reason',
                  'summary': 'No defect', 'evidence': [{'path': 'src/kept.ts', 'line': 1}]}
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', side_effect=[report,
                 {'stop': 'ok', 'verdict': 'valid', 'reason': 'still a defect'}, report]) as dispatch:
            result = service.process(self.config, job, wt)
        self.assertEqual(result['verdict'], 'FAILED')
        self.assertEqual(dispatch.call_count, 3)
        self.assertTrue(dispatch.call_args_list[1].kwargs['judge'])

    def test_evidence_short_judge_rationale_reaches_a2(self):
        job_id = 'crq-run1-F1'
        self.job(job_id, 'pr1-merged', 'run1', 'src/kept.ts', severity='critical')
        job = bounded.drain_job(self.root, self.config, self.queue, job_id)[1]
        wt = self.worktree('crq-repair-pr1-merged-' + job_id)
        report = {'stop': 'ok', 'changed': False, 'disposition': 'unchanged_with_reason',
                  'summary': 'No defect', 'evidence': [{'path': 'src/kept.ts', 'line': 1}]}
        reason = 'missing source evidence for the consumer'
        observed = []
        def dispatch(*args, **kwargs):
            observed.append(args[2]['mechanical_evidence'])
            return {'stop': 'ok', 'verdict': 'unsure', 'reason': reason} if kwargs.get('judge') else report
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', side_effect=dispatch):
            service.process(self.config, job, wt)
        self.assertEqual(observed, ['', '', reason])

    def test_unchanged_evidence_projects_to_dismissed(self):
        c = SimpleNamespace(CONFIG=self.config, iso=lambda: 'now')
        evidence = [{'path': 'src/kept.ts', 'line': 1, 'target': self.pin, 'quoted_text': 'one'}]
        with mock.patch.object(repair_tick, 'finding_inbox') as inbox:
            repair_tick.mark_finding_outcome(c, {'job': 'j', 'canonical_finding_id': 'f'},
                {'verdict': 'NOT-FIXED', 'reason': 'No defect', 'unchanged_evidence': evidence})
        call = inbox.return_value.repair_outcome.call_args
        self.assertEqual(call.args[2], 'dismissed')
        self.assertEqual(call.kwargs['source_evidence'], evidence)

    def test_process_captures_terminal_tree_for_later_harvest_cleanup(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        c = SimpleNamespace(STATE=self.root / 'state', WT_ROOT=self.root / 'wt', CLONE=self.clone,
                            ROOT=ROOT, CONFIG=self.config,
                            make_worktree=lambda name, sha: (self.root, 'verify'),
                            remove_worktree=lambda wt, branch: None)
        for job_id, changed in (('crq-run1-F1', True), ('crq-run1-F2', False)):
            with self.subTest(verdict='FIXED' if changed else 'NOT-FIXED'):
                record.update(jobs=[job_id], state='queued', base=self.pin)
                self.job(job_id, 'pr1-merged', 'run1', 'src/kept.ts')
                job = bounded.drain_job(self.root, self.config, self.queue, job_id)[1]
                wt = self.worktree('crq-repair-pr1-merged-' + job_id)
                def dispatch(config, role, current, tree, directory, judge=False):
                    if not changed:
                        return {'stop': 'ok', 'changed': False, 'summary': 'not a defect'}
                    (tree / 'src/kept.ts').write_text('fixed\n')
                    subprocess.run(['git', 'commit', '-qam', job_id], cwd=tree, check=True)
                    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=tree, check=True,
                                         capture_output=True, text=True).stdout.strip()
                    return {'stop': 'ok', 'changed': True, 'commits': [sha]}
                with mock.patch.object(service, 'blocked', return_value=False), \
                     mock.patch.object(service, 'dispatch', side_effect=dispatch), \
                     mock.patch.object(service, 'mechanical', return_value={}):
                    result = service.process(self.config, job, wt)
                self.assertEqual(result['verdict'], 'FIXED' if changed else 'NOT-FIXED')
                self.assertTrue(list((self.root / 'state/repair' / job_id / 'final').glob('retained-*/manifest.json')))
                fake_module = SimpleNamespace(mechanical=lambda *args: None)
                fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
                with mock.patch.object(repair_tick, 'mark_finding_outcome'), \
                     mock.patch.object(repair_tick, 'verify'), \
                     mock.patch.object(repair_tick, 'publish', side_effect=lambda c, q, i, r, rec, f: rec.update(state='published')), \
                     mock.patch('importlib.util.spec_from_file_location', return_value=fake_spec), \
                     mock.patch('importlib.util.module_from_spec', return_value=fake_module):
                    repair_tick.harvest(c, self.queue, item)
                self.assertTrue(wt.exists())
                repair_tick.harvest(c, self.queue, item)
                self.assertFalse(wt.exists())

    def test_terminal_archive_failure_keeps_tree_and_reports_failure(self):
        from crq_repair.retain import retain
        job = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')[1]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        def capture(tree, base, directory, **kwargs):
            if kwargs.get('include_clean'):
                raise OSError('archive disk full')
            return retain(tree, base, directory, **kwargs)
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', return_value={'stop': 'ok', 'changed': False}), \
             mock.patch.object(service, 'retain', side_effect=capture):
            result = service.process(self.config, job, wt)
        self.assertEqual(result['verdict'], 'FAILED')
        self.assertIn('archive disk full', result['reason'])
        self.assertTrue(wt.exists())

    def test_resumed_legacy_result_records_the_actual_job_worktree(self):
        job = bounded.drain_job(self.root, self.config, self.queue, 'crq-run1-F1')[1]
        wt = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        atomic(self.root / 'state/repair' / job['job'] / 'result.json',
               {'job': job['job'], 'item': job['item'], 'repair_base': self.pin,
                'worktree': str(self.root / 'wt/crq-repair-pr1-merged'), 'verdict': 'FAILED',
                'attempts': [], 'judge': None, 'retry_after': '2000-01-01T00:00:00Z'})
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch', return_value={'stop': 'ok', 'changed': False, 'summary': 'no change'}):
            result = service.process(self.config, job, wt)
        self.assertEqual(result['worktree'], str(wt))

    def test_recovery_does_not_override_an_owner_disposition(self):
        import sys
        job_id = 'crq-run1-F1'
        path = bounded.job_path(self.root, job_id)
        job = json.loads(path.read_text())
        job['canonical_finding_id'] = 'd' * 64
        atomic(path, job)
        atomic(self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json'),
               {'status': 'needs-human', 'previous_event_id': 'event', 'receipt': {'repair_task': job_id}})
        c = SimpleNamespace(load_queue=lambda: self.queue, ran_locked=lambda fn: (fn(), True)[1])
        inbox = mock.Mock()
        inbox.publication.retained.return_value = [{'id': 'event', 'payload': {
            'actor': 'operator', 'finding_id': 'd' * 64, 'evidence': {'repair_task': job_id}}}]
        with mock.patch.dict(sys.modules, {'crq': c}), mock.patch.object(repair_tick, 'finding_inbox', return_value=inbox):
            with self.assertRaisesRegex(ValueError, 'owner decision'):
                service.recover_job(self.config, job_id)

    def test_recovery_prepares_and_dispatches_separate_job_without_resetting_old_tree(self):
        import sys
        job_id = 'crq-run1-F1'
        job = json.loads(bounded.job_path(self.root, job_id).read_text())
        original = self.worktree('crq-repair-pr1-merged-crq-run1-F1')
        (original / 'src/kept.ts').write_text('unfinished staged work\n')
        subprocess.run(['git', 'add', 'src/kept.ts'], cwd=original, check=True)
        atomic(self.root / 'state/repair' / job_id / 'result.json',
               {'job': job_id, 'item': job['item'], 'repair_base': self.pin,
                'worktree': str(original), 'verdict': 'FAILED', 'reason': 'driver no_outcome'})
        self.config['repair']['max_rounds_per_pin'] = 10
        c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state', CLONE=self.clone,
                            CONFIG=self.config, iso=lambda: 'now', load_queue=lambda: self.queue,
                            ran_locked=lambda fn: (fn(), True)[1],
                            run=lambda args, **kw: subprocess.run(args, **kw, capture_output=True, text=True, check=True),
                            secret_scan_diff=mock.Mock(return_value=(True, {})),
                            save_queue=lambda q: atomic(self.root / 'state/queue.json', q))
        report = {'stop': 'ok', 'verdict': 'valid', 'reason': 'current source confirms bug',
                  'current_path': 'src/kept.ts', 'current_lines': [[1, 1]], 'quoted_text': 'one'}
        with mock.patch.dict(sys.modules, {'crq': c}), \
             mock.patch.object(service, 'dispatch', return_value=report) as judge:
            first = service.recover_job(self.config, job_id)
            second = service.recover_job(self.config, job_id)
        self.assertEqual(first, second)
        judge.assert_called_once()
        original_run = self.queue['items'][0]['repair_runs']['run1']
        self.assertEqual(original_run['state'], 'queued')
        self.assertIn('crq-run1-F2', original_run['jobs'])
        replacement = json.loads(bounded.job_path(self.root, first['replacement_job']).read_text())
        self.assertTrue(replacement['recovery_worktree'])
        self.assertEqual(replacement['origin_job'], job_id)
        with mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'dispatch_paused', return_value=None), \
             mock.patch.object(service, 'process', return_value={'verdict': 'NOT-FIXED'}) as fixer:
            service.process_item(self.config, [replacement])
        self.assertNotEqual(fixer.call_args.args[2], original)
        self.assertEqual((original / 'src/kept.ts').read_text(), 'unfinished staged work\n')
        self.assertIn('src/kept.ts', subprocess.run(['git', 'diff', '--cached', '--name-only'], cwd=original,
                                                    check=True, capture_output=True, text=True).stdout)

    def test_operator_disposition_prevents_publication_of_finished_job(self):
        item = self.queue['items'][0]
        record = item['repair_runs']['run1']
        job_id = record['jobs'][0]
        path = self.root / 'state/repair/inbox' / (job_id + '.json')
        job = json.loads(path.read_text())
        job['canonical_finding_id'] = 'd' * 64
        atomic(path, job)
        atomic(self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json'),
               {'status': 'superseded', 'receipt': {'repair_task': job_id}})
        result = self.root / 'state/repair' / job_id / 'result.json'
        atomic(result, {'job': job_id, 'item': item['id'], 'verdict': 'FIXED', 'audit': 'retained'})
        before = result.read_bytes()
        with mock.patch.object(repair_tick, 'publish') as publish:
            repair_tick.harvest(SimpleNamespace(STATE=self.root / 'state'), self.queue, item)
            publish.assert_not_called()
        self.assertEqual(record['state'], 'stale')
        self.assertEqual(result.read_bytes(), before)

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

    def test_only_canonical_minors_are_drainable(self):
        path = bounded.job_path(self.root, 'crq-run1-F1')
        job = json.loads(path.read_text())
        atomic(self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json'),
               {'status': 'delivered', 'receipt': {'repair_task': job['job']}})
        for severity, canonical, expected in (
                ('minor', None, 'skip'), ('minor', '', 'skip'),
                ('minor', '  ', 'skip'), ('minor', 123, 'skip'),
                ('minor', 'canonical-1', 'skip'), ('minor', 'd' * 64, 'run'), ('info', 'd' * 64, 'skip')):
            with self.subTest(severity=severity, canonical=canonical):
                job['finding']['severity'] = severity
                job['canonical_finding_id'] = canonical
                atomic(path, job)
                self.assertEqual(bounded.drain_job(
                    self.root, self.config, self.queue, job['job'])[0], expected)
        job['finding']['severity'] = 'minor'
        job['canonical_finding_id'] = 'd' * 64
        job['finding']['path'] = 'src/moved.ts'
        atomic(path, job)
        self.assertEqual(bounded.drain_job(
            self.root, self.config, self.queue, job['job'])[0], 'stale')

    def test_drain_prioritizes_major_items_over_older_canonical_minors(self):
        job_id = 'crq-backfill-minor'
        item_id = 'backfill-finding-minor'
        self.queue['items'].append(self.item(item_id, 'backfill-minor', [job_id], False))
        self.job(job_id, item_id, 'backfill-minor', 'src/kept.ts', severity='minor')
        path = bounded.job_path(self.root, job_id)
        job = json.loads(path.read_text())
        job['canonical_finding_id'] = 'd' * 64
        atomic(self.root / 'state/backfill/findings/triage' / ('d' * 64 + '.json'),
               {'status': 'delivered', 'receipt': {'repair_task': job_id}})
        atomic(path, job)
        atomic(self.root / 'state/queue.json', self.queue)
        with mock.patch.object(service, 'drain_order', return_value=[job_id, 'crq-run1-F1']), \
             mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        self.assertEqual([call.args[1][0]['job'] for call in process_item.call_args_list],
                         ['crq-run1-F1', job_id])
        jobs = [job, {'job': 'crq-run1-F1', 'run': 'run1', 'finding': {'severity': 'major'}},
                {'job': 'crq-run2-F1', 'run': 'run2', 'finding': {'severity': 'critical'}}]
        self.assertEqual([j['job'] for j in sorted(jobs, key=service.finding_order)],
                         ['crq-run1-F1', 'crq-run2-F1', job_id])
        same_class = [{'job': 'crq-z-F2', 'run': 'z', 'finding': {'severity': 'major'}},
                      {'job': 'crq-a-F2', 'run': 'a', 'finding': {'severity': 'critical'}},
                      {'job': 'crq-a-F1', 'run': 'a', 'finding': {'severity': 'major'}}]
        self.assertEqual([j['job'] for j in sorted(same_class, key=service.finding_order)],
                         ['crq-a-F1', 'crq-a-F2', 'crq-z-F2'])

    def test_priority_uses_eligible_jobs_and_preserves_item_order(self):
        specs = [('minor-a', 'minor'), ('major-a', 'major'),
                 ('minor-b', 'minor'), ('major-b', 'critical')]
        for name, severity in specs:
            job_id, item_id = 'crq-' + name, 'item-' + name
            self.queue['items'].append(self.item(item_id, name, [job_id], False))
            self.job(job_id, item_id, name, 'src/kept.ts', severity=severity)
            if severity == 'minor':
                path = bounded.job_path(self.root, job_id)
                job = json.loads(path.read_text())
                fid = ('a' if name == 'minor-a' else 'b') * 64
                job['canonical_finding_id'] = fid
                atomic(path, job)
                atomic(self.root / 'state/backfill/findings/triage' / (fid + '.json'),
                       {'status': 'delivered', 'receipt': {'repair_task': job_id}})
        # This older major belongs to the minor item but is not queued.
        self.job('crq-ineligible', 'item-minor-a', 'minor-a', 'src/kept.ts')
        atomic(self.root / 'state/queue.json', self.queue)
        order = ['crq-ineligible', 'crq-minor-a', 'crq-major-a', 'crq-minor-b', 'crq-major-b']
        with mock.patch.object(service, 'drain_order', return_value=order), \
             mock.patch.object(service, 'blocked', return_value=False), \
             mock.patch.object(service, 'process_item') as process_item:
            service.drain(self.config)
        self.assertEqual([call.args[1][0]['job'] for call in process_item.call_args_list],
                         ['crq-major-a', 'crq-major-b', 'crq-minor-a', 'crq-minor-b'])

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

    def test_fallback_archives_throttled_fixers_partial_commits_and_files(self):
        self.config['repair']['fallback_models'] = ['deepseek/deepseek-flash']
        original = self.git('rev-parse', 'HEAD')
        def invoke(config, role, job, wt, directory, judge):
            if role['model'].startswith('zai/'):
                (wt / 'src/kept.ts').write_text('partial edit')
                self.git('commit', '-qam', 'partial fixer commit')
                (wt / 'partial-untracked').write_text('partial file')
                return {'stop': 'rate-limit'}
            self.assertEqual(self.git('rev-parse', 'HEAD'), original)
            self.assertFalse((wt / 'partial-untracked').exists())
            return {'stop': 'ok', 'changed': False}
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': 'fixture', 'DEEPSEEK_API_KEY': 'fixture'}), \
             mock.patch.object(service, '_dispatch', side_effect=invoke):
            result = service.dispatch(self.config, ROLES['fixer'], {'run': 'r', 'job': 'j'}, self.clone, self.root)
        self.assertEqual(result['model'], 'deepseek/deepseek-flash')
        archives = list((self.root / 'zai').glob('retained-*/manifest.json'))
        self.assertEqual(len(archives), 1)
        manifest = json.loads(archives[0].read_text())
        self.assertTrue(manifest['commits'])
        self.assertIn('+partial edit', (archives[0].parent / 'committed.patch').read_text())
        listed = subprocess.run(['git', 'bundle', 'list-heads', str(archives[0].parent / 'commits.bundle')],
                                cwd=self.clone, check=True, capture_output=True, text=True).stdout
        self.assertIn(manifest['head'], listed)
        import tarfile
        with tarfile.open(archives[0].parent / 'untracked.tar') as tar:
            self.assertEqual(tar.extractfile('partial-untracked').read(), b'partial file')

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
               'source_snapshot': {'source_sha': 'a' * 40, 'source_blob_sha': 'b' * 40,
                                   'finding_sha256': 'c' * 64, 'path': 'src/kept.ts',
                                   'line_start': 1, 'line_end': 1, 'source': '1: x', 'incomplete': False}}
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


class CanonicalFixedProjectionTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.f = Fixture(self.root / 'repo')
        self.published = self.f.commit({'a': b'original repair\n'})
        self.actual = self.f.commit({'a': b'reviewed implementation correction\n'})
        self.merge = self.f.commit({'merged': b'merge evidence\n'})
        self.unrelated = self.f.git('commit-tree', self.f.repo.tree(self.published), '-m', 'unrelated root')
        self.f.git('update-ref', 'refs/remotes/origin/main', self.merge)
        self.review = self.f.full_review(self.published, 'a', [[1, 1]])
        finding = finding_delivery.normalize('crq-runner-app', 'projection', {
            'severity': 'major', 'path': 'a', 'blob': self.f.repo.entries(self.published)['a']['blob'],
            'intervals': [[1, 1]], 'title': 'Repair', 'body': 'Original finding'})
        self.review['payload']['findings'] = [finding]
        rehash(self.review)
        self.fid = finding['id']
        self.out = ledger.Outbox(self.root / 'outbox', self.f.store)
        self.out.spool(self.review)
        self.inbox = finding_delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.review)
        self.at = '2026-11-09T00:00:00Z'
        confirmed = self.inbox.triage(self.fid, self.f.repo, self.published,
                                      'confirmed', 'fixture', 'valid source', self.at)
        self.queue = {'items': []}
        transport = finding_delivery.repair_transport(self.root, self.queue, lambda _: None, lambda *_: True, scan_finding=lambda *_: True)
        receipt = self.inbox.deliver(self.fid, transport, self.at)
        self.job_id = receipt['repair_task']
        self.record = next(iter(self.queue['items'][0]['repair_runs'].values()))
        self.publication = {'head': self.published, 'commits': [self.published]}
        self.record.update(state='published', publication=copy.deepcopy(self.publication),
                           fix_pr={'number': 99, 'url': 'https://github.com/example/repo/pull/99'},
                           verdicts=[{'job': self.job_id, 'verdict': 'FIXED', 'reason': 'original worker fix'}])
        self.journal = self.root / 'state/repair' / self.job_id / 'publication.json'
        atomic(self.journal, self.publication)
        self.original_journal = self.journal.read_bytes()
        self.row_file = self.root / 'state/backfill/findings/triage' / (self.fid + '.json')
        delivered = next(v for v in self.out.retained() if v['payload'].get('action') == 'delivered')
        self.fixed = self.inbox.triage(self.fid, self.f.repo, self.merge, 'fixed', 'fixture',
                                     'Verified original finding on the reviewed merged implementation',
                                     self.at, fixing_commit=self.merge)
        ledger.validate_sequence([self.review, confirmed, delivered, self.fixed])
        self.info = {'number': 99, 'state': 'MERGED', 'headRefOid': self.actual,
                     'mergeCommit': {'oid': self.merge}}
        self.c = SimpleNamespace(STATE=self.root / 'state', iso=lambda: self.at,
                                 pr_info=lambda _: self.info, git=self.f.git,
                                 is_ancestor=lambda a, b: subprocess.run(
                                     ['git', '-C', str(self.f.root), 'merge-base', '--is-ancestor', a, b],
                                     capture_output=True).returncode == 0)
        patcher = mock.patch.object(repair_tick, 'finding_inbox', return_value=self.inbox)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_current_fixed_event_completes_projection_and_retries_without_append(self):
        retained = self.out.retained()
        original_row = self.row_file.read_bytes()
        publish = repair_tick.publish_source_resolution
        calls = []
        def source_feedback(c, record, merge):
            calls.append(merge)
            if len(calls) == 1:
                raise RuntimeError('forge unavailable')
            return publish(c, record, merge)
        with self.assertRaisesRegex(ValueError, 'source changed'):
            repair_tick.merge_head_evidence(self.c, self.record, self.actual)
        with mock.patch.object(self.inbox, 'repair_outcome') as outcome, \
             mock.patch.object(self.out, 'spool', wraps=self.out.spool) as spool, \
             mock.patch.object(repair_tick, 'publish_source_resolution',
                               side_effect=source_feedback) as source:
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            self.assertNotIn('fix_merged', self.record)
            self.assertEqual(self.record['source_publication_error'], 'forge unavailable')
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            outcome.assert_not_called()
            spool.assert_not_called()
            self.assertEqual(source.call_count, 2)
        self.assertEqual(self.record['fix_merged'], self.at)
        self.assertNotIn('source_publication_error', self.record)
        self.assertEqual(self.record['validated_merge_head'], {
            'published_head': self.published, 'actual_head': self.actual,
            'merge_commit': self.merge, 'canonical_fixed_events': {self.job_id: self.fixed['id']}})
        self.assertEqual(self.out.retained(), retained)
        self.assertEqual(self.row_file.read_bytes(), original_row)
        self.assertEqual(self.journal.read_bytes(), self.original_journal)
        self.assertEqual(self.record['publication']['head'], self.published)
        self.assertEqual(self.record['publication']['commits'], [self.published])

    def test_noncurrent_or_mismatched_fixed_evidence_cannot_complete(self):
        original_row = ledger.loads(self.row_file.read_bytes())
        retained = self.out.retained()
        for case in ('merge', 'receipt', 'row-review', 'row-finding', 'event-review',
                     'event-finding', 'event-id', 'event-hash', 'verification', 'delivered',
                     'pr', 'lineage', 'merge-not-main'):
            with self.subTest(case=case):
                row = copy.deepcopy(original_row)
                values = copy.deepcopy(retained)
                value = next(v for v in values if v['id'] == self.fixed['id'])
                if case == 'merge': value['payload']['evidence']['fixing_commit'] = self.published
                if case == 'receipt': row['receipt']['repair_task'] = 'new-generation'
                if case == 'row-review': row['review_id'] = 'd' * 64
                if case == 'row-finding': row['finding']['id'] = 'd' * 64
                if case == 'event-review': value['payload']['review_id'] = 'd' * 64
                if case == 'event-finding': value['payload']['finding_id'] = 'd' * 64
                if case == 'verification': value['payload']['evidence']['verification'] = '  '
                if case == 'delivered': row['status'] = 'delivered'
                if case == 'event-hash': value['payload']['actor'] = 'changed without rehash'
                else: rehash(value); row['previous_event_id'] = value['id']
                if case == 'event-id': row['previous_event_id'] = 'e' * 64
                self.info.update(number=98 if case == 'pr' else 99,
                                 headRefOid=self.unrelated if case == 'lineage' else self.actual)
                self.info['mergeCommit'] = {'oid': self.unrelated if case == 'merge-not-main' else self.merge}
                ledger.atomic(self.row_file, ledger.canonical(row))
                for key in ('fix_merged', 'source_publication_error', 'validated_merge_head'):
                    self.record.pop(key, None)
                with mock.patch.object(self.out, 'retained', return_value=values), \
                     mock.patch.object(repair_tick, 'mark_finding_outcome') as mark, \
                     mock.patch.object(repair_tick, 'publish_source_resolution') as source:
                    repair_tick.reconcile_fix_prs(self.c, self.queue)
                    mark.assert_not_called()
                    source.assert_not_called()
                self.assertNotIn('fix_merged', self.record)
                if case != 'merge-not-main':
                    self.assertIn('source_publication_error', self.record)
                self.assertEqual(self.journal.read_bytes(), self.original_journal)

    def test_source_feedback_rechecks_current_fixed_disposition(self):
        blocker = {'repair_job': self.job_id}
        self.queue['items'][0]['blocking'] = [blocker]
        original = self.inbox.current_fixed_event
        calls = []
        def changed(job, merge):
            calls.append(job['job'])
            if len(calls) == 2:
                before = self.row_file.read_bytes()
                self.inbox.triage(self.fid, self.f.repo, self.merge, 'superseded', 'fixture',
                                  'Newer retained disposition before feedback', self.at)
                ledger.atomic(self.row_file, before)  # Crash after spool, before row update.
            return original(job, merge)
        with mock.patch.object(self.inbox, 'current_fixed_event', side_effect=changed), \
             mock.patch.object(self.inbox, 'repair_outcome') as outcome, \
             mock.patch.object(repair_tick, 'publish_source_resolution') as source:
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            outcome.assert_not_called()
            source.assert_not_called()
        self.assertEqual(len(calls), 2)
        self.assertNotIn('fix_merged', self.record)
        self.assertNotIn('resolution', blocker)
        self.assertNotIn('validated_merge_head', self.record)
        self.assertIn('changed before source feedback', self.record['source_publication_error'])
        self.assertEqual(self.journal.read_bytes(), self.original_journal)

    def assert_spooled_successor_prevents_projection(self, action):
        before = self.row_file.read_bytes()
        self.inbox.triage(self.fid, self.f.repo, self.merge, action, 'fixture',
                          'Newer authoritative disposition', self.at)
        retained = self.out.retained()
        ledger.atomic(self.row_file, before)  # Durable event survived; cache did not.
        with mock.patch.object(self.inbox, 'repair_outcome') as outcome, \
             mock.patch.object(self.out, 'spool', wraps=self.out.spool) as spool, \
             mock.patch.object(repair_tick, 'publish_source_resolution') as source:
            repair_tick.reconcile_fix_prs(self.c, self.queue)
            outcome.assert_not_called()
            spool.assert_not_called()
            source.assert_not_called()
        self.assertEqual(ledger.loads(self.row_file.read_bytes())['status'], action)
        self.assertNotIn('fix_merged', self.record)
        self.assertEqual(self.out.retained(), retained)
        self.assertEqual(self.journal.read_bytes(), self.original_journal)

    def test_retained_needs_human_successor_recovers_before_projection(self):
        self.assert_spooled_successor_prevents_projection('needs-human')

    def test_retained_superseded_successor_recovers_before_projection(self):
        self.assert_spooled_successor_prevents_projection('superseded')


if __name__ == '__main__':
    unittest.main()
