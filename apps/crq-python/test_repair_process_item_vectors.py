"""Reproducibility guard for the composed ``process_item`` -> ``process`` oracle fixture.

``repair_process_item_vectors.py`` runs the PRODUCTION ``crq_repair.process_item``
over the PRODUCTION ``crq_repair.process`` with only its effects injected. This
test fails when the committed fixture no longer matches, so a change to either
function forces the TypeScript port and the fixture to move together. Offline.

Regenerate with ``python3 repair_process_item_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_process_item_vectors as emitter


class RepairProcessItemVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_process_item_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_core_paths_are_covered(self) -> None:
        names = " ".join(case["name"] for case in emitter.build()["cases"])
        for path in ("chain:", "deferral:", "prior:", "resume:", "non-dict prior list", "non-dict prior null"):
            self.assertIn(path, names)


if __name__ == "__main__":
    unittest.main()
