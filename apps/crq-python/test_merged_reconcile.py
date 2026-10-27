"""Q2 merged-interval reconciliation: offline fixtures only.

No live forge, provider, scheduler or repair: pages are fakes, the interval
is frozen in the fixture, and every assertion is about REPRESENTATION and
honest incompleteness, never review credit.
"""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_merged_reconcile", ROOT / "merged_reconcile.py")
mr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mr)

A = "2026-10-01T00:00:00Z"
B = "2026-10-27T00:00:00Z"  # frozen upper bound


def sha(n: int) -> str:
    return format(n, "040x")


def pr(n: int, at: str, merge: str = None, head: str = None) -> dict:
    return {"number": n, "mergedAt": at,
            "mergeCommit": {"oid": merge or sha(n)},
            "headRefOid": head or sha(n + 1000)}


def cursor_page(records: list, next_cursor=None) -> list:
    """Attach the fetcher's trailing cursor marker to the LAST record."""
    if next_cursor is None or not records:
        return records
    out = [dict(record) for record in records]
    out[-1]["__next_cursor"] = next_cursor
    return out


class FakeForge:
    """Deterministic multi-page forge: cursor -> records; walks sequentially."""

    def __init__(self, pages: dict):
        self.pages = pages
        self.calls = []

    def fetch(self, cursor):
        self.calls.append(cursor)
        return self.pages[cursor]


class IntervalTests(unittest.TestCase):
    def test_interval_shape_and_order_refused(self):
        for after, before in [("bad", B), (A, "2026-10-27 00:00:00"),
                              (A, A), (B, A), (None, B), (A, 17)]:
            with self.subTest(after=after, before=before):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.normalize_interval(after, before)
        self.assertEqual(mr.normalize_interval(A, B), {"after": A, "before": B})

    def test_page_budget_is_bounded_positive_integer(self):
        for budget in [0, -1, True, "3", 3.0, None, mr.MAX_PAGE_BUDGET + 1]:
            with self.subTest(budget=budget):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.normalize_page_budget(budget)
        self.assertEqual(mr.normalize_page_budget(1), 1)
        self.assertEqual(mr.normalize_page_budget(mr.MAX_PAGE_BUDGET),
                         mr.MAX_PAGE_BUDGET)


class RecordIdentityTests(unittest.TestCase):
    def test_well_formed_record_proposes_the_q1_subject_shape(self):
        identity = mr.record_identity(pr(5, "2026-10-03T04:05:06Z"))
        self.assertEqual(identity["disposition"], "intent")
        self.assertEqual(identity["subject"],
                         {"repo": None, "pr": 5, "merge_sha": sha(5),
                          "target_selector": "promoted-main",
                          "policy": "affected-current-additions-v1"})

    def test_unsupported_records_name_their_reason(self):
        cases = [("not an object", "junk"),
                 ("malformed number", {"number": "seven", "mergedAt": A,
                                       "mergeCommit": {"oid": sha(1)}, "headRefOid": sha(2)}),
                 ("bad mergedAt", {**pr(1, A), "mergedAt": "yesterday"}),
                 ("missing merge identity", {**pr(1, A), "mergeCommit": None}),
                 ("source head gone", {**pr(1, A), "headRefOid": None}),
                 ("malformed head", {**pr(1, A), "headRefOid": "deadbeef"})]
        for name, record in cases:
            with self.subTest(record=name):
                identity = mr.record_identity(record)
                self.assertEqual(identity["disposition"], "unsupported")
                self.assertTrue(identity["reason"])


class PagingTests(unittest.TestCase):
    def test_over_100_prs_across_many_pages_all_represented(self):
        total = 250
        page_size = 40
        pages, records = {}, []
        for index in range(total):
            records.append(pr(index + 1, "2026-10-%02dT12:00:00Z" % (1 + index // 25)))
        for start in range(0, total, page_size):
            chunk = records[start:start + page_size]
            more = start + page_size < total
            pages[None if start == 0 else "c%d" % start] = cursor_page(
                chunk, "c%d" % (start + page_size) if more else None)
        forge = FakeForge(pages)
        result = mr.reconcile(None, forge.fetch, after=A, before=B,
                              page_budget=mr.MAX_PAGE_BUDGET)
        self.assertTrue(result["complete"])
        self.assertEqual(result["summary"]["intents"], total)
        self.assertEqual(result["summary"]["unsupported"], 0)
        self.assertEqual(len(forge.calls), total // page_size + 1)

    def test_page_budget_stops_honestly_incomplete_with_next_cursor(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                                    pr(2, "2026-10-03T00:00:00Z")], "c1"),
                 "c1": cursor_page([pr(3, "2026-10-04T00:00:00Z")], None)}
        forge = FakeForge(pages)
        result = mr.reconcile(None, forge.fetch, after=A, before=B, page_budget=1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], "c1")
        self.assertEqual(result["summary"]["intents"], 2)
        self.assertEqual(result["summary"]["pending_review"], 2)

    def test_same_time_merges_have_stable_order(self):
        forge = FakeForge({None: cursor_page([pr(9, A[:11] + "05:00:00Z"),
                                              pr(7, A[:11] + "05:00:00Z"),
                                              pr(8, A[:11] + "05:00:00Z")], None)})
        result = mr.reconcile(None, forge.fetch, after=A, before=B, page_budget=1)
        order = [entry["pr"] for entry in result["inventory"]]
        self.assertEqual(order, [7, 8, 9])

    def test_prs_merged_outside_the_frozen_window_are_never_represented(self):
        def fetch(cursor):
            if cursor is None:
                return cursor_page([pr(1, "2026-10-01T00:00:00Z" if False else "2026-09-30T23:59:59Z"),
                                    pr(2, "2026-10-28T00:00:00Z"),  # after 'before'
                                    pr(3, B)], "next")
            return []
        result = mr.reconcile(None, fetch, after=A, before=B, page_budget=2)
        self.assertEqual([entry["pr"] for entry in result["inventory"]], [3])

    def test_transient_page_failure_never_advances_the_watermark(self):
        attempts = {"count": 0}

        def fetch(cursor):
            attempts["count"] += 1
            raise mr.PageFailed("gh: HTTP 502")

        result = mr.reconcile(None, fetch, after=A, before=B, page_budget=4)
        self.assertFalse(result["complete"])
        self.assertEqual(result["pages_read"], 0)
        self.assertEqual(result["transient_failures"], 1)
        self.assertFalse(result["steps"][-1]["watermark_advanced"])

    def test_transient_failure_after_progress_resumes_from_checkpoint(self):
        state = {"mode": "flaky"}

        def fetch(cursor):
            if state["mode"] == "flaky" and cursor == "c1":
                raise mr.PageFailed("rate limited")
            if cursor is None:
                return cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1")
            return cursor_page([pr(2, "2026-10-03T00:00:00Z")], None)

        first = mr.reconcile(None, fetch, after=A, before=B, page_budget=5)
        self.assertFalse(first["complete"])
        self.assertEqual(first["transient_failures"], 1)
        self.assertEqual(first["summary"]["intents"], 1)
        state["mode"] = "ok"  # transient condition cleared
        second = mr.reconcile(None, fetch, after=A, before=B, page_budget=5,
                              checkpoint_raw=first)
        self.assertTrue(second["complete"])
        self.assertEqual(second["summary"]["intents"], 2)
        self.assertEqual(second["transient_failures"], 1)  # history retained

    def test_interrupted_page_read_leaves_honest_incomplete(self):
        class HalfPage(FakeForge):
            def fetch(self, cursor):
                if cursor == "c1":
                    raise mr.PageFailed("connection reset mid-page")
                return super().fetch(cursor)

        forge = HalfPage({None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1"),
                          "c1": []})
        result = mr.reconcile(None, forge.fetch, after=A, before=B, page_budget=3)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], "c1")
        self.assertEqual(result["summary"]["intents"], 1)


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
            accumulated = mr.reconcile(None, self.forge.fetch, after=A, before=B,
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
        first = mr.reconcile(None, self.forge.fetch, after=A, before=B, page_budget=2)
        # simulate a process restart: JSON round-trip through disk
        serialized = json.dumps(first)
        resumed = mr.reconcile(None, self.forge.fetch, after=A, before=B,
                               page_budget=2, checkpoint_raw=json.loads(serialized))
        self.assertTrue(resumed["complete"])
        self.assertEqual(resumed["summary"]["intents"], 3)

    def test_duplicate_prs_never_double_count_across_pages(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                                    pr(1, "2026-10-02T00:00:00Z"),
                                    pr(1, "2026-10-02T00:00:00Z")], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, after=A, before=B,
                              page_budget=1)
        self.assertEqual(result["summary"]["intents"], 1)
        self.assertEqual(len(result["inventory"]), 1)

    def test_conflicting_merge_identity_for_one_pr_is_represented_not_silently_picked(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1"),
                 "c1": cursor_page([pr(1, "2026-10-02T00:00:00Z", merge=sha(77))], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, after=A, before=B,
                              page_budget=2)
        self.assertEqual(result["summary"]["intents"], 1)
        conflicts = [entry for entry in result["inventory"]
                     if entry.get("reason") == "conflicting merge identity for one PR"]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["observed"]["merge_sha"], sha(77))

    def test_checkpoint_from_another_interval_or_budget_is_refused(self):
        first = mr.reconcile(None, self.forge.fetch, after=A, before=B, page_budget=1)
        for after, before, budget in [(A, "2026-10-28T00:00:00Z", 1),
                                      ("2026-10-02T00:00:00Z", B, 1),
                                      (A, B, 5)]:
            with self.subTest(after=after, before=before, budget=budget):
                with self.assertRaisesRegex(mr.ReconcileRefused, "checkpoint"):
                    mr.reconcile(None, self.forge.fetch, after=after, before=before,
                                 page_budget=budget, checkpoint_raw=first)

    def test_completed_checkpoint_refuses_resume(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], None)}
        done = mr.reconcile(None, FakeForge(pages).fetch, after=A, before=B,
                            page_budget=1)
        self.assertTrue(done["complete"])
        with self.assertRaisesRegex(mr.ReconcileRefused, "already complete"):
            mr.reconcile(None, self.forge.fetch, after=A, before=B, page_budget=1,
                         checkpoint_raw=done)

    def test_malformed_checkpoint_shapes_refuse(self):
        # None is not a resume: it means "start fresh"; everything else that
        # is not a well-formed incomplete checkpoint must refuse.
        for raw in ["junk", [], {}, {"schema_version": 99},
                    {"schema_version": 1, "after": A, "before": B, "page_budget": 1}]:
            with self.subTest(raw=type(raw).__name__):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.reconcile(None, self.forge.fetch, after=A, before=B,
                                 page_budget=1, checkpoint_raw=raw)
        fresh = mr.reconcile(None, self.forge.fetch, after=A, before=B,
                             page_budget=1, checkpoint_raw=None)
        self.assertEqual(fresh["pages_read"], 1)


class SummaryTests(unittest.TestCase):
    def test_totals_reconcile_to_the_inventory_with_honest_buckets(self):
        pages = {
            None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                               {**pr(2, "2026-10-03T00:00:00Z"), "mergeCommit": None},
                               {"number": 3, "mergedAt": "nope",
                                "mergeCommit": {"oid": sha(3)}, "headRefOid": sha(4)}],
                              None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, after=A, before=B,
                              page_budget=1)
        summary = result["summary"]
        self.assertEqual(summary["represented"], 3)
        self.assertEqual(summary["intents"], 1)
        self.assertEqual(summary["unsupported"], 2)
        self.assertEqual(summary["represented"],
                         summary["intents"] + summary["unsupported"])
        # pending/skip is never counted as reviewed
        self.assertEqual(summary["reviewed"], 0)
        self.assertEqual(summary["pending_review"], summary["intents"])
        self.assertTrue(summary["complete"])

    def test_deletion_only_small_and_docs_changes_still_become_intents(self):
        # discovery is scope-blind: path knowledge belongs to the tick's
        # capture, not the inventory
        pages = {None: cursor_page([pr(10, "2026-10-07T00:00:00Z"),
                                    pr(11, "2026-10-07T00:00:01Z"),
                                    pr(12, "2026-10-07T00:00:02Z")], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, after=A, before=B,
                              page_budget=1)
        self.assertEqual(result["summary"]["intents"], 3)


class NoSideEffectTests(unittest.TestCase):
    def test_pure_module_never_touches_queue_or_claims_review(self):
        source = (ROOT / "merged_reconcile.py").read_text()
        for forbidden in ("gh_json", "subprocess", "save_queue", "load_queue",
                          "repair_tick", "author_quota", "run([", "requests."):
            self.assertNotIn(forbidden, source)
        # no vendor call happened in these tests: every page was a fake


if __name__ == "__main__":
    unittest.main()
