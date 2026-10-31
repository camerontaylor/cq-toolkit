"""Operator commands require fresh exact evidence and never dispatch reviews."""
from pathlib import Path
import tempfile
import copy
from types import SimpleNamespace
import unittest
from unittest import mock

import backfill
import coverage as coverage_policy
import backfill_history as history
import review_ledger as ledger
from test_backfill_accounting import Fixture

AT = "2026-10-30T00:00:00Z"


class OperatorTest(unittest.TestCase):
    def test_inventory_prepares_unlocked_and_merges_current_queue(self):
        for stale in (None, "items", "backfill_scope_failures", "backfill_path_lineages", "config"):
            with self.subTest(stale=stale), tempfile.TemporaryDirectory() as td:
                q = {"items": [{"id": "ordinary", "kind": "merged", "state": "pending"}], "diagnostic": "before"}
                held = [False]
                config = {"enabled": True}
                saved = []
                def lock(fn, **kwargs):
                    self.assertFalse(held[0])
                    held[0] = True
                    try:
                        return fn()
                    finally:
                        held[0] = False
                def load():
                    self.assertTrue(held[0])
                    return copy.deepcopy(q)
                def prepare(c, snapshot, **kwargs):
                    self.assertFalse(held[0])  # Git/GitHub/construction live here.
                    self.assertTrue(kwargs["prepare_only"])
                    self.assertFalse(kwargs["enqueue"])
                    q["diagnostic"] = "tick progressed"
                    q["items"][0]["state"] = "done"
                    q["backfill_idle_with_candidate"] = 3
                    if stale == "config":
                        config["enabled"] = False
                    elif stale:
                        q[stale] = [{"kind": "backfill", "vendor_state": "live"}] if stale == "items" else {"changed": True}
                    snapshot["backfill_last_manifest"] = {"target": "a" * 40}
                    return {"queue": snapshot, "manifest": {}, "ranked": {}, "report": {}, "event_items": []}
                c = SimpleNamespace(STATE=Path(td), with_lock=lock, load_queue=load, save_queue=saved.append)
                with mock.patch.object(backfill.runtime, "settings", side_effect=lambda _: copy.deepcopy(config)), \
                     mock.patch.object(backfill.runtime, "run_inventory", side_effect=prepare):
                    if stale:
                        with self.assertRaisesRegex(ledger.IntegrityError, "snapshot stale"):
                            backfill.inventory_unlocked(c, SimpleNamespace(report_only=True))
                        self.assertFalse(saved)
                        self.assertFalse((Path(td) / "backfill/latest-report.json").exists())
                    else:
                        backfill.inventory_unlocked(c, SimpleNamespace(report_only=True))
                        self.assertEqual(saved[0]["diagnostic"], "tick progressed")
                        self.assertEqual(saved[0]["items"][0]["state"], "done")
                        self.assertEqual(saved[0]["backfill_idle_with_candidate"], 3)
                        self.assertEqual(saved[0]["backfill_last_manifest"]["target"], "a" * 40)

    def test_legacy_quarantine_release_binds_scope_history_and_ownership(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = {"id": "source", "pr": 7, "kind": "merged", "measure": {"files": [
                {"path": "a.py", "now": "a.py"}, {"path": "b.py", "now": "b.py"}]}}
            item = {"id": "legacy", "kind": "coverage", "state": "blocked", "pr": 7,
                    "coverage_source": "source", "coverage_paths": ["a.py"], "attempts": [], "failures": 6}
            q = {"items": [source, item]}
            for index in range(6):
                stamp = f"2026-10-{20 + index:02d}T00:00:00Z"
                run = f"run-{index}"
                item["attempts"].append({"run_id": run, "outcome": "error", "counted": False,
                                         "at": stamp, "head": "a" * 40, "base": "b" * 40})
                coverage_policy.record_legacy_failure(q, item, stamp, "error", run)
            sibling = coverage_policy._legacy_family(7, "b.py")
            q["backfill_families"][sibling] = {"failures": 4, "quarantined": False, "next_eligible_at": None}
            family = coverage_policy._legacy_family(7, "a.py")
            before_attempts = ledger.canonical(item["attempts"])
            before_family = ledger.canonical(q["backfill_families"][family])
            q["backfill_operator_events"] = [{"family": family, "operator": "someone", "reason": "unmatched"}]
            self.assertFalse(coverage_policy.legacy_retry_view(q, 7, "a.py", AT)["allowed"])
            evidence = {"family": family, "queue_digest": backfill.queue_digest_v1(q), "checked_at": AT,
                        "exact_no_live_run": True, "checked_runs": [f"run-{i}" for i in range(6)]}
            evidence_file = root / "evidence.json"; evidence_file.write_bytes(ledger.canonical(evidence))
            c = SimpleNamespace(STATE=root, load_queue=lambda: q, iso=lambda: AT, save_queue=lambda queue: None)
            args = SimpleNamespace(command="quarantine-release", family=family, evidence=str(evidence_file),
                                   operator="operator", reason="terminal scope investigated")
            with mock.patch.object(backfill.runtime, "settings", return_value={"enabled": True}), \
                 mock.patch.object(backfill.runtime, "services", return_value=(None, None, None, None)):
                item["run"] = {"run_id": "live"}
                evidence["queue_digest"] = backfill.queue_digest_v1(q); evidence_file.write_bytes(ledger.canonical(evidence))
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)
                item.pop("run")
                item["vendor_state"] = "unknown"
                evidence["queue_digest"] = backfill.queue_digest_v1(q); evidence_file.write_bytes(ledger.canonical(evidence))
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)
                item.pop("vendor_state")
                for state in ("reviewing", "launch-unknown"):
                    item["state"] = state
                    evidence["queue_digest"] = backfill.queue_digest_v1(q); evidence_file.write_bytes(ledger.canonical(evidence))
                    with self.assertRaises(ledger.IntegrityError):
                        backfill.execute(c, args)
                    self.assertNotIn("legacy_coverage_releases", q)
                item["state"] = "blocked"
                evidence["queue_digest"] = backfill.queue_digest_v1(q); evidence_file.write_bytes(ledger.canonical(evidence))
                self.assertTrue(backfill.execute(c, args)["released"])
                self.assertTrue(coverage_policy.legacy_retry_view(q, 7, "a.py", AT)["allowed"])
                self.assertEqual(ledger.canonical(item["attempts"]), before_attempts)
                self.assertEqual(ledger.canonical(q["backfill_families"][family]), before_family)
                self.assertEqual(q["legacy_coverage_releases"][0]["reason"], "terminal scope investigated")
                self.assertEqual(q["backfill_families"][sibling]["failures"], 4)
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)  # old evidence binds the pre-release queue
                evidence["queue_digest"] = backfill.queue_digest_v1(q); evidence_file.write_bytes(ledger.canonical(evidence))
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)  # a fresh assertion cannot release an already released epoch
                self.assertEqual(len(q["legacy_coverage_releases"]), 1)
                after_release = "2026-10-30T00:01:00Z"
                item["attempts"].append({"run_id": "new-run", "outcome": "error", "counted": False,
                                         "at": after_release, "head": "a" * 40, "base": "b" * 40})
                item["failures"] = 7
                coverage_policy.record_legacy_failure(q, item, after_release, "error", "new-run")
                later = coverage_policy.legacy_retry_view(q, 7, "a.py", "2026-11-01T00:00:00Z")
                self.assertEqual(later["failures"], 1)
                self.assertTrue(later["allowed"])
                for index in range(5):
                    stamp = f"2026-11-{index+1:02d}T00:00:00Z"; run = f"later-{index}"
                    item["attempts"].append({"run_id": run, "outcome": "error", "counted": False,
                                             "at": stamp, "head": "a" * 40, "base": "b" * 40})
                    item["failures"] += 1
                    coverage_policy.record_legacy_failure(q, item, stamp, "error", run)
                second_at = "2026-11-10T00:00:00Z"
                self.assertFalse(coverage_policy.legacy_retry_view(q, 7, "a.py", second_at)["allowed"])
                c.iso = lambda: second_at
                evidence.update(checked_at=second_at, queue_digest=backfill.queue_digest_v1(q),
                                checked_runs=["new-run"] + [f"later-{i}" for i in range(5)])
                evidence_file.write_bytes(ledger.canonical(evidence))
                self.assertTrue(backfill.execute(c, args)["released"])
                self.assertTrue(coverage_policy.legacy_retry_view(q, 7, "a.py", second_at)["allowed"])
                self.assertEqual(len(q["legacy_coverage_releases"]), 2)
                self.assertEqual(q["backfill_families"][family]["failures"], 12)
                args.family = "nonexistent"
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)

    def test_release_queue_digest_handles_unicode_and_finite_diagnostics(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            queue = {"items": [{"id": "coverage-test", "kind": "coverage", "state": "blocked", "run": None}], "notes": "waiting — verify", "diagnostic": 1.5}
            saved = []
            c = SimpleNamespace(STATE=root, load_queue=lambda: queue, iso=lambda: AT, save_queue=lambda q: saved.append(q))
            evidence = {"item": "coverage-test", "queue_digest": backfill.queue_digest_v1(queue), "checked_at": AT, "vendor_state": "terminal", "exact_no_live_run": True}
            file = root / "evidence.json"; file.write_bytes(ledger.canonical(evidence))
            args = SimpleNamespace(command="release", item="coverage-test", evidence=str(file), operator="fixture", reason="verified")
            backfill.execute(c, args)
            self.assertEqual(queue["items"][0]["state"], "skipped")
            self.assertEqual(len(saved), 1)
            with self.assertRaises(ValueError):
                backfill.queue_digest_v1({"diagnostic": float("nan")})

    def test_history_retry_reuses_unpublished_outbox_record(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fixture = Fixture(root / "repo")
            outbox = ledger.Outbox(root / "outbox", fixture.store)
            catalog = root / "catalog.json"
            catalog.write_bytes(ledger.canonical({"sources": [{"class": history.CLASSES[0], "id": "source-1", "raw_artifact": fixture.store.put(b"{}"), "envelope": {}}]}))
            times = iter([AT, "2026-10-31T00:00:00Z"])
            c = SimpleNamespace(STATE=root, load_queue=lambda: {"items": []}, iso=lambda: next(times))
            publisher = SimpleNamespace(fetch=lambda: ("head", []))
            args = SimpleNamespace(command="import-history", catalog=str(catalog))
            with mock.patch.object(backfill.runtime, "settings", return_value={"enabled": True}), mock.patch.object(backfill.runtime, "services", return_value=(fixture.repo, fixture.store, outbox, publisher)):
                first = backfill.execute(c, args)
                saved = ledger.canonical(outbox.retained())
                second = backfill.execute(c, args)
            self.assertEqual(first["publication_pending"], 1)
            self.assertEqual(second["publication_pending"], 0)
            self.assertEqual(ledger.canonical(outbox.retained()), saved)
            self.assertEqual(len(outbox.pending()), 1)

    def test_stale_release_fresh_exact_queue_no_live_evidence_and_reason(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); queue = {"items": [{"id": "coverage-ab612ba1a041484d", "kind": "coverage", "state": "blocked", "run": None}]}
            saved = []
            c = SimpleNamespace(STATE=root, load_queue=lambda: queue, iso=lambda: AT, save_queue=lambda q: saved.append(ledger.canonical(q)))
            evidence = {"item": queue["items"][0]["id"], "queue_digest": ledger.digest(queue), "checked_at": AT,
                        "vendor_state": "terminal", "exact_no_live_run": True, "checked_runs": ["fixture-terminal"]}
            file = root / "evidence.json"; file.write_bytes(ledger.canonical(evidence))
            args = SimpleNamespace(command="release", item=evidence["item"], evidence=str(file), operator="fixture-operator", reason="exact run identities verified terminal")
            result = backfill.execute(c, args)
            self.assertEqual(result["released"], evidence["item"])
            self.assertEqual(queue["items"][0]["state"], "skipped")
            self.assertEqual(len(saved), 1)

    def test_wrong_queue_or_live_owner_never_releases(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); queue = {"items": [{"id": "coverage-ab612ba1a041484d", "kind": "coverage", "state": "blocked", "run": {"run_id": "unknown"}}]}
            c = SimpleNamespace(STATE=root, load_queue=lambda: queue, iso=lambda: AT, save_queue=lambda q: self.fail("must not write"))
            file = root / "evidence.json"
            args = SimpleNamespace(command="release", item=queue["items"][0]["id"], evidence=str(file), operator="operator", reason="verified")
            for queue_digest in ("incorrect", ledger.digest(queue)):
                file.write_bytes(ledger.canonical({"item": args.item, "queue_digest": queue_digest, "checked_at": AT,
                                                   "vendor_state": "terminal", "exact_no_live_run": True}))
                with self.assertRaises(ledger.IntegrityError):
                    backfill.execute(c, args)

    def test_timer_inert_six_hour_schedule_shared_cli_and_stage2_switch(self):
        root = Path(__file__).resolve().parent
        timer = (root / "ops/systemd/crq-backfill.timer").read_text()
        service = (root / "ops/systemd/crq-backfill.service").read_text()
        self.assertIn("00,06,12,18:00:00 UTC", timer)
        self.assertIn("ConditionPathExists=@CRQ_ROOT@/state/backfill-rollout.json", service)
        self.assertIn("backfill.py inventory", service)
        example = ledger.loads((root / "ops/backfill-rollout.example.json").read_bytes())
        self.assertIs(example["enabled"], False)
        self.assertEqual(example["inventory_mode"], "timer")


if __name__ == "__main__":
    unittest.main()
