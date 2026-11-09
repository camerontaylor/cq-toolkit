"""Offline recovery tests using real Git worktrees and fake judge/transport."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from crq_repair import atomic
from crq_repair.recovery import recover


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'clone'
        self.repo.mkdir()
        self.run_git(self.repo, 'init', '-q')
        self.run_git(self.repo, 'config', 'user.name', 'test')
        self.run_git(self.repo, 'config', 'user.email', 'test@example.invalid')
        (self.repo / 'a.py').write_text('original\n')
        self.run_git(self.repo, 'add', 'a.py')
        self.run_git(self.repo, 'commit', '-qm', 'base')
        self.base = self.run_git(self.repo, 'rev-parse', 'HEAD')
        self.run_git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.base)
        self.wt = self.root / 'worktrees/crq-repair-item-crq-job'
        self.wt.parent.mkdir()
        self.run_git(self.repo, 'worktree', 'add', '--detach', str(self.wt), self.base)
        (self.wt / 'a.py').write_text('unfinished\n')
        self.run_git(self.wt, 'add', 'a.py')
        (self.wt / 'untracked.txt').write_text('preserve me')
        self.job = {'job': 'crq-job', 'item': 'item', 'run': 'run', 'repair_base': self.base,
                    'finding': {'path': 'a.py', 'line': 1, 'severity': 'major', 'body': 'bug'}}
        atomic(self.root / 'state/repair/inbox/crq-job.json', self.job)
        atomic(self.root / 'state/repair/crq-job/result.json', {'job': 'crq-job', 'item': 'item',
               'repair_base': self.base, 'worktree': str(self.wt), 'verdict': 'FAILED',
               'reason': 'driver stop error: no_outcome'})
        self.config = {'clone': str(self.repo), 'worktree_root': str(self.wt.parent)}
        self.scan = mock.Mock(return_value=True)
        self.judge = mock.Mock(return_value={'stop': 'ok', 'verdict': 'valid', 'reason': 'current bug',
                         'current_path': 'a.py', 'current_lines': [[1, 1]], 'quoted_text': 'original'})
        self.prepare = mock.Mock(return_value='crq-replacement')

    @staticmethod
    def run_git(cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def run_recovery(self):
        return recover(self.root, self.config, 'crq-job', self.scan, self.judge, self.prepare)

    def test_staged_and_untracked_work_remains_and_duplicate_does_not_dispatch(self):
        before = self.run_git(self.wt, 'diff', '--cached')
        result = self.run_recovery()
        self.assertEqual(result['replacement_job'], 'crq-replacement')
        self.assertIn('+unfinished', self.scan.call_args.args[0]['retained_patch'])
        retained = json.loads((self.root / 'state/repair/crq-job/recovery-evidence.json').read_text())
        self.assertIn('+unfinished', retained['retained_patch'])
        self.assertEqual(self.run_git(self.wt, 'diff', '--cached'), before)
        self.assertEqual((self.wt / 'untracked.txt').read_text(), 'preserve me')
        self.assertEqual(self.run_recovery(), result)
        self.judge.assert_called_once()
        self.prepare.assert_called_once()

    def test_interrupted_progress_without_result_can_be_recovered(self):
        directory = self.root / 'state/repair/crq-job'
        result = json.loads((directory / 'result.json').read_text())
        (directory / 'result.json').unlink()
        atomic(directory / 'progress.json', {**result, 'dispatch_pending': {'rung': 'A0'}})
        self.assertEqual(self.run_recovery()['replacement_job'], 'crq-replacement')
        self.assertFalse((directory / 'result.json').exists())
        self.assertIn('unfinished', (self.wt / 'a.py').read_text())

    def test_a_failed_replacement_is_also_recoverable(self):
        self.job.update(origin_job='crq-older', recovery_worktree=True)
        atomic(self.root / 'state/repair/inbox/crq-job.json', self.job)
        self.assertEqual(self.run_recovery()['replacement_job'], 'crq-replacement')
        self.prepare.assert_called_once()

    def test_legacy_shared_worktree_is_not_attributed_to_a_job(self):
        result_path = self.root / 'state/repair/crq-job/result.json'
        result = json.loads(result_path.read_text())
        result['worktree'] = str(self.wt.parent / 'crq-repair-item')
        atomic(result_path, result)
        with self.assertRaisesRegex(ValueError, 'owned repair worktree'):
            self.run_recovery()
        self.judge.assert_not_called()

    def test_recovery_reads_only_own_retained_attempt_after_reset(self):
        from crq_repair.retain import retain
        retain(self.wt, self.base, self.root / 'state/repair/crq-job/A0')
        self.run_git(self.wt, 'reset', '--hard', self.base)
        self.run_git(self.wt, 'clean', '-fd')
        self.run_recovery()
        attempts = self.scan.call_args.args[0]['retained_attempts']
        self.assertEqual(len(attempts), 1)
        self.assertIn('+unfinished', attempts[0]['patches'][0])

    def test_scan_rejection_never_calls_judge(self):
        self.scan.return_value = False
        self.assertEqual(self.run_recovery()['state'], 'unresolved')
        self.judge.assert_not_called()
        self.prepare.assert_not_called()

    def test_current_contract_is_in_scanned_evidence(self):
        path = self.repo / 'docs/current-contract-and-backlog.md'
        path.parent.mkdir()
        path.write_text('current obligations\n')
        self.run_git(self.repo, 'add', str(path.relative_to(self.repo)))
        self.run_git(self.repo, 'commit', '-qm', 'contract')
        self.run_git(self.repo, 'update-ref', 'refs/remotes/origin/main',
                     self.run_git(self.repo, 'rev-parse', 'HEAD'))
        self.run_recovery()
        contract = self.scan.call_args.args[0]['current_contract']
        self.assertEqual(contract['text'], 'current obligations\n')
        self.assertFalse(contract['truncated'])

    def test_owner_decision_and_missing_outcome_do_not_prepare(self):
        self.judge.return_value = {'stop': 'ok', 'verdict': 'unsure', 'reason': 'owner must choose behavior'}
        self.assertEqual(self.run_recovery()['disposition'], 'unsure')
        self.prepare.assert_not_called()
        self.judge.assert_called_once()

    def test_changed_source_or_worktree_refuses_replay(self):
        self.run_recovery()
        (self.wt / 'a.py').write_text('changed after recovery\n')
        with self.assertRaisesRegex(ValueError, 'evidence or source changed'):
            self.run_recovery()
        self.judge.assert_called_once()

    def test_moved_current_source_refuses_replay(self):
        self.run_recovery()
        (self.repo / 'a.py').write_text('new current source\n')
        self.run_git(self.repo, 'add', 'a.py')
        self.run_git(self.repo, 'commit', '-qm', 'new current')
        self.run_git(self.repo, 'update-ref', 'refs/remotes/origin/main',
                     self.run_git(self.repo, 'rev-parse', 'HEAD'))
        with self.assertRaisesRegex(ValueError, 'evidence or source changed'):
            self.run_recovery()
        self.judge.assert_called_once()

    def test_known_provider_deferrals_have_bounded_explicit_retries(self):
        self.judge.return_value = {'stop': 'rate-limit'}
        self.assertEqual(self.run_recovery()['state'], 'deferred')
        self.assertEqual(self.run_recovery()['state'], 'deferred')
        self.assertEqual(self.run_recovery()['state'], 'complete')
        self.assertEqual(self.run_recovery()['state'], 'complete')
        self.assertEqual(self.judge.call_count, 3)
        self.prepare.assert_not_called()

    def test_moved_anchor_never_creates_replacement(self):
        self.judge.return_value['current_lines'] = [[2, 2]]
        self.assertEqual(self.run_recovery()['disposition'], 'unresolved')
        self.prepare.assert_not_called()

    def test_lost_judge_response_never_repeats_dispatch(self):
        self.judge.side_effect = RuntimeError('lost response')
        with self.assertRaisesRegex(RuntimeError, 'lost response'):
            self.run_recovery()
        self.assertEqual(self.run_recovery()['state'], 'unknown')
        self.judge.assert_called_once()
        self.prepare.assert_not_called()
