"""Dedupe and resume: page-boundary restarts and checkpoint refusal.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import json
import unittest

from test_merged_reconcile_fixtures import A, B, FakeForge, cursor_page, mr, pr, sha


class DedupeAndResumeTests(unittest.TestCase):
    def setUp(self):
        self.pages = {
            None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                               pr(2, "2026-10-02T00:00:00Z")], "c1"),
            "c1": cursor_page([pr(3, "2026-10-05T00:00:00Z"),
                               {**pr(4, "2026-10-06T00:00:00Z"),
                                "mergeCommit": None}], "c2"),
            "c2": cursor_page([pr(1, "2026-10-02T00:00:00Z")],  # overlap replay
                              "c3"),
            "c3": [],
        }
        self.forge = FakeForge(self.pages)

    def test_restart_on_each_page_boundary_dedupes_and_completes(self):
        accumulated = None
        for budget in (1, 1, 1, 1):
            accumulated = mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B,
                                       page_budget=budget,
                                       checkpoint_raw=accumulated)
        self.assertTrue(accumulated["complete"])
        self.assertEqual(accumulated["summary"]["intents"], 3)
        self.assertEqual(accumulated["summary"]["unsupported"], 1)
        self.assertEqual(accumulated["summary"]["represented"], 4)
        prs = sorted(entry["pr"] for entry in accumulated["inventory"])
        self.assertEqual(prs, [1, 2, 3, 4])
        # the replayed PR 1 kept ONE intent, not two
        self.assertEqual([entry["pr"] for entry in accumulated["inventory"]
                          if entry["pr"] == 1 and entry["disposition"] == "intent"],
                         [1])

    def test_serialized_checkpoint_resumes_after_process_restart(self):
        first = mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B, page_budget=2)
        # simulate a process restart: JSON round-trip through disk
        serialized = json.dumps(first)
        resumed = mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B,
                               page_budget=2, checkpoint_raw=json.loads(serialized))
        self.assertTrue(resumed["complete"])
        self.assertEqual(resumed["summary"]["intents"], 3)

    def test_duplicate_prs_never_double_count_across_pages(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                                    pr(1, "2026-10-02T00:00:00Z"),
                                    pr(1, "2026-10-02T00:00:00Z")], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                              page_budget=1)
        self.assertEqual(result["summary"]["intents"], 1)
        self.assertEqual(len(result["inventory"]), 1)

    def test_conflicting_merge_identity_for_one_pr_is_represented_not_silently_picked(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1"),
                 "c1": cursor_page([pr(1, "2026-10-02T00:00:00Z", merge=sha(77))], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                              page_budget=2)
        self.assertEqual(result["summary"]["intents"], 1)
        conflicts = [entry for entry in result["inventory"]
                     if entry.get("reason") == "conflicting merge identity for one PR"]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["observed"]["merge_sha"], sha(77))

    def test_checkpoint_from_another_interval_or_budget_is_refused(self):
        first = mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B, page_budget=1)
        for after, before, budget in [(A, "2026-10-28T00:00:00Z", 1),
                                      ("2026-10-02T00:00:00Z", B, 1),
                                      (A, B, 5)]:
            with self.subTest(repo="org/repo", after=after, before=before, budget=budget):
                with self.assertRaisesRegex(mr.ReconcileRefused, "checkpoint"):
                    mr.reconcile(None, self.forge.fetch, repo="org/repo", after=after, before=before,
                                 page_budget=budget, checkpoint_raw=first)

    def test_completed_checkpoint_refuses_resume(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], None)}
        done = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                            page_budget=1)
        self.assertTrue(done["complete"])
        with self.assertRaisesRegex(mr.ReconcileRefused, "already complete"):
            mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B, page_budget=1,
                         checkpoint_raw=done)

    def test_malformed_checkpoint_shapes_refuse(self):
        # None is not a resume: it means "start fresh"; everything else that
        # is not a well-formed incomplete checkpoint must refuse.
        for raw in ["junk", [], {}, {"schema_version": 99},
                    {"schema_version": 1, "after": A, "before": B, "page_budget": 1}]:
            with self.subTest(raw=type(raw).__name__):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B,
                                 page_budget=1, checkpoint_raw=raw)
        fresh = mr.reconcile(None, self.forge.fetch, repo="org/repo", after=A, before=B,
                             page_budget=1, checkpoint_raw=None)
        self.assertEqual(fresh["pages_read"], 1)
