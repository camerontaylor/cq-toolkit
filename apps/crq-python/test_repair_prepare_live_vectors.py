"""Reproducibility guard for the repair-prepare live oracle.

``repair_prepare_live_vectors.py`` builds the deterministic scratch repository,
runs the PRODUCTION ``repair_tick.prepare_current_job`` over real git reads and
records the exact job/queue/triage/outbox bytes. This test fails when the
committed fixture no longer matches that output, including the recorded
repository object names the TypeScript acceptance test rebuilds.

Regenerate with ``python3 repair_prepare_live_vectors.py --write``.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import repair_prepare_live_vectors as emitter


class RepairPrepareLiveVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-repair-prepare-live"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 repair_prepare_live_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_recorded_repository_names_are_full_sha1(self) -> None:
        document = emitter.build()
        repository = document["repository"]
        self.assertRegex(repository["source_sha"], r"^[0-9a-f]{40}$")
        self.assertRegex(repository["source_blob_sha"], r"^[0-9a-f]{40}$")
        self.assertEqual(repository["source_sha"], repository["source_sha"].lower())
        for case in document["cases"].values():
            self.assertIsNotNone(case["old_job_canonical"])
            self.assertIsNotNone(case["queue_input_canonical"])
            self.assertEqual(case["job_id"].split("-")[0], "crq")


if __name__ == "__main__":
    unittest.main()
