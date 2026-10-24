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
  2.5  all three drivers forward the parent CQ_* env; the repair dispatch
       pins CQ_* to the selected job (crq:<review run id>).
"""
import importlib.util
import json
import os
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
                result_box['r'] = codex._stream_codex(argv, None, None, 2, log)
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            seen = False
            for _ in range(100):
                if log.exists() and 'event-one' in log.read_text():
                    seen = True
                    break
                time.sleep(0.05)
            self.assertTrue(seen, 'driver.log did not receive stdout during the run')
            # The helper itself must enforce the wall clock while the child
            # holds stdout open and silent: no external cleanup.
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive(), 'wall-clock timeout did not fire')
            rc, lines, _, timed_out = result_box['r']
            self.assertTrue(timed_out, 'expected timed_out=True')
            self.assertEqual(lines, ['event-one\n'])
            self.assertNotEqual(rc, 0)

    def test_stderr_is_returned_and_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'driver.log'
            argv = [sys.executable, '-c',
                    "import sys; print('out', flush=True); "
                    "print('Rate limit reached', file=sys.stderr, flush=True); sys.exit(3)"]
            rc, lines, err, timed_out = codex._stream_codex(argv, None, None, 30, log)
            self.assertEqual((rc, lines, timed_out), (3, ['out\n'], False))
            self.assertIn('Rate limit reached', err)
            self.assertIn('Rate limit reached', log.read_text())

    def test_stderr_rate_limit_is_classified(self):
        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}

        def fake_stream(argv, cwd, env, timeout, log_path):
            return 1, [], 'error: rate limit exceeded\n', False

        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / 'job'
            job_dir.mkdir()
            with mock.patch.object(codex, '_stream_codex', fake_stream):
                result = codex.invoke(config, {'model': 'm', 'budget': {}},
                                      {'job': 'j', 'finding': {}, 'source_snapshot': {}},
                                      Path(tmp), job_dir)
            self.assertEqual(result['stop'], 'rate-limit')

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


class RepairCorrelationTest(unittest.TestCase):
    """item 2.5: the repair path pins CQ_* to the SELECTED job, not the shell."""

    def test_dispatch_sets_and_restores_job_identity(self):
        svc = _load('crq_repair_service_corr', ROOT / 'crq_repair.py')
        seen = {}

        def fake_invoke(config, role, job, wt, directory, judge=False):
            seen.update({k: os.environ.get(k) for k in
                         ('CQ_WORK_ID', 'CQ_RUN_ID', 'CQ_ROLE', 'CQ_TASK', 'CQ_PARENT_WORK_ID')})
            return {'stop': 'ok'}

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(svc, 'source_snapshot', return_value={}), \
             mock.patch.object(svc.codex, 'invoke', fake_invoke), \
             mock.patch.dict(os.environ, {'CQ_WORK_ID': 'shell-work',
                                          'CQ_PARENT_WORK_ID': 'stale-parent'}):
            os.environ.pop('CQ_RUN_ID', None)
            svc.dispatch({}, {'driver': 'codex'}, {'run': 'r-1', 'job': 'crq-r-1-F2'},
                         Path(tmp), Path(tmp) / 'a', judge=True)
            after = (os.environ.get('CQ_WORK_ID'), os.environ.get('CQ_RUN_ID'),
                     os.environ.get('CQ_PARENT_WORK_ID'))
        self.assertEqual(seen, {'CQ_WORK_ID': 'crq:r-1', 'CQ_RUN_ID': 'crq-r-1-F2',
                                'CQ_ROLE': 'judge', 'CQ_TASK': 'crq-repair',
                                'CQ_PARENT_WORK_ID': None})
        self.assertEqual(after, ('shell-work', None, 'stale-parent'))


class CqSessionsDirTest(unittest.TestCase):
    """item 2.3: sessionsDir is advertised only once the runner wrote there."""

    def _run(self, write_session):
        cqd = _load('crq_cq_driver', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        config = {'repo': 'o/r', 'repair': {'cq_bin': 'cq.js',
                                            'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}
        job = {'job': 'j', 'pr': 1, 'finding': {'path': 'a', 'line': 1, 'body': 'b'},
               'source_snapshot': {}}
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / 'job'
            job_dir.mkdir()

            def fake_command(argv, cwd=None, env=None, timeout=None):
                self.assertEqual(env['CQ_SESSIONS_DIR'], str(job_dir / 'sessions'))
                if write_session:
                    Path(env['CQ_SESSIONS_DIR']).mkdir()
                    (Path(env['CQ_SESSIONS_DIR']) / 's-1.json').write_text('{}')
                body = {'status': 'ok', 'value': {'sessionId': 's-1', 'changed': False}}
                return mock.Mock(returncode=0, stdout=json.dumps(body), stderr='')

            with mock.patch.object(cqd, 'command', fake_command), \
                 mock.patch.dict(os.environ, {'CQ_WORK_ID': 'crq:r-1'}):
                result = cqd.invoke(config, {'model': 'p/m', 'budget': {}}, job, Path(tmp), job_dir)
            self.assertEqual(result['stop'], 'ok')
            return json.loads((job_dir / 'session.json').read_text()), job_dir

    def test_written_store_is_advertised(self):
        session, job_dir = self._run(True)
        self.assertEqual(session['sessionId'], 's-1')
        self.assertEqual(session['workId'], 'crq:r-1')
        self.assertEqual(session['sessionsDir'], str(job_dir / 'sessions'))

    def test_inert_variable_is_not_advertised(self):
        session, _ = self._run(False)
        self.assertEqual(session['sessionId'], 's-1')
        self.assertIsNone(session['sessionsDir'])


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
