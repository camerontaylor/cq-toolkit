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
import review_ledger as ledger
import io


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

    def test_nested_duplicates_and_invalid_numbers_fail_before_journal_operation(self):
        cases = ('{"items": [{"id": "one", "id": "two"}]}',
                 '{"items": [], "backfill_admissions": [{"observation": {"remaining": 1, "remaining": 2}}]}',
                 '{"items": [], "value": 1.5}', '{"items": [], "value": NaN}',
                 '{"items": [], "backfill_admissions": [{"observation": {"remaining": 1.5}}]}')
        for raw in cases:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as td:
                journal = jobs.Journal(Path(td) / "queue.json", Path(td) / "tick.lock")
                journal.filename.write_text(raw)
                operation = unittest.mock.Mock()
                with self.assertRaises(ledger.IntegrityError):
                    journal.transact(operation)
                operation.assert_not_called()
                self.assertEqual(journal.filename.read_text(), raw)

    def test_invalid_version_marker_has_typed_error(self):
        for marker in (None, "1", 1.0, True, [], {}, -1, 2):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as td:
                path = Path(td) / "queue.json"
                path.write_text(json.dumps({history.MARKER: marker}))
                with self.assertRaisesRegex(ValueError, "unsupported admission history version"):
                    history.load(path)

    def test_first_non_tick_save_logs_once_even_after_queue_copy(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "queue.json"
            path.write_text(json.dumps({"items": [], "backfill_admissions": [{"decision": "usage-unknown"}]}))
            before = path.stat().st_size
            with patch.object(crq, "QUEUE", path), patch("sys.stderr", new_callable=io.StringIO) as log:
                q = json.loads(json.dumps(crq.load_queue()))
                self.assertEqual(log.getvalue(), "")
                crq.save_queue(q)
                self.assertIn(f"before_bytes={before} after_bytes={path.stat().st_size}", log.getvalue())
                crq.save_queue(q)
                self.assertEqual(log.getvalue().count("admission compaction v1"), 1)

    def test_journal_logs_first_compaction_only_after_successful_write(self):
        with tempfile.TemporaryDirectory() as td:
            journal = jobs.Journal(Path(td) / "queue.json", Path(td) / "tick.lock")
            journal.filename.write_text('{"items": [], "backfill_admissions": []}')
            with patch("sys.stderr", new_callable=io.StringIO) as log:
                with patch.object(ledger, "atomic", side_effect=OSError("save failed")):
                    with self.assertRaises(OSError):
                        journal.transact(lambda q: None)
                self.assertEqual(log.getvalue(), "")
                journal.transact(lambda q: None)
                journal.transact(lambda q: None)
                self.assertEqual(log.getvalue().count("admission compaction v1"), 1)

    def test_admission_summarized_once(self):
        with patch.object(history, "summarize", wraps=history.summarize) as summarize:
            decision = jobs.admission({"items": []}, {"id": "job"}, "2026-11-02T00:00:00Z", None, False)
            summarize.assert_called_once()
            self.assertEqual(decision["decision"], "usage-unknown")
