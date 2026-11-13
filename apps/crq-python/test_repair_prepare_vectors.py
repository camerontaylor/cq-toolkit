"""Reproducibility guard for the repair-prepare oracle fixture.

`repair_prepare_vectors.py` imports the PRODUCTION `crq_repair.bounded` and
`repair_tick.prepare_current_job`, fakes every effect, and records the bytes
and decisions the Python runtime actually produces. This test fails if the
committed fixture no longer matches that output, so a Python behaviour change
cannot silently leave the TypeScript port pinned to stale evidence.

Regenerate with `python3 repair_prepare_vectors.py --write`.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import repair_prepare_vectors as emitter


class RepairPrepareVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = Path(emitter.__file__).resolve().parent / "fixtures" / "repair-prepare" / "cases.json"
        self.assertTrue(fixture.exists(), "run python3 repair_prepare_vectors.py --write")
        self.assertEqual(
            fixture.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-prepare fixture is stale; run python3 repair_prepare_vectors.py --write",
        )

    def test_document_shape(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-prepare-vector/v1")
        self.assertTrue(document["prepare_cases"])
        self.assertTrue(document["harvest_cases"])
        self.assertTrue(document["path_cases"])
        self.assertTrue(document["gate_cases"])
        self.assertTrue(document["round_cases"])
        self.assertTrue(document["delivery_cases"])
        self.assertTrue(document["handoff_cases"])
        self.assertTrue(document["allowlist_cases"])
        self.assertTrue(document["patch_cases"]["source"])
        self.assertTrue(document["patch_cases"]["instructions"])
        names = [case["name"] for case in document["prepare_cases"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("major-no-instructions", names)
        self.assertIn("refuse-round-ceiling", names)
        gate_names = [case["name"] for case in document["gate_cases"]]
        self.assertEqual(len(gate_names), len(set(gate_names)))
        self.assertIn("scan-clean-source-only", gate_names)
        self.assertIn("canonical-round-backfill-missing", gate_names)

    def test_no_temp_paths_leak(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("TemporaryDirectory", text)


if __name__ == "__main__":
    unittest.main()
