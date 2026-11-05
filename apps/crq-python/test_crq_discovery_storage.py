"""Discovery persistence: queue/wrapper save faults and tick effects.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import unittest
from unittest import mock
from test_crq_discovery_wrapper import DiscoveryFailureFixture
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class DiscoveryFailureBoundaryTest(DiscoveryFailureFixture, unittest.TestCase):
    """Real discovery/persistence; temporary files and counter-only tick effects."""

    AFTER = "2026-10-01T00:00:00Z"
    BEFORE = "2026-10-03T00:00:00Z"

    def test_large_queue_preparation_does_not_spend_forge_deadline(self):
        self.q["backfill_admissions"] = [{"payload": "x" * 4096} for _ in range(512)]
        clock = mock.Mock(return_value=0.0)
        budget = crq.ForgeBudget(requests=2, seconds=30, clock=clock)
        atomic = crq.repair_tick.atomic

        def slow_save(path, value):
            clock.return_value += 40
            return atomic(path, value)

        def read(args):
            self.assertEqual(budget.take(), 10)
            return []

        self.forge.side_effect = read
        with mock.patch.object(crq.repair_tick, "atomic", side_effect=slow_save):
            crq.discover_merged(self.q, budget,
                interval={"after": self.AFTER, "before": self.BEFORE}, recent=True)
        self.assertTrue(self.q["merged_reconcile"]["complete"])
        self.assertEqual(budget.remaining, 1)
        self.assertEqual(self.q["merged_watermark"], self.BEFORE)

    def test_budget_exhaustion_is_not_transport_failure(self):
        for failure, reason, failures in (
                (crq.deferred_refresh.RefreshExhausted("exhausted"), "budget-exhausted", 0),
                (OSError("unavailable"), "transport-failure", 1)):
            with self.subTest(reason=reason):
                self.reset_case()
                self.forge.side_effect = failure
                log = crq.discover_merged(self.q, crq.ForgeBudget(),
                    interval={"after": self.AFTER, "before": self.BEFORE}, recent=True)
                summary = self.q["merged_reconcile"]
                self.assertEqual(summary["reason"], reason)
                self.assertEqual(summary["transient_failures"], failures)
                self.assertFalse(summary["complete"])
                self.assertEqual(self.q["merged_watermark"], self.AFTER)
                self.assertIn("reason=" + reason, log[0])

    def test_completed_interval_rerun_never_persists_incomplete_or_bumps_health(self):
        self.assertIn("complete=True", self.discover()[0])
        persisted = []
        save = crq._save_discovery_queue

        def record(q, stage):
            persisted.append((stage, copy.deepcopy(q["merged_discovery"])))
            return save(q, stage)

        def health():
            with mock.patch.object(crq.client_health, "advisory"), \
                    mock.patch.object(crq.client_health, "checkout_sha", return_value="a" * 40):
                crq.client_health.record(crq, self.q, discovery_enabled=True)
            return self.q["client_health"]["incomplete_ticks"]

        with mock.patch.object(crq, "_save_discovery_queue", side_effect=record):
            self.assertIn("complete=True", self.discover()[0])
        self.assertNotIn("bounds-save", [stage for stage, _ in persisted])
        self.assertTrue(persisted)
        self.assertTrue(all(value["complete"] is True for _, value in persisted))
        self.assertTrue(crq.load_queue()["merged_discovery"]["complete"])
        self.assertEqual(health(), 0)
        # A genuine refusal of the same completed bounds still reports incomplete.
        self.path.write_bytes(b"{")
        self.assertIn("incomplete", self.discover()[0])
        self.assertFalse(crq.load_queue()["merged_discovery"]["complete"])
        self.assertEqual(health(), 1)

    def test_wrapper_save_failure_stops_before_next_fetch(self):
        for write in (1, 3):
            for post in (False, True):
                with self.subTest(write=write, post=post):
                    self.reset_case(count=51)
                    baseline = copy.deepcopy(self.q)
                    with self.fault(wrapper_write=write, post=post):
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, "wrapper-save"):
                            self.discover()
                    self.assertEqual(self.q, baseline)
                    self.assertEqual(crq.load_queue(), baseline)
                    self.assertEqual(self.forge.call_count, 1 if write == 1 else 2)
                    # Read actual remaining disk bytes on a new invocation; no rollback.
                    fresh = crq.load_queue()
                    self.assertIn("complete=True", self.discover(fresh)[0])
                    self.assertEqual(len(fresh["items"]), 51)
                    self.assertTrue(all(item["state"] == "pending" for item in fresh["items"]))

    def test_queue_write_failure_discards_memory_and_never_retries(self):
        stages = ("bounds-save", "enrollment-save", "inventory-summary-save",
                  "discovery-summary-save", "watermark-save", "refusal-debt-save")
        for stage in stages:
            for post in (False, True):
                with self.subTest(stage=stage, post=post):
                    self.reset_case(count=201 if stage == "inventory-summary-save" else 1)
                    if stage == "bounds-save":
                        self.q.pop("merged_discovery")
                        crq.save_queue(self.q)
                    if stage == "refusal-debt-save":
                        self.path.write_bytes(b"{")
                    baseline = copy.deepcopy(self.q)
                    with self.fault(stage=stage, post=post) as events:
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                            self.discover()
                    self.assertEqual(self.q, baseline)
                    attempted = events[-1][2]
                    disk = crq.load_queue()
                    self.assertEqual(disk, attempted if post else
                        (events[-2][2] if len(events) > 1 and events[-2][0] == str(crq.QUEUE) else baseline))
                    self.assertTrue(all(item["state"] == "pending" for item in disk["items"]))
                    self.assertFalse(any(item.get("cycles") for item in disk["items"]))
                    if stage != "watermark-save" or not post:
                        self.assertEqual(disk["merged_watermark"], self.AFTER)
                    # Restart from disk, never from the discarded private view.
                    self.discover(disk)
                    self.assertFalse(any(item.get("cycles") for item in disk["items"]))

    def test_storage_failure_aborts_tick_before_follow_on_effects(self):
        for stage in ("bounds-save", "refusal-debt-save"):
            self.reset_case()
            if stage == "bounds-save":
                self.q.pop("merged_discovery")
            else:
                self.path.write_bytes(b"{")
            baseline = copy.deepcopy(self.q)
            with self.tick_effects() as effects, self.fault(stage=stage):
                with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                    crq.tick()
                effects["refresh_deferred"].assert_called_once()
                for name, effect in effects.items():
                    if name != "refresh_deferred":
                        effect.assert_not_called()
            self.assertEqual(self.q, baseline)

    def test_decode_refusal_allows_existing_tick_work_after_debt_commit(self):
        self.q["items"] = [{"id": "older-review", "kind": "open", "state": "reviewing",
                            "repair_runs": {"older-repair": {}}}]
        self.path.write_bytes(b"{")
        order = []
        save = crq._save_discovery_queue
        def record(q, stage):
            result = save(q, stage)
            order.append(stage)
            return result
        with self.tick_effects() as effects, \
                mock.patch.object(crq, "_save_discovery_queue", side_effect=record):
            effects["refresh_deferred"].side_effect = lambda *a, **k: order.append("refresh") or []
            crq.tick()
            # Identical frozen bounds are already durable; no rewrite.
            self.assertEqual(order[:2], ["refresh", "refusal-debt-save"])
            for name in ("harvest_review", "harvest", "enroll",
                         "read_slot_usage", "admit_available", "write_status", "write_heartbeat"):
                effects[name].assert_called_once()
        self.assertEqual(crq.load_queue()["merged_watermark"], self.AFTER)
        self.assertEqual(self.path.read_bytes(), b"{")
        self.forge.assert_not_called()

    def test_incomplete_and_manual_calls_never_publish_failed_save(self):
        for stage, count in (("inventory-summary-save", 201), ("enrollment-save", 1)):
            for post in (False, True):
                with self.subTest(stage=stage, post=post):
                    self.reset_case(count=count)
                    baseline = copy.deepcopy(self.q)
                    with self.fault(stage=stage, post=post):
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                            self.manual()
                    self.assertEqual(self.q, baseline)
