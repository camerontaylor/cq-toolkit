"""A wall-clock kill of the direct cq path is the runner's budget stop.

The runner invokes `review.fixItem` (and the judge bridge) directly; no
governor arms inside cq on that path and the ai-sdk lane ignores
`wallClockMs`, so the Python kill timer is the only run-level wall-clock
owner. Regression for PR #1507 (finding
d20216150c754b8568c60ebd48f95ab31258c87daf5d008281ae83b387025660): before
the fix, `invoke()` and `judge()` re-raised `TimeoutExpired`, which the
attempt loop recorded as an unknown-outcome error and burned a rung on.
The summaries here state the runner's own deadline, never a claim that cq
itself returned budget-exhausted.

Narrow, isolated, no live crq state, no network, no models (the repo's
narrow-test rule). `cq.command` is mocked with a `TimeoutExpired` side
effect; no provider is contacted.
"""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
SNAPSHOT = {'source_sha': 'a' * 40, 'source_blob_sha': 'b' * 40, 'finding_sha256': 'c' * 64,
            'path': 'a', 'line_start': 1, 'line_end': 1, 'source': '1: x', 'incomplete': False}


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cq = _load('crq_cq_wall_clock_driver', ROOT / 'crq_repair' / 'drivers' / 'cq.py')

CONFIG = {'repo': 'example/repo', 'repair': {'cq_bin': '/unused/cli.js',
                                             'budget': {'wall_clock_min': 1, 'max_tokens': 1000}}}
JOB = {'job': 'crq-run1-F1', 'pr': 1, 'finding': {'path': 'a', 'line': 1, 'body': 'x'},
       'source_snapshot': SNAPSHOT}

NO_CQ_CLOCK = 'wall clock: Python deadline at budget+60s (cq never returned budget-exhausted)'


def _timeout():
    return subprocess.TimeoutExpired(['node'], 60, output='partial-out', stderr='partial-err')


class InvokeWallClockTest(unittest.TestCase):
    """invoke() translates its own deadline kill into the typed budget stop."""

    def invoke(self, session_lines=()):
        """Run invoke() with a mocked command that dies at the deadline.

        The fake command also asserts the subprocess timeout stays at
        budget + grace and that the session store still points under the
        job dir, then optionally writes this run's session lines first.
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)

        def fake_command(argv, cwd=None, env=None, timeout=None):
            self.assertEqual(timeout, 60 + cq.WALL_CLOCK_GRACE_S,
                             'subprocess deadline must stay budget + grace')
            self.assertEqual(cwd, directory)
            self.assertEqual(env['CQ_SESSIONS_DIR'], str(directory / 'sessions'))
            if session_lines:
                Path(env['CQ_SESSIONS_DIR']).mkdir()
                (Path(env['CQ_SESSIONS_DIR']) / 's-1.jsonl').write_text(
                    ''.join(json.dumps(line) + '\n' for line in session_lines))
            raise _timeout()

        with mock.patch.object(cq, 'command', side_effect=fake_command):
            return cq.invoke(CONFIG, {'model': 'zai/glm-5.3-flash'}, JOB, directory, directory)

    def test_timeout_returns_typed_budget_stop_not_timeoutexpired(self):
        report = self.invoke()
        self.assertEqual(report['stop'], 'budget')
        self.assertEqual(report['changed'], False)
        self.assertEqual(report['commits'], [])
        self.assertEqual(report['summary'], NO_CQ_CLOCK)

    def test_timeout_logs_the_partial_invocation_output(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        with mock.patch.object(cq, 'command', side_effect=_timeout()):
            report = cq.invoke(CONFIG, {'model': 'zai/glm-5.3-flash'}, JOB, directory, directory)
        self.assertEqual(report['stop'], 'budget')
        log = (directory / 'driver.log').read_text()
        self.assertIn('# invocation', log)
        self.assertIn('partial-out', log)
        self.assertIn('partial-err', log)

    def test_budget_stop_session_line_is_reported_when_present(self):
        stop = {'type': 'budget-stop', 'cause': 'output-tokens', 'step': 3, 'at': 'x',
                'detail': 'output budget: 500 output tokens over 3 steps (cap 500)'}
        report = self.invoke(session_lines=[stop])
        self.assertEqual(report['stop'], 'budget')
        self.assertEqual(
            report['summary'],
            'wall clock: Python deadline at budget+60s (output budget: '
            '500 output tokens over 3 steps (cap 500))')

    def test_only_this_runs_session_line_counts(self):
        stop = {'type': 'budget-stop', 'cause': 'context', 'detail': 'stale earlier run'}
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        sessions = directory / 'sessions'
        sessions.mkdir()
        (sessions / 'old.jsonl').write_text(json.dumps(stop) + '\n')
        with mock.patch.object(cq, 'command', side_effect=_timeout()):
            report = cq.invoke(CONFIG, {'model': 'zai/glm-5.3-flash'}, JOB, directory, directory)
        self.assertEqual(report['summary'], NO_CQ_CLOCK)


class JudgeWallClockTest(unittest.TestCase):
    """judge() reports its deadline kill as an unsure budget stop."""

    def test_judge_timeout_is_unsure_budget_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with mock.patch.object(cq, 'command', side_effect=_timeout()):
                report = cq.judge(CONFIG, {'model': 'example/model'}, {}, directory, directory)
            self.assertEqual(report['stop'], 'budget')
            self.assertEqual(report['verdict'], 'unsure')
            self.assertEqual(report['reason'], NO_CQ_CLOCK)
            log = (directory / 'driver.log').read_text()
            self.assertIn('partial-out', log)
            self.assertIn('partial-err', log)


if __name__ == '__main__':
    unittest.main()
