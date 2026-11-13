#!/usr/bin/env python3
"""Deterministic B1 vectors for GitHub-issue delivery of crq findings.

Test tooling only: importing this module has no runtime effect and crq never
imports it. It drives the real ``finding_issues`` module with injected
``gh`` fakes and records exact title/body bytes, ``file_issue`` return values,
Python exception classes and messages, and every ``gh`` argv/stdin pair in
effect order. The TypeScript replay is ``test/policy/crq/findingIssues.test.ts``.

Every record is public and synthetic. No filesystem path, host, credential,
process id or timestamp is recorded, so regeneration is byte-identical on every
host and Python 3.14+ patch level. A large body is recorded as its SHA-256 and
code-point length rather than inline.

Regenerate with ``python3 finding_issues_vector_emit_b1.py --write`` and verify
with ``--check``. ``--stdout`` prints the whole document for the determinism
test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import finding_issues

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-finding-issues-b1" / "vectors.json"
SCHEMA = "cq.crq-finding-issues-b1-vector/v1"

REPO = "camerontaylor/infra"
BASE = "aaaaaaaaaa1111"
HEAD = "bbbbbbbbbb2222"
ITEM_ID = "push-infra-aaaaaaaaaa-bbbbbbbbbb"
RUN_ID = "r-20261103T120000Z-abcd"
RECEIPT = "c" * 64
COUNTS = {"critical": 1, "major": 1, "minor": 1}
META = {
    "repo": REPO,
    "item_id": ITEM_ID,
    "run_id": RUN_ID,
    "base": BASE,
    "head": HEAD,
    "receipt_id": RECEIPT,
}
MD = "### Findings\n\n- something\n"
TITLE = finding_issues.title(BASE, HEAD, COUNTS, ITEM_ID)

SEARCH_ARGV = [
    "gh",
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "all",
    "--limit",
    "20",
    "--json",
    "number,title,url",
    "--search",
    f'in:title "{TITLE}"',
]
URL = f"https://github.com/{REPO}/issues/7"

_UNSET = object()
LARGE = 20000


def _encode_inputs(value: Any) -> Any:
    """Encode a long periodic string as a repeat descriptor, recursively.

    A 40,000-emoji input would otherwise dominate the fixture as escaped
    surrogate pairs. The descriptor is ``{"repeat": {"text": unit,
    "count": n}}`` and both the Python and TypeScript replay expand it before
    calling the oracle. Real (short) inputs are unchanged, so the vector still
    shows every scalar the module receives.
    """
    if isinstance(value, str) and len(value) > LARGE:
        for size in (1, 2):
            unit = value[:size]
            if unit and len(value) % size == 0 and value == unit * (len(value) // size):
                return {"repeat": {"text": unit, "count": len(value) // size}}
        return value
    if isinstance(value, dict):
        return {key: _encode_inputs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_encode_inputs(item) for item in value]
    return value


class ScriptedGh:
    """Records every call and replays one scripted result in order."""

    def __init__(self, script: List[Dict[str, Any]]):
        self.script = [dict(step) for step in script]
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, argv: List[str], *, input_text: Optional[str] = None) -> Any:
        self.calls.append({"argv": list(argv), "input_text": input_text})
        if not self.script:
            raise AssertionError("gh called more often than the script provides")
        step = self.script.pop(0)
        raised = step.get("raise")
        if raised == "timeout":
            raise subprocess.TimeoutExpired(list(argv), finding_issues.GH_TIMEOUT)
        if raised == "oserror":
            raise OSError(step["detail"])
        if raised:
            raise AssertionError(f"unknown scripted raise: {raised!r}")
        return SimpleNamespace(
            returncode=step["returncode"],
            stdout=step["stdout"],
            stderr=step["stderr"],
        )


def ok(stdout: str = "", stderr: str = "", returncode: int = 0) -> Dict[str, Any]:
    return {"returncode": returncode, "stdout": stdout, "stderr": stderr}


def timeout_step(argv: List[str]) -> Dict[str, Any]:
    detail = str(subprocess.TimeoutExpired(list(argv), finding_issues.GH_TIMEOUT))
    return {"raise": "timeout", "detail": detail}


def _expect_value(value: Any) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": True}
    if isinstance(value, str) and len(value) > LARGE:
        expect["value_sha256"] = hashlib.sha256(value.encode("utf-8")).hexdigest()
        expect["value_length"] = len(value)
    else:
        expect["value"] = value
    return expect


def _case(
    name: str,
    source: str,
    inputs: Dict[str, Any],
    *,
    value: Any = _UNSET,
    error: Optional[str] = None,
    message: Optional[str] = None,
    calls: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": error is None}
    if error is None:
        if value is not _UNSET:
            expect.update(_expect_value(value))
    else:
        expect["error"] = error
        if message is not None:
            expect["message"] = message
    if calls is not None:
        expect["calls"] = calls
    return {"name": name, "source": source, "input": _encode_inputs(inputs), "expect": expect}


def _raised(name: str, source: str, inputs: Dict[str, Any], action) -> Dict[str, Any]:
    try:
        value = action()
    except Exception as exc:  # noqa: BLE001 - the oracle records the class
        return _case(name, source, inputs, error=type(exc).__name__, message=str(exc))
    return _case(name, source, inputs, value=value)


def enabled_cases() -> List[Dict[str, Any]]:
    source = "finding_issues.enabled"
    values: List[tuple[str, Any]] = [
        ("explicit-issue", {"findings": "issue"}),
        ("explicit-none", {"findings": "none"}),
        ("absent-key", {"repo": REPO}),
        ("empty-object", {}),
        ("null-value", {"findings": None}),
        ("empty-string", {"findings": ""}),
        ("non-string-number", {"findings": 5}),
        ("non-dict-string", "x"),
        ("non-dict-null", None),
        ("non-dict-list", []),
    ]
    return [
        _raised(name, source, {"repo_cfg": repo_cfg}, lambda cfg=repo_cfg: finding_issues.enabled(cfg))
        for name, repo_cfg in values
    ]


def title_cases() -> List[Dict[str, Any]]:
    source = "finding_issues.title"
    cases: List[Dict[str, Any]] = []

    def add(name: str, base: Any, head: Any, counts: Any, item_id: Any = _UNSET) -> None:
        inputs: Dict[str, Any] = {"base": base, "head": head, "severity_counts": counts}
        if item_id is not _UNSET:
            inputs["item_id"] = item_id
        if item_id is _UNSET:
            cases.append(_raised(name, source, inputs,
                                 lambda b=base, h=head, c=counts: finding_issues.title(b, h, c)))
        else:
            cases.append(_raised(name, source, inputs,
                                 lambda b=base, h=head, c=counts, i=item_id:
                                 finding_issues.title(b, h, c, i)))

    add("exact-with-blocking", BASE, HEAD, COUNTS, ITEM_ID)
    add("zero-blocking", BASE, HEAD, {"minor": 2})
    add("empty-counts", BASE, HEAD, {})
    add("missing-severity-keys", BASE, HEAD, {"major": 1})
    add("short-refs", "abc", "def", {})
    add("item-id-empty", BASE, HEAD, COUNTS, "")
    add("item-id-null", BASE, HEAD, COUNTS, None)
    add("item-id-number", BASE, HEAD, COUNTS, 7)
    add("item-id-list", BASE, HEAD, COUNTS, [1, "x"])
    add("unicode-refs", "标题😀abcdefghijk", "𝕏bcdefghijklmnop", {})
    add("emoji-refs", "😀" * 20, "🛠" * 20, {})
    add("float-counts", BASE, HEAD, {"major": 1.5, "minor": 2.0})
    add("bool-counts", BASE, HEAD, {"critical": True, "major": False})
    add("negative-counts", BASE, HEAD, {"critical": -2, "major": 1, "minor": -3})
    add("huge-int-counts", BASE, HEAD, {"major": 2 ** 70})
    add("float-int-overflow", BASE, HEAD, {"major": 2 ** 1024, "minor": 1.5})
    add("string-count", BASE, HEAD, {"major": "x"})
    add("none-count", BASE, HEAD, {"major": None})
    add("float-sum-compensated", BASE, HEAD,
        {"critical": 1e16, "major": 1.0, "minor": -1e16})
    add("float-sum-point-one", BASE, HEAD,
        {"critical": 0.1, "major": 0.2, "minor": 0.3})
    add("float-sum-int64-overflow", BASE, HEAD,
        {"minor": 2 ** 64, "low": -(2 ** 64), "high": 1e16, "x": 1.0, "y": -1e16})
    add("float-sum-int64-boundary", BASE, HEAD,
        {"minor": 2 ** 63, "low": 1.0, "high": -(2 ** 63)})
    add("float-sum-large-int", BASE, HEAD, {"minor": 2 ** 70, "low": 1.0})
    add("float-sum-bool", BASE, HEAD, {"minor": True, "low": 1.5})
    add("float-sum-negative-zero", BASE, HEAD, {"minor": -0.0})
    add("float-sum-cancel", BASE, HEAD, {"minor": 1e16, "low": 1.0, "high": -1e16})
    add("float-sum-int-first", BASE, HEAD,
        {"minor": 1, "low": 1e16, "high": 1.0, "x": -1e16})
    add("sum-string", BASE, HEAD, {"minor": "x"})
    add("sum-list", BASE, HEAD, {"minor": [1]})
    add("sum-none", BASE, HEAD, {"minor": None})
    add("sum-dict", BASE, HEAD, {"minor": {"a": 1}})
    add("sum-string-after-float", BASE, HEAD, {"minor": 1.5, "low": "x"})
    add("sum-list-after-bigint", BASE, HEAD,
        {"minor": 2 ** 64, "low": -(2 ** 64), "x": [1]})
    add("critical-string-major-string", BASE, HEAD, {"critical": "a", "major": "b"})
    add("critical-string-major-int", BASE, HEAD, {"critical": "a", "major": 1})
    add("critical-list-major-list", BASE, HEAD, {"critical": [1], "major": [2]})
    add("critical-list-major-int", BASE, HEAD, {"critical": [], "major": 1})
    add("critical-list-major-bool", BASE, HEAD, {"critical": [], "major": True})
    add("critical-bool-major-list", BASE, HEAD, {"critical": True, "major": []})
    add("critical-float-major-list", BASE, HEAD, {"critical": 1.5, "major": []})
    add("critical-none-major-string", BASE, HEAD, {"critical": None, "major": "b"})
    add("critical-dict-major-list", BASE, HEAD, {"critical": {"a": 1}, "major": []})
    add("counts-non-dict", BASE, HEAD, [])
    add("base-non-string", 5, HEAD, {})
    add("base-none", None, HEAD, {})
    add("base-dict", {"a": 1}, HEAD, {})
    add("base-list", ["a", "b", 3], ["c"], {})
    add("error-order-base-before-total", 5, HEAD, {"minor": "x"})
    return cases


def body_cases() -> List[Dict[str, Any]]:
    source = "finding_issues.body"
    cases: List[Dict[str, Any]] = []

    def add(name: str, meta: Any, markdown: Any) -> None:
        cases.append(_raised(name, source, {"meta": meta, "findings_md": markdown},
                             lambda m=meta, d=markdown: finding_issues.body(m, d)))

    add("identity-fields-present", META, MD)
    add("absent-fields-degrade", {}, MD)
    add("receipt-empty-string-omitted", dict(META, receipt_id=""), MD)
    add("receipt-null-omitted", dict(META, receipt_id=None), MD)
    add("receipt-zero-omitted", dict(META, receipt_id=0), MD)
    add("receipt-false-omitted", dict(META, receipt_id=False), MD)
    add("receipt-empty-list-omitted", dict(META, receipt_id=[]), MD)
    add("scalar-meta-values", {"repo": 5, "item_id": True, "run_id": None,
                               "base": 1.5, "head": -0.0}, MD)
    add("float-meta-values", {"repo": 1e16, "item_id": 1e-5, "run_id": 1e-4,
                              "base": 1.2345678901234567, "head": 1e21}, MD)
    add("container-meta", {"repo": ["a", 1], "item_id": {"k": "v'w"},
                           "run_id": ["x"], "base": {"z": None}, "head": []}, MD)
    add("unicode-control-meta", {"repo": "a\nb\tc\x01d\u2028e", "item_id": "q'w\"e",
                                 "run_id": "\\path", "base": "\u00a0", "head": "\u200b"}, MD)
    add("nonprintable-repr", {"repo": "\x00\x7f\x80\xa0\ud800", "item_id": "\U0001f600",
                              "run_id": "\u0085"}, MD)
    add("findings-trailing-newlines", META, "x\n\n\n")
    add("findings-trailing-carriage-return", META, "x\r\n\n")
    add("findings-empty", META, "")

    room = finding_issues.MAX_BODY - len(finding_issues.body(META, ""))
    add("exact-limit-not-truncated", META, "x" * room)
    add("oversized-ascii-truncated", META, "x" * (finding_issues.MAX_BODY + 5000))
    add("oversized-unicode-truncated", META, "😀" * 70000)
    add("budget-negative", {"repo": "x" * 70000}, "abc")
    add("meta-non-dict", [], MD)
    add("findings-non-string", META, 5)
    return cases


def file_cases() -> List[Dict[str, Any]]:
    source = "finding_issues.file_issue"
    cases: List[Dict[str, Any]] = []

    def add(
        name: str,
        repo_cfg: Any,
        script: List[Dict[str, Any]],
        *,
        base: Any = BASE,
        head: Any = HEAD,
        meta: Any = META,
        counts: Any = COUNTS,
        markdown: Any = MD,
    ) -> None:
        inputs = {
            "repo_cfg": repo_cfg,
            "base": base,
            "head": head,
            "meta": meta,
            "severity_counts": counts,
            "findings_md": markdown,
            "gh_script": script,
        }
        fake = ScriptedGh(script)
        try:
            value = finding_issues.file_issue(
                repo_cfg, base=base, head=head, meta=meta,
                severity_counts=counts, findings_md=markdown, gh=fake,
            )
        except Exception as exc:  # noqa: BLE001 - the oracle records the class
            cases.append(_case(name, source, inputs, error=type(exc).__name__,
                               message=str(exc), calls=fake.calls))
            return
        cases.append(_case(name, source, inputs, value=value, calls=fake.calls))

    add("disabled-no-calls", {"repo": REPO, "findings": "none"}, [])
    add("existing-exact-title", {"repo": REPO, "findings": "issue"},
        [ok(json.dumps([{"number": 7, "title": TITLE, "url": URL}]))])
    add("existing-case-sensitive-mismatch", {"repo": REPO},
        [ok(json.dumps([{"number": 7, "title": TITLE.upper(), "url": URL}])),
         ok(f"https://github.com/{REPO}/issues/9\n")])
    add("existing-row-not-object", {"repo": REPO},
        [ok('[1, "x", null]'), ok(f"https://github.com/{REPO}/issues/9\n")])
    add("existing-row-number-float", {"repo": REPO},
        [ok(json.dumps([{"number": 1.0, "title": TITLE, "url": URL}])),
         ok(f"https://github.com/{REPO}/issues/9\n")])
    add("existing-row-number-bool", {"repo": REPO},
        [ok(json.dumps([{"number": True, "title": TITLE, "url": URL}]))])
    add("existing-row-url-empty", {"repo": REPO},
        [ok(json.dumps([{"number": 1, "title": TITLE, "url": ""}])),
         ok(f"https://github.com/{REPO}/issues/9\n")])
    add("existing-row-url-number", {"repo": REPO},
        [ok(json.dumps([{"number": 1, "title": TITLE, "url": 5}]))])
    add("existing-row-url-list", {"repo": REPO},
        [ok(json.dumps([{"number": 1, "title": TITLE, "url": [1, 2]}]))])
    add("list-empty-stdout", {"repo": REPO},
        [ok(""), ok(f"https://github.com/{REPO}/issues/9\n")])
    add("list-whitespace-stdout", {"repo": REPO}, [ok("  \n")])
    add("list-unparsable", {"repo": REPO}, [ok("not json")])
    add("list-non-list", {"repo": REPO}, [ok('{"a": 1}')])
    add("list-duplicate-key-last", {"repo": REPO},
        [ok(f'[{{"title": "wrong", "title": "{TITLE}", "number": 1, "url": "{URL}"}}]')])
    add("list-nonfinite-number", {"repo": REPO},
        [ok('[{"number": NaN, "title": "x", "url": "u"}]'),
         ok(f"https://github.com/{REPO}/issues/9\n")])
    add("list-exit-error", {"repo": REPO},
        [ok(stderr="  GraphQL: Could not resolve to an Issue  \n", returncode=1)])
    add("list-exit-error-empty-stderr", {"repo": REPO}, [ok(returncode=1)])
    add("list-exit-error-astral-stderr", {"repo": REPO},
        [ok(stderr="😀" * 400, returncode=1)])
    add("list-timeout", {"repo": REPO}, [timeout_step(SEARCH_ARGV)])
    add("list-spawn-error", {"repo": REPO},
        [{"raise": "oserror", "detail": "no gh binary"}])
    add("create-passes-body-stdin", {"repo": REPO},
        [ok("[]\n"), ok(f"\nhttps://github.com/{REPO}/issues/12\n")])
    add("create-url-surrounded", {"repo": REPO},
        [ok("[]"), ok(f"prefix https://github.com/{REPO}/issues/12 suffix\n")])
    add("create-no-url", {"repo": REPO}, [ok("[]"), ok("nothing here\n")])
    add("create-no-url-astral", {"repo": REPO}, [ok("[]"), ok("😀" * 400)])
    add("create-unicode-digits", {"repo": REPO},
        [ok("[]"), ok("https://github.com/o/r/issues/١٢\n")])
    add("create-huge-number", {"repo": REPO},
        [ok("[]"), ok("https://github.com/o/r/issues/999999999999999999999\n")])
    add("create-digit-limit-boundary", {"repo": REPO},
        [ok("[]"), ok("https://github.com/o/r/issues/" + "9" * 4300 + "\n")])
    add("create-digit-limit-exceeded", {"repo": REPO},
        [ok("[]"), ok("https://github.com/o/r/issues/" + "9" * 4301 + "\n")])
    add("create-zero-number", {"repo": REPO},
        [ok("[]"), ok("https://github.com/o/r/issues/0\n")])
    add("create-url-whitespace", {"repo": REPO},
        [ok("[]"), ok("https://github.com/a b/c/issues/1\n")])
    add("create-url-feff-owner", {"repo": REPO},
        [ok("[]"), ok("https://github.com/\ufeff/r/issues/1\n")])
    add("create-url-information-separator", {"repo": REPO},
        [ok("[]"), ok("https://github.com/a\x1cb/c/issues/1\n")])
    add("create-url-astral-owner", {"repo": REPO},
        [ok("[]"), ok("https://github.com/😀/r/issues/1\n")])
    add("repo-missing", {"findings": "issue"}, [])
    add("meta-non-dict", {"repo": REPO}, [], meta=[])
    add("findings-non-string-after-search", {"repo": REPO}, [ok("[]")], markdown=5)
    add("existing-with-nonstring-findings", {"repo": REPO},
        [ok(json.dumps([{"number": 7, "title": TITLE, "url": URL}]))], markdown=5)
    return cases


def document() -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/finding_issues_vector_emit_b1.py",
        "families": [
            {"family": "enabled", "cases": enabled_cases()},
            {"family": "title", "cases": title_cases()},
            {"family": "body", "cases": body_cases()},
            {"family": "file_issue", "cases": file_cases()},
        ],
    }


def render() -> str:
    return json.dumps(document(), indent=2, ensure_ascii=True, sort_keys=False) + "\n"


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="rewrite the checked-in vectors")
    parser.add_argument("--check", action="store_true", help="fail when the checked-in vectors are stale")
    parser.add_argument("--stdout", action="store_true", help="print the whole document")
    args = parser.parse_args(argv)
    text = render()
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if args.check:
        if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
            print(f"{FIXTURE} is stale; run python3 finding_issues_vector_emit_b1.py --write",
                  file=sys.stderr)
            return 1
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
