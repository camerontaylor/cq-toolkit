"""Oversized interval partitioning: durable split parts and watermarks.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import unittest
from unittest import mock
import test_crq_recent_discovery as _recent_discovery
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class OversizedIntervalPartitionTest(unittest.TestCase):
    """#565: an interval with more identities than the inventory cap is split
    durably; the watermark advances only through completed, enrolled parts."""

    AFTER = _recent_discovery.RecentKeysetDiscoveryTest.AFTER
    BEFORE = _recent_discovery.RecentKeysetDiscoveryTest.BEFORE
    CAP = 10
    setUp = _recent_discovery.RecentKeysetDiscoveryTest.setUp
    forge = _recent_discovery.RecentKeysetDiscoveryTest.forge
    enrolled = _recent_discovery.RecentKeysetDiscoveryTest.enrolled

    def outage(self, times):
        """Closed merged PRs at the given merge seconds after AFTER."""
        base = crq.parse_iso(self.AFTER)
        self.rows = {n: {"number": n, "base": {"ref": "main"},
                         "updated_at": crq.iso(base + crq.dt.timedelta(seconds=t)),
                         "merged_at": crq.iso(base + crq.dt.timedelta(seconds=t)),
                         "merge_commit_sha": f"{n:040x}", "head": {"sha": f"{n:040x}"}}
                     for n, t in enumerate(times, start=1)}
        self.merged = set(self.rows)

    def tick(self):
        interval = crq.rolling_discovery_interval(self.q, {"enabled": True, "after": self.AFTER})
        with mock.patch.object(crq, "gh_json", side_effect=self.forge), \
                mock.patch.object(crq.merged_reconcile, "MAX_INVENTORY", self.CAP):
            return crq.discover_merged(self.q, crq.ForgeBudget(), interval=interval, recent=True)

    def check_frontier(self):
        """Enrollment precedes the watermark, and nothing is enrolled twice."""
        disk = crq.load_queue()
        numbers = [item["pr"] for item in disk["items"]]
        self.assertEqual(len(numbers), len(set(numbers)))
        watermark = disk["merged_watermark"]
        due = {n for n in self.merged if self.rows[n]["merged_at"] <= watermark}
        self.assertLessEqual(due, set(numbers))
        if disk.get("merged_reconcile", {}).get("complete"):
            self.assertLessEqual(disk["merged_reconcile"]["represented"], self.CAP)
        return disk

    def drive(self, ticks=40, on_tick=None):
        marks, logs = [], []
        for i in range(ticks):
            if on_tick:
                on_tick(i)
            try:
                logs += self.tick()
            except crq.DiscoveryStorageFailed:
                self.q = crq.load_queue()  # restart from disk, like the next tick
            disk = self.check_frontier()
            marks.append(disk["merged_watermark"])
            if disk["merged_watermark"] == self.BEFORE and disk["merged_discovery"].get("complete"):
                break
        else:
            self.fail("outage did not drain")
        self.assertEqual(marks, sorted(marks))
        self.assertEqual(self.enrolled(), self.merged)
        return marks, logs

    def test_oversized_outage_drains_through_enrolled_partitions(self):
        # 45 merges spread over the two-day outage: 4.5x the inventory cap.
        self.outage([3600 * k + 7 for k in range(45)])
        first = self.tick()
        self.assertIn("inventory cap: partitioned", first[0])
        md = crq.load_queue()["merged_discovery"]
        self.assertEqual((md["after"], md["before"], md["complete"], md["reason"]),
                         (self.AFTER, "2026-10-02T00:00:00Z", False, "inventory-cap-partitioned"))
        self.assertEqual(self.enrolled(), set())
        self.assertEqual(crq.load_queue()["merged_watermark"], self.AFTER)
        # Status reports the partition honestly; the width hint stays internal.
        import status_summary
        natural = status_summary.merged_current(crq.load_queue(), crq.STATE / "receipts")["natural_discovery"]
        self.assertEqual((natural["complete"], natural["reason"]), (False, "inventory-cap-partitioned"))
        self.assertNotIn("span", natural)
        marks, logs = self.drive()
        self.assertGreater(len(set(marks)), 4)  # several independently complete parts
        self.assertTrue(any("complete=True" in line for line in logs))

    def test_merges_at_a_partition_boundary_enroll_once(self):
        # Three merges exactly at the first split second (2026-10-02T00:00:00Z,
        # included in the first half) and more just after it, inside the
        # five-minute overlap of the next interval.
        # 19 merges in 17 s exceed the cap of 10, even inside one five-minute
        # overlap: parts there start at the watermark until the overlap clears.
        self.outage([86400] * 3 + [86400 + k for k in range(1, 9)] + [86400 - k for k in range(1, 9)])
        self.drive(ticks=80)

    def test_restart_at_partition_enrollment_and_watermark_boundaries(self):
        for stage in ("refusal-debt-save", "enrollment-save", "discovery-summary-save", "watermark-save"):
            with self.subTest(stage=stage):
                self.setUp()
                self.outage([3600 * k + 7 for k in range(45)])
                save = crq._save_discovery_queue
                hits = []

                def flaky(q, name):
                    if name == stage:
                        hits.append(name)
                        if len(hits) in (1, 3):
                            raise crq.DiscoveryStorageFailed("fixture storage fault: " + name)
                    return save(q, name)

                with mock.patch.object(crq, "_save_discovery_queue", side_effect=flaky):
                    self.drive()
                self.assertGreaterEqual(len(hits), 3)

    def test_errors_and_budget_exhaustion_retain_the_partition(self):
        self.outage([3600 * k + 7 for k in range(45)])
        self.tick()
        part = dict(crq.load_queue()["merged_discovery"])
        for failure, reason in ((OSError("down"), "transport-failure"),
                                (crq.deferred_refresh.RefreshExhausted("spent"), "budget-exhausted")):
            with mock.patch.object(self, "forge", side_effect=failure):
                self.assertIn("reason=" + reason, self.tick()[0])
            disk = crq.load_queue()
            self.assertEqual((disk["merged_discovery"]["after"], disk["merged_discovery"]["before"]),
                             (part["after"], part["before"]))
            self.assertEqual(disk["merged_watermark"], self.AFTER)
        self.drive()

    def test_other_refusals_do_not_partition(self):
        self.outage([3600 * k + 7 for k in range(45)])
        self.rows[45]["number"] = "bad"
        self.assertIn("cursor/debt retained", self.tick()[0])
        md = crq.load_queue()["merged_discovery"]
        self.assertEqual((md["before"], md["reason"]), (self.BEFORE, "reconcile-refused"))

    def test_dense_overlap_marker_outlives_the_rolling_upper_bound(self):
        # A part completes at the rolling upper bound while its reduced
        # overlap is under five minutes old: drop the width, keep the marker.
        self.outage([])
        mark = "2026-10-02T23:58:00Z"
        self.q.update(merged_watermark=mark, merged_discovery={
            "after": mark, "before": self.BEFORE, "complete": False, "span": 4, "overlap_from": mark})
        crq.save_queue(self.q)
        with mock.patch.object(crq, "gh_json", side_effect=self.forge):
            log = crq.discover_merged(self.q, crq.ForgeBudget(),
                                      interval={"after": mark, "before": self.BEFORE}, recent=True)
        self.assertIn("complete=True", log[0])
        md = crq.load_queue()["merged_discovery"]
        self.assertEqual(md.get("overlap_from"), mark)
        self.assertNotIn("span", md)
        self.assertGreaterEqual(
            crq.rolling_discovery_interval(self.q, {"enabled": True, "after": self.AFTER})["after"], mark)

    def test_span_hint_lapses_under_a_real_clock(self):
        # P3-1: the frozen upper bound was now()-1s at selection time; the
        # scan itself advances the clock, so a completion check against a
        # fresh now() never fires. A frozen test clock hides this; here the
        # clock stands one minute past the bound the interval was selected
        # with, and the hint must still lapse (one tick of slack).
        self.outage([])
        mark = "2026-10-02T23:00:00Z"
        self.q.update(merged_watermark=mark, merged_discovery={
            "after": mark, "before": self.BEFORE, "complete": False, "span": 600})
        crq.save_queue(self.q)
        with mock.patch.object(crq, "now", return_value=crq.parse_iso("2026-10-03T00:01:01Z")), \
                mock.patch.object(crq, "gh_json", side_effect=self.forge):
            log = crq.discover_merged(self.q, crq.ForgeBudget(),
                                      interval={"after": mark, "before": self.BEFORE}, recent=True)
        self.assertIn("complete=True", log[0])
        md = crq.load_queue()["merged_discovery"]
        self.assertTrue(md["complete"])
        self.assertNotIn("span", md)
        self.assertEqual(md["before"], self.BEFORE)

    def test_span_hint_is_kept_while_the_drain_is_behind(self):
        # Far from the rolling upper bound, the slack must not lapse the
        # width hint: recovery continues at twice the completed width.
        self.outage([])
        mark = "2026-10-02T12:00:00Z"
        before = "2026-10-02T12:10:00Z"
        self.q.update(merged_watermark=mark, merged_discovery={
            "after": mark, "before": before, "complete": False, "span": 600})
        crq.save_queue(self.q)
        with mock.patch.object(crq, "gh_json", side_effect=self.forge):
            log = crq.discover_merged(self.q, crq.ForgeBudget(),
                                      interval={"after": mark, "before": before}, recent=True)
        self.assertIn("complete=True", log[0])
        self.assertEqual(crq.load_queue()["merged_discovery"]["span"], 1200)

    def test_in_flight_attempt_keeps_the_partition_reason(self):
        # P3-2: a resumed attempt drops the superseded refusal's error text
        # but keeps the partition reason on the durable state, so status
        # reports the drain honestly mid-attempt (and across crashes).
        self.outage([3600 * k + 7 for k in range(45)])
        self.assertIn("partitioned", self.tick()[0])
        part = crq.load_queue()["merged_discovery"]
        with mock.patch.object(crq, "reconcile_merged",
                               side_effect=ValueError("fixture crash mid-attempt")):
            with self.assertRaises(ValueError):
                self.tick()
        md = crq.load_queue()["merged_discovery"]
        self.assertEqual((md["after"], md["before"]), (part["after"], part["before"]))
        self.assertFalse(md["complete"])
        self.assertEqual(md["reason"], "inventory-cap-partitioned")
        self.assertNotIn("error", md)
        import status_summary
        natural = status_summary.merged_current(crq.load_queue(), crq.STATE / "receipts")["natural_discovery"]
        self.assertEqual((natural["complete"], natural["reason"]), (False, "inventory-cap-partitioned"))
        self.assertNotIn("span", natural)
        self.drive()  # the drain still completes from this state

    def test_partition_bounds(self):
        t = "2026-10-01T00:{:02d}:{:02d}Z".format
        # Halves above the watermark, keeping the overlap below it.
        self.assertEqual(crq._partition(t(0, 0), t(10, 0), t(5, 0)), (t(0, 0), t(7, 30), 150))
        self.assertEqual(crq._partition(t(0, 0), t(0, 3), None), (t(0, 0), t(0, 1), 1))
        # An overlap too dense to fit starts at the watermark instead.
        self.assertEqual(crq._partition(t(0, 0), t(5, 1), t(5, 0)), (t(5, 0), t(5, 1), 1))
        # One second at the watermark over the cap still refuses.
        self.assertIsNone(crq._partition(t(5, 0), t(5, 1), t(5, 0)))
