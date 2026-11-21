"""Reproducibility guard for the triage context-assembly oracle fixture.

``triage_context_vectors.py`` drives the PRODUCTION
``crq_repair.triage.context`` against a recording fake repository and stores
the packed context (or the exception class) with the ordered reads. This test
fails when the committed fixture no longer matches that output, so a change to
``triage.py`` forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 triage_context_vectors.py --write``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import triage_context_vectors as emitter


class TriageContextVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3 triage_context_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_cases_are_named_and_cover_every_outcome(self) -> None:
        cases = emitter.build()["cases"]
        names = [case["name"] for case in cases]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(any("result" in case for case in cases))
        errors = {case["error"]["type"] for case in cases if "error" in case}
        self.assertEqual(errors, set(emitter.RAISERS))
        self.assertTrue(any("raises" in case for case in cases))
        self.assertTrue(any(case["ts_refuses"] for case in cases))
        for case in cases:
            self.assertNotEqual(case.get("raises"), "AssertionError", case["name"])

    def test_fixture_contains_no_host_paths(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn(tempfile.gettempdir(), text)
        self.assertNotIn("/tmp/", text)
        self.assertNotIn(str(Path(__file__).resolve().parent), text)


if __name__ == "__main__":
    unittest.main()
