"""Optional cycle admission: parked merged rows and required work.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import tempfile
from pathlib import Path
import unittest
from unittest import mock
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class OptionalCycleWaitTest(unittest.TestCase):
    """Q14: a parked merged row never starts, so it must not demand a wait."""

    def optional(self, **over):
        return dict(dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}],
                         optional_cycle=True, order=1), **over)

    def merged(self, pr=42, **over):
        return dict(dict(id=f"merged-{pr}", pr=pr, kind="merged", state="pending", order=2), **over)

    def receipt(self, pr=42, **over):
        return dict(dict(id=f"current-{pr}", pr=pr, kind=crq.review_receipt.KIND,
                         state="pending", order=3), **over)

    @staticmethod
    def callsite_parks(item, items):
        """crq.tick()'s admission predicate, verbatim from the base pin."""
        return item["kind"] == "merged" and any(
            i.get("kind") == crq.review_receipt.KIND and i.get("pr") == item["pr"] for i in items)

    def test_parked_merged_row_does_not_demand_an_optional_wait(self):
        optional, merged, receipt = self.optional(), self.merged(), self.receipt()
        q = dict(items=[optional, merged, receipt])
        # A pending linked receipt is startable work in its own right: it still demands the wait.
        self.assertTrue(crq.optional_wait(q, optional))
        for state in ("done", "blocked", "skipped"):
            with self.subTest(receipt_state=state):
                receipt["state"] = state      # the park rule ignores the receipt state
                # Terminal receipt: only the parked merged row is left, and it never starts.
                self.assertFalse(crq.optional_wait(q, optional))

    def test_optional_cycle_still_waits_for_startable_required_work(self):
        optional = self.optional()
        self.assertTrue(crq.optional_wait(dict(items=[optional, self.merged()]), optional))
        self.assertTrue(crq.optional_wait(
            dict(items=[optional, self.merged(), self.receipt(pr=43)]), optional))
        self.assertTrue(crq.optional_wait(dict(items=[optional, self.receipt()]), optional))
        self.assertTrue(crq.optional_wait(dict(items=[
            optional, self.merged(), self.receipt(),
            dict(id="pr9", pr=9, kind="open", state="pending", order=4)]), optional))

    def test_park_predicate_matches_the_admission_callsite_for_every_row_shape(self):
        cases = [[self.merged(), self.receipt()],
                 [self.merged(), self.receipt(state="done")],
                 [self.merged(), self.receipt(pr=43)],
                 [self.merged()],
                 [self.receipt(), self.merged(pr=43)],
                 [self.merged(), dict(id="cov", pr=42, kind="coverage", state="pending")],
                 [self.receipt()]]
        for items in cases:
            for item in items:
                with self.subTest(rows=[i["id"] for i in items], row=item["id"]):
                    self.assertEqual(crq.parked_merged_linked_receipt(dict(items=items), item),
                                     self.callsite_parks(item, items))


class OptionalCycleAdmissionTest(unittest.TestCase):
    """Q14: the parked row yields the start slot instead of starving rank 5."""

    def setUp(self):
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
        for name, value in (
                ("load_queue", lambda **kwargs: self.q), ("fetch", mock.Mock()),
                ("gh_json", mock.Mock(side_effect=AssertionError("unmocked forge in admission fixture"))),
                ("enroll", lambda q, dry: []), ("discover_merged", lambda q, budget: []),

                 ("save_queue", mock.Mock()),
                ("write_status", mock.Mock()), ("write_heartbeat", mock.Mock()),
                ("notify_owner", mock.Mock()), ("event", mock.Mock()),
                ("coverage_fallback", lambda *a: (None, False)),

                ("STATE", self.root),
                ("CONFIG", {"max_starts_per_hour": 5, "max_inflight": 2,
                            "stale_alarm_min": 36, "repair": {}})):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        for name in ("backfill", "archive_legacy", "reconcile_fix_prs"):
            patch = mock.patch.object(crq.repair_tick, name, mock.Mock())
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(crq.coverage, "record_opportunity", lambda *a, **k: {})
        patch.start()
        self.addCleanup(patch.stop)

    def rows(self):
        """The linked receipt is terminal: the park rule ignores its state."""
        return (dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}],
                     optional_cycle=True, order=1),
                dict(id="merged-42", pr=42, kind="merged", state="pending", order=2),
                dict(id="current-42", pr=42, kind=crq.review_receipt.KIND, state="done", order=3))

    def start(self):
        plan = dict(base="a" * 40, head="b" * 40, notes=[], label="additional cycle (optional)")
        with mock.patch.object(crq, "pr_info", return_value={"state": "OPEN"}), \
             mock.patch.object(crq, "quiet_reason", return_value=None), \
             mock.patch.object(crq, "plan_open", return_value=plan), \
             mock.patch.object(crq, "launch", return_value="run") as launch:
            crq.tick()
        return launch

    def test_parked_merged_row_no_longer_starves_the_optional_cycle(self):
        self.q["items"] = list(self.rows())
        launch = self.start()
        self.assertEqual(launch.call_args.args[1]["id"], "pr1")

    def test_startable_required_work_still_precedes_the_optional_cycle(self):
        optional, merged, receipt = self.rows()
        open_row = dict(id="pr9", pr=9, kind="open", state="pending", order=0)
        self.q["items"] = [open_row, merged, receipt, optional]
        launch = self.start()
        self.assertEqual(launch.call_args.args[1]["id"], "pr9")
