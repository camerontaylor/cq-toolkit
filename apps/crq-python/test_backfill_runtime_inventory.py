"""Inventory bounds pin age: superseded pending jobs retire and one run enqueues a bounded set."""
import unittest
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class StalePinInventoryTest(RuntimeTestBase):
    def setUp(self):
        super().setUp()
        tiers = ledger.loads((runtime.ROOT / "policy/review-tiers.json").read_bytes())
        limits = {**ledger.loads((runtime.ROOT / "policy/review-limits.json").read_bytes()), "reviewer": self.policy["reviewer"]}
        self.limits = limits
        required = {"version": 1, "rows": [{"row": 1, "pr": 1}], "explicit_unions": []}
        patch = mock.patch.object(runtime, "policies", return_value=(tiers, limits, required))
        patch.start(); self.addCleanup(patch.stop)

    def advance(self, files=None):
        tip = self.f.commit(files or {"b": b"x\ny\n"})
        self.f.git("update-ref", "refs/remotes/origin/main", tip)
        return tip

    def inventory(self, **kwargs):
        paths = {"1": [{"path": "a"}, {"path": "b"}]}
        return runtime.run_inventory(self.c, self.q, required_paths=paths, members={}, fetch=False, **kwargs)

    def eligible_lines(self, ranked, path):
        row = next(r for r in ranked["paths"] if r["path"] == path)
        return row["eligible"]

    def test_pending_job_at_older_pin_is_retired_and_its_lines_rerank_at_the_tip(self):
        old = self.item
        tip = self.advance({"a": b"one\ntwo\n", "b": b"x\ny\n"})
        manifest, ranked, _ = self.inventory()
        self.assertEqual(old["state"], "skipped")
        self.assertEqual(old["last_error"], "superseded by inventory " + tip)
        self.assertTrue(self.eligible_lines(ranked, "a"))
        fresh = [i for i in self.q["items"] if i is not old and i["target"] == tip]
        self.assertTrue(fresh)
        self.assertTrue(all(i["state"] == "pending" for i in fresh))

    def test_owned_jobs_and_current_pin_jobs_are_kept(self):
        tip = self.advance()
        keep = {}
        for name in ("reviewing", "publication-pending", "launch-unknown", "quarantined"):
            item = {**self.item, "id": "keep-" + name, "job_id": "keep-" + name, "state": name}
            self.q["items"].append(item); keep[name] = item
        current = {**self.item, "id": "keep-current", "job_id": "keep-current", "target": tip}
        self.q["items"].append(current)
        self.inventory()
        for name, item in keep.items():
            self.assertEqual(item["state"], name)
        self.assertEqual(current["state"], "pending")
        self.assertEqual(self.item["state"], "skipped")

    def test_owned_jobs_at_the_older_pin_alone_keep_their_lines_owned(self):
        # 2210 F1: no pending job at the tip here, so only the owned jobs can
        # hold path "a"; the same inventory without them ranks its lines.
        self.advance()
        for name in ("reviewing", "publication-pending", "launch-unknown", "quarantined"):
            self.q["items"].append({**self.item, "id": "keep-" + name, "job_id": "keep-" + name, "state": name})
        _, ranked, _ = self.inventory()
        self.assertEqual(self.item["state"], "skipped")
        self.assertEqual(self.eligible_lines(ranked, "a"), [])

    def test_without_owned_jobs_the_same_lines_are_eligible(self):
        self.advance()
        _, ranked, _ = self.inventory()
        self.assertTrue(self.eligible_lines(ranked, "a"))

    def test_expired_jobs_at_the_current_pin_are_released_and_do_not_fill_the_cap(self):
        # Quiet main: 32 pending jobs at the tip are all past 24 h; a new inventory still enqueues.
        tip = self.advance()
        self.q["items"] = []
        for n in range(runtime.INVENTORY_ENQUEUE_LIMIT):
            self.q["items"].append({**self.item, "id": "stale-%d" % n, "job_id": "stale-%d" % n, "target": tip,
                                    "created_at": "2026-10-28T00:00:00Z"})  # AT is 2026-10-30T00:00:00Z
        stale = list(self.q["items"])
        self.inventory()
        for item in stale:
            self.assertEqual(item["state"], "skipped")
            self.assertEqual(item["last_error"], "expired: pending more than 24 h")
        self.assertTrue([i for i in self.q["items"] if i["state"] == "pending" and i["target"] == tip])

    def test_unreadable_created_at_is_reported_as_such_not_as_age(self):
        tip = self.advance()
        bad = {**self.item, "id": "bad-ts", "job_id": "bad-ts", "target": tip, "created_at": "bad"}
        gone = {**self.item, "id": "no-ts", "job_id": "no-ts", "target": tip}
        del gone["created_at"]
        self.q["items"] += [bad, gone]
        self.inventory()
        self.assertEqual(bad["last_error"], "expired: unreadable created_at")
        self.assertEqual(gone["last_error"], "expired: unreadable created_at")

    def test_report_only_retires_nothing(self):
        self.advance()
        self.inventory(enqueue=False)
        self.assertEqual(self.item["state"], "pending")

    def test_prepare_only_returns_retired_ids_without_events(self):
        tip = self.advance()
        with mock.patch.object(runtime, "state_event") as event:
            result = self.inventory(prepare_only=True)
        self.assertEqual(result["retired"], [self.item["id"]])
        self.assertEqual(result["target"], tip)
        self.assertNotIn(self.item["id"], [call.args[2]["id"] for call in event.call_args_list])

    def test_enqueue_stops_at_the_cap_and_leaves_the_rest_eligible(self):
        self.limits["max_files"] = 1  # one partition per file
        names = ["src/kernel/a.ts", "apps/crq-python/z.py", "docs/x", "src/new.ts", "unknown/future"]
        self.advance({n: b"m\nn\n" for n in names})
        paths = {"1": [{"path": n} for n in ["a", *names]]}
        _, free, _ = runtime.run_inventory(self.c, {"items": [], "starts": []}, required_paths=paths, members={}, fetch=False)
        candidates = len(free["candidates"])
        self.assertGreater(candidates, 1)
        with mock.patch.object(runtime, "INVENTORY_ENQUEUE_LIMIT", 1):
            _, ranked, _ = runtime.run_inventory(self.c, self.q, required_paths=paths, members={}, fetch=False)
        pending = [i for i in self.q["items"] if i["state"] == "pending"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(len(ranked["candidates"]), candidates)  # the rest stay ranked and eligible
        enqueued = {x["path"] for i in pending for x in i["scope"]}
        beyond = [path for c in ranked["candidates"] for path in c["paths"] if path not in enqueued]
        self.assertEqual(len(beyond), candidates - 1)
        for path in beyond:  # candidates past the cap stay eligible for the next inventory
            self.assertTrue(self.eligible_lines(ranked, path), path)


if __name__ == "__main__":
    unittest.main()
