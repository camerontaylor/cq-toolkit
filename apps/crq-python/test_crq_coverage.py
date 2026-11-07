"""Coverage fallback and measurement targets: legacy audit and backfill.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class CoverageFallbackTargetTest(unittest.TestCase):
    def test_success_after_released_legacy_failure_preserves_counter_audit(self):
        import datetime as dt
        import backfill
        at = dt.datetime(2026, 10, 30, 12, tzinfo=dt.timezone.utc)
        source = {"id": "source", "pr": 42, "kind": "merged",
                  "measure": {"files": [{"path": "old.py", "now": "new.py"}]}}
        item = {"id": "legacy", "kind": "coverage", "state": "blocked", "pr": 42,
                "coverage_source": "source", "coverage_paths": ["new.py"], "failures": 6, "attempts": [], "cycles": []}
        q = {"items": [source, item]}
        for n in range(6):
            stamp = f"2026-10-{20+n:02d}T00:00:00Z"; run = f"old-{n}"
            item["attempts"].append({"run_id": run, "outcome": "error", "counted": False,
                                     "at": stamp, "head": "a" * 40, "base": "b" * 40})
            crq.coverage.record_legacy_failure(q, item, stamp, "error", run)
        release_at = "2026-10-28T00:00:00Z"
        family = crq.coverage._legacy_family(42, "old.py")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            evidence = {"family": family, "checked_at": release_at, "exact_no_live_run": True,
                        "checked_runs": [f"old-{n}" for n in range(6)], "queue_digest": backfill.queue_digest_v1(q)}
            evidence_file = root / "release.json"; evidence_file.write_bytes(backfill.ledger.canonical(evidence))
            operator = SimpleNamespace(STATE=root, load_queue=lambda: q, iso=lambda: release_at, save_queue=lambda q: None)
            args = SimpleNamespace(command="quarantine-release", family=family, evidence=str(evidence_file),
                                   operator="operator", reason="investigated")
            with mock.patch.object(backfill.runtime, "settings", return_value={"enabled": True}), \
                 mock.patch.object(backfill.runtime, "services", return_value=(None, None, None, None)):
                self.assertTrue(backfill.execute(operator, args)["released"])
        stamp = "2026-10-30T10:00:00Z"
        item["attempts"].append({"run_id": "new-failure", "outcome": "error", "counted": False,
                                 "at": stamp, "head": "a" * 40, "base": "b" * 40})
        item.update(failures=7, state="reviewing", run={"run_id": "success"})
        crq.coverage.record_legacy_failure(q, item, stamp, "error", "new-failure")
        counter = copy.deepcopy(q["backfill_families"][family])
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); rdir = root / "runs" / "success"; rdir.mkdir(parents=True)
            (rdir / "exit.json").write_text(json.dumps({"exit": 0}))
            (rdir / "meta.json").write_text(json.dumps({"run_id": "success", "head": "c" * 40,
                "base": "d" * 40, "cycle": 1, "worktree": str(root / "wt"), "wt_branch": "fixture",
                "coverage_paths": ["new.py"]}))
            (rdir / "review.ndjson").write_text(json.dumps({"type": "complete", "reviewedFiles": ["new.py"]}) + "\n")
            cls = {"outcome": "completed", "counted": True, "findings": 0, "severity_counts": {}}
            with mock.patch.object(crq, "RUNS", root / "runs"), mock.patch.object(crq, "STATE", root), \
                 mock.patch.object(crq, "run_liveness", return_value="harvest"), mock.patch.object(crq, "now", return_value=at), \
                 mock.patch.object(crq, "classify", return_value=cls), mock.patch.object(crq, "findings_md", return_value=""), \
                 mock.patch.object(crq, "event"), mock.patch.object(crq, "remove_worktree"), \
                 mock.patch.object(crq.usage_slots, "write_next"), mock.patch.object(crq.repair_tick, "enqueue", return_value=False):
                crq.harvest_review(q, item, False)
        view = crq.coverage.legacy_retry_view(q, 42, "old.py", at + dt.timedelta(days=2))
        self.assertTrue(view["allowed"], view)
        self.assertEqual(view["failures"], 0)
        self.assertEqual(q["backfill_families"][family], counter)
        self.assertEqual(len(q["legacy_coverage_releases"]), 1)
        self.assertEqual(len(item["attempts"]), 8)
        for history_key in ("backfill_families", "backfill_scope_failures"):
            for replacement in (None, 5):
                altered = copy.deepcopy(q)
                if replacement is None:
                    altered[history_key].pop(family)
                else:
                    altered[history_key][family]["failures"] = replacement
                before = copy.deepcopy(altered)
                held = crq.coverage.legacy_retry_view(altered, 42, "old.py", at + dt.timedelta(days=2))
                self.assertFalse(held["allowed"])
                self.assertIn("released counter floor missing or reduced", held["reasons"])
                self.assertEqual(altered, before)
        later_at = "2026-10-30T13:00:00Z"
        item["attempts"].append({"run_id": "after-success", "outcome": "error", "counted": False,
                                 "at": later_at, "head": "a" * 40, "base": "b" * 40})
        item.update(failures=1, state="blocked")
        crq.coverage.record_legacy_failure(q, item, later_at, "error", "after-success")
        view = crq.coverage.legacy_retry_view(q, 42, "old.py", at + dt.timedelta(days=2))
        self.assertEqual(view["failures"], 1)
        self.assertTrue(view["allowed"], view)
        for n in range(5):
            stamp = f"2026-11-{n+1:02d}T00:00:00Z"; run = f"later-{n}"
            item["attempts"].append({"run_id": run, "outcome": "error", "counted": False,
                                     "at": stamp, "head": "a" * 40, "base": "b" * 40})
            item["failures"] += 1
            crq.coverage.record_legacy_failure(q, item, stamp, "error", run)
        release_at = "2026-11-10T00:00:00Z"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            evidence = {"family": family, "checked_at": release_at, "exact_no_live_run": True,
                        "checked_runs": ["after-success"] + [f"later-{n}" for n in range(5)],
                        "queue_digest": backfill.queue_digest_v1(q)}
            evidence_file = root / "release.json"; evidence_file.write_bytes(backfill.ledger.canonical(evidence))
            operator = SimpleNamespace(STATE=root, load_queue=lambda: q, iso=lambda: release_at, save_queue=lambda q: None)
            args = SimpleNamespace(command="quarantine-release", family=family, evidence=str(evidence_file),
                                   operator="operator", reason="second epoch investigated")
            with mock.patch.object(backfill.runtime, "settings", return_value={"enabled": True}), \
                 mock.patch.object(backfill.runtime, "services", return_value=(None, None, None, None)):
                self.assertTrue(backfill.execute(operator, args)["released"])
        self.assertTrue(crq.coverage.legacy_retry_view(q, 42, "old.py", release_at)["allowed"])
        altered = copy.deepcopy(q)
        altered["backfill_families"][family]["failures"] += 1
        held = crq.coverage.legacy_retry_view(altered, 42, "old.py", release_at)
        self.assertFalse(held["allowed"])
        self.assertIn("unreconciled family aggregate", held["reasons"])
        altered = copy.deepcopy(q)
        altered_item = next(i for i in altered["items"] if i["id"] == "legacy")
        altered_item["attempts"].append({"run_id": "missing-from-release", "outcome": "error", "counted": False,
                                         "at": "2026-11-06T00:00:00Z", "head": "a" * 40, "base": "b" * 40})
        altered_item["failures"] += 1
        held = crq.coverage.legacy_retry_view(altered, 42, "old.py", release_at)
        self.assertFalse(held["allowed"])
        self.assertIn("failure predates or coincides with release but lacks release proof", held["reasons"])

    def test_harvested_scope_success_resets_only_matching_legacy_streak(self):
        import datetime as dt
        at = dt.datetime(2026, 10, 30, 12, tzinfo=dt.timezone.utc)
        source = {"id": "source", "pr": 42, "kind": "merged", "measure": {"files": [
            {"path": "old.py", "now": "new.py"}, {"path": "sibling.py", "now": "sibling.py"}]}}
        failure = {"run_id": "old-run", "outcome": "error", "counted": False,
                   "at": (at - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"), "head": "a" * 40, "base": "b" * 40}
        item = {"id": "legacy", "kind": "coverage", "state": "reviewing", "pr": 42,
                "coverage_source": "source", "coverage_paths": ["new.py", "sibling.py"],
                "run": {"run_id": "success"}, "failures": 1, "attempts": [failure], "cycles": []}
        q = {"items": [source, item]}
        crq.coverage.record_legacy_failure(q, item, failure["at"], "error", "old-run")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); rdir = root / "runs" / "success"; rdir.mkdir(parents=True)
            (rdir / "exit.json").write_text(json.dumps({"exit": 0}))
            (rdir / "meta.json").write_text(json.dumps({"run_id": "success", "head": "c" * 40,
                "base": "d" * 40, "cycle": 1, "worktree": str(root / "wt"), "wt_branch": "fixture",
                "coverage_paths": ["new.py", "sibling.py"]}))
            (rdir / "review.ndjson").write_text(json.dumps({"type": "complete", "reviewedFiles": ["new.py"]}) + "\n")
            cls = {"outcome": "completed", "counted": True, "findings": 0, "severity_counts": {}}
            with mock.patch.object(crq, "RUNS", root / "runs"), mock.patch.object(crq, "STATE", root), \
                 mock.patch.object(crq, "run_liveness", return_value="harvest"), mock.patch.object(crq, "now", return_value=at), \
                 mock.patch.object(crq, "classify", return_value=cls), mock.patch.object(crq, "findings_md", return_value=""), \
                 mock.patch.object(crq, "event"), mock.patch.object(crq, "remove_worktree"), \
                 mock.patch.object(crq.usage_slots, "write_next"), mock.patch.object(crq.repair_tick, "enqueue", return_value=False):
                crq.harvest_review(q, item, False)
        self.assertTrue(crq.coverage.legacy_retry_view(q, 42, "old.py", at)["allowed"])
        self.assertFalse(crq.coverage.legacy_retry_view(q, 42, "sibling.py", at)["allowed"])
        self.assertEqual(len(item["attempts"]), 2)
        self.assertIn("old-run", q["legacy_coverage_failure_runs"])
        later_at = "2026-10-30T13:00:00Z"
        item["attempts"].append({"run_id": "after-success", "outcome": "error", "counted": False,
                                 "at": later_at, "head": "a" * 40, "base": "b" * 40})
        item.update(failures=1, state="blocked")
        crq.coverage.record_legacy_failure(q, item, later_at, "error", "after-success")
        self.assertEqual(crq.coverage.legacy_retry_view(q, 42, "old.py", at + dt.timedelta(days=2))["failures"], 1)
        self.assertFalse(crq.coverage.legacy_retry_view(q, 42, "sibling.py", at + dt.timedelta(days=2))["allowed"])

    def test_pending_candidate_obeys_real_historical_family_deadline(self):
        import datetime as dt
        at = dt.datetime(2026, 10, 30, 12, tzinfo=dt.timezone.utc)
        source = {"id": "source", "pr": 42, "kind": "merged",
                  "measure": {"files": [{"path": "old.py", "now": "new.py"}]}}
        old = {"id": "old", "kind": "coverage", "state": "blocked", "pr": 42,
               "coverage_source": "source", "coverage_paths": ["new.py"], "failures": 3,
               "attempts": [{"run_id": f"r{i}", "outcome": "error", "counted": False,
                             "at": (at - dt.timedelta(hours=3-i)).isoformat(),
                             "head": "a" * 40, "base": "b" * 40} for i in range(3)]}
        pending = {"id": "new", "kind": "coverage", "state": "pending", "pr": 42,
                   "coverage_source": "source", "coverage_paths": ["new.py"]}
        q = {"items": [source, old, pending]}
        with mock.patch.object(crq.backfill_runtime, "select", return_value=(None, False)), \
             mock.patch.object(crq.backfill_runtime, "settings", return_value=None), \
             mock.patch.object(crq, "git", return_value="a" * 40), \
             mock.patch.object(crq, "now", return_value=at), \
             mock.patch.object(crq, "deps_met", return_value=True), \
             mock.patch.object(crq, "build_synthetic") as build:
            self.assertEqual(crq.coverage_fallback(q, [], False, None), (None, False))
        build.assert_not_called()
        self.assertFalse(crq.coverage.legacy_retry_view(q, 42, "old.py", at)["allowed"])
        self.assertTrue(crq.coverage.legacy_retry_view(q, 42, "old.py", at + dt.timedelta(hours=4))["allowed"])

    def test_pending_legacy_candidate_obeys_family_cooldown_before_planning(self):
        source = {"id": "source", "pr": 42, "kind": "merged",
                  "measure": {"files": [{"path": "old.py", "now": "new.py"}]}}
        item = {"id": "coverage", "kind": "coverage", "state": "pending",
                "coverage_source": "source", "coverage_paths": ["new.py"]}
        q = {"items": [source, item]}
        with mock.patch.object(crq.backfill_runtime, "select", return_value=(None, False)), \
             mock.patch.object(crq.backfill_runtime, "settings", return_value=None), \
             mock.patch.object(crq, "git", return_value="a" * 40), \
             mock.patch.object(crq, "deps_met", return_value=True), \
             mock.patch.object(crq.coverage, "_legacy_retry_allowed", return_value=False) as gate, \
             mock.patch.object(crq, "build_synthetic") as build:
            self.assertEqual(crq.coverage_fallback(q, [], False, None), (None, False))
        gate.assert_called_once()
        build.assert_not_called()
        self.assertIn("cooldown unresolved", item["wait_reason"])

    def test_tick_slot_templates_pin_managed_cli_updates(self):
        root = Path(__file__).parent / "ops/systemd"
        for name in ("crq-tick.service", "crq-slot.service"):
            text = (root / name).read_text()
            self.assertIn("Environment=CODERABBIT_CLI_DISABLE_AUTO_UPDATE=true", text)
            self.assertIn("Environment=CODERABBIT_CLI_UPDATE_MANAGED=true", text)

    def test_backfill_child_records_scope_and_preflight_refusal(self):
        for version in ("0.8.2", "0.9.2", "0.9.1", "unknown"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as td:
                root = Path(td); run_dir = root / "run"; run_dir.mkdir()
                meta = {"cmd": ["coderabbit", "review"], "kind": "backfill", "worktree": td,
                        "head": "a" * 40, "base": "b" * 40, "backfill": {"attempt_id": "attempt"}}
                (run_dir / "meta.json").write_text(json.dumps(meta))
                repository = mock.Mock()
                repository.git.side_effect = lambda *args: ("a" * 40).encode() if args[0] == "rev-parse" else b""
                process = mock.Mock(pid=999); process.wait.return_value = 0
                with mock.patch.object(crq, "RUNS", root), mock.patch.object(crq.signal, "signal"), \
                     mock.patch.object(crq.subprocess, "run", return_value=SimpleNamespace(stdout=version)) as preflight, \
                     mock.patch.object(crq.subprocess, "Popen", return_value=process) as spawn, \
                     mock.patch.object(crq.backfill_runtime.accounting, "Repository", return_value=repository), \
                     mock.patch.object(crq.backfill_runtime.history, "submitted_scope", return_value=[]), \
                     mock.patch.object(crq, "run"):
                    result = crq.cmd_review_child("run")
                self.assertTrue((run_dir / "review.pid").exists())
                self.assertTrue((run_dir / "exit.json").exists())
                self.assertEqual(preflight.call_args.kwargs["env"]["CODERABBIT_CLI_DISABLE_AUTO_UPDATE"], "true")
                self.assertEqual(preflight.call_args.kwargs["env"]["CODERABBIT_CLI_UPDATE_MANAGED"], "true")
                if version in ("0.8.2", "0.9.2"):
                    self.assertEqual(result, 0); spawn.assert_called_once()
                    proof = json.loads((run_dir / "submission.json").read_text())
                    self.assertEqual(proof["attempt_id"], "attempt")
                    self.assertEqual(proof["cli_version"], version)
                    self.assertEqual(proof["format"], "coderabbit-agent-" + version)
                    self.assertEqual(spawn.call_args.kwargs["env"], preflight.call_args.kwargs["env"])
                else:
                    self.assertEqual(result, 3); spawn.assert_not_called()
                    self.assertTrue(json.loads((run_dir / "exit.json").read_text())["pre_vendor_refusal"])

    def test_merged_projection_waits_for_promoted_code(self):
        with mock.patch.object(crq, "git", return_value="a" * 40), \
             mock.patch.object(crq, "is_ancestor", return_value=False), \
             mock.patch.object(crq, "build_synthetic") as build:
            with self.assertRaises(crq.NotReady):
                crq.plan_merged({"merge_commit": "b" * 40}, False)
        build.assert_not_called()

    def test_selective_backfill_preserves_ordinary_priority(self):
        queue = {"items": [{"id": "ordinary", "kind": "open", "state": "pending", "pr": 1}]}
        observed = []
        def fallback(q, log, dry, only):
            observed.append(crq.ordinary_review_eligible(q))
            return None, False
        with mock.patch.object(crq, "coverage_fallback", side_effect=fallback):
            crq.start_one(queue, [], False, "backfill-only", False)
        self.assertEqual(observed, [True])


    def test_ledger_spool_transport_binds_only_base_and_head(self):
        spool = crq.Spool({"host": "operator@127.0.0.1", "key": "/fixture/key"})
        base, head = "a" * 40, "b" * 40
        with mock.patch.object(spool, "_ssh", return_value=json.dumps({"published": head})) as ssh:
            spool.publish_ledger(base, head, b"bundle")
            ssh.assert_called_once_with("ledger-publish " + base + " " + head, b"bundle", timeout=330)
            with self.assertRaises(OSError):
                spool.publish_ledger(base, "--force", b"bundle")
            self.assertEqual(ssh.call_count, 1)
        with mock.patch.object(spool, "_ssh", side_effect=crq.SpoolUnreachable("connection lost")):
            with self.assertRaises(OSError):
                spool.publish_ledger(base, head, b"bundle")
        with mock.patch.object(spool, "_ssh", return_value=json.dumps({"published": base})):
            with self.assertRaises(OSError):
                spool.publish_ledger(base, head, b"bundle")

    def test_measure_skips_repair_only_merged_item(self):
        repair = {"id": "repair-1", "kind": "merged", "pr": 0, "repair_runs": {"run": {}}, "state": "pending"}
        queue = {"items": [repair]}
        with tempfile.TemporaryDirectory() as td, mock.patch.object(crq, 'STATE', Path(td)), \
             mock.patch.object(crq, 'load_queue', return_value=queue), mock.patch.object(crq, 'fetch'), \
             mock.patch.object(crq, 'apply_measure') as measure, mock.patch.object(crq, 'save_queue') as save, \
             mock.patch.object(crq, 'write_status'):
            crq.cmd_measure()
        measure.assert_not_called()
        save.assert_called_once_with(queue)
        self.assertNotIn('measure', repair)

    def test_measure_ranks_only_measured_items(self):
        skipped = {"id": "f-1", "kind": "merged", "pr": 5, "source": "followup", "state": "skipped"}
        done = {"id": "m-1", "kind": "merged", "pr": 6, "state": "pending"}
        queue = {"items": [skipped, done]}

        def fake_measure(item):
            item["measure"] = {"docs_only": False, "surviving_nondoc": 1, "surviving": 1, "added": 1,
                               "survival": 1, "file_level_focus": 0, "synthetic_paths": [], "excluded_paths": [],
                               "synthetic_added": 0, "covered_surviving": 0, "focus": 0}
        with tempfile.TemporaryDirectory() as td, mock.patch.object(crq, 'STATE', Path(td)), \
             mock.patch.object(crq, 'load_queue', return_value=queue), mock.patch.object(crq, 'fetch'), \
             mock.patch.object(crq, 'apply_measure', side_effect=fake_measure), \
             mock.patch.object(crq, 'save_queue') as save, mock.patch.object(crq, 'write_status'), \
             mock.patch('builtins.print'):
            crq.cmd_measure()
        save.assert_called_once_with(queue)
        self.assertNotIn("order", skipped)
        self.assertEqual(done["order"], 0)

    def test_secret_scan_ignores_header_shaped_hunk_content(self):
        rule = {"id": "marker", "regex": "SECRETMARKER"}
        diff = "\n".join([
            "diff --git a/src/app.sql b/src/app.sql", "--- a/src/app.sql", "+++ b/src/app.sql",
            "@@ -1,0 +2,2 @@", "+++ b/node_modules/x", "+SECRETMARKER", ""])
        removed = "\n".join([
            "diff --git a/src/app.sql b/src/app.sql", "--- a/src/app.sql", "+++ b/src/app.sql",
            "@@ -1,2 +1,0 @@", "--- SECRETMARKER", ""])
        with tempfile.TemporaryDirectory() as td, mock.patch.object(crq, 'denylist_rules', return_value=[rule]), \
             mock.patch.object(crq.shutil, 'which', return_value=None):
            ok, res = crq.secret_scan_diff(diff, Path(td) / "s.json")
            self.assertFalse(ok)
            self.assertEqual([h["file"] for h in res["denylist_hits"]], ["src/app.sql"])
            ok, res = crq.secret_scan_diff(removed, Path(td) / "s.json")
            self.assertFalse(ok)

    def test_measurement_uses_supplied_immutable_target(self):
        target = 'a' * 40
        item = {'merge_commit': 'b' * 40}
        with mock.patch.object(crq, 'git', return_value='') as git, \
             mock.patch.object(crq, 'pr_commit_set', return_value=set()), \
             mock.patch.object(crq, 'rename_map', return_value={}) as renames, \
             mock.patch.object(crq, 'synth_paths', return_value=[]) as paths:
            result = crq.measure_merged(item, target)
        self.assertEqual(result['merge_queue'], target)
        renames.assert_called_once_with(item['merge_commit'], target)
        paths.assert_called_once_with(item['merge_commit'], target)
        self.assertNotIn(mock.call('rev-parse', 'origin/merge-queue'), git.call_args_list)

    def test_measurement_and_coverage_use_same_selected_main_commit(self):
        target = 'a' * 40
        item = {'id': 'merged-1', 'kind': 'merged', 'state': 'done', 'merge_commit': 'b' * 40}
        q = {'items': [item]}
        with mock.patch.object(crq.backfill_runtime, 'select', return_value=(None, False)), \
             mock.patch.object(crq.backfill_runtime, 'settings', return_value=None), \
             mock.patch.object(crq, 'git', return_value=target), \
             mock.patch.object(crq, 'measure_merged', return_value={'merge_queue': target}) as measure, \
             mock.patch.object(crq.coverage, 'coverage_candidate', return_value=None) as candidate:
            crq.coverage_fallback(q, [], False, None)
        measure.assert_called_once_with(item, target)
        self.assertEqual(candidate.call_args.kwargs['merge_queue_sha'], target)
        self.assertEqual(item['measure']['merge_queue'], target)
