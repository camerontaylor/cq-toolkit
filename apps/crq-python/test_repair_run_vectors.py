"""Reproducibility guard for the ``run`` result-lane oracle fixture.

``repair_run_vectors.py`` runs the PRODUCTION ``crq_repair.run`` (dry-run and
drain tail), ``drain`` and ``main`` with only their effects injected and records
what they do. This test fails when the committed fixture no longer matches, so
a change to those functions forces the TypeScript port and the fixture to move
together.

Regenerate with ``python3 repair_run_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_run_vectors as emitter


class RepairRunVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_run_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_case_names_are_unique(self) -> None:
        names = [case["name"] for case in emitter.build()["cases"]]
        self.assertEqual(len(names), len(set(names)))


if __name__ == "__main__":
    unittest.main()
