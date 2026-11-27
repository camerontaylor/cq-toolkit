"""Reproducibility guard for the ``crq_repair.findings`` oracle fixture.

``repair_findings_vectors.py`` runs the PRODUCTION ``crq_repair.findings`` over
byte-exact ``review.ndjson`` inputs. This test fails when the committed fixture
no longer matches, so a change to that parser forces the TypeScript port
(``src/queue-runner/repairFindings.ts``) and the fixture to move together.

Regenerate with ``python3.14 repair_findings_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_findings_vectors as emitter


class RepairFindingsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_findings_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
