"""Reproducibility guard for the ``recover_job`` oracle fixture.

``repair_recover_job_vectors.py`` runs the PRODUCTION ``crq_repair.recover_job``
(``crq_repair.py:1395-1528``) with only its effects injected and records the seam
trace, what each closure handed to ``recovery.recover`` answered or raised, and
the outcome per scenario. This test fails when the committed fixture no longer
matches, so a change to ``recover_job`` forces the TypeScript port and the
fixture to move together.

Regenerate with ``python3 repair_recover_job_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_recover_job_vectors as emitter


class RepairRecoverJobVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_recover_job_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_every_closure_path_is_covered(self) -> None:
        names = " ".join(case["name"] for case in emitter.build()["cases"])
        for path in ("role:", "lock:", "owner:", "judge:", "prepare:", "scan:", "flow:",
                     "blackout", "runner marker", "busy tick"):
            self.assertIn(path, names)


if __name__ == "__main__":
    unittest.main()
