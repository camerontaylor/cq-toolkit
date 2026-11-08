"""Runner mechanics: tick lock, review wrapper process groups, deadline exits.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import fcntl
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from test_author_quota_fixtures import BASE, HEAD, MARKER, author_item, author_quota, crq, empty_queue


class LockTest(unittest.TestCase):
    def test_second_holder_refuses_and_runs_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "tick.lock"
            with mock.patch.object(crq, "LOCK", lock):
                holder = lock.open("w")
                self.addCleanup(holder.close)
                fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
                called = mock.Mock()
                self.assertIsNone(crq.with_lock(called))
                called.assert_not_called()

    def test_ran_locked_reports_whether_the_lock_was_held(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(crq, "LOCK", Path(tmp) / "tick.lock"):
            self.assertTrue(crq.ran_locked(lambda: None))
            holder = (Path(tmp) / "tick.lock").open("w")
            self.addCleanup(holder.close)
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            called = mock.Mock()
            self.assertFalse(crq.ran_locked(called))
            called.assert_not_called()

    def test_full_tick_waits_for_slot_lock_and_then_runs(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(crq, "LOCK", Path(tmp) / "tick.lock"), \
             mock.patch.object(crq.fcntl, "flock", side_effect=[BlockingIOError(), None, None]), \
             mock.patch.object(crq.time, "monotonic", side_effect=[0, 0.1]), \
             mock.patch.object(crq.time, "sleep") as sleep:
            called = mock.Mock(return_value="ran")
            self.assertEqual(crq.with_lock(called, lock_wait=90), "ran")
            sleep.assert_called_once_with(0.25)
            called.assert_called_once_with()

    def test_full_tick_lock_wait_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(crq, "LOCK", Path(tmp) / "tick.lock"), \
             mock.patch.object(crq.fcntl, "flock", side_effect=BlockingIOError()), \
             mock.patch.object(crq.time, "monotonic", side_effect=[0, 89.9, 90]), \
             mock.patch.object(crq.time, "sleep") as sleep:
            called = mock.Mock()
            self.assertIsNone(crq.with_lock(called, lock_wait=90))
            self.assertAlmostEqual(sleep.call_args.args[0], 0.1)
            called.assert_not_called()


class WrapperGroupTest(unittest.TestCase):
    """Real (harmless) subprocess regressions for the GNU timeout process group.

    MANAGED: `timeout --foreground` keeps the whole review in the runner's own
    group (marked in review.pid), so a runner killed before the cli_pid write
    leaves the recorded group LIVE. LEGACY: the default timeout puts the wrapper
    and its child in the wrapper's OWN group, whose pgid is the recorded cli_pid;
    a dead runner/timeout pid with the command group still live must retain.
    No model CLI is involved; only `sleep`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        self.pgids = []
        self.addCleanup(self._cleanup_groups)
        for name, value in (("STATE", Path(self.tmp.name) / "state"),
                            ("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock()),
                            ("remove_worktree", mock.Mock())):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _cleanup_groups(self):
        for pg in self.pgids:
            try:
                crq.os.killpg(pg, signal.SIGKILL)
            except OSError:
                pass

    def _item(self, q, rid):
        item = author_item(q)
        item["state"] = "reviewing"
        item["run"] = {"run_id": rid, "pid": None, "started_at": crq.iso()}
        return item

    def _spawn_runner(self, rid, argv, identity):
        rdir = self.runs / rid
        rdir.mkdir(parents=True)
        (rdir / "meta.json").write_text(json.dumps({"run_id": rid, "cycle": 1, "base": BASE,
                                                    "head": HEAD, "worktree": "/w", "wt_branch": "crq/w"}))
        runner = self.runs / f"{rid}-runner.py"
        runner.write_text(
            "import json, os, subprocess, sys, time\n"
            "outfile, argv, extra = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])\n"
            "p = subprocess.Popen(argv, stdin=subprocess.DEVNULL)\n"
            "ident = {'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp(),\n"
            "         'sid': os.getsid(0)}\n"
            "ident.update(extra)\n"
            "if extra.get('_cli_pid'):\n"
            "    ident['cli_pid'] = p.pid\n"
            "ident.pop('_cli_pid', None)\n"
            "open(outfile + '.tmp', 'w').write(json.dumps(ident))\n"
            "os.replace(outfile + '.tmp', outfile)\n"
            "time.sleep(60)\n")
        proc = subprocess.Popen([sys.executable, str(runner), str(rdir / "review.pid"),
                                 json.dumps(argv), json.dumps(identity)], start_new_session=True)
        self.pgids.append(proc.pid)
        for _ in range(200):
            if (rdir / "review.pid").exists():
                break
            time.sleep(0.05)
        self.assertTrue((rdir / "review.pid").exists())
        if identity.get("_cli_pid"):
            # Popen returns before GNU timeout creates its legacy process group.
            # Do not kill the runner until the wrapper has actually detached.
            wrapper_pid = json.loads((rdir / "review.pid").read_text())["cli_pid"]
            for _ in range(200):
                if os.getpgid(wrapper_pid) == wrapper_pid:
                    break
                time.sleep(0.01)
            self.assertEqual(os.getpgid(wrapper_pid), wrapper_pid)
        return proc, rdir

    def _crash(self, proc):
        try:
            os.kill(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()

    def test_wrapper_argv_requires_foreground(self):
        argv = crq.review_wrapper_argv(["coderabbit", "review"], 75)
        self.assertIn("--foreground", argv)
        self.assertIn("--kill-after=60", argv)
        self.assertIn("75m", argv)
        self.assertEqual(argv[-2:], ["coderabbit", "review"])

    def test_managed_runner_killed_before_cli_pid_keeps_the_group_live(self):
        if subprocess.run(["timeout", "--foreground", "5m", "true"],
                          capture_output=True).returncode != 0:
            self.skipTest("timeout --foreground unavailable on this host")
        rid = "author-run-managed"
        argv = crq.review_wrapper_argv(["sleep", "20"], 5)
        proc, rdir = self._spawn_runner(rid, argv, {"group_owner": MARKER, "run_id": rid})
        try:
            self._crash(proc)
            pidfile = json.loads((rdir / "review.pid").read_text())
            self.assertNotIn("cli_pid", pidfile)               # the exact window
            self.assertEqual(author_quota.identity_kind(pidfile, run_id=rid), "managed")
            self.assertTrue(crq.group_alive(pidfile["pgid"]))  # wrapper+child live in the group
            q = empty_queue()
            item = self._item(q, rid)
            self.assertIsNone(crq.harvest_review(q, item, False))  # retained, never "gone"
            self.assertEqual(item["state"], "reviewing")
        finally:
            self._crash(proc)

    def test_legacy_dead_runner_wrapper_group_live_is_retained(self):
        if subprocess.run(["timeout", "--kill-after=60", "5m", "true"],
                          capture_output=True).returncode != 0:
            self.skipTest("timeout --kill-after unavailable on this host")
        rid = "author-run-legacy"
        # LEGACY shape: the default wrapper (no --foreground), pidfile WITHOUT the
        # marker, cli_pid recorded as the wrapper's pid (= the wrapper's group id).
        argv = [crq.CONFIG.get("timeout_bin", "timeout"), "--kill-after=60", "5m", "sleep", "20"]
        proc, rdir = self._spawn_runner(rid, argv, {"_cli_pid": True})
        try:
            self._crash(proc)
            pidfile = json.loads((rdir / "review.pid").read_text())
            self.pgids.append(pidfile["cli_pid"])   # the wrapper's own group (cleanup only)
            self.assertNotIn("group_owner", pidfile)
            self.assertEqual(author_quota.identity_kind(pidfile), "legacy")
            self.assertFalse(crq.group_alive(pidfile["pgid"]))       # runner group empty
            self.assertTrue(crq.group_alive(pidfile["cli_pid"]))     # wrapper group still live
            q = empty_queue()
            item = self._item(q, rid)
            self.assertIsNone(crq.harvest_review(q, item, False))    # retained
            self.assertEqual(item["state"], "reviewing")
        finally:
            self._crash(proc)


class DeadlineClassifyTest(unittest.TestCase):
    """cmd_review_child records timed_out for a wrapper exit in (124, 137) and
    infers no cause: a 137 may be an external KILL, not the deadline."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("RUNS", self.runs),
                            ("CONFIG", {"review_timeout_min": 75, "timeout_bin": "timeout"})):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _exit(self, rc):
        rid = f"deadline-{rc}"
        rdir = self.runs / rid
        rdir.mkdir(parents=True)
        (rdir / "meta.json").write_text(json.dumps({"run_id": rid, "cmd": ["coderabbit", "review"],
                                                    "worktree": "/w"}))
        with mock.patch.object(crq.subprocess, "Popen",
                               return_value=SimpleNamespace(pid=5, wait=lambda: rc)), \
             mock.patch.object(crq, "run") as wake:
            crq.cmd_review_child(rid)
            wake.assert_called_once_with(["systemctl", "--user", "--no-block", "start",
                                          "crq-tick.service"], check=False, timeout=10)
        return json.loads((rdir / "exit.json").read_text())

    def test_timed_out_covers_124_and_137_only(self):
        for rc in (124, 137):
            with self.subTest(rc=rc):
                self.assertTrue(self._exit(rc)["timed_out"])
        for rc in (0, 1, 143):
            with self.subTest(rc=rc):
                self.assertFalse(self._exit(rc)["timed_out"])


if __name__ == "__main__":
    unittest.main()
