"""Legacy history migration and bounded diagnostic evidence."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import admission_history as history
import backfill_jobs as jobs
import crq
import backfill_report


class HistoryTests(unittest.TestCase):
    def test_growth_and_refusal_evidence(self):
        q = {"items": [], "backfill_reservations": {
            str(i): {"quota_state": "released"} for i in range(1000)}}
        observation = {"successful": True, "remaining": 1, "observed_at": "2026-11-02T00:00:00Z",
                       "reflected_reservations": list(q["backfill_reservations"])}
        for _ in range(2000):
            decision = jobs.admission(q, {"id": "job"}, observation["observed_at"], observation, False)
        self.assertEqual(len(q["backfill_admissions"]), history.LIMIT)
        self.assertEqual(decision["decision"], "one-slot-reserve")
        self.assertEqual(decision["effective_remaining"], 1)
        self.assertEqual(decision["reservation_counts"], {"released": 1000})
        self.assertEqual(decision["observation"]["remaining"], 1)
        self.assertLess(len(json.dumps(q["backfill_admissions"])), 100000)
        self.assertNotIn("reflected_reservations", decision["observation"])

    def test_compaction_idempotent_preserves_authority_and_atomic_reload(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "queue.json"
            row = {"at": "now", "item": "job", "decision": "usage-unknown", "observation": None,
                   "reservations": {"attempt": {"quota_state": "reserved", "payload": "x" * 70000}}}
            original = {"items": [], "backfill_reservations": row["reservations"],
                        "queue_client_requests": {"receipt": {"state": "awaiting-pr"}},
                        "backfill_admissions": [row] * 300}
            path.write_text(json.dumps(original))
            before = path.stat().st_size
            with patch.object(crq, "QUEUE", path):
                original_bytes = path.read_bytes()
                preview = crq.load_queue()
                self.assertEqual(path.read_bytes(), original_bytes)
                q = crq.load_queue(persist_compaction=True)
                self.assertEqual(q, preview)
                after = path.read_bytes()
                self.assertEqual(q, crq.load_queue())
                self.assertEqual(after, path.read_bytes())
            self.assertLess(len(after), before // 10)
            self.assertEqual(q["backfill_reservations"], original["backfill_reservations"])
            self.assertEqual(q["queue_client_requests"], original["queue_client_requests"])
            self.assertEqual(q["backfill_admissions"][-1], history.summarize(row))
            self.assertEqual(history.load(path), (q, False))
            ranked = {"manifest_id": "m", "target": "t", "paths": [], "required": [], "evidence_gaps": []}
            report = backfill_report.summary(None, ranked, q)
            self.assertEqual(report["spare_quota_admissions"], q["backfill_admissions"])

    def test_invalid_input_never_replaced(self):
        for raw in ('{"items": [], "backfill_admissions": [', '{"items":[],}',
                    '{"items":[],"backfill_admissions": [ {}, ]}', '{"items":[]} extra'):
            with tempfile.TemporaryDirectory() as td:
                path = Path(td) / "queue.json"
                path.write_text(raw)
                with patch.object(crq, "QUEUE", path), self.assertRaises(ValueError):
                    crq.load_queue()
                self.assertEqual(path.read_text(), raw)
