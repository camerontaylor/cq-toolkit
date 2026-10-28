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
import deferred_refresh
import review_receipt
import queue_transport

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


    def test_all_causes_exact_vendor_vocabulary_and_exit_contract(self):
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True,
                  "metadata": {"waitTime": "2 minutes"}}
        cause = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for exit_code in (0, 1):
                path.write_text(json.dumps(vendor) + "\n" + json.dumps(vendor))
                cls = crq.classify(path, exit_code)
                self.assertEqual(cls["outcome"], "rate_limited")
                self.assertFalse(cls["counted"])
                self.assertEqual(cls["wait_minutes"], 3)
                self.assertEqual(cls["failure_provenance"],
                    {"version": 1, "complete": True, "causes": [cause, cause]})
            hard_events = [
                {"type": "error", "errorType": "scan", "message": "rate limit auth login quota"},
                {"type": "error", "errorType": "budget"},
                {"type": "error", "errorType": "cancel"},
                {"type": "error", "errorType": "unknown"},
                {"type": "error", "errorType": "rate_limit", "recoverable": False},
                {"type": "error", "errorType": "rate_limit", "recoverable": 1},
                {"type": "error", "errorType": "RATE_LIMIT", "recoverable": True},
                {"type": "action_required"}, {"type": "status", "status": "cancelled"},
                {"type": "status", "status": "budget_exhausted"},
                {"type": "status", "status": "scan_failed"},
                {"type": "finding", "severity": "major"}, COMPLETE]
            for hard_event in hard_events:
                for events in ([vendor, hard_event], [hard_event, vendor]):
                    with self.subTest(events=events):
                        path.write_text("\n".join(json.dumps(e) for e in events))
                        cls = crq.classify(path, 0)
                        self.assertNotEqual(cls["outcome"], "rate_limited")
                        self.assertFalse(cls["counted"])
                        causes = cls["failure_provenance"]["causes"]
                        self.assertIn(cause, causes)
                        self.assertTrue(any(c["source"] == "queue" for c in causes))
            for exit_code in (None, True, "1", -15, 2, 124, 137):
                with self.subTest(exit_code=exit_code):
                    path.write_text(json.dumps(vendor))
                    cls = crq.classify(path, exit_code)
                    self.assertNotEqual(cls["outcome"], "rate_limited")
                    self.assertTrue(any(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))
            for malformed in ("bad", json.dumps({"type": "unknown"})):
                path.write_text(json.dumps(vendor) + "\n" + malformed)
                cls = crq.classify(path, 1)
                self.assertFalse(cls["failure_provenance"]["complete"])
                self.assertNotEqual(cls["outcome"], "rate_limited")
            for error_type in ("review", "auth", "file_limit", "quota", "rate_limit_error"):
                path.write_text(json.dumps({"type": "error", "errorType": error_type,
                    "message": "rate limit: login required", "recoverable": True}))
                cls = crq.classify(path, 1)
                self.assertEqual(cls["outcome"], "auth" if error_type == "auth" else "error")
                self.assertEqual(cls["failure_provenance"]["causes"][0]["source"], "queue")


    def test_only_literal_structured_auth_is_an_operational_auth_stop(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for code in ("auth", "AUTH", "auth_error", "authentication", "unknown", None, []):
                for exit_code in (0, 1, None, 124):
                    with self.subTest(code=code, exit_code=exit_code):
                        path.write_text(json.dumps({"type": "error", "errorType": code,
                            "message": "auth login expired; authenticate", "recoverable": True}))
                        cls = crq.classify(path, exit_code)
                        self.assertEqual(cls["outcome"], "auth" if code == "auth" else
                                         "error")
                        self.assertFalse(cls["counted"])
                        self.assertTrue(all(c["source"] == "queue"
                            for c in cls["failure_provenance"]["causes"]))
            path.write_text(json.dumps({"type": "error", "errorType": "auth"}) + "\n" +
                            json.dumps({"type": "action_required"}))
            cls = crq.classify(path, 1)
            self.assertEqual(cls["outcome"], "action_required")
            self.assertFalse(cls["counted"])

    def test_recognized_progress_preserves_truthful_terminal_and_findings(self):
        progress_events = [{"type": "status", "status": status}
                           for status in ("scanning", "reviewing", "writing")]
        progress_events.append({"type": "heartbeat", "status": "reviewing"})
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for progress in progress_events:
                for severity in (None, "minor", "major"):
                    with self.subTest(progress=progress, severity=severity):
                        findings = [{"type": "finding", "severity": severity}] if severity else []
                        path.write_text("\n".join(json.dumps(e) for e in [progress, *findings, COMPLETE]))
                        cls = crq.classify(path, 0)
                        self.assertEqual(cls["outcome"], "completed")
                        self.assertTrue(cls["counted"])
                        self.assertEqual(cls["findings"], len(findings))
                        self.assertEqual(cls["failure_provenance"], {"version": 1, "complete": True,
                            "causes": [{"source": "queue", "category": "unknown", "code": "blocking-finding"}]
                            if severity == "major" else []})

    def test_progress_alone_trailing_progress_and_missing_exit_never_count(self):
        progress = {"type": "status", "status": "reviewing"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for events, exit_code in (([progress], 0), ([COMPLETE, progress], 0),
                    ([progress, COMPLETE, COMPLETE], 0), ([progress, COMPLETE], None),
                    ([progress, COMPLETE], True), ([progress, COMPLETE], 1),
                    ([progress, {**COMPLETE, "status": "review_skipped"}], 0),
                    ([progress, {**COMPLETE, "message": "No fresh detailed file review"}], 0)):
                with self.subTest(events=events, exit_code=exit_code):
                    path.write_text("\n".join(json.dumps(e) for e in events))
                    cls = crq.classify(path, exit_code)
                    self.assertFalse(cls["counted"])
                    self.assertNotEqual(cls["outcome"], "rate_limited")
                    self.assertTrue(cls["failure_provenance"]["causes"])
                    if type(exit_code) is not int:
                        self.assertFalse(cls["failure_provenance"]["complete"])

    def test_unknown_malformed_and_wrong_type_statuses_stay_incomplete(self):
        bad_events = [{"type": "status", "status": status} for status in
            ("unknown", "REVIEWING", "reviewing ", "scan_failed", "budget_exhausted",
             "cancelled", "awaiting_confirmation", None, [], {}, 1, True)]
        bad_events += [{"type": "review_context", "status": "reviewing"},
                       {"type": "finding", "severity": "minor", "status": "reviewing"},
                       {"type": "heartbeat", "status": "scanning"}]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            for bad in bad_events:
                with self.subTest(bad=bad):
                    path.write_text("\n".join(json.dumps(e) for e in
                        [{"type": "status", "status": "reviewing"}, bad, COMPLETE]))
                    cls = crq.classify(path, 0)
                    self.assertFalse(cls["counted"])
                    self.assertFalse(cls["failure_provenance"]["complete"])
                    self.assertTrue(all(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))

    def test_progress_preserves_all_ordered_failure_causes_without_authorizing_them(self):
        progress = {"type": "status", "status": "reviewing"}
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        vendor_cause = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stream"
            path.write_text(json.dumps(progress) + "\n" + json.dumps(vendor))
            cls = crq.classify(path, 1)
            self.assertEqual(cls["outcome"], "rate_limited")
            self.assertFalse(cls["counted"])
            self.assertEqual(cls["failure_provenance"],
                             {"version": 1, "complete": True, "causes": [vendor_cause]})
            for code in ("unknown", "scan", "budget", "cancel"):
                hard_event = {"type": "error", "errorType": code}
                hard_cause = {"source": "queue", "category": "unknown", "code": code}
                for failures, causes in (([vendor, hard_event], [vendor_cause, hard_cause]),
                                         ([hard_event, vendor], [hard_cause, vendor_cause])):
                    with self.subTest(code=code, failures=failures):
                        path.write_text("\n".join(json.dumps(e) for e in [progress, *failures]))
                        cls = crq.classify(path, 0)
                        self.assertEqual(cls["outcome"], "error")
                        self.assertFalse(cls["counted"])
                        self.assertEqual(cls["failure_provenance"]["causes"], causes)
            for failure in ({"type": "action_required"}, {"type": "status", "status": "scan_failed"}):
                path.write_text("\n".join(json.dumps(e) for e in [progress, vendor, failure]))
                cls = crq.classify(path, 0)
                self.assertNotEqual(cls["outcome"], "rate_limited")
                self.assertFalse(cls["counted"])
                self.assertEqual(cls["failure_provenance"]["causes"][0], vendor_cause)
                self.assertTrue(any(c["source"] == "queue" for c in cls["failure_provenance"]["causes"]))
            path.write_text(json.dumps(progress) + "\nbad\n" + json.dumps(vendor))
            cls = crq.classify(path, 1)
            self.assertFalse(cls["failure_provenance"]["complete"])
            self.assertNotEqual(cls["outcome"], "rate_limited")


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

    def tick(self, dry=False, only=None):
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
            crq.with_lock(crq.tick, dry=dry, only=only)
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

    def deferred_entry(self, pr=42):
        entry = {"binding": {"kind": "deferred-author", "repo": crq.REPO, "producer": "fixture-user",
                 "head": self.merge, "target": "merge-queue", "targetSelector": "promoted-main"},
                 "state": "awaiting-merge" if pr else "awaiting-pr", "pr": pr,
                 "principal": {"server": "retained"}, "deliveries": {"ack": "retained"}, "consumed": True}
        self.q["queue_client_requests"] = {"deferred-42": entry}
        crq.save_queue(self.q)
        return entry

    def forge_data(self, number=42):
        return {"number": number, "user": {"login": "fixture-user"}, "head": {"sha": self.merge},
                "base": {"ref": "merge-queue", "repo": {"full_name": crq.REPO}},
                "state": "closed", "merged": True, "merge_commit_sha": self.merge}

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


    def test_auth_classification_pauses_current_ordinary_and_promotion_harvest(self):
        initial = copy.deepcopy(self.q)
        auth = {"type": "error", "errorType": "auth", "recoverable": True}
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        mixed = [{"type": "error", "errorType": code}
                 for code in ("unknown", "scan", "budget", "cancel")] + [vendor]
        streams = [[auth]] + [events for other in mixed
                              for events in ([auth, other], [other, auth])]
        n = 0
        for kind in (review_receipt.KIND, "pr", "promotion"):
            for events in streams:
                with self.subTest(kind=kind, events=events), \
                     mock.patch.object(crq, "RUNS", self.state / f"auth-runs-{n}"):
                    n += 1
                    self.q = copy.deepcopy(initial)
                    crq.save_queue(self.q)
                    item = self.enroll(f"auth-{n}")
                    rdir = self.launch_item(item)
                    self.terminal_artifacts(item, events)
                    (rdir / "exit.json").write_text(json.dumps({"exit": 1}))
                    # A real detached run, stream and classifier feed each harvest route.
                    item["kind"] = kind
                    result = self.harvest(item)
                    cls = json.loads((rdir / "classification.json").read_text())
                    self.assertEqual(cls["outcome"], "auth")
                    self.assertFalse(cls["counted"])
                    self.assertEqual(cls["failure_provenance"]["causes"][:len(events)], [
                        {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                        if e["errorType"] == "rate_limit" else
                        {"source": "queue", "category": "unknown", "code": e["errorType"]}
                        for e in events])
                    self.assertTrue(self.q["paused"])
                    self.assertIn("auth", self.q["pause_reason"])
                    self.assertIsNone(item["run"])
                    self.assertNotIn("not_before", item)
                    self.assertEqual(item.get("cycles", []), [])
                    self.assertNotIn("coverage", self.q)
                    if kind == review_receipt.KIND:
                        document = self.document(item)
                        self.assertEqual(document["outcome"], "auth")
                        self.assertFalse(document["counted"])
                        self.assertEqual(document["classification"], cls)
                        self.assertFalse(queue_transport._vendor_rate_limit(document))
                    else:
                        self.assertIn("PAUSED", result)
                        self.assertEqual(item["state"], "pending")
                    crq.save_queue(self.q)
                    self.assertEqual(self.tick(), 0)
                    self.assertTrue(crq.load_queue()["paused"])

    def test_prose_auth_and_unknown_mixed_causes_do_not_pause_or_gain_vendor_authority(self):
        initial = copy.deepcopy(self.q)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        for n, code in enumerate(("unknown", "AUTH", "auth_error", "scan", "budget", "cancel")):
            hard = {"type": "error", "errorType": code, "message": "auth login expired"}
            for order, events in enumerate(([vendor, hard], [hard, vendor])):
                with self.subTest(code=code, order=order), \
                     mock.patch.object(crq, "RUNS", self.state / f"not-auth-{n}-{order}"):
                    self.q = copy.deepcopy(initial)
                    crq.save_queue(self.q)
                    item = self.enroll(f"not-auth-{n}-{order}")
                    rdir = self.launch_item(item)
                    self.terminal_artifacts(item, events)
                    self.harvest(item)
                    document = self.document(item)
                    self.assertEqual(document["outcome"], "error")
                    self.assertFalse(document["counted"])
                    self.assertFalse(self.q["paused"])
                    self.assertFalse(queue_transport._vendor_rate_limit(document))
                    self.assertNotIn("cooldown_until", self.q)
                    self.assertNotIn("coverage", self.q)
                    self.assertTrue(any(c["source"] == "queue"
                        for c in document["classification"]["failure_provenance"]["causes"]))

    def test_receipt_preserves_all_classification_causes(self):
        item = self.enroll()
        rdir = self.launch_item(item)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        (rdir / "review.ndjson").write_text(json.dumps(vendor) + "\n" +
            json.dumps({"type": "error", "errorType": "scan"}))
        self.harvest(item)
        document = self.document(item)
        self.assertEqual(document["outcome"], "error")
        self.assertFalse(document["counted"])
        self.assertEqual(document["classification"]["failure_provenance"]["causes"], [
            {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"},
            {"source": "queue", "category": "unknown", "code": "scan"}])


    def test_persisted_producer_proof_controls_transport_vendor_authority(self):
        initial = copy.deepcopy(self.q)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        hard = {"type": "error", "errorType": "scan"}
        launch_at = crq.now()
        for n, events in enumerate(([vendor], [vendor, hard], [hard, vendor])):
            with self.subTest(events=events), \
                 mock.patch.object(crq, "RUNS", self.state / f"runs-{n}"), \
                 mock.patch.object(crq, "now", return_value=launch_at):
                self.q = copy.deepcopy(initial)
                crq.save_queue(self.q)
                request = f"boundary-{n}"
                item = self.enroll(request)
                self.launch_item(item)
                self.terminal_artifacts(item, events)
                self.harvest(item)
                document = self.document(item)
                self.assertEqual(len(document["classification"]["failure_provenance"]["causes"]), len(events))
                binding = {"kind": "merged-current", "repo": crq.REPO, "pr": 42,
                           "mergeSha": self.merge, "targetSelector": "promoted-main"}
                policy = {"enabled": True, "repo": crq.REPO, "targets": ["promoted-main"],
                          "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
                forge = {"repo": crq.REPO, "pr": 42, "target": "merge-queue",
                         "state": "MERGED", "mergeSha": self.merge}
                def call(op):
                    raw = queue_transport.handle(review_receipt.canonical({"v": 1, "op": op,
                        "requestId": request, "binding": binding}), crq, principal="developer",
                        policy=policy, verify_source=lambda repo, pr: forge,
                        receipt_root=self.state / "receipts")
                    return json.loads(raw)["result"]
                call("enqueue")
                status = call("status")
                self.assertEqual(status["receiptId"], item["receipt_id"])
                self.assertTrue(status["enqueued"])
                self.assertEqual(status["state"], "blocked")
                self.assertFalse(status["reviewed"])
                self.assertFalse(status["fixed"])
                self.assertEqual(status["reason"],
                    {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                    if n == 0 else {"source": "queue", "category": "unknown", "code": "unclassified"})


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


class OptionalCycleWaitTest(unittest.TestCase):
    """Q14: a parked merged row never starts, so it must not demand a wait."""

    def optional(self, **over):
        return dict(dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}],
                         optional_cycle=True, order=1), **over)

    def merged(self, pr=42, **over):
        return dict(dict(id=f"merged-{pr}", pr=pr, kind="merged", state="pending", order=2), **over)

    def receipt(self, pr=42, **over):
        return dict(dict(id=f"current-{pr}", pr=pr, kind=crq.review_receipt.KIND,
                         state="pending", order=3), **over)

    @staticmethod
    def callsite_parks(item, items):
        """crq.tick()'s admission predicate, verbatim from the base pin."""
        return item["kind"] == "merged" and any(
            i.get("kind") == crq.review_receipt.KIND and i.get("pr") == item["pr"] for i in items)

    def test_parked_merged_row_does_not_demand_an_optional_wait(self):
        optional, merged, receipt = self.optional(), self.merged(), self.receipt()
        q = dict(items=[optional, merged, receipt])
        # A pending linked receipt is startable work in its own right: it still demands the wait.
        self.assertTrue(crq.optional_wait(q, optional))
        for state in ("done", "blocked", "skipped"):
            with self.subTest(receipt_state=state):
                receipt["state"] = state      # the park rule ignores the receipt state
                # Terminal receipt: only the parked merged row is left, and it never starts.
                self.assertFalse(crq.optional_wait(q, optional))

    def test_optional_cycle_still_waits_for_startable_required_work(self):
        optional = self.optional()
        self.assertTrue(crq.optional_wait(dict(items=[optional, self.merged()]), optional))
        self.assertTrue(crq.optional_wait(
            dict(items=[optional, self.merged(), self.receipt(pr=43)]), optional))
        self.assertTrue(crq.optional_wait(dict(items=[optional, self.receipt()]), optional))
        self.assertTrue(crq.optional_wait(dict(items=[
            optional, self.merged(), self.receipt(),
            dict(id="pr9", pr=9, kind="open", state="pending", order=4)]), optional))

    def test_park_predicate_matches_the_admission_callsite_for_every_row_shape(self):
        cases = [[self.merged(), self.receipt()],
                 [self.merged(), self.receipt(state="done")],
                 [self.merged(), self.receipt(pr=43)],
                 [self.merged()],
                 [self.receipt(), self.merged(pr=43)],
                 [self.merged(), dict(id="cov", pr=42, kind="coverage", state="pending")],
                 [self.receipt()]]
        for items in cases:
            for item in items:
                with self.subTest(rows=[i["id"] for i in items], row=item["id"]):
                    self.assertEqual(crq.parked_merged_linked_receipt(dict(items=items), item),
                                     self.callsite_parks(item, items))


class OptionalCycleAdmissionTest(unittest.TestCase):
    """Q14: the parked row yields the start slot instead of starving rank 5."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
        for name, value in (
                ("load_queue", lambda: self.q), ("fetch", mock.Mock()),
                ("enroll", lambda q, dry: []), ("promotion_audit", lambda q, dry: []),
                ("promotion_tick", lambda q, dry: []), ("save_queue", mock.Mock()),
                ("write_status", mock.Mock()), ("write_heartbeat", mock.Mock()),
                ("notify_owner", mock.Mock()), ("event", mock.Mock()),
                ("coverage_fallback", lambda *a: (None, False)),
                ("promotion_mode", lambda: "user"), ("apply_signer_backoff", mock.Mock()),
                ("STATE", self.root), ("PROMO", {"enabled": False}),
                ("CONFIG", {"max_starts_per_hour": 5, "max_inflight": 2,
                            "stale_alarm_min": 36, "repair": {}})):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        for name in ("backfill", "archive_legacy", "reconcile_fix_prs"):
            patch = mock.patch.object(crq.repair_tick, name, mock.Mock())
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(crq.coverage, "record_opportunity", lambda *a, **k: {})
        patch.start()
        self.addCleanup(patch.stop)

    def rows(self):
        """The linked receipt is terminal: the park rule ignores its state."""
        return (dict(id="pr1", pr=1, kind="open", state="pending", cycles=[{}],
                     optional_cycle=True, order=1),
                dict(id="merged-42", pr=42, kind="merged", state="pending", order=2),
                dict(id="current-42", pr=42, kind=crq.review_receipt.KIND, state="done", order=3))

    def start(self):
        plan = dict(base="a" * 40, head="b" * 40, notes=[], label="additional cycle (optional)")
        with mock.patch.object(crq, "pr_info", return_value={"state": "OPEN"}), \
             mock.patch.object(crq, "quiet_reason", return_value=None), \
             mock.patch.object(crq, "plan_open", return_value=plan), \
             mock.patch.object(crq, "launch", return_value="run") as launch:
            crq.tick()
        return launch

    def test_parked_merged_row_no_longer_starves_the_optional_cycle(self):
        self.q["items"] = list(self.rows())
        launch = self.start()
        self.assertEqual(launch.call_args.args[1]["id"], "pr1")

    def test_startable_required_work_still_precedes_the_optional_cycle(self):
        optional, merged, receipt = self.rows()
        open_row = dict(id="pr9", pr=9, kind="open", state="pending", order=0)
        self.q["items"] = [open_row, merged, receipt, optional]
        launch = self.start()
        self.assertEqual(launch.call_args.args[1]["id"], "pr9")


class ConfiguredBranchTargetTest(unittest.TestCase):
    """CR major on PR #668 (r4400294081): a configured branch target must verify.

    The deferred publication path hardcoded `merge-queue`, so a PR opened into an
    allowlisted branch such as `release/1.4` failed `verify_deferred_source` and
    refresh recorded a permanent identity blocker. The binding comparison that keeps
    the target immutable lives in `deferred_refresh._verified`, so these tests pin
    both halves: the configured target verifies, and cross-target drift still blocks.
    """

    def setUp(self):
        self.metadata = {}
        self.result = {"incomplete_results": False, "total_count": 0, "items": []}
        patch = mock.patch.object(crq, "deferred_forge", self.forge)
        patch.start()
        self.addCleanup(patch.stop)

    def forge(self, argv):
        if "search/issues" in argv:
            return self.result
        return self.metadata[int(argv[-1].rsplit("/", 1)[-1])]

    def pr(self, number, head="a" * 40, target="merge-queue"):
        self.metadata[number] = {
            "number": number, "state": "open", "merged": False, "merge_commit_sha": None,
            "user": {"login": "author"}, "head": {"sha": head},
            "base": {"ref": target, "repo": {"full_name": crq.REPO}}}
        return {"number": number, "pull_request": {"url": f"fixture/{number}"}}

    def binding(self, target):
        return {"kind": "deferred-author", "repo": crq.REPO, "producer": "author",
                "head": "a" * 40, "target": target, "targetSelector": "promoted-main"}

    def refresh(self, q):
        return deferred_refresh.refresh_deferred(q, verify_source=crq.verify_deferred_source,
                                                 find_source=crq.find_deferred_source, at="now")

    def test_configured_branch_target_verifies(self):
        self.pr(12, target="release/1.4")
        self.assertEqual(crq.verify_deferred_source(crq.REPO, 12)["target"], "release/1.4")

    def test_configured_branch_target_is_found_and_clears_the_identity_blocker(self):
        row = self.pr(12, target="release/1.4")
        self.result = {"incomplete_results": False, "total_count": 1, "items": [row]}
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": self.binding("release/1.4"), "state": "awaiting-pr", "createdAt": "before"}}}
        self.refresh(q)
        entry = q["queue_client_requests"]["request-1"]
        self.assertEqual(entry["state"], "awaiting-merge")
        self.assertEqual(entry["pr"], 12)
        self.assertNotIn("reason", entry)

    def test_configured_branch_target_still_refuses_a_malformed_target(self):
        self.pr(12, target="release/1.4")
        for bad in ("a..b", "release//1.4", "x.lock", "@"):
            with self.subTest(target=bad):
                with self.assertRaises(ValueError):
                    crq.find_deferred_source(crq.REPO, "author", "a" * 40, bad, 2)

    def test_cross_target_drift_still_blocks(self):
        # Binding says release/1.4 but the forge PR actually targets release/2.0:
        # dropping the hardcoded constant must not weaken the immutable binding.
        self.pr(12, target="release/2.0")
        q = {"items": [], "queue_client_requests": {"request-1": {
            "binding": self.binding("release/1.4"), "state": "awaiting-merge", "pr": 12,
            "createdAt": "before"}}}
        self.refresh(q)
        entry = q["queue_client_requests"]["request-1"]
        self.assertEqual(entry["reason"]["category"], "identity")
        self.assertEqual(q["items"], [])
