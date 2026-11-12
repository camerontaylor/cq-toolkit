"""Reproducibility guard for the repair-snapshot oracle fixture.

``repair_snapshot_vectors.py`` imports the PRODUCTION
``crq_repair.bounded.source_snapshot`` and records the exact snapshots and
ValueError refusals. This test fails if the committed fixture no longer
matches that output, so a Python behavior change cannot silently leave the
TypeScript port pinned to stale evidence.

Regenerate with `python3 repair_snapshot_vectors.py --write`.
"""
from __future__ import annotations

import unittest

import repair_snapshot_vectors as emitter


class RepairSnapshotVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(
            emitter.FIXTURE.exists(), "run python3 repair_snapshot_vectors.py --write"
        )
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-snapshot fixture is stale; run python3 repair_snapshot_vectors.py --write",
        )

    def test_document_shape(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-snapshot-vector/v1")
        self.assertEqual(
            document["source"],
            "apps/crq-python/crq_repair/bounded.py:source_snapshot",
        )
        self.assertEqual(document["source_path"], "apps/crq-python/crq_repair/bounded.py")
        self.assertRegex(document["source_module_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(document["source_function_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(document["max_chars"], 16000)
        self.assertTrue(document["cases"])
        names = [case["name"] for case in document["cases"]]
        self.assertEqual(len(names), len(set(names)))
        for required in (
            "prepared-line-2",
            "legacy-line-2",
            "crlf-astral",
            "full-window-expansion",
            "bound-limited-expansion",
            "exact-bound",
            "anchor-too-large",
            "binding-mismatch",
            "blob-mismatch",
            "bad-path",
        ):
            self.assertIn(required, names)
        for case in document["cases"]:
            self.assertIn("job", case)
            self.assertIn("source_text", case)
            self.assertIn("observed_blob", case)
            self.assertIn("expected", case)
            if case["expected"]["ok"]:
                self.assertEqual(
                    case["expected"]["snapshot_keys"],
                    [
                        "source_sha",
                        "finding_sha256",
                        "origin_job",
                        "source_blob_sha",
                        "path",
                        "line_start",
                        "line_end",
                        "source",
                        "incomplete",
                        "instruction",
                    ],
                )
            else:
                self.assertTrue(case["expected"]["error"])


if __name__ == "__main__":
    unittest.main()
