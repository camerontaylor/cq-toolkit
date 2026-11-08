"""Real isolated inbox/event/repair adapter integration, no paid providers."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import repair_tick
from crq_repair import atomic
from crq_repair.bounded import drain_job
import finding_delivery as delivery
import review_ledger as ledger
from crq_repair.triage import phase
from test_finding_delivery import FindingTest, AT


class PhaseTest(FindingTest):
    def run_phase(self, report=None, dry=False, maximum=6):
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        judge = mock.Mock(return_value=report or {'stop': 'ok', 'verdict': 'valid', 'reason': 'source confirms',
                        'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'})
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT, dry_run=dry, maximum=maximum)
        return result, queue, judge

    def test_real_delivery_and_replay_are_idempotent(self):
        result, queue, _ = self.run_phase()
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        job = next((self.root / 'state/repair/inbox').glob('*.json'))
        self.assertEqual(ledger.loads(job.read_bytes())['canonical_finding_id'], self.fid)
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

    def test_dry_run_preserves_every_byte_and_never_delivers(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*.json')}
        result, queue, _ = self.run_phase(dry=True)
        self.assertEqual(result['judged'], 1)
        self.assertEqual(queue['items'], [])
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*.json')})

    def test_provider_limit_leaves_finding_unjudged(self):
        result, _, _ = self.run_phase({'stop': 'rate-limit'})
        self.assertEqual(result['unjudged'], 1)
        self.assertEqual(result['counts'], {})

    def test_bad_quote_cannot_confirm(self):
        result, _, _ = self.run_phase({'stop': 'ok', 'verdict': 'valid', 'reason': 'asserted',
                                     'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'wrong'})
        self.assertEqual(result['counts'], {'needs-human': 1})

    def test_zero_limit_leaves_unjudged(self):
        result, _, judge = self.run_phase(maximum=0)
        judge.assert_not_called()
        self.assertEqual(result['unjudged'], 1)

    def test_delivered_pr_zero_job_is_consumed_and_harvested(self):
        _, queue, _ = self.run_phase()
        item = queue['items'][0]
        run = next(iter(item['repair_runs']))
        job_id = item['repair_runs'][run]['jobs'][0]
        self.f.repo.git('update-ref', 'refs/remotes/origin/main', self.t)
        config = {'clone': str(self.f.repo.root), 'repair': {'max_rounds_per_pin': 2}}
        status, job, reason = drain_job(self.root, config, queue, job_id)
        self.assertEqual((status, reason), ('run', ''))
        self.assertEqual(job['pr'], 0)
        path = Path(__file__).parent / 'crq_repair.py'
        spec = importlib.util.spec_from_file_location('triage_drain_test', path)
        service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
        config['repair']['blackout'] = {'enabled': False}
        config['worktree_root'] = str(self.root / 'worktrees')
        result = {'job': job_id, 'item': item['id'], 'verdict': 'NOT-FIXED', 'reason': 'invalid', 'commits': []}
        def process(*args):
            atomic(self.root / 'state/repair' / job_id / 'result.json', result)
            return result
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'process', side_effect=process), mock.patch.object(service, 'dispatch_paused', return_value=None):
            service.process_item(config, [job])
        c = SimpleNamespace(STATE=self.root / 'state')
        messages = repair_tick.harvest(c, queue, item)
        self.assertTrue(messages)
        self.assertEqual(item['repair_runs'][run]['state'], 'done')
        self.assertEqual(item['state'], 'done')

    def test_exact_duplicate_is_mechanical_and_deleted_path_is_superseded(self):
        import copy
        row_path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = ledger.loads(row_path.read_bytes())
        duplicate = copy.deepcopy(row)
        duplicate['finding']['id'] = 'f' * 64
        duplicate['canonical_id'] = 'f' * 64
        ledger.atomic(row_path.parent / ('f' * 64 + '.json'), ledger.canonical(duplicate))
        result, _, judge = self.run_phase(dry=True, maximum=0)
        self.assertEqual(result['counts'], {'duplicate': 1})
        judge.assert_not_called()
        tip = self.f.commit({'a': None})
        result = phase(self.inbox, self.f.repo, tip, judge, None, AT, dry_run=True, maximum=0)
        self.assertEqual(result['counts'], {'superseded': 2})

    def test_fixed_requires_commit_that_touches_path_and_is_ancestor(self):
        result, _, _ = self.run_phase({'stop': 'ok', 'verdict': 'fixed', 'reason': 'fixed', 'fixing_commit': '0' * 40})
        self.assertEqual(result['counts'], {'needs-human': 1})
