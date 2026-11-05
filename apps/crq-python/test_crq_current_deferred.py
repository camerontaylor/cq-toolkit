"""Deferred refresh: durable bindings, bounded search and lost publication.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock
import deferred_refresh
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def test_fix_pr_lookup_honors_exhausted_forge_budget(self):
        with crq.forge_window(crq.ForgeBudget(requests=0)), mock.patch.object(crq, 'run') as process:
            with self.assertRaises(crq.deferred_refresh.RefreshExhausted):
                crq.pr_info(9)
            process.assert_not_called()

    def test_deferred_merge_saved_before_planning_and_restart_idempotent(self):
        original = copy.deepcopy(self.deferred_entry())
        def assert_persisted_then_wait(q, item, dry):
            persisted = crq.load_queue()
            self.assertEqual(persisted["queue_client_requests"]["deferred-42"]["state"], "ready-current")
            self.assertEqual(persisted["merged_current_requests"]["deferred-42"]["item"], item["id"])
            raise crq.NotReady("fixture wait after durable binding")
        with mock.patch.object(crq, "gh_json", return_value=self.forge_data()) as forge, \
             mock.patch.object(crq, "prepare_current", side_effect=assert_persisted_then_wait):
            self.assertEqual(self.tick(), 0)
            forge.assert_called_once_with(["api", f"repos/{crq.REPO}/pulls/42"])
            durable = crq.load_queue()
            entry = durable["queue_client_requests"]["deferred-42"]
            for key in ("binding", "principal", "deliveries", "consumed"):
                self.assertEqual(entry[key], original[key])
            identity = durable["merged_current_requests"]["deferred-42"]
            forge.reset_mock()
            self.assertEqual(self.tick(), 0)
            forge.assert_not_called()
            restarted = crq.load_queue()
            self.assertEqual(restarted["merged_current_requests"]["deferred-42"], identity)
            self.assertEqual(len(restarted["items"]), 1)

    def test_deferred_drift_and_config_boundary_never_enroll(self):
        for field in ("producer", "head", "target", "repo"):
            with self.subTest(field=field):
                entry = self.deferred_entry()
                entry["binding"][field] = "other/repo" if field == "repo" else "drift"
                crq.save_queue(self.q)
                with mock.patch.object(crq, "gh_json", return_value=self.forge_data()) as forge:
                    self.assertEqual(self.tick(), 0)
                    if field == "repo":
                        forge.assert_not_called()
                q = crq.load_queue()
                self.assertEqual(q["items"], [])
                self.assertNotIn("merged_current_requests", q)
                self.assertEqual(q["queue_client_requests"]["deferred-42"]["reason"],
                                 {"source": "queue", "category": "identity", "code": "forge-identity"})

    def test_deferred_transient_retry_and_failed_save_never_dispatch(self):
        self.deferred_entry()
        with mock.patch.object(crq, "gh_json", side_effect=RuntimeError("private remote failure")):
            self.assertEqual(self.tick(), 0)
        q = crq.load_queue()
        self.assertEqual(q["queue_client_requests"]["deferred-42"]["state"], "awaiting-merge")
        self.assertIn("debt retained", q["queue_client_requests"]["deferred-42"]["refreshError"])
        self.assertNotIn("private remote failure", json.dumps(q))
        with mock.patch.object(crq, "gh_json", return_value=self.forge_data()), \
             mock.patch.object(crq, "save_queue", side_effect=OSError("disk full")), \
             mock.patch.object(crq, "launch") as launch:
            with self.assertRaises(OSError):
                self.tick()
            launch.assert_not_called()
        self.assertNotIn("merged_current_requests", crq.load_queue())
        with mock.patch.object(crq, "gh_json", return_value=self.forge_data()), \
             mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("fixture wait")):
            self.assertEqual(self.tick(), 0)
        self.assertEqual(crq.load_queue()["queue_client_requests"]["deferred-42"]["state"], "ready-current")

    def test_deferred_only_natural_non_dry_tick_refreshes(self):
        self.deferred_entry()
        with mock.patch.object(crq.deferred_refresh, "refresh_deferred", return_value=[]) as refresh:
            self.tick(dry=True)
            self.tick(only="selective")
            refresh.assert_not_called()
            self.tick()
            self.assertEqual(refresh.call_count, 1)
            self.assertEqual(refresh.call_args.kwargs["limit"], 20)

    def test_deferred_lost_publication_exact_all_state_search_and_ambiguity(self):
        self.deferred_entry(pr=None)
        search = {"total_count": 1, "incomplete_results": False,
                  "items": [{"number": 42, "pull_request": {}}]}
        with mock.patch.object(crq, "gh_json", side_effect=[search, self.forge_data()]) as forge, \
             mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("fixture wait")):
            self.assertEqual(self.tick(), 0)
        args = forge.call_args_list[0].args[0]
        self.assertIn("per_page=2", args)
        self.assertIn("page=1", args)
        query = next(a for a in args if a.startswith("q="))
        self.assertIn("is:pr", query)
        self.assertIn(self.merge, query)
        self.assertNotIn("is:open", query)
        self.assertNotIn("is:merged", query)
        self.assertEqual(crq.load_queue()["queue_client_requests"]["deferred-42"]["pr"], 42)
        self.q = {"items": [], "starts": [], "paused": False, "created_at": crq.iso()}
        self.deferred_entry(pr=None)
        search["total_count"] = 2
        search["items"].append({"number": 43, "pull_request": {}})
        with mock.patch.object(crq, "gh_json", side_effect=[search, self.forge_data(), self.forge_data(43)]):
            self.assertEqual(self.tick(), 0)
        q = crq.load_queue()
        self.assertEqual(q["items"], [])
        self.assertEqual(q["queue_client_requests"]["deferred-42"]["reason"]["code"], "forge-identity")

    def test_deferred_search_incomplete_empty_and_closed(self):
        self.deferred_entry(pr=None)
        for result in ({"total_count": 3, "items": [], "incomplete_results": False},
                       {"total_count": 1, "items": [], "incomplete_results": False},
                       {"total_count": 0, "items": [], "incomplete_results": True},
                       {"total_count": 0, "items": [], "incomplete_results": False}):
            with self.subTest(result=result), mock.patch.object(crq, "gh_json", return_value=result):
                self.assertEqual(self.tick(), 0)
                q = crq.load_queue()
                self.assertEqual(q["items"], [])
                self.assertEqual(q["queue_client_requests"]["deferred-42"]["state"], "awaiting-pr")
                self.assertEqual("refreshError" in q["queue_client_requests"]["deferred-42"],
                                 result["total_count"] != 0 or result["incomplete_results"])
        self.q = crq.load_queue()
        self.deferred_entry()
        closed = dict(self.forge_data(), merged=False, merge_commit_sha=None)
        with mock.patch.object(crq, "gh_json", return_value=closed):
            self.assertEqual(self.tick(), 0)
        self.assertEqual(crq.load_queue()["queue_client_requests"]["deferred-42"]["state"], "cancelled")

    def test_deferred_forge_timeout_and_invalid_metadata_retain_debt(self):
        self.deferred_entry()
        with mock.patch.object(crq, "gh_json", side_effect=subprocess.TimeoutExpired(["gh"], 120)):
            self.assertEqual(self.tick(), 0)
        self.assertIn("refreshError", crq.load_queue()["queue_client_requests"]["deferred-42"])
        for change in ({"base": {"ref": "merge-queue", "repo": {"full_name": "other/repo"}}},
                       {"base": {"ref": "main", "repo": {"full_name": crq.REPO}}},
                       {"number": True}, {"merged": True, "merge_commit_sha": None},
                       {"head": {"sha": "not-immutable"}}, {"merged": True, "state": "open"}):
            with self.subTest(change=change), mock.patch.object(crq, "gh_json", return_value=dict(self.forge_data(), **change)):
                self.assertEqual(self.tick(), 0)
                q = crq.load_queue()
                self.assertEqual(q["items"], [])
                self.assertEqual(q["queue_client_requests"]["deferred-42"]["reason"]["code"], "forge-identity")

    def test_deferred_bounded_round_robin_known_requests(self):
        entry = self.deferred_entry()
        self.q["queue_client_requests"] = {f"deferred-{n:02}": copy.deepcopy(entry) for n in range(21)}
        crq.save_queue(self.q)
        data = dict(self.forge_data(), merged=False, state="open", merge_commit_sha=None)
        with mock.patch.object(crq, "gh_json", return_value=data) as forge:
            self.assertEqual(self.tick(), 0)
            self.assertEqual(forge.call_count, 20)
            q = crq.load_queue()
            self.assertEqual(sum("refreshedAt" in e for e in q["queue_client_requests"].values()), 20)
            self.assertNotIn("refreshedAt", q["queue_client_requests"]["deferred-20"])
            forge.reset_mock()
            self.assertEqual(self.tick(), 0)
            self.assertEqual(forge.call_count, 20)
            q = crq.load_queue()
            self.assertTrue(all("refreshedAt" in e for e in q["queue_client_requests"].values()))
            self.assertEqual(q["items"], [])

    def test_shared_read_budget_stops_mid_search_and_resumes_same_intent(self):
        entry = copy.deepcopy(self.deferred_entry(pr=None))
        self.q["queue_client_requests"] = {f"request-{n}": copy.deepcopy(entry) for n in range(3)}
        crq.save_queue(self.q)
        original_run = crq.run
        search = {"total_count": 1, "incomplete_results": False,
                  "items": [{"number": 42, "pull_request": {}}]}
        calls = []
        def fake_run(argv, **kwargs):
            if argv[0] != "gh":
                return original_run(argv, **kwargs)
            calls.append(argv)
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], 10)
            value = search if "search/issues" in argv else dict(self.forge_data(), merged=False, state="open")
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)
        with mock.patch.object(crq, "ForgeBudget", return_value=crq.ForgeBudget(requests=3)), \
             mock.patch.object(crq, "run", side_effect=fake_run):
            self.tick()
        saved = crq.load_queue()
        self.assertEqual(len(calls), 3)  # search+verify first; search second, no verify allowance
        self.assertEqual(saved["deferred_refresh_cursor"], "request-0")
        self.assertEqual(saved["queue_client_requests"]["request-1"], entry)
        self.assertEqual(saved["queue_client_requests"]["request-2"], entry)
        calls.clear()
        with mock.patch.object(crq, "ForgeBudget", return_value=crq.ForgeBudget(requests=2)), \
             mock.patch.object(crq, "run", side_effect=fake_run):
            self.tick()
        resumed = crq.load_queue()
        self.assertEqual(len(calls), 2)
        self.assertEqual(resumed["deferred_refresh_cursor"], "request-1")
        self.assertEqual(resumed["queue_client_requests"]["request-2"], entry)


class DeferredSourceSearchTest(unittest.TestCase):
    """Q14: publication recovery reads search text as a hint, never as identity.

    The search request carries the head sha as free text, so unrelated well-formed
    PRs by the same producer and base come back. Those are skipped; malformed
    candidates, an incomplete envelope and duplicates still fail closed.
    """

    def setUp(self):
        self.result = self.envelope()
        self.metadata = {}
        patch = mock.patch.object(crq, "deferred_forge", self.forge)
        patch.start()
        self.addCleanup(patch.stop)

    def forge(self, argv):
        """The only forge boundary: search envelope or one PR's raw metadata."""
        if "search/issues" in argv:
            return self.result
        return self.metadata[int(argv[-1].rsplit("/", 1)[-1])]

    def pr(self, number, head="a" * 40, **over):
        record = {"number": number, "state": "open", "merged": False, "merge_commit_sha": None,
                  "user": {"login": "author"}, "head": {"sha": head},
                  "base": {"ref": "merge-queue", "repo": {"full_name": crq.REPO}}}
        record.update(over)
        self.metadata[number] = record
        return {"number": number, "pull_request": {"url": f"fixture/{number}"}}

    def envelope(self, *items, **over):
        return dict({"incomplete_results": False, "total_count": len(items),
                     "items": list(items)}, **over)

    def find(self, **over):
        args = dict({"repo": crq.REPO, "producer": "author", "head": "a" * 40,
                     "target": "merge-queue", "limit": 2}, **over)
        return crq.find_deferred_source(**args)

    def test_nonmatching_wellformed_candidate_is_skipped_not_blocking(self):
        self.result = self.envelope(self.pr(12), self.pr(13, head="c" * 40))
        self.assertEqual([m["pr"] for m in self.find()], [12])

    def test_all_nonmatching_candidates_read_as_unpublished(self):
        self.result = self.envelope(self.pr(12, head="c" * 40), self.pr(13, head="d" * 40))
        self.assertEqual(self.find(), [])

    def test_matching_candidate_after_noise_is_still_recovered(self):
        self.result = self.envelope(self.pr(12, head="c" * 40), self.pr(13))
        self.assertEqual([m["pr"] for m in self.find()], [13])

    def test_refresh_reads_search_noise_as_unpublished_not_an_identity_blocker(self):
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": {"kind": "deferred-author", "repo": crq.REPO, "producer": "author",
                        "head": "a" * 40, "target": "merge-queue", "targetSelector": "promoted-main"},
            "state": "awaiting-pr", "createdAt": "before"}}}
        self.result = self.envelope(self.pr(12, head="c" * 40), self.pr(13, head="d" * 40))
        self.assertEqual(deferred_refresh.refresh_deferred(
            q, verify_source=crq.verify_deferred_source, find_source=crq.find_deferred_source,
            at="now"), ["request-1"])
        entry = q["queue_client_requests"]["request-1"]
        self.assertEqual(entry["state"], "awaiting-pr")
        self.assertNotIn("reason", entry)          # never an identity blocker
        self.assertNotIn("refreshError", entry)    # not vendor debt either
        self.assertEqual(q["deferred_refresh_cursor"], "request-1")
        self.assertEqual(q["items"], [])

    def test_bound_intent_still_fails_closed_on_head_drift(self):
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": {"kind": "deferred-author", "repo": crq.REPO, "producer": "author",
                        "head": "a" * 40, "target": "merge-queue", "targetSelector": "promoted-main"},
            "state": "awaiting-merge", "pr": 12, "createdAt": "before"}}}
        self.pr(12, head="c" * 40)                 # bound head no longer the PR head
        deferred_refresh.refresh_deferred(q, verify_source=crq.verify_deferred_source,
                                          find_source=crq.find_deferred_source, at="now")
        self.assertEqual(q["queue_client_requests"]["request-1"]["reason"]["category"], "identity")
        self.assertEqual(q["items"], [])

    def test_malformed_incomplete_and_over_limit_searches_fail_closed(self):
        row = self.pr(12)
        cases = [
            ("candidate is not a forge PR", ValueError, dict(items=[17], total_count=1)),
            ("candidate names no pull request", ValueError, dict(items=[{"number": 12}], total_count=1)),
            ("incomplete index", RuntimeError,
             dict(items=[], total_count=0, incomplete_results=True)),
            ("total above the bounded limit", RuntimeError,
             dict(items=[self.pr(12), self.pr(13), self.pr(14)], total_count=3)),
            ("count disagrees with items", RuntimeError, dict(items=[row], total_count=2)),
        ]
        for label, expected, envelope in cases:
            with self.subTest(label):
                self.result = dict({"incomplete_results": False}, **envelope)
                with self.assertRaises(expected):
                    self.find()

    def test_duplicate_candidates_fail_closed_whether_or_not_they_match(self):
        row = self.pr(12)
        for label, head in (("matching", "a" * 40), ("non-matching", "c" * 40)):
            with self.subTest(label):
                self.pr(12, head=head)
                self.result = self.envelope(row, row)
                with self.assertRaises(RuntimeError):
                    self.find()

    def test_malformed_trusted_reread_and_binding_are_refused(self):
        # A non-merge-queue base ref is now a legitimate configured target, so the
        # malformed-reread probe uses a trusted re-read that names another repository
        # (and the binding loop uses actually invalid ref strings).
        self.result = self.envelope(
            self.pr(12, base={"ref": "release/1.4", "repo": {"full_name": "other/repo"}}))
        with self.assertRaises(ValueError):
            self.find()
        for over in (dict(repo="other/repo"), dict(producer="author name"), dict(head="xyz"),
                     dict(target="a..b"), dict(target="release//1.4"), dict(limit=3),
                     dict(limit=True)):
            with self.subTest(over=over):
                with self.assertRaises(ValueError):
                    self.find(**over)
