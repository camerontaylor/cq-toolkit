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
import io
import json
import os
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
CQ_SNAPSHOT = {'source_sha': 'a' * 40, 'source_blob_sha': 'b' * 40, 'finding_sha256': 'c' * 64,
               'path': 'a', 'line_start': 1, 'line_end': 1, 'source': '1: x', 'incomplete': False}


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


class CodexLogFailureTest(unittest.TestCase):
    def test_broken_log_and_stderr_do_not_interrupt_either_pipe(self):
        """Keep every line when both the log and failure diagnostic reject writes."""
        for log_error in (OSError, ValueError):
            for report_error in (OSError, ValueError):
                with self.subTest(log_error=log_error, report_error=report_error):
                    lines = ['event-one\n', 'event-two\n']
                    errors = ['error-one\n', 'error-two\n']
                    process = mock.Mock(stdout=io.StringIO(''.join(lines)),
                                        stderr=io.StringIO(''.join(errors)), returncode=0)
                    log = mock.MagicMock()
                    log.__enter__.return_value = log
                    log.write.side_effect = [None] + [log_error('broken log')] * 4
                    stderr = mock.Mock()
                    stderr.write.side_effect = report_error('broken stderr')
                    with mock.patch.object(codex, 'open', return_value=log), \
                         mock.patch.object(codex.subprocess, 'Popen', return_value=process), \
                         mock.patch.object(codex.os, 'killpg'), \
                         mock.patch.object(codex.sys, 'stderr', stderr), \
                         mock.patch.object(threading, 'excepthook') as thread_error:
                        result = codex._stream_codex([], None, None, 1, 'driver.log')
                    self.assertEqual(result, (0, lines, ''.join(errors), False))
                    self.assertEqual(log.write.call_count, 5)
                    self.assertEqual(stderr.write.call_count, 2)
                    thread_error.assert_not_called()


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

    def test_timeout_kills_a_descendant_that_survives_the_launcher(self):
        """The launcher dying on SIGTERM is not proof the group stopped: a
        SIGTERM-ignoring descendant must still be SIGKILLed."""
        with tempfile.TemporaryDirectory() as tmp:
            log, pidfile = Path(tmp) / 'driver.log', Path(tmp) / 'child.pid'
            child = ("import os, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                     "open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)")
            launcher = ("import subprocess, sys, time; "
                        "subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], "
                        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
                        "print('started', flush=True); time.sleep(60)")
            argv = [sys.executable, '-c', launcher, child, str(pidfile)]
            _, _, _, timed_out = codex._stream_codex(argv, None, None, 2, log)
            self.assertTrue(timed_out)
            pid = int(pidfile.read_text())
            gone = False
            for _ in range(100):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    gone = True
                    break
                time.sleep(0.05)
            if not gone:
                os.kill(pid, 9)
            self.assertTrue(gone, 'descendant survived the timeout cleanup')

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

    def test_rate_limit_comes_from_structured_signals_only(self):
        """Review content that mentions a rate limit is not a provider stop."""
        message = [json.dumps({'type': 'item.completed',
                               'item': {'type': 'agent_message', 'text': 'rate limit'}}) + '\n']
        self.assertFalse(codex._has_rate_limit(message, ''))
        self.assertTrue(codex._has_rate_limit([], 'rate limit reached\n'))
        self.assertTrue(codex._has_rate_limit(
            [json.dumps({'type': 'error', 'message': 'rate limit exceeded'}) + '\n'], ''))
        self.assertTrue(codex._has_rate_limit(
            [json.dumps({'type': 'turn.failed', 'error': {'message': 'rate limit'}}) + '\n'], ''))

    def _invoke_with_stream(self, stream_result, judge=False, preexisting=None):
        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}

        def fake_stream(argv, cwd, env, timeout, log_path):
            return stream_result

        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            if preexisting is not None:
                (directory / 'last.json').write_text(preexisting)
            with mock.patch.object(codex, '_stream_codex', fake_stream):
                result = codex.invoke(config, {'model': 'm', 'budget': {}}, {'job': 'j'},
                                      directory, directory, judge=judge)
            return result, directory

    def test_stale_last_json_is_never_returned_as_ok(self):
        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}
        stale = json.dumps({'verdict': 'valid', 'reason': 'an earlier invocation'})

        def fake_stream(argv, cwd, env, timeout, log_path):
            return 0, [], '', False

        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'last.json').write_text(stale)
            with mock.patch.object(codex, '_stream_codex', fake_stream):
                result = codex.invoke(config, {'model': 'm', 'budget': {}}, {'job': 'j'},
                                      directory, directory, judge=True)
            self.assertEqual(result['stop'], 'error')
            self.assertNotIn('an earlier invocation', json.dumps(result))
            self.assertFalse((directory / 'last.json').exists())

    def test_unparseable_last_json_is_an_error_stop(self):
        result, _ = self._invoke_with_stream((0, [], '', False), judge=True,
                                             preexisting='{"verdict": tru')
        self.assertEqual((result['stop'], result['verdict']), ('error', 'unsure'))

    def test_judge_failures_report_unsure(self):
        for stream_result in ((0, [], '', True), (1, [], '', False)):
            with self.subTest(stream_result=stream_result):
                result, _ = self._invoke_with_stream(stream_result, judge=True)
                self.assertEqual((result['stop'], result['verdict']), ('error', 'unsure'))
                self.assertTrue(result['reason'])

    def test_retry_preserves_log_and_thread_links(self):
        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}
        real_stream = codex._stream_codex
        threads = iter(['first', 'second'])

        def stream(argv, cwd, env, timeout, log_path):
            event = json.dumps({'type': 'thread.started', 'thread_id': next(threads)})
            failure = json.dumps({'type': 'error', 'message': 'rate limit'})
            script = "import sys; print(sys.argv[1]); print(sys.argv[2]); sys.exit(1)"
            return real_stream([sys.executable, '-c', script, event, failure],
                               cwd, env, timeout, log_path)

        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with mock.patch.object(codex, '_stream_codex', stream):
                for _ in range(2):
                    result = codex.invoke(config, {'model': 'm'}, {}, directory, directory)
                    self.assertEqual(result['stop'], 'rate-limit')
            log = (directory / 'driver.log').read_text()
            self.assertIn('first', log)
            self.assertIn('second', log)
            self.assertEqual(log.count('# invocation'), 2)
            session = json.loads((directory / 'session.json').read_text())
            self.assertEqual(session['threadIds'], ['first', 'second'])
            self.assertEqual(session['threadId'], 'second')

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
            # Codex writes its `-o` result file itself; the driver never seeds it.
            Path(argv[argv.index('-o') + 1]).write_text(
                json.dumps({'changed': False, 'summary': 's', 'commits': []}))
            return 0, [json.dumps({'type': 'thread.started', 'thread_id': 't1'}) + '\n'], '', False

        config = {'repair': {'codex_budget_launcher': 'launcher',
                             'codex_budget_launcher_verified': True,
                             'budget': {'max_tokens': 100, 'wall_clock_min': 1}}}
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / 'job'
            job_dir.mkdir()
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

    def _run(self, write_session, value_sid=None):
        cqd = _load('crq_cq_driver', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        config = {'repo': 'o/r', 'repair': {'cq_bin': 'cq.js',
                                            'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}
        job = {'job': 'j', 'pr': 1, 'finding': {'path': 'a', 'line': 1, 'body': 'b'},
               'source_snapshot': CQ_SNAPSHOT}
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / 'job'
            job_dir.mkdir()

            def fake_command(argv, cwd=None, env=None, timeout=None):
                self.assertEqual(env['CQ_SESSIONS_DIR'], str(job_dir / 'sessions'))
                if write_session:
                    Path(env['CQ_SESSIONS_DIR']).mkdir()
                    (Path(env['CQ_SESSIONS_DIR']) / 's-1.jsonl').write_text('{}\n')
                # The real review.fixItem value carries no sessionId.
                value = {'changed': False}
                if value_sid:
                    value['sessionId'] = value_sid
                body = {'status': 'ok', 'value': value}
                return mock.Mock(returncode=0, stdout=json.dumps(body), stderr='')

            with mock.patch.object(cqd, 'command', fake_command), \
                 mock.patch.dict(os.environ, {'CQ_WORK_ID': 'crq:r-1'}):
                result = cqd.invoke(config, {'model': 'p/m', 'budget': {}}, job, Path(tmp), job_dir)
            self.assertEqual(result['stop'], 'ok')
            return json.loads((job_dir / 'session.json').read_text()), job_dir

    def test_judge_retries_keep_both_invocation_logs(self):
        cqd = _load('crq_cq_judge_driver', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        config = {'repair': {'cq_bin': 'cq.js',
                             'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}
        outputs = [mock.Mock(returncode=1, stdout='first-output', stderr='first-error'),
                   mock.Mock(returncode=0, stdout='{"verdict":"valid"}', stderr='second-error')]
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(cqd, 'command', side_effect=outputs), \
             mock.patch.object(cqd.time, 'strftime', return_value='2026-11-03T00:00:00Z'):
            directory = Path(tmp)
            for _ in outputs:
                cqd.judge(config, {'model': 'p/m'}, {}, directory, directory)
            log = (directory / 'driver.log').read_text()
            for output in outputs:
                self.assertIn(output.stdout, log)
                self.assertIn(output.stderr, log)
            self.assertEqual(log.count('# invocation 2026-11-03T00:00:00Z'), 2)

    def test_written_store_is_advertised(self):
        session, job_dir = self._run(True)
        self.assertEqual(session['sessionId'], 's-1')  # derived from the store
        self.assertEqual(session['sessionIds'], ['s-1'])
        self.assertEqual(session['workId'], 'crq:r-1')
        self.assertEqual(session['sessionsDir'], str(job_dir / 'sessions'))

    def test_inert_variable_is_not_advertised(self):
        session, _ = self._run(False)
        self.assertIsNone(session['sessionId'])
        self.assertEqual(session['sessionIds'], [])
        self.assertIsNone(session['sessionsDir'])

    def test_value_session_id_wins(self):
        session, _ = self._run(True, value_sid='s-value')
        self.assertEqual(session['sessionId'], 's-value')

    def test_retry_attributes_only_the_new_session(self):
        cqd = _load('crq_cq_retry_driver', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        config = {'repo': 'o/r', 'repair': {'cq_bin': 'cq.js',
                  'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}
        job = {'job': 'j', 'finding': {'path': 'a', 'line': 1, 'body': 'b'}, 'source_snapshot': CQ_SNAPSHOT}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            sessions = directory / 'sessions'
            sessions.mkdir()
            (sessions / 'old.jsonl').write_text('{}\n')
            def run(create):
                def command(*args, **kwargs):
                    if create:
                        (sessions / 'new.jsonl').write_text('{}\n')
                    return mock.Mock(returncode=0, stdout='{"status":"ok","value":{}}', stderr='')
                with mock.patch.object(cqd, 'command', command):
                    cqd.invoke(config, {'model': 'p/m'}, job, directory, directory)
                return json.loads((directory / 'session.json').read_text())
            self.assertIsNone(run(False)['sessionId'])
            session = run(True)
            self.assertEqual(session['sessionId'], 'new')
            self.assertEqual(session['sessionIds'], ['new', 'old'])


class CqTimeoutLogTest(unittest.TestCase):
    """A wall-clock kill keeps its invocation output in driver.log."""

    def _config(self):
        return {'repo': 'o/r', 'repair': {'cq_bin': 'cq.js',
                                          'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}

    def _timeout(self):
        return subprocess.TimeoutExpired(['node'], 60, output='partial-out',
                                         stderr='partial-err')

    def test_invoke_logs_the_timed_out_invocation(self):
        cqd = _load('crq_cq_driver_timeout', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        job = {'job': 'j', 'pr': 1, 'finding': {'path': 'a', 'line': 1, 'body': 'b'},
               'source_snapshot': CQ_SNAPSHOT}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with mock.patch.object(cqd, 'command', side_effect=self._timeout()):
                # The deadline kill is the runner's typed budget stop (PR #1507);
                # the log-preservation guarantee is unchanged.
                report = cqd.invoke(self._config(), {'model': 'p/m', 'budget': {}}, job,
                                    directory, directory)
            self.assertEqual(report['stop'], 'budget')
            log = (directory / 'driver.log').read_text()
            self.assertIn('# invocation', log)
            self.assertIn('partial-out', log)
            self.assertIn('partial-err', log)

    def test_judge_logs_the_timed_out_invocation(self):
        cqd = _load('crq_cq_judge_timeout', ROOT / 'crq_repair' / 'drivers' / 'cq.py')
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with mock.patch.object(cqd, 'command', side_effect=self._timeout()):
                report = cqd.judge(self._config(), {'model': 'p/m'}, {}, directory, directory)
            self.assertEqual(report['stop'], 'budget')
            self.assertEqual(report['verdict'], 'unsure')
            log = (directory / 'driver.log').read_text()
            self.assertIn('partial-out', log)
            self.assertIn('partial-err', log)

    def test_command_keeps_partial_output_on_timeout(self):
        from crq_repair import command
        argv = [sys.executable, '-c',
                "import sys, time; print('late-out', flush=True); "
                "print('late-err', file=sys.stderr, flush=True); time.sleep(30)"]
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            command(argv, timeout=1)
        self.assertIn('late-out', caught.exception.stdout or '')
        self.assertIn('late-err', caught.exception.stderr or '')


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


class PaseoCleanupTest(unittest.TestCase):
    """A created agent is reclaimed, and a failed stop is never silent."""

    CONFIG = {'repair': {'paseo_host': 'h', 'paseo_read_only_mode': 'm',
                         'paseo_budget_launcher': 'launcher',
                         'paseo_budget_launcher_verified': True,
                         'budget': {'max_tokens': 1, 'wall_clock_min': 1}}}

    def _run(self, calls):
        paseo = _load('crq_paseo_driver_cleanup', ROOT / 'crq_repair' / 'drivers' / 'paseo.py')
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'job'
            with mock.patch.object(paseo, 'command', side_effect=calls) as cmd, \
                 mock.patch.object(paseo.sys, 'stderr', new_callable=io.StringIO) as err:
                # The inspect probe always fails here: the cleanup in `finally`
                # is the subject, and that failure must still surface.
                with self.assertRaises(RuntimeError):
                    paseo.invoke(self.CONFIG, {'model': 'm', 'budget': {}}, {'job': 'j'},
                                 Path(tmp), directory)
                argvs = [call.args[0] for call in cmd.call_args_list]
                record = json.loads((directory / 'agent.json').read_text())
                return argvs, err.getvalue(), record

    def _ok(self, stdout='{"agentId": "a1"}'):
        return mock.Mock(returncode=0, stdout=stdout)

    def _failed(self):
        return mock.Mock(returncode=1, stdout='')

    def test_trailing_launcher_output_still_yields_a_reclaimed_agent(self):
        argvs, _, record = self._run([self._ok('{"agentId": "a1"}\ntrailing noise'),
                                      self._failed(), self._ok(), self._ok()])
        self.assertEqual(record['agentId'], 'a1')
        self.assertIn(['paseo', '--host', 'h', 'stop', 'a1'], argvs)
        self.assertIn(['paseo', '--host', 'h', 'archive', 'a1'], argvs)

    def test_failed_stop_is_reported_and_skips_archive(self):
        argvs, err, _ = self._run([self._ok(), self._failed(), self._failed()])
        self.assertIn(['paseo', '--host', 'h', 'stop', 'a1'], argvs)
        self.assertNotIn(['paseo', '--host', 'h', 'archive', 'a1'], argvs)
        self.assertIn('may still be running; not archived', err)

    def test_stop_exception_does_not_replace_the_verdict(self):
        argvs, err, _ = self._run([self._ok(), self._failed(), OSError('paseo gone')])
        self.assertNotIn(['paseo', '--host', 'h', 'archive', 'a1'], argvs)
        self.assertIn('paseo stop failed for a1', err)
        self.assertIn('may still be running; not archived', err)


if __name__ == '__main__':
    unittest.main()
