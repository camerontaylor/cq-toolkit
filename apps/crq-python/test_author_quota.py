"""Narrow isolated tests for supported author enrollment and shared-quota
admission. No live queue/state, no models, no processes, no Git: every queue is a
plain dict in a temp dir and every launch/git/coverage/repair effect is mocked."""
import copy
import datetime as dt
import fcntl
import importlib.machinery
import importlib.util
import json
import sys
import tempfile
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
        self.saved = []
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

    def test_launch_shares_starts_inflight_and_carries_no_credits_flag(self):
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
        self.assertEqual(meta["cmd"], ["coderabbit", "review", "--agent", "--base-commit", BASE])
        self.assertNotIn("--use-credits", meta["cmd"])
        self.assertNotIn("--credits", meta["cmd"])

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

    def _item(self, q, run_id, pidfile=None):
        item = author_item(q)
        item["state"] = "reviewing"
        item["run"] = {"run_id": run_id, "pid": None, "started_at": crq.iso()}
        rdir = self.runs / run_id
        rdir.mkdir(parents=True)
        if pidfile is not None:
            (rdir / "review.pid").write_text(json.dumps(pidfile))
        return item, rdir

    def test_run_state_matrix_is_fail_closed(self):
        rs = author_quota.run_state
        self.assertEqual(rs(has_exit=True, pidfile=None, runner_alive=False, cli_alive=False,
                            group_alive=False), "harvest")
        self.assertEqual(rs(has_exit=False, pidfile={"pid": 1}, runner_alive=True, cli_alive=False,
                            group_alive=False), "alive")
        self.assertEqual(rs(has_exit=False, pidfile={"pid": 1}, runner_alive=False, cli_alive=False,
                            group_alive=True), "alive")  # live GROUP keeps it alive
        self.assertEqual(rs(has_exit=False, pidfile=None, runner_alive=False, cli_alive=False,
                            group_alive=False), "ambiguous")
        self.assertEqual(rs(has_exit=False, pidfile={"pid": 1}, runner_alive=False, cli_alive=False,
                            group_alive=False), "gone")

    def test_missing_pid_retains_capacity_never_ttl_releases(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-missing")
        with mock.patch.object(crq, "author_group_alive", return_value=False):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertIn("owner disposition", item["wait_reason"])

    def test_live_pgid_retains_capacity(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-live", pidfile={"pid": 111, "pgid": 222})
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "author_group_alive", return_value=True):
            self.assertIsNone(crq.harvest_review(q, item, False))
        self.assertEqual(item["state"], "reviewing")
        self.assertIn("alive", item["wait_reason"])

    def test_provably_gone_is_a_distinct_terminal_with_no_retry(self):
        q = empty_queue()
        item, _ = self._item(q, "author-run-gone", pidfile={"pid": 111, "pgid": 222})
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "author_group_alive", return_value=False):
            msg = crq.harvest_review(q, item, False)
        self.assertIsNotNone(msg)
        self.assertEqual(item["state"], author_quota.AUTHOR_FAILED)
        self.assertEqual(item["attempts"][-1]["outcome"], "interrupted")
        self.assertFalse(item["attempts"][-1]["counted"])

    def test_group_probe_is_fail_closed(self):
        self.assertTrue(crq.author_group_alive(None) is False)
        self.assertTrue(crq.author_group_alive(0) is False)
        self.assertTrue(crq.author_group_alive(crq.os.getpgrp()) is True)


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

    def _completed_run(self, run_id):
        rdir = self.runs / run_id
        rdir.mkdir(parents=True)
        (rdir / "meta.json").write_text(json.dumps({"run_id": run_id, "cycle": 1, "base": BASE,
                                                    "head": HEAD, "worktree": "/w", "wt_branch": "crq/w"}))
        (rdir / "review.ndjson").write_text("")
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": crq.iso(), "timed_out": False}))
        return rdir

    def test_completed_author_harvest_keeps_evidence_without_repair_or_coverage(self):
        q = empty_queue()
        item = author_item(q)
        rid = "author-run-ok"
        self._completed_run(rid)
        item["state"] = "reviewing"
        item["run"] = {"run_id": rid, "pid": 1, "started_at": crq.iso()}
        cls = {"outcome": "completed", "counted": True, "findings": 2,
               "severity_counts": {"major": 2}, "message": None}
        with mock.patch.object(crq, "classify", return_value=cls), \
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

    def test_author_cycles_are_not_repair_backfill_input(self):
        item = {"kind": "author", "author_cycles": [{"run_id": "r"}]}
        # repair_tick.backfill scans item['cycles'] only; author evidence lives
        # elsewhere, so no repair job can ever be derived from it.
        self.assertEqual(item.get("cycles", []), [])


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
        self.q["items"].append({"id": "pr9", "pr": 9, "kind": "open", "state": "reviewing",
                                "cycles": [], "attempts": [],
                                "run": {"run_id": "r", "pid": None, "started_at": crq.iso()}})
        self.q["items"].append({"id": "pr8", "pr": 8, "kind": "open", "state": "reviewing",
                                "cycles": [], "attempts": [],
                                "run": {"run_id": "s", "pid": None, "started_at": crq.iso()}})
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
        self.assertFalse(again["charged"])                  # idempotent
        self.assertEqual(len(q["starts"]), 1)

    def test_reserved_true_future_and_stale_refuse(self):
        for over in ({"reserved": True},
                     {"started_at": crq.iso(crq.now() + dt.timedelta(minutes=5))},
                     {"started_at": crq.iso(crq.now() - dt.timedelta(hours=2))}):
            manifest, now = self._manifest(**over)
            with self.subTest(over=over), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)

    def test_artifacts_require_regular_files_with_matching_digests(self):
        q = empty_queue()
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
