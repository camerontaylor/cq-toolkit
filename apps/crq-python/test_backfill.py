"""Operator commands require fresh exact evidence and never dispatch reviews."""
from pathlib import Path
import tempfile
import threading
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
                q = {"items": [{"id": "ordinary", "kind": "merged", "state": "pending"}], "diagnostic": "before",
                     "backfill_halted": "inventory failed", "backfill_halt_operation": "inventory"}
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
                        self.assertNotIn("backfill_halted", saved[0])
                        self.assertEqual(saved[0]["diagnostic"], "tick progressed")
                        self.assertEqual(saved[0]["items"][0]["state"], "done")
                        self.assertEqual(saved[0]["backfill_idle_with_candidate"], 3)
                        self.assertEqual(saved[0]["backfill_last_manifest"]["target"], "a" * 40)

    def test_inventory_skips_cleanly_when_queue_lock_stays_busy(self):
        with tempfile.TemporaryDirectory() as td:
            saved = []
            q = {"items": []}
            busy_at = {"snapshot": 1, "merge": 2}
            for phase, busy_call in busy_at.items():
                calls = []
                def lock(fn, *a, lock_wait=0, **kw):
                    calls.append(lock_wait)
                    return None if len(calls) == busy_call else fn(*a, **kw)
                c = SimpleNamespace(STATE=Path(td), with_lock=lock, load_queue=lambda: copy.deepcopy(q),
                                    save_queue=saved.append)
                prepared = {"queue": {}, "manifest": {}, "ranked": {}, "report": {}, "event_items": []}
                with self.subTest(phase=phase), \
                     mock.patch.object(backfill.runtime, "settings", return_value={}), \
                     mock.patch.object(backfill.runtime, "run_inventory", return_value=prepared) as run:
                    result = backfill.inventory_unlocked(c, SimpleNamespace(report_only=True))
                    self.assertEqual(result["inventory"], "skipped")
                    self.assertIn(phase, result["reason"])
                    self.assertFalse(saved)
                    self.assertEqual(run.called, phase == "merge")
                    self.assertEqual(calls[0], backfill.SNAPSHOT_LOCK_WAIT)
                    self.assertGreaterEqual(min(calls), 180)
                    self.assertFalse((Path(td) / "backfill/latest-report.json").exists())
                    self.assertFalse((Path(td) / "backfill/latest-ranked.json").exists())

    def test_inventory_skips_merge_when_run_budget_is_spent(self):
        with tempfile.TemporaryDirectory() as td:
            saved, waits = [], []
            def lock(fn, *a, lock_wait=0, **kw):
                waits.append(lock_wait)
                return fn(*a, **kw)
            c = SimpleNamespace(STATE=Path(td), with_lock=lock, load_queue=lambda: {"items": []},
                                save_queue=saved.append)
            prepared = {"queue": {}, "manifest": {}, "ranked": {}, "report": {}, "event_items": []}
            ticks = iter([0, backfill.RUN_BUDGET_S - 30])  # prepare used nearly the whole budget
            with mock.patch.object(backfill.runtime, "settings", return_value={}), \
                 mock.patch.object(backfill.runtime, "run_inventory", return_value=prepared):
                result = backfill.inventory_unlocked(c, SimpleNamespace(report_only=True), clock=lambda: next(ticks))
            self.assertEqual(result["inventory"], "skipped")
            self.assertIn("budget", result["reason"])
            self.assertEqual(waits, [backfill.SNAPSHOT_LOCK_WAIT])  # merge lock never requested
            self.assertFalse(saved)

    def test_operator_command_reports_busy_lock_as_error(self):
        import io, sys
        fake = SimpleNamespace(with_lock=lambda *a, **kw: None)
        out = io.StringIO()
        with mock.patch.dict(sys.modules, {"crq": fake}), \
             mock.patch.object(sys, "argv", ["backfill.py", "baseline"]), \
             mock.patch("sys.stdout", out), self.assertRaises(SystemExit) as raised:
            backfill.main()
        self.assertEqual(raised.exception.code, 3)
        self.assertIn("queue lock busy", out.getvalue())

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

    def test_history_catalog_serializes_across_state_directories(self):
        for initial in (None, b"previous catalog"):
            with self.subTest(initial=initial), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                output = root / "catalog.json"
                (root / "alias").symlink_to(root, target_is_directory=True)
                if initial is not None:
                    output.write_bytes(initial)
                entered = threading.Event()
                release = threading.Event()
                attempted = threading.Event()
                newer_entered = threading.Event()
                failures = []
                held = {}
                snapshots = []
                def context(name):
                    state = root / name
                    held[state] = False
                    def lock(fn, **kwargs):
                        with ledger.locked(state / "tick.lock"):
                            held[state] = True
                            try:
                                return fn()
                            finally:
                                held[state] = False
                    def load():
                        snapshots.append(name)
                        return {"items": []}
                    return SimpleNamespace(STATE=state, with_lock=lock, load_queue=load)
                older, newer = context("older"), context("newer")
                def collect(queue, state, store, **kwargs):
                    self.assertFalse(held[state])
                    if state == older.STATE:
                        entered.set()
                        self.assertTrue(release.wait(5))
                    elif state == newer.STATE:
                        newer_entered.set()
                    return {"sources": [state.name], "acquisition": {}}
                real_locked = ledger.locked
                def locked(path):
                    if threading.current_thread().name == "newer" and str(path).endswith(".collect-history.lock"):
                        attempted.set()
                    return real_locked(path)
                def run(c):
                    try:
                        destination = root / "alias/catalog.json" if c is newer else output
                        backfill.collect_history_unlocked(c, SimpleNamespace(output=str(destination), github=False))
                    except BaseException as exc:
                        failures.append(exc)
                first = threading.Thread(target=run, args=(older,), name="older")
                second = threading.Thread(target=run, args=(newer,), name="newer")
                with mock.patch.object(backfill.runtime, "settings", return_value={"enabled": True}), \
                     mock.patch.object(backfill.runtime, "services", return_value=(None, None, None, None)), \
                     mock.patch.object(history, "collect_sources", side_effect=collect), \
                     mock.patch.object(ledger, "locked", side_effect=locked):
                    first.start()
                    try:
                        self.assertTrue(entered.wait(5))
                        second.start()
                        self.assertTrue(attempted.wait(5))
                        self.assertFalse(newer_entered.wait(0.1))
                        self.assertEqual(snapshots, ["older"])
                        # Another output can finish while the first collector
                        # still holds its catalog lock and the second waits.
                        independent = context("independent")
                        other_output = root / "other.json"
                        backfill.collect_history_unlocked(independent, SimpleNamespace(output=str(other_output), github=False))
                        self.assertEqual(ledger.loads(other_output.read_bytes())["sources"], ["independent"])
                    finally:
                        release.set()
                        first.join(5)
                        if second.ident is not None:
                            second.join(5)
                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(snapshots, ["older", "independent", "newer"])
                self.assertEqual(ledger.loads(output.read_bytes())["sources"], ["newer"])

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
