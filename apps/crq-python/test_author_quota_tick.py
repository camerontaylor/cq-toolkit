"""Tick admission for author items: priority, cooldown, pause and shared caps.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_author_quota_fixtures import BASE, HEAD, author_item, author_quota, binding, crq, empty_queue


class TickTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.q = empty_queue()
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        self.patches = [
            ("refresh_slot_deadline", mock.Mock()),
            ("load_queue", lambda **kwargs: self.q), ("fetch", mock.Mock()), ("enroll", lambda q, dry: []),
            ("discover_merged", lambda q, budget: []),

            ("save_queue", mock.Mock()), ("write_status", mock.Mock()), ("write_heartbeat", mock.Mock()),
            ("notify_owner", mock.Mock()), ("event", mock.Mock()), ("coverage_fallback", lambda *a: (None, False)),

            ("plan_author", lambda item, dry: author_quota.plan(item)),
            ("pr_info", mock.Mock(side_effect=AssertionError("author items must not query a PR"))),
            ("quiet_reason", mock.Mock(side_effect=AssertionError("author items skip the PR quiet gate"))),
            ("STATE", self.root),
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

    def test_prioritized_merged_current_starts_naturally_before_open(self):
        current = dict(id="current", pr=42, kind=crq.review_receipt.KIND,
                       state="pending", operator_priority=True, order=99)
        self.q["items"] = [dict(id="pr1", pr=1, kind="open", state="pending", order=1), current]
        plan = dict(base=BASE, head=HEAD, notes=[], label="current")
        with mock.patch.object(crq, "prepare_current", return_value=plan), \
             mock.patch.object(crq, "launch", return_value="run") as launch:
            crq.tick()
        self.assertEqual(launch.call_args.args[1]["id"], "current")

    def test_additional_author_cycle_waits_for_required_pending_work(self):
        item = author_quota.enroll(self.q, **binding(cycle=2), at=crq.iso())["item"]
        item["operator_priority"] = True
        self.q["items"].append(dict(id="pr1", pr=1, kind="open", state="pending",
                                   not_before=crq.iso(crq.now() + dt.timedelta(hours=1))))
        with mock.patch.object(crq, "launch") as launch:
            crq.tick()
        launch.assert_not_called()
        self.assertEqual(crq.rank(item), 5)
        self.assertIn("optional cycle waits", item["wait_reason"])

    def test_prioritized_author_starts_before_open(self):
        item = author_item(self.q)
        item["operator_priority"] = True
        self.q["items"].append(dict(id="pr1", pr=1, kind="open", state="pending"))
        with mock.patch.object(crq, "launch", return_value="run") as launch:
            crq.tick()
        self.assertEqual(launch.call_args.args[1]["id"], item["id"])

    def test_prioritized_current_selective_start_still_refused(self):
        self.q["items"] = [dict(id="current", pr=42, kind=crq.review_receipt.KIND,
                                state="pending", operator_priority=True)]
        with mock.patch.object(crq, "launch") as launch:
            log = crq.tick(False, "current")
        launch.assert_not_called()
        self.assertTrue(any("selective start refused" in line for line in log))

    def test_prioritized_optional_waits_even_for_backed_off_merged_current(self):
        optional = dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}],
                        optional_cycle=True, operator_priority=True)
        pending = dict(id="current", pr=42, kind=crq.review_receipt.KIND, state="pending",
                       not_before=crq.iso(crq.now() + dt.timedelta(hours=1)))
        self.q["items"] = [optional, pending]
        with mock.patch.object(crq, "launch") as launch:
            crq.tick()
        launch.assert_not_called()
        self.assertIn("optional cycle waits", optional["wait_reason"])

    def test_optional_cycle_yields_to_coverage_then_starts_when_idle(self):
        optional = dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}], optional_cycle=True)
        self.q["items"] = [optional]
        with mock.patch.object(crq, "coverage_fallback", return_value=("coverage-run", True)), \
             mock.patch.object(crq, "launch") as launch:
            crq.tick()
        launch.assert_not_called()
        info = dict(state="OPEN")
        plan = dict(base=BASE, head=HEAD, notes=[], label="additional cycle (optional)")
        with mock.patch.object(crq, "pr_info", return_value=info), \
             mock.patch.object(crq, "quiet_reason", return_value=None), \
             mock.patch.object(crq, "plan_open", return_value=plan), \
             mock.patch.object(crq, "launch", return_value="run") as launch:
            crq.tick()
        self.assertEqual(launch.call_args.args[1]["id"], "pr1")

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


if __name__ == "__main__":
    unittest.main()
