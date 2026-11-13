"""Window boundaries and failure visibility for the crq producer summary."""
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader("crq_adapter", str(ROOT / "status_summary.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
adapter = importlib.util.module_from_spec(spec)
loader.exec_module(adapter)


def setUpModule():
    # Every producer probe is faked explicitly; no real process is needed.
    patch = mock.patch.object(adapter.subprocess, "Popen",
        side_effect=AssertionError("unmocked producer probe in offline fixture"))
    patch.start()
    unittest.addModuleCleanup(patch.stop)


class SummaryTest(unittest.TestCase):
    def test_local_review_preview_aging_repeat_reason_position(self):
        queue = {"items": [dict(id="repeat", kind="local-review", generation=1,
            repeat_requested=True, created_at="1970-01-01T00:00:00Z", state="pending",
            wait_reason="capacity", order=1), dict(id="first", kind="local-review",
            generation=1, state="pending", order=2)]}
        config = dict(repo="owner/repo", max_starts_per_hour=8)
        for clock, generations in ((3599, [1, 1]), (3600, [1, 1])):
            data = adapter.summarize({"generated_at": "1970-01-01T01:00:00Z"}, queue, {}, config, [], clock)
            rows = data["pending_items"]
            self.assertEqual([r["generation"] for r in rows], generations)
            repeat = next(r for r in rows if r["reason"] == "capacity")
            self.assertEqual(repeat["band"], "interactive")
            self.assertEqual(repeat["aging_deadline"], 3600)
            self.assertEqual(repeat["approximate_position"], 2 if clock < 3600 else 1)

    def test_invalid_local_review_age_does_not_break_preview(self):
        queue = {"items": [dict(kind="local-review", generation=2, created_at="invalid",
            state="pending", order=1), dict(kind="local-review", generation=1, state="pending", order=2)]}
        result = adapter.summarize({"generated_at": "1970-01-01T01:00:00Z"}, queue, {},
            dict(repo="owner/repo", max_starts_per_hour=8), [], 3600)
        self.assertEqual([i["generation"] for i in result["pending_items"]], [1, 2])
        self.assertIsNone(result["pending_items"][1]["aging_deadline"])

    def test_preview_prioritizes_foreign_open_pr_before_repository_rank(self):
        queue = {"items": [
            {"id": "foreign", "repo": "owner/foreign", "kind": "open", "state": "pending", "order": 0},
            {"id": "primary", "kind": "merged-current", "state": "pending", "order": 1},
            {"id": "push", "repo": "owner/foreign", "kind": "push-current", "state": "pending", "order": 2}]}
        data = adapter.summarize({"generated_at": "1970-01-01T00:00:02Z"}, queue, {},
            {"repo": "owner/primary", "max_starts_per_hour": 8,
             "repos": [{"repo": "owner/foreign", "rank_tier": 3}]}, [], 2)
        self.assertEqual([i["kind"] for i in data["pending_items"]],
                         ["open", "merged-current", "push-current"])

    def test_completion_groups_and_bounded_priority_preview(self):
        kinds = ["open", "delta", "merged-current", "merged", "coverage", "backfill"]
        items = [{"id": str(n), "kind": k, "state": "pending", "pr": n + 1,
                  "order": n} for n, k in enumerate(kinds)]
        items += [{"id": str(n), "kind": "backfill", "state": "pending"}
                  for n in range(6, 20)]
        events = [{"event": "review_finished", "item": str(n), "outcome": "completed",
                   "at": "1970-01-01T00:00:01Z"} for n in range(6)]
        data = adapter.summarize({"generated_at": "1970-01-01T00:00:02Z"},
            {"items": items}, {}, {"max_starts_per_hour": 8, "repo": "owner/repo"}, events, 2)
        self.assertEqual(data["completed_24h_by_work"],
                         dict(open=2, recent_merge=1, backfill=3, other=0))
        self.assertEqual(sum(data["completed_24h_by_work"].values()), data["outcomes_24h"]["completed"])
        self.assertEqual(data["backfill_reserved_slots"], 1)
        self.assertEqual(len(data["pending_items"]), 10)
        self.assertEqual([i["kind"] for i in data["pending_items"][:3]], kinds[:3])
        self.assertEqual(data["pending_items"][0]["repo"], "owner/repo")

    def test_discovery_budget_reason_visible(self):
        result = adapter.merged_current({"items": [], "merged_reconcile": {
            "reason": "budget-exhausted", "pages_read": 0, "transient_failures": 0}})
        self.assertEqual(result["discovery"]["reason"], "budget-exhausted")

    def test_legacy_records_do_not_reserve_capacity_or_publish_alerts(self):
        queue = {"items": [{"kind": "promotion", "state": "reviewing"}],
                 "promotion_audit": {"alerts": [{"text": "obsolete"}]}}
        data = adapter.summarize({"generated_at": "2026-10-31T00:00:00Z"},
                                 queue, {}, {"max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["in_flight"], 0)
        self.assertNotIn("promotion", data)
        self.assertNotIn("promotion", data["backlog"])
        self.assertNotIn("obsolete", json.dumps(data))

    def test_account_limit_overrides_fallback_cap(self):
        for usage, expected in [({"limit": 8}, 8), ({"limit": 12}, 12),
                                (None, 5), ({"remaining": 2}, 5),
                                ({"limit": 0}, 5), ({"limit": True}, 5),
                                ({"limit": "8"}, 5)]:
            with self.subTest(usage=usage):
                data = adapter.summarize({"generated_at": "2026-10-31T00:00:00Z"},
                    {"items": [], "usage": usage}, {}, {"max_starts_per_hour": 5}, [], 0)
                self.assertEqual(data["starts_cap"], expected)

    def test_optional_open_cycles_are_not_pending_review_debt(self):
        queue = {"items": [
            {"kind": "open", "state": "pending", "cycles": [{}]},
            {"kind": "open", "state": "pending", "prior_cycles": 1, "prior_base": "a" * 40},
            {"kind": "open", "state": "pending", "cycles": []},
        ]}
        data = adapter.summarize({"generated_at": "2026-10-28T00:00:00Z"}, queue, {},
                                 {"max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["backlog"]["open"], 2)

    def test_reharvested_run_counts_once(self):
        events = [{"event": "review_finished", "at": "2026-11-06T00:00:00Z", "run": "r1", "outcome": "error"},
                  {"event": "review_finished", "at": "2026-11-06T00:01:00Z", "run": "r1", "outcome": "completed"},
                  {"event": "review_finished", "at": "2026-11-06T00:02:00Z", "run": "r1", "outcome": "completed"},
                  {"event": "review_finished", "at": "2026-11-06T00:03:00Z", "run": "r2", "outcome": "interrupted"},
                  {"event": "review_finished", "at": "2026-11-06T00:04:00Z", "outcome": "completed"},
                  {"event": "review_finished", "at": "2026-11-06T00:05:00Z", "outcome": "completed"}]
        data = adapter.summarize({"generated_at": "2026-11-06T01:00:00Z"}, {"items": []}, {},
                                 {"max_starts_per_hour": 5}, events, adapter.timestamp("2026-11-06T01:00:00Z"))
        self.assertEqual(data["outcomes_24h"], {"completed": 3, "interrupted": 1, "error": 0})

    def test_review_finished_timestamp_validation(self):
        now = adapter.timestamp("2026-11-06T01:00:00Z")

        def summarize(event):
            return adapter.summarize({"generated_at": "2026-11-06T01:00:00Z"},
                                     {"items": []}, {}, {"max_starts_per_hour": 5}, [event], now)

        event = {"event": "review_finished", "outcome": "completed"}
        with self.assertRaisesRegex(ValueError, "invalid review_finished timestamp"):
            summarize({**event, "at": "garbage"})
        for at in (None, ""):
            with self.subTest(at=at):
                candidate = event if at is None else {**event, "at": at}
                self.assertEqual(summarize(candidate)["outcomes_24h"]["completed"], 0)
        self.assertEqual(summarize({**event, "at": "2026-11-06T00:00:00Z"})
                         ["outcomes_24h"]["completed"], 1)

    def test_backfill_and_merged_current_pending_are_backlog(self):
        queue = {"items": [
            {"kind": "backfill", "state": "pending"},
            {"kind": "backfill", "state": "pending"},
            {"kind": "backfill", "state": "done"},
            {"kind": "merged-current", "state": "pending"},
            {"kind": "push-current", "state": "pending", "repo": "camerontaylor/hart"},
        ]}
        data = adapter.summarize({"generated_at": "2026-11-06T00:00:00Z"}, queue, {},
                                 {"repo": "camerontaylor/cq-toolkit", "max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["backlog"]["backfill"], 2)
        self.assertEqual(data["backlog"]["merged-current"], 1)
        self.assertEqual(data["repos"]["camerontaylor/hart"]["pending"], 1)


    def test_publish_is_atomic_private_and_omits_queue_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            events = root / "state/events.jsonl"
            events.write_text('{"event":"review_finished","at":"2026-10-08T02:30:00Z","outcome":"completed","secret":"never publish"}\n')
            queue = {"last_tick": "2026-10-08T02:24:00Z", "items": [], "starts": []}
            config = {"max_starts_per_hour": 5, "schedule_id": "tick", "clone": "/private/clone"}
            triage = root / "state/backfill/findings/triage"
            triage.mkdir(parents=True)
            (triage / "a.json").write_text(json.dumps({"status": "needs-human", "target": "tip",
                "canonical_id": "a", "finding": {"id": "a", "title": "Needs inspection",
                "path": "a.py", "severity": "minor"}}))
            xdg = root / "xdg-state"
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", return_value="12\n"):
                data = adapter.publish(root, queue, config, {"status": "active"}, home=root,
                                       now=adapter.timestamp("2026-10-08T03:00:00Z"))
            target = xdg / "crq/summary.json"
            self.assertEqual(json.loads(target.read_text()), data)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("never publish", target.read_text())
            self.assertNotIn("/private/clone", target.read_text())
            self.assertEqual(data["outcomes_24h"]["completed"], 1)
            self.assertEqual(data["finding_triage"]["counts"], {"needs-human": 1})
            self.assertEqual(data["finding_triage"]["needs_human"][0]["id"], "a")
            self.assertEqual(data["schema_version"], 2)
            self.assertEqual(set(data["systemd_timers"]),
                             {"crq-tick.timer", "crq-watchdog.timer", "crq-slot.timer",
                              "crq-backfill.timer", "crq-repair.timer"})
            self.assertEqual(data["systemd_services"], {})
            for entry in list(data["systemd_timers"].values()) + list(data["systemd_services"].values()):
                self.assertIsNone(entry["active"])
                self.assertEqual(entry["error"], "systemd unit observation unavailable")
            # Complete malformed events preserve the last good file.
            old = target.read_bytes()
            events.write_text('broken complete line\n')
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    self.assertRaises(json.JSONDecodeError):
                adapter.publish(root, queue, config, {}, home=root)
            self.assertEqual(target.read_bytes(), old)

    def test_publish_survives_corrupt_triage_and_bounds_partial_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = root / "state/backfill/findings/triage"
            rows.mkdir(parents=True)
            (root / "state/events.jsonl").write_text("")
            for n in range(35):
                row = {"status": "needs-human", "target": "tip", "canonical_id": str(n),
                       "finding": {"id": str(n), "title": "Check", "severity": "major", "path": "a"}}
                (rows / f"{n:02}.json").write_text(json.dumps(row))
            for name, data in (("invalid", "broken"), ("list", "[]"),
                               ("missing", '{}'), ("status", '{"status": []}')):
                (rows / (name + ".json")).write_text(data)
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(root / "xdg")}), \
                 mock.patch.object(adapter, "systemd_activity", return_value=({}, {})):
                data = adapter.publish(root, {"items": [], "last_tick": "2026-11-08T00:00:00Z"},
                                       {"max_starts_per_hour": 8}, {}, home=root)
            triage = data["finding_triage"]
            self.assertEqual(triage["counts"], {"needs-human": 35})
            self.assertFalse(triage["counts_complete"])
            self.assertEqual(triage["error_count"], 4)
            self.assertEqual(len(triage["errors"]), 4)
            self.assertEqual(triage["needs_human_count"], 35)
            self.assertEqual(len(triage["needs_human"]), 32)
            self.assertEqual(triage["needs_human_omitted"], 3)
            self.assertEqual(json.loads((root / "xdg/crq/summary.json").read_text()), data)
            for n in range(40):
                (rows / f"bad{n}.json").write_text("broken")
            triage = adapter.finding_triage(root / "state/backfill/findings")
            self.assertEqual(triage["error_count"], 44)
            self.assertEqual(len(triage["errors"]), 32)
            self.assertEqual(triage["errors_omitted"], 12)

    def test_corrupt_last_tick_preserves_summary_accepted_by_fleet_reader(self):
        spec = importlib.util.spec_from_file_location("fleet_reader", ROOT / "ops/fleet-reader.py")
        reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reader)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            (root / "state/events.jsonl").write_text("")
            target = root / "xdg/crq/summary.json"
            queue = dict(last_tick="2026-11-08T00:00:00Z", items=[])
            config = dict(max_starts_per_hour=8)
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(root / "xdg")}), \
                 mock.patch.object(adapter, "systemd_activity", return_value=({}, {})):
                adapter.publish(root, queue, config, {}, home=root)
                retained = target.read_bytes()
                for corrupt in ("garbage", 123, [], ""):
                    with self.subTest(last_tick=corrupt):
                        with self.assertRaisesRegex(ValueError, "invalid last_tick|no completed tick"):
                            adapter.publish(root, dict(queue, last_tick=corrupt), config, {}, home=root)
                        self.assertEqual(target.read_bytes(), retained)
                settings = dict(ssh_host="fixture", source="/fixture/summary.json")
                with mock.patch.object(reader, "source_settings", return_value=settings), \
                     mock.patch.object(reader.subprocess, "run",
                         return_value=mock.Mock(returncode=0, stdout=retained.decode())), \
                     mock.patch.object(reader.Path, "home", return_value=root / "mirror-home"), \
                     mock.patch("builtins.print"):
                    reader.main(["--overlay", str(root / "overlay.json")])
                mirrored = json.loads(target.read_text())
                self.assertEqual(mirrored["last_tick"], queue["last_tick"])
                self.assertEqual(mirrored["source_host"], "fixture")

    def test_failed_optional_probes_stay_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            # Ignore only a concurrently appended incomplete final record.
            (root / "state/events.jsonl").write_text('{"event":')
            xdg = root / "xdg-state"
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", side_effect=RuntimeError("unavailable")):
                data = adapter.publish(root, {"last_tick": "2026-10-08T02:24:00Z", "items": []},
                                       {"max_starts_per_hour": 5, "clone": "absent"}, {}, home=root)
            self.assertEqual(data["schedule"]["state"], "systemd")
            self.assertIsNone(data["systemd_timers"]["crq-tick.timer"]["active"])
            self.assertEqual(data["systemd_timers"]["crq-tick.timer"]["error"],
                             "systemctl user show unavailable")
            self.assertIsNone(data["systemd_timers"]["crq-backfill.timer"]["active"])
            self.assertEqual(data["systemd_timers"]["crq-backfill.timer"]["error"],
                             "systemctl user show unavailable")
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", side_effect=RuntimeError("unavailable")):
                unknown = adapter.publish(root, {"last_tick": "2026-10-08T02:24:00Z", "items": []},
                                          {"max_starts_per_hour": 5, "clone": "absent"},
                                          {"status": "unknown"}, home=root)
            self.assertEqual(unknown["schedule"]["state"], "unknown")
            self.assertEqual(unknown["schedule"]["error"], "schedule probe unavailable")

    def test_monotonic_timer_timespans_accept_month_and_year_units(self):
        # systemd renders long monotonic values with month/y units; a healthy
        # timer must stay observable after about 30 days of host uptime.
        blocks = [f"Id={unit}\nLoadState=loaded\nActiveState=active\n"
                  f"LastTriggerUSec=@1700000000\nNextElapseUSecMonotonic={value}"
                  for unit, value in (("crq-watchdog.timer", "1month 2d 3h"),
                                      ("crq-tick.timer", "1y 2month 13h 30min"))]
        with mock.patch.object(adapter, "command", return_value="\n\n".join(blocks)):
            timers, _ = adapter.systemd_activity()
        for unit in ("crq-watchdog.timer", "crq-tick.timer"):
            self.assertNotIn("error", timers[unit])
            self.assertRegex(timers[unit]["next_elapse"],
                             r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


class MergedCurrentSummaryTest(unittest.TestCase):
    def test_discovery_and_legacy_done_do_not_count_as_current_review(self):
        q = {"items": [{"kind": "merged", "state": "done"},
                       {"kind": "merged-current", "state": "done"},
                       {"kind": "merged-current", "state": "pending"}],
             "merged_reconcile": {"complete": True, "represented": 125,
                                  "source": "private", "secret": "not exported"}}
        summary = adapter.merged_current(q)
        self.assertEqual(summary["receipts"]["unverified"], 1)
        self.assertEqual(summary["receipts"]["pending"], 1)
        self.assertEqual(summary["receipts"]["proven_terminal"], 0)
        self.assertEqual(summary["coverage_at_today_target"], "unverified")
        self.assertNotIn("private", json.dumps(summary))

    def test_only_bound_verified_receipts_count_at_retained_target_with_exclusions(self):
        rr = adapter.review_receipt
        paths = [{"path": "gone.py", "disposition": "deleted"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": rr.digest(paths), "policy": rr.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = rr.current_equivalence(capture)
        subject = {"repo": "owner/repo", "pr": 1}
        document = {"version": 1, "source": subject, "capture": capture, "outcome": "no-current-code",
                    "counted": False, "classification": None}
        with tempfile.TemporaryDirectory() as td:
            receipt_id = rr.write_receipt(td, document)
            item = {"kind": "merged-current", "state": "no-current-code", "subject": subject,
                    "capture": capture, "receipt_id": receipt_id}
            summary = adapter.merged_current({"items": [item]}, td)
            self.assertEqual(summary["receipts"]["no_current_code"], 1)
            self.assertEqual(summary["receipts"]["proven_terminal"], 0)
            self.assertEqual(summary["captured_targets"], ["a" * 40])
            self.assertEqual(summary["path_exclusions"], {"deleted": 1})
            document.update(outcome="partial-scope", counted=True,
                            classification={"counted": True, "outcome": "completed"})
            item.update(state="done", receipt_id=rr.write_receipt(td, document))
            self.assertEqual(adapter.merged_current({"items": [item]}, td)["receipts"]["partial_scope"], 1)
            document["outcome"] = "terminal-with-findings"
            item["receipt_id"] = rr.write_receipt(td, document)
            self.assertEqual(adapter.merged_current({"items": [item]}, td)["receipts"]["proven_terminal"], 1)
            (Path(td) / (item["receipt_id"] + ".json")).write_text("{}")
            summary = adapter.merged_current({"items": [item]}, td)
            self.assertEqual(summary["receipts"]["unverified"], 1)
            self.assertEqual(summary["receipts"]["proven_terminal"], 0)



    def test_reused_receipt_requires_retained_lineage_and_equivalent_scope(self):
        rr = adapter.review_receipt
        paths = [{"path": "gone.py", "disposition": "deleted"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": rr.digest(paths), "policy": rr.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = rr.current_equivalence(capture)
        document = {"version": 1, "source": {"repo": "owner/repo", "pr": 1},
                    "capture": capture, "outcome": "terminal-with-findings", "counted": True,
                    "classification": {"counted": True, "outcome": "completed"}}
        with tempfile.TemporaryDirectory() as td:
            receipt = rr.write_receipt(td, document)
            original = {"id": "original", "kind": "merged-current", "state": "done",
                        "receipt_id": receipt, "subject": document["source"], "capture": capture}
            reused = {**original, "id": "reused", "subject": {"repo": "owner/repo", "pr": 2},
                      "capture": {**capture, "captured_at": "later", "base": "c" * 40},
                      "reused_from": "original"}
            queue = {"items": [original, reused]}
            summary = adapter.merged_current(queue, td)
            self.assertEqual(summary["receipts"]["proven_terminal"], 2)
            self.assertEqual(summary["path_exclusions"], {"deleted": 2})
            for bad in ({"reused_from": "missing"}, {"reused_from": "reused"},
                        {"capture": {**reused["capture"], "target": "d" * 40}},
                        {"receipt_id": "e" * 64}, {"state": "unsupported"}):
                with self.subTest(bad=bad):
                    result = adapter.merged_current({"items": [original, {**reused, **bad}]}, td)
                    self.assertEqual(result["receipts"]["unverified"], 1)
                    self.assertEqual(result["receipts"]["proven_terminal"], 1)


class ReposSummaryTests(unittest.TestCase):
    """Additive per-repo counts for non-primary repos (docs/multi-repo.md)."""

    PRIMARY = "camerontaylor/cq-toolkit"

    def queue(self):
        return {"items": [
            {"kind": "open", "state": "pending", "cycles": []},
            {"kind": "open", "state": "reviewing", "cycles": []},
            {"kind": "push-current", "state": "pending", "repo": "camerontaylor/infra"},
            {"kind": "push-current", "state": "blocked", "repo": "camerontaylor/infra"},
            {"kind": "push-current", "state": "done", "repo": "camerontaylor/hart"},
            {"kind": "open", "state": "pending", "repo": "camerontaylor/hart", "cycles": []},
        ], "push_discovery": {"camerontaylor/infra": {"reviewed_tip": "a" * 40},
                              "camerontaylor/other": {"reviewed_tip": "b" * 40}}}

    def test_repos_block_counts_foreign_items_and_carries_push_tips(self):
        data = adapter.summarize({"generated_at": "2026-11-03T00:00:00Z"}, self.queue(), {},
                                 {"repo": self.PRIMARY, "max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["repos"]["camerontaylor/infra"],
                         {"pending": 1, "reviewing": 0, "blocked": 1, "other": 0,
                          "reviewed_tip": "a" * 40})
        self.assertEqual(data["repos"]["camerontaylor/hart"]["other"], 1)
        # idle repos stay visible with zero counts and their push tip
        self.assertEqual(data["repos"]["camerontaylor/other"],
                         {"pending": 0, "reviewing": 0, "blocked": 0, "other": 0,
                          "reviewed_tip": "b" * 40})

    def test_configured_repos_stay_visible_before_their_first_item(self):
        data = adapter.summarize({"generated_at": "2026-11-03T00:00:00Z"}, {"items": []}, {},
                                 {"repo": self.PRIMARY, "max_starts_per_hour": 5,
                                  "repos": [{"repo": "camerontaylor/dotfiles"},
                                            {"repo": "camerontaylor/encoding"}]}, [], 0)
        for slug in ("camerontaylor/dotfiles", "camerontaylor/encoding"):
            self.assertEqual(data["repos"][slug],
                             {"pending": 0, "reviewing": 0, "blocked": 0, "other": 0})

    def test_backlog_stays_primary_and_in_flight_stays_global(self):
        data = adapter.summarize({"generated_at": "2026-11-03T00:00:00Z"}, self.queue(), {},
                                 {"repo": self.PRIMARY, "max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["backlog"]["open"], 1)  # the hart open PR is not primary backlog
        self.assertEqual(data["in_flight"], 1)        # every reviewing item holds shared quota

    def test_legacy_queue_without_repo_fields_keeps_schema_two_shape(self):
        data = adapter.summarize({"generated_at": "2026-11-03T00:00:00Z"},
                                 {"items": [{"kind": "open", "state": "pending", "cycles": []}]}, {},
                                 {"max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["repos"], {})
        self.assertEqual(data["backlog"]["open"], 1)

    def test_review_metrics_fixture(self):
        """One fixture queue covering the S3c block, including unknowns."""
        item = dict(id="lr-first", kind="local-review", repo="owner/repo",
                    pr=11, generation=1, state="done", scope_adequate=True,
                    receipt_id="r1", created_at="2026-11-06T00:00:00Z",
                    completed_at="2026-11-06T00:00:45Z",
                    attempts=[dict(run_id="run1", band="interactive",
                                   started_at="2026-11-06T00:00:05Z",
                                   outcome="completed", counted=True)])
        repeat = dict(id="lr-repeat", kind="local-review", repo="owner/repo",
                      generation=2, state="done", scope_adequate=True,
                      created_at="2026-11-06T01:00:00Z",
                      completed_at="2026-11-06T01:40:00Z",
                      attempts=[dict(run_id="run2a", band="interactive",
                                     started_at="2026-11-06T01:30:00Z",
                                     outcome="rate_limited", counted=False),
                                dict(run_id="run2b", band="background",
                                     started_at="2026-11-06T01:31:00Z",
                                     outcome="error", counted=False)],
                      failures=1)
        in_flight = dict(id="lr-live", kind="local-review", generation=1,
                         state="reviewing", created_at="2026-11-06T02:00:00Z",
                         run={"run_id": "run3", "started_at": "2026-11-06T02:00:00Z"},
                         attempts=[])
        app_item = dict(id="app1", kind="open", state="reviewing",
                        pr_review_request={"run_id": "pr1", "pr": 7},
                        pr_review_attempts=2)
        queue = {"items": [item, repeat, in_flight, app_item],
                 "usage": {"limit": 10, "remaining": 4},
                 "cooldown_until": "2026-11-06T03:00:00Z",
                 "review_requests": {
                     "req-create": {"item": "lr-first", "created_at": "2026-11-06T00:00:00Z",
                                    "predecessor": None, "admission_action": "created"},
                     "req-reuse": {"item": "lr-first", "created_at": "2026-11-06T00:05:00Z",
                                   "supersedes": "req-old", "admission_action": "reused"},
                     "req-join": {"item": "lr-live", "created_at": "2026-11-06T02:01:00Z",
                                  "admission_action": "joined"},
                     "req-pr": {"item": "lr-first", "created_at": "2026-11-06T01:00:00Z",
                                "admission_action": "reused"}},
                 "review_pr_links": {"owner/repo#11": {"item": "lr-first", "pr": 11,
                                                      "repo": "owner/repo"}},
                 "review_notify_outbox": {
                     "n1": {"state": "sent", "attempts": 1},
                     "n2": {"state": "pending", "attempts": 3},
                     "n3": {"state": "error", "attempts": 4}}}
        events = [{"event": "review_started", "at": "2026-11-06T00:00:01Z"},
                  {"event": "review_started", "at": "2026-11-05T23:00:00Z"},  # outside 24h window
                  {"event": "spawn_failed", "at": "2026-11-06T02:30:00Z", "item": "lr-live"}]
        now = adapter.timestamp("2026-11-07T00:00:00Z")
        data = adapter.summarize({"generated_at": "2026-11-07T00:00:00Z"}, queue, {},
                                 {"repo": "owner/repo", "max_starts_per_hour": 8},
                                 events, now)
        m = data["review_metrics"]
        # requests: retained admission actions classify every binding
        self.assertEqual(m["requests"], {"total": 4, "created": 1, "joined": 1,
                                         "reused": 2, "observed": 0, "unknown_action": 0})
        self.assertEqual(m["dedup"]["requests_without_new_item"], 3)
        self.assertEqual(m["dedup"]["on_completed_items"], 2)
        self.assertEqual(m["dedup"]["monetary_saving"]["state"], "unknown")
        # vendor starts: launch-evidence attempts (3) + in-flight live run (1);
        # PR-associated: lr-first attempt (1) — repeat/live have no PR link
        self.assertEqual(m["vendor_starts"], 4)
        self.assertEqual(m["operation_events_24h"], {"review_started": 1, "spawn_failed": 1})
        # wait: 5s interactive (first), 30min interactive + 31min background (repeat)
        self.assertEqual(m["queue_wait"]["interactive"],
                         {"count": 2, "buckets": {"lt_60s": 1, "lt_600s": 0, "lt_3600s": 1, "gte_3600s": 0}})
        self.assertEqual(m["queue_wait"]["background"],
                         {"count": 1, "buckets": {"lt_60s": 0, "lt_600s": 0, "lt_3600s": 1, "gte_3600s": 0}})
        self.assertEqual(m["queue_wait"]["first"]["count"], 1)
        self.assertEqual(m["queue_wait"]["repeat"]["count"], 2)
        # completion latency: 45s interactive first; 40min background repeat
        # (terminal attempt's own band, not a majority vote)
        self.assertEqual(m["completion"]["interactive"]["buckets"]["lt_60s"], 1)
        self.assertEqual(m["completion"]["background"]["buckets"]["lt_3600s"], 1)
        self.assertEqual(m["completion"]["first"]["count"], 1)
        self.assertEqual(m["completion"]["repeat"]["count"], 1)
        self.assertEqual(m["completion"]["unknown_band"],
                         {"count": 0, "buckets": {"lt_60s": 0, "lt_600s": 0, "lt_3600s": 0, "gte_3600s": 0}})
        self.assertEqual(m["repeats"], {"repeat_items": 1, "completed_repeats": 1})
        self.assertEqual(m["predecessor"], {"linked_requests": 0, "superseding_requests": 1,
                                            "change_statistics": m["predecessor"]["change_statistics"]})
        self.assertEqual(m["predecessor"]["change_statistics"]["state"], "unknown")
        self.assertEqual(m["cooldown"], {"state": "expired",
                                         "until": "2026-11-06T03:00:00Z",
                                         "seconds_remaining": 0})  # past cooldown relative to now
        self.assertEqual(m["attempts"], {"failed": 2, "unknown": 0, "no_review": 0})
        self.assertEqual(m["quota"], {"state": "known", "limit": 10, "remaining": 4})
        self.assertEqual(m["notifications"], {"sent": 1, "error": 1, "pending": 1,
                                              "withdrawn": 0, "retries": 5,
                                              "delivery_lag": m["notifications"]["delivery_lag"],
                                              "consumption_lag": m["notifications"]["consumption_lag"]})
        self.assertEqual(m["notifications"]["delivery_lag"]["state"], "unknown")
        self.assertEqual(m["notifications"]["consumption_lag"]["state"], "unknown")
        self.assertEqual(m["pr_associated"], {"items": 1, "reuse_requests": 2,
                                              "additional_starts": 1})
        self.assertEqual(m["app_reviews"], {"items": 1, "attempts": 2})
        self.assertEqual(m["records"]["ingestion_lag"]["state"], "unknown")
        self.assertEqual(m["records"]["unknown_scope_rate"]["state"], "unknown")
        self.assertEqual(m["records"]["projection_failures"]["state"], "unknown")

    def test_review_metrics_unknown_quota_and_no_cooldown(self):
        """No usage observation stays unknown; absent cooldown stays none."""
        queue = {"items": [], "review_requests": {},
                 "review_notify_outbox": {}, "usage": {"remaining": 2}}
        data = adapter.summarize({"generated_at": "2026-11-07T00:00:00Z"}, queue, {},
                                 {"repo": "owner/repo", "max_starts_per_hour": 8}, [], 0)
        m = data["review_metrics"]
        self.assertEqual(m["quota"], {"state": "unknown",
                                      "reason": "no current vendor usage observation in queue state"})
        self.assertEqual(m["cooldown"], {"state": "none"})
        self.assertEqual(m["requests"], {"total": 0, "created": 0, "joined": 0,
                                         "reused": 0, "observed": 0, "unknown_action": 0})
        self.assertEqual(m["vendor_starts"], 0)

    def test_review_metrics_vendor_starts_need_launch_evidence(self):
        """Regression: reuse run ids and spawn-failed runs are not vendor starts.

        A receipt-only reuse attempt retains the source run id but started_at
        is null (nothing launched for this request). A retained spawn-failed
        run (crq.py keeps `run` with spawn_failed_at as a consumed
        reservation) never launched the CLI; the spawn_failed event counter
        covers it. Outcome rule follows the classifier's own vocabulary
        (crq.classify): skipped (no fresh review) and too_large (oversize,
        no review performed) mean the vendor never reviewed, so they count
        under attempts.no_review, not failed and not unknown.
        """
        reuse_attempt = dict(id="lr-reuse", kind="local-review", generation=1,
                             state="pending", created_at="2026-11-06T00:00:00Z",
                             attempts=[dict(run_id="r-old", outcome="completed",
                                            counted=True, band="background",
                                            started_at=None)])
        spawn_failed = dict(id="lr-spawn", kind="local-review", generation=1,
                            state="failed", created_at="2026-11-06T01:00:00Z",
                            run={"run_id": "r-new",
                                 "started_at": "2026-11-06T01:00:00Z",
                                 "spawn_failed_at": "2026-11-06T01:00:01Z"},
                            attempts=[])
        skipped = dict(id="lr-skip", kind="local-review", generation=1,
                       state="done", scope_adequate=False,
                       created_at="2026-11-06T02:00:00Z",
                       attempts=[dict(run_id="r-skip", band="background",
                                      started_at="2026-11-06T02:00:00Z",
                                      outcome="skipped", counted=False)])
        too_large = dict(id="lr-big", kind="local-review", generation=1,
                         state="blocked", created_at="2026-11-06T03:00:00Z",
                         attempts=[dict(run_id="r-big", band="background",
                                        started_at="2026-11-06T03:00:00Z",
                                        outcome="too_large", counted=False)])
        queue = {"items": [reuse_attempt, spawn_failed, skipped, too_large],
                 "review_requests": {}, "review_notify_outbox": {}}
        data = adapter.summarize({"generated_at": "2026-11-07T00:00:00Z"}, queue, {},
                                 {"repo": "owner/repo", "max_starts_per_hour": 8}, [], 0)
        m = data["review_metrics"]
        # The reuse attempt and the spawn-failed run launched nothing.
        self.assertEqual(m["vendor_starts"], 2)  # only skipped + too_large attempts
        # The reuse attempt (started_at null: bookkeeping, not a launch) is
        # unknown; skipped/too_large are no-review outcomes, not failures.
        self.assertEqual(m["attempts"], {"failed": 0, "unknown": 1, "no_review": 2})


if __name__ == "__main__":
    unittest.main()
