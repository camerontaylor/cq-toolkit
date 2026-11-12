"""Reproducibility and shape guard for the repair-preparation executor oracle.

``repair_prepare_execution_vectors.py`` imports the PRODUCTION
``repair_tick.prepare_current_job``, ``finding_delivery.Inbox.handoff`` and
``review_ledger.Outbox`` and records the ordered effect trace in a temp root.
This test fails if the committed fixture no longer matches that output, and it
pins the phase order the TypeScript executor depends on.

Regenerate with ``python3 repair_prepare_execution_vectors.py --write``.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import repair_prepare_execution_vectors as emitter


def _writes(attempt):
    return [entry for entry in attempt["trace"] if entry["kind"] == "write"]


def _targets(attempt):
    return [entry.get("target") for entry in _writes(attempt)]


def _handoff_entries(attempt):
    return [entry for entry in attempt["trace"] if entry["kind"] == "handoff"]


class RepairPrepareExecutionVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-repair-prepare-execution"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 repair_prepare_execution_vectors.py --write")
        self.assertEqual(
            fixture.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-prepare-execution fixture is stale; run "
            "python3 repair_prepare_execution_vectors.py --write",
        )

    def test_document_shape(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-prepare-execution-vector/v1")
        names = [case["name"] for case in document["execution_cases"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(
            set(names),
            {
                "new-canonical-old-owner",
                "new-canonical-prepared-owner",
                "new-non-canonical",
                "new-preserve-worktree-canonical",
                "refuse-scan-dirty",
                "refuse-round-ceiling",
                "idempotent-canonical",
                "idempotent-non-canonical",
                "fail-job-write",
                "fail-handoff-owner-mismatch",
                "fail-outbox-write",
                "fail-row-write",
                "fail-queue-write",
            },
        )
        for case in document["execution_cases"]:
            self.assertTrue(case["attempts"])
            self.assertEqual(case["attempts"][0]["label"], "first")

    def test_success_writes_follow_job_handoff_queue(self) -> None:
        cases = {case["name"]: case for case in emitter.build()["execution_cases"]}
        new = cases["new-canonical-old-owner"]["attempts"][0]
        self.assertEqual(new["outcome"]["status"], "ok")
        self.assertEqual(_targets(new), ["job", "outbox", "triage", "queue"])
        self.assertEqual(_handoff_entries(new)[0]["phase"], "enter")
        self.assertEqual(_handoff_entries(new)[-1]["phase"], "exit")

        non_canonical = cases["new-non-canonical"]["attempts"][0]
        self.assertEqual(_targets(non_canonical), ["job", "queue"])
        self.assertEqual(_handoff_entries(non_canonical), [])

        already = cases["new-canonical-prepared-owner"]["attempts"][0]
        self.assertEqual(_targets(already), ["job", "queue"])
        self.assertTrue(_handoff_entries(already))

    def test_idempotent_paths(self) -> None:
        cases = {case["name"]: case for case in emitter.build()["execution_cases"]}
        canonical = cases["idempotent-canonical"]["attempts"][0]
        self.assertEqual(canonical["outcome"]["status"], "ok")
        self.assertEqual(_writes(canonical), [])
        self.assertTrue(_handoff_entries(canonical))

        non_canonical = cases["idempotent-non-canonical"]["attempts"][0]
        self.assertEqual(non_canonical["outcome"]["status"], "ok")
        self.assertEqual(non_canonical["trace"][0]["kind"], "lock")
        self.assertEqual(non_canonical["trace"][-1]["kind"], "lock")
        self.assertEqual(_writes(non_canonical), [])
        self.assertEqual(_handoff_entries(non_canonical), [])

    def test_refusals_write_nothing(self) -> None:
        cases = {case["name"]: case for case in emitter.build()["execution_cases"]}
        for name in ("refuse-scan-dirty", "refuse-round-ceiling"):
            attempt = cases[name]["attempts"][0]
            self.assertEqual(attempt["outcome"]["status"], "error")
            self.assertEqual(_writes(attempt), [])
            self.assertEqual([entry["kind"] for entry in attempt["trace"]], ["lock", "lock"])

    def test_failures_retry_idempotently(self) -> None:
        cases = {case["name"]: case for case in emitter.build()["execution_cases"]}
        for name in (
            "fail-job-write",
            "fail-handoff-owner-mismatch",
            "fail-outbox-write",
            "fail-row-write",
            "fail-queue-write",
        ):
            first, retry = cases[name]["attempts"]
            self.assertEqual(first["outcome"]["status"], "error", name)
            self.assertEqual(retry["outcome"]["status"], "ok", name)
            jobs = retry["state"]["jobs"]
            prepared = [job for job in jobs if job["id"] != emitter.OLD]
            self.assertEqual(len(prepared), 1, name)
            queue = retry["state"]["queue"]
            self.assertEqual(queue.count('"revalidated-'), 1, name)
            retained = retry["state"]["retained"]
            if name in {"fail-row-write", "fail-queue-write", "fail-outbox-write"}:
                self.assertEqual(len(retained), 1, name)

    def test_no_temp_paths_leak(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("TemporaryDirectory", text)


if __name__ == "__main__":
    unittest.main()
