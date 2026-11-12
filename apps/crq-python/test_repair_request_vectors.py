"""Reproducibility guard for the repair-request oracle fixture.

``repair_request_vectors.py`` imports the PRODUCTION
``crq_repair.drivers.cq.fixer_body`` and records the exact legacy bodies,
typed-mapping bodies and ValueError refusals. This test fails if the committed
fixture no longer matches that output, so a Python behavior change cannot
silently leave the TypeScript port pinned to stale evidence.

Regenerate with `python3 repair_request_vectors.py --write`.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import repair_request_vectors as emitter


class RepairRequestVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "repair-request"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 repair_request_vectors.py --write")
        self.assertEqual(
            fixture.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-request fixture is stale; run python3 repair_request_vectors.py --write",
        )

    def test_document_shape(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-request-vector/v1")
        self.assertEqual(document["body_bound_utf16"], 8000)
        self.assertTrue(document["cases"])
        names = [case["name"] for case in document["cases"]]
        self.assertEqual(len(names), len(set(names)))
        for required in (
            "simple-no-guidance",
            "operator-guidance",
            "operator-and-retry-guidance",
            "astral-and-escapes",
            "full-source-anchor",
            "expand-to-bound",
            "anchor-too-large",
            "malformed-excerpt",
            "combined-order",
        ):
            self.assertIn(required, names)
        for case in document["cases"]:
            self.assertTrue(case["body"] is None or case["error"] is None)
            self.assertTrue(case["typed"]["body"] is None or case["typed"]["error"] is None)

    def test_no_temp_paths_leak(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("TemporaryDirectory", text)


if __name__ == "__main__":
    unittest.main()
