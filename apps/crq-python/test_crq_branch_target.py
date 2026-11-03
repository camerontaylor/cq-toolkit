"""Configured branch target: identity verification and drift.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import unittest
from unittest import mock
import deferred_refresh
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class ConfiguredBranchTargetTest(unittest.TestCase):
    """CR major on PR #668 (r4400294081): a configured branch target must verify.

    The deferred publication path hardcoded `merge-queue`, so a PR opened into an
    allowlisted branch such as `release/1.4` failed `verify_deferred_source` and
    refresh recorded a permanent identity blocker. The binding comparison that keeps
    the target immutable lives in `deferred_refresh._verified`, so these tests pin
    both halves: the configured target verifies, and cross-target drift still blocks.
    """

    def setUp(self):
        self.metadata = {}
        self.result = {"incomplete_results": False, "total_count": 0, "items": []}
        patch = mock.patch.object(crq, "deferred_forge", self.forge)
        patch.start()
        self.addCleanup(patch.stop)

    def forge(self, argv):
        if "search/issues" in argv:
            return self.result
        return self.metadata[int(argv[-1].rsplit("/", 1)[-1])]

    def pr(self, number, head="a" * 40, target="merge-queue"):
        self.metadata[number] = {
            "number": number, "state": "open", "merged": False, "merge_commit_sha": None,
            "user": {"login": "author"}, "head": {"sha": head},
            "base": {"ref": target, "repo": {"full_name": crq.REPO}}}
        return {"number": number, "pull_request": {"url": f"fixture/{number}"}}

    def binding(self, target):
        return {"kind": "deferred-author", "repo": crq.REPO, "producer": "author",
                "head": "a" * 40, "target": target, "targetSelector": "promoted-main"}

    def refresh(self, q):
        return deferred_refresh.refresh_deferred(q, verify_source=crq.verify_deferred_source,
                                                 find_source=crq.find_deferred_source, at="now")

    def test_configured_branch_target_verifies(self):
        self.pr(12, target="release/1.4")
        self.assertEqual(crq.verify_deferred_source(crq.REPO, 12)["target"], "release/1.4")

    def test_configured_branch_target_is_found_and_clears_the_identity_blocker(self):
        row = self.pr(12, target="release/1.4")
        self.result = {"incomplete_results": False, "total_count": 1, "items": [row]}
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": self.binding("release/1.4"), "state": "awaiting-pr", "createdAt": "before"}}}
        self.refresh(q)
        entry = q["queue_client_requests"]["request-1"]
        self.assertEqual(entry["state"], "awaiting-merge")
        self.assertEqual(entry["pr"], 12)
        self.assertNotIn("reason", entry)

    def test_configured_branch_target_still_refuses_a_malformed_target(self):
        self.pr(12, target="release/1.4")
        for bad in ("a..b", "release//1.4", "x.lock", "@"):
            with self.subTest(target=bad):
                with self.assertRaises(ValueError):
                    crq.find_deferred_source(crq.REPO, "author", "a" * 40, bad, 2)

    def test_cross_target_drift_still_blocks(self):
        # Binding says release/1.4 but the forge PR actually targets release/2.0:
        # dropping the hardcoded constant must not weaken the immutable binding.
        self.pr(12, target="release/2.0")
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": self.binding("release/1.4"), "state": "awaiting-merge", "pr": 12,
            "createdAt": "before"}}}
        self.refresh(q)
        entry = q["queue_client_requests"]["request-1"]
        self.assertEqual(entry["reason"]["category"], "identity")
        self.assertEqual(q["items"], [])
