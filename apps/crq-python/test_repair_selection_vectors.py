"""Reproducibility guard for the repair-selection oracle fixture.

``repair_selection_vectors.py`` imports the PRODUCTION
``crq_repair.bounded`` selection helpers, injects every Git and filesystem
fact, and records the exact ordering, run/stale/skip classification, bound
job bytes, explicit selection and Git read order. This test fails when the
committed fixture no longer matches that output, so a change to ``bounded.py``
forces the port and the fixture to move together.

Regenerate with ``python3 repair_selection_vectors.py --write``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import repair_selection_vectors as emitter


class RepairSelectionVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-repair-selection"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 repair_selection_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_are_named_and_cover_every_outcome(self) -> None:
        document = emitter.build()
        cases = document["cases"]
        names = [case["name"] for case in cases]
        self.assertEqual(len(names), len(set(names)))
        kinds = {case["kind"] for case in cases}
        self.assertEqual(kinds, {"order", "drain", "select"})
        statuses = {case["expected"]["status"] for case in cases if case["kind"] == "drain"}
        self.assertEqual(statuses, {"run", "stale", "skip"})
        self.assertTrue(any(case["expected"]["ok"] for case in cases if case["kind"] == "select"))
        self.assertTrue(any(not case["expected"]["ok"] for case in cases if case["kind"] == "select"))
        orders = [case["expected"]["jobs"] for case in cases if case["kind"] == "order"]
        self.assertTrue(any(not jobs for jobs in orders))
        self.assertTrue(any(jobs for jobs in orders))

    def test_fixture_contains_no_host_paths(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn(tempfile.gettempdir(), text)
        self.assertNotIn("/tmp/", text)


if __name__ == "__main__":
    unittest.main()
