"""Reproducibility guard for the triage-context scan oracle fixture.

``triage_context_scan_vectors.py`` drives the PRODUCTION
``crq_repair.triage_context_scan`` and records the synthetic patch, the
verdicts and every exception class. This test fails when the committed fixture
no longer matches that output, so a change to ``crq_repair.py`` or
``crq_repair/triage.py`` forces the TypeScript port and the fixture to move
together.

Regenerate with ``python3 triage_context_scan_vectors.py --write``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import triage_context_scan_vectors as emitter


class TriageContextScanVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-triage-context-scan"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 triage_context_scan_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_cover_every_outcome(self) -> None:
        document = emitter.build()
        results = [case["result"] for case in document["flatten"]]
        raised = {result["raises"] for result in results if "raises" in result}
        self.assertTrue(
            {"ContextScanError", "KeyError", "TypeError", "AttributeError", "ValueError"} <= raised
        )
        self.assertTrue(any(result.get("verdict") is True for result in results))
        self.assertTrue(any(result.get("verdict") is False for result in results))
        self.assertTrue(all(result["output_passed_through"] for result in results if result["scanner_calls"]))
        real = [case["result"] for case in document["real"]]
        self.assertTrue(any(result["clean"] for result in real))
        self.assertTrue(any(not result["clean"] for result in real))
        self.assertTrue(all(result["gitleaks"] == "not-run" for result in real))

    def test_fixture_contains_no_host_paths(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn(tempfile.gettempdir(), text)
        self.assertNotIn("/tmp/", text)


if __name__ == "__main__":
    unittest.main()
