"""Branch-target grammar tests for queue transport.

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


class BranchTargetGrammarTests(unittest.TestCase):
    """The deferred target is a git branch, not a request token (PR #580 r4394484110).

    The vectors come from test/fixtures/refname-vectors.json, the same file the
    TypeScript suite reads, so the canonical grammar and this mirror cannot drift.
    """

    VECTORS = json.loads(
        (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "refname-vectors.json")
        .read_text())["vectors"]

    def binding(self, target="merge-queue", producer="cycle-1"):
        return {"kind": "deferred-author", "repo": "owner/repo", "producer": producer,
                "head": "a" * 40, "target": target, "targetSelector": "promoted-main"}

    def test_vector_table_matches_shared_fixture(self):
        for vector in self.VECTORS:
            with self.subTest(rule=vector["rule"], value=vector["value"]):
                fault = transport.branch_fault(vector["value"])
                self.assertEqual(fault is None, vector["accept"],
                                 f"{vector['rule']}: {vector['value']!r} -> {fault}")

    def test_binding_accepts_approved_branch_targets(self):
        accepted = [v for v in self.VECTORS if v["accept"]]
        self.assertTrue(accepted)
        for vector in accepted:
            with self.subTest(value=vector["value"]):
                self.assertEqual(transport.binding(self.binding(target=vector["value"]))["target"],
                                 vector["value"])

    def test_binding_rejects_invalid_branch_targets(self):
        rejected = [v for v in self.VECTORS if not v["accept"]]
        self.assertTrue(rejected)
        for vector in rejected:
            with self.subTest(rule=vector["rule"], value=vector["value"]):
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(target=vector["value"]))

    def test_producer_keeps_token_grammar(self):
        # No request-token widening: the producer keeps the strict QueueToken grammar.
        for producer in ("release/1.4", "a b", "cycle@1"):
            with self.subTest(producer=producer):
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(producer=producer))
        self.assertEqual(transport.binding(self.binding(producer="cycle-1"))["producer"], "cycle-1")

    def test_unapproved_branch_fails_at_allowlist_not_grammar(self):
        # A structurally valid refname that policy does not approve still fails closed,
        # and it fails at the branch allowlist, not at the token grammar.
        binding = self.binding(target="release/1.4")
        self.assertIsNone(transport.branch_fault(binding["target"]))
        self.assertEqual(transport.binding(binding)["target"], "release/1.4")
        request = receipts.canonical({"v": 1, "op": "status", "requestId": "request-1",
                                      "binding": binding})
        policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
                  "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
        with tempfile.TemporaryDirectory() as root:
            def run(inner):
                return inner()
            runner = SimpleNamespace(load_queue=lambda: {"items": []},
                                     save_queue=lambda q: None, iso=lambda: "2026-10-28T00:00:00Z",
                                     with_lock=run)
            with self.assertRaises(ValueError) as caught:
                transport.handle(request, runner, principal="developer", policy=policy,
                                 verify_source=lambda repo, pr: self.fail("must not reach forge"),
                                 receipt_root=root)
        self.assertIn("target branch denied", str(caught.exception))

    def test_unicode_whitespace_parity(self):
        r"""The P2 fix: JS and Python `\s` disagree, so the rule is explicit instead.

        Python's Unicode `\s` matches U+0085 and ECMAScript's matches U+FEFF; neither
        character is forbidden by the shared rule, so both must accept them, while the
        literal space and C0 controls stay refused.
        """
        for value in ("a\u0085b", "a\ufeffb", "a\u00a0b"):
            with self.subTest(accepted=value):
                self.assertIsNone(transport.branch_fault(value))
                self.assertEqual(transport.binding(self.binding(target=value))["target"], value)
        for value in ("a b", "a\u001fb", "a\u007fb", "a\tb"):
            with self.subTest(rejected=value):
                self.assertIsNotNone(transport.branch_fault(value))
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(target=value))
