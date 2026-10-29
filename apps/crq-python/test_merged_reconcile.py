"""Q2 merged-interval reconciliation: offline fixtures only.

No live forge, provider, scheduler or repair: pages are fakes, the interval
is frozen in the fixture, and every assertion is about REPRESENTATION and
honest incompleteness, never review credit.
"""
import importlib.util
import json
import copy
import tempfile
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


def cursor_page(records: list, next_cursor=None) -> dict:
    """Explicit forge pagination metadata, including on empty pages."""
    return {"records": records, "has_next_page": next_cursor is not None,
            "next_cursor": next_cursor}



class FakeForge:
    """Deterministic multi-page forge: cursor -> records; walks sequentially."""

    def __init__(self, pages: dict):
        self.pages = pages
        self.calls = []

    def fetch(self, cursor):
        self.calls.append(cursor)
        page = self.pages[cursor]
        return cursor_page(page) if isinstance(page, list) else page


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
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B,
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
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], "c1")
        self.assertEqual(result["summary"]["intents"], 2)
        self.assertEqual(result["summary"]["pending_review"], 2)

    def test_same_time_merges_have_stable_order(self):
        forge = FakeForge({None: cursor_page([pr(9, A[:11] + "05:00:00Z"),
                                              pr(7, A[:11] + "05:00:00Z"),
                                              pr(8, A[:11] + "05:00:00Z")], None)})
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=1)
        order = [entry["pr"] for entry in result["inventory"]]
        self.assertEqual(order, [7, 8, 9])

    def test_prs_merged_outside_the_frozen_window_are_never_represented(self):
        def fetch(cursor):
            if cursor is None:
                return cursor_page([pr(1, "2026-09-30T23:59:59Z"),
                                    pr(2, "2026-10-28T00:00:00Z"),  # after 'before'
                                    pr(3, B)], "next")
            return cursor_page([])
        result = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=2)
        self.assertEqual([entry["pr"] for entry in result["inventory"]], [3])

    def test_transient_page_failure_never_advances_the_watermark(self):
        attempts = {"count": 0}

        def fetch(cursor):
            attempts["count"] += 1
            raise mr.PageFailed("gh: HTTP 502")

        result = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=4)
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

        first = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=5)
        self.assertFalse(first["complete"])
        self.assertEqual(first["transient_failures"], 1)
        self.assertEqual(first["summary"]["intents"], 1)
        state["mode"] = "ok"  # transient condition cleared
        second = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=5,
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
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=3)
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


class SummaryTests(unittest.TestCase):
    def test_totals_reconcile_to_the_inventory_with_honest_buckets(self):
        pages = {
            None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                               {**pr(2, "2026-10-03T00:00:00Z"), "mergeCommit": None},
                               {"number": 3, "mergedAt": "nope",
                                "mergeCommit": {"oid": sha(3)}, "headRefOid": sha(4)}],
                              None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
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
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                              page_budget=1)
        self.assertEqual(result["summary"]["intents"], 3)


class NoSideEffectTests(unittest.TestCase):
    def test_pure_module_never_touches_queue_or_claims_review(self):
        source = (ROOT / "merged_reconcile.py").read_text()
        for forbidden in ("gh_json", "subprocess", "save_queue", "load_queue",
                          "repair_tick", "author_quota", "run([", "requests."):
            self.assertNotIn(forbidden, source)
        # no vendor call happened in these tests: every page was a fake



class DurableBoundaryTests(unittest.TestCase):
    def run_inventory(self, fetch, **kwargs):
        return mr.reconcile(None, fetch, repo="org/repo", after=A, before=B,
                            page_budget=kwargs.pop("page_budget", 3), **kwargs)

    def test_page_save_precedes_next_fetch_and_restart_after_real_disk_boundary(self):
        class Crash(Exception):
            pass

        pages = {None: cursor_page([pr(1, B)], "next"),
                 "next": cursor_page([pr(2, B), pr(1, B)])}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"

            def save(snapshot):
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps(snapshot))
                temporary.replace(path)

            def fetch(cursor):
                saved = json.loads(path.read_text())
                self.assertEqual(saved["cursor"], cursor)
                if cursor == "next":
                    raise Crash("process lost after first persisted page")
                return pages[cursor]

            with self.assertRaises(Crash):
                self.run_inventory(fetch, checkpoint_save=save)
            saved = json.loads(path.read_text())
            self.assertEqual(saved["pages_read"], 1)
            resumed = self.run_inventory(FakeForge(pages).fetch, checkpoint_raw=saved,
                                         checkpoint_save=save)
            self.assertTrue(resumed["complete"])
            self.assertEqual(resumed["summary"]["represented"], 2)
            self.assertEqual(resumed["summary"]["duplicates_seen"], 1)
            self.assertEqual(json.loads(path.read_text()), resumed)

    def test_save_failure_aborts_before_next_fetch(self):
        calls = []

        def fetch(cursor):
            calls.append(cursor)
            return cursor_page([pr(1, B)], "next")

        def save(snapshot):
            if snapshot["pages_read"]:
                raise OSError("disk full")

        with self.assertRaisesRegex(OSError, "disk full"):
            self.run_inventory(fetch, checkpoint_save=save)
        self.assertEqual(calls, [None])

    def test_callback_cannot_mutate_inventory_and_failed_fetch_does_not_mutate_resume_input(self):
        def save(snapshot):
            snapshot["inventory"].clear()
            snapshot["cursor_history"].clear()

        first = self.run_inventory(FakeForge({None: cursor_page([pr(1, B)], "next")}).fetch,
                                   page_budget=1, checkpoint_save=save)
        original = copy.deepcopy(first)

        def failed(cursor):
            self.assertEqual(cursor, "next")
            raise mr.PageFailed("temporary")

        second = self.run_inventory(failed, checkpoint_raw=first, page_budget=1)
        self.assertEqual(first, original)
        self.assertEqual(second["summary"]["intents"], 1)
        self.assertIsNone(second["summary"]["complete_through"])
        self.assertEqual(second["cursor"], first["cursor"])

    def test_dry_run_never_persists_or_mutates_queue(self):
        effects = {"items": [{"id": "legacy", "state": "skipped"}]}
        original = copy.deepcopy(effects)
        saved = []
        result = mr.reconcile(effects, FakeForge({None: cursor_page([pr(1, B)])}).fetch,
                              repo="org/repo", after=A, before=B, page_budget=1,
                              dry_run=True, checkpoint_save=saved.append)
        plan = mr.enrollment_plan(result, repo="org/repo", dry_run=True)
        self.assertTrue(plan["dry_run"])
        self.assertEqual(saved, [])
        self.assertEqual(effects, original)
        self.assertEqual(plan["reviewed"], 0)
        self.assertEqual(len(plan["entries"]), 1)

    def test_incomplete_result_cannot_produce_enrollment_even_with_dry_run_false(self):
        result = self.run_inventory(FakeForge({None: cursor_page([pr(1, B)], "next")}).fetch,
                                    page_budget=1)
        for dry_run in (True, False):
            with self.assertRaisesRegex(mr.ReconcileRefused, "incomplete"):
                mr.enrollment_plan(result, repo="org/repo", dry_run=dry_run)
        self.assertIsNone(result["summary"]["complete_through"])

    def test_explicit_empty_nonterminal_page_resumes_without_false_complete(self):
        forge = FakeForge({None: cursor_page([], "next"), "next": cursor_page([pr(1, B)])})
        first = self.run_inventory(forge.fetch, page_budget=1)
        self.assertFalse(first["complete"])
        second = self.run_inventory(forge.fetch, page_budget=1, checkpoint_raw=first)
        self.assertTrue(second["complete"])
        self.assertEqual(second["summary"]["complete_through"], B)

    def test_partial_ambiguous_oversized_and_cyclic_pages_are_refused(self):
        malformed = [[], {"records": []}, {"records": [], "has_next_page": True, "next_cursor": None},
                     {"records": [], "has_next_page": False, "next_cursor": "next"},
                     {"records": [], "has_next_page": True, "next_cursor": 3},
                     cursor_page([pr(n + 1, B) for n in range(mr.MAX_PAGE_RECORDS + 1)])]
        for page in malformed:
            with self.subTest(page=repr(page)[:100]):
                with self.assertRaises(mr.ReconcileRefused):
                    self.run_inventory(lambda cursor: page)
        forge = FakeForge({None: cursor_page([], "a"), "a": cursor_page([], "b"),
                           "b": cursor_page([], "a")})
        with self.assertRaisesRegex(mr.ReconcileRefused, "cycled"):
            self.run_inventory(forge.fetch)

    def test_explicit_incomplete_or_error_flags_refuse_even_with_terminal_cursor(self):
        for flags in ({"incomplete_results": True}, {"incomplete_results": "false"},
                      {"truncated": True}, {"errors": [{"message": "partial data"}]}):
            with self.subTest(flags=flags):
                saved = []
                page = {**cursor_page([pr(1, B)]), **flags}
                with self.assertRaisesRegex(mr.ReconcileRefused, "incomplete"):
                    self.run_inventory(lambda cursor: page, checkpoint_save=saved.append)
                self.assertEqual(len(saved), 1)  # only initial frozen boundary
                self.assertFalse(saved[0]["complete"])
                self.assertEqual(saved[0]["pages_read"], 0)

    def test_corrupted_checkpoints_and_changed_query_refuse_before_fetch(self):
        first = self.run_inventory(FakeForge({None: cursor_page([pr(1, B)], "next")}).fetch,
                                   page_budget=1)
        for field, value in [("cursor", 10), ("pages_read", True), ("complete", "false"),
                             ("seen", []), ("record_keys", []), ("records_read", 100),
                             ("cursor_history", ["a", "a"]), ("inventory", [{"disposition": "intent"}])]:
            with self.subTest(field=field):
                bad = copy.deepcopy(first)
                bad[field] = value
                bad["digest"] = mr.checkpoint_digest(bad)
                with self.assertRaises(mr.ReconcileRefused):
                    self.run_inventory(lambda cursor: self.fail("unexpected fetch"),
                                       checkpoint_raw=bad, page_budget=1)
        for kwargs in ({"repo": "other/repo"}, {"base": "main"}):
            arguments = dict(repo="org/repo", after=A, before=B, page_budget=1, checkpoint_raw=first)
            arguments.update(kwargs)
            with self.assertRaisesRegex(mr.ReconcileRefused, "repository/base"):
                mr.reconcile(None, lambda cursor: self.fail("unexpected fetch"), **arguments)
        bad = copy.deepcopy(first)
        bad["inventory"].clear()  # unchanged digest detects on-disk corruption
        with self.assertRaisesRegex(mr.ReconcileRefused, "digest"):
            self.run_inventory(lambda cursor: self.fail("unexpected fetch"),
                               checkpoint_raw=bad, page_budget=1)

    def test_unsupported_replay_conflicts_and_out_of_window_records_reconcile_totals(self):
        invalid = {**pr(2, B), "mergeCommit": {"oid": 7}}
        records = [pr(1, B), pr(1, B), invalid, invalid,
                   {**pr(3, A), "headRefOid": None},
                   {**pr(4, "2026-10-28T00:00:00Z"), "mergeCommit": None},
                   pr(1, B, merge=sha(88)), pr(1, B, merge=sha(88))]
        result = self.run_inventory(lambda cursor: cursor_page(records))
        summary = result["summary"]
        self.assertEqual(summary["duplicates_seen"], 3)
        self.assertEqual(summary["outside_window"], 2)
        self.assertEqual(summary["unsupported"], 2)
        self.assertEqual(summary["records_read"],
                         summary["represented"] + summary["outside_window"] + summary["duplicates_seen"])
        with self.assertRaisesRegex(mr.ReconcileRefused, "conflicting"):
            mr.enrollment_plan(result, repo="org/repo")

    def test_stable_q1_binding_replays_and_legacy_state_never_grants_review_credit(self):
        result = self.run_inventory(lambda cursor: cursor_page([pr(1, B), pr(2, B)]))
        plan = mr.enrollment_plan(result, repo="org/repo")
        binding = plan["entries"][0]["binding"]
        for state in ("synthetic", "skipped", "done"):
            effects = {"items": [{"pr": 1, "state": state}]}
            inventory = mr.reconcile(effects, lambda cursor: cursor_page([pr(1, B), pr(2, B)]),
                                     repo="org/repo", after=A, before=B, page_budget=3)
            repeated = mr.enrollment_plan(inventory, repo="org/repo", existing_requests=[binding])
            self.assertEqual(repeated["entries"][0]["disposition"], "already-enrolled")
            self.assertEqual(repeated["entries"][1]["disposition"], "intent")
            self.assertEqual(repeated["entries"][0]["request_id"], plan["entries"][0]["request_id"])
            self.assertEqual(inventory["summary"]["reviewed"], 0)
        with self.assertRaisesRegex(mr.ReconcileRefused, "repository/base"):
            mr.enrollment_plan(result, repo="other/repo")

    def test_real_q1_enroll_survives_lost_response_and_overlapping_interval(self):
        receipt_spec = importlib.util.spec_from_file_location("q2_q1_receipt", ROOT / "review_receipt.py")
        receipt = importlib.util.module_from_spec(receipt_spec)
        receipt_spec.loader.exec_module(receipt)
        queue = {"items": [{"id": "pr1-merged", "pr": 1, "state": "skipped",
                            "kind": "merged", "cycles": []}]}
        inventory = self.run_inventory(lambda cursor: cursor_page([pr(1, B)]))
        first = mr.enrollment_plan(inventory, repo="org/repo", dry_run=False)["entries"][0]

        def apply(entry):
            binding = {k: v for k, v in entry["binding"].items() if k != "policy"}
            return receipt.enroll(queue, **binding, request_id=entry["request_id"], at=B)

        self.assertTrue(apply(first)["created"])
        # Queue saved but caller lost the enrollment response; a new inventory
        # with a different overlapping interval still produces the same binding.
        queue = json.loads(json.dumps(queue))
        overlap = mr.reconcile(None, lambda cursor: cursor_page([pr(1, B)]),
                               repo="org/repo", after="2026-10-02T00:00:00Z", before=B, page_budget=1)
        replay = mr.enrollment_plan(overlap, repo="org/repo", dry_run=False)["entries"][0]
        self.assertEqual(first["request_id"], replay["request_id"])
        self.assertFalse(apply(replay)["created"])
        self.assertEqual(len(queue["items"]), 2)
        self.assertEqual(queue["items"][0]["state"], "skipped")
        self.assertEqual(queue["items"][1]["state"], "pending")
        self.assertEqual(queue["items"][1]["cycles"], [])

    def test_invalid_calendar_and_typed_merge_metadata_are_explicit_unsupported(self):
        records = [{**pr(1, B), "mergedAt": "2026-02-30T00:00:00Z"},
                   {**pr(2, B), "mergeCommit": {"oid": []}}]
        result = self.run_inventory(lambda cursor: cursor_page(records))
        self.assertEqual(result["summary"]["unsupported"], 2)
        self.assertEqual(result["summary"]["intents"], 0)


if __name__ == "__main__":
    unittest.main()


class NumericSourceTests(unittest.TestCase):
    def response(self, **fields):
        return {"data": {"repository": {"id": "R", "nameWithOwner": "owner/repo", **fields}}}

    def source(self, ceiling=125):
        return mr.freeze_source(lambda query: self.response(
            issues={"totalCount": 0, "nodes": []},
            pullRequests={"totalCount": ceiling, "nodes": [{"number": ceiling}]}),
            repo="owner/repo", base="merge-queue")

    def test_numeric_windows_survive_mutable_merge_order_and_new_prs(self):
        import re
        source = self.source()
        seen = []
        def forge(query):
            fields = {}
            for value in re.findall(r"issueOrPullRequest\(number:(\d+)\)", query):
                number = int(value)
                seen.append(number)
                fields["n" + value] = {"__typename": "PullRequest", "baseRefName": "merge-queue",
                    **pr(number, "2026-10-02T00:00:00Z" if number < 80 else "2026-10-28T00:00:00Z")}
            return self.response(**fields)
        cursor = None
        rows = []
        for _ in range(3):
            page = mr.number_page(forge, source, cursor, repo="owner/repo", base="merge-queue")
            rows.extend(page["records"])
            cursor = page["next_cursor"]
        self.assertEqual(seen, list(range(1, 126)))
        self.assertIsNone(cursor)
        self.assertEqual(len(rows), 125)
        # New number126 is outside frozen universe; merges after before filter out.
        result = mr.reconcile(None,
            lambda cursor: mr.number_page(forge, source, cursor, repo="owner/repo", base="merge-queue"),
            repo="owner/repo", after=A, before=B, page_budget=4)
        self.assertEqual(result["summary"]["intents"], 79)
        self.assertEqual(result["summary"]["outside_window"], 46)

    def test_missing_slot_errors_repo_drift_and_cursor_query_drift_refuse(self):
        source = self.source(1)
        for response in (self.response(n1=None), self.response(n1={"number": 1, "__typename": "Unknown"}),
                         {**self.response(), "errors": [{"message": "partial"}]},
                         self.response(id="replaced"), {**self.response(), "truncated": True}):
            with self.subTest(response=response), self.assertRaises(mr.ReconcileRefused):
                mr.number_page(lambda query: response, source, None, repo="owner/repo", base="merge-queue")
        source = self.source()
        wrong = json.dumps({"source": "0" * 64, "next": 51})
        with self.assertRaises(mr.ReconcileRefused):
            mr.number_page(lambda query: self.fail("must not fetch"), source, wrong,
                           repo="owner/repo", base="merge-queue")

    def test_ceiling_requires_all_state_counts_and_inventory_growth_is_capped(self):
        for fields in (
            {"issues": {"nodes": []}, "pullRequests": {"nodes": [{"number": 1}]}},
            {"issues": {"totalCount": 0, "nodes": []},
             "pullRequests": {"totalCount": 2, "nodes": [{"number": 1}]}}):
            with self.assertRaises(mr.ReconcileRefused):
                mr.freeze_source(lambda query: self.response(**fields), repo="owner/repo", base="merge-queue")
        from unittest import mock
        checkpoint = mr.new_checkpoint({"after": A, "before": B}, 1, repo="owner/repo", base="merge-queue")
        with mock.patch.object(mr, "MAX_INVENTORY", 1), self.assertRaises(mr.ReconcileRefused):
            mr.reconcile_page(checkpoint, [pr(1, "2026-10-02T00:00:00Z"), pr(2, "2026-10-02T00:00:00Z")])
        self.assertEqual(checkpoint["inventory"], [])
