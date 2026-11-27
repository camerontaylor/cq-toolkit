"""Reproducibility guard for the ``process()`` rung-machine oracle fixture.

``repair_rung_machine_vectors.py`` runs the PRODUCTION ``crq_repair.process``
(``crq_repair.py:486-789``) with only its effects injected and records the seam
trace, every file save and the outcome per scenario. This test fails when the
committed fixture no longer matches, so a change to ``process`` forces the
TypeScript port and the fixture to move together.

Regenerate with ``python3 repair_rung_machine_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_rung_machine_vectors as emitter


class RepairRungMachineVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_rung_machine_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_every_rung_path_is_covered(self) -> None:
        names = " ".join(case["name"] for case in emitter.build()["cases"])
        for path in ("A0 success", "stop timeout", "rate limit", "pending_judge", "pending_mechanical",
                     "interrupted rung", "blackout", "needs_human"):
            self.assertIn(path, names)


if __name__ == "__main__":
    unittest.main()
