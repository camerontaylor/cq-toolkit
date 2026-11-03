"""Fail-closed crash recovery: run identity, liveness and retention evidence.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_author_quota_fixtures import MARKER, author_item, author_quota, crq, empty_queue


class CrashRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("STATE", Path(self.tmp.name) / "state"),
                            ("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock())):
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


if __name__ == "__main__":
    unittest.main()
