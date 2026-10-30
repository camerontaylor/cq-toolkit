"""Operator commands require fresh exact evidence and never dispatch reviews."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import backfill
import backfill_history as history
import review_ledger as ledger
from test_backfill_accounting import Fixture

AT = "2026-10-30T00:00:00Z"


class OperatorTest(unittest.TestCase):
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
