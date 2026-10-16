"""Narrow isolated tests for supported author enrollment and shared-quota
admission. No live queue/state, no models, no Git: every queue is a plain dict in
a temp dir and every launch/git/coverage/repair effect is mocked. One class spawns
a real, harmless `timeout`+`sleep` wrapper (never the model CLI) to regression-test
the GNU timeout process-group requirement, for both the managed and legacy shapes."""
import copy
import datetime as dt
import fcntl
import importlib.machinery
import importlib.util
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

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import author_quota  # noqa: E402

loader = importlib.machinery.SourceFileLoader("crq_author_under_test", str(ROOT / "crq.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
crq = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = crq
loader.exec_module(crq)

BASE = "a" * 40
HEAD = "b" * 40
REQ = "author-cycle-1"
MARKER = author_quota.GROUP_OWNER_MARKER


def binding(**over):
    d = {"request_id": REQ, "base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1}
    d.update(over)
    return d


def empty_queue():
    return {"created_at": crq.iso(), "items": [], "starts": [], "paused": False,
            "author_requests": {}, "author_observations": []}


def author_item(q):
    return author_quota.enroll(q, **binding(), at=crq.iso())["item"]


class EnrollTest(unittest.TestCase):
    def test_enroll_creates_pending_item_only_and_never_dispatches(self):
        q = empty_queue()
        res = author_quota.enroll(q, **binding(), at=crq.iso())
        self.assertTrue(res["created"])
        item = res["item"]
        self.assertEqual((item["state"], item["kind"], item["pr"]), ("pending", "author", 0))
        self.assertEqual(item["cycles"], [])
        self.assertEqual(item["author_cycles"], [])
        self.assertEqual(item["author"]["base"], BASE)
        self.assertEqual(item["author"]["head"], HEAD)
        self.assertEqual(q["author_requests"][REQ]["item"], item["id"])
        self.assertEqual(q["starts"], [])  # enrollment only queues; the tick launches

    def test_identical_request_is_idempotent(self):
        q = empty_queue()
        first = author_item(q)["id"]
        again = author_quota.enroll(q, **binding(), at=crq.iso())
        self.assertFalse(again["created"])
        self.assertEqual(again["item"]["id"], first)
        self.assertEqual(len(q["items"]), 1)

    def test_conflicting_binding_refuses_without_mutation(self):
        q = empty_queue()
        author_item(q)
        before = copy.deepcopy(q)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "different binding"):
            author_quota.enroll(q, **binding(head="d" * 40), at=crq.iso())
        self.assertEqual(q, before)

    def test_duplicate_binding_under_second_request_id_refuses(self):
        q = empty_queue()
        author_item(q)
        before = copy.deepcopy(q)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "already"):
            author_quota.enroll(q, **binding(request_id="other-id"), at=crq.iso())
        self.assertEqual(q, before)

    def test_malformed_identity_refuses(self):
        for bad in (dict(base="short"), dict(head=BASE), dict(cycle=3), dict(cycle=0),
                    dict(cycle="1"), dict(target="bad target"), dict(request_id=""),
                    dict(request_id="../escape"), dict(request_id="a" * 81)):
            with self.subTest(bad=bad), self.assertRaises(author_quota.AuthorRefused):
                author_quota.enroll(empty_queue(), **binding(**bad), at=crq.iso())


class PriorityTest(unittest.TestCase):
    def test_author_ranks_after_ordinary_and_before_coverage(self):
        author = {"id": "author-x", "kind": "author", "order": 0}
        for kind, order in (("open", 9), ("delta", 9), ("merged", 9), ("promotion", 9)):
            with self.subTest(kind=kind):
                self.assertLess(crq.sort_key({"id": "n", "kind": kind, "order": order}),
                                crq.sort_key(author))
        coverage = {"id": "coverage-x", "kind": "coverage", "order": 5, "state": "pending"}
        self.assertLess(crq.sort_key(author), crq.sort_key(coverage))


class LaunchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.runs = self.state / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("ROOT", self.root), ("STATE", self.state), ("RUNS", self.runs),
                            ("QUEUE", self.state / "queue.json"),
                            ("CONFIG", {"max_starts_per_hour": 5, "max_inflight": 2, "repair": {}})):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name in ("save_queue", "event"):
            p = mock.patch.object(crq, name)
            p.start()
            self.addCleanup(p.stop)
        self.worktree = mock.patch.object(crq, "make_worktree",
                                          return_value=(self.root / "wt", "crq/wt"))
        self.worktree.start()
        self.addCleanup(self.worktree.stop)

    def _launch(self, q, item, popen):
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", **popen):
            crq.launch(q, item, author_quota.plan(item))

    def test_author_launch_uses_committed_and_shares_starts_inflight(self):
        q = empty_queue()
        item = author_item(q)
        self._launch(q, item, {"return_value": SimpleNamespace(pid=4242)})
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(len(q["starts"]), 1)
        self.assertEqual(crq.starts_last_hour(q), 1)
        self.assertEqual(len(crq.inflight(q)), 1)
        meta = json.loads((self.runs / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["author"], {"request_id": REQ, "base": BASE, "head": HEAD,
                                          "target": "origin/merge-queue", "cycle": 1})
        self.assertEqual(meta["cmd"],
                         ["coderabbit", "review", "--agent", "--committed", "--base-commit", BASE])
        self.assertNotIn("--use-credits", meta["cmd"])
        self.assertNotIn("--credits", meta["cmd"])

    def test_natural_launch_cmd_is_unchanged(self):
        q = empty_queue()
        item = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "cycles": [], "attempts": []}
        q["items"].append(item)
        plan = {"base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1,
                "branch": "b", "notes": [], "label": "l"}
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", return_value=SimpleNamespace(pid=7)):
            crq.launch(q, item, plan)
        meta = json.loads((self.runs / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["cmd"], ["coderabbit", "review", "--agent", "--base-commit", BASE])

    def test_secret_scan_refusal_blocks_before_spawn_and_consumes_no_start(self):
        q = empty_queue()
        item = author_item(q)
        with mock.patch.object(crq, "secret_scan",
                               return_value=(False, {"denylist_hits": [1], "gitleaks_hits": []})), \
             mock.patch.object(crq.subprocess, "Popen") as popen:
            crq.launch(q, item, author_quota.plan(item))
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(q["starts"], [])
        popen.assert_not_called()

    def test_failed_spawn_is_a_consumed_terminal_with_no_retry(self):
        q = empty_queue()
        item = author_item(q)
        self._launch(q, item, {"side_effect": OSError("cannot fork")})
        self.assertEqual(item["state"], author_quota.AUTHOR_FAILED)
        self.assertNotEqual(item["state"], "pending")  # never auto-retried
        self.assertEqual(len(q["starts"]), 1)  # admission consumed
        self.assertFalse(item["run"]["launch_pending"])
        self.assertIn("no retry", item["last_error"])

    def test_non_author_spawn_failure_still_raises(self):
        q = empty_queue()
        item = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "cycles": [], "attempts": []}
        q["items"].append(item)
        plan = {"base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1,
                "branch": "b", "notes": [], "label": "l"}
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", side_effect=OSError("no fork")):
            with self.assertRaises(OSError):
                crq.launch(q, item, plan)


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


class CrashRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock())):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.remove = mock.patch.object(crq, "remove_worktree")
        self.remove.start()
        self.addCleanup(self.remove.stop)

    def _item(self, q, run_id, *, pidfile=None, pidfile_text=None, has_exit=False):
        item = author_item(q)
        item["state"] = "reviewing"
        item["run"] = {"run_id": run_id, "pid": None, "started_at": crq.iso()}
        rdir = self.runs / run_id
        rdir.mkdir(parents=True)
        if pidfile is not None:
            (rdir / "review.pid").write_text(json.dumps(pidfile))
        elif pidfile_text is not None:
            (rdir / "review.pid").write_text(pidfile_text)
        if has_exit:
            (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": crq.iso(),
                                                        "timed_out": False}))
        return item, rdir

    @staticmethod
    def _managed(rid, **over):
        pidfile = {"run_id": rid, "pid": 111, "pgid": 111, "sid": 111, "group_owner": MARKER}
        pidfile.update(over)
        return pidfile

    def test_run_state_matrix_is_fail_closed(self):
        rs = author_quota.run_state
        dead = dict(runner_alive=False, cli_alive=False, runner_group_alive=False)
        # managed: complete ownership -> a terminal run is harvestable
        self.assertEqual(rs(has_exit=True, identity="managed", wrapper_group_alive=None, **dead),
                         "harvest")
        # legacy with a KNOWN empty wrapper group: complete evidence -> harvest
        self.assertEqual(rs(has_exit=True, identity="legacy", wrapper_group_alive=False, **dead),
                         "harvest")
        # legacy with an UNKNOWN wrapper group: incomplete evidence -> retain
        self.assertEqual(rs(has_exit=True, identity="legacy", wrapper_group_alive=None, **dead),
                         "ambiguous")
        # a MISSING exit never asserts absence
        self.assertEqual(rs(has_exit=False, identity="managed", wrapper_group_alive=None, **dead),
                         "ambiguous")
        self.assertEqual(rs(has_exit=False, identity="legacy", wrapper_group_alive=False, **dead),
                         "ambiguous")
        # an invalid identity never releases, even with exit evidence
        self.assertEqual(rs(has_exit=True, identity="invalid", wrapper_group_alive=None, **dead),
                         "ambiguous")
        # any live probe wins, even with exit evidence
        for probe in ("runner_alive", "cli_alive", "runner_group_alive"):
            with self.subTest(probe=probe):
                self.assertEqual(rs(has_exit=True, identity="managed", wrapper_group_alive=None,
                                    **{**dead, probe: True}), "alive")
        self.assertEqual(rs(has_exit=True, identity="legacy", wrapper_group_alive=True, **dead), "alive")

    def test_identity_kind(self):
        managed = {"run_id": "r1", "pid": 111, "pgid": 111, "sid": 111, "group_owner": MARKER}
        self.assertEqual(author_quota.identity_kind(managed, run_id="r1"), "managed")
        self.assertEqual(author_quota.identity_kind(managed, run_id="r1", queue_pid=111), "managed")
        # legacy: no marker, no run_id/sid needed; consistent queue pid is fine
        self.assertEqual(author_quota.identity_kind({"pid": 111, "pgid": 222}), "legacy")
        self.assertEqual(author_quota.identity_kind({"pid": 111, "pgid": 222}, queue_pid=111), "legacy")
        bad = [
            None, {}, {"pid": 111}, {"pgid": 222}, {"pid": "1", "pgid": 222}, [],
            # managed but bound to another run
            {**managed, "run_id": "other"},
            # managed without a run_id
            {k: v for k, v in managed.items() if k != "run_id"},
            # unknown marker
            {**managed, "group_owner": "foreground-v2"},
            # not the detached session shape (pid != pgid, or missing/zero sid)
            {**managed, "pgid": 222},
            {**managed, "sid": 222},
            {k: v for k, v in managed.items() if k != "sid"},
            {**managed, "sid": 0},
        ]
        for pidfile in bad:
            with self.subTest(pidfile=pidfile):
                self.assertEqual(author_quota.identity_kind(pidfile, run_id="r1"), "invalid")
        # legacy pidfile whose pid disagrees with the persisted queue pid
        self.assertEqual(author_quota.identity_kind({"pid": 111, "pgid": 222}, queue_pid=999),
                         "invalid")
        # managed pidfile whose pid disagrees with the persisted queue pid
        self.assertEqual(author_quota.identity_kind(managed, run_id="r1", queue_pid=999), "invalid")

    def test_missing_pid_retains_capacity_never_ttl_releases(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-missing")
        with mock.patch.object(crq, "group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertIn("owner disposition", item["wait_reason"])

    def test_malformed_or_empty_pidfile_retains_without_exception(self):
        for n, text in enumerate(("{not json", "[]", "{}", '{"pid": 111}', '{"pid": 0, "pgid": 222}')):
            with self.subTest(text=text):
                q = empty_queue()
                item, _ = self._item(q, f"author-run-bad-{n}", pidfile_text=text)
                with mock.patch.object(crq, "pid_alive", return_value=False), \
                     mock.patch.object(crq, "group_alive", return_value=False):
                    self.assertIsNone(crq.harvest_review(q, item, False))
                self.assertEqual(item["state"], "reviewing")

    def test_malformed_identity_with_terminal_exit_still_retains(self):
        q = empty_queue()
        item, rdir = self._item(q, "author-run-bad-exit", pidfile_text="{not json", has_exit=True)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertTrue((rdir / "exit.json").exists())  # not consumed

    def test_legacy_no_exit_never_asserts_absence(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-legacy-none", pidfile={"pid": 111, "pgid": 222})
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")

    def test_legacy_partial_without_cli_retains_even_with_exit(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-legacy-partial", pidfile={"pid": 111, "pgid": 222},
                             has_exit=True)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")

    def test_legacy_dead_timeout_with_live_command_group_retains(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-legacy-live",
                             pidfile={"pid": 111, "pgid": 222, "cli_pid": 333})
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", side_effect=lambda pg: pg == 333):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertIn("alive", item["wait_reason"])

    def test_original_natural_valid_terminal_legacy_is_harvestable(self):
        # A NATURAL legacy run: terminal exit + complete ownership evidence (the
        # runner group AND the cli_pid group both known and empty) must harvest.
        q = empty_queue()
        item = {"id": "pr1", "pr": 1, "kind": "open", "state": "reviewing", "cycles": [],
                "attempts": [], "run": {"run_id": "natural-run", "pid": None, "started_at": crq.iso()}}
        q["items"].append(item)
        rdir = self.runs / "natural-run"
        rdir.mkdir(parents=True)
        (rdir / "review.pid").write_text(json.dumps({"pid": 111, "pgid": 222, "cli_pid": 333}))
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": crq.iso(), "timed_out": False}))
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertEqual(crq.run_liveness(rdir, item, item["run"], True), "harvest")

    def test_terminal_artifact_with_live_group_still_waits(self):
        q = empty_queue()
        item, rdir = self._item(q, "author-run-exit-live",
                                pidfile=self._managed("author-run-exit-live"), has_exit=True)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=True):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertTrue((rdir / "exit.json").exists())
        self.assertEqual(item["attempts"], [])

    def test_foreign_or_missing_managed_run_id_with_exit_retains(self):
        for n, over in enumerate(({"run_id": "some-other-run"},
                                  {"run_id": None},
                                  {"group_owner": "foreground-v2"},
                                  {"pgid": 222},          # pid != pgid
                                  {"sid": 222},           # sid != pid
                                  {"sid": 0})):
            with self.subTest(over=over):
                q = empty_queue()
                rid = f"author-run-foreign-{n}"
                item, rdir = self._item(q, rid, pidfile=self._managed(rid, **over), has_exit=True)
                with mock.patch.object(crq, "pid_alive", return_value=False), \
                     mock.patch.object(crq, "group_alive", return_value=False):
                    self.assertIsNone(crq.harvest_review(q, item, False))
                self.assertEqual(item["state"], "reviewing")
                self.assertTrue((rdir / "exit.json").exists())

    def test_legacy_pid_inconsistent_with_queue_pid_retains(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-pid-mismatch", pidfile={"pid": 111, "pgid": 222},
                             has_exit=True)
        item["run"]["pid"] = 999  # persisted queue pid disagrees with the recorded pid
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")

    def test_managed_current_run_without_persisted_pid_stays_covered(self):
        # A crash before the queue pid is persisted leaves run["pid"] = None; a
        # valid managed current run must still classify as managed.
        q = empty_queue()
        item, rdir = self._item(q, "author-run-nopid", pidfile=self._managed("author-run-nopid"))
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertEqual(crq.run_liveness(rdir, item, item["run"], False), "ambiguous")
        # with terminal evidence it is releasable (harvest), not blocked
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": crq.iso(), "timed_out": False}))
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False):
            self.assertEqual(crq.run_liveness(rdir, item, item["run"], True), "harvest")

    def test_dry_run_harvest_appends_no_events(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-dry", pidfile_text="{not json", has_exit=True)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "event") as ev:
            self.assertIsNone(crq.harvest_review(q, item, True))
        ev.assert_not_called()

    def test_group_probe_is_fail_closed(self):
        self.assertFalse(crq.group_alive(None))
        self.assertFalse(crq.group_alive(0))
        self.assertTrue(crq.group_alive(crq.os.getpgrp()))


class HarvestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock()),
                            ("remove_worktree", mock.Mock()), ("findings_md", lambda *a, **k: "")):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _run_dir(self, run_id, exit_code=0):
        rdir = self.runs / run_id
        rdir.mkdir(parents=True)
        (rdir / "meta.json").write_text(json.dumps({"run_id": run_id, "cycle": 1, "base": BASE,
                                                    "head": HEAD, "worktree": "/w", "wt_branch": "crq/w"}))
        (rdir / "review.ndjson").write_text("")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 111, "pgid": 111,
                                                     "sid": 111, "group_owner": MARKER}))
        (rdir / "exit.json").write_text(json.dumps({"exit": exit_code, "ended_at": crq.iso(),
                                                    "timed_out": exit_code == 124}))
        return rdir

    def _item(self, q, run_id):
        item = author_item(q)
        item["state"] = "reviewing"
        item["run"] = {"run_id": run_id, "pid": None, "started_at": crq.iso()}
        return item

    def test_completed_author_harvest_keeps_evidence_without_repair_or_coverage(self):
        q = empty_queue()
        rid = "author-run-ok"
        self._run_dir(rid)
        item = self._item(q, rid)
        cls = {"outcome": "completed", "counted": True, "findings": 2,
               "severity_counts": {"major": 2}, "message": None}
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "classify", return_value=cls), \
             mock.patch.object(crq.coverage, "record_review") as credit, \
             mock.patch.object(crq.repair_tick, "enqueue") as enqueue:
            msg = crq.harvest_review(q, item, False)
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["author_cycles"]), 1)   # genuine cycle evidence kept
        self.assertEqual(item["cycles"], [])              # so repair backfill never sees it
        self.assertFalse(item.get("repair_runs"))         # no repair debt
        credit.assert_not_called()                        # no promoted coverage credit
        enqueue.assert_not_called()
        self.assertNotIn("coverage", q)
        self.assertIn("no repair/coverage credit", msg)

    def test_every_noncompleted_author_outcome_is_a_consumed_terminal(self):
        for o in ("rate_limited", "action_required", "auth", "error", "interrupted",
                  "skipped", "too_large"):
            with self.subTest(outcome=o):
                q = empty_queue()
                rid = "author-run-" + o
                self._run_dir(rid, exit_code=1)
                item = self._item(q, rid)
                cls = {"outcome": o, "counted": False, "findings": 0, "severity_counts": {},
                       "message": "boom"}
                with mock.patch.object(crq, "pid_alive", return_value=False), \
                     mock.patch.object(crq, "group_alive", return_value=False), \
                     mock.patch.object(crq, "classify", return_value=cls):
                    crq.harvest_review(q, item, False)
                self.assertEqual(item["state"], author_quota.AUTHOR_FAILED)
                self.assertNotEqual(item["state"], "pending")     # never auto-retried
                self.assertIsNone(item["run"])
                self.assertIsNone(item.get("not_before"))
                self.assertFalse(item["attempts"][-1]["counted"])
                self.assertIn("no automatic retry", item["last_error"])
                if o == "rate_limited":
                    self.assertIsNotNone(q.get("cooldown_until"))  # global cooldown preserved
                if o in ("action_required", "auth"):
                    self.assertTrue(q.get("paused"))               # global pause preserved

    def test_author_cycles_are_not_repair_backfill_input(self):
        item = {"kind": "author", "author_cycles": [{"run_id": "r"}]}
        # repair_tick.backfill scans item['cycles'] only; author evidence lives
        # elsewhere, so no repair job can ever be derived from it.
        self.assertEqual(item.get("cycles", []), [])


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
        for name, value in (("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock()),
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
            "open(outfile, 'w').write(json.dumps(ident))\n"
            "time.sleep(60)\n")
        proc = subprocess.Popen([sys.executable, str(runner), str(rdir / "review.pid"),
                                 json.dumps(argv), json.dumps(identity)], start_new_session=True)
        self.pgids.append(proc.pid)
        for _ in range(200):
            if (rdir / "review.pid").exists():
                break
            time.sleep(0.05)
        self.assertTrue((rdir / "review.pid").exists())
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


class TickTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.q = empty_queue()
        self.patches = [
            ("load_queue", lambda: self.q), ("fetch", mock.Mock()), ("enroll", lambda q, dry: []),
            ("promotion_audit", lambda q, dry: []), ("promotion_tick", lambda q, dry: []),
            ("save_queue", mock.Mock()), ("write_status", mock.Mock()), ("write_heartbeat", mock.Mock()),
            ("notify_owner", mock.Mock()), ("event", mock.Mock()), ("coverage_fallback", lambda *a: (None, False)),
            ("promotion_mode", lambda: "user"), ("apply_signer_backoff", mock.Mock()),
            ("plan_author", lambda item, dry: author_quota.plan(item)),
            ("pr_info", mock.Mock(side_effect=AssertionError("author items must not query a PR"))),
            ("quiet_reason", mock.Mock(side_effect=AssertionError("author items skip the PR quiet gate"))),
            ("STATE", self.root), ("PROMO", {"enabled": False}),
            ("CONFIG", {"max_starts_per_hour": 5, "max_inflight": 2, "stale_alarm_min": 36, "repair": {}}),
        ]
        for name, value in self.patches:
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name in ("backfill", "archive_legacy", "reconcile_fix_prs"):
            p = mock.patch.object(crq.repair_tick, name, mock.Mock())
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(crq.coverage, "record_opportunity", lambda *a, **k: {})
        p.start()
        self.addCleanup(p.stop)

    def test_cooldown_blocks_the_author_start(self):
        self.q["cooldown_until"] = crq.iso(crq.now() + dt.timedelta(minutes=10))
        author_item(self.q)
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick()
        launch.assert_not_called()
        self.assertTrue(any("cooldown" in line for line in log))

    def test_pause_blocks_the_author_start(self):
        self.q["paused"] = True
        author_item(self.q)
        with mock.patch.object(crq, "launch") as launch:
            crq.tick()
        launch.assert_not_called()

    def test_hourly_cap_is_shared_and_blocks_the_author(self):
        self.q["starts"] = [crq.iso() for _ in range(5)]
        author_item(self.q)
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick()
        launch.assert_not_called()
        self.assertTrue(any("hourly cap" in line for line in log))

    def test_inflight_cap_is_shared(self):
        for n in (9, 8):
            self.q["items"].append({"id": f"pr{n}", "pr": n, "kind": "open", "state": "reviewing",
                                    "cycles": [], "attempts": [],
                                    "run": {"run_id": f"r{n}", "pid": None, "started_at": crq.iso()}})
        author_item(self.q)
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick()
        launch.assert_not_called()
        self.assertTrue(any("in flight" in line for line in log))

    def test_promotion_is_selected_before_the_author(self):
        author_item(self.q)
        self.q["items"].append({"id": "promo-1", "kind": "promotion", "state": "pending",
                                "base_sha": BASE, "batch_sha": HEAD, "order": 0})
        started = []
        with mock.patch.object(crq, "plan_promotion",
                               return_value={"base": BASE, "head": HEAD, "target": "origin/main",
                                             "cycle": None, "branch": None, "notes": [], "label": "p"}), \
             mock.patch.object(crq, "launch", side_effect=lambda q, i, p: started.append(i["id"]) or "r"):
            crq.tick()
        self.assertEqual(started, ["promo-1"])

    def test_author_starts_in_the_tick_and_coverage_fallback_is_not_reached(self):
        item = author_item(self.q)
        started = []
        with mock.patch.object(crq, "launch",
                               side_effect=lambda q, i, p: (started.append(i["id"]),
                                                            i.update(state="reviewing"), "r")[2]), \
             mock.patch.object(crq, "coverage_fallback") as coverage:
            crq.tick()
        self.assertEqual(started, [item["id"]])
        coverage.assert_not_called()

    def test_selective_start_of_an_author_item_is_refused(self):
        item = author_item(self.q)
        self.q["items"].append({"id": "promo-1", "kind": "promotion", "state": "pending",
                                "base_sha": BASE, "batch_sha": HEAD, "order": 0})
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick(False, item["id"])
        launch.assert_not_called()                         # never dispatches
        self.assertTrue(any("selective start refused" in line for line in log))
        self.assertEqual(item["state"], "pending")         # still queued, untouched

    def test_selective_author_start_does_not_bypass_the_hourly_cap(self):
        item = author_item(self.q)
        self.q["starts"] = [crq.iso() for _ in range(5)]
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick(False, item["id"])
        launch.assert_not_called()
        self.assertTrue(any("hourly cap" in line for line in log))

    def test_selective_author_dry_run_shows_the_plan_but_never_launches(self):
        item = author_item(self.q)
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick(True, item["id"])
        launch.assert_not_called()
        self.assertTrue(any("DRY-RUN would start" in line for line in log))


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
                               return_value=SimpleNamespace(pid=5, wait=lambda: rc)):
            crq.cmd_review_child(rid)
        return json.loads((rdir / "exit.json").read_text())

    def test_timed_out_covers_124_and_137_only(self):
        for rc in (124, 137):
            with self.subTest(rc=rc):
                self.assertTrue(self._exit(rc)["timed_out"])
        for rc in (0, 1, 143):
            with self.subTest(rc=rc):
                self.assertFalse(self._exit(rc)["timed_out"])


class ObservationTest(unittest.TestCase):
    def _manifest(self, **over):
        now = crq.now()
        d = {"request_id": "manual-cycle-1", "base": BASE, "head": HEAD,
             "target": "origin/merge-queue", "cycle": 1,
             "started_at": crq.iso(now - dt.timedelta(minutes=5)),
             "artifacts": [{"path": "/tmp/cycle1.ndjson", "sha256": "e" * 64}]}
        d.update(over)
        return d, now

    def test_charge_is_append_only_never_fabricates_a_cycle(self):
        q = empty_queue()
        items_before = copy.deepcopy(q["items"])
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        self.assertFalse(obs["reserved"])
        res = author_quota.charge_observation(q, obs, at=crq.iso(now))
        self.assertTrue(res["charged"])
        self.assertEqual(q["starts"], [obs["started_at"]])  # charged to the rolling hour
        self.assertEqual(q["items"], items_before)          # no item/cycle fabricated
        self.assertEqual(crq.starts_last_hour(q), 1)
        self.assertFalse(q["author_observations"][0]["reserved"])
        again = author_quota.charge_observation(q, obs, at=crq.iso(now))
        self.assertFalse(again["charged"])                  # identical is idempotent
        self.assertEqual(len(q["starts"]), 1)

    def test_same_key_different_binding_or_artifacts_refuses(self):
        q = empty_queue()
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        author_quota.charge_observation(q, obs, at=crq.iso(now))
        before = copy.deepcopy(q)
        for clash in ({**obs, "head": "c" * 40},
                      {**obs, "artifacts": [{"path": "/tmp/other.ndjson", "sha256": "d" * 64}]}):
            with self.subTest(clash=clash.get("head")), self.assertRaises(author_quota.AuthorRefused):
                author_quota.charge_observation(q, clash, at=crq.iso(now))
        self.assertEqual(q, before)

    def test_reserved_true_future_and_stale_refuse(self):
        for over in ({"reserved": True},
                     {"started_at": crq.iso(crq.now() + dt.timedelta(minutes=5))},
                     {"started_at": crq.iso(crq.now() - dt.timedelta(hours=2))}):
            manifest, now = self._manifest(**over)
            with self.subTest(over=over), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)

    def test_timestamp_grammar_is_strict_no_truncation(self):
        for bad in ("2026-10-11T16:09:57.123Z", "2026-10-11T16:09:57+00:00",
                    "2026-10-11T16:09:57", "2026-10-11T16:09:57Zjunk", "2026-10-11 16:09:57Z"):
            manifest, now = self._manifest(started_at=bad)
            with self.subTest(bad=bad), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)

    def test_artifacts_require_regular_files_with_matching_digests(self):
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        with self.assertRaises(author_quota.AuthorRefused):
            author_quota.verify_artifacts(obs, is_regular=lambda p: False, digest_of=lambda p: "e" * 64)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "digest mismatch"):
            author_quota.verify_artifacts(obs, is_regular=lambda p: True, digest_of=lambda p: "0" * 64)
        author_quota.verify_artifacts(obs, is_regular=lambda p: True, digest_of=lambda p: "e" * 64)

    def test_missing_or_duplicate_artifacts_refuse(self):
        for over in ({"artifacts": []},
                     {"artifacts": [{"path": "/x", "sha256": "bad"}]},
                     {"artifacts": [{"path": "/x", "sha256": "e" * 64},
                                    {"path": "/y", "sha256": "e" * 64}]}):
            manifest, now = self._manifest(**over)
            with self.subTest(over=over), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)


if __name__ == "__main__":
    unittest.main()
