"""Four historical source classes are accounted, without inferred path credit."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

import backfill_history as history
import review_ledger as ledger
from test_backfill_accounting import Fixture

AT = "2026-10-30T00:00:00Z"


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name) / "repo")
        self.t = self.f.commit({"a": b"one\ntwo\n"})
        self.value = self.f.full_review(self.t, "a", [[1, 2]])

    def envelope(self):
        return {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app", "exit_code": 0,
                "completed_at": AT, "review_payload": copy.deepcopy(self.value["payload"])}

    def stream(self, files=None, head=None):
        return ledger.canonical({"type": "complete", "status": "review_completed", "head": head or self.value["payload"]["head"],
                                 "reviewedFiles": files if files is not None else self.value["payload"]["input_scope"]})

    def test_positive_credit_duplicate_cross_class_and_repeat_idempotence(self):
        raw, envelope = self.stream(), self.envelope()
        first, result = history.import_source(self.f.repo, self.f.store, history.CLASSES[0], "vendor-1", raw, envelope, AT, [])
        self.assertEqual(result["payload"]["result"], "credited")
        repeated, same = history.import_source(self.f.repo, self.f.store, history.CLASSES[0], "vendor-1", raw, envelope, AT, first)
        self.assertFalse(repeated); self.assertEqual(same, result)
        alias, result = history.import_source(self.f.repo, self.f.store, history.CLASSES[1], "vendor-1", raw, envelope, AT, first)
        self.assertEqual(result["payload"]["result"], "duplicate")
        ledger.validate_sequence(first + alias)

    def test_vendor_metadata_numbers_and_blank_lines_preserve_strict_scope(self):
        raw = b'{"type":"heartbeat","duration":1.5}\n\n' + self.stream() + b'\n'
        self.assertEqual(history.terminal_scope(raw, self.value["payload"]["head"]), self.value["payload"]["input_scope"])
        with self.assertRaises(ledger.IntegrityError):
            history.terminal_scope(b'{"type":"heartbeat","type":"complete"}\n' + self.stream(), self.value["payload"]["head"])
        invalid = ledger.loads(self.stream()); invalid["reviewedFiles"][0]["intervals"] = [[1.5, 2]]
        with self.assertRaises(ledger.IntegrityError):
            history.terminal_scope(json.dumps(invalid).encode(), self.value["payload"]["head"])
        invalid["reviewedFiles"][0]["intervals"] = [[1, 2**54]]
        with self.assertRaises(ledger.IntegrityError):
            history.terminal_scope(json.dumps(invalid).encode(), self.value["payload"]["head"])

    def test_wrong_head_author_path_only_and_walkthrough_never_credit(self):
        cases = [(self.stream(head="f" * 40), self.envelope()),
                 (self.stream(files=["a"]), self.envelope()),
                 (b'{"body":"No actionable comments"}', self.envelope())]
        author = self.envelope(); author["author_cycle"] = True
        cases.append((self.stream(), author))
        for raw, envelope in cases:
            events, result = history.import_source(self.f.repo, self.f.store, history.CLASSES[0], "vendor-1", raw, envelope, AT, [])
            self.assertNotEqual(result["payload"]["result"], "credited")
            self.assertFalse(any(ledger.creditable(v) for v in events))
            for ref in result["payload"]["artifacts"]:
                self.f.store.verify(ref)

    def test_all_four_classes_report_gaps_and_github_requires_exact_authenticated_scope(self):
        catalog = [{"class": kind, "id": str(i), "raw": b"{}", "envelope": {}} for i, kind in enumerate(history.CLASSES)]
        events, report = history.import_catalog(self.f.repo, self.f.store, catalog, AT, [])
        self.assertEqual(set(report), set(history.CLASSES)); self.assertEqual(len(events), 4)
        self.assertTrue(all(r["sources"] == 1 for r in report.values()))
        envelope = self.envelope(); envelope["producer"] = "coderabbitai[bot]"
        raw = ledger.canonical({"id": 123, "commit_id": self.value["payload"]["head"], "user": {"login": "coderabbitai[bot]", "type": "Bot"}})
        _, gap = history.import_source(self.f.repo, self.f.store, "github-app-review", "123", raw, envelope, AT, [])
        self.assertEqual(gap["payload"]["result"], "unverified")
        envelope["scope_artifact"] = self.f.store.put(self.stream())
        credited, result = history.import_source(self.f.repo, self.f.store, "github-app-review", "123", raw, envelope, AT, [])
        self.assertEqual(result["payload"]["result"], "credited")

    def test_collectors_retain_all_classes_and_paginated_api_bytes_without_credit(self):
        state = Path(self.tmp.name) / "state"
        (state / "receipts").mkdir(parents=True)
        raw = ledger.canonical({"run_id": "receipt-1", "started_at": AT, "paths": ["a"]})
        import hashlib
        (state / "receipts" / (hashlib.sha256(raw).hexdigest() + ".json")).write_bytes(raw)
        queue = {"items": [{"id": "merged-1", "kind": "merged", "cycles": [{"run_id": "run-1", "completed_at": AT}]}],
                 "promotion_audit": {"records": [{"at": AT, "head": self.t}]}}
        prs = ledger.canonical([[{"number": 1, "merged_at": AT}], [{"number": 2, "merged_at": None}]])
        api = {"id": 123, "commit_id": self.t, "submitted_at": AT, "user": {"login": "coderabbitai[bot]", "type": "Bot"}}
        reviews = ledger.canonical([[], [api]])
        with mock.patch.object(history.subprocess, "run", side_effect=[SimpleNamespace(stdout=prs), SimpleNamespace(stdout=reviews)]) as fetch:
            result = history.collect_sources(queue, state, self.f.store, github=lambda: history.github_sources(self.f.store))
        self.assertEqual(fetch.call_count, 2)
        self.assertTrue(all("--paginate" in call.args[0] and "--slurp" in call.args[0] for call in fetch.call_args_list))
        self.assertEqual({s["class"] for s in result["sources"]}, set(history.CLASSES))
        catalog = []
        for source in result["sources"]:
            self.f.store.verify(source["raw_artifact"])
            catalog.append({**source, "raw": Path(source["raw_artifact"]["location"]).read_bytes()})
        events, report = history.import_catalog(self.f.repo, self.f.store, catalog, AT, [])
        self.assertFalse(any(ledger.creditable(v) for v in events))
        self.assertTrue(all(r["sources"] == 1 for r in report.values()))
        gh = next(s for s in result["sources"] if s["class"] == "github-app-review")
        for ref in gh["envelope"]["transport"].values():
            if isinstance(ref, dict):
                self.f.store.verify(ref)


if __name__ == "__main__":
    unittest.main()
