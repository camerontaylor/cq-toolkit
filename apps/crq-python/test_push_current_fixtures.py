"""Shared fixtures for the push-discovery test modules.

Split provenance: apps/crq-python/test_push_current.py was split by subject into
test_push_current_discovery.py, test_push_current_coalescing.py,
test_push_current_prepare.py, test_push_current_scan.py,
test_push_current_scheduling.py, test_push_current_worktree.py and
test_push_current_delivery.py. This module carries only their shared fixture
surface and defines no TestCase.

Offline push-discovery integration: real temporary Git repos; fake forge/CLI.

Fixture shape follows the crq suite's current-test base class (now the
``test_crq_*`` split modules): module-global patching of the
loaded crq module, real git for both the primary fixture and the foreign
origin/clone pair, no network, and a fake coderabbit CLI version. The foreign
repo is a real clone of a local origin so discovery's refspec fetch is exercised
for real (docs/multi-repo.md push discovery).
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
spec = importlib.util.spec_from_file_location("crq_push_test_crq", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)
import push_current
import repo_registry
import review_receipt

PRIMARY = "camerontaylor/cq-toolkit"
FOREIGN = "camerontaylor/infra"
COMPLETE = {"type": "complete", "status": "review_completed", "reviewedFiles": ["f0.py"]}

# Fake denylist corpus: every UNIVERSAL_SCAN_CLASSES id plus publish classes
# and a repo extra class. denylist_rules parses this file from the primary
# clone at origin/main, so the class filtering runs for real.
#
# The publish vocabulary is itself denylisted in this tree, so fixtures spell
# it in pieces (the same convention as test/ops/review/addressWorker.test.ts).
_CERES = "ce" + "res"
_PLUTO = "pl" + "uto"
_PERSONAL = "/home/c" + "taylor"
_SSH_KEY_RULE = "-----BEGIN " + "[A-Z0-9 ]*" + "PRIVATE KEY-----"
_FLEET_PROSE = ("redeploy " + _CERES + " tonight\ncwd=" + _PERSONAL + "/tmp\n"
                + _PLUTO + ".web" + "front.app and " + "bee" + "dee" + " dashboards\n")
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
    "  - id: class:fixture-extra\n"
    "    regex: 'fixture-extra-marker'\n"
)


class PushTestBase:
    """One primary fixture (crq's own clone, carrying the denylist corpus) and
    a foreign origin+clone pair whose default branch receives pushes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.init_repo(self.root / "primary-origin")
        (self.origin / "policy" / "denylist").mkdir(parents=True)
        (self.origin / "policy" / "denylist" / "patterns.yml").write_text(DENYLIST_FIXTURE)
        self.pre = self.commit(self.origin, "denylist fixture", when=self.ago(48))
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

    def cfg(self, **over):
        entry = {"repo": FOREIGN, "clone": str(self.foreign), "default_branch": "main",
                 "discovery": {"push": True, "pr": False}, "floor": None, "quiet_minutes": None,
                 "rank_tier": 3, "findings": "issue"}
        entry.update(over)
        return repo_registry.parse_entry(entry)

    def discover(self, dry=False):
        return push_current.discover(crq, self.q, dry)

    def the_item(self):
        items = [i for i in self.q["items"] if i.get("kind") == push_current.KIND]
        self.assertEqual(len(items), 1, [i["id"] for i in self.q["items"]])
        return items[0]

    def enroll_push(self, **over):
        """Floor-init then enroll through real discovery; returns the item."""
        over.setdefault("floor", self.iso_of(self.ago(36)))
        self.repos[0] = self.cfg(**over)
        self.discover()
        self.discover()
        return self.the_item()

    def prepare(self, item):
        return push_current.prepare(crq, self.q, item, False)

    def fake_spawn(self):
        """Popen mock that only fakes the detached _review child; real Popen
        otherwise, because subprocess.run shares the same module object."""
        real_popen = subprocess.Popen

        def fake_child(argv, *args, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, *args, **kw)

        return mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child)

    @staticmethod
    def spawns(child):
        """The faked detached-review launches among all delegated Popen calls."""
        return [c for c in child.call_args_list
                if c.args and c.args[0] and c.args[0][0] == sys.executable and "_review" in c.args[0]]

    def launch(self, item, scan_ok=True):
        """Prepare and launch with the vendor boundary faked."""
        plan = self.prepare(item)
        with mock.patch.object(crq, "secret_scan_diff", return_value=(scan_ok, {"denylist_hits": [],
                                                                                "gitleaks_hits": []})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, plan)
        return plan, wt, child, run_id

    def terminal_artifacts(self, item, events=None):
        run_id = item["run"]["run_id"]
        rdir = crq.RUNS / run_id
        (rdir / "review.ndjson").write_text("\n".join(json.dumps(e) for e in (events or [COMPLETE])))
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": "immutable-end"}))
        (rdir / "secret-scan.json").write_text("{}")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 919191, "pgid": 919191,
            "sid": 919191, "group_owner": crq.author_quota.GROUP_OWNER_MARKER, "cli_pid": 919192}))
        return rdir

    def harvest(self, item, events=None):
        """Direct harvest; asserts no repair/coverage path ever runs for a push item."""
        self.terminal_artifacts(item, events)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue") as repair, \
             mock.patch.object(crq.coverage, "record_review") as record:
            result = crq.harvest_review(self.q, item, False)
        repair.assert_not_called()
        record.assert_not_called()
        return result, remove

    def tick(self):
        """A real tick with only the vendor/process boundary faked."""
        real_popen = subprocess.Popen

        def fake_child(argv, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, **kw)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(crq, "discover_merged", return_value=[]))
            for name in ("write_status", "write_heartbeat", "notify_owner"):
                stack.enter_context(mock.patch.object(crq, name))
            stack.enter_context(mock.patch.object(crq, "enroll", return_value=[]))
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs", return_value={}))
            stack.enter_context(mock.patch.object(crq, "make_worktree",
                                                  return_value=(self.root / "wt", "fixture")))
            stack.enter_context(mock.patch.object(crq, "secret_scan_diff",
                                                  return_value=(True, {"denylist_hits": [], "gitleaks_hits": []})))
            child = stack.enter_context(mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child))
            crq.with_lock(crq.tick, dry=False, only=None)
            return sum(call.args[0][0] == sys.executable and "_review" in call.args[0]
                       for call in child.call_args_list)

    def events(self):
        return [json.loads(line) for line in crq.EVENTS.read_text().splitlines() if line.strip()]

    def document(self, item):
        return json.loads((self.state / "receipts" / (item["receipt_id"] + ".json")).read_text())

    def scan_result(self, item):
        return json.loads((crq.RUNS / item["run"]["run_id"] / "secret-scan.json").read_text())
