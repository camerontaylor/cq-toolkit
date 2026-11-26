"""Reproducibility guard for the driver-output oracle fixture.

``repair_driver_output_vectors.py`` drives the PRODUCTION ``crq_repair.drivers``
``invoke`` functions with their effects replaced and stores what Python does.
This test fails when the committed fixture no longer matches that output.

Regenerate with ``python3 repair_driver_output_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_driver_output_vectors as emitter


class RepairDriverOutputVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3 repair_driver_output_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_cases_cover_every_outcome(self) -> None:
        document = emitter.build()
        codex = [case["expect"] for case in document["codex"]]
        self.assertTrue(any(r.get("ok") is True for r in codex))
        self.assertTrue(any(r.get("ok") is False for r in codex))
        paseo = [case["expect"] for case in document["paseo"]]
        self.assertTrue(any("result" in r for r in paseo))
        self.assertEqual({r["raises"] for r in paseo if "raises" in r}, {"ValueError", "JSONDecodeError"})
        cq = [case["expect"] for case in document["cq"]]
        self.assertTrue(any(r.get("record") for r in cq))
        self.assertFalse(any("raises" in r for r in cq))
