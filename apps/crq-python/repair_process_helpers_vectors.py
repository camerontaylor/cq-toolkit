#!/usr/bin/env python3
"""Deterministic offline oracle for the TS ports of the ``process()`` helpers.

Test tooling only. It runs the PRODUCTION functions and records what Python
actually does:

* ``crq_repair.failure_class_for_stop`` (``crq_repair.py:161-166``);
* the ``judge_required`` expression at ``crq_repair.py:670``, extracted from
  the production source with ``ast`` (it is inline in ``process``) and
  evaluated against a counting ``random.random``;
* ``crq_repair.bounded.validate_revalidation`` with ``bounded.git`` scripted;
* ``crq_repair.verify`` (``__init__.py:62``) against a scratch git repository;
* ``crq_repair.retain.retain`` / ``untracked_directories`` and
  ``crq_repair.retain_preserving_nested`` (``crq_repair.py:300``) against a
  scratch git repository.

Scratch repositories are built from a small declarative step list (identical
in the TS test), under a temporary directory, with a pinned git identity, pinned
commit dates and no user/system git config, so every commit SHA is
deterministic. Nothing outside the temporary directory is read or written and
no production queue, state, signer, network or host service is touched.

Recorded exceptions: the Python class name, plus the message where it is
authored by the code under test (``ValueError``, ``KeyError``,
``UnsupportedUntracked``, and the ``git <sub> failed:`` prefix of
``RuntimeError``). Messages from the interpreter itself (``TypeError``,
``AttributeError``) are pinned by class only.

``untracked.tar`` and ``commits.bundle`` digests are masked: the TS tar writer
reproduces Python's entry names, types, sizes, modes, link targets and content,
not its header bytes (PAX ``mtime`` float, ``uname``/``gname``).

Regenerate with ``python3 repair_process_helpers_vectors.py --write`` and
verify with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-process-helpers" / "cases.json"
SCHEMA = "cq.crq-process-helpers-vector/v1"
JOB = "crq-R-F1"

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Vector",
    "GIT_AUTHOR_EMAIL": "vector@example.invalid",
    "GIT_COMMITTER_NAME": "Vector",
    "GIT_COMMITTER_EMAIL": "vector@example.invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "LC_ALL": "C",
    "LANGUAGE": "C",
}


def _service():
    """Load the production repair service module, not a copy of it."""
    spec = importlib.util.spec_from_file_location("repair_process_helpers_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()
sys.path.insert(0, str(HERE))
import crq_repair  # noqa: E402  (the package, not crq_repair.py)
from crq_repair import bounded, retain as retain_mod  # noqa: E402


# ---------------------------------------------------------------------------
# failure_class_for_stop
# ---------------------------------------------------------------------------

FAILURE_REPORTS = [
    ("empty report", {}),
    ("rate-limit", {"stop": "rate-limit"}),
    ("configuration", {"stop": "configuration"}),
    ("timeout", {"stop": "timeout"}),
    ("error", {"stop": "error"}),
    ("ok", {"stop": "ok"}),
    ("blackout", {"stop": "blackout"}),
    ("stop null", {"stop": None}),
    ("case differs", {"stop": "Rate-Limit"}),
    ("padded", {"stop": "rate-limit "}),
    ("list holding the name", {"stop": ["rate-limit"]}),
    ("integer stop", {"stop": 1}),
    ("true stop", {"stop": True}),
    ("prose never consulted", {"stop": "ok", "error": "rate-limit configuration 429"}),
    ("report is None", None),
    ("report is a list", []),
    ("report is a string", "rate-limit"),
    ("report is an integer", 0),
]


def failure_cases() -> list[dict]:
    out = []
    for name, report in FAILURE_REPORTS:
        out.append({"name": name, "report": report,
                    **outcome(lambda r=report: crq_repair_failure(json.loads(json.dumps(r))))})
    return out


def crq_repair_failure(report):
    return service.failure_class_for_stop({}, {}, report)


# ---------------------------------------------------------------------------
# judge_required
# ---------------------------------------------------------------------------

def _judge_expression():
    tree = ast.parse((HERE / "crq_repair.py").read_text())
    found = [node for node in ast.walk(tree)
             if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "judge_required"
                                                      for t in node.targets)]
    assert len(found) == 1, "judge_required must be assigned exactly once in crq_repair.py"
    return compile(ast.Expression(found[0].value), "crq_repair.py:judge_required", "eval"), found[0].lineno


JUDGE_CODE, JUDGE_LINE = _judge_expression()


class CountingRandom:
    def __init__(self, value):
        self.value = value
        self.draws = 0

    def random(self):
        self.draws += 1
        return self.value


def judge_cases() -> list[dict]:
    def job(severity="minor", **extra):
        return {"job": JOB, "finding": {"severity": severity}, **extra}

    specs = [
        ("pending judge short-circuits before the job is read", {"pending_judge": {"rung": 1}}, "NOJOB", {}, 0.0),
        ("pending judge as empty dict is falsy", {"pending_judge": {}}, job(), {}, 0.9),
        ("pending judge as zero is falsy", {"pending_judge": 0}, job(), {}, 0.9),
        ("pending judge as 0.0 is falsy", {"pending_judge": 0.0}, job(), {}, 0.9),
        ("pending judge as empty string is falsy", {"pending_judge": ""}, job(), {}, 0.9),
        ("pending judge non-empty string", {"pending_judge": "x"}, job(), {}, 0.9),
        ("pending judge null", {"pending_judge": None}, job(), {}, 0.9),
        ("critical severity needs no draw", {}, job("critical"), {}, 0.0),
        ("major severity falls through to the draw", {}, job("major"), {}, 0.9),
        ("severity case differs", {}, job("Critical"), {}, 0.9),
        ("recurrence true", {}, job(recurrence=True), {}, 0.9),
        ("recurrence non-empty list", {}, job(recurrence=["a"]), {}, 0.9),
        ("recurrence empty list is falsy", {}, job(recurrence=[]), {"judge_sample_rate": 0}, 0.0),
        ("recurrence zero is falsy", {}, job(recurrence=0), {}, 0.9),
        ("recurrence float 0.0 is falsy", {}, job(recurrence=0.0), {}, 0.9),
        ("recurrence null", {}, job(recurrence=None), {}, 0.9),
        ("no rate configured: random() < 0 is never true", {}, job(), {}, 0.0),
        ("rate 1 always samples", {}, job(), {"judge_sample_rate": 1}, 0.999999),
        ("rate 0.5, draw below", {}, job(), {"judge_sample_rate": 0.5}, 0.25),
        ("rate 0.5, draw equal is not less", {}, job(), {"judge_sample_rate": 0.5}, 0.5),
        ("rate 0.5, draw above", {}, job(), {"judge_sample_rate": 0.5}, 0.75),
        ("rate True counts as 1", {}, job(), {"judge_sample_rate": True}, 0.5),
        ("rate False counts as 0", {}, job(), {"judge_sample_rate": False}, 0.0),
        ("rate huge integer", {}, job(), {"judge_sample_rate": 10**30}, 0.5),
        ("rate negative", {}, job(), {"judge_sample_rate": -1}, 0.0),
        ("rate NaN compares false", {}, job(), {"judge_sample_rate": float("nan")}, 0.0),
        ("rate +inf", {}, job(), {"judge_sample_rate": float("inf")}, 0.5),
        ("rate null raises TypeError after the draw", {}, job(), {"judge_sample_rate": None}, 0.5),
        ("rate string raises TypeError after the draw", {}, job(), {"judge_sample_rate": "0.5"}, 0.5),
        ("rate list raises TypeError after the draw", {}, job(), {"judge_sample_rate": [0.5]}, 0.5),
        ("rate dict raises TypeError after the draw", {}, job(), {"judge_sample_rate": {}}, 0.5),
        ("repair is not a dict raises AttributeError after the draw", {}, job(), "NOTDICT", 0.5),
        ("job has no finding", {}, {"job": JOB}, {}, 0.5),
        ("finding has no severity", {}, {"job": JOB, "finding": {}}, {}, 0.5),
        ("finding is a list", {}, {"job": JOB, "finding": []}, {}, 0.5),
        ("finding is a string", {}, {"job": JOB, "finding": "critical"}, {}, 0.5),
        ("finding is null", {}, {"job": JOB, "finding": None}, {}, 0.5),
        ("job is a list", {}, [], {}, 0.5),
        ("job is null", {}, None, {}, 0.5),
        ("result is not a dict", None, job(), {}, 0.5),
        ("result is a list", [], job(), {}, 0.5),
    ]
    out = []
    for name, result, jobv, repair, draw in specs:
        case = {"name": name, "rung_result": result, "job": jobv, "repair": repair, "random": draw}
        if jobv == "NOJOB":
            case["job"] = {"job": JOB}  # no finding at all
        if repair == "NOTDICT":
            case["repair"] = [1]
        rng = CountingRandom(case["random"])
        env = {"result": roundtrip(case["rung_result"]), "job": roundtrip(case["job"]),
               "repair": roundtrip(case["repair"]), "random": rng}
        out.append({**case, **outcome(lambda e=env: bool(eval(JUDGE_CODE, {}, e))), "draws": rng.draws})
    return out


# ---------------------------------------------------------------------------
# validate_revalidation
# ---------------------------------------------------------------------------

TIP = "1" * 40
BLOB = "2" * 40


def revalidation_cases() -> list[dict]:
    finding = {"id": "F1", "severity": "major", "path": "src/a.py", "title": "T"}
    digest = bounded.identity(finding)

    def old(**over):
        value = {"job": JOB, "finding": dict(finding)}
        value.update(over)
        return value

    def good(**over):
        value = {"source_sha": TIP, "finding_sha256": digest, "source_blob_sha": BLOB,
                 "verdict": "still-valid", "reviewer": "ana", "reason": "still reproduces"}
        value.update(over)
        return value

    canonical = "a" * 64
    specs = []

    def add(name, old_v, sha, evidence, script=None):
        specs.append({"name": name, "old": old_v, "source_sha": sha, "evidence": evidence,
                      "git": script if script is not None else {
                          "rev-parse origin/main": TIP, f"rev-parse {TIP}:src/a.py": BLOB}})

    add("valid evidence", old(), TIP, good())
    add("sha is not a string", old(), 7, good())
    add("sha is null", old(), None, good())
    add("sha too short", old(), TIP[:39], good())
    add("sha upper case", old(), TIP.upper(), good())
    add("sha with trailing newline", old(), TIP + "\n", good())
    add("sha with non-hex digit", old(), "g" * 40, good())
    add("tip read fails", old(), TIP, good(), {"rev-parse origin/main": {"error": "bad ref"}})
    add("tip differs", old(), TIP, good(), {"rev-parse origin/main": "3" * 40})
    add("severity critical", old(finding={**finding, "severity": "critical"}), TIP,
        good(finding_sha256=bounded.identity({**finding, "severity": "critical"})))
    add("severity minor without canonical id", old(finding={**finding, "severity": "minor"}), TIP, good())
    add("severity minor with canonical id", old(finding={**finding, "severity": "minor"},
                                                 canonical_finding_id=canonical), TIP,
        good(finding_sha256=bounded.identity({**finding, "severity": "minor"})))
    add("severity minor with short canonical id", old(finding={**finding, "severity": "minor"},
                                                       canonical_finding_id="a" * 63), TIP, good())
    add("severity minor with upper-case canonical id", old(finding={**finding, "severity": "minor"},
                                                            canonical_finding_id="A" * 64), TIP, good())
    add("severity minor with canonical id and newline", old(finding={**finding, "severity": "minor"},
                                                             canonical_finding_id=canonical + "\n"), TIP, good())
    add("severity minor with non-string canonical id", old(finding={**finding, "severity": "minor"},
                                                            canonical_finding_id=5), TIP, good())
    add("severity nit", old(finding={**finding, "severity": "nit"}), TIP, good())
    add("job has no finding", {"job": JOB}, TIP, good())
    add("finding is null", {"job": JOB, "finding": None}, TIP, good())
    add("finding is a list", {"job": JOB, "finding": []}, TIP, good())
    add("old is a list", [], TIP, good())
    add("old is null", None, TIP, good())
    for label, path in [("absolute path", "/etc/passwd"), ("parent segment", "src/../a.py"),
                        ("dot path", "."), ("dot slash", "./"), ("empty path", ""),
                        ("path with newline", "src/a\n.py"), ("path with tab", "src/a\t.py"),
                        ("path with quote", 'src/"a.py'), ("path with backslash", "src\\a.py"),
                        ("path with NUL", "src/a\x00.py"), ("path is a number", 5), ("path missing", None)]:
        f = {**finding, "path": path}
        if path is None:
            f.pop("path")
        add(label, old(finding=f), TIP, good(finding_sha256=bounded.identity(f)),
            {"rev-parse origin/main": TIP})
    for label, path, norm in [("doubled and dotted slashes", "src//./a.py", "src/a.py"),
                              ("trailing slash", "src/a.py/", "src/a.py"),
                              ("leading dot segment", "./src/a.py", "src/a.py"),
                              ("non-ASCII path", "src/é.py", "src/é.py")]:
        f = {**finding, "path": path}
        add(label, old(finding=f), TIP, good(finding_sha256=bounded.identity(f)),
            {"rev-parse origin/main": TIP, f"rev-parse {TIP}:{norm}": BLOB})
    add("blob read fails", old(), TIP, good(), {"rev-parse origin/main": TIP,
                                                f"rev-parse {TIP}:src/a.py": {"error": "no blob"}})
    add("evidence source_sha differs", old(), TIP, good(source_sha="4" * 40))
    add("evidence finding digest differs", old(), TIP, good(finding_sha256="5" * 64))
    add("evidence blob differs", old(), TIP, good(source_blob_sha="6" * 40))
    add("evidence verdict differs", old(), TIP, good(verdict="invalid"))
    add("evidence verdict missing", old(), TIP, {k: v for k, v in good().items() if k != "verdict"})
    add("evidence is a list", old(), TIP, [])
    add("evidence is null", old(), TIP, None)
    add("reviewer missing", old(), TIP, {k: v for k, v in good().items() if k != "reviewer"})
    add("reviewer blank", old(), TIP, good(reviewer="   "))
    add("reviewer non-string", old(), TIP, good(reviewer=7))
    add("reason blank", old(), TIP, good(reason=""))
    # Python str.strip() and JavaScript trim() disagree on these code points.
    for label, ch in [("FS (U+001C) is whitespace in Python", "\x1c"), ("NEL (U+0085) is whitespace", "\x85"),
                      ("NBSP (U+00A0) is whitespace", "\xa0"), ("ideographic space (U+3000)", "　"),
                      ("BOM (U+FEFF) is not whitespace in Python", "﻿"),
                      ("zero-width space (U+200B) is not whitespace", "​"),
                      ("line separator (U+2028) is whitespace", " ")]:
        add("reviewer only " + label, old(), TIP, good(reviewer=ch))
    add("reason of 4000 characters", old(), TIP, good(reason="x" * 4000))
    add("reason of 4001 characters", old(), TIP, good(reason="x" * 4001))
    add("reason of 4000 astral code points", old(), TIP, good(reason="\U0001f600" * 4000))
    add("reason of 4001 astral code points", old(), TIP, good(reason="\U0001f600" * 4001))
    # identity() is the canonical JSON digest: ASCII escapes, sorted keys, float kinds.
    for label, extra in [("non-ASCII finding body", {"body": "café \U0001f600"}),
                         ("float and int kinds", {"score": 1.0, "count": 1}),
                         ("exponent float", {"score": 1e22}),
                         ("nested and unsorted keys", {"z": {"b": 1, "a": [1, 2.5, None]}, "a": True})]:
        f = {**finding, **extra}
        add(label, old(finding=f), TIP, good(finding_sha256=bounded.identity(f)))

    out = []
    for spec in specs:
        calls = []

        def scripted(clone, *args, _spec=spec, _calls=calls):
            key = " ".join(args)
            _calls.append(key)
            value = _spec["git"].get(key)
            if isinstance(value, dict):
                raise RuntimeError("git " + args[0] + " failed: " + value["error"])
            if value is None:
                raise AssertionError("unscripted git call: " + key)
            return value

        args = roundtrip((spec["old"], spec["source_sha"], spec["evidence"]))
        with mock.patch.object(bounded, "git", scripted):
            result = outcome(lambda a=args: bounded.validate_revalidation({"clone": "clone"}, *a))
        out.append({**spec, **result, "calls": calls})
    return out


# ---------------------------------------------------------------------------
# Scratch repositories
# ---------------------------------------------------------------------------

def run_steps(root: Path, steps: list) -> dict:
    """Interpret the step list the TS test interprets identically."""
    marks: dict[str, str] = {}
    repo = root / "repo"
    repo.mkdir()
    for step in steps:
        op = step[0]
        if op == "git":
            subprocess.run(["git", *step[1:]], cwd=repo, check=True, capture_output=True)
        elif op == "write":
            path = repo / step[1]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(step[2])
            path.chmod(0o644)
        elif op == "write_b64":
            path = repo / step[1]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(step[2]))
            path.chmod(0o644)
        elif op == "chmod":
            (repo / step[1]).chmod(int(step[2], 8))
        elif op == "rm":
            (repo / step[1]).unlink()
        elif op == "symlink":
            (repo / step[1]).parent.mkdir(parents=True, exist_ok=True)
            os.symlink(step[2], repo / step[1])
        elif op == "link":
            os.link(repo / step[1], repo / step[2])
        elif op == "mkfifo":
            os.mkfifo(repo / step[1])
        elif op == "mark":
            marks[step[1]] = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True,
                                            capture_output=True, text=True).stdout.strip()
        elif op == "commit_all":
            subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-q", "-m", step[1]], cwd=repo, check=True, capture_output=True)
        elif op == "commit_bytes":
            message = root / "message.bin"
            message.write_bytes(base64.b64decode(step[1]))
            subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-q", "-F", str(message)], cwd=repo, check=True,
                           capture_output=True)
        else:
            raise AssertionError("unknown step " + op)
    return marks


def base_steps(*extra):
    return [["git", "init", "-q", "-b", "main"], ["write", "a.txt", "one\n"], ["commit_all", "base"],
            ["mark", "c0"], *extra]


def fix_commit(n: int, file: str = "a.txt", message: str | None = None):
    return [["write", file, f"fix {n}\n"], ["commit_all", message or f"fix {JOB} step {n}"],
            ["mark", f"c{n}"]]


def sub(value, marks):
    if isinstance(value, str):
        for name, sha in marks.items():
            value = value.replace("{" + name + "}", sha)
        return value
    if isinstance(value, list):
        return [sub(item, marks) for item in value]
    return value


def scrubber(root: Path, marks: dict):
    pairs = sorted(marks.items(), key=lambda kv: -len(kv[1]))

    def scrub(text):
        text = text.replace(str(root), "<root>")
        for name, sha in pairs:
            text = text.replace(sha, "{" + name + "}")
        return text
    return scrub


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------

def verify_cases() -> list[dict]:
    ok = base_steps(*fix_commit(1))
    two = base_steps(*fix_commit(1), *fix_commit(2, "b.txt"))
    empty_second = base_steps(*fix_commit(1), ["git", "commit", "-q", "--allow-empty", "-m", f"empty {JOB}"],
                              ["mark", "c2"])
    sibling = [["git", "init", "-q", "-b", "main"], ["write", "a.txt", "one\n"], ["commit_all", "base"],
               ["mark", "c0"], ["git", "checkout", "-q", "-b", "side"], *fix_commit(1, "s.txt"),
               ["git", "checkout", "-q", "main"], *fix_commit(2, "m.txt")]
    off_head = base_steps(["git", "checkout", "-q", "-b", "side"], *fix_commit(1, "s.txt"),
                          ["git", "checkout", "-q", "main"], *fix_commit(2, "m.txt"))
    arabic = "٣"  # ARABIC-INDIC DIGIT THREE: Python \d matches it, [0-9] does not
    msg = lambda m: base_steps(*fix_commit(1, message=m))
    specs = [
        ("one claimed commit", ok, "{c0}", ["{c1}"], JOB),
        ("two claimed commits", two, "{c0}", ["{c1}", "{c2}"], JOB),
        ("claim order is irrelevant", two, "{c0}", ["{c2}", "{c1}"], JOB),
        ("no commits claimed", ok, "{c0}", [], JOB),
        ("commits null", ok, "{c0}", None, JOB),
        ("commits zero", ok, "{c0}", 0, JOB),
        ("commits empty string", ok, "{c0}", "", JOB),
        ("duplicate commits", ok, "{c0}", ["{c1}", "{c1}"], JOB),
        ("commits true is not iterable", ok, "{c0}", True, JOB),
        ("commits integer is not iterable", ok, "{c0}", 5, JOB),
        ("commits string iterates its characters", ok, "{c0}", "abc", JOB),
        ("commit element is an integer", ok, "{c0}", [1], JOB),
        ("duplicate integer elements", ok, "{c0}", [1, 1], JOB),
        ("True and 1 are the same set member", ok, "{c0}", [True, 1], JOB),
        ("unhashable element", ok, "{c0}", [["{c1}"]], JOB),
        ("valid commit then an integer element", ok, "{c0}", ["{c1}", 5], JOB),
        ("not 40 hex", ok, "{c0}", ["{c1}"[:-1] + "z"], JOB),
        ("39 hex", ok, "{c0}", ["f" * 39], JOB),
        ("hex with trailing newline", ok, "{c0}", ["{c1}\n"], JOB),
        ("upper-case hex names a real commit but is not in rev-list", ok, "{c0}", ["UPPER:{c1}"], JOB),
        ("commit missing from the repository", ok, "{c0}", ["a" * 40], JOB),
        ("commit equals base", ok, "{c0}", ["{c0}"], JOB),
        ("commit is not a descendant of base", sibling, "{c1}", ["{c2}"], JOB),
        ("base is not a commit", ok, "b" * 40, ["{c1}"], JOB),
        ("commit is not an ancestor of HEAD", off_head, "{c0}", ["{c1}", "{c2}"], JOB),
        ("empty commit", empty_second, "{c0}", ["{c1}", "{c2}"], JOB),
        ("message lacks the job", msg("unrelated"), "{c0}", ["{c1}"], JOB),
        ("job followed by an ASCII digit", msg("fix crq-R-F10"), "{c0}", ["{c1}"], JOB),
        ("job preceded by an ASCII digit", msg("fix 9crq-R-F1"), "{c0}", ["{c1}"], JOB),
        ("job followed by an Arabic-Indic digit", msg("fix crq-R-F1" + arabic), "{c0}", ["{c1}"], JOB),
        ("job preceded by an Arabic-Indic digit", msg("fix " + arabic + "crq-R-F1"), "{c0}", ["{c1}"], JOB),
        ("job preceded by a letter is accepted", msg("fixcrq-R-F1"), "{c0}", ["{c1}"], JOB),
        ("job in the message body", msg("subject\n\nbody crq-R-F1 here"), "{c0}", ["{c1}"], JOB),
        ("job with a regex dot must match literally", msg("fix crq-RxF1"), "{c0}", ["{c1}"], "crq-R.F1"),
        ("job with a regex dot, literal match", msg("fix crq-R.F1"), "{c0}", ["{c1}"], "crq-R.F1"),
        ("empty job matches any message", msg("whatever"), "{c0}", ["{c1}"], ""),
        ("empty job still refuses a digit boundary", msg("1"), "{c0}", ["{c1}"], ""),
        ("message that is not UTF-8", base_steps(["write", "a.txt", "x\n"],
                                                 ["commit_bytes", base64.b64encode(
                                                     b"fix " + JOB.encode() + b" \xff\xfe\n").decode()],
                                                 ["mark", "c1"]), "{c0}", ["{c1}"], JOB),
        ("unclaimed commit in range", two, "{c0}", ["{c2}"], JOB),
        ("claimed commit outside the range", ok, "{c0}", ["{c1}", "{c0}"], JOB),
        ("dirty tracked file", ok + [["write", "a.txt", "dirty\n"]], "{c0}", ["{c1}"], JOB),
        ("untracked file", ok + [["write", "new.txt", "x\n"]], "{c0}", ["{c1}"], JOB),
        ("staged change", ok + [["write", "a.txt", "staged\n"], ["git", "add", "a.txt"]], "{c0}", ["{c1}"], JOB),
    ]
    out = []
    for name, steps, base, commits, job in specs:
        with tempfile.TemporaryDirectory(prefix="cq-process-helpers-") as tmp, \
                mock.patch.dict(os.environ, GIT_ENV):
            root = Path(tmp).resolve()
            marks = run_steps(root, steps)
            marks_for_sub = dict(marks)
            commits_in = commits
            if isinstance(commits, list):
                commits_in = [c.replace("UPPER:", "") if isinstance(c, str) else c for c in commits]
                commits_in = [sub(c, marks_for_sub) if isinstance(c, str) else c for c in commits_in]
                commits_in = [c.upper() if isinstance(c, str) and "UPPER:" in commits[i] else c
                              for i, c in enumerate(commits_in)]
            base_in = sub(base, marks_for_sub)
            result = outcome(lambda: crq_repair.verify(str(root / "repo"), base_in, commits_in, job),
                             scrub=scrubber(root, marks), git_message=True)
            if "result" in result:
                result = {"result": "{head}" if result["result"] == marks[_head_mark(marks)] else result["result"]}
        out.append({"name": name, "repo": steps, "base": base, "commits": commits, "job": job, **result})
    return out


def _head_mark(marks):
    return sorted(k for k in marks if k != "c0")[-1] if len(marks) > 1 else "c0"


# ---------------------------------------------------------------------------
# retain / untracked_directories / retain_preserving_nested
# ---------------------------------------------------------------------------

def snapshot_of(root: Path, wt: Path, target: Path, marks: dict) -> dict:
    scrub = scrubber(root, marks)
    manifest_text = (target / "manifest.json").read_text()
    manifest = json.loads(manifest_text)
    digests = {}
    for name in ("staged.patch", "unstaged.patch", "committed.patch", "untracked.tar", "commits.bundle"):
        digests[name] = hashlib.sha256((target / name).read_bytes()).hexdigest()
    token = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    members = []
    with tarfile.open(target / "untracked.tar") as archive:
        for member in archive.getmembers():
            data = archive.extractfile(member).read() if member.isreg() else None
            members.append({"name": member.name, "type": member.type.decode(), "size": member.size,
                            "linkname": member.linkname, "mode": member.mode,
                            "sha256": hashlib.sha256(data).hexdigest() if data is not None else None})
    bundle = (target / "commits.bundle").read_bytes()
    heads = None
    if bundle:
        heads = scrub(subprocess.run(["git", "bundle", "list-heads", str(target / "commits.bundle")],
                                     cwd=wt, check=True, capture_output=True, text=True).stdout)
    masked = json.loads(json.dumps(manifest))
    for name in ("untracked.tar", "commits.bundle"):
        masked["sha256"][name] = "<sha256>"
    return {
        "manifest": json.loads(scrub(json.dumps(masked))),
        "manifest_key_order": list(manifest),
        "manifest_sha256_key_order": list(manifest["sha256"]),
        "manifest_text_matches_atomic": manifest_text == json.dumps(manifest, indent=2) + "\n",
        "digests_consistent": digests == manifest["sha256"],
        "named_by_manifest": target.name == "retained-" + token,
        "files": sorted(p.name for p in target.iterdir()),
        "patches": {n: (target / n).read_bytes().decode("utf-8", "replace")
                    for n in ("staged.patch", "unstaged.patch", "committed.patch")},
        "tar": members,
        "bundle_empty": not bundle,
        "bundle_heads": heads,
        "dir_mode": stat.S_IMODE(target.stat().st_mode),
        "manifest_mode": stat.S_IMODE((target / "manifest.json").stat().st_mode),
    }


def status_of(wt: Path, scrub) -> str:
    return scrub(subprocess.run(["git", "status", "--porcelain", "--ignored", "-z"], cwd=wt, check=True,
                                capture_output=True, text=True).stdout.replace("\0", "|"))


def retain_cases() -> list[dict]:
    long_name = "d" * 40 + "/" + "e" * 40 + "/" + "f" * 40 + ".txt"
    specs = [
        ("clean tree is not retained", base_steps(), {}),
        ("clean tree is retained with include_clean", base_steps(), {"include_clean": True}),
        ("staged change", base_steps(["write", "a.txt", "staged\n"], ["git", "add", "a.txt"]), {}),
        ("unstaged change", base_steps(["write", "a.txt", "unstaged\n"]), {}),
        ("staged and further unstaged change", base_steps(["write", "a.txt", "s\n"], ["git", "add", "a.txt"],
                                                          ["write", "a.txt", "u\n"]), {}),
        ("untracked regular file", base_steps(["write", "new.txt", "hello\n"]), {}),
        ("untracked empty file", base_steps(["write", "empty.txt", ""]), {}),
        ("untracked executable", base_steps(["write", "run.sh", "#!/bin/sh\n"], ["chmod", "run.sh", "755"]), {}),
        ("untracked binary file", base_steps(["write_b64", "blob.bin", base64.b64encode(
            bytes(range(256)) * 3).decode()]), {}),
        ("untracked large file", base_steps(["write", "big.txt", "x" * 70000]), {}),
        ("untracked dangling symlink", base_steps(["symlink", "dangling", "missing/target"]), {}),
        ("untracked symlink to a file", base_steps(["write", "t.txt", "t\n"], ["symlink", "z-link", "t.txt"]), {}),
        ("untracked files in subdirectories", base_steps(["write", "s/one.txt", "1\n"],
                                                         ["write", "s/t/two.txt", "2\n"]), {}),
        ("untracked non-ASCII and spaced names", base_steps(["write", "café ☃.txt", "u\n"],
                                                            ["write", "a b.txt", "s\n"]), {}),
        ("untracked name over 100 characters", base_steps(["write", long_name, "long\n"]), {}),
        ("untracked hard link becomes a link entry", base_steps(["write", "h1.txt", "same\n"],
                                                                ["link", "h1.txt", "h2.txt"]), {}),
        ("ignored files are not archived", base_steps(["write", ".gitignore", "*.log\n"],
                                                      ["write", "x.log", "ignored\n"]), {}),
        ("one commit ahead", base_steps(*fix_commit(1)), {}),
        ("two commits ahead, tree clean", base_steps(*fix_commit(1), *fix_commit(2, "b.txt")), {}),
        ("two commits ahead, clean, include_clean", base_steps(*fix_commit(1), *fix_commit(2, "b.txt")),
         {"include_clean": True}),
        ("everything at once", base_steps(*fix_commit(1), ["write", "a.txt", "u\n"],
                                          ["write", "st.txt", "s\n"], ["git", "add", "st.txt"],
                                          ["write", "ut.txt", "n\n"]), {}),
        ("rename in the index", base_steps(["git", "mv", "a.txt", "renamed.txt"]), {}),
        ("deleted tracked file", base_steps(["rm", "a.txt"]), {}),
        ("binary tracked change", base_steps(["write_b64", "a.txt", base64.b64encode(b"\x00\x01\x02").decode()]), {}),
        ("base is not an ancestor of HEAD", [["git", "init", "-q", "-b", "main"], ["write", "a.txt", "1\n"],
                                             ["commit_all", "one"], ["mark", "c0"],
                                             ["git", "checkout", "-q", "--orphan", "other"],
                                             ["write", "b.txt", "2\n"], ["commit_all", "two"]], {}),
        ("fifo refuses with UnsupportedUntracked", base_steps(["mkfifo", "pipe"]), {}),
        ("nested repository refuses with UnsupportedUntracked", base_steps(
            ["git", "init", "-q", "nested"], ["write", "nested/f.txt", "n\n"],
            ["git", "-C", "nested", "add", "-A"], ["git", "-C", "nested", "commit", "-q", "-m", "n"]), {}),
        ("regular file listed before a refused fifo", base_steps(["write", "a-first.txt", "1\n"],
                                                                 ["mkfifo", "z-pipe"]), {}),
    ]
    out = []
    for name, steps, opts in specs:
        with tempfile.TemporaryDirectory(prefix="cq-process-helpers-") as tmp, \
                mock.patch.dict(os.environ, GIT_ENV):
            root = Path(tmp).resolve()
            marks = run_steps(root, steps)
            wt = root / "repo"
            evidence = root / "evidence" / "attempt"
            scrub = scrubber(root, marks)
            before = status_of(wt, scrub)
            base = marks.get("c0")
            raw = []
            call = outcome(lambda: raw.append(retain_mod.retain(wt, base, evidence, **opts)) or raw[0],
                           scrub=scrub, git_message=True)
            record: dict = {"name": name, "repo": steps, "options": opts, **call}
            if "result" in call:
                target = raw[0]
                record["result"] = None if target is None else "<snapshot>"
                if target is not None:
                    record["snapshot"] = snapshot_of(root, wt, Path(target), marks)
                    again = retain_mod.retain(wt, base, evidence, **opts)
                    record["second_capture_reuses_snapshot"] = again == target
            record["leftover_capture_dirs"] = sorted(p.name for p in evidence.glob(".capture-*")) \
                if evidence.exists() else []
            record["evidence_entries"] = len(list(evidence.iterdir())) if evidence.exists() else None
            record["tree_unchanged"] = status_of(wt, scrub) == before
            record["untracked_directories"] = outcome(lambda: retain_mod.untracked_directories(wt))
        out.append(record)
    return out


def nested_cases() -> list[dict]:
    nest = lambda name: [["git", "init", "-q", name], ["write", f"{name}/f.txt", f"{name}\n"],
                         ["git", "-C", name, "add", "-A"], ["git", "-C", name, "commit", "-q", "-m", "n"]]
    specs = [
        ("one nested repository is preserved", [base_steps(*nest("nested"))]),
        ("nested repository plus a regular untracked file", [base_steps(*nest("nested"), ["write", "keep.txt", "k\n"])]),
        ("nested repository below a tracked directory", [base_steps(
            ["write", "tracked/t.txt", "t\n"], ["commit_all", "dir"], *nest("tracked/inner"))]),
        ("two nested repositories", [base_steps(*nest("n1"), *nest("n2"))]),
        ("nested repository and a fifo still fail after the move", [base_steps(*nest("nested"), ["mkfifo", "pipe"])]),
        ("fifo only: refusal is rethrown and nothing moves", [base_steps(["mkfifo", "pipe"])]),
        ("clean tree: nothing to do", [base_steps()]),
        ("a rerun gets its own capture directory", [base_steps(*nest("nested")), nest("again")]),
    ]
    out = []
    for name, rounds in specs:
        with tempfile.TemporaryDirectory(prefix="cq-process-helpers-") as tmp, \
                mock.patch.dict(os.environ, GIT_ENV):
            root = Path(tmp).resolve()
            marks = run_steps(root, rounds[0])
            wt = root / "repo"
            evidence = root / "evidence" / "attempt"
            scrub = scrubber(root, marks)
            results = []
            for index, steps in enumerate(rounds):
                if index:
                    run_in_repo(wt, steps)
                results.append(outcome(lambda: service.retain_preserving_nested(wt, marks["c0"], evidence),
                                       scrub=scrub, git_message=True))
            holder = evidence / "retained-nested"
            moved = sorted(re.sub(r"capture-[A-Za-z0-9_]+", "capture-*", str(p.relative_to(holder)))
                           for p in holder.rglob("*")
                           if (p.is_file() or p.is_symlink()) and ".git/" not in p.as_posix()) \
                if holder.exists() else None
            nested_git = sorted(re.sub(r"capture-[A-Za-z0-9_]+", "capture-*", str(p.relative_to(holder)))
                                for p in holder.rglob(".git/HEAD")) if holder.exists() else None
            captures = sorted(p.name.startswith("capture-") for p in holder.iterdir()) if holder.exists() else None
            snapshots = []
            for d in sorted(evidence.glob("retained-*")) if evidence.exists() else []:
                if d.name != "retained-nested":
                    snapshots.append(snapshot_of(root, wt, d, marks))
            snapshots.sort(key=lambda s: json.dumps(s["manifest"], sort_keys=True))
            out.append({"name": name, "rounds": rounds, "results": results, "moved_files": moved, "moved_git_heads": nested_git,
                        "capture_dirs": captures, "snapshots": snapshots,
                        "tree_status": status_of(wt, scrub)})
    return out


def run_in_repo(repo: Path, steps: list) -> None:
    for step in steps:
        if step[0] == "git":
            subprocess.run(["git", *step[1:]], cwd=repo, check=True, capture_output=True)
        elif step[0] == "write":
            path = repo / step[1]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(step[2])
            path.chmod(0o644)
        else:
            raise AssertionError("unsupported follow-up step " + step[0])


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

AUTHORED = ("ValueError", "KeyError", "UnsupportedUntracked")


def outcome(call, scrub=lambda s: s, git_message=False) -> dict:
    try:
        return {"result": scrub_value(call(), scrub)}
    except BaseException as exc:  # noqa: BLE001 - the oracle records every escape
        name = type(exc).__name__
        record = {"raises": name}
        text = scrub(str(exc))
        if isinstance(exc, UnicodeDecodeError):
            record["is_value_error"] = True
        elif name in AUTHORED:
            record["message"] = text
        elif name == "RuntimeError":
            record["message"] = text.split(" failed: ", 1)[0] + " failed: "
        return record


def scrub_value(value, scrub):
    if isinstance(value, Path):
        return scrub(str(value))
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [scrub_value(v, scrub) for v in value]
    if isinstance(value, dict):
        return {k: scrub_value(v, scrub) for k, v in value.items()}
    return value


def roundtrip(value):
    return json.loads(json.dumps(value))


def build() -> dict:
    return {
        "schema": SCHEMA,
        "source": {
            "failure_class_for_stop": "apps/crq-python/crq_repair.py:161-166",
            "judge_required": f"apps/crq-python/crq_repair.py:{JUDGE_LINE}",
            "validate_revalidation": "apps/crq-python/crq_repair/bounded.py:34-61",
            "verify": "apps/crq-python/crq_repair/__init__.py:62-82",
            "retain": "apps/crq-python/crq_repair/retain.py:56-107",
            "untracked_directories": "apps/crq-python/crq_repair/retain.py:110-119",
            "retain_preserving_nested": "apps/crq-python/crq_repair.py:300-326",
        },
        "job": JOB,
        "default_ref": "origin/main",
        "failure_class": failure_cases(),
        "judge_required": judge_cases(),
        "revalidation": revalidation_cases(),
        "verify": verify_cases(),
        "retain": retain_cases(),
        "nested": nested_cases(),
    }


def render(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("process-helpers fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
