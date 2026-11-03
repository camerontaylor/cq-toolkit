"""Review outcome classification: semantic terminal vocabulary and causes.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import json
import tempfile
from pathlib import Path
import unittest
from test_crq_fixtures import (
    COMPLETE,
    crq,
    setUpModule,
)

class ClassifierTest(unittest.TestCase):
    def test_semantic_terminal_and_negative_cases_match_ts_contract(self):
        cases = [([COMPLETE], 0, True),
                 ([{"type": "status"}, {"type": "review_context"}, {"type": "heartbeat"},
                   {"type": "finding", "severity": "major", "comment": "defect"}, COMPLETE], 0, True),
                 ([{**COMPLETE, "message": "No fresh detailed file review was performed in this run."}], 0, False),
                 ([{**COMPLETE, "status": "review_skipped"}], 0, False),
                 ([{**COMPLETE, "status": "unknown"}], 0, False),
                 ([COMPLETE, {"type": "finding", "severity": "major"}], 0, False),
                 ([COMPLETE, {"type": "heartbeat"}], 0, False),
                 ([COMPLETE, {"type": "review_context"}], 0, False),
                 ([COMPLETE, COMPLETE], 0, False),
                 ([{"type": "error", "message": "failure"}, COMPLETE], 0, False),
                 ([{"type": "action_required"}, COMPLETE], 0, False),
                 ([{"type": "unknown"}, COMPLETE], 0, False),
                 ([{"type": []}, COMPLETE], 0, False),
                 ([None, COMPLETE], 0, False), ([[], COMPLETE], 0, False),
                 ([{"type": "finding", "severity": []}, COMPLETE], 0, False),
                 ([{"type": "finding"}, COMPLETE], 0, False),
                 ([COMPLETE], 1, False), ([COMPLETE], None, False), ([], 0, False)]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for events, exit_code, counted in cases:
                with self.subTest(events=events, exit_code=exit_code):
                    path.write_text("\n".join(json.dumps(e) for e in events))
                    self.assertEqual(crq.classify(path, exit_code)["counted"], counted)
            for content in ("bad\n" + json.dumps(COMPLETE), json.dumps(COMPLETE) + "\nbad"):
                path.write_text(content)
                self.assertFalse(crq.classify(path, 0)["counted"])


    def test_all_causes_exact_vendor_vocabulary_and_exit_contract(self):
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True,
                  "metadata": {"waitTime": "2 minutes"}}
        cause = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for exit_code in (0, 1):
                path.write_text(json.dumps(vendor) + "\n" + json.dumps(vendor))
                cls = crq.classify(path, exit_code)
                self.assertEqual(cls["outcome"], "rate_limited")
                self.assertFalse(cls["counted"])
                self.assertEqual(cls["wait_seconds"], 120)
                self.assertEqual(cls["failure_provenance"],
                    {"version": 1, "complete": True, "causes": [cause, cause]})
            hard_events = [
                {"type": "error", "errorType": "scan", "message": "rate limit auth login quota"},
                {"type": "error", "errorType": "budget"},
                {"type": "error", "errorType": "cancel"},
                {"type": "error", "errorType": "unknown"},
                {"type": "error", "errorType": "rate_limit", "recoverable": False},
                {"type": "error", "errorType": "rate_limit", "recoverable": 1},
                {"type": "error", "errorType": "RATE_LIMIT", "recoverable": True},
                {"type": "action_required"}, {"type": "status", "status": "cancelled"},
                {"type": "status", "status": "budget_exhausted"},
                {"type": "status", "status": "scan_failed"},
                {"type": "finding", "severity": "major"}, COMPLETE]
            for hard_event in hard_events:
                for events in ([vendor, hard_event], [hard_event, vendor]):
                    with self.subTest(events=events):
                        path.write_text("\n".join(json.dumps(e) for e in events))
                        cls = crq.classify(path, 0)
                        self.assertNotEqual(cls["outcome"], "rate_limited")
                        self.assertFalse(cls["counted"])
                        causes = cls["failure_provenance"]["causes"]
                        self.assertIn(cause, causes)
                        self.assertTrue(any(c["source"] == "queue" for c in causes))
            for exit_code in (None, True, "1", -15, 2, 124, 137):
                with self.subTest(exit_code=exit_code):
                    path.write_text(json.dumps(vendor))
                    cls = crq.classify(path, exit_code)
                    self.assertNotEqual(cls["outcome"], "rate_limited")
                    self.assertTrue(any(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))
            for malformed in ("bad", json.dumps({"type": "unknown"})):
                path.write_text(json.dumps(vendor) + "\n" + malformed)
                cls = crq.classify(path, 1)
                self.assertFalse(cls["failure_provenance"]["complete"])
                self.assertNotEqual(cls["outcome"], "rate_limited")
            for error_type in ("review", "auth", "file_limit", "quota", "rate_limit_error"):
                path.write_text(json.dumps({"type": "error", "errorType": error_type,
                    "message": "rate limit: login required", "recoverable": True}))
                cls = crq.classify(path, 1)
                self.assertEqual(cls["outcome"], "auth" if error_type == "auth" else "error")
                self.assertEqual(cls["failure_provenance"]["causes"][0]["source"], "queue")


    def test_only_literal_structured_auth_is_an_operational_auth_stop(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for code in ("auth", "AUTH", "auth_error", "authentication", "unknown", None, []):
                for exit_code in (0, 1, None, 124):
                    with self.subTest(code=code, exit_code=exit_code):
                        path.write_text(json.dumps({"type": "error", "errorType": code,
                            "message": "auth login expired; authenticate", "recoverable": True}))
                        cls = crq.classify(path, exit_code)
                        self.assertEqual(cls["outcome"], "auth" if code == "auth" else
                                         "error")
                        self.assertFalse(cls["counted"])
                        self.assertTrue(all(c["source"] == "queue"
                            for c in cls["failure_provenance"]["causes"]))
            path.write_text(json.dumps({"type": "error", "errorType": "auth"}) + "\n" +
                            json.dumps({"type": "action_required"}))
            cls = crq.classify(path, 1)
            self.assertEqual(cls["outcome"], "action_required")
            self.assertFalse(cls["counted"])

    def test_recognized_progress_preserves_truthful_terminal_and_findings(self):
        progress_events = [{"type": "status", "status": status}
                           for status in ("scanning", "reviewing", "writing")]
        progress_events.append({"type": "heartbeat", "status": "reviewing"})
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for progress in progress_events:
                for severity in (None, "minor", "major"):
                    with self.subTest(progress=progress, severity=severity):
                        findings = [{"type": "finding", "severity": severity}] if severity else []
                        path.write_text("\n".join(json.dumps(e) for e in [progress, *findings, COMPLETE]))
                        cls = crq.classify(path, 0)
                        self.assertEqual(cls["outcome"], "completed")
                        self.assertTrue(cls["counted"])
                        self.assertEqual(cls["findings"], len(findings))
                        self.assertEqual(cls["failure_provenance"], {"version": 1, "complete": True,
                            "causes": [{"source": "queue", "category": "unknown", "code": "blocking-finding"}]
                            if severity == "major" else []})

    def test_progress_alone_trailing_progress_and_missing_exit_never_count(self):
        progress = {"type": "status", "status": "reviewing"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for events, exit_code in (([progress], 0), ([COMPLETE, progress], 0),
                    ([progress, COMPLETE, COMPLETE], 0), ([progress, COMPLETE], None),
                    ([progress, COMPLETE], True), ([progress, COMPLETE], 1),
                    ([progress, {**COMPLETE, "status": "review_skipped"}], 0),
                    ([progress, {**COMPLETE, "message": "No fresh detailed file review"}], 0)):
                with self.subTest(events=events, exit_code=exit_code):
                    path.write_text("\n".join(json.dumps(e) for e in events))
                    cls = crq.classify(path, exit_code)
                    self.assertFalse(cls["counted"])
                    self.assertNotEqual(cls["outcome"], "rate_limited")
                    self.assertTrue(cls["failure_provenance"]["causes"])
                    if type(exit_code) is not int:
                        self.assertFalse(cls["failure_provenance"]["complete"])

    def test_unknown_malformed_and_wrong_type_statuses_stay_incomplete(self):
        bad_events = [{"type": "status", "status": status} for status in
            ("unknown", "REVIEWING", "reviewing ", "scan_failed", "budget_exhausted",
             "cancelled", "awaiting_confirmation", None, [], {}, 1, True)]
        bad_events += [{"type": "review_context", "status": "reviewing"},
                       {"type": "finding", "severity": "minor", "status": "reviewing"},
                       {"type": "heartbeat", "status": "scanning"}]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for bad in bad_events:
                with self.subTest(bad=bad):
                    path.write_text("\n".join(json.dumps(e) for e in
                        [{"type": "status", "status": "reviewing"}, bad, COMPLETE]))
                    cls = crq.classify(path, 0)
                    self.assertFalse(cls["counted"])
                    self.assertFalse(cls["failure_provenance"]["complete"])
                    self.assertTrue(all(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))

    def test_progress_preserves_all_ordered_failure_causes_without_authorizing_them(self):
        progress = {"type": "status", "status": "reviewing"}
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        vendor_cause = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            path.write_text(json.dumps(progress) + "\n" + json.dumps(vendor))
            cls = crq.classify(path, 1)
            self.assertEqual(cls["outcome"], "rate_limited")
            self.assertFalse(cls["counted"])
            self.assertEqual(cls["failure_provenance"],
                             {"version": 1, "complete": True, "causes": [vendor_cause]})
            for code in ("unknown", "scan", "budget", "cancel"):
                hard_event = {"type": "error", "errorType": code}
                hard_cause = {"source": "queue", "category": "unknown", "code": code}
                for failures, causes in (([vendor, hard_event], [vendor_cause, hard_cause]),
                                         ([hard_event, vendor], [hard_cause, vendor_cause])):
                    with self.subTest(code=code, failures=failures):
                        path.write_text("\n".join(json.dumps(e) for e in [progress, *failures]))
                        cls = crq.classify(path, 0)
                        self.assertEqual(cls["outcome"], "error")
                        self.assertFalse(cls["counted"])
                        self.assertEqual(cls["failure_provenance"]["causes"], causes)
            for failure in ({"type": "action_required"}, {"type": "status", "status": "scan_failed"}):
                path.write_text("\n".join(json.dumps(e) for e in [progress, vendor, failure]))
                cls = crq.classify(path, 0)
                self.assertNotEqual(cls["outcome"], "rate_limited")
                self.assertFalse(cls["counted"])
                self.assertEqual(cls["failure_provenance"]["causes"][0], vendor_cause)
                self.assertTrue(any(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))
            path.write_text(json.dumps(progress) + "\nbad\n" + json.dumps(vendor))
            cls = crq.classify(path, 1)
            self.assertFalse(cls["failure_provenance"]["complete"])
            self.assertNotEqual(cls["outcome"], "rate_limited")
