"""Reproducibility guard for the ``dispatch()`` wrapper oracle fixture.

``repair_dispatch_wrapper_vectors.py`` runs the PRODUCTION ``crq_repair.dispatch``
(``crq_repair.py:329-461``) with only its effects injected and records the seam
trace, the CQ_* environment at each driver and retention call, and the outcome per
scenario. This test fails when the committed fixture no longer matches, so a change
to ``dispatch`` forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 repair_dispatch_wrapper_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_dispatch_wrapper_vectors as emitter


class RepairDispatchWrapperVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_dispatch_wrapper_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_every_path_is_covered(self) -> None:
        names = " ".join(case["name"] for case in emitter.build()["cases"])
        for path in ("plain:", "triage:", "identity:", "snapshot:", "diff:", "budget:", "select:", "loop:",
                     "blackout", "rate-limit"):
            self.assertIn(path, names)


if __name__ == "__main__":
    unittest.main()
