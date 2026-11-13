"""Shared fixtures for the split offline Q1 integration suite.

Real temporary Git; fake forge/provider/processes. Every split module
imports setUpModule from here, so the fail-closed process boundary and the
failure observer are installed once per unittest module.

Split provenance: test_crq.py was split by subject into
test_crq_offline_boundary.py, test_crq_classifier.py,
test_crq_current_receipts.py, test_crq_current_classification.py,
test_crq_current_cli.py, test_crq_current_manifest.py,
test_crq_current_deferred.py, test_crq_current_discovery.py,
test_crq_current_range.py, test_crq_discovery_wrapper.py,
test_crq_discovery_storage.py, test_crq_recent_discovery.py,
test_crq_oversized_partition.py, test_crq_optional_cycle.py,
test_crq_coverage.py, test_crq_branch_target.py,
test_crq_multi_repo_identity.py and test_crq_push_dispatch.py; this module
holds the module bootstrap, the offline Git boundary and the shared mixins.
"""
import atexit
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
import re
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
import push_current
import repo_registry

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_current_test", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)
COMPLETE = {"type": "complete", "status": "review_completed", "reviewedFiles": ["affected.py"]}


# Registered by CurrentTest before its first Git invocation. No other class
# needs a real process, and no selected fixture needs a real scanner.
OFFLINE_REPOS = set()
OFFLINE_INDEXES = {}


@contextlib.contextmanager
def offline_index_directory(repo, root):
    repo = Path(repo).resolve(strict=True)
    root = Path(root).resolve(strict=True)
    if repo not in OFFLINE_REPOS or repo.parent != root:
        raise AssertionError("private index fixture owner missing")
    with tempfile.TemporaryDirectory(dir=root) as td:
        parent = Path(td).resolve(strict=True)
        index = parent / "index"
        info = parent.stat()
        if index in OFFLINE_INDEXES:
            raise AssertionError("private index already registered")
        OFFLINE_INDEXES[index] = (repo, info.st_dev, info.st_ino)
        try:
            yield str(parent)
        finally:
            del OFFLINE_INDEXES[index]


_TRACE_OBSERVER_RESTORE = None


def install_failure_observer():
    """Observe framework rendering after module setup; preserve its result."""
    global _TRACE_OBSERVER_RESTORE
    if _TRACE_OBSERVER_RESTORE is not None:
        return
    result_class = unittest.result.TestResult
    original = result_class._exc_info_to_string

    def observe(result, err, test):
        rendered = original(result, err, test)
        payload = ("\nQ2_IMMEDIATE_FAILURE " + test.id() + "\n" + rendered).encode("utf-8")
        marker = b"\nQ2_IMMEDIATE_FAILURE_TRUNCATED limit=16384\n"
        if len(payload) > 16384:
            payload = payload[:16384 - len(marker)] + marker
        sys.stderr.write(payload.decode("utf-8", errors="ignore"))
        sys.stderr.flush()
        return rendered

    def restore():
        global _TRACE_OBSERVER_RESTORE
        if result_class._exc_info_to_string is observe:
            result_class._exc_info_to_string = original
        _TRACE_OBSERVER_RESTORE = None

    # Register restoration before mutation, including exceptional setup exits.
    atexit.register(restore)
    _TRACE_OBSERVER_RESTORE = restore
    result_class._exc_info_to_string = observe
    sys.stderr.write("Q2_TRACE_OBSERVER activation=end-test_crq.setUpModule "
                     "renderer=unittest.result.TestResult._exc_info_to_string\n")
    sys.stderr.flush()


def offline_git_boundary(real_popen, home, violations):
    """Build the fail-closed fixture launcher; tests inject a captured mock."""
    def refuse(stage):
        sys.stderr.write("Q2_GUARD_REFUSAL stage=" + stage + "\n")
        sys.stderr.flush()
        violations.append("unexpected process boundary")
        raise AssertionError("unmocked process in offline fixture")

    def local_git(args):
        # Exact observed fixture/adapter shapes; no global Git options, aliases,
        # remote commands, arbitrary config, helpers or option-shaped operands.
        if not args or not all(isinstance(v, str) for v in args):
            return False
        cmd, *tail = args
        operand = lambda v: bool(v) and not v.startswith("-")
        if cmd == "init":
            return tail == ["-q"]
        if cmd == "config":
            return tail in (["user.email", "fixture@localhost"], ["user.name", "fixture"])
        if cmd == "add":
            return tail == ["."]
        if cmd == "commit":
            return len(tail) == 2 and tail[0] == "-qm" and operand(tail[1])
        if cmd == "mv":
            return len(tail) == 2 and all(operand(v) for v in tail)
        if cmd in {"rev-parse", "read-tree"}:
            return len(tail) == 1 and operand(tail[0])
        if cmd == "write-tree":
            return not tail
        if cmd == "update-ref":
            return (len(tail) == 2 and tail[0].startswith(("refs/remotes/origin/", "refs/crq/current/"))
                    and bool(re.fullmatch(r"[0-9a-f]{40}", tail[1])))
        if cmd == "merge-base":
            if tail[:1] == ["--is-ancestor"]:
                tail = tail[1:]
            return len(tail) == 2 and all(operand(v) for v in tail)
        if cmd == "cat-file":
            return len(tail) == 2 and tail[0] in {"-e", "-s", "blob"} and operand(tail[1])
        if cmd == "ls-tree":
            return len(tail) == 4 and tail[0] == "-z" and operand(tail[1]) and tail[2] == "--" and operand(tail[3])
        if cmd == "update-index":
            return len(tail) == 3 and tail[:2] == ["--force-remove", "--"] and operand(tail[2])
        if cmd == "commit-tree":
            return (len(tail) == 5 and tail[1] == "-p" and tail[3] == "-m"
                    and all(operand(tail[n]) for n in (0, 2, 4)))
        if cmd == "diff":
            shapes = (["--name-status"], ["--no-ext-diff"],
                      ["--name-only", "--no-renames", "-z"],
                      ["--raw", "--no-abbrev", "-M50%", "-z"],
                      ["--text", "--no-textconv", "--no-ext-diff", "--no-renames", "--no-color", "--unified=0"],
                      ["--no-color", "--no-ext-diff", "--unified=0"])
            return any(tail[:-2] == flags and len(tail) == len(flags) + 2
                       and all(operand(v) for v in tail[-2:]) for flags in shapes)
        return False

    def check_index_file(index):
        parent = index.parent
        if parent.resolve(strict=True) != parent or not parent.is_dir():
            refuse("index-path")
        if index.is_symlink() or (index.exists() and
                (not index.is_file() or index.stat().st_nlink != 1)):
            refuse("index-path")
        lock = index.with_name(index.name + ".lock")
        if lock.exists() or lock.is_symlink():
            refuse("index-path")
        return parent.stat()

    def offline_process(argv, *args, **kwargs):
        if (not isinstance(argv, (list, tuple)) or not argv or
                argv[0] not in {"git", "/usr/bin/git"} or args or
                not local_git(list(argv[1:]))):
            refuse("process-or-git-shape")
        # Validate names AND values before the captured launcher sees anything.
        # Construct its kwargs explicitly below: never forward caller kwargs.
        validators = {
            "cwd": lambda v: type(v) in (str, Path, type(home)),
            "env": lambda v: v is None or (type(v) is dict and
                all(type(k) is str and type(value) is str for k, value in v.items())),
            "stdin": lambda v: v is None or (type(v) is int and v in (subprocess.PIPE, subprocess.DEVNULL)),
            "stdout": lambda v: v is None or (type(v) is int and v in (subprocess.PIPE, subprocess.DEVNULL)),
            "stderr": lambda v: v is None or (type(v) is int and v in (subprocess.PIPE, subprocess.DEVNULL)),
            "text": lambda v: type(v) is bool,
            "universal_newlines": lambda v: type(v) is bool,
            "close_fds": lambda v: v is True,
            "shell": lambda v: v is False,
            "executable": lambda v: v is None,
            "preexec_fn": lambda v: v is None,
            "pass_fds": lambda v: type(v) is tuple and not v,
        }
        if any(key not in validators or not validators[key](value) for key, value in kwargs.items()):
            refuse("keyword-value")
        cwd = Path(kwargs.get("cwd") or ".").resolve()
        if cwd not in OFFLINE_REPOS:
            refuse("cwd")
        # Fresh repos use empty templates. Never inherit Git environment,
        # user/system config, hooks, signing, attributes, fsmonitor or helpers.
        incoming = kwargs.get("env") or {}
        env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "LANG": "C",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": "/dev/null",
               "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ATTR_NOSYSTEM": "1",
               "GIT_TERMINAL_PROMPT": "0", "GIT_TEMPLATE_DIR": str(home / "templates")}
        for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
                    "GIT_LITERAL_PATHSPECS"):
            if key in incoming:
                env[key] = incoming[key]
        try:
            if "GIT_INDEX_FILE" in incoming:
                raw = incoming["GIT_INDEX_FILE"]
                index = Path(raw)
                if not index.is_absolute() or str(index) != raw or ".." in index.parts:
                    refuse("index-path")
                owner = OFFLINE_INDEXES.get(index)
                if owner is None or owner[0] != cwd:
                    refuse("index-path")
                info = check_index_file(index)
                if owner[1:] != (info.st_dev, info.st_ino):
                    refuse("index-path")
                env["GIT_INDEX_FILE"] = str(index)
            else:
                gitdir = cwd / ".git"
                if not (list(argv[1:]) == ["init", "-q"] and
                        not gitdir.exists() and not gitdir.is_symlink()):
                    check_index_file(gitdir / "index")
        except (OSError, ValueError, RuntimeError):
            refuse("index-path")
        launch_kwargs = {"cwd": str(cwd), "env": env, "close_fds": True,
                         "stdin": kwargs.get("stdin"), "stdout": kwargs.get("stdout"),
                         "stderr": kwargs.get("stderr")}
        for key in ("text", "universal_newlines"):
            if key in kwargs:
                launch_kwargs[key] = kwargs[key]
        options = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                   "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never",
                   "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false"]
        if argv[1] == "diff":
            options += ["--no-pager"]
            argv = [*argv[:2], "--no-ext-diff", "--no-textconv", *argv[2:]]
        return real_popen(["/usr/bin/git", *options, *argv[1:]], **launch_kwargs)

    return offline_process


def setUpModule():
    isolation = tempfile.TemporaryDirectory(prefix="q2-offline-git-")
    unittest.addModuleCleanup(isolation.cleanup)
    home = Path(isolation.name)
    (home / "templates").mkdir()
    violations = []
    offline_process = offline_git_boundary(subprocess.Popen, home, violations)

    def assert_no_violations():
        if violations:
            raise AssertionError("offline fixture attempted an unexpected process")

    patch = mock.patch.object(subprocess, "Popen", side_effect=offline_process)
    patch.start()
    unittest.addModuleCleanup(assert_no_violations)
    unittest.addModuleCleanup(patch.stop)
    install_failure_observer()


class CurrentFixture:
    def setUp(self):
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        wake = mock.patch.object(crq, "refresh_slot_deadline")
        wake.start()
        self.addCleanup(wake.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        OFFLINE_REPOS.add(self.repo.resolve())
        self.addCleanup(OFFLINE_REPOS.discard, self.repo.resolve())
        patch = mock.patch.object(crq, "tempfile", SimpleNamespace(
            TemporaryDirectory=lambda: offline_index_directory(self.repo, self.root)))
        patch.start()
        self.addCleanup(patch.stop)
        def assert_indexes_retired():
            self.assertFalse(any(owner[0] == self.repo.resolve()
                                 for owner in OFFLINE_INDEXES.values()))
        self.addCleanup(assert_indexes_retired)
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
            if argv[0] == "gh":
                raise AssertionError("unmocked forge call in offline fixture")
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

    def tick(self, dry=False, only=None, discovery=False):
        real_popen = subprocess.Popen
        def fake_child(argv, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, **kw)
        with contextlib.ExitStack() as stack:
            if not discovery:
                stack.enter_context(mock.patch.object(crq, "discover_merged", return_value=[]))
            for name in ("fetch", "write_status", "write_heartbeat", "notify_owner"):
                stack.enter_context(mock.patch.object(crq, name))
            for name in ("enroll",):
                stack.enter_context(mock.patch.object(crq, name, return_value=[]))
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs",
                side_effect=lambda *args: self.assertIsNotNone(crq._FORGE_BUDGET) and {}))
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
            doc = self.document(item)
            if (crq.repair_tick.merged_current_enabled(crq) and doc["counted"]
                    and doc["findings"] and doc["outcome"] != "partial-scope"):
                repair.assert_called_once()
                self.assertEqual(repair.call_args.args[2]["receipt_id"], item["receipt_id"])
            else:
                repair.assert_not_called()
            return result

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
