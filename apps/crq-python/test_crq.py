"""Offline Q1 integration: real temporary Git; fake forge/provider/processes."""
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
                      ["--name-status", "-M50%", "-z"],
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


class OfflineBoundaryTest(unittest.TestCase):
    def test_process_capabilities_refused_before_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock()
            boundary = offline_git_boundary(launcher, repo, [])
            callback = mock.Mock()
            forbidden = [{"preexec_fn": callback}, {"pass_fds": (3,)},
                         {"executable": "/bin/sh"}, {"shell": True},
                         {"user": 0}, {"group": 0}, {"extra_groups": []},
                         {"start_new_session": True}, {"process_group": 0},
                         {"umask": 0}, {"unknown_option": None},
                         {"close_fds": False}, {"stdout": 123},
                         {"text": "yes"}, {"env": {"X": object()}}]
            for options in forbidden:
                with self.subTest(option=next(iter(options))):
                    with self.assertRaises(AssertionError):
                        boundary(["git", "rev-parse", "HEAD"], cwd=repo, **options)
            launcher.assert_not_called()
            callback.assert_not_called()

    def test_ordinary_runner_shape_reaches_only_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            (repo / ".git").mkdir()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, repo, [])
            child = boundary(["git", "rev-parse", "HEAD"], cwd=str(repo), env=None,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertIs(child, mock.sentinel.child)
            launcher.assert_called_once()
            argv = launcher.call_args.args[0]
            options = launcher.call_args.kwargs
            self.assertEqual(argv[0], "/usr/bin/git")
            self.assertEqual(argv[-2:], ["rev-parse", "HEAD"])
            self.assertEqual(set(options), {"cwd", "env", "close_fds", "stdin", "stdout", "stderr", "text"})
            self.assertEqual(options["cwd"], str(repo))
            self.assertIs(options["close_fds"], True)
            self.assertEqual(options["env"]["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_private_index_registration_controls_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").mkdir()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, root, [])
            outside = root / "outside-index"
            outside.write_bytes(b"fixture")
            def denied(value):
                launcher.reset_mock()
                with self.assertRaises(AssertionError):
                    boundary(["git", "read-tree", "HEAD"], cwd=repo,
                             env={"GIT_INDEX_FILE": value})
                launcher.assert_not_called()
            denied(str(outside))
            denied("index")
            denied("")
            with offline_index_directory(repo, root) as directory:
                index = Path(directory) / "index"
                denied(str(index.parent / ".." / index.parent.name / "index"))
                for existing in (False, True):
                    if existing:
                        index.write_bytes(b"fixture")
                    launcher.reset_mock()
                    child = boundary(["git", "read-tree", "HEAD"], cwd=repo,
                                     env={"GIT_INDEX_FILE": str(index)})
                    self.assertIs(child, mock.sentinel.child)
                    launcher.assert_called_once()
                    self.assertEqual(launcher.call_args.kwargs["env"]["GIT_INDEX_FILE"], str(index))
                index.unlink()
                index.symlink_to(outside)
                denied(str(index))
                index.unlink()
                alias = root / "index-parent-alias"
                alias.symlink_to(index.parent, target_is_directory=True)
                denied(str(alias / "index"))
                alias.unlink()
                os.link(outside, index)
                denied(str(index))
                index.unlink()
                index.mkdir()
                denied(str(index))
                index.rmdir()
                lock = index.with_name("index.lock")
                lock.write_bytes(b"fixture")
                denied(str(index))
                lock.unlink()
                other = root / "other-repo"
                other.mkdir()
                (other / ".git").mkdir()
                OFFLINE_REPOS.add(other)
                try:
                    launcher.reset_mock()
                    with self.assertRaises(AssertionError):
                        boundary(["git", "read-tree", "HEAD"], cwd=other,
                                 env={"GIT_INDEX_FILE": str(index)})
                    launcher.assert_not_called()
                finally:
                    OFFLINE_REPOS.discard(other)
                saved_parent = root / "saved-index-parent"
                index.parent.rename(saved_parent)
                try:
                    index.parent.mkdir()
                    denied(str(index))  # Same name, different parent inode: refuse.
                    index.parent.rmdir()
                finally:
                    if index.parent.exists():
                        index.parent.rmdir()
                    saved_parent.rename(index.parent)
                # Exact registered parent is now missing; never recreate on launch.
                index.parent.rmdir()
                denied(str(index))
            self.assertNotIn(index, OFFLINE_INDEXES)
            denied(str(index))
            with self.assertRaisesRegex(RuntimeError, "fixture unwind"):
                with offline_index_directory(repo, root) as directory:
                    retired = Path(directory) / "index"
                    raise RuntimeError("fixture unwind")
            self.assertNotIn(retired, OFFLINE_INDEXES)
            self.assertFalse(retired.parent.exists())
            denied(str(retired))

    def test_default_index_and_ambient_env_are_confined(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, repo, [])
            def denied():
                launcher.reset_mock()
                with self.assertRaises(AssertionError):
                    boundary(["git", "add", "."], cwd=repo)
                launcher.assert_not_called()
            denied()  # Missing parent, not merely missing index.
            boundary(["git", "init", "-q"], cwd=repo)  # Captured MOCK only.
            (repo / ".git").mkdir()
            outside = repo / "outside-index"
            outside.write_bytes(b"fixture")
            with mock.patch.dict(os.environ, {"GIT_INDEX_FILE": str(outside)}):
                for options in ({}, {"env": None}, {"env": {}}):
                    launcher.reset_mock()
                    boundary(["git", "add", "."], cwd=repo, **options)
                    launcher.assert_called_once()
                    self.assertNotIn("GIT_INDEX_FILE", launcher.call_args.kwargs["env"])
            index = repo / ".git" / "index"
            index.symlink_to(outside)
            denied()
            index.unlink()
            os.link(outside, index)
            denied()
            index.unlink()
            (repo / ".git").rmdir()
            (repo / ".git").symlink_to(repo, target_is_directory=True)
            denied()


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
                self.assertEqual(cls["wait_seconds"], 120)
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
            stack.enter_context(mock.patch.object(crq, "promotion_mode", return_value="user"))
            if not discovery:
                stack.enter_context(mock.patch.object(crq, "discover_merged", return_value=[]))
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
             mock.patch.object(crq, "discover_merged", return_value=[]), \
             mock.patch.object(crq, "write_status"), mock.patch.object(crq, "write_heartbeat"), \
             mock.patch.object(crq, "promotion_mode", return_value="user"), \
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


    def forge_inventory(self, count=125):
        def forge(args):
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


    def test_natural_discovery_overlap_watermark_and_dry_selective_gating(self):
        actual = self.forge_inventory()
        self.q["created_at"] = "2026-10-01T00:00:00Z"
        crq.save_queue(self.q)
        with mock.patch.object(crq, "gh_json", side_effect=actual),              mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("wait")):
            self.tick(dry=True, discovery=True)
            self.tick(only="selection", discovery=True)
            self.assertNotIn("merged_watermark", crq.load_queue())
            self.tick(discovery=True)
        q = crq.load_queue()
        watermark = q["merged_watermark"]
        self.assertEqual(q["merged_reconcile"]["represented"], 125)
        self.assertEqual(q["merged_discovery"]["before"], watermark)
        # Advancing an interval replays 5 minutes; request bindings dedupe.
        with mock.patch.object(crq, "gh_json", side_effect=actual),              mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("wait")):
            self.tick(discovery=True)
        q = crq.load_queue()
        self.assertEqual(q["merged_reconcile"]["after"],
                         crq.iso(crq.parse_iso(watermark) - crq.dt.timedelta(minutes=5)))
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


    def test_once_per_range_preserves_restacked_cycles_and_refuses_same_head_shortcut(self):
        info = {"state": "OPEN", "isDraft": False, "headRefOid": self.merge,
                "baseRefName": "merge-queue", "headRefName": "fixture"}
        item = {"pr": 42, "cycles": [{"run_id": "legacy", "base": self.pre, "head": self.merge,
                                    "findings": 2}], "prior_cycles": 1, "pinned_base": self.pre}
        saved = copy.deepcopy(item["cycles"])
        plan = crq.plan_open(item, info, False)
        self.assertEqual(item["cycles"], saved)
        self.assertEqual(plan["label"], "one review of captured range")
        # Same-head legacy credit has no scope policy; full review is still owed.
        self.assertEqual(crq.plan_delta(item, info, False)["base"], self.merge)
        item["cycles"].append({"run_id": "proven", "base": self.merge, "head": self.merge,
                              "dirty_diff": "clean tree", "range_policy": "full-range-once-v1"})
        with self.assertRaises(crq.NothingToReview):
            crq.plan_open(item, info, False)
        crq.advance_open(item)
        self.assertEqual(item["state"], "done")


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
        self.q["queue_client_requests"] = {f"request-{n:02}": copy.deepcopy(entry) for n in range(3)}
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
            value = actual_forge(argv[1:]) if argv[2] == "graphql" else self.forge_data()
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)
        with mock.patch.object(crq, "ForgeBudget", return_value=budget),              mock.patch.object(crq, "run", side_effect=fake_run),              mock.patch.object(crq, "prepare_current", side_effect=crq.NotReady("wait")):
            self.tick(discovery=True)
        q = crq.load_queue()
        self.assertEqual(len(calls), 5)  # ceiling + 3 numeric pages + 1 deferred read
        self.assertEqual(q["merged_reconcile"]["represented"], 125)
        self.assertEqual(q["deferred_refresh_cursor"], "request-00")
        self.assertEqual(q["queue_client_requests"]["request-01"], entry)
        self.assertEqual(q["queue_client_requests"]["request-02"], entry)


    def test_future_bound_refuses_before_forge_and_full_range_dispatch_is_committed(self):
        with mock.patch.object(crq, "gh_json") as forge:
            with self.assertRaises(crq.merged_reconcile.ReconcileRefused):
                crq.reconcile_merged(self.q, after="2026-10-01T00:00:00Z",
                                     before="2099-01-01T00:00:00Z", page_budget=1)
            forge.assert_not_called()
        self.g("update-ref", "refs/remotes/origin/merge-queue", self.pre)
        item = {"id": "open-range", "kind": "open", "pr": 42, "state": "pending", "cycles": [],
                "attempts": [], "failures": 0}
        self.q["items"].append(item)
        info = {"state": "OPEN", "isDraft": False, "headRefOid": self.merge,
                "baseRefName": "merge-queue", "headRefName": "fixture"}
        plan = crq.plan_open(item, info, False)
        guarded_popen = subprocess.Popen
        def fake_child(argv, **kwargs):
            expected = [sys.executable, str(Path(crq.__file__).resolve()), "_review",
                        (item.get("run") or {}).get("run_id")]
            if argv == expected:
                return SimpleNamespace(pid=919191)
            return guarded_popen(argv, **kwargs)
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")), \
             mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child):
            crq.launch(self.q, item, plan)
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["range_policy"], "full-range-once-v1")


    def test_range_enrollment_recovers_heads_and_isolates_unavailable_prs(self):
        opened = [{"number": n, "headRefOid": self.merge, "baseRefName": "merge-queue",
                   "headRefName": f"fixture-{n}", "isDraft": False} for n in (42, 43, 44, 45)]
        self.q["items"] = [{"id": f"pr{n}", "pr": n, "kind": "open", "state": "done",
                            "cycles": [], "order": n} for n in (42, 43, 44, 45)]
        real_git = crq.git
        reads = 0
        def merge_base(*args, **kwargs):
            nonlocal reads
            if args[0] == "merge-base":
                reads += 1
                if reads == 2:
                    raise RuntimeError("head moved after recovery")
            return real_git(*args, **kwargs)
        with mock.patch.object(crq, "gh_json", return_value=opened), \
             mock.patch.object(crq, "ensure_commit", side_effect=[False, True, True, True]) as recover, \
             mock.patch.object(crq, "git", side_effect=merge_base):
            log = crq.enroll(self.q, False)
        self.assertEqual([call.args[0] for call in recover.call_args_list], [42, 43, 44, 45])
        self.assertEqual([item["pr"] for item in self.q["items"] if item["kind"] == "delta"], [43, 45])
        self.assertEqual(sum("enrollment deferred" in line for line in log), 2)
        # Same frozen range is represented once across enrollment replay.
        with mock.patch.object(crq, "gh_json", return_value=opened[1:2]), \
             mock.patch.object(crq, "ensure_commit", return_value=True):
            crq.enroll(self.q, False)
        self.assertEqual(sum(item["kind"] == "delta" and item["pr"] == 43 for item in self.q["items"]), 1)



class DiscoveryFailureBoundaryTest(unittest.TestCase):
    """Real discovery/persistence; temporary files and counter-only tick effects."""

    AFTER = "2026-10-01T00:00:00Z"
    BEFORE = "2026-10-03T00:00:00Z"

    def patch(self, obj, name, **kwargs):
        patcher = mock.patch.object(obj, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="q2-discovery-fault-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.patch(crq, "STATE", new=self.root)
        self.patch(crq, "QUEUE", new=self.root / "queue.json")
        self.patch(crq, "now", return_value=crq.parse_iso("2026-10-03T00:00:01Z"))
        self.forge = self.patch(crq, "gh_json", side_effect=self.forge_response)
        self.reset_case()

    def reset_case(self, count=1):
        self.count = count
        self.q = {"created_at": self.AFTER, "items": [], "starts": [],
                  "merged_watermark": self.AFTER,
                  "merged_discovery": {"after": self.AFTER, "before": self.BEFORE, "complete": False}}
        key = review_receipt.digest({"repo": crq.REPO, "base": "merge-queue",
                                     "after": self.AFTER, "before": self.BEFORE})
        self.path = self.root / "reconcile" / (key + ".json")
        self.path.parent.mkdir(exist_ok=True)
        self.path.unlink(missing_ok=True)
        crq.save_queue(self.q)
        self.forge.reset_mock()

    def forge_response(self, args):
        self.assertEqual(args[:3], ["api", "graphql", "-f"])
        self.assertEqual(len(args), 4)
        self.assertTrue(args[3].startswith("query="))
        repository = {"id": "fixture-repository", "nameWithOwner": crq.REPO}
        if "issues(last:" in args[3]:
            repository.update(issues={"totalCount": 0, "nodes": []},
                              pullRequests={"totalCount": self.count, "nodes": [{"number": self.count}]})
        else:
            numbers = re.findall(r"issueOrPullRequest\(number:(\d+)\)", args[3])
            self.assertTrue(numbers)
            for value in numbers:
                repository["n" + value] = {"__typename": "PullRequest", "number": int(value),
                    "baseRefName": "merge-queue", "mergedAt": "2026-10-02T00:00:00Z",
                    "mergeCommit": {"oid": "a" * 40}, "headRefOid": "b" * 40}
        return {"data": {"repository": repository}}

    def wrapper(self, checkpoint=None):
        value = {"source": {"version": 1, "method": "all-number-slots-v1", "repo": crq.REPO,
            "base": "merge-queue", "repository_id": "fixture-repository", "ceiling": self.count,
            "window": crq.merged_reconcile.NUMBER_WINDOW}, "checkpoint": checkpoint}
        value["digest"] = review_receipt.digest(value)
        return value

    def put_wrapper(self, value):
        self.path.write_text(json.dumps(value))

    def manual(self, q=None, budget=4):
        return crq.reconcile_merged(self.q if q is None else q, after=self.AFTER,
                                    before=self.BEFORE, page_budget=budget)

    def discover(self, q=None):
        return crq.discover_merged(self.q if q is None else q, crq.ForgeBudget())

    @contextlib.contextmanager
    def fault(self, *, stage=None, wrapper_write=None, post=False):
        """Raise before install or after a real isolated atomic replacement."""
        atomic = crq.repair_tick.atomic
        save = crq._save_discovery_queue
        events = []
        current = [None]
        wrapper_count = [0]
        failed = [False]

        def save_stage(q, name):
            current[0] = name
            return save(q, name)

        def write(path, value):
            self.assertFalse(failed[0], "write after uncertain durability")
            if path == self.path:
                wrapper_count[0] += 1
            target = ((path == crq.QUEUE and current[0] == stage and stage is not None) or
                      (path == self.path and wrapper_count[0] == wrapper_write))
            events.append((str(path), current[0], copy.deepcopy(value), target))
            if target:
                if post:
                    atomic(path, value)
                failed[0] = True
                raise OSError("fixture storage fault")
            return atomic(path, value)

        with mock.patch.object(crq, "_save_discovery_queue", side_effect=save_stage), \
                mock.patch.object(crq.repair_tick, "atomic", side_effect=write):
            yield events
        self.assertTrue(failed[0], "intended storage boundary was not reached")
        self.assertTrue(events[-1][3])
        self.assertEqual(sum(event[3] for event in events), 1)

    def test_wrapper_decode_and_schema_refusal_records_debt_without_forge(self):
        malformed = [b"\xff", b"{", b"null", b"[]"]
        for field in ("source", "checkpoint"):
            value = self.wrapper()
            del value[field]
            malformed.append(json.dumps(value).encode())
        for source in (None, [], "fixture"):
            value = self.wrapper()
            value["source"] = source
            value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
            malformed.append(json.dumps(value).encode())
        for field, bad in (("version", True), ("repo", "other/repository"), ("base", "main"),
                           ("repository_id", ""), ("ceiling", False), ("window", 1)):
            value = self.wrapper()
            value["source"][field] = bad
            value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
            malformed.append(json.dumps(value).encode())
        for checkpoint in ({}, [], False, 0, "", [1], "invalid"):
            malformed.append(json.dumps(self.wrapper(checkpoint)).encode())
        value = self.wrapper()
        value["digest"] = "0" * 64
        malformed.append(json.dumps(value).encode())
        for shape, raw in enumerate(malformed):
            with self.subTest(shape=shape):
                self.reset_case()
                self.q["items"] = [{"id": "prior", "kind": "merged", "state": "done",
                                    "cycles": [{"run_id": "retained"}], "blocking": [{"id": "finding"}]}]
                self.q["merged_current_requests"] = {"retained": {"receiptId": "prior-receipt"}}
                retained = copy.deepcopy(self.q)
                self.path.write_bytes(raw)
                with mock.patch.object(crq.review_receipt, "enroll") as enroll:
                    for _ in range(2):
                        self.assertIn("incomplete", self.discover()[0])
                        self.assertEqual(self.path.read_bytes(), raw)
                        self.assertEqual(self.q["items"], retained["items"])
                        self.assertEqual(self.q["merged_current_requests"], retained["merged_current_requests"])
                        self.assertEqual(self.q["merged_watermark"], self.AFTER)
                        self.assertFalse(self.q["merged_discovery"]["complete"])
                        self.assertTrue(crq.load_queue()["merged_discovery"]["error"])
                    enroll.assert_not_called()
                self.forge.assert_not_called()

    def test_wrapper_parser_failures_preserve_debt_and_storage_boundary(self):
        original_loads = json.loads
        reason = "wrapper-decode: invalid JSON"
        for error in (ValueError, RecursionError):
            for mode in ("manual", "discovery", "tick", "save-before", "save-after"):
                with self.subTest(error=error.__name__, mode=mode):
                    self.reset_case()
                    self.q["items"] = [{"id": "older-review", "kind": "open", "state": "reviewing",
                        "cycles": [{"run_id": "retained"}], "repair_runs": {"older-repair": {}}}]
                    self.q["merged_current_requests"] = {"retained": {"receiptId": "prior-receipt"}}
                    crq.save_queue(self.q)
                    baseline = copy.deepcopy(self.q)
                    retained_digest = review_receipt.digest(baseline)
                    sentinel = json.dumps({"fixture_parser_boundary": str(self.path),
                                           "error": error.__name__, "mode": mode})
                    self.path.write_text(sentinel)
                    encounters = []
                    order = []
                    save = crq._save_discovery_queue

                    def dispatch(*args, **kwargs):
                        text = args[0] if args else kwargs.get("s")
                        if text == sentinel:
                            encounters.append("wrapper-parse")
                            raise error("fixture parser fault")
                        return original_loads(*args, **kwargs)

                    def record(q, stage):
                        result = save(q, stage)
                        order.append(stage)
                        return result

                    rounds = 2 if mode == "discovery" else 1
                    with mock.patch.object(crq.review_receipt, "enroll") as enroll:
                        for attempt in range(rounds):
                            with mock.patch.object(crq.json, "loads", side_effect=dispatch):
                                if mode == "manual":
                                    with self.assertRaisesRegex(crq.merged_reconcile.ReconcileRefused,
                                                               "^" + reason + "$"):
                                        self.manual()
                                elif mode == "discovery":
                                    self.assertEqual(self.discover(), [
                                        "merged discovery incomplete; cursor/debt retained: " + reason])
                                elif mode == "tick":
                                    with self.tick_effects() as effects, mock.patch.object(
                                            crq, "_save_discovery_queue", side_effect=record):
                                        effects["refresh_deferred"].side_effect = (
                                            lambda *a, **k: order.append("refresh") or [])
                                        crq.tick()
                                        self.assertEqual(order[:2], ["refusal-debt-save", "refresh"])
                                        for name in ("harvest_review", "harvest", "enroll", "promotion_audit",
                                                     "promotion_tick", "read_slot_usage", "admit_available",
                                                     "write_status", "write_heartbeat"):
                                            effects[name].assert_called_once()
                                else:
                                    with self.tick_effects() as effects, self.fault(
                                            stage="refusal-debt-save", post=mode == "save-after") as events:
                                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed,
                                                                   "refusal-debt-save"):
                                            crq.tick()
                                        for effect in effects.values():
                                            effect.assert_not_called()
                                        self.assertEqual(len(events), 1)
                            # Shared parser restored before persisted reloads or digest checks.
                            self.assertIs(json.loads, original_loads)
                            self.assertEqual(len(encounters), attempt + 1)
                            disk = crq.load_queue()
                            self.assertEqual(self.path.read_text(), sentinel)
                            for value in (self.q, disk):
                                for field in ("items", "merged_current_requests", "merged_watermark"):
                                    self.assertEqual(value[field], baseline[field])
                                for field in ("after", "before", "complete"):
                                    self.assertEqual(value["merged_discovery"][field],
                                                     baseline["merged_discovery"][field])
                            if mode == "manual" or mode.startswith("save-"):
                                self.assertEqual(self.q, baseline)
                                self.assertEqual(review_receipt.digest(self.q), retained_digest)
                            if mode in ("manual", "save-before"):
                                self.assertEqual(disk, baseline)
                            else:
                                self.assertEqual(disk["merged_discovery"]["error"], reason)
                            if mode.startswith("save-"):
                                self.assertEqual(disk, events[-1][2] if mode == "save-after" else baseline)
                            if mode == "discovery":
                                # Resume only from actual persisted debt, after parser restoration.
                                self.assertEqual(self.q, disk)
                                self.q = disk
                        enroll.assert_not_called()
                    self.forge.assert_not_called()

    def test_valid_complete_wrapper_validates_and_enrolls_once(self):
        first = self.manual()
        self.assertTrue(first["complete"])
        self.assertEqual(first["reviewed"], 0)
        saved = crq.load_queue()
        self.assertEqual(len(saved["items"]), 1)
        self.assertEqual(saved["items"][0]["state"], "pending")
        self.forge.reset_mock()
        self.manual(saved)
        self.assertEqual(crq.load_queue(), saved)
        self.assertEqual(len(saved["items"]), 1)
        self.forge.assert_not_called()
        # A valid digest cannot make the complete fast path skip source validation.
        value = json.loads(self.path.read_text())
        value["source"]["repo"] = "other/repository"
        value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
        self.put_wrapper(value)
        with self.assertRaises(crq.merged_reconcile.ReconcileRefused):
            self.manual(saved)

    def test_wrapper_read_io_aborts_without_mutating_caller(self):
        read = Path.read_text
        for error in (PermissionError, OSError):
            with self.subTest(error=error.__name__):
                baseline = copy.deepcopy(self.q)
                def denied(path, *args, **kwargs):
                    if path == self.path:
                        raise error("fixture read fault")
                    return read(path, *args, **kwargs)
                with mock.patch.object(Path, "read_text", new=denied), \
                        mock.patch.object(crq, "save_queue") as save:
                    with self.assertRaisesRegex(crq.DiscoveryStorageFailed, "wrapper-read"):
                        self.discover()
                    save.assert_not_called()
                self.assertEqual(self.q, baseline)
                self.forge.assert_not_called()
        # Missing wrapper is a first run, not a storage refusal.
        self.assertFalse(self.path.exists())
        self.assertTrue(self.manual()["complete"])

    def test_wrapper_save_failure_stops_before_next_fetch(self):
        for write in (1, 3):
            for post in (False, True):
                with self.subTest(write=write, post=post):
                    self.reset_case(count=51)
                    baseline = copy.deepcopy(self.q)
                    with self.fault(wrapper_write=write, post=post):
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, "wrapper-save"):
                            self.discover()
                    self.assertEqual(self.q, baseline)
                    self.assertEqual(crq.load_queue(), baseline)
                    self.assertEqual(self.forge.call_count, 1 if write == 1 else 2)
                    # Read actual remaining disk bytes on a new invocation; no rollback.
                    fresh = crq.load_queue()
                    self.assertIn("complete=True", self.discover(fresh)[0])
                    self.assertEqual(len(fresh["items"]), 51)
                    self.assertTrue(all(item["state"] == "pending" for item in fresh["items"]))

    def test_queue_write_failure_discards_memory_and_never_retries(self):
        stages = ("bounds-save", "enrollment-save", "inventory-summary-save",
                  "discovery-summary-save", "watermark-save", "refusal-debt-save")
        for stage in stages:
            for post in (False, True):
                with self.subTest(stage=stage, post=post):
                    self.reset_case(count=201 if stage == "inventory-summary-save" else 1)
                    if stage == "bounds-save":
                        self.q.pop("merged_discovery")
                        crq.save_queue(self.q)
                    if stage == "refusal-debt-save":
                        self.path.write_bytes(b"{")
                    baseline = copy.deepcopy(self.q)
                    with self.fault(stage=stage, post=post) as events:
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                            self.discover()
                    self.assertEqual(self.q, baseline)
                    attempted = events[-1][2]
                    disk = crq.load_queue()
                    self.assertEqual(disk, attempted if post else
                        (events[-2][2] if len(events) > 1 and events[-2][0] == str(crq.QUEUE) else baseline))
                    self.assertTrue(all(item["state"] == "pending" for item in disk["items"]))
                    self.assertFalse(any(item.get("cycles") for item in disk["items"]))
                    if stage != "watermark-save" or not post:
                        self.assertEqual(disk["merged_watermark"], self.AFTER)
                    # Restart from disk, never from the discarded private view.
                    self.discover(disk)
                    self.assertFalse(any(item.get("cycles") for item in disk["items"]))

    @contextlib.contextmanager
    def tick_effects(self):
        """Every external continuation seam is counter-only; discovery stays real."""
        with contextlib.ExitStack() as stack:
            effects = {}
            def counter(obj, name, result=None):
                effects[name] = stack.enter_context(mock.patch.object(obj, name, return_value=result))
            counter(crq, "load_queue", self.q)
            counter(crq, "fetch")
            counter(crq, "promotion_mode", "user")
            for name in ("harvest_signer", "harvest_review", "apply_signer_backoff", "refresh_slot_deadline",
                         "write_status", "write_heartbeat", "event", "notify_owner"):
                counter(crq, name)
            for name in ("enroll", "promotion_audit", "promotion_tick"):
                counter(crq, name, [])
            for name in ("harvest", "backfill", "archive_legacy", "reconcile_fix_prs"):
                counter(crq.repair_tick, name, [])
            counter(crq.deferred_refresh, "refresh_deferred", [])
            counter(crq, "read_slot_usage", (None, []))
            counter(crq, "admit_available", (False, "fixture-control-flow", 0))
            counter(crq.coverage, "record_opportunity", {})
            yield {k: v for k, v in effects.items() if k not in ("load_queue", "fetch")}

    def test_storage_failure_aborts_tick_before_follow_on_effects(self):
        for stage in ("bounds-save", "refusal-debt-save"):
            self.reset_case()
            if stage == "bounds-save":
                self.q.pop("merged_discovery")
            else:
                self.path.write_bytes(b"{")
            baseline = copy.deepcopy(self.q)
            with self.tick_effects() as effects, self.fault(stage=stage):
                with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                    crq.tick()
                for effect in effects.values():
                    effect.assert_not_called()
            self.assertEqual(self.q, baseline)

    def test_decode_refusal_allows_existing_tick_work_after_debt_commit(self):
        self.q["items"] = [{"id": "older-review", "kind": "open", "state": "reviewing",
                            "repair_runs": {"older-repair": {}}}]
        self.path.write_bytes(b"{")
        order = []
        save = crq._save_discovery_queue
        def record(q, stage):
            result = save(q, stage)
            order.append(stage)
            return result
        with self.tick_effects() as effects, \
                mock.patch.object(crq, "_save_discovery_queue", side_effect=record):
            effects["refresh_deferred"].side_effect = lambda *a, **k: order.append("refresh") or []
            crq.tick()
            self.assertEqual(order[:2], ["refusal-debt-save", "refresh"])
            for name in ("harvest_review", "harvest", "enroll", "promotion_audit", "promotion_tick",
                         "read_slot_usage", "admit_available", "write_status", "write_heartbeat"):
                effects[name].assert_called_once()
        self.assertEqual(crq.load_queue()["merged_watermark"], self.AFTER)
        self.assertEqual(self.path.read_bytes(), b"{")
        self.forge.assert_not_called()

    def test_incomplete_and_manual_calls_never_publish_failed_save(self):
        for stage, count in (("inventory-summary-save", 201), ("enrollment-save", 1)):
            for post in (False, True):
                with self.subTest(stage=stage, post=post):
                    self.reset_case(count=count)
                    baseline = copy.deepcopy(self.q)
                    with self.fault(stage=stage, post=post):
                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed, stage):
                            self.manual()
                    self.assertEqual(self.q, baseline)


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
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
        for name, value in (
                ("load_queue", lambda: self.q), ("fetch", mock.Mock()),
                ("gh_json", mock.Mock(side_effect=AssertionError("unmocked forge in admission fixture"))),
                ("enroll", lambda q, dry: []), ("discover_merged", lambda q, budget: []),
                ("promotion_audit", lambda q, dry: []),
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
        later_at = "2026-10-30T13:00:00Z"
        item["attempts"].append({"run_id": "after-success", "outcome": "error", "counted": False,
                                 "at": later_at, "head": "a" * 40, "base": "b" * 40})
        item.update(failures=1, state="blocked")
        crq.coverage.record_legacy_failure(q, item, later_at, "error", "after-success")
        view = crq.coverage.legacy_retry_view(q, 42, "old.py", at + dt.timedelta(days=2))
        self.assertEqual(view["failures"], 1)
        self.assertTrue(view["allowed"], view)

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
