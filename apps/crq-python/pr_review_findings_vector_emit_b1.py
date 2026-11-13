#!/usr/bin/env python3
"""Deterministic B1 vectors for pull-request review delivery of crq findings.

Test tooling only: importing this module has no runtime effect and crq never
imports it. It drives the real ``pr_review_findings`` module with injected
``gh`` fakes and records exact review payload bytes, delivery return values,
Python exception classes and messages, and every ``gh`` argv/stdin pair in
effect order. The TypeScript replay is
``test/policy/crq/prReviewFindings.test.ts``.

Every record is public and synthetic. No filesystem path, host, credential,
process id or timestamp is recorded, so regeneration is byte-identical on every
host and Python 3.14+ patch level. A large body is recorded as its SHA-256 and
code-point length rather than inline, and a long periodic string input is
encoded as a repeat descriptor.

Regenerate with ``python3 pr_review_findings_vector_emit_b1.py --write`` and
verify with ``--check``. ``--stdout`` prints the whole document for the
determinism test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

import pr_review_findings

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-pr-review-b1" / "vectors.json"
SCHEMA = "cq.crq-pr-review-b1-vector/v1"

REPO = "camerontaylor/infra"
HEAD = "a" * 40
BASE = "b" * 40
RUN_ID = "r-20261103T120000Z-abcd"
ITEM_ID = "push-infra-aaaaaaaaaa-bbbbbbbbbb"
PATCH = "@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -40,2 +41,6 @@\n x\n+y\n"
POSTED = {"id": 77, "html_url": "https://github.com/x/r/pull/77"}

FILE_NAME = "src/a.py"
ANCHORED_LINE = 2
END_LINE = 3
SEVERITY = "major"
FINDING_TITLE = "Check the bound"
FINDING_COMMENT = "**Check the bound**\n\nOff by one.<!-- foreign marker -->"
CODEGEN = "prompt text"
META = {"head": HEAD, "base": BASE, "run_id": RUN_ID, "item_id": ITEM_ID}
FINDING = {
    "type": "finding",
    "severity": SEVERITY,
    "fileName": FILE_NAME,
    "startLine": ANCHORED_LINE,
    "endLine": END_LINE,
    "title": FINDING_TITLE,
    "comment": FINDING_COMMENT,
    "codegenInstructions": CODEGEN,
}

_UNSET = object()
LARGE = 20000


def _encode_inputs(value: Any) -> Any:
    """Encode a long periodic string as a repeat descriptor, recursively.

    The descriptor is ``{"repeat": {"text": unit, "count": n}}`` and both the
    Python and TypeScript replay expand it before calling the oracle. Real
    (short) inputs are unchanged, so the vector still shows every scalar the
    module receives.
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


def _expect_value(value: Any) -> Dict[str, Any]:
    if isinstance(value, str) and len(value) > LARGE:
        return {
            "value_sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            "value_length": len(value),
        }
    return {"value": value}


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
            raise subprocess.TimeoutExpired(list(argv), pr_review_findings.GH_TIMEOUT)
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


class EndpointGh:
    """Answers by endpoint shape; a script step overrides the next call."""

    def __init__(self, state="open", merged=False, head=HEAD, base=BASE,
                 reviews="[]", compare=ok(json.dumps(
                     [{"filename": FILE_NAME, "status": "modified", "patch": PATCH}])),
                 post=None, script=None):
        self.calls: List[Dict[str, Any]] = []
        self.state, self.merged, self.head, self.base = state, merged, head, base
        self.reviews = reviews
        self.compare = compare
        self.post = list(post or [ok(json.dumps(POSTED))])
        self.script = list(script or [])

    def __call__(self, argv: List[str], *, input_text: Optional[str] = None) -> Any:
        self.calls.append({"argv": list(argv), "input_text": input_text})
        if self.script:
            step = self.script.pop(0)
            if step.get("raise") == "timeout":
                raise subprocess.TimeoutExpired(list(argv), pr_review_findings.GH_TIMEOUT)
            if step.get("raise") == "oserror":
                raise OSError(step["detail"])
            return SimpleNamespace(returncode=step["returncode"], stdout=step["stdout"],
                                   stderr=step["stderr"])
        if argv[2:3] == ["user"]:
            return SimpleNamespace(returncode=0, stdout="crq-host\n", stderr="")
        if "--method" in argv:
            step = self.post.pop(0) if self.post else ok(json.dumps(POSTED))
            if step.get("raise") == "timeout":
                raise subprocess.TimeoutExpired(list(argv), pr_review_findings.GH_TIMEOUT)
            if step.get("raise") == "oserror":
                raise OSError(step["detail"])
            return SimpleNamespace(returncode=step["returncode"], stdout=step["stdout"],
                                   stderr=step["stderr"])
        target = next(a for a in argv[2:] if a.startswith("repos/"))
        if target.endswith("/reviews?per_page=100"):
            raw = self.reviews["stdout"] if isinstance(self.reviews, dict) else self.reviews
            if "--paginate" not in argv:
                # Real `gh api` without --paginate returns only page 1; the
                # recorded stream holds every page, so drop the later ones.
                raw = raw[: raw.find("\n") + 1] if "\n" in raw else raw
            modelled = _apply_reviews_jq(argv, raw)
            if isinstance(modelled, SimpleNamespace):
                return modelled
            return SimpleNamespace(returncode=0, stdout=modelled, stderr="")
        if "/compare/" in target:
            step = self.compare
            if isinstance(step, dict):
                if step.get("raise") == "timeout":
                    raise subprocess.TimeoutExpired(list(argv), pr_review_findings.GH_TIMEOUT)
                if step.get("raise") == "oserror":
                    raise OSError(step["detail"])
                return SimpleNamespace(returncode=step.get("returncode", 0),
                                       stdout=step.get("stdout", ""),
                                       stderr=step.get("stderr", ""))
            return SimpleNamespace(returncode=0, stdout=step["stdout"]
                                   if isinstance(step, dict) else step, stderr="")
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"state": self.state, "merged": self.merged,
                               "base": self.base, "head": self.head}),
            stderr="")



def _apply_reviews_jq(argv, raw):
    """Model real `gh api --jq` over the recorded raw API response.

    Real `gh --paginate` feeds jq ONE STREAM of concatenated pages, each a
    JSON array on its own line (`[page1]\n[page2]`); jq processes documents
    in sequence and reports where an error hit. Modelled here:

    - each line of the input is one JSON document (a page); unparsable
      input -> jq parse failure naming the failing line (returncode 2),
    - a non-array page -> `Cannot iterate over null` naming its line (rc 2),
    - a non-object row -> jq's runtime error (returncode 5) after emitting
      any earlier matches to stdout (real jq streams results as it goes;
      the message names the row's actual JSON type and the input line),
    - rows are filtered by the selector's `user.login` and marker predicate
      (`startswith`/`contains`) and projected to `{id, url: .html_url}`.

    A caller regression that drops a predicate changes the argv, so the
    fake returns unfiltered rows and the delivery result exposes it.
    """
    jq = ""
    for index, arg in enumerate(argv):
        if arg == "--jq" and index + 1 < len(argv):
            jq = argv[index + 1]
            break
    login_match = re.search(r'select\(\.user\.login == "((?:[^"\\]|\\.)*)"', jq)
    literal_match = re.search(r'(startswith|contains)\("((?:[^"\\]|\\.)*)"\)', jq)
    def _fail(returncode, detail, keep=""):
        return SimpleNamespace(returncode=returncode, stdout=keep, stderr=detail)
    if login_match is None or literal_match is None:
        # Unmodelled selector: refuse rather than fake agreement.
        return _fail(3, "jq: unmodelled selector in fake")
    login = json.loads('"' + login_match.group(1) + '"')
    predicate = literal_match.group(1)
    wanted = json.loads('"' + literal_match.group(2) + '"')
    row_type = {list: "array", str: "string", bool: "boolean", int: "number",
                float: "number", type(None): "null"}
    out_lines = []
    segments = raw.split("\n")
    for line_index, line in enumerate(segments, start=0):
        terminated = line_index + 1 < len(segments)
        # Real jq 1.8.2 numbers runtime errors by newlines consumed through
        # the failing document's own terminator: an unterminated final segment
        # reports one less than its 1-based index (single page without a
        # trailing "\n" reports <stdin>:0, the same page with it :1; a page-2
        # error without a trailing "\n" reports :1, with it :2).
        error_line = line_index + (1 if terminated else 0)
        if not line.strip():
            continue
        try:
            page = json.loads(line)
        except ValueError:
            # Real jq 1.8.2: parse errors exit 5 and report the 1-based input
            # line (which equals the document line for line-per-page input).
            return _fail(5, f"jq: parse error: Invalid literal at line {line_index + 1}",
                         keep="".join(l + "\n" for l in out_lines))
        if not isinstance(page, list):
            return _fail(5,
                         f"jq: error (at <stdin>:{error_line}): Cannot iterate over null",
                         keep="".join(l + "\n" for l in out_lines))
        for row in page:
            if not isinstance(row, dict):
                noun = row_type[type(row)]
                return _fail(5,
                             'jq: error (at <stdin>:%d): Cannot index %s with string ("user")'
                             % (error_line, noun),
                             keep="".join(l + "\n" for l in out_lines))
            if (row.get("user") or {}).get("login") != login:
                continue
            body = row.get("body") or ""
            if predicate == "startswith" and not body.startswith(wanted):
                continue
            if predicate == "contains" and wanted not in body:
                continue
            out_lines.append(json.dumps({"id": row.get("id"), "url": row.get("html_url")}))
    return SimpleNamespace(returncode=0, stdout="".join(line + "\n" for line in out_lines), stderr="")

def timeout_step(argv: List[str]) -> Dict[str, Any]:
    detail = str(subprocess.TimeoutExpired(list(argv), pr_review_findings.GH_TIMEOUT))
    return {"raise": "timeout", "detail": detail}


def write_events(events: List[Dict[str, Any]]) -> str:
    """Serialise finding events the way the caller's queue does."""
    return "".join(json.dumps(event) + "\n" for event in events)


# --------------------------------------------------------------- families


def marker_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.marker"
    values: List[Tuple[str, Any]] = [
        ("exact-run-id", RUN_ID),
        ("empty-run-id", ""),
        ("one-char", "r"),
        ("digits-only", "2026"),
        ("dot-dash-underscore", "a.b_c-d"),
        ("long-run-id", "r" * 201),
        ("unicode-run-id", "résumé"),
        ("leading-punct", "-abc"),
        ("space-run-id", "a b"),
        ("newline-run-id", "a\nb"),
        ("astral-run-id", "😀r"),
        ("zwj-run-id", "a‍b"),
    ]
    cases = []
    for name, run_id in values:
        inputs = {"run_id": run_id}
        if isinstance(run_id, str) and pr_review_findings.RUN_ID.fullmatch(run_id):
            cases.append(_case(name, source, inputs, value=pr_review_findings.marker(run_id)))
        else:
            cases.append(_raised(
                name, source, inputs,
                lambda r=run_id: pr_review_findings.marker(r)))
    return cases


def load_findings_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.load_findings"
    cases: List[Dict[str, Any]] = []

    def add(name: str, text: Any) -> None:
        """Record the stream text as the vector input.

        The oracle reads a file, so the emitter writes the stream to a private
        temp file that is deleted before the case is recorded. The replay
        writes the same text to its own temp file, preserving the Python
        ``Path.read_text(errors='replace')`` behaviour byte for byte.
        """
        inputs = {"text": text}
        if not isinstance(text, str):
            cases.append(_raised(
                name, source, inputs,
                lambda t=text: pr_review_findings.load_findings(t)))
            return
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "review.ndjson"
            path.write_text(text, encoding="utf-8")
            cases.append(_raised(
                name, source, inputs,
                lambda p=path: pr_review_findings.load_findings(p)))

    add("anchored-event", write_events([FINDING]))
    add("exact-duplicate-dropped", write_events([FINDING, FINDING]))
    add("differing-text-kept", write_events([
        FINDING, dict(FINDING, comment=FINDING_COMMENT + " more")]))
    add("line-order-normalised", write_events([
        dict(FINDING, startLine=END_LINE, endLine=ANCHORED_LINE)]))
    add("end-defaults-to-start", write_events([
        dict(FINDING, endLine=None)]))
    add("start-defaults-to-end", write_events([
        dict(FINDING, startLine=None)]))
    add("comment-falls-back-to-title", write_events([
        dict(FINDING, comment=None)]))
    add("severity-defaults-to-none", write_events([
        dict(FINDING, severity=None)]))
    add("missing-file-name", write_events([
        {k: v for k, v in FINDING.items() if k != "fileName"}]))
    add("file-name-not-string", write_events([
        dict(FINDING, fileName=7)]))
    add("bool-start-line", write_events([
        dict(FINDING, startLine=True, endLine=True)]))
    add("zero-start-line", write_events([
        dict(FINDING, startLine=0)]))
    add("negative-start-line", write_events([
        dict(FINDING, startLine=-2)]))
    add("float-start-line", write_events([
        dict(FINDING, startLine=2.0, endLine=3.0)]))
    add("huge-start-line", write_events([
        dict(FINDING, startLine=10 ** 30, endLine=10 ** 30 + 1)]))
    add("huge-start-only-defaults-end", write_events([
        dict(FINDING, startLine=10 ** 30, endLine=None)]))
    add("unicode-title-comment", write_events([
        dict(FINDING, title="Très — 😀", comment="À propos **b** <!-- x --> @user")]))
    add("astral-title-comment", write_events([
        dict(FINDING, title="😀🛠", comment="x" * 50 + "😀" * 50)]))
    add("nonfinding-events-skipped", write_events([
        {"type": "review", "severity": "major"}, {"type": "finding"}]) + "\n\n")
    add("malformed-lines-skipped", "{not json}\n[]\n" + write_events([FINDING]))
    add("empty-stream", "")
    add("whitespace-only-stream", "\n\n")
    add("severity-number", write_events([dict(FINDING, severity=7)]))
    add("title-number", write_events([dict(FINDING, title=7)]))
    add("title-whitespace-trimmed", write_events([
        dict(FINDING, title="  T  ", comment="  c  ")]))
    add("comment-whitespace-only-falls-back", write_events([
        dict(FINDING, comment="   ")]))
    add("non-dict-line-skipped", write_events([FINDING]) + "[1, 2]\n")
    add("nonfinite-constants", '{"type": "finding", "severity": NaN, "title": "t", "comment": "c"}\n')
    add("duplicate-key-last", write_events([
        json.loads('{"type": "finding", "severity": "minor", "severity": "major", '
                   '"title": "t", "comment": "c"}')]))
    add("raw-surrogate-escaped", '{"type": "finding", "severity": "s", "title": "\\ud800x", "comment": "c"}\n')
    return cases


def one_line_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.one_line"
    values: List[Tuple[str, Any]] = [
        ("plain", "MAJOR"),
        ("collapse-whitespace", "  a \t\n\n b  "),
        ("unicode", "  CRITICAL 😀 \t tab"),
        ("astral", "😀🛠 x"),
        ("html-comment-dropped", "MAJOR <!-- bot run 1 --> MAJOR"),
        ("multiline-html-comment", "a<!-- x\ny -->b"),
        ("mention-neutralised", "@user"),
        ("mention-in-code-span", "`@user`"),
        ("html-comment-open-neutralised", "a <!-- b"),
        ("empty", ""),
        ("whitespace-only", "   \n\t "),
        ("non-string-number", 5),
        ("non-string-none", None),
        ("non-string-list", [1, "a"]),
        ("non-string-dict", {"a": 1}),
        ("non-string-bool", True),
        ("non-string-float", 1.5),
        ("zwj-already-present", "a‍b"),
        ("comment-then-mention", "<!-- x --> @team"),
    ]
    return [
        _raised(name, source, {"text": text},
                lambda t=text: pr_review_findings.one_line(t))
        for name, text in values
    ]


def code_span_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.code_span"
    values: List[Tuple[str, Any]] = [
        ("plain", "src/a.py"),
        ("empty", ""),
        ("one-backtick", "a`b"),
        ("two-backticks", "a``b"),
        ("three-backticks", "```a```"),
        ("leading-backtick", "`x"),
        ("trailing-backtick", "x`"),
        ("both-ends", "`x`"),
        ("run-then-plain", "``a b"),
        ("unicode", "标题.py"),
        ("astral", "😀.py"),
        ("collapse-whitespace", "  a \n b "),
        ("non-string-number", 5),
        ("non-string-none", None),
        ("non-string-bool", True),
        ("non-string-float", -0.0),
        ("non-string-list", ["a"]),
    ]
    return [
        _raised(name, source, {"text": text},
                lambda t=text: pr_review_findings.code_span(t))
        for name, text in values
    ]


def clean_text_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.clean_text"
    cases: List[Dict[str, Any]] = []

    def add(name: str, text: Any, title: Any = _UNSET) -> None:
        inputs = {"text": text}
        if title is not _UNSET:
            inputs["title"] = title
            cases.append(_raised(
                name, source, inputs,
                lambda t=text, ti=title: pr_review_findings.clean_text(t, ti)))
        else:
            cases.append(_raised(
                name, source, inputs,
                lambda t=text: pr_review_findings.clean_text(t)))

    add("leading-bold-title-removed", "**Check the bound**\n\nOff by one.", "Check the bound")
    add("leading-bold-not-title-kept", "**Other** body", "Check the bound")
    add("title-with-regex-chars", "**C++ (x)**\n\nbody", "C++ (x)")
    add("title-no-match", "body", "**C++ (x)**")
    add("html-comment-dropped", "a<!-- foreign bot -->b")
    add("multiline-html-comment", "a<!-- x\ny -->b")
    add("suggestion-fence-demoted", "```suggestion\nline\n```")
    add("indented-suggestion-demoted", "   ```suggestion\nline\n```")
    add("suggestion-suffix-word-kept", "```suggestions\nline\n```")
    add("suggestion-dot-demoted", "```suggestion.\ny")
    add("suggestion-hyphen-demoted", "```suggestion-\ny")
    add("fence-mention-kept", "```py\n@user\n```")
    add("open-fence-closed", "```py\n@user")
    add("indented-close-lf", "```py\n@user\n   ```\n@after")
    add("indented-close-crlf", "```py\n@user\n   ```\r\n@after")
    add("indented-close-tab", "```py\n@user\n\t```\n@after")
    add("tilde-fence", "~~~\n@user\n~~~")
    add("tilde-fence-open-closed", "~~~md\n@user")
    add("mention-in-prose-neutralised", "ping @user and @types/node")
    add("mention-after-unicode-letter", "é@user")
    add("mention-after-digit", "x1@u")
    add("mention-after-hyphen", "-@user")
    add("mention-after-dot-kept", ".@user")
    add("mention-after-underscore-kept", "_@user")
    add("mention-after-slash-kept", "/@user")
    add("mention-in-code-span-kept", "`@user` stays")
    add("email-at-kept", "me@example.com")
    add("empty", "")
    add("whitespace-only", "  \n\t ")
    add("title-removed-then-fence", "**T**\n\n```suggestion\nx\n```", "T")
    add("non-string-text", 5)
    add("non-string-title", {"a": 1}, "x")
    add("text-with-codegen-fence", "```suggestion\nfix it\n```\n\nAlso @user.")
    return cases


def right_ranges_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.right_ranges"
    patches: List[Tuple[str, Any]] = [
        ("two-hunks", PATCH),
        ("empty", ""),
        ("none", None),
        ("not-a-patch", "not a patch"),
        ("single-line-hunk", "@@ -5 +6 @@"),
        ("zero-length-hunk", "@@ -5,0 +6,0 @@\n"),
        ("huge-hunk", "@@ -1 +999999,3 @@"),
        ("crlf-patch", "@@ -1,2 +1,2 @@\r\n a\r\n+b\r\n"),
        ("hunk-no-trailing-newline", "@@ -1 +2,1 @@"),
        ("indented-hunk", "   @@ -1,2 +3,4 @@"),
        ("middle-hunk", "context\n@@ -7,1 +8,2 @@\n a\n+ b\n"),
        ("astral-path-irrelevant", "@@ -1 +2 @@"),
        ("negative-not-matched", "@@ -1 +2,1 @@ extra"),
        ("unicode-digits-not-matched", "@@ -1 +٢,١ @@"),
        ("left-only-range", "@@ -10,5 +10 @@"),
    ]
    return [
        _raised(name, source, {"patch": patch},
                lambda p=patch: pr_review_findings.right_ranges(p))
        for name, patch in patches
    ]


def build_review_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.build_review"
    hunks = {FILE_NAME: pr_review_findings.right_ranges(PATCH)}
    meta_full = dict(META)
    cases: List[Dict[str, Any]] = []

    def add(name: str, meta: Any, findings: Any, diff: Any) -> None:
        inputs = {"meta": meta, "findings": findings, "hunks": diff}
        cases.append(_raised(
            name, source, inputs,
            lambda m=meta, f=findings, h=diff: pr_review_findings.build_review(m, f, h)))

    add("anchored-inline", meta_full, [dict(
        severity=SEVERITY, path=FILE_NAME, start=ANCHORED_LINE, end=END_LINE,
        title=FINDING_TITLE, text=FINDING_COMMENT)], hunks)
    add("body-only-no-diff", meta_full, [dict(
        severity=SEVERITY, path=FILE_NAME, start=ANCHORED_LINE, end=END_LINE,
        title=FINDING_TITLE, text=FINDING_COMMENT)], None)
    add("outside-diff-listed", meta_full, [dict(
        severity="minor", path=FILE_NAME, start=20, end=22,
        title="Rename", text="Rename it.")], hunks)
    add("no-path-listed", meta_full, [dict(
        severity="minor", path=None, start=1, end=1,
        title="Doc", text="Doc gap.")], hunks)
    add("local-review-label", dict(meta_full, label="Independent review by GLM-5.3-flash for " + HEAD),
        [dict(severity="none", path=None, start=None, end=None, title="T", text="x")], hunks)
    add("summary-and-label", dict(meta_full, label="L", summary="Sum"),
        [dict(severity="none", path=None, start=None, end=None, title="T", text="x")], hunks)
    add("empty-findings", meta_full, [], hunks)
    add("fifty-inline", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=1, end=1, title="t", text="x")
         for _ in range(50)], hunks)
    add("fifty-one-inline-fifty-first", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=1, end=1, title="t", text="x")
         for _ in range(51)], hunks)
    add("severity-summary-sorted", meta_full,
        [dict(severity="zig", path=None, start=None, end=None, title="a", text="x"),
         dict(severity="ABC", path=None, start=None, end=None, title="b", text="y"),
         dict(severity="Zig", path=None, start=None, end=None, title="c", text="z")], hunks)
    add("empty-severity-summary", meta_full,
        [dict(severity="", path=None, start=None, end=None, title="", text="")], hunks)
    add("none-severity-stringified", meta_full,
        [dict(severity=None, path=None, start=None, end=None, title=None, text=None)], hunks)
    add("unicode-heavy", meta_full,
        [dict(severity="重大", path="文件.py", start=1, end=2, title="标题 — 😀",
              text="😀 " * 20 + "```py\n@user\n```\n<!-- x -->")], hunks)
    add("multiline-unanchored", meta_full,
        [dict(severity="minor", path="docs/x.md", start=1, end=1, title="Doc",
              text="line one\nline two\n\n```\n@user\n```")], hunks)
    add("start-only-lines-suffix", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=5, end=None,
              title="t", text="x")], hunks)
    add("huge-start-anchored", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=10 ** 30, end=10 ** 30,
              title="t", text="x")], hunks)
    add("huge-range-clamps-outside", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=10 ** 30, end=10 ** 30 + 1,
              title="t", text="x")], hunks)
    add("single-line-comment-note", meta_full,
        [dict(severity="minor", path=FILE_NAME, start=2, end=2, title="t", text="x")], hunks)
    add("marker-idempotent-shape", dict(meta_full, run_id="r" * 100),
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], None)
    add("meta-missing-item-id", {"head": HEAD, "base": BASE, "run_id": RUN_ID},
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("meta-null-item-id", dict(meta_full, item_id=None),
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("meta-null-label", dict(meta_full, label=None),
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("meta-number-label", dict(meta_full, label=7),
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("meta-list-summary", dict(meta_full, summary=["a"]),
        [dict(severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("comment-clip-trailing-space", meta_full,
        [dict(severity="none", path=FILE_NAME, start=1, end=1, title="",
              text="y " * 6000)], hunks)
    add("comment-clip-exact", meta_full,
        [dict(severity="none", path=FILE_NAME, start=1, end=1, title="",
              text="y" * 11940)], hunks)
    add("comment-clip-just-over", meta_full,
        [dict(severity="none", path=FILE_NAME, start=1, end=1, title="",
              text="y" * 11941)], hunks)
    add("comment-clip-astral", meta_full,
        [dict(severity="none", path=FILE_NAME, start=1, end=1, title="",
              text="😀" * 4000)], hunks)
    add("clip-severs-fence-closed", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="```py\n@user\n" + "x" * 12000)], hunks)
    add("clip-keeps-closed-fence", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="```py\n@user\n```\n" + "x" * 12000)], hunks)
    add("clip-tab-fence-not-opened", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="prose\n\t```python\n@user\n" + "x" * 12000)], hunks)
    add("clip-tab-prefixed-closer-closes", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="```py\n@user\n\t```\n" + "x" * 12000)], hunks)
    add("clip-four-backtick-closed", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="````py\n@user\n" + "x" * 12000)], hunks)
    add("clip-five-tilde-closed", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="~~~~~md\n@user\n" + "x" * 12000)], hunks)
    add("body-cap-fence-closed", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="```py\n" + "x" * 12000) for _ in range(6)], hunks)
    add("body-cap-rescan-longer-bounded", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="",
              text="x" * 12000) for _ in range(4)]
        + [dict(severity="none", path=None, start=None, end=None, title="",
                text="x" * 100),
           dict(severity="none", path=None, start=None, end=None, title="",
                text="~" * 5600 + "\n" + "~" * 5600 + "\n```python\n" + "z" * 200)],
        None)
    add("body-cap-degenerate-trailing-spaces", dict(META, run_id="r-ok", summary="prose   \n" + "~" * 60000),
        [], None)
    add("body-truncated-large", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="t", text="q" * 30000),
         dict(severity="none", path=None, start=None, end=None, title="t", text="q" * 30000)],
        None)
    add("body-truncated-astral", meta_full,
        [dict(severity="none", path=None, start=None, end=None, title="t",
              text="😀" * 20000)], None)
    add("findings-not-a-list", meta_full, "x", hunks)
    add("finding-not-a-dict", meta_full, ["x"], hunks)
    add("meta-not-a-dict", [], [dict(
        severity="none", path=None, start=None, end=None, title="t", text="x")], hunks)
    add("hunks-file-missing", meta_full,
        [dict(severity="none", path="other.py", start=1, end=1, title="t", text="x")], hunks)
    add("prototype-path-listed", meta_full,
        [dict(severity="none", path="constructor", start=1, end=1, title="t", text="x")], hunks)
    add("proto-path-listed", meta_full,
        [dict(severity="none", path="__proto__", start=1, end=1, title="t", text="x")], hunks)
    add("tostring-path-listed", meta_full,
        [dict(severity="none", path="toString", start=1, end=1, title="t", text="x")], hunks)
    add("hunks-empty-dict", meta_full,
        [dict(severity="none", path=FILE_NAME, start=1, end=1, title="t", text="x")], {})
    add("mention-in-heading-neutralised", meta_full,
        [dict(severity="none", path=None, start=None, end=None,
              title="ping @user", text="x")], hunks)
    add("html-comment-in-heading-dropped", meta_full,
        [dict(severity="none", path=None, start=None, end=None,
              title="t <!-- x --> t", text="x")], hunks)
    return cases


def deliver_cases() -> List[Dict[str, Any]]:
    source = "pr_review_findings.deliver"
    marker_body = pr_review_findings.marker(RUN_ID) + " body"

    def reviews_page(*rows: Dict[str, Any]) -> str:
        """The raw API page real gh feeds to `--jq`: one JSON array."""
        return json.dumps(list(rows))

    cases: List[Dict[str, Any]] = []

    def add(name: str, repo: Any, pr: Any, meta: Any, events: Any, *,
            login: Any = _UNSET, gh: Any = None) -> None:
        stream = write_events(events) if isinstance(events, list) else events
        # The fake itself is not vector data; only the scripted overrides
        # (state, merged, head, reviews page, post results) are recorded so a
        # replay can rebuild an identical fake. The script snapshot must be
        # taken BEFORE deliver runs: EndpointGh consumes script entries as
        # calls arrive, and the recording happens after the call below.
        script_snapshot = list(gh.script) if isinstance(gh, EndpointGh) else []
        post_snapshot = list(gh.post) if isinstance(gh, EndpointGh) else []
        config: Dict[str, Any] = {}
        if isinstance(gh, EndpointGh):
            config = {
                "state": gh.state, "merged": gh.merged,
                "head": gh.head, "base": gh.base,
                "reviews": gh.reviews,
                "compare": gh.compare,
                "post": post_snapshot,
                "script": script_snapshot,
            }
        inputs: Dict[str, Any] = {
            "repo": repo, "pr": pr, "meta": meta, "events": stream,
            "gh": config,
        }
        if login is not _UNSET:
            inputs["login"] = login
        fake = EndpointGh() if gh is None else gh

        def call() -> Any:
            # deliver reads the ndjson before any identity or state check, so
            # every case runs against a real temp stream file.
            with tempfile.TemporaryDirectory() as root:
                path = Path(root) / "review.ndjson"
                path.write_text(stream, encoding="utf-8")
                return pr_review_findings.deliver(
                    repo, pr, dict(meta) if isinstance(meta, dict) else meta, path,
                    gh=fake, login=login if isinstance(login, str) else None)

        cases.append(_raised(name, source, inputs, call))
        cases[-1]["expect"]["calls"] = fake.calls

    nd = [FINDING]
    add("created-anchored", REPO, 77, dict(META, local_review=True), nd)
    add("created-with-login", REPO, 77, dict(META, local_review=True), nd,
        login="crq-host")
    add("existing-by-marker", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 7, "user": {"login": "crq-host"}, "body": marker_body,
             "html_url": "https://github.com/x/r/pull/77"})))
    add("existing-marker-other-author-ignored", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 8, "user": {"login": "someone-else"}, "body": marker_body,
             "url": "u"})))
    add("existing-marker-quoted-in-body-ignored", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 9, "user": {"login": "crq-host"},
             "body": "quoted: " + json.dumps(pr_review_findings.marker(RUN_ID)),
             "url": "u"})))
    add("skipped-closed", REPO, 77, META, nd,
        gh=EndpointGh(state="closed"))
    add("skipped-merged", REPO, 77, META, nd,
        gh=EndpointGh(state="open", merged=True))
    add("skipped-empty-no-summary", REPO, 77, META, [],
        gh=EndpointGh())
    add("skipped-empty-after-state", REPO, 77, META, [],
        gh=EndpointGh())
    add("skipped-empty-no-findings-with-summary", REPO, 77,
        dict(META, summary="Sum"), [], gh=EndpointGh())
    add("created-no-findings-summary-only", REPO, 77,
        dict(META, summary="Sum"), [], gh=EndpointGh())
    add("pr-state-exit-error", REPO, 77, META, nd,
        gh=EndpointGh(script=[ok("", "boom", 1)]))
    add("pr-state-timeout", REPO, 77, META, nd,
        gh=EndpointGh(script=[timeout_step(["gh", "api", f"repos/{REPO}/pulls/77"])]))
    add("pr-state-spawn-error", REPO, 77, META, nd,
        gh=EndpointGh(script=[{"raise": "oserror", "detail": "No such file"}]))
    add("pr-state-unparsable", REPO, 77, META, nd,
        gh=EndpointGh(script=[ok("{broken")]))
    add("pr-state-not-dict", REPO, 77, META, nd,
        gh=EndpointGh(script=[ok(json.dumps(["open"]))]))
    add("pr-state-unknown-state", REPO, 77, META, nd,
        gh=EndpointGh(state="mysterious"))
    # The failing step must land on the COMPARE call, so the passing pr_state
    # response is queued ahead of it (script steps feed the next call in
    # order) and the compare answer itself is a step on the compare branch.
    _prstate_ok = ok(json.dumps({"state": "open", "merged": False,
                                 "base": BASE, "head": HEAD}))
    add("compare-exit-error", REPO, 77, META, nd,
        gh=EndpointGh(script=[_prstate_ok],
                      compare=ok("", "no diff", 1)))
    add("compare-unparsable", REPO, 77, META, nd,
        gh=EndpointGh(script=[_prstate_ok],
                      compare=ok("[")))
    add("compare-files-not-list", REPO, 77, META, nd,
        gh=EndpointGh(script=[_prstate_ok],
                      compare=ok(json.dumps({"files": []}))))
    add("compare-removed-file-skipped", REPO, 77, META, nd,
        gh=EndpointGh(compare=ok(json.dumps([
            {"filename": "gone.py", "status": "removed", "patch": PATCH},
            {"filename": FILE_NAME, "status": "modified", "patch": PATCH}]))))
    add("compare-binary-no-patch-skipped", REPO, 77, META, nd,
        gh=EndpointGh(compare=ok(json.dumps([
            {"filename": "img.bin", "status": "modified", "patch": None}]))))
    add("post-422-falls-back-body-only", REPO, 77, META, nd,
        gh=EndpointGh(post=[ok("", "gh: HTTP 422: Validation Failed", 1),
                            ok(json.dumps(POSTED))]))
    add("post-422-with-summary-falls-back", REPO, 77,
        dict(META, summary="Run summary"), nd,
        gh=EndpointGh(post=[ok("", "gh: HTTP 422: Validation Failed", 1),
                            ok(json.dumps(POSTED))]))
    add("post-exit-error", REPO, 77, META, nd,
        gh=EndpointGh(post=[ok("", "server on fire", 1)]))
    add("post-timeout", REPO, 77, META, nd,
        gh=EndpointGh(post=[timeout_step(["gh", "api", "--method", "POST"])]))
    add("post-422-then-timeout", REPO, 77, META, nd,
        gh=EndpointGh(post=[ok("", "gh: HTTP 422: Validation Failed", 1),
                            timeout_step(["gh", "api", "--method", "POST"])]))
    add("post-unparsable-still-created", REPO, 77, META, nd,
        gh=EndpointGh(post=[ok("{nope")]))
    add("invalid-run-id", REPO, 77, dict(META, run_id="bad id"), nd,
        gh=EndpointGh())
    add("invalid-run-id-type", REPO, 77, dict(META, run_id=None), nd,
        gh=EndpointGh())
    add("invalid-repo", "ownér/repo", 77, META, nd, gh=EndpointGh())
    add("invalid-repo-leading-slash", "/owner", 77, META, nd,
        gh=EndpointGh())
    add("invalid-repo-trailing-slash", "owner/", 77, META, nd,
        gh=EndpointGh())
    add("invalid-repo-empty-side", "owner//repo", 77, META, nd,
        gh=EndpointGh())
    add("invalid-repo-connector-punct", "own‿﹏/repo", 77, META, nd,
        gh=EndpointGh())
    add("invalid-repo-two-slashes", "a/b/c", 77, META, nd, gh=EndpointGh())
    add("invalid-pr-zero", REPO, 0, META, nd, gh=EndpointGh())
    add("invalid-pr-float", REPO, 7.5, META, nd, gh=EndpointGh())
    add("invalid-pr-bool", REPO, True, META, nd, gh=EndpointGh())
    add("invalid-head-sha", REPO, 77, dict(META, head="abc"), nd,
        gh=EndpointGh())
    add("invalid-base-empty", REPO, 77, dict(META, base=""), nd,
        gh=EndpointGh())
    add("invalid-base-not-string", REPO, 77, dict(META, base=5), nd,
        gh=EndpointGh())
    add("invalid-login", REPO, 77, META, nd, login="bad login!",
        gh=EndpointGh())
    add("unicode-payload-created", REPO, 77, META,
        [dict(FINDING, title="标题", comment="😀 <!-- x --> @user")],
        gh=EndpointGh())
    add("astral-letter-mention-blocked", REPO, 77, META,
        [dict(FINDING, title="t", comment="𝔸@user stays literal")],
        gh=EndpointGh())
    add("connector-punct-mention-neutralised", REPO, 77, META,
        [dict(FINDING, title="t", comment="a‿@user hello")],
        gh=EndpointGh())
    add("local-review-head-moved-before-post", REPO, 77,
        dict(META, local_review=True), nd,
        gh=EndpointGh(head="c" * 40))
    add("reviews-array-page-crashes", REPO, 77, META, nd,
        gh=EndpointGh(reviews=json.dumps(
            [{"id": 7, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"))
    add("reviews-row-not-object", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 1, "user": {"login": "crq-host"}, "body": marker_body},
            ["row"])))
    add("reviews-two-page-stream", REPO, 77, META, nd,
        gh=EndpointGh(reviews=
            json.dumps([{"id": 5, "user": {"login": "crq-host"}, "body": "other"}]) + "\n"
            + json.dumps([{"id": 7, "user": {"login": "crq-host"}, "body": marker_body,
                           "html_url": "https://github.com/x/r/pull/77#review-7"}]) + "\n"))
    add("reviews-page-two-row-error", REPO, 77, META, nd,
        gh=EndpointGh(reviews=
            json.dumps([{"id": 1, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([["row"]]) + "\n"))
    add("reviews-page-three-row-error", REPO, 77, META, nd,
        gh=EndpointGh(reviews=
            json.dumps([{"id": 1, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([{"id": 2, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([["row"]]) + "\n"))
    add("reviews-page-two-row-error-no-newline", REPO, 77, META, nd,
        gh=EndpointGh(reviews=
            json.dumps([{"id": 1, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([["row"]])))
    add("reviews-page-three-row-error-no-newline", REPO, 77, META, nd,
        gh=EndpointGh(reviews=
            json.dumps([{"id": 1, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([{"id": 2, "user": {"login": "crq-host"}, "body": marker_body}]) + "\n"
            + json.dumps([["row"]])))
    add("reviews-row-id-float", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 7.5, "user": {"login": "crq-host"}, "body": marker_body})))
    add("reviews-row-id-bool", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": True, "user": {"login": "crq-host"}, "body": marker_body})))
    add("reviews-paginated", REPO, 77, META, nd,
        gh=EndpointGh(reviews=reviews_page(
            {"id": 5, "user": {"login": "crq-host"}, "body": "other"},
            {"id": 7, "user": {"login": "crq-host"}, "body": marker_body,
             "html_url": "https://github.com/x/r/pull/77#review-7"})))
    return cases


def document() -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/pr_review_findings_vector_emit_b1.py",
        "families": [
            {"family": "marker", "cases": marker_cases()},
            {"family": "load_findings", "cases": load_findings_cases()},
            {"family": "one_line", "cases": one_line_cases()},
            {"family": "code_span", "cases": code_span_cases()},
            {"family": "clean_text", "cases": clean_text_cases()},
            {"family": "right_ranges", "cases": right_ranges_cases()},
            {"family": "build_review", "cases": build_review_cases()},
            {"family": "deliver", "cases": deliver_cases()},
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
    payload = render().encode("utf-8")
    if args.stdout:
        sys.stdout.buffer.write(payload)
        return 0
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(payload)
        return 0
    if args.check:
        if not FIXTURE.exists() or FIXTURE.read_bytes() != payload:
            print(f"{FIXTURE} is stale; run python3 pr_review_findings_vector_emit_b1.py --write",
                  file=sys.stderr)
            return 1
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
