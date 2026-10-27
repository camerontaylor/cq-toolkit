"""Offline Q1 integration: real temporary Git; fake forge/provider/processes."""
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import review_receipt

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_current_test", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)
COMPLETE = {"type": "complete", "status": "review_completed", "reviewedFiles": ["affected.py"]}


class ClassifierTest(unittest.TestCase):
    def test_semantic_terminal_and_negative_cases_match_ts_contract(self):
        cases = [([COMPLETE], 0, True),
                 ([{"type": "status"}, {"type": "review_context"}, {"type": "heartbeat"},
                   {"type": "finding", "severity": "major", "comment": "defect"}, COMPLETE], 0, True),
                 ([{**COMPLETE, "message": "No fresh detailed file review was performed in this run."}], 0, False),
                 ([{**COMPLETE, "status": "review_skipped"}], 0, False),
                 ([{**COMPLETE, "status": "unknown"}], 0, False),
                 ([COMPLETE, {"type": "finding", "severity": "major"}], 0, False),
                 ([COMPLETE, {"type": "heartbeat"}], 0, False),
                 ([COMPLETE, {"type": "review_context"}], 0, False),
                 ([COMPLETE, COMPLETE], 0, False),
                 ([{"type": "error", "message": "failure"}, COMPLETE], 0, False),
                 ([{"type": "action_required"}, COMPLETE], 0, False),
                 ([{"type": "unknown"}, COMPLETE], 0, False),
                 ([{"type": []}, COMPLETE], 0, False),
                 ([None, COMPLETE], 0, False), ([[], COMPLETE], 0, False),
                 ([{"type": "finding", "severity": []}, COMPLETE], 0, False),
                 ([{"type": "finding"}, COMPLETE], 0, False),
                 ([COMPLETE], 1, False), ([COMPLETE], None, False), ([], 0, False)]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for events, exit_code, counted in cases:
                with self.subTest(events=events, exit_code=exit_code):
                    path.write_text("\n".join(json.dumps(e) for e in events))
                    self.assertEqual(crq.classify(path, exit_code)["counted"], counted)
            for content in ("bad\n" + json.dumps(COMPLETE), json.dumps(COMPLETE) + "\nbad"):
                path.write_text(content)
                self.assertFalse(crq.classify(path, 0)["counted"])


class CurrentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.g("init", "-q")
        self.g("config", "user.email", "fixture@localhost")
        self.g("config", "user.name", "fixture")
        self.write("affected.py", "historical removed text\nunchanged within file\n")
        self.write("gone.py", "old deleted code\n")
        self.write("unrelated.py", "unrelated scope\n")
        self.pre = self.commit("before")
        self.write("affected.py", "source addition\nunchanged within file\n")
        self.write("rename.py", "rename survives\n" * 10)
        (self.repo / "gone.py").unlink()
        self.merge = self.commit("source merge provenance")
        self.state = self.root / "state"
        self.state.mkdir()
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False,
                  "legacy_repair_backfilled": crq.iso()}
        for name, value in (("CLONE", self.repo), ("STATE", self.state), ("RUNS", self.state / "runs"),
                            ("QUEUE", self.state / "queue.json"), ("EVENTS", self.state / "events.jsonl"),
                            ("LOCK", self.state / "tick.lock"), ("WORK_RECORDS", self.state / "work.jsonl")):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        real_run = crq.run
        def fake_version(argv, **kw):
            if argv == ["coderabbit", "--version"]:
                return SimpleNamespace(stdout="fixture-cli-1\n", returncode=0)
            return real_run(argv, **kw)
        patch = mock.patch.object(crq, "run", side_effect=fake_version)
        patch.start()
        self.addCleanup(patch.stop)
        self.info = {"number": 42, "state": "MERGED", "mergeCommit": {"oid": self.merge},
                     "baseRefName": "merge-queue"}
        self.g("update-ref", "refs/remotes/origin/main", self.merge)
        self.g("update-ref", "refs/remotes/origin/merge-queue", self.merge)
        crq.save_queue(self.q)

    def g(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, text=True,
                              capture_output=True).stdout.strip()

    def write(self, name, text):
        (self.repo / name).write_text(text)

    def commit(self, message):
        self.g("add", ".")
        self.g("commit", "-qm", message)
        return self.g("rev-parse", "HEAD")

    def enroll(self, request="missed"):
        with mock.patch.object(crq, "pr_info", return_value=self.info), \
             mock.patch.object(crq, "launch") as launch:
            result = crq.with_lock(crq.enqueue_merged, 42, self.merge, request)
            launch.assert_not_called()
        self.q = crq.load_queue()
        return next(i for i in self.q["items"] if i["id"] == result["item_id"])

    def advance(self):
        self.write("affected.py", "current replacement\nunchanged within file\n")
        self.g("mv", "rename.py", "renamed.py")
        target = self.commit("later current code")
        self.g("update-ref", "refs/remotes/origin/main", target)
        return target

    def tick(self):
        real_popen = subprocess.Popen
        def fake_child(argv, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, **kw)
        with contextlib.ExitStack() as stack:
            for name in ("fetch", "write_status", "write_heartbeat", "notify_owner"):
                stack.enter_context(mock.patch.object(crq, name))
            for name in ("enroll", "promotion_audit", "promotion_tick"):
                stack.enter_context(mock.patch.object(crq, name, return_value=[]))
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs"))
            stack.enter_context(mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")))
            stack.enter_context(mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})))
            child = stack.enter_context(mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child))
            crq.with_lock(crq.tick)
            return sum(call.args[0][0] == sys.executable and "_review" in call.args[0] for call in child.call_args_list)

    def plan_item(self, item):
        self.plan = crq.prepare_current(self.q, item, False)
        return self.plan

    def terminal_artifacts(self, item, events=None):
        run_id = item["run"]["run_id"]
        rdir = crq.RUNS / run_id
        (rdir / "review.ndjson").write_text("\n".join(json.dumps(e) for e in (events or [COMPLETE])))
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": "immutable-end"}))
        (rdir / "secret-scan.json").write_text("{}")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 919191, "pgid": 919191,
            "sid": 919191, "group_owner": crq.author_quota.GROUP_OWNER_MARKER, "cli_pid": 919192}))
        return rdir

    def document(self, item):
        return json.loads((self.state / "receipts" / (item["receipt_id"] + ".json")).read_text())

    def launch_item(self, item):
        self.plan_item(item)
        with mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")), \
             mock.patch.object(crq.subprocess, "Popen", return_value=SimpleNamespace(pid=919191)), \
             mock.patch.object(crq, "git", return_value="fixture patch"):
            crq.launch(self.q, item, self.plan)
        return self.terminal_artifacts(item)

    def harvest(self, item):
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree"), \
             mock.patch.object(crq.repair_tick, "enqueue") as repair:
            result = crq.harvest_review(self.q, item, False)
            repair.assert_not_called()
            return result

    def test_enqueue_and_request_conflict_are_verified_without_launch(self):
        item = self.enroll()
        self.assertNotIn("capture", item)
        self.assertEqual(self.q["starts"], [])
        with mock.patch.object(crq, "pr_info", return_value={**self.info, "state": "OPEN"}):
            with self.assertRaises(ValueError):
                crq.enqueue_merged(42, self.merge, "bad")
        self.assertEqual(len(crq.load_queue()["items"]), 1)
        again = self.enroll("second")
        self.assertEqual(item["id"], again["id"])

    def test_projection_exact_current_blobs_including_unchanged_and_later_rename(self):
        item = self.enroll()
        target = self.advance()
        plan = self.plan_item(item)
        self.assertEqual(item["capture"]["target"], target)
        self.assertEqual(self.g("rev-parse", plan["head"] + "^{tree}"), self.g("rev-parse", target + "^{tree}"))
        self.assertEqual(self.g("diff", "--name-status", plan["base"], plan["head"]).splitlines(),
                         ["A\taffected.py", "A\trenamed.py"])
        patch = self.g("diff", "--no-ext-diff", plan["base"], plan["head"])
        self.assertIn("+unchanged within file", patch)
        self.assertIn("+current replacement", patch)
        self.assertNotIn("historical removed text", patch)
        self.assertNotIn("unrelated scope", patch)
        rows = {r["source_path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["gone.py"]["disposition"], "deleted")
        self.assertEqual(rows["rename.py"]["disposition"], "renamed")
        self.write("affected.py", "advanced during run\n")
        later = self.commit("inflight movement")
        self.g("update-ref", "refs/remotes/origin/main", later)
        self.assertEqual(self.plan_item(item)["head"], plan["head"])
        self.assertEqual(item["capture"]["target"], target)

    def test_not_yet_promoted_and_dry_run_never_capture(self):
        item = self.enroll()
        self.g("update-ref", "refs/remotes/origin/main", self.pre)
        self.assertIsNotNone(crq.prepare_current(self.q, item, True))
        self.assertNotIn("capture", item)
        with self.assertRaisesRegex(crq.NotReady, "not-yet-promoted"):
            self.plan_item(item)
        self.assertNotIn("capture", item)

    def test_natural_tick_reserves_then_detaches_and_harvests_after_restart(self):
        item = self.enroll()
        target = self.advance()
        self.assertEqual(self.tick(), 1)
        self.q = crq.load_queue()
        item = self.q["items"][0]
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(len(self.q["starts"]), 1)
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["capture"]["target"], target)
        self.terminal_artifacts(item, [{"type": "finding", "severity": "major", "comment": "fix this"}, COMPLETE])
        self.harvest(item)
        self.assertEqual(item["state"], "done")
        doc = self.document(item)
        self.assertEqual(doc["outcome"], "terminal-with-findings")
        self.assertTrue(doc["counted"])
        self.assertEqual(doc["remediation"], "disabled/deferred")
        self.assertEqual(item["cycles"], [])
        manifest = crq.current_report("missed")
        self.assertEqual(manifest, crq.current_report("missed"))
        self.assertEqual(len(crq.load_queue()["starts"]), 1)

    def test_harvest_crash_after_receipt_write_recovers_same_identity(self):
        item = self.enroll()
        self.launch_item(item)
        persisted = copy.deepcopy(self.q)
        with mock.patch.object(crq, "save_queue", side_effect=OSError("queue write lost")):
            with self.assertRaises(OSError):
                self.harvest(item)
        ids = [p.stem for p in (self.state / "receipts").glob("*.json")]
        self.assertEqual(len(ids), 1)
        self.q = persisted
        item = self.q["items"][0]
        self.harvest(item)
        self.assertEqual(item["receipt_id"], ids[0])
        self.assertEqual(len(item["attempts"]), 1)
        self.assertEqual(len(self.q["starts"]), 1)

    def test_alive_and_ambiguous_never_released(self):
        item = self.enroll()
        self.launch_item(item)
        before = copy.deepcopy(item["run"])
        for state in ("alive", "ambiguous"):
            with mock.patch.object(crq, "run_liveness", return_value=state):
                self.assertIsNone(crq.harvest_review(self.q, item, False))
                self.assertEqual(item["run"], before)
                self.assertEqual(item["state"], "reviewing")
                self.assertNotIn("receipt_id", item)

    def test_no_fresh_and_malformed_receipts_do_not_count(self):
        for n, events in enumerate(([{**COMPLETE, "message": "No fresh detailed file review was performed"}],
                       [None, COMPLETE], [COMPLETE, {"type": "finding", "severity": "major"}])):
            with self.subTest(events=events):
                item = self.enroll()
                item.update(id="negative-" + str(n), state="pending", run=None)
                self.launch_item(item)
                self.terminal_artifacts(item, events)
                self.harvest(item)
                self.assertEqual(item["state"], "blocked")
                self.assertFalse(self.document(item)["counted"])

    def test_scan_failure_never_reserves_or_spawns(self):
        item = self.enroll()
        self.plan_item(item)
        with mock.patch.object(crq, "secret_scan_diff", return_value=(False, {"denylist_hits": [1], "gitleaks_hits": []})), \
             mock.patch.object(crq.subprocess, "Popen") as child, \
             mock.patch.object(crq, "git", return_value="patch"):
            crq.launch(self.q, item, self.plan)
        child.assert_not_called()
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])

    def test_all_vanished_no_current_code_and_binary_oversize_symlink_dispositions(self):
        item = self.enroll()
        (self.repo / "affected.py").unlink()
        (self.repo / "rename.py").unlink()
        target = self.commit("all vanished")
        self.g("update-ref", "refs/remotes/origin/main", target)
        self.assertIsNone(self.plan_item(item))
        self.assertEqual(item["state"], "no-current-code")
        self.assertFalse(self.document(item)["counted"])
        self.assertEqual(self.q["starts"], [])
        self.write("affected.py", "x" * 262145)
        (self.repo / "rename.py").write_bytes(b"binary\x00data")
        self.g("update-ref", "refs/remotes/origin/main", self.commit("unsupported current files"))
        item.pop("capture")
        item.pop("receipt_id")
        self.assertIsNone(self.plan_item(item))
        self.assertEqual(item["state"], "unsupported")
        self.assertEqual(sum(r["disposition"] == "unsupported" for r in item["capture"]["paths"]), 2)
        (self.repo / "affected.py").unlink()
        os.symlink("unrelated.py", self.repo / "affected.py")
        self.g("update-ref", "refs/remotes/origin/main", self.commit("symlink is never dereferenced"))
        rows = crq.current_paths(self.merge, self.g("rev-parse", "HEAD"))
        self.assertEqual(next(r for r in rows if r["source_path"] == "affected.py")["reason"],
                         "non-regular file; never dereferenced")

    def test_equivalent_receipt_reuse_and_legacy_does_not_upgrade(self):
        item = self.enroll()
        self.launch_item(item)
        self.harvest(item)
        other = copy.deepcopy(item)
        other.update(id="current-other-source", state="pending", attempts=[], receipt_id=None,
                     subject={**item["subject"], "pr": 43})
        self.q["items"].append(other)
        self.assertIsNone(crq.prepare_current(self.q, other, False))
        self.assertEqual(other["receipt_id"], item["receipt_id"])
        self.assertEqual(other["reused_from"], item["id"])
        self.assertEqual(len(self.q["starts"]), 1)
        legacy = {"id": "legacy", "kind": "merged", "pr": 42, "state": "done", "cycles": [{"head": self.merge}]}
        self.q["items"] = [legacy, {**copy.deepcopy(item), "state": "pending", "receipt_id": None}]
        self.assertIsNotNone(crq.prepare_current(self.q, self.q["items"][1], False))
        legacy["state"] = "reviewing"
        with self.assertRaisesRegex(crq.NotReady, "legacy"):
            crq.prepare_current(self.q, self.q["items"][1], False)

    def test_cli_help_and_json_enrollment_report(self):
        for command in ("enqueue-merged", "report"):
            with mock.patch.object(sys, "argv", ["crq", command, "--help"]), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as end:
                    crq.main()
                self.assertEqual(end.exception.code, 0)
                self.assertIn("--request-id", output.getvalue())
        with mock.patch.object(sys, "argv", ["crq", "enqueue-merged", "--pr", "42", "--merge-sha", self.merge,
                                             "--request-id", "cli"]), \
             mock.patch.object(crq, "pr_info", return_value=self.info), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(crq.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["state"], "pending")
        with mock.patch.object(sys, "argv", ["crq", "report", "--request-id", "cli"]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(crq.main(), 0)
            self.assertIsNone(json.loads(output.getvalue())["receipt_id"])

    def test_ambiguous_rename_keeps_explicit_partial_scope(self):
        self.write("duplicate.py", "rename survives\n" * 10)
        self.merge = self.commit("source includes identical rename candidates")
        self.info["mergeCommit"]["oid"] = self.merge
        item = self.enroll()
        self.g("mv", "rename.py", "new-one.py")
        self.g("mv", "duplicate.py", "new-two.py")
        target = self.commit("ambiguous identical renames")
        self.g("update-ref", "refs/remotes/origin/main", target)
        self.plan_item(item)
        rows = item["capture"]["paths"]
        self.assertEqual(next(r for r in rows if r["source_path"] == "duplicate.py")["disposition"], "ambiguous")
        # No other affected current code remains: ambiguity cannot become clean.
        self.assertEqual(item["state"], "unsupported")
        self.assertFalse(self.document(item)["counted"])

    def test_actual_full_current_scan_blocks_unchanged_secret_before_spawn(self):
        self.write("affected.py", "source addition\nfixture-sensitive-marker\n")
        self.g("update-ref", "refs/remotes/origin/main", self.commit("current secret outside old added lines"))
        item = self.enroll()
        self.plan_item(item)
        # Real projection/scan, controlled denylist, no optional external scanner.
        with mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "fixture-sensitive-marker"}]), \
             mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree") as wt:
            crq.launch(self.q, item, self.plan)
        wt.assert_not_called()
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        doc = self.document(item)
        self.assertEqual(doc["outcome"], "blocked-secret-scan")
        self.assertNotIn("fixture-sensitive-marker", json.dumps(doc))
        self.assertFalse(doc["counted"])

    def test_receipt_write_failure_preserves_original_review_for_retry(self):
        item = self.enroll()
        self.launch_item(item)
        with mock.patch.object(review_receipt, "write_receipt", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.harvest(item)
        self.assertEqual(item["state"], "reviewing")
        self.assertIsNotNone(item["run"])
        self.harvest(item)
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["attempts"]), 1)

    def test_selective_start_refuses_and_caps_prevent_capture(self):
        item = self.enroll()
        with mock.patch.object(crq, "fetch"), mock.patch.object(crq, "enroll", return_value=[]), \
             mock.patch.object(crq, "write_status"), mock.patch.object(crq, "write_heartbeat"), \
             mock.patch.object(crq, "promotion_tick", return_value=[]), \
             mock.patch.object(crq, "promotion_audit", return_value=[]), \
             mock.patch.object(crq.repair_tick, "reconcile_fix_prs"), \
             mock.patch.object(crq, "prepare_current") as planner:
            log = crq.with_lock(crq.tick, False, item["id"])
            self.assertTrue(any("selective start refused" in line for line in log))
            planner.assert_not_called()
            q = crq.load_queue()
            q["starts"] = [crq.iso()] * crq.CONFIG["max_starts_per_hour"]
            crq.save_queue(q)
            log = crq.with_lock(crq.tick)
            self.assertTrue(any("hourly cap" in line for line in log))
            planner.assert_not_called()
