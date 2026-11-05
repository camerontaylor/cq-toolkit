"""Merged discovery: recent keyset pages, inventory and tick budgets.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import contextlib
import copy
import io
import json
import re
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def test_aggregate_deadline_and_budget_context_restored(self):
        clock = mock.Mock(return_value=10.0)
        budget = crq.ForgeBudget(requests=2, seconds=3, clock=clock)
        with crq.forge_window(budget), mock.patch.object(crq, "run",
                return_value=SimpleNamespace(stdout="{}")) as run:
            crq.gh_json(["api", "fixture"])
            self.assertEqual(run.call_args.kwargs["timeout"], 3)
            clock.return_value = 13.0
            with self.assertRaises(crq.deferred_refresh.RefreshExhausted):
                crq.gh_json(["api", "fixture"])
            run.assert_called_once()
        self.assertIsNone(crq._FORGE_BUDGET)

    def test_discovery_enrolls_direct_main_and_queue_merges_with_legacy_records(self):
        legacy = {"id": "promo-old", "kind": "promotion", "state": "reviewing"}
        self.q["items"].append(legacy)
        crq.save_queue(self.q)
        forge = self.forge_inventory(count=2)
        def both_branches(args):
            response = forge(args)
            node = response["data"]["repository"].get("n1")
            if node:
                node["baseRefName"] = "main"
            return response
        interval = {"after": "2026-10-01T00:00:00Z", "before": "2026-10-03T00:00:00Z"}
        with mock.patch.object(crq, "gh_json", side_effect=both_branches):
            crq.discover_merged(self.q, crq.ForgeBudget(), interval=interval)
        saved = crq.load_queue()
        self.assertEqual(saved["items"][0], legacy)
        self.assertEqual({i["pr"] for i in crq.live_items(saved)}, {1, 2})
        self.assertTrue(all(i["state"] == "pending" for i in crq.live_items(saved)))
        self.assertEqual(crq.inflight(saved), [])
        self.assertFalse(crq.has_collectable_runs(saved))
        self.assertEqual(saved["merged_watermark"], interval["before"])

    def test_next_tick_discovers_main_merge_after_old_upper_bound(self):
        floor = "2026-10-01T00:00:00Z"
        old_upper = "2026-10-27T00:00:00Z"
        self.q.update(created_at=floor, merged_watermark=old_upper,
                      merged_discovery={"after": floor, "before": old_upper, "complete": True})
        crq.save_queue(self.q)
        rows = [{"number": 750, "base": {"ref": "main"},
                 "updated_at": "2026-10-29T00:00:00Z", "merged_at": "2026-10-29T00:00:00Z",
                 "merge_commit_sha": self.merge, "head": {"sha": self.merge}}]
        with mock.patch.dict(crq.CONFIG, {"merged_discovery": {
                "enabled": True, "after": floor, "before": old_upper}}), \
             mock.patch.object(crq, "gh_json", return_value=rows) as forge, \
             mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("fixture")), \
             mock.patch.object(crq, "now", return_value=crq.parse_iso("2026-10-30T00:00:00Z")):
            self.tick(discovery=True)
        saved = crq.load_queue()
        self.assertEqual([i["pr"] for i in saved["items"]], [750])
        self.assertEqual(saved["items"][0]["state"], "pending")
        self.assertGreater(saved["merged_watermark"], old_upper)
        self.assertGreaterEqual(saved["merged_discovery"]["after"], floor)
        self.assertEqual(forge.call_count, 1)
        self.assertIn("sort=updated&direction=desc", forge.call_args.args[0][1])

    def test_recent_pages_stop_at_floor_and_resume(self):
        rows = [{"number": 900 - n, "base": {"ref": "main"},
                 "updated_at": f"2026-10-29T00:{59 - n // 60:02d}:{59 - n % 60:02d}Z",
                 "merged_at": "2026-10-29T00:00:00Z",
                 "merge_commit_sha": self.merge, "head": {"sha": self.merge}} for n in range(100)]
        with mock.patch.object(crq, "gh_json", return_value=rows) as forge:
            page = crq.recent_merged_page(None, "2026-10-27T00:00:00Z")
        self.assertTrue(forge.call_args.args[0][1].endswith("per_page=100&page=1"))
        self.assertEqual(len(page["records"]), 100)
        cursor = json.loads(page["next_cursor"])
        self.assertEqual(cursor["a"], [[r["number"], r["updated_at"]] for r in rows[-40:]])
        self.assertEqual((cursor["o"], cursor["h"]), (79, rows[0]["updated_at"]))
        # The continuation overlaps 20 rows and resumes after the last row passed.
        with mock.patch.object(crq, "gh_json", return_value=rows[79:]) as forge:
            page = crq.recent_merged_page(page["next_cursor"], "2026-10-27T00:00:00Z")
        self.assertTrue(forge.call_args.args[0][1].endswith("per_page=79&page=2"))
        self.assertEqual(page["records"], [])
        head = page["next_cursor"]
        self.assertEqual(json.loads(head)["p"], 1)
        # A window holding no passed row backs off; so does a changed anchor.
        changed = [{**r, "updated_at": "2026-10-30T00:00:00Z"} for r in rows[79:]]
        for window in ([], changed):
            with self.subTest(window=len(window)), mock.patch.object(crq, "gh_json", return_value=window):
                gap = crq.recent_merged_page(json.dumps({**cursor, "n": 5}, separators=(",", ":")),
                                             "2026-10-27T00:00:00Z")
            self.assertEqual((gap["records"], json.loads(gap["next_cursor"])["o"]), ([], 0))
        with mock.patch.object(crq, "gh_json", return_value=rows) as forge:
            page = crq.recent_merged_page(head, "2026-10-27T00:00:00Z")
        self.assertIsNone(page["next_cursor"])
        self.assertEqual(page["records"], [])
        # Offset (f25b328c) and first keyset (#822) cursors restart safely.
        v1 = json.dumps({"n": 3, "p": 0, "f": "2026-10-29T00:59:58Z", "fs": [], "fa": False, "h": None,
                         "hs": [], "ha": False, "o": 0, "u": None, "t": [], "k": 0, "c": 0})
        for legacy in ("2", v1):
            with self.subTest(legacy=legacy), mock.patch.object(crq, "gh_json", return_value=rows[:1]) as forge:
                self.assertIsNone(crq.recent_merged_page(legacy, "2026-10-29T00:59:58Z")["next_cursor"])
            self.assertTrue(forge.call_args.args[0][1].endswith("per_page=100&page=1"))
        for bad in ("{", "[]", json.dumps({**cursor, "f": "2026-10-28T00:00:00Z"}), "02",
                    json.dumps({**cursor, "v": 1}), json.dumps({**cursor, "a": [[0, "x"]]})):
            with self.subTest(cursor=bad), mock.patch.object(crq, "gh_json") as forge:
                with self.assertRaises(crq.merged_reconcile.ReconcileRefused):
                    crq.recent_merged_page(bad, "2026-10-27T00:00:00Z")
                forge.assert_not_called()

    def forge_inventory(self, count=125):
        def forge(args):
            if len(args) == 2 and "/pulls?" in args[1]:
                size = int(re.search(r"[?&]per_page=(\d+)", args[1]).group(1))
                page = int(re.search(r"[?&]page=(\d+)", args[1]).group(1))
                # One shared update second: the keyset tie group spans pages.
                return [{"number": n, "base": {"ref": "merge-queue"},
                         "updated_at": "2026-10-02T00:00:00Z", "merged_at": "2026-10-02T00:00:00Z",
                         "merge_commit_sha": self.merge, "head": {"sha": self.merge}}
                        for n in range((page - 1) * size + 1, min(page * size, count) + 1)]
            query = args[-1]
            repository = {"id": "repo-id", "nameWithOwner": crq.REPO}
            if "issues(last:" in query:
                repository.update(issues={"totalCount": 0, "nodes": []},
                                  pullRequests={"totalCount": count, "nodes": [{"number": count}]})
            else:
                for value in re.findall(r"issueOrPullRequest\(number:(\d+)\)", query):
                    number = int(value)
                    repository["n" + value] = {"__typename": "PullRequest", "number": number,
                        "baseRefName": "merge-queue", "mergedAt": "2026-10-02T00:00:00Z",
                        "mergeCommit": {"oid": self.merge}, "headRefOid": self.merge}
            return {"data": {"repository": repository}}
        return forge


    def reconcile_inventory(self, budget=1, dry=False):
        return crq.with_lock(crq.reconcile_merged, self.q, after="2026-10-01T00:00:00Z",
            before="2026-10-03T00:00:00Z", page_budget=budget, dry_run=dry)


    def test_inventory_restart_all_125_and_idempotent_legacy_states_no_credit(self):
        self.q["items"] = [{"id": "old", "kind": "merged", "pr": 1, "state": "skipped",
                           "cycles": [], "order": 0}]
        crq.save_queue(self.q)
        forge = self.forge_inventory()
        with mock.patch.object(crq, "gh_json", side_effect=forge) as calls,              mock.patch.object(crq, "launch") as launch:
            first = self.reconcile_inventory()
            self.assertFalse(first["complete"])
            self.assertEqual(len(crq.load_queue()["items"]), 1)
            self.q = crq.load_queue()
            self.assertFalse(self.reconcile_inventory()["complete"])
            self.q = crq.load_queue()
            final = self.reconcile_inventory()
            self.assertTrue(final["complete"])
            self.assertEqual(final["represented"], 125)
            self.assertEqual(final["reviewed"], 0)
            self.assertEqual(len(crq.load_queue()["items"]), 126)
            calls.reset_mock()
            self.q = crq.load_queue()
            self.reconcile_inventory()
            calls.assert_not_called()
            launch.assert_not_called()
        self.assertEqual(crq.load_queue()["items"][0]["state"], "skipped")
        self.assertNotIn("merged_watermark", crq.load_queue())


    def test_inventory_page_atomic_before_next_fetch_and_save_failure_stops(self):
        actual = self.forge_inventory()
        observed = []
        def forge(args):
            if "issueOrPullRequest(number:51)" in args[-1]:
                wrappers = list((self.state / "reconcile").glob("*.json"))
                checkpoint = json.loads(wrappers[0].read_text())["checkpoint"]
                self.assertEqual(checkpoint["pages_read"], 1)
                self.assertFalse(checkpoint["complete"])
                observed.append(True)
            return actual(args)
        with mock.patch.object(crq, "gh_json", side_effect=forge):
            self.assertTrue(self.reconcile_inventory(budget=4)["complete"])
        self.assertEqual(observed, [True])
        # New isolated interval state: first source persistence fails before page1.
        for path in (self.state / "reconcile").glob("*.json"):
            path.unlink()
        with mock.patch.object(crq, "gh_json", side_effect=actual) as calls,              mock.patch.object(crq.repair_tick, "atomic", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(crq.DiscoveryStorageFailed, "merged discovery storage failure: wrapper-save; tick aborted"):
                self.reconcile_inventory(budget=4)
            self.assertEqual(calls.call_count, 1)


    def test_inventory_dry_run_and_transient_resume_no_enrollment(self):
        before = crq.QUEUE.read_bytes()
        with mock.patch.object(crq, "gh_json", side_effect=self.forge_inventory()):
            self.assertTrue(self.reconcile_inventory(budget=4, dry=True)["complete"])
        self.assertEqual(crq.QUEUE.read_bytes(), before)
        self.assertFalse((self.state / "reconcile").exists())
        actual = self.forge_inventory()
        def fail(args):
            if "issueOrPullRequest(number:51)" in args[-1]:
                raise RuntimeError("offline")
            return actual(args)
        with mock.patch.object(crq, "gh_json", side_effect=fail):
            result = self.reconcile_inventory(budget=4)
        self.assertFalse(result["complete"])
        cursor = result["next_cursor"]
        self.assertEqual(crq.load_queue()["items"], [])
        self.q = crq.load_queue()
        with mock.patch.object(crq, "gh_json", side_effect=actual) as forge:
            result = self.reconcile_inventory(budget=4)
        self.assertIn("number:51)", forge.call_args_list[0].args[0][-1])
        self.assertIsNotNone(cursor)
        self.assertTrue(result["complete"])


    def test_natural_discovery_requires_explicit_frozen_interval(self):
        actual = self.forge_inventory()
        self.q["created_at"] = "2026-10-01T00:00:00Z"
        crq.save_queue(self.q)
        with mock.patch.dict(crq.CONFIG, {"merged_discovery": {"enabled": False}}), \
             mock.patch.object(crq, "gh_json", side_effect=actual) as forge:
            self.tick(discovery=True)
            forge.assert_not_called()
        for config in ({}, {"enabled": "true"}, {"enabled": True},
                       {"enabled": True, "after": "2099-01-01T00:00:00Z", "before": "2099-01-02T00:00:00Z"},
                       {"enabled": True, "after": "bad", "before": "bad"}):
            with mock.patch.dict(crq.CONFIG, {"merged_discovery": config}), \
                 mock.patch.object(crq.client_health, "advisory"), \
                 mock.patch.object(crq, "gh_json", side_effect=actual) as forge:
                self.tick(discovery=True)
                forge.assert_not_called()
        interval = {"after": "2026-10-01T00:00:00Z", "before": "2026-10-27T00:00:00Z"}
        self.q["merged_discovery"] = {"after": "2020-01-01T00:00:00Z",
                                      "before": "2026-10-29T00:00:00Z", "complete": False}
        crq.save_queue(self.q)
        with mock.patch.dict(crq.CONFIG, {"merged_discovery": {"enabled": True, **interval}}), \
             mock.patch.object(crq, "gh_json", side_effect=actual), \
             mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("wait")):
            self.tick(dry=True, discovery=True)
            self.tick(only="selection", discovery=True)
            self.assertNotIn("merged_watermark", crq.load_queue())
            self.tick(discovery=True)
        q = crq.load_queue()
        self.assertEqual(q["merged_reconcile"]["represented"], 125)
        self.assertEqual(q["merged_reconcile"]["after"], interval["after"])
        self.assertGreater(q["merged_reconcile"]["before"], interval["before"])
        self.assertEqual(len(q["items"]), 125)


    def test_aggregate_budget_request_timeout_and_deferred_cursor_retained(self):
        clock = mock.Mock(return_value=10.0)
        budget = crq.ForgeBudget(requests=1, seconds=3, clock=clock)
        with crq.forge_window(budget), mock.patch.object(crq, "run", return_value=SimpleNamespace(stdout="{}")) as run:
            crq.gh_json(["api", "fixture"])
            self.assertEqual(run.call_args.kwargs["timeout"], 3)
            with self.assertRaises(crq.deferred_refresh.RefreshExhausted):
                crq.gh_json(["api", "fixture"])
            self.assertEqual(run.call_count, 1)
        self.deferred_entry()
        initial = copy.deepcopy(self.q)
        ids = crq.deferred_refresh.refresh_deferred(self.q,
            verify_source=lambda *a: self.fail("must not fetch"), find_source=lambda *a: [],
            at=crq.iso(), may_continue=budget.available)
        self.assertEqual(ids, [])
        self.assertEqual(self.q, initial)
        clock.return_value = 14
        self.assertFalse(crq.ForgeBudget(requests=2, seconds=0, clock=clock).available())

    def test_reconcile_cli_flags_only_and_one_json_result_no_dispatch(self):
        with mock.patch.object(sys, "argv", ["crq", "reconcile-merged", "--after=2026-10-01T00:00:00Z",
             "--before=2026-10-03T00:00:00Z", "--page-budget=4", "--dry-run"]),              mock.patch.object(crq, "gh_json", side_effect=self.forge_inventory()),              mock.patch.object(crq, "launch") as launch, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(crq.main(), 0)
        self.assertTrue(json.loads(out.getvalue())["complete"])
        self.assertEqual(crq.load_queue()["items"], [])
        launch.assert_not_called()


    def test_real_tick_recovery_budget_shared_and_exhausted_debt_untouched(self):
        self.q["created_at"] = "2026-10-01T00:00:00Z"
        entry = self.deferred_entry()
        self.q["queue_client_requests"] = {f"request-{n:02}": copy.deepcopy(entry) for n in range(5)}
        crq.save_queue(self.q)
        original_run = crq.run
        actual_forge = self.forge_inventory()
        calls = []
        budget = crq.ForgeBudget(requests=5, seconds=30)
        def fake_run(argv, **kwargs):
            if argv[0] != "gh":
                return original_run(argv, **kwargs)
            calls.append(argv)
            self.assertLessEqual(kwargs["timeout"], 10)
            value = actual_forge(argv[1:]) if argv[2] == "graphql" or "/pulls?" in argv[2] else self.forge_data()
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)
        with mock.patch.dict(crq.CONFIG, {"merged_discovery": {"enabled": True,
                "after": "2026-10-01T00:00:00Z", "before": "2026-10-27T00:00:00Z"}}), \
             mock.patch.object(crq, "ForgeBudget", return_value=budget),              mock.patch.object(crq, "run", side_effect=fake_run),              mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("wait")):
            self.tick(discovery=True)
        q = crq.load_queue()
        self.assertEqual(len(calls), 5)  # Existing intents get the same shared allowance first.
        self.assertEqual(q["merged_reconcile"]["represented"], 0)
        self.assertFalse(q["merged_reconcile"]["complete"])
        self.assertEqual(q["deferred_refresh_cursor"], "request-04")
        self.assertTrue(all(e.get("refreshedAt") for e in q["queue_client_requests"].values()))
