"""Q6 recovery fixtures: no Q2 discovery, provider, scheduler or credentials."""
import copy
import unittest

import deferred_refresh as refresh


class DeferredRefreshTests(unittest.TestCase):
    def setUp(self):
        self.binding = {"kind": "deferred-author", "repo": "owner/repo", "producer": "author",
                        "head": "a" * 40, "target": "merge-queue", "targetSelector": "promoted-main"}
        self.entry = {"binding": copy.deepcopy(self.binding), "principal": "server-principal",
                      "state": "awaiting-pr", "createdAt": "before", "deliveries": {"old": {"next": 1}},
                      "consumed": "old"}
        self.q = {"items": [], "queue_client_requests": {"request-1": self.entry}}
        self.forge = {**self.binding, "pr": 12, "state": "OPEN", "mergeSha": None}
        self.found = [self.forge]

    def run_refresh(self, **kwargs):
        return refresh.refresh_deferred(self.q, verify_source=lambda repo, pr: self.forge,
            find_source=lambda repo, producer, head, target, limit: self.found, at="now", **kwargs)

    def test_publication_crash_merge_crash_replay_without_discovery_or_duplicate_work(self):
        # Publication happened, client died before bind. Recover the unique exact PR.
        self.run_refresh()
        self.assertEqual(self.entry["state"], "awaiting-merge")
        self.assertEqual(self.entry["pr"], 12)
        self.assertEqual(self.q["items"], [])
        # Simulate persistence/restart, then merge observed by the sole runner.
        self.q = copy.deepcopy(self.q)
        self.entry = self.q["queue_client_requests"]["request-1"]
        self.forge.update(state="MERGED", mergeSha="b" * 40)
        self.run_refresh()
        self.run_refresh()
        self.assertEqual(self.entry["state"], "ready-current")
        self.assertEqual(len(self.q["items"]), 1)
        item = self.q["items"][0]
        self.assertEqual(item["attempts"], [])
        self.assertNotIn("capture", item)  # Q1 captures promoted target only at dispatch.
        # A crash before queue save is replayed from pre-merge state.
        self.entry["state"] = "awaiting-merge"
        self.run_refresh()
        self.assertEqual(len(self.q["items"]), 1)
        self.assertEqual(self.entry["binding"], self.binding)
        self.assertEqual(self.entry["principal"], "server-principal")
        self.assertEqual(self.entry["deliveries"], {"old": {"next": 1}})
        self.assertEqual(self.entry["consumed"], "old")

    def test_unpublished_cancelled_closed_and_ambiguous_never_dispatch(self):
        self.found = []
        self.run_refresh()
        self.assertEqual(self.entry["state"], "awaiting-pr")
        self.entry["state"] = "cancelled"
        self.assertEqual(self.run_refresh(), [])
        self.entry["state"] = "awaiting-pr"
        self.found = [self.forge, self.forge]
        self.run_refresh()
        self.assertEqual(self.entry["reason"]["category"], "identity")
        self.assertEqual(self.q["items"], [])
        self.entry["state"] = "awaiting-pr"
        self.found = [self.forge]
        self.forge["state"] = "CLOSED"
        self.run_refresh()
        self.assertEqual(self.entry["state"], "cancelled")

    def test_changed_identity_and_bad_merge_are_blocking_not_vendor_debt(self):
        for key in ["head", "producer", "target", "repo", "pr"]:
            with self.subTest(key=key):
                self.entry.update(state="awaiting-merge", pr=12)
                original = self.forge[key]
                self.forge[key] = 99 if key == "pr" else "changed"
                self.run_refresh()
                self.assertEqual(self.entry["reason"]["category"], "identity")
                self.forge[key] = original
        self.entry["state"] = "awaiting-merge"
        self.forge.update(state="MERGED", mergeSha="bad")
        self.run_refresh()
        self.assertEqual(self.q["items"], [])

    def test_bounded_fair_refresh_and_retryable_forge_failure(self):
        self.q["queue_client_requests"]["request-2"] = copy.deepcopy(self.entry)
        self.found = []
        self.assertEqual(self.run_refresh(limit=1), ["request-1"])
        self.assertEqual(self.run_refresh(limit=1), ["request-2"])
        def offline(*args):
            raise OSError("private API payload should not be persisted")
        refresh.refresh_deferred(self.q, verify_source=offline, find_source=offline, at="later", limit=1)
        self.assertIn("debt retained", self.entry["refreshError"])
        self.assertEqual(self.entry["state"], "awaiting-pr")
        self.assertNotIn("private", str(self.q))
        self.run_refresh()
        self.assertNotIn("refreshError", self.entry)
        for limit in [0, 51, True]:
            with self.assertRaises(ValueError):
                self.run_refresh(limit=limit)

    def test_exhausted_budget_preserves_current_intent_and_cursor(self):
        self.q["deferred_refresh_cursor"] = "before"
        before = copy.deepcopy(self.q)
        self.assertEqual(self.run_refresh(may_continue=lambda: False), [])
        self.assertEqual(self.q, before)
        def exhausted(*args):
            raise refresh.RefreshExhausted("no more reads")
        result = refresh.refresh_deferred(self.q, verify_source=exhausted,
            find_source=exhausted, at="later")
        self.assertEqual(result, [])
        self.assertEqual(self.q, before)
