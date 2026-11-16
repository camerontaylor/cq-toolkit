"""Shared fixtures for the pr-discovery test modules.

Split provenance: apps/crq-python/test_pr_enroll.py was split by subject into
test_pr_enroll_enrollment.py, test_pr_enroll_planning.py,
test_pr_enroll_scan.py, test_pr_enroll_harvest.py,
test_pr_enroll_primary.py and test_pr_enroll_tick.py. This module carries only
their shared fixture surface and defines no TestCase.

Offline pr-discovery integration: real temporary Git repos; fake forge/CLI.

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


class PrTestBase:
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
        detached-review spawns, secret_scan mock and tick log for assertions."""
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
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs", return_value={}))
            stack.enter_context(mock.patch.object(crq, "make_worktree",
                                                  return_value=(self.root / "wt", "fixture")))
            scan = stack.enter_context(mock.patch.object(
                crq, "secret_scan", return_value=(True, {"denylist_hits": [], "gitleaks_hits": []})))
            child = stack.enter_context(mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child))
            log = crq.with_lock(crq.tick, dry=False, only=None)
            spawns = sum(call.args[0][0] == sys.executable and "_review" in call.args[0]
                         for call in child.call_args_list)
        return spawns, scan, log

    @staticmethod
    def spawns_of(child):
        return [c for c in child.call_args_list
                if c.args and c.args[0] and c.args[0][0] == sys.executable and "_review" in c.args[0]]
