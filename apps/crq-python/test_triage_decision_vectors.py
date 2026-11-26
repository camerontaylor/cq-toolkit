"""Reproducibility guard for the triage ``decision`` oracle fixture.

``triage_decision_vectors.py`` drives the PRODUCTION
``crq_repair.triage.decision`` with an injected fake repository and records the
decision tuple, the ordered repository reads and any exception class. This test
fails when the committed fixture no longer matches that output, so a change to
``triage.py`` forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 triage_decision_vectors.py --write``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import triage_decision_vectors as emitter


class TriageDecisionVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-triage-decision"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 triage_decision_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_are_named_and_cover_every_outcome(self) -> None:
        cases = emitter.build()["cases"]
        names = [case["name"] for case in cases]
        self.assertEqual(len(names), len(set(names)))
        statuses = {case["expected"]["status"] for case in cases if "status" in case["expected"]}
        self.assertEqual(
            statuses,
            {"needs-human", "confirmed", "dismissed", "already-fixed", "superseded", "duplicate"},
        )
        raised = [case["expected"] for case in cases if "raises" in case["expected"]]
        self.assertTrue(any(item["injected"] for item in raised))
        self.assertTrue(any(not item["injected"] for item in raised))
        self.assertTrue(any(case["ts_refuses"] for case in cases))

    def test_an_unexpected_read_aborts_the_build(self) -> None:
        # AssertionError is never caught by decision(), so a case that reads
        # something it did not provide must fail loudly, not be recorded.
        spec = next(case for case in emitter.cases() if case["name"].startswith("fixed with a verified"))
        spec = {**spec, "git": {}}
        with self.assertRaisesRegex(AssertionError, "unexpected git"):
            emitter.run_python(spec)

    def test_fixture_contains_no_host_paths(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn(tempfile.gettempdir(), text)
        self.assertNotIn("/tmp/", text)


if __name__ == "__main__":
    unittest.main()
