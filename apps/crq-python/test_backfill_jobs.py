"""Offline admission, retries and crash-safe ownership; no providers invoked."""
from concurrent.futures import ThreadPoolExecutor
import copy
import datetime as dt
from pathlib import Path
import tempfile
import unittest

import backfill_jobs as jobs
import review_ledger as ledger

AT = "2026-10-30T00:00:00Z"


def partition(number=0, generation=0, target="a" * 40, path="a"):
    sid = str(number) * 64
    scope = [{"path": path, "blob": "b" * 40, "intervals": [[1, 2]]}]
    return {"subject_id": sid, "job_id": sid + ":" + str(generation), "generation": generation,
            "target": target, "scope": scope, "scope_digest": ledger.digest(scope), "family": "family",
            "kind": "A", "prs": [1], "partition": number}


class JobsTest(unittest.TestCase):
    def test_quota_deadline_survives_new_generation_and_target(self):
        q = {"items": []}
        old = jobs.enqueue(q, partition(), AT)
        jobs.admission(q, old, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        jobs.bind_run(q, old, "quota-run")
        jobs.defer_terminal_quota(q, old, AT, 3600)
        moved = jobs.enqueue(q, partition(1, generation=1, target="c" * 40), AT)
        self.assertFalse(jobs.eligible(q, moved, "2026-10-30T00:30:00Z"))
        self.assertTrue(jobs.eligible(q, moved, "2026-10-30T01:00:00Z"))
        self.assertEqual(q["backfill_reservations"][old["attempt_id"]]["quota_state"], "reserved")

    def test_atomic_effective_two_admits_only_one_and_reserve_survives_restart(self):
        with tempfile.TemporaryDirectory() as td:
            journal = jobs.Journal(Path(td) / "queue.json", Path(td) / "tick.lock")
            journal.transact(lambda q: [jobs.enqueue(q, partition(i, path=str(i)), AT) for i in range(2)])
            observation = {"successful": True, "observed_at": AT, "remaining": 2}
            def admit(i):
                return journal.transact(lambda q: jobs.admission(q, q["items"][i], AT, observation, False))
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(admit, range(2)))
            self.assertEqual(sum(r["decision"] == "admit" for r in results), 1)
            q = ledger.loads(journal.filename.read_bytes())
            self.assertEqual(len(q["backfill_reservations"]), 1)
            self.assertEqual(sum(jobs.is_execution_owner(i) for i in q["items"]), 1)
            self.assertIn("one-slot-reserve", [r["decision"] for r in results])

    def test_stale_unknown_quota_ordinary_priority_and_shared_cap(self):
        for observation in (None, {"successful": False}, {"successful": True, "remaining": 8, "observed_at": "2026-10-29T23:58:59Z"}):
            q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
            self.assertNotEqual(jobs.admission(q, item, AT, observation, False)["decision"], "admit")
        q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
        observation = {"successful": True, "remaining": 8, "observed_at": AT}
        self.assertEqual(jobs.admission(q, item, AT, observation, True)["decision"], "ordinary-eligible")
        self.assertEqual(jobs.admission(q, item, AT, observation, False)["decision"], "admit")
        # Later ordinary arrivals do not preempt already running backfill.
        self.assertTrue(jobs.is_execution_owner(item))
        q["items"].append({"id": "legacy", "kind": "coverage", "state": "reviewing", "run": {"id": "legacy"}})
        third = jobs.enqueue(q, partition(2, path="other"), AT)
        self.assertEqual(jobs.admission(q, third, AT, observation, False)["decision"], "rank4-inflight-cap")

    def test_generation_idempotence_three_failures_same_target_and_six_quarantine(self):
        q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
        self.assertIs(item, jobs.enqueue(q, partition(), AT))
        at = ledger.timestamp(AT)
        for i in range(3):
            stamp = at.strftime("%Y-%m-%dT%H:%M:%SZ")
            item.update(state="reviewing", vendor_state="live")
            jobs.terminal(q, item, stamp, "error", vendor_terminal=True)
            at += dt.timedelta(hours=24)
        self.assertEqual(item["state"], "blocked"); self.assertFalse(jobs.is_execution_owner(item))
        retry = jobs.enqueue(q, partition(generation=1), AT)
        self.assertEqual(retry["family_failures"], 3)
        self.assertNotEqual(retry["job_id"], item["job_id"])
        moved = jobs.enqueue(q, partition(1, generation=1, target="c" * 40), AT)
        self.assertEqual(moved["family_failures"], 3)
        for i in range(3):
            jobs.terminal(q, retry, at.strftime("%Y-%m-%dT%H:%M:%SZ"), "error", vendor_terminal=True)
            at += dt.timedelta(hours=24)
        self.assertEqual(retry["state"], "quarantined")
        self.assertFalse(jobs.eligible(q, moved, "2026-11-10T00:00:00Z"))
        jobs.release_quarantine(q, "family", "2026-11-10T00:00:00Z", "operator", "vendor recovered after investigation")
        self.assertTrue(q["backfill_operator_events"])

    def test_unknown_launch_retains_ownership_and_release_refuses(self):
        q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
        item.update(state="launch-unknown", vendor_state="unknown", failures=3)
        jobs.terminal(q, item, AT, "error", vendor_terminal=False)
        self.assertTrue(jobs.is_execution_owner(item))
        with self.assertRaises(ledger.IntegrityError):
            jobs.release(q, item, AT, "operator", "check", {"not_live": True})

    def test_unknown_launch_requires_bound_vendor_absence_and_known_prelaunch_cancel_releases_quota(self):
        q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
        observation = {"successful": True, "remaining": 2, "observed_at": AT}
        jobs.admission(q, item, AT, observation, False)
        with self.assertRaises(ledger.IntegrityError):
            jobs.reconcile_absent(q, item, AT, "operator", "checked", {"verdict": "vendor-confirmed-not-started"})
        proof = {"attempt_id": item["attempt_id"], "verdict": "vendor-confirmed-not-started", "vendor_query": {"sha256": "proof"}}
        jobs.reconcile_absent(q, item, AT, "operator", "authenticated run lookup found no invocation", proof)
        self.assertFalse(jobs.is_execution_owner(item))
        self.assertEqual(q["backfill_reservations"][item["attempt_id"]]["quota_state"], "released")
        self.assertEqual(item["state"], "pending")

    def test_failure_cooldown_and_immediate_quarantine_survive_serialization(self):
        q = {"items": []}; item = jobs.enqueue(q, partition(), AT)
        jobs.terminal(q, item, AT, "error", vendor_terminal=True, retry_after=7200)
        self.assertEqual(item["not_before"], "2026-10-30T02:00:00Z")
        q = ledger.loads(ledger.canonical(q)); item = q["items"][0]
        self.assertFalse(jobs.eligible(q, item, "2026-10-30T01:59:59Z"))
        self.assertTrue(jobs.eligible(q, item, "2026-10-30T02:00:00Z"))
        jobs.terminal(q, item, AT, "auth", vendor_terminal=True)
        self.assertEqual(item["state"], "quarantined")

    def test_publication_pending_owns_scope_not_slot_and_sibling_success_no_reset(self):
        q = {"items": []}; first = jobs.enqueue(q, partition(path="bad"), AT)
        jobs.terminal(q, first, AT, "error", vendor_terminal=True)
        sibling = jobs.enqueue(q, partition(1, path="good"), AT)
        jobs.terminal(q, sibling, AT, "completed", vendor_terminal=True)
        self.assertTrue(jobs.scope_owner(sibling)); self.assertFalse(jobs.is_execution_owner(sibling))
        jobs.published(q, sibling, sibling["scope"], "e" * 64)
        self.assertEqual(q["backfill_scope_failures"]["bad"]["failures"], 1)
        self.assertEqual(q["backfill_families"]["family"]["failures"], 1)


if __name__ == "__main__":
    unittest.main()
