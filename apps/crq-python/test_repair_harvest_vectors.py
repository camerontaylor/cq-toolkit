"""Reproducibility guard for the repair-harvest oracle fixture.

`repair_harvest_vectors.py` drives the PRODUCTION `repair_tick.harvest`,
`repair_tick.mark_finding_outcome` and `finding_delivery.Inbox.repair_outcome`
over a real temporary inbox/outbox and records the canonical event and row
bytes Python actually writes. This test fails if the committed fixture no
longer matches that output, so a Python behaviour change cannot silently leave
the TypeScript port pinned to stale evidence.

The additional shape checks pin the D7 distinction the slice exists for:
retriable failures stay `needs-retriage`, only a typed `owner-decision`
escalates to `needs-human`, the retry bound terminates, and a pre-merge FIXED
artifact writes nothing.

Regenerate with `python3 repair_harvest_vectors.py --write`.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import repair_harvest_vectors as emitter


class RepairHarvestVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = Path(emitter.__file__).resolve().parent / "fixtures" / "repair-harvest" / "cases.json"
        self.assertTrue(fixture.exists(), "run python3 repair_harvest_vectors.py --write")
        self.assertEqual(
            fixture.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-harvest fixture is stale; run python3 repair_harvest_vectors.py --write",
        )

    def test_document_shape(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-harvest-vector/v1")
        names = [case["name"] for case in document["harvest_cases"]]
        self.assertEqual(len(names), len(set(names)))
        for name in (
            "failed-exhausted",
            "failed-owner-decision",
            "not-fixed-with-evidence",
            "not-fixed-without-evidence",
            "retry-bound-reached",
            "idempotent-replay-after-spool",
            "preserved-newer-generation",
        ):
            self.assertIn(name, names)
        mark_names = [case["name"] for case in document["mark_cases"]]
        self.assertIn("pre-merge-fixed-writes-nothing", mark_names)
        self.assertIn("merged-fixed-writes-fixed", mark_names)

    def test_owner_decision_is_the_only_escalation(self) -> None:
        document = emitter.build()
        for case in document["harvest_cases"]:
            for event in case["events_added"]:
                payload = event["payload"]
                failure_class = payload["evidence"].get("failure_class")
                # The owner-decision class always escalates; a needs-human row
                # may instead be the retry bound keeping its retriable class.
                if failure_class == "owner-decision":
                    self.assertEqual(payload["action"], "needs-human", case["name"])
                if case["name"].startswith("failed-") and payload["action"] == "needs-human":
                    self.assertEqual(failure_class, "owner-decision", case["name"])

    def test_retry_bound_and_pre_merge_fixed(self) -> None:
        document = emitter.build()
        cases = {case["name"]: case for case in document["harvest_cases"]}
        bound = cases["retry-bound-reached"]
        self.assertEqual(len(bound["events_added"]), 1)
        self.assertEqual(bound["events_added"][0]["payload"]["action"], "needs-human")
        self.assertEqual(bound["events_added"][0]["payload"]["evidence"]["failure_class"],
                         "exhausted")
        pre_merge = {case["name"]: case for case in document["mark_cases"]}
        self.assertFalse(pre_merge["pre-merge-fixed-writes-nothing"]["events_added"])

    def test_idempotent_replay_adds_no_event(self) -> None:
        document = emitter.build()
        case = next(c for c in document["harvest_cases"]
                    if c["name"] == "idempotent-replay-after-spool")
        self.assertEqual(len(case["events_added"]), 1)
        self.assertEqual(case["row_replayed"], case["row_after"])

    def test_invalid_artifact_persists_queue_before_the_terminal_outcome(self) -> None:
        document = emitter.build()
        cases = {case["name"]: case for case in document["harvest_cases"]}
        invalid = cases["invalid-fixed-without-commits"]
        # repair_tick.harvest rejects a malformed artifact as a deterministic
        # terminal failure: it persists queue identity first, then records the
        # FAILED outcome the TS port models as needs-retriage/exhausted.
        self.assertTrue(invalid["queue_saved"])
        self.assertEqual(len(invalid["events_added"]), 1)
        payload = invalid["events_added"][0]["payload"]
        self.assertEqual(payload["action"], "needs-retriage")
        self.assertEqual(payload["evidence"]["failure_class"], "exhausted")
        self.assertTrue(payload["evidence"]["reason"].startswith("invalid repair result: "))
        self.assertFalse(any(case["queue_saved"] for name, case in cases.items()
                             if name != "invalid-fixed-without-commits"))

    def test_no_temp_paths_leak(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("TemporaryDirectory", text)


if __name__ == "__main__":
    unittest.main()
