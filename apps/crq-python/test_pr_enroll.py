"""Offline pr-discovery integration: real temporary Git repos; fake forge/CLI.

Fixture shape follows test_push_current.py (which follows CurrentTest): a
module-global copy of the crq module, real git for the primary fixture and a
foreign origin/clone pair, no network, a fake coderabbit CLI and a fake
gh_json keyed on repo. Covers docs/multi-repo.md discovery mode `pr`:
enrollment, repo-clone planning, the universal scan classes, counted-harvest
issue delivery (never coverage/repair), and the unchanged primary behavior.
"""
import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_pr_test_crq", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)
import pr_enroll
import repo_registry

PRIMARY = "camerontaylor/cq-toolkit"
FOREIGN = "camerontaylor/infra"
COMPLETE = {"type": "complete", "status": "review_completed", "reviewedFiles": ["f0.py"]}

# Fake denylist corpus (same shape as test_push_current.py): the four
# UNIVERSAL_SCAN_CLASSES ids plus publish classes that must stay primary-only.
# denylist_rules parses this file from the primary clone at origin/main, so the
# class filtering runs for real. Publish vocabulary is itself denylisted in
# this tree, so fixtures spell it in pieces.
_CERES = "ce" + "res"
_PLUTO = "pl" + "uto"
_PERSONAL = "/home/c" + "taylor"
_SSH_KEY_RULE = "-----BEGIN " + "[A-Z0-9 ]*" + "PRIVATE KEY-----"
_FLEET_PROSE = "redeploy " + _CERES + " tonight\ncwd=" + _PERSONAL + "/tmp\n" + _PLUTO + " dashboards\n"
DENYLIST_FIXTURE = (
    "rules:\n"
    "  - id: class:token-ssh-plumbing\n"
    f"    regex: '{_SSH_KEY_RULE}'\n"
    "  - id: class:route-key-material\n"
    "    regex: 'pk-(live|test)-[A-Za-z0-9]{16,}'\n"
    "  - id: class:key-material-env\n"
    "    regex: '\\b[A-Z][A-Z_]*_KEY='\n"
    "  - id: class:inline-secret-assignments\n"
    "    regex: '\\b(secret|password)\\s*[:=]\\s*\\S{8,}'\n"
    "  - id: class:webfront-hostnames\n"
    f"    regex: '\\b({_CERES}|{_PLUTO})\\b'\n"
    "  - id: class:personal-paths\n"
    f"    regex: '{_PERSONAL}\\b'\n"
)


class PrTest(unittest.TestCase):
    """One primary fixture (crq's own clone, carrying the denylist corpus) and
    a foreign origin+clone pair whose default branch hosts the open PRs."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.init_repo(self.root / "primary-origin")
        (self.origin / "policy" / "denylist").mkdir(parents=True)
        (self.origin / "policy" / "denylist" / "patterns.yml").write_text(DENYLIST_FIXTURE)
        self.commit(self.origin, "denylist fixture", when=self.ago(48))
        self.repo = self.clone_repo(self.origin, self.root / "primary")
        self.foreign_origin = self.init_repo(self.root / "infra-origin")
        (self.foreign_origin / "README.md").write_text("infra\n")
        self.base = self.commit(self.foreign_origin, "infra init", when=self.ago(48))
        self.foreign = self.clone_repo(self.foreign_origin, self.root / "infra")
        self.state = self.root / "state"
        self.state.mkdir()
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
        for name, value in (("CLONE", self.repo), ("STATE", self.state), ("RUNS", self.state / "runs"),
                            ("QUEUE", self.state / "queue.json"), ("EVENTS", self.state / "events.jsonl"),
                            ("LOCK", self.state / "tick.lock"), ("WORK_RECORDS", self.state / "work.jsonl")):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.repos = [self.cfg()]
        patch = mock.patch.object(crq, "REPOS", self.repos)
        patch.start()
        self.addCleanup(patch.stop)
        real_run = crq.run

        def fake_run(argv, **kw):
            if argv == ["coderabbit", "--version"]:
                return SimpleNamespace(stdout="fixture-cli-1\n", returncode=0)
            if argv[0] == "gh":
                raise AssertionError("unmocked forge call in offline fixture")
            return real_run(argv, **kw)

        patch = mock.patch.object(crq, "run", side_effect=fake_run)
        patch.start()
        self.addCleanup(patch.stop)
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        wake = mock.patch.object(crq, "refresh_slot_deadline")
        wake.start()
        self.addCleanup(wake.stop)
        crq.save_queue(self.q)

    # ------------------------------------------------------------ fixtures

    def init_repo(self, path):
        path.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "fixture@localhost"], cwd=path, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.name", "fixture"], cwd=path, check=True, capture_output=True)
        return path

    def clone_repo(self, source, path):
        subprocess.run(["git", "clone", "-q", str(source), str(path)], cwd=self.root, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.email", "fixture@localhost"], cwd=path, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.name", "fixture"], cwd=path, check=True, capture_output=True)
        return path

    def git(self, repo, *args, env=None, check=True):
        merged = dict(os.environ)
        merged.update(env or {})
        p = subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True, env=merged)
        if check and p.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed: {p.stderr.strip()}")
        return p.stdout.strip()

    def ago(self, hours=0, minutes=0):
        return dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours, minutes=minutes)

    def iso_of(self, when):
        return when.strftime("%Y-%m-%dT%H:%M:%SZ")

    def commit(self, repo, message, *, when=None, files=None):
        for name, text in (files or {}).items():
            target = Path(repo) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        env = {}
        if when:
            stamp = f"@{int(when.timestamp())} +0000"
            env.update({"GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp})
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-qm", message, env=env)
        return self.git(repo, "rev-parse", "HEAD")

    def foreign_commit(self, message, files):
        """A PR-head commit in the foreign clone (aged past the quiet window)."""
        return self.commit(self.foreign, message, when=self.ago(2), files=files)

    def cfg(self, **over):
        entry = {"repo": FOREIGN, "clone": str(self.foreign), "default_branch": "main",
                 "discovery": {"push": False, "pr": True}, "floor": None, "quiet_minutes": None,
                 "rank_tier": 3, "findings": "issue"}
        entry.update(over)
        return repo_registry.parse_entry(entry)

    def pr_row(self, n, head, *, base="main", draft=False):
        return {"number": n, "isDraft": draft, "baseRefName": base,
                "headRefName": f"fixture-{n}", "headRefOid": head}

    def pr_view(self, n, head, *, base="main", draft=False):
        return {"number": n, "state": "OPEN", "isDraft": draft, "headRefName": f"fixture-{n}",
                "headRefOid": head, "baseRefName": base, "updatedAt": self.iso_of(self.ago(2)),
                "mergeCommit": None, "mergedAt": None}

    def fake_gh(self, *, opened=None, view=None):
        """gh_json fake keyed on (subcommand, repo); anything else fails the test."""
        def side_effect(args, **kw):
            repo = args[args.index("--repo") + 1] if "--repo" in args else None
            if args[1] == "list" and repo == FOREIGN:
                return opened if opened is not None else []
            if args[1] == "view" and repo == FOREIGN:
                return view
            if args[1] == "list" and repo == crq.REPO:
                return []  # the primary repo's own enrollment sees no open PRs
            raise AssertionError(f"unmocked forge call in offline fixture: {args}")
        return mock.patch.object(crq, "gh_json", side_effect=side_effect)

    def enroll(self, opened, dry=False):
        with self.fake_gh(opened=opened):
            return pr_enroll.enroll(crq, self.q, dry)

    def fake_spawn(self):
        real_popen = subprocess.Popen

        def fake_child(argv, *args, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, *args, **kw)

        return mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child)

    def launch(self, item, plan, scan_ok=True):
        with mock.patch.object(crq, "secret_scan", return_value=(scan_ok, {"denylist_hits": [],
                                                                          "gitleaks_hits": []})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, plan)
        return wt, child, run_id

    def terminal_artifacts(self, item, events=None):
        run_id = item["run"]["run_id"]
        rdir = crq.RUNS / run_id
        (rdir / "review.ndjson").write_text("\n".join(json.dumps(e) for e in (events or [COMPLETE])))
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": "immutable-end"}))
        (rdir / "secret-scan.json").write_text("{}")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 919191, "pgid": 919191,
            "sid": 919191, "group_owner": crq.author_quota.GROUP_OWNER_MARKER, "cli_pid": 919192}))
        return rdir

    def scan_result(self, item):
        return json.loads((crq.RUNS / item["run"]["run_id"] / "secret-scan.json").read_text())

    def tick(self):
        """A real tick with only the vendor/process boundary faked; returns the
        detached-review spawns and the secret_scan mock for assertions."""
        real_popen = subprocess.Popen

        def fake_child(argv, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, **kw)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(crq, "discover_merged", return_value=[]))
            for name in ("write_status", "write_heartbeat", "notify_owner"):
                stack.enter_context(mock.patch.object(crq, name))
            stack.enter_context(mock.patch.object(crq, "running_agents", return_value=[]))
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs"))
            stack.enter_context(mock.patch.object(crq, "make_worktree",
                                                  return_value=(self.root / "wt", "fixture")))
            scan = stack.enter_context(mock.patch.object(
                crq, "secret_scan", return_value=(True, {"denylist_hits": [], "gitleaks_hits": []})))
            child = stack.enter_context(mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child))
            crq.with_lock(crq.tick, dry=False, only=None)
            spawns = sum(call.args[0][0] == sys.executable and "_review" in call.args[0]
                         for call in child.call_args_list)
        return spawns, scan

    # ------------------------------------------------------------- tests

    def test_open_pr_enrollment_target_chain_and_drafts(self):
        h5 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        rows = [self.pr_row(5, h5),
                self.pr_row(6, self.base, base="other-branch"),
                self.pr_row(7, h5, draft=True)]
        log = self.enroll(rows)
        item = next(i for i in self.q["items"] if i["id"] == "infra-pr5")
        self.assertEqual(item["repo"], FOREIGN)
        self.assertEqual(item["pr"], 5)
        self.assertEqual(item["kind"], "open")
        self.assertEqual(item["tier"], 1)
        self.assertEqual(item["prior_cycles"], 0)
        self.assertEqual(item["state"], "pending")
        self.assertEqual(crq.item_repo(item), FOREIGN)
        # A PR targeting another branch is logged and skipped; drafts skip quietly.
        self.assertTrue(any("PR #6 targets other-branch, not main" in line for line in log), log)
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])
        # Re-enrollment is idempotent (ids are sticky).
        self.enroll(rows)
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])

    def test_delta_evidence_after_a_captured_cycle(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        pin = self.git(self.foreign, "merge-base", "origin/main", h1)
        item["state"] = "done"
        item["cycles"] = [{"run_id": "run-1", "cycle": 1, "base": pin, "head": h1, "pr_head": h1,
                           "dirty_diff": "clean tree", "range_policy": "full-range-once-v1",
                           "completed_at": crq.iso()}]
        # An unchanged head with equivalent captured evidence enrolls nothing.
        log = self.enroll([self.pr_row(5, h1)])
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])
        self.assertTrue(all("enrolled" not in line for line in log), log)
        # A new head owes exactly one delta item with the repo-prefixed range id.
        h2 = self.foreign_commit("more pr work", {"a.txt": "a\nb\n"})
        self.enroll([self.pr_row(5, h2)])
        delta = next(i for i in self.q["items"] if i["kind"] == "delta")
        self.assertEqual(delta["id"], f"infra-pr5-range-{pin[:10]}-{h2[:10]}")
        self.assertEqual(delta["repo"], FOREIGN)
        self.assertEqual(delta["followup"], "open")
        self.assertEqual(delta["state"], "pending")

    def test_plan_computes_the_merge_base_in_the_repo_clone(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, h1), False)
        # The primary clone lacks these commits entirely: only the repo's own
        # clone can produce this pin.
        self.assertEqual(plan["base"], self.base)
        self.assertEqual(plan["target"], "origin/main")
        self.assertEqual(plan["head"], h1)
        self.assertEqual(plan["range_policy"], "full-range-once-v1")
        self.assertEqual(item["pinned_base"], self.base)
        self.assertEqual(item["target_ref"], "origin/main")
        # The delta plan runs in the same clone. A delta only enrolls once the
        # owed open review is terminal (a pending open item re-plans instead).
        item["state"] = "done"
        h2 = self.foreign_commit("more pr work", {"a.txt": "a\nb\n"})
        self.enroll([self.pr_row(5, h2)])
        delta = next(i for i in self.q["items"] if i["kind"] == "delta")
        dplan = crq.plan_delta(delta, self.pr_view(5, h2), False)
        self.assertEqual(dplan["base"], self.base)
        self.assertEqual(dplan["target"], "origin/main")
        self.assertEqual(dplan["head"], h2)

    def test_foreign_open_scan_fleet_prose_does_not_block(self):
        prose = self.foreign_commit("fleet prose", {"notes.md": _FLEET_PROSE})
        self.enroll([self.pr_row(5, prose)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, prose), False)
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn():
            crq.launch(self.q, item, plan)
        self.assertEqual(item["state"], "reviewing")
        wt.assert_called_once()  # the worktree was cut from the repo clone path
        scan = self.scan_result(item)
        # Only the four universal secret-shape classes ran over the PR range:
        # publish vocabulary is primary-only, so fleet prose is clean.
        self.assertEqual(scan["denylist_rules"], 4)
        self.assertEqual(scan["denylist_hits"], [])

    def test_foreign_open_scan_inline_secret_blocks(self):
        leak = self.foreign_commit("leaked value", {"deploy.sh": "password = supersecretvalue\n"})
        self.enroll([self.pr_row(5, leak)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, leak), False)
        with mock.patch.object(crq.shutil, "which", return_value=None):
            run_id = crq.launch(self.q, item, plan)  # a blocked launch never reaches worktree/spawn
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:inline-secret-assignments"])

    @staticmethod
    def spawns_of(child):
        return [c for c in child.call_args_list
                if c.args and c.args[0] and c.args[0][0] == sys.executable and "_review" in c.args[0]]

    def test_counted_foreign_open_harvest_files_issue_without_coverage_or_repair(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, h1), False)
        self.launch(item, plan)
        self.assertEqual(item["state"], "reviewing")
        finding = {"type": "finding", "severity": "major", "fileName": "a.txt", "comment": "fix this"}
        self.terminal_artifacts(item, [finding, COMPLETE])
        filed = {"issue_url": f"https://github.com/{FOREIGN}/issues/3", "issue_number": 3, "created": True}
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue") as repair, \
             mock.patch.object(crq.coverage, "record_review") as record, \
             mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            result = crq.harvest_review(self.q, item, False)
        # NO cq coverage and NO repair enqueue for a foreign open review.
        repair.assert_not_called()
        record.assert_not_called()
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["cycles"]), 1)
        cycle = item["cycles"][0]
        self.assertEqual((cycle["base"], cycle["head"]), (self.base, h1))
        self.assertEqual(cycle["range_policy"], "full-range-once-v1")
        # Debt only at harvest: the bounded post-harvest pass performs the upload.
        self.assertEqual(item["issue_request"]["base"], self.base)
        self.assertEqual(item["issue_request"]["head"], h1)
        self.assertTrue(item["issue_pending"])
        self.assertNotIn("issue", item)
        self.assertEqual(file_issue.call_args, None)
        self.assertEqual(result, f"{item['id']}: completed (1 findings)")
        crq.save_queue(self.q)
        with self.fake_gh(), \
             mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.tick()
            item = crq.load_queue()["items"][0]
        self.assertEqual(item["issue"], filed)
        self.assertFalse(item["issue_pending"])
        file_issue.assert_called_once()
        self.assertIn("issue_attempt_at", item)
        self.assertEqual(file_issue.call_args.kwargs["base"], self.base)
        self.assertEqual(file_issue.call_args.kwargs["head"], h1)
        self.assertEqual(file_issue.call_args.kwargs["meta"]["repo"], FOREIGN)
        self.assertEqual(file_issue.call_args.kwargs["meta"]["base"], self.base)
        remove.assert_called_once()
        self.assertEqual(remove.call_args.kwargs["clone"], Path(self.foreign))

    def test_pr_heads_are_fetched_before_local_reads(self):
        # The quiet window reads the head locally before planning, so every
        # enrollable PR's head must be fetched first, even on first enrollment.
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        calls = mock.Mock()
        with mock.patch.object(crq, "fetch") as fetch, \
             mock.patch.object(crq, "ensure_commit", return_value=True) as ensure, \
             mock.patch.object(crq, "git", wraps=crq.git) as git:
            calls.attach_mock(fetch, "fetch")
            calls.attach_mock(ensure, "ensure")
            calls.attach_mock(git, "git")
            self.enroll([self.pr_row(5, h1)])
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs["clone"], Path(self.foreign))
        self.assertIn("refs/heads/main", fetch.call_args.kwargs["refspec"])
        ensure.assert_called_once()
        self.assertEqual(ensure.call_args.args[:2], (5, h1))
        self.assertEqual(ensure.call_args.kwargs["clone"], Path(self.foreign))
        self.assertEqual(calls.mock_calls, [
            mock.call.fetch(clone=Path(self.foreign),
                            refspec="+refs/heads/main:refs/remotes/origin/main"),
            mock.call.ensure(5, h1, clone=Path(self.foreign)),
            mock.call.git("merge-base", "origin/main", h1, cwd=Path(self.foreign)),
        ])

    def test_legacy_issue_request_without_range_falls_back_to_the_subject(self):
        (self.root / "findings.md").write_text("- finding\n")
        item = {"id": "push-infra-legacy", "repo": FOREIGN, "kind": "push-current",
                "state": "done", "issue_pending": True,
                "subject": {"type": "push-range", "repo": FOREIGN, "base": "b" * 40, "head": "h" * 40},
                "issue_request": {"run_id": "r-legacy", "severity_counts": {"major": 1},
                                  "findings_md": str(self.root / "findings.md")}}
        filed = {"issue_url": f"https://github.com/{FOREIGN}/issues/9",
                 "issue_number": 9, "created": True}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.assertEqual(crq._deliver_push_findings(self.q, item), "findings issue #9 (created)")
        self.assertEqual(file_issue.call_args.kwargs["base"], "b" * 40)
        self.assertEqual(file_issue.call_args.kwargs["head"], "h" * 40)

    def test_primary_enrollment_reads_only_primary_items(self):
        self.repos[0] = self.cfg()
        foreign_cycle = {"run_id": "foreign", "head": "f" * 40,
                         "completed_at": "2026-11-02T00:00:00Z"}
        self.q["items"].append({"id": "infra-pr7", "repo": FOREIGN, "kind": "open", "pr": 7,
                                "state": "done", "cycles": [foreign_cycle]})
        self.assertIsNone(crq.last_reviewed(self.q, 7))
        primary_cycle = {"run_id": "primary", "head": "a" * 40,
                         "completed_at": "2026-11-01T00:00:00Z"}
        self.q["items"].append({"id": "pr7", "kind": "open", "pr": 7,
                                "state": "done", "cycles": [primary_cycle]})
        self.assertEqual(crq.last_reviewed(self.q, 7), primary_cycle)

    def test_repair_enqueue_rejects_foreign_items_before_reading_findings(self):
        for kind in ("open", "delta", "push-current"):
            with self.subTest(kind=kind):
                item = {"id": "infra-pr7", "repo": FOREIGN, "kind": kind, "pr": 7}
                q = {"items": [item]}
                with mock.patch.object(crq.repair_tick, "findings") as findings, \
                     mock.patch.object(crq.repair_tick, "atomic") as atomic, \
                     mock.patch.object(crq, "git") as git:
                    self.assertFalse(crq.repair_tick.enqueue(crq, q, item, {}, self.root))
                findings.assert_not_called()
                atomic.assert_not_called()
                git.assert_not_called()
                self.assertEqual(item, {"id": "infra-pr7", "repo": FOREIGN, "kind": kind, "pr": 7})
                self.assertFalse((crq.STATE / "repair").exists())

    def test_legacy_repair_backfill_ignores_foreign_cycles(self):
        q = {"items": [{"id": "push-infra-legacy", "repo": FOREIGN, "kind": "push-current",
                        "cycles": [{"run_id": "run-missing", "findings": 1}]}]}
        crq.repair_tick.backfill(crq, q)
        self.assertEqual(q.get("legacy_repair_missing"), [])
        self.assertTrue(q.get("legacy_repair_backfilled"))

    def test_primary_enrollment_unchanged_without_pr_repos(self):
        # An empty repos list (or no pr flag) keeps pr enrollment a no-op:
        # no forge read, no items, no log.
        with mock.patch.object(crq, "REPOS", []), \
             mock.patch.object(crq, "gh_json", side_effect=AssertionError("no forge call")) as gh:
            self.assertEqual(pr_enroll.enroll(crq, self.q, False), [])
        gh.assert_not_called()
        self.assertEqual(self.q["items"], [])
        self.repos[0] = self.cfg(discovery={"push": False, "pr": False})
        with mock.patch.object(crq, "gh_json", side_effect=AssertionError("no forge call")) as gh:
            self.assertEqual(pr_enroll.enroll(crq, self.q, False), [])
        gh.assert_not_called()
        # The primary repo's own enrollment keeps its exact item ids and shape.
        head = self.git(self.repo, "rev-parse", "HEAD")
        opened = [{"number": 42, "isDraft": False, "baseRefName": "main",
                   "headRefName": "fixture-42", "headRefOid": head}]
        with mock.patch.object(crq, "gh_json", return_value=opened):
            log = crq.enroll(self.q, False)
        item = self.q["items"][0]
        self.assertEqual(item["id"], "pr42")
        self.assertEqual(item["kind"], "open")
        self.assertEqual(item["tier"], 1)
        self.assertEqual(item["prior_cycles"], 0)
        self.assertNotIn("repo", item)
        self.assertEqual(crq.item_repo(item), PRIMARY)
        self.assertIn("enrolled pr42 (open PR not yet enrolled)", "\n".join(log))

    def test_foreign_open_item_ranks_at_repo_tier(self):
        primary_open = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "order": 2}
        foreign_open = {"id": "infra-pr1", "pr": 1, "kind": "open", "repo": FOREIGN,
                        "state": "pending", "order": 3}
        self.assertEqual(crq.rank(primary_open), 0)
        self.assertEqual(crq.rank(foreign_open), 3)
        self.assertEqual([i["id"] for i in sorted([foreign_open, primary_open], key=crq.sort_key)],
                         ["pr1", "infra-pr1"])

    def test_tick_enrolls_and_launches_a_foreign_open_review(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        with self.fake_gh(opened=[self.pr_row(5, h1)], view=self.pr_view(5, h1)):
            spawns, scan = self.tick()
        self.assertEqual(spawns, 1)
        self.q = crq.load_queue()
        item = next(i for i in self.q["items"] if i["id"] == "infra-pr5")
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(item["repo"], FOREIGN)
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["repo"], FOREIGN)
        self.assertEqual(meta["base"], self.base)
        self.assertEqual(meta["head"], h1)
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["range_policy"], "full-range-once-v1")
        # The launch scan ran with the universal class set in the repo's clone
        # (quiet_reason's head read ran there too, or the launch would not exist).
        scan.assert_called_once()
        self.assertEqual(scan.call_args.kwargs["clone"], Path(self.foreign))
        self.assertEqual(scan.call_args.kwargs["classes"], crq.UNIVERSAL_SCAN_CLASSES)


if __name__ == "__main__":
    unittest.main()
