"""Reproducibility guard for the repair hack-detector oracle fixture.

``repair_hack_detector_vectors.py`` runs the PRODUCTION
``crq_repair.hack_detector`` with its subprocess call stubbed. This test fails
when the committed fixture no longer matches, so a change to the function forces
the TypeScript port and the fixture to move together.

Regenerate with ``python3 repair_hack_detector_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_hack_detector_vectors as emitter


class RepairHackDetectorVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_hack_detector_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
