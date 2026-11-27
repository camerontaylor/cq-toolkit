"""Reproducibility guard for the triage phase-tail oracle fixture.

``triage_phase_vectors.py`` drives the PRODUCTION ``crq_repair.triage.phase``
with a scripted judge, fake inbox and fake clock and records the call trace and
report. This test fails when the committed fixture no longer matches, so a
change to ``triage.py`` forces the TypeScript port and the fixture to move
together.

Regenerate with ``python3 triage_phase_vectors.py --write``.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import triage_phase_vectors as emitter


class TriagePhaseVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent / "fixtures" / "crq-triage-phase" / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 triage_phase_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_are_unique_and_cover_every_path(self) -> None:
        cases = emitter.build()["cases"]
        names = [case["name"] for case in cases]
        self.assertEqual(len(names), len(set(names)))
        raised = {case["expected"]["raises"] for case in cases if "raises" in case["expected"]}
        self.assertTrue({"KeyError", "TypeError", "AttributeError", "RuntimeError"} <= raised)
        self.assertTrue(any(case["expected"].get("report_json") for case in cases))

    def test_every_case_reaches_the_tail_boundary(self) -> None:
        for case in emitter.build()["cases"]:
            self.assertIsNotNone(case["boundary"], case["name"])


if __name__ == "__main__":
    unittest.main()
