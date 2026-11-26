#!/usr/bin/env python3
"""Deterministic offline oracle for the TS triage-context secret scan port.

Test tooling only. It drives the PRODUCTION ``crq_repair.triage_context_scan``
(and through it ``triage_context_safe``) from ``crq_repair.py`` and records
what Python actually does:

* ``flatten`` cases inject a recording scanner (``c.secret_scan_diff``) and
  record the exact synthetic patch Python hands it, the verdict, and the
  exception class (and ``ContextScanError.reason``) when Python raises;
* ``real`` cases run the PRODUCTION ``crq.secret_scan_diff`` with a fixed
  two-rule denylist and ``gitleaks`` made unavailable, and record the clean
  verdict, so the TS adapter scanner can be compared on the same patches.

No production module is modified and no repository, queue, signer, network or
provider is touched. The TypeScript test (``test/policy/crq/
triageContextScan.test.ts``) replays every case through
``triageContextScan``. Where Python raises uncaught ``KeyError``/``TypeError``/
``AttributeError`` the case records the class name and the port refuses.

Regenerate with ``python3 triage_context_scan_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import crq

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-context-scan" / "cases.json"
SCHEMA = "cq.crq-triage-context-scan-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair.py"

_spec = importlib.util.spec_from_file_location("triage_scan_oracle_service", HERE / "crq_repair.py")
service = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(service)

RULES = [
    {"id": "planted-key", "regex": "pk-[A-Za-z0-9]{8,}"},
    {"id": "env-only", "regex": "SECRET=", "path": "[.]env$"},
]


def ctx(**over) -> dict:
    value = {"current_path": "src/a.py", "finding": {"path": "src/a.py", "title": "T", "body": "B"},
             "region": [{"line": 1, "text": "one"}]}
    value.update(over)
    return value


def flatten_cases() -> list[dict]:
    out: list[dict] = []

    def add(name, context, scanner="clean", **extra):
        out.append({"name": name, "context": context, "scanner": scanner, **extra})

    add("basic", ctx())
    add("verdict dirty is returned", ctx(), scanner="dirty")
    add("string values only, document order, keys never scanned",
        {"current_path": "p", "finding": {"zeta": "z1", "alpha": ["a1", {"k": "a2"}, 7, True, None, 1.5]},
         "secret-key-name": "v", "n": 3})
    add("current_path wins over finding path", ctx(current_path="cur.py", finding={"path": "old.py"}))
    for label, value in (("empty string", ""), ("zero", 0), ("null", None), ("false", False),
                         ("empty list", []), ("empty object", {}), ("zero float", 0.0)):
        add("falsy current_path (%s) falls back to finding path" % label,
            {"current_path": value, "finding": {"path": "fallback.py", "b": "x"}})
    add("absent current_path uses finding path", {"finding": {"path": "only.py"}})
    for label, value in (("empty string", ""), ("null", None), ("zero", 0), ("empty list", [])):
        add("falsy finding path (%s) uses the default name" % label, {"finding": {"path": value, "t": "x"}})
    add("finding without path uses the default name", {"finding": {"t": "x"}})
    add("current_path falsy and finding path falsy uses the default name",
        {"current_path": "", "finding": {"path": ""}})
    add("path with spaces and unicode", ctx(current_path="src/a b/é.py"))
    for label, value in (("true", True), ("one", 1), ("float", 2.5), ("list", ["a"]), ("object", {"a": 1})):
        add("truthy non-string current_path (%s) raises TypeError" % label, ctx(current_path=value))
    add("truthy non-string finding path raises TypeError",
        {"current_path": "", "finding": {"path": 5}})
    add("missing finding with falsy current_path raises KeyError", {"current_path": ""})
    add("missing finding and current_path raises KeyError", {"region": ["x"]})
    for label, value in (("null", None), ("string", "s"), ("list", [1]), ("number", 3), ("true", True)):
        add("non-object finding (%s) raises AttributeError" % label, {"current_path": "", "finding": value})
    add("non-object finding is not read when current_path is truthy", {"current_path": "p", "finding": "s"})
    add("string context raises AttributeError", "just text")
    add("list context raises AttributeError", ["a", "b"])
    add("null context raises AttributeError", None)
    add("number context raises AttributeError", 7)
    add("empty object raises KeyError", {})
    # splitlines edge cases: every boundary, CRLF as one break, no trailing empty line.
    for label, text in (
        ("lf", "a\nb"), ("crlf", "a\r\nb"), ("lone cr", "a\rb"), ("lfcr", "a\n\rb"),
        ("vt", "a\u000bb"), ("ff", "a\u000cb"), ("fs", "a\u001cb"), ("gs", "a\u001db"),
        ("rs", "a\u001eb"), ("nel", "a\u0085b"), ("ls", "a b"), ("ps", "a b"),
        ("trailing newline", "a\n"), ("trailing crlf", "a\r\n"), ("leading newline", "\na"),
        ("only newline", "\n"), ("blank line between", "a\n\nb"), ("empty", ""),
        ("zero width and nbsp are not breaks", "a​b c"), ("tab is not a break", "a\tb"),
        ("astral", "x\U0001f600y\nz"), ("nul", "a\u0000b"), ("plus and minus lead", "+x\n-y"),
    ):
        add("splitlines: " + label, ctx(region=[text]))
    add("empty context strings give an empty hunk", {"current_path": "p", "finding": {}})
    add("only non-string leaves give an empty hunk", {"current_path": "p", "n": 1, "t": True, "z": None})
    add("empty string values keep their join newlines", {"current_path": "p", "a": "", "b": "", "c": "x"})
    # error_reason through ContextScanError.
    for label, kind, message in (
        ("OSError", "OSError", "cannot read policy"),
        ("RuntimeError", "RuntimeError", "denylist parse failed (fail closed)"),
        ("whitespace collapsed", "RuntimeError", "  a\t b\n\n c d e\u001cf  "),
        ("empty message uses the class name", "OSError", ""),
        ("blank message uses the class name", "RuntimeError", " \n\t  "),
        ("limit is 300 code points", "RuntimeError", "x" * 300 + "tail"),
        ("limit counts astral as one", "RuntimeError", "\U0001f600" * 301),
        ("limit lands before a joined space", "RuntimeError", "y" * 299 + " z"),
        ("limit lands after a joined space", "RuntimeError", "y" * 298 + " z" + "w" * 10),
        ("limit trailing space is kept", "RuntimeError", "y" * 299 + "  tail"),
    ):
        add("scanner raises " + label, ctx(), scanner={"raises": kind, "message": message})
    for kind in ("ValueError", "KeyError", "TypeError", "subprocess.CalledProcessError"):
        add("scanner %s propagates unchanged" % kind, ctx(), scanner={"raises": kind, "message": "boom"})
    add("damaged context raises before the scanner is asked", {"current_path": ""},
        scanner={"raises": "RuntimeError", "message": "never reached"})
    return out


def real_cases() -> list[dict]:
    out: list[dict] = []

    def add(name, context):
        out.append({"name": name, "context": context})

    add("clean context", ctx())
    add("planted key in a string value", ctx(region=[{"line": 1, "text": "token pk-ABCDEFGH12"}]))
    add("planted key in a nested finding", ctx(finding={"path": "src/a.py", "body": "see pk-ABCDEFGH12 now"}))
    add("short key shape is clean", ctx(region=["pk-short"]))
    add("planted key in a dict key name is not scanned", ctx(**{"pk-ABCDEFGH12": "v"}))
    add("planted key after a lone CR is its own line", ctx(region=["safe\rpk-ABCDEFGH12"]))
    add("planted key after a unicode separator is its own line", ctx(region=["safe pk-ABCDEFGH12"]))
    add("planted key after CRLF", ctx(region=["safe\r\npk-ABCDEFGH12"]))
    add("path scoped rule fires on a matching path", ctx(current_path="deploy/.env", region=["SECRET=1"]))
    add("path scoped rule is silent on another path", ctx(current_path="src/a.py", region=["SECRET=1"]))
    add("path scoped rule fires through the finding path",
        {"current_path": "", "finding": {"path": "prod.env"}, "region": ["SECRET=1"]})
    add("allowlisted node_modules path is skipped", ctx(current_path="node_modules/x/y.js", region=["pk-ABCDEFGH12"]))
    add("allowlisted dist path is skipped", ctx(current_path="dist/out.js", region=["pk-ABCDEFGH12"]))
    add("allowlisted .git path is skipped", ctx(current_path=".git/config", region=["pk-ABCDEFGH12"]))
    add("allowlisted denylist file is skipped", ctx(current_path="policy/denylist/patterns.yml", region=["pk-ABCDEFGH12"]))
    add("near-miss allowlist path is scanned", ctx(current_path="policy/denylist/patterns.yml.bak", region=["pk-ABCDEFGH12"]))
    add("default path name is scanned", {"finding": {}, "region": ["pk-ABCDEFGH12"]})
    add("empty context is clean", {"current_path": "p"})
    return out


def run_flatten(spec: dict) -> dict:
    calls: list[str] = []
    outputs: list[object] = []
    scanner = spec["scanner"]

    def secret_scan_diff(diff, output):
        calls.append(diff)
        outputs.append(output)
        if scanner in ("clean", "dirty"):
            return scanner == "clean", {}
        error = {
            "OSError": OSError, "RuntimeError": RuntimeError, "ValueError": ValueError,
            "KeyError": KeyError, "TypeError": TypeError,
        }.get(scanner["raises"])
        if error is None:
            import subprocess
            raise subprocess.CalledProcessError(1, "git")
        raise error(scanner["message"])

    c = SimpleNamespace(secret_scan_diff=secret_scan_diff)
    sentinel = object()
    result: dict = {"scanner_calls": 0, "patch": None}
    try:
        verdict = service.triage_context_scan(c, spec["context"], sentinel)
        result["verdict"] = verdict
    except Exception as exc:  # the oracle records every class Python can raise
        name = type(exc).__name__
        result["raises"] = name
        if name == "ContextScanError":
            result["reason"] = exc.reason
            result["message"] = str(exc)
        if name == "CalledProcessError":
            result["raises"] = "subprocess.CalledProcessError"
    result["scanner_calls"] = len(calls)
    result["patch"] = calls[0] if calls else None
    result["output_passed_through"] = bool(outputs) and outputs[0] is sentinel
    return result


def run_real(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "scan.json"
        with mock.patch.object(crq, "denylist_rules", lambda classes=None: [dict(rule) for rule in RULES]), \
                mock.patch.object(crq.shutil, "which", lambda name: None):
            clean = service.triage_context_safe(crq, spec["context"], output)
        report = json.loads(output.read_text())
    return {"clean": clean, "denylist_hits": len(report["denylist_hits"]), "gitleaks": report["gitleaks"]}


def encode(spec: dict, result: dict) -> dict:
    """Keep the context as ordered JSON text: ``sort_keys`` would reorder dict
    values, and document order is exactly what the flatten depends on."""
    item = {key: value for key, value in spec.items() if key != "context"}
    item["context_json"] = json.dumps(spec["context"], ensure_ascii=True)
    item["result"] = result
    return item


def build() -> dict:
    flatten = [encode(spec, run_flatten(spec)) for spec in flatten_cases()]
    real = [encode(spec, run_real(spec)) for spec in real_cases()]
    names = [item["name"] for item in flatten] + [item["name"] for item in real]
    if len(names) != len(set(names)):
        raise AssertionError("duplicate vector case names")
    return {"schema": SCHEMA, "source": SOURCE_PATH, "rules": RULES, "flatten": flatten, "real": real}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq triage-context-scan oracle fixture")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("triage-context-scan fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
