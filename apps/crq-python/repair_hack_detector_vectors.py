#!/usr/bin/env python3
"""Deterministic offline oracle for ``crq_repair.hack_detector`` (crq_repair/__init__.py:104).

Test tooling only. The PRODUCTION ``hack_detector`` runs with ``crq_repair.command``
replaced by a stub that returns a declared (exit code, stdout, stderr) triple or
raises a declared exception. Nothing starts ``node``. The TypeScript replay drives
``runHackDetector`` with an identical injected runner and compares the returned
verdict or the exception class and message.

Fidelity traps covered: a size bound counted in UTF-8 bytes rather than characters,
a lone surrogate (``str.encode`` raises), ``str(...)[:n]`` clips counted in code
points, Python truthiness of ``detail``/``error``, ``json.dumps`` ASCII escaping and
separators, non-dict findings dropped, duplicate keys, ``NaN`` constants, a
``CliErrorArtifact`` versus a plain failure, and stderr-over-stdout in unreadable
output.

Regenerate with ``python3.14 repair_hack_detector_vectors.py --write``; verify
with ``--check``.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crq_repair  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-repair-hack-detector" / "cases.json"
SCHEMA = "cq.crq-repair-hack-detector-vector/v1"
LIMIT = crq_repair.MAX_HACK_DETECTOR_DIFF_BYTES


def proc(code, stdout, stderr=""):
    return {"proc": {"code": code, "stdout": stdout, "stderr": stderr}}


def ok(value=None):
    return json.dumps({"status": "ok", "value": [] if value is None else value})


def finding(kind="skip", file="a.test.ts", message="m"):
    return {"kind": kind, "file": file, "message": message}


def specs():
    out = []

    def add(name, diff="diff --git a/x b/x\n", **run):
        out.append({"name": name, "diff": diff, "run": run})

    add("clean", **proc(0, ok()))
    add("clean-with-extra-keys", **proc(0, json.dumps({"status": "ok", "value": [], "x": 1})))
    add("one-finding", **proc(0, ok([finding()])))
    add("finding-exit-nonzero", **proc(1, ok([finding()])))
    add("clean-but-exit-nonzero", **proc(1, ok()))
    add("clean-but-exit-negative", **proc(-9, ok()))
    add("non-ascii-finding", **proc(0, ok([finding(message="café ☃ \U0001f600")])))
    add("finding-missing-keys", **proc(0, ok([{"kind": "k"}])))
    add("finding-extra-keys-dropped", **proc(0, ok([{"kind": "k", "file": "f", "message": "m", "line": 3}])))
    add("finding-non-dict-dropped", **proc(0, ok([finding(), "stray", 7, None])))
    add("findings-all-non-dict", **proc(0, ok(["stray", 7])))
    add("finding-nested-value", **proc(0, ok([{"kind": ["a", {"b": 1.5}], "file": None, "message": True}])))
    add("finding-float-int-exponent", **proc(0, ok([{"kind": 1.0, "file": 1e400, "message": 10}])))
    add("finding-detail-clipped", **proc(0, ok([finding(message="x" * 900)])))
    add("finding-detail-clipped-astral", **proc(0, ok([finding(message="\U0001f600" * 400)])))
    add("status-failed-detail", **proc(1, json.dumps({"status": "failed", "detail": "bad config"})))
    add("status-failed-error-string", **proc(1, json.dumps({"status": "failed", "error": "boom"})))
    add("status-failed-error-dict", **proc(1, json.dumps(
        {"error": {"kind": "thrown", "subcommand": "gates.hackDetector", "message": "x", "exitCode": 1}})))
    add("error-dict-with-ok-status", **proc(0, json.dumps({"status": "ok", "value": [], "error": {"k": 1}})))
    add("error-dict-beats-findings", **proc(0, json.dumps({"status": "ok", "value": [finding()], "error": {"k": 1}})))
    add("error-list-is-rejection", **proc(1, json.dumps({"status": "failed", "error": ["a", 1]})))
    add("error-empty-dict-is-unavailable", **proc(1, json.dumps({"error": {}})))
    add("detail-falsy-falls-to-error", **proc(1, json.dumps({"status": "failed", "detail": "", "error": "e"})))
    add("detail-zero-falls-to-status", **proc(1, json.dumps({"status": "failed", "detail": 0, "error": 0})))
    add("detail-empty-list-falls-through", **proc(1, json.dumps({"status": "failed", "detail": [], "error": {}})))
    add("detail-dict-repr", **proc(1, json.dumps({"status": "failed", "detail": {"a": [1, None, True], "b": "q'x"}})))
    add("detail-float-repr", **proc(1, json.dumps({"status": "failed", "detail": 1.5})))
    add("detail-null-status-none", **proc(1, json.dumps({"detail": None})))
    add("no-status-key", **proc(0, json.dumps({"value": []})))
    add("status-not-string", **proc(0, json.dumps({"status": 1, "value": []})))
    add("status-ok-uppercase", **proc(0, json.dumps({"status": "OK", "value": []})))
    add("value-missing", **proc(0, json.dumps({"status": "ok"})))
    add("value-not-list", **proc(0, json.dumps({"status": "ok", "value": {}})))
    add("value-null", **proc(0, json.dumps({"status": "ok", "value": None})))
    add("status-ok-value-string", **proc(0, json.dumps({"status": "ok", "value": "x"})))
    add("detail-clipped-600", **proc(1, json.dumps({"status": "failed", "detail": "d" * 700})))
    add("detail-clipped-astral", **proc(1, json.dumps({"status": "failed", "detail": "\U0001f600" * 700})))
    add("duplicate-keys-last-wins", **proc(0, '{"status": "bad", "status": "ok", "value": [], "value": []}'))
    add("duplicate-finding-keys", **proc(0, '{"status":"ok","value":[{"kind":"a","kind":"b","file":"f","message":"m"}]}'))
    add("nan-constant-detail", **proc(1, '{"status": "failed", "detail": NaN}'))
    add("infinity-constant", **proc(1, '{"status": "failed", "detail": -Infinity}'))
    add("unreadable-stderr-wins", **proc(2, "not json", "stderr text"))
    add("unreadable-stdout-when-stderr-empty", **proc(2, "stdout text"))
    add("unreadable-empty-both", **proc(0, ""))
    add("unreadable-clipped-300", **proc(0, "z" * 500))
    add("unreadable-astral-clipped", **proc(0, "\U0001f600" * 400, ""))
    add("unreadable-trailing-comma", **proc(0, '{"status": "ok",}'))
    add("unreadable-leading-whitespace-ok", **proc(0, "  \n" + ok() + "\n"))
    add("shape-list", **proc(0, "[]"))
    add("shape-string", **proc(0, '"x"'))
    add("shape-null", **proc(0, "null"))
    add("shape-number-clipped", **proc(1, "1" * 400))
    add("shape-astral-clipped", **proc(0, json.dumps(["\U0001f600" * 400], ensure_ascii=False)))
    add("size-at-limit", diff="a" * LIMIT, **proc(0, ok()))
    add("size-over-limit", diff="a" * (LIMIT + 1), **proc(0, ok()))
    add("size-counts-bytes-not-chars", diff="é" * (LIMIT // 2 + 1), **proc(0, ok()))
    add("size-chars-under-bytes-over-astral", diff="\U0001f600" * (LIMIT // 4 + 1), **proc(0, ok()))
    add("size-exactly-bytes-astral", diff="\U0001f600" * (LIMIT // 4), **proc(0, ok()))
    add("lone-surrogate-diff", diff="a\ud800b", **proc(0, ok()))
    add("lone-low-surrogate-diff", diff="\udc00", **proc(0, ok()))
    add("paired-surrogates-are-fine", diff="😀".encode("utf-16", "surrogatepass").decode("utf-16"), **proc(0, ok()))
    add("empty-diff", diff="", **proc(0, ok()))
    exc_to = subprocess.TimeoutExpired(["node", "cq"], 1200)
    add("timeout", raise_={"kind": "TimeoutExpired", "text": str(exc_to)})
    add("timeout-long-text", raise_={"kind": "TimeoutExpired", "text": "t" * 500})
    add("oserror", raise_={"kind": "OSError", "text": str(FileNotFoundError(2, "No such file or directory", "node"))})
    add("oserror-astral-clipped", raise_={"kind": "OSError", "text": "\U0001f600" * 400})
    add("other-exception-propagates", raise_={"kind": "RuntimeError", "text": "weird"})
    for entry in out:
        if "raise_" in entry["run"]:
            entry["run"] = {"raise": entry["run"]["raise_"]}
    return out


def run_case(spec):
    def fake(argv, cwd=None, **_kw):
        assert argv[:3] == ["node", "cq.js", "gates.hackDetector"] and argv[3] == "--diff=" + spec["diff"]
        assert argv[4] == "--json"
        run = spec["run"]
        if "raise" in run:
            kind, text = run["raise"]["kind"], run["raise"]["text"]
            if kind == "TimeoutExpired":
                class _Timeout(subprocess.TimeoutExpired):
                    def __str__(self):
                        return text
                raise _Timeout(argv, 1200)
            if kind == "OSError":
                class _Os(OSError):
                    def __str__(self):
                        return text
                raise _Os()
            raise RuntimeError(text)
        p = run["proc"]
        return SimpleNamespace(returncode=p["code"], stdout=p["stdout"], stderr=p["stderr"])

    with mock.patch.object(crq_repair, "command", fake):
        try:
            data = crq_repair.hack_detector("cq.js", spec["diff"], "/nonexistent")
        except Exception as exc:  # noqa: BLE001 - the class is the datum
            out = {"outcome": "raised", "class": type(exc).__name__}
            if not isinstance(exc, UnicodeEncodeError):
                out["message"] = str(exc)
            return out
    return {"outcome": "returned", "status": data.get("status")}


def build():
    cases = [{**s, "expected": run_case(s)} for s in specs()]
    names = [c["name"] for c in cases]
    assert len(names) == len(set(names)), "duplicate names"
    return {"schema": SCHEMA, "limit": LIMIT, "cases": cases}


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=False) + "\n"


def main(argv=None):
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
        print("repair-hack-detector fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
