"""Reproducibility guard for the repair request-context oracle fixture.

``repair_request_context_vectors.py`` runs the PRODUCTION ``process_item``,
``process``, ``_dispatch`` and ``cq.invoke`` with only their effects mocked,
and records the derived worktree, role, repo, driver and budget plus each
production exception. This test fails if the committed fixture no longer
matches that output, so a Python behaviour change cannot silently leave the
TypeScript port pinned to stale evidence.

Regenerate with `python3 repair_request_context_vectors.py --write`.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

import repair_request_context_vectors as emitter


class RepairRequestContextVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "repair-request-context"
            / "cases.json"
        )
        self.assertTrue(
            fixture.exists(),
            "run python3 repair_request_context_vectors.py --write",
        )
        self.assertEqual(
            fixture.read_text(encoding="utf-8"),
            emitter.render(emitter.build()),
            "repair-request-context fixture is stale; "
            "run python3 repair_request_context_vectors.py --write",
        )

    def test_document_shape_and_coverage(self) -> None:
        document = emitter.build()
        self.assertEqual(document["schema"], "cq.crq-repair-request-context-vector/v1")
        self.assertEqual(document["context_fields"], ["repo", "worktree", "driver", "budget"])
        names = [case["name"] for case in document["cases"]]
        self.assertEqual(len(names), len(set(names)))
        for required in (
            "canonical-fixer",
            "escalation-role",
            "role-budget-overrides",
            "base-token-defaults",
            "fractional-wall-clock",
            "unknown-role",
            "role-missing-model",
            "non-cq-fixer-driver",
            "missing-budget",
            "missing-worktree-root",
        ):
            self.assertIn(required, names)

    def test_valid_cases_carry_context_and_refusals_carry_an_exception(self) -> None:
        for case in emitter.build()["cases"]:
            with self.subTest(case=case["name"]):
                if case["error"] is None:
                    self.assertIsNotNone(case["context"])
                    self.assertEqual(
                        case["context_json"],
                        json.dumps(case["context"], ensure_ascii=True, indent=2) + "\n",
                    )
                else:
                    self.assertIsNone(case["context"])
                    self.assertIsNone(case["context_json"])
                    self.assertIn(
                        case["error"]["stage"], ("worktree", "role", "dispatch")
                    )
                    self.assertTrue(case["error"]["type"])

    def test_escalation_records_the_dispatched_a2_worktree(self) -> None:
        cases = {case["name"]: case for case in emitter.build()["cases"]}
        escalation = cases["escalation-role"]
        self.assertEqual(escalation["worktree"], escalation["base_worktree"] + "-A2")
        self.assertEqual(escalation["context"]["worktree"]["path"], escalation["worktree"])
        fixer = cases["canonical-fixer"]
        self.assertEqual(fixer["worktree"], fixer["base_worktree"])

    def test_no_temp_paths_leak(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("TemporaryDirectory", text)


if __name__ == "__main__":
    unittest.main()
