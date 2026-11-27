#!/usr/bin/env python3
"""Deterministic offline oracle for gitleaks binary discovery (``crq.py:643``).

Test tooling only. ``crq.secret_scan_diff`` decides availability with
``shutil.which("gitleaks")``; this runs the PRODUCTION ``shutil.which`` of the
oracle interpreter (Python 3.14) over throwaway directory trees holding FAKE
files only (never a real gitleaks), once per scenario, and records the path it
returns, or ``None``. A scenario is a list of filesystem operations, an
explicit ``PATH`` entry list and the working directory (``/T/cwd``).

The unset-``PATH`` facts are recorded separately: ``shutil.which`` consults
``os.confstr('CS_PATH')`` (not ``os.defpath``) and returns ``None`` for the
empty string.

Paths starting with ``/T`` are substituted with the temporary directory both
ways. Refuses to run as root: the permission scenarios would answer
differently (the TypeScript live test covers root).

Regenerate with ``python3.14 gitleaks_discovery_vectors.py --write``; verify with ``--check``.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-gitleaks-discovery" / "cases.json"
SCHEMA = "cq.crq-gitleaks-discovery-vector/v1"

SCENARIOS: list[dict] = []


def add(name, path, ops=(), cwd="/T/cwd"):
    SCENARIOS.append({"name": name, "path": list(path), "ops": [list(o) for o in ops], "cwd": cwd})


def exe(p, mode=0o755):
    return ["file", p, mode]


def build_scenarios() -> None:
    G = "gitleaks"
    add("single executable", ["/T/a"], [exe("/T/a/gitleaks")])
    add("absent binary", ["/T/a"], [["dir", "/T/a"]])
    add("nonexistent directory", ["/T/missing"], [])
    add("first match wins", ["/T/a", "/T/b"], [exe("/T/a/gitleaks"), exe("/T/b/gitleaks")])
    add("first match wins (reversed)", ["/T/b", "/T/a"], [exe("/T/a/gitleaks"), exe("/T/b/gitleaks")])
    add("duplicate entries", ["/T/a", "/T/a", "/T/b"], [exe("/T/a/gitleaks", 0o644), exe("/T/b/gitleaks")])
    add("duplicate entries both usable", ["/T/a", "/T/a"], [exe("/T/a/gitleaks")])
    add("non-executable file is skipped", ["/T/a", "/T/b"], [exe("/T/a/gitleaks", 0o644), exe("/T/b/gitleaks")])
    add("only a non-executable file", ["/T/a"], [exe("/T/a/gitleaks", 0o644)])
    add("owner-no-x but group/other x is not executable", ["/T/a"], [exe("/T/a/gitleaks", 0o611)])
    add("execute-only (no read) file is executable", ["/T/a"], [exe("/T/a/gitleaks", 0o111)])
    add("directory named gitleaks is skipped", ["/T/a", "/T/b"],
        [["dir", "/T/a/gitleaks"], exe("/T/b/gitleaks")])
    add("only a directory named gitleaks", ["/T/a"], [["dir", "/T/a/gitleaks"]])
    add("symlink to an executable", ["/T/a"], [exe("/T/real/gitleaks"), ["symlink", "/T/a/gitleaks", "/T/real/gitleaks"]])
    add("relative symlink to an executable", ["/T/a"],
        [exe("/T/a/real"), ["symlink", "/T/a/gitleaks", "real"]])
    add("symlink to a non-executable file", ["/T/a", "/T/b"],
        [exe("/T/real/x", 0o644), ["symlink", "/T/a/gitleaks", "/T/real/x"], exe("/T/b/gitleaks")])
    add("symlink to a directory", ["/T/a", "/T/b"],
        [["dir", "/T/real"], ["symlink", "/T/a/gitleaks", "/T/real"], exe("/T/b/gitleaks")])
    add("dangling symlink is skipped", ["/T/a", "/T/b"],
        [["symlink", "/T/a/gitleaks", "/T/nowhere"], exe("/T/b/gitleaks")])
    add("looping symlink is skipped (ELOOP)", ["/T/a", "/T/b"],
        [["symlink", "/T/a/gitleaks", "/T/a/gitleaks"], exe("/T/b/gitleaks")])
    add("symlink loop in the directory entry (ELOOP)", ["/T/a", "/T/b"],
        [["symlink", "/T/a", "/T/a"], exe("/T/b/gitleaks")])
    add("directory entry is a symlink to a directory", ["/T/link"],
        [exe("/T/real/gitleaks"), ["symlink", "/T/link", "/T/real"]])
    add("entry is a file (ENOTDIR)", ["/T/f", "/T/b"], [["file", "/T/f", 0o755], exe("/T/b/gitleaks")])
    add("component is a file (ENOTDIR)", ["/T/f/sub", "/T/b"], [["file", "/T/f", 0o755], exe("/T/b/gitleaks")])
    add("entry too long (ENAMETOOLONG)", ["/T/" + "x" * 300, "/T/b"], [exe("/T/b/gitleaks")])
    add("entry path too long overall (ENAMETOOLONG)", ["/T/" + "/".join(["y" * 200] * 30), "/T/b"],
        [exe("/T/b/gitleaks")])
    add("embedded NUL in an entry", ["/T/a\x00b", "/T/b"], [exe("/T/b/gitleaks")])
    add("unsearchable parent (EACCES)", ["/T/locked", "/T/b"],
        [exe("/T/locked/gitleaks"), ["chmod", "/T/locked", 0o000], exe("/T/b/gitleaks")])
    add("readable but not searchable parent (EACCES)", ["/T/locked", "/T/b"],
        [exe("/T/locked/gitleaks"), ["chmod", "/T/locked", 0o644], exe("/T/b/gitleaks")])
    add("only an unsearchable parent", ["/T/locked"],
        [exe("/T/locked/gitleaks"), ["chmod", "/T/locked", 0o000]])
    add("executable fifo", ["/T/a", "/T/b"], [["fifo", "/T/a/gitleaks", 0o755], exe("/T/b/gitleaks")])
    add("non-executable fifo", ["/T/a", "/T/b"], [["fifo", "/T/a/gitleaks", 0o644], exe("/T/b/gitleaks")])
    # --- empty and relative entries ----------------------------------------------------------
    add("empty entry means the cwd", ["", "/T/b"], [exe("/T/cwd/gitleaks"), exe("/T/b/gitleaks")])
    add("empty entry searched in its position", ["/T/a", "", "/T/b"],
        [exe("/T/a/gitleaks", 0o644), exe("/T/cwd/gitleaks"), exe("/T/b/gitleaks")])
    add("empty entry without a cwd binary falls through", ["", "/T/b"], [exe("/T/b/gitleaks")])
    add("trailing empty entry (a trailing colon)", ["/T/a", ""], [["dir", "/T/a"], exe("/T/cwd/gitleaks")])
    add("two empty entries", ["", ""], [exe("/T/cwd/gitleaks")])
    add("non-executable in the cwd is skipped", ["", "/T/b"], [exe("/T/cwd/gitleaks", 0o644), exe("/T/b/gitleaks")])
    add("relative entry", ["rel"], [exe("/T/cwd/rel/gitleaks")])
    add("relative entry beats a later absolute one", ["rel", "/T/b"],
        [exe("/T/cwd/rel/gitleaks"), exe("/T/b/gitleaks")])
    add("dot entry", ["."], [exe("/T/cwd/gitleaks")])
    add("dot-dot entry", [".."], [exe("/T/gitleaks")])
    add("dot-dot after a symlink resolves physically, not lexically", ["/T/base/link/.."],
        [exe("/T/target/gitleaks"), exe("/T/base/gitleaks"), ["symlink", "/T/base/link", "/T/target/bin"],
         ["dir", "/T/target/bin"]])
    add("dot-dot after a symlink, file only through the link target's parent", ["/T/base/link/.."],
        [exe("/T/target/gitleaks"), ["symlink", "/T/base/link", "/T/target/bin"], ["dir", "/T/target/bin"]])
    add("relative dot-dot after a symlink", ["base/link/.."],
        [exe("/T/target/gitleaks"), exe("/T/cwd/base/gitleaks"), ["symlink", "/T/cwd/base/link", "/T/target/bin"],
         ["dir", "/T/target/bin"]])
    add("trailing slash entry", ["/T/a/"], [exe("/T/a/gitleaks")])
    add("relative entry with dot-dot", ["../a"], [exe("/T/a/gitleaks")])
    add("relative entry missing, absolute found", ["rel", "/T/b"], [exe("/T/b/gitleaks")])
    # --- the empty PATH string ---------------------------------------------------------------
    add("empty PATH string finds nothing even with a cwd binary", [], [exe("/T/cwd/gitleaks")])
    add("a lone empty entry joins to the empty PATH string", [""], [exe("/T/cwd/gitleaks")])
    add("two empty entries with a non-executable cwd binary", ["", ""], [exe("/T/cwd/gitleaks", 0o644)])


def _apply(op, sub):
    kind = op[0]
    if kind == "file":
        p = Path(sub(op[1]))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("#!/bin/sh\n", encoding="utf-8")
        os.chmod(p, op[2])
    elif kind == "dir":
        Path(sub(op[1])).mkdir(parents=True, exist_ok=True)
    elif kind == "symlink":
        p = Path(sub(op[1]))
        p.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(sub(op[2]), p)
    elif kind == "fifo":
        p = Path(sub(op[1]))
        p.parent.mkdir(parents=True, exist_ok=True)
        os.mkfifo(p, op[2])
    elif kind == "chmod":
        os.chmod(sub(op[1]), op[2])
    else:
        raise AssertionError(kind)


def _which(path_list, cwd):
    old = os.getcwd()
    os.chdir(cwd)
    try:
        return shutil.which("gitleaks", path=os.pathsep.join(path_list))
    finally:
        os.chdir(old)


def _run(scenario):
    with tempfile.TemporaryDirectory(prefix="gl-disc-") as raw:
        tmp = str(Path(raw).resolve())
        sub = lambda s: s.replace("/T", tmp)  # noqa: E731
        Path(sub(scenario["cwd"])).mkdir(parents=True)
        try:
            for op in scenario["ops"]:
                _apply(op, sub)
            found = _which([sub(e) for e in scenario["path"]], sub(scenario["cwd"]))
        finally:
            for dirpath, dirnames, _files in os.walk(tmp):
                for d in dirnames:
                    full = os.path.join(dirpath, d)
                    if not os.path.islink(full):
                        os.chmod(full, 0o755)
        return None if found is None else found.replace(tmp, "/T")


def unset_path_facts() -> dict:
    """``shutil.which`` with no PATH: ``os.confstr('CS_PATH')`` is consulted, ``''`` finds nothing."""
    with tempfile.TemporaryDirectory(prefix="gl-disc-") as raw:
        tmp = str(Path(raw).resolve())
        (Path(tmp) / "b").mkdir()
        target = Path(tmp) / "b" / "gitleaks"
        target.write_text("#!/bin/sh\n", encoding="utf-8")
        os.chmod(target, 0o755)
        with mock.patch.dict(os.environ):
            os.environ.pop("PATH", None)
            with mock.patch("os.confstr", return_value=f"{tmp}/a:{tmp}/b") as confstr:
                found = shutil.which("gitleaks")
            consulted = [c.args for c in confstr.call_args_list]
        return {
            "confstr_consulted": consulted == [("CS_PATH",)],
            "confstr_search_found": None if found is None else found.replace(tmp, "/T"),
            "empty_string": shutil.which("gitleaks", path=""),
            "cs_path": os.confstr("CS_PATH"),
        }


def build() -> dict:
    if os.geteuid() == 0:
        raise SystemExit("refusing to run as root: permission scenarios would differ")
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    return {"schema": SCHEMA, "unset": unset_path_facts(),
            "cases": [{"name": s["name"], "scenario": s, "expected": _run(s)} for s in SCENARIOS]}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(c, ensure_ascii=True, separators=(",", ":")) for c in document["cases"]]
    return json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n"


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
        print("gitleaks discovery fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
