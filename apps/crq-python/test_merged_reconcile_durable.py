"""Durable boundaries: persisted checkpoints, refusals, and real enrollment.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from test_merged_reconcile_fixtures import (
    A, B, FakeForge, ROOT, cursor_page, mr, pr, sha)


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
        for kwargs in ({"repo": "other/repo"}, {"base": "release"}):
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
