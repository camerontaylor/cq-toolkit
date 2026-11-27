"""Reproducibility guard for the repair-harvest remaining-effects oracle fixture.

``repair_harvest_rest_vectors.py`` runs the PRODUCTION ``repair_tick.finalize_publication`` (with
``crq.run`` / ``crq.gh_json`` / ``crq.new_item`` / ``crq.save_queue`` against a fake ``gh`` on a temporary
``PATH``), the admission-history compaction log of ``crq.save_queue`` and the gitleaks block of
``crq.secret_scan_diff`` against a fake ``gitleaks``. This test fails when the committed fixture no longer
matches, so a change to those functions forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 repair_harvest_rest_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_harvest_rest_vectors as emitter


class RepairHarvestRestVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_harvest_rest_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
