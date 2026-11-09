"""Offline publication replay: real Git conflicts, empty picks and transient errors."""
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import repair_tick


class ReplayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.repo / 'file').write_text('base\n')
        self.git('add', 'file')
        self.git('commit', '-qm', 'base')
        self.base = self.git('rev-parse', 'HEAD')
        (self.repo / 'file').write_text('repair\n')
        self.git('commit', '-qam', 'repair')
        self.repair = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '--detach', self.base)

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def publish(self, target, *, git_override=None):
        wt = self.root / 'publish'
        self.git('worktree', 'add', '-q', '--detach', str(wt), target)
        self.addCleanup(lambda: self.git('worktree', 'remove', '--force', str(wt)))
        c = SimpleNamespace(STATE=self.root / 'state', git=lambda *args: target,
                            make_worktree=lambda *args: (wt, 'fixture'),
                            remove_worktree=lambda *args: None)
        record = {'jobs': ['job'], 'open_pr': False, 'base': self.base, 'state': 'ready'}
        original = repair_tick.wt_git
        with mock.patch.object(repair_tick, 'wt_git', side_effect=git_override or original), \
             mock.patch.object(repair_tick, 'verify', side_effect=AssertionError('replayed')):
            try:
                repair_tick.publish(c, {}, {}, 'run', record,
                                    [{'job': 'job', 'commits': [self.repair]}])
            except Exception as exc:
                return record, exc
        return record, None

    def assert_stale_replay(self, content):
        (self.repo / 'file').write_text(content)
        self.git('commit', '-qam', 'target')
        record, error = self.publish(self.git('rev-parse', 'HEAD'))
        self.assertIsNone(error)
        self.assertEqual(record['state'], 'stale')

    def test_conflicting_replay_is_stale(self):
        self.assert_stale_replay('target\n')

    def test_empty_replay_is_stale(self):
        self.assert_stale_replay('repair\n')

    def test_transient_git_failure_propagates_for_retry(self):
        original = repair_tick.wt_git
        def failed(wt, *args):
            if args[0] == 'cherry-pick':
                raise RuntimeError('temporary git failure')
            return original(wt, *args)
        record, error = self.publish(self.base, git_override=failed)
        self.assertEqual(str(error), 'temporary git failure')
        self.assertEqual(record['state'], 'ready')

    def test_successful_real_replay_reaches_verification(self):
        record, error = self.publish(self.base)
        self.assertIsInstance(error, AssertionError)
        self.assertEqual(str(error), 'replayed')
        self.assertEqual(record['state'], 'ready')
