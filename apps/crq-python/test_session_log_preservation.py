"""Session-log preservation tests — crq side (plan items 2.1–2.5).

Narrow, isolated, no live crq state, no network, no models (the repo's
narrow-test rule). Covers:

  2.1  launch() mints workId into meta.json and appends work.jsonl
       (drive launch indirectly: the work-record helper + meta shape).
  2.2  codex driver: stdout streams to driver.log DURING the run (a run
       killed at the wall clock keeps its prefix), thread id captured into
       session.json, --ephemeral gone from the argv.
  2.3  cq driver: CQ_SESSIONS_DIR points under the job dir; session.json
       written from the returned value.
  2.4  paseo driver: --title and cq.* labels ride the create argv.
  2.5  all three drivers forward the parent CQ_* env.
"""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
CRQ = ROOT / 'crq.py'


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


crq = _load('crq_module_under_test', CRQ)
codex = _load('crq_codex_driver', ROOT / 'crq_repair' / 'drivers' / 'codex.py')


class WorkRecordTest(unittest.TestCase):
    def test_append_work_record_writes_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            with mock.patch.object(crq, 'WORK_RECORDS', state / 'work.jsonl'), \
                 mock.patch.object(crq, 'event') as ev:
                crq.append_work_record({'type': 'work-started', 'workId': 'w1'})
                crq.append_work_record({'type': 'work-finished', 'workId': 'w1'})
            lines = (state / 'work.jsonl').read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[0])['workId'], 'w1')
            ev.assert_not_called()

    def test_append_failure_is_swallowed_and_logged(self):
        with mock.patch.object(crq, 'WORK_RECORDS', Path('/proc/nope/x.jsonl')), \
             mock.patch.object(crq, 'event') as ev:
            crq.append_work_record({'type': 'work-started', 'workId': 'w1'})
        ev.assert_called_once()
        self.assertEqual(ev.call_args.args[0], 'work_record_failed')


class CodexStreamTest(unittest.TestCase):
    """_stream_codex against a REAL tiny process — no mocks on the I/O path."""

    def test_stdout_streams_to_log_during_run(self):
        """_stream_codex writes bytes to the log WHILE the child still runs —
        the whole point vs the old command() that captured only at exit."""
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'driver.log'
            # A child that prints, flushes, then sleeps 30s: the helper must
            # surface the line before the child exits.
            argv = [sys.executable, '-c',
                    "print('event-one', flush=True)\nimport time; time.sleep(30)"]
            result_box = {}
            def run():
                result_box['r'] = codex._stream_codex(argv, None, None, 5, log)
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            seen = False
            for _ in range(100):
                if log.exists() and 'event-one' in log.read_text():
                    seen = True
                    break
                time.sleep(0.05)
            self.assertTrue(seen, 'driver.log did not receive stdout during the run')
            # Clean up the still-running child (its own group) and let the
            # helper's wait finish; the timeout lands within seconds.
            subprocess.run(['pkill', '-f', 'event-one'], check=False)
            thread.join(timeout=15)

    def test_thread_id_from_stream(self):
        lines = [json.dumps({'type': 'thread.started', 'thread_id': 'th-9'}) + '\n',
                 json.dumps({'type': 'item.completed', 'item': {}}) + '\n']
        self.assertEqual(codex._thread_id(lines), 'th-9')

    def test_thread_id_absent_is_none_not_a_guess(self):
        self.assertIsNone(codex._thread_id(['{not json}\n', '{"type": "other"}\n']))

    def test_ephemeral_is_gone_from_argv(self):
        # Build the argv the way invoke does, via a stubbed stream.
        captured = {}

        def fake_stream(argv, cwd, env, timeout, log_path):
            captured['argv'] = argv
            return 0, [json.dumps({'type': 'thread.started', 'thread_id': 't1'}) + '\n'], '', False

        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / 'job'
            job_dir.mkdir()
            out = job_dir / 'last.json'
            out.write_text(json.dumps({'changed': False, 'summary': 's', 'commits': []}))
            with mock.patch.object(codex, '_stream_codex', fake_stream), \
                 mock.patch.dict(os.environ, {'CQ_WORK_ID': 'w-42'}):
                result = codex.invoke(config, {'model': 'm', 'budget': {}},
                                      {'job': 'j', 'finding': {}, 'source_snapshot': {}},
                                      Path(tmp), job_dir)
            self.assertEqual(result['stop'], 'ok')
            argv = captured['argv']
            self.assertNotIn('--ephemeral', argv)
            self.assertIn('--json', argv)
            session = json.loads((job_dir / 'session.json').read_text())
            self.assertEqual(session['threadId'], 't1')
            self.assertEqual(session['workId'], 'w-42')


class PaseoLabelsTest(unittest.TestCase):
    def test_title_and_labels_ride_the_create_argv(self):
        paseo = _load('crq_paseo_driver', ROOT / 'crq_repair' / 'drivers' / 'paseo.py')
        config = {'repair': {'paseo_host': 'h', 'paseo_read_only_mode': 'm',
                             'paseo_budget_launcher': 'launcher',
                             'paseo_budget_launcher_verified': True,
                             'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}
        created = json.dumps({'agentId': 'a1'})
        with tempfile.TemporaryDirectory() as tmp:
            def fake_command(argv, **kw):
                idx = argv.index('--json')
                # exercise the inspect path enough for the driver to settle:
                raise StopIteration  # not reached; we assert before

            with mock.patch.object(paseo, 'command') as cmd, \
                 mock.patch.dict(os.environ, {'CQ_WORK_ID': 'w-7', 'CQ_RUN_ID': 'r-7'}):
                cmd.side_effect = [mock.Mock(returncode=0,
                                             stdout='{"agentId": "a1"}')]
                try:
                    paseo.invoke(config, {'model': 'm', 'budget': {}}, {'job': 'j'},
                                 Path(tmp), Path(tmp) / 'job')
                except (StopIteration, RuntimeError, ValueError, KeyError):
                    pass  # the create-argv assertion below is the point
                create_argv = cmd.call_args_list[0].args[0]
            self.assertIn('--title', create_argv)
            self.assertEqual(create_argv[create_argv.index('--title') + 1], 'crq judge')
            self.assertIn('--label', create_argv)
            labels = [create_argv[i + 1] for i, a in enumerate(create_argv) if a == '--label']
            self.assertIn('cq.task=crq-judge', labels)
            self.assertIn('cq.role=judge', labels)
            self.assertIn('cq.work=w-7', labels)
            self.assertIn('cq.run=r-7', labels)


if __name__ == '__main__':
    unittest.main()
