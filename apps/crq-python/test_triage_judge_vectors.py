"""Reproducibility guard for the triage judge oracle fixture.

``triage_judge_vectors.py`` drives the PRODUCTION ``drivers.cq.judge`` and the
``triage_phase`` judge closure of ``crq_repair.py`` and records requests, raw
process outcomes, reports and the gate trace. This test fails when the
committed fixture no longer matches, so a change to either forces the
TypeScript port and the fixture to move together.

Regenerate with ``python3 triage_judge_vectors.py --write``.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import triage_judge_vectors as emitter


class TriageJudgeVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent / "fixtures" / "crq-triage-judge" / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 triage_judge_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_are_unique_and_cover_every_gate(self) -> None:
        built = emitter.build()
        for group in ("judge", "gate"):
            names = [case["name"] for case in built[group]]
            self.assertEqual(len(names), len(set(names)), group)
        stops = {
            case["expected"]["outcome"]["result"].get("errorClass")
            for case in built["gate"]
            if isinstance(case["expected"]["outcome"].get("result"), dict)
        }
        self.assertTrue({"runner-disabled", "blackout", "rate-limit"} <= stops)


if __name__ == "__main__":
    unittest.main()
