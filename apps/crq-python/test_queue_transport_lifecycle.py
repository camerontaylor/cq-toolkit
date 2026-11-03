"""Enqueue/bind lifecycle, policy and capability tests for queue transport.

Split provenance: apps/crq-python/test_queue_transport.py was split by subject;
shared fixtures live in test_queue_transport_fixtures.py.
"""
import unittest
import copy
import json
import builtins
import io
import os
import sys
import subprocess
from types import SimpleNamespace
from unittest import mock
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import crq
import merged_reconcile as reconcile
import queue_transport as transport
import review_receipt as receipts
import capability_dispatcher as dispatcher

from test_queue_transport_fixtures import QueueTransportFixtureMixin, setUpModule, tearDownModule


class QueueTransportTests(QueueTransportFixtureMixin, unittest.TestCase):
    def test_durable_pre_pr_binding_replay_and_lost_response(self):
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("bind", pr=12, mergeSha=None)["state"], "awaiting-merge")
        self.assertEqual(self.call("bind", pr=12, mergeSha="b" * 40)["state"], "pending")
        self.call("bind", pr=12, mergeSha="b" * 40)
        self.assertEqual(len(self.q["items"]), 1)
        self.assertEqual(self.q["items"][0]["attempts"], [])

    def test_original_pr_only_replay_after_merged_recovery_preserves_ready_state(self):
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha=None)
        self.call("bind", pr=12, mergeSha="b" * 40)
        before = copy.deepcopy(self.q)
        self.assertEqual(before["queue_client_requests"]["request-1"]["state"], "ready-current")
        # Round-trip durable state and re-import the handler to model a restart.
        self.q = json.loads(json.dumps(self.q))
        import importlib
        importlib.reload(transport)
        for _ in range(2):
            result = self.call("bind", pr=12, mergeSha=None)
            self.assertEqual(result["state"], "pending")
            self.assertEqual(result["mergeSha"], "b" * 40)
            self.assertEqual(self.q, before)

    def test_merged_pr_only_replay_revalidates_identity_without_mutation(self):
        self.merged()
        before = copy.deepcopy(self.q)
        original_forge = copy.deepcopy(self.forge)
        for key, value in (("repo", "foreign/repo"), ("pr", 99),
                ("producer", "foreign-author"), ("head", "e" * 40),
                ("target", "main"), ("mergeSha", "e" * 40), ("state", "OPEN")):
            self.forge = {**original_forge, key: value}
            with self.subTest(forge_field=key), self.assertRaises(ValueError):
                self.call("bind", pr=12, mergeSha=None)
            self.assertEqual(self.q, before)
        self.forge = original_forge
        for pr, sha in ((99, None), (12, "e" * 40)):
            with self.subTest(pr=pr, mergeSha=sha), self.assertRaisesRegex(ValueError, "conflicting"):
                self.call("bind", pr=pr, mergeSha=sha)
            self.assertEqual(self.q, before)
        self.policy["write"].append("other-developer")
        raw = receipts.canonical({"v": 1, "op": "bind", "requestId": "request-1",
                                  "binding": self.b, "pr": 12, "mergeSha": None})
        with self.assertRaisesRegex(ValueError, "principal mismatch"):
            transport.handle(raw, self.runner, principal="other-developer", policy=self.policy,
                             verify_source=lambda repo, pr: self.forge, receipt_root=self.tmp.name)
        self.assertEqual(self.q, before)
        for key, value in (("producer", "other-cycle"), ("head", "f" * 40),
                           ("target", "other-target")):
            if key == "target":
                self.policy["branches"].append(value)
            original = self.b[key]
            self.b[key] = value
            with self.subTest(binding_field=key), self.assertRaisesRegex(ValueError, "binding"):
                self.call("bind", pr=12, mergeSha=None)
            self.b[key] = original
            self.assertEqual(self.q, before)

    def test_unauthorized_and_wrong_forge_refuse_without_mutation(self):
        self.policy["write"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("enqueue")
        self.assertEqual(self.q, {"items": []})
        self.policy["write"] = ["developer"]
        self.call("enqueue")
        self.forge["head"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "mismatch"): self.call("bind", pr=12, mergeSha=None)
        self.assertEqual(self.call("status")["state"], "awaiting-pr")

    def test_binding_conflict_cancellation_and_disabled_capability(self):
        self.call("enqueue")
        self.b["head"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "binding"): self.call("status")
        self.b["head"] = "a" * 40
        self.assertEqual(self.call("cancel")["state"], "cancelled")
        with self.assertRaises(ValueError): self.call("bind", pr=12, mergeSha=None)
        self.policy["enabled"] = False
        self.assertIn("unsupported", self.call("status"))

    def test_malformed_policy_refuses_before_transport_lock_or_mutation(self):
        policies = list(self.malformed_policies())
        with mock.patch.object(self.runner, "with_lock") as locked:
            for policy in policies:
                self.policy = policy
                for op in ("enqueue", "status"):
                    with self.subTest(policy=policy, op=op), self.assertRaisesRegex(ValueError, "policy"):
                        self.call(op)
                self.assertEqual(self.q, {"items": []})
            locked.assert_not_called()

    def test_only_boolean_true_activates_transport(self):
        self.policy["enabled"] = False
        self.assertIn("unsupported", self.call("enqueue"))
        del self.policy["enabled"]
        self.assertIn("unsupported", self.call("enqueue"))
        self.assertEqual(self.q, {"items": []})
        self.policy["enabled"] = True
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")

    def test_read_write_capabilities_repository_target_and_request_caps(self):
        self.call("enqueue")
        self.policy["read"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["read"] = ["developer"]
        self.policy["targets"] = ["merge-queue"]
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["targets"] = ["promoted-main"]
        self.policy["repo"] = "another/repo"
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["repo"] = "owner/repo"
        self.policy["branches"] = ["main"]
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
