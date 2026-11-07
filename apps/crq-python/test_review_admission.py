"""Admission uses immutable resolved facts, separate from the author v1 map."""
import copy
import json
from pathlib import Path
import unittest

import review_admission as admission


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())
        self.facts = vectors[0]["value"]
        self.inputs = next(r["value"]["inputs"] for r in vectors if r["name"] == "submit")
        self.profile = next(r["value"] for r in vectors if r["name"] == "pinned-profile")
        self.q = {"items": [], "author_requests": {"legacy": {"binding": "unchanged"}}}

    def admit(self, key, **kw):
        return admission.admit(self.q, request_id=key, inputs=self.inputs,
                               resolved=self.facts, profile=self.profile,
                               at="2026-11-08T00:00:00Z", **kw)

    def test_join_retry_conflict_and_cancel(self):
        first = self.admit("one")
        self.assertEqual(first["action"], "created")
        self.assertEqual(self.admit("two")["action"], "joined")
        self.assertEqual(self.admit("one")["item"], first["item"])
        self.assertEqual(len(self.q["items"]), 1)
        changed = {**self.inputs, "target": "other"}
        with self.assertRaises(ValueError):
            admission.retry(self.q, "one", admission.key_digest(changed))
        admission.cancel(self.q, "one")
        self.assertEqual(self.q["items"][0]["state"], "pending")
        admission.cancel(self.q, "two")
        self.assertEqual(self.q["items"][0]["state"], "cancelled")
        self.assertEqual(self.q["author_requests"], {"legacy": {"binding": "unchanged"}})

    def test_completed_findings_reuse_and_unbounded_generations(self):
        self.admit("one")
        item = self.q["items"][0]
        item.update(state="done", scope_adequate=True, receipt_id="a" * 64)
        self.assertEqual(self.admit("two")["action"], "reused")
        self.assertNotIn("two", item["observers"])
        for generation in range(2, 6):
            result = self.admit(str(generation) + "-repeat", repeat=True)
            self.assertEqual(result["generation"], generation)
            self.assertEqual(result["action"], "created")
        self.profile["flags"].append("--new")
        self.assertNotIn("--new", item["profile"]["flags"])

    def test_failed_equivalent_requires_explicit_resubmit(self):
        self.admit("one")
        self.q["items"][0]["state"] = "failed"
        self.assertEqual(self.admit("two")["next_action"], "resubmit")
        self.assertEqual(len(self.q["items"]), 1)
        self.assertEqual(self.admit("three", repeat=True)["generation"], 2)

    def test_no_changes_and_running_cancellation(self):
        self.facts["head_tree"] = self.facts["base_tree"]
        self.assertEqual(self.admit("empty")["action"], "no-changes")
        self.assertEqual(self.q["items"][0]["state"], "done")
        self.facts["head_tree"] = "d" * 40
        self.facts["head_commit"] = "f" * 40
        self.inputs["head_commit"] = "f" * 40
        self.admit("work")
        item = self.q["items"][-1]
        item["state"] = "reviewing"
        self.assertEqual(admission.cancel(self.q, "work")["state"], "running")

    def test_pending_pr_is_never_joined_and_invalid_input_is_atomic(self):
        self.q["items"].append(dict(id="pr-1", kind="open", state="pending", order=1))
        self.assertEqual(self.admit("one")["action"], "created")
        before = copy.deepcopy(self.q)
        with self.assertRaises(ValueError):
            self.admit("invalid", notify={"arbitrary": "extra"})
        self.assertEqual(before, self.q)
