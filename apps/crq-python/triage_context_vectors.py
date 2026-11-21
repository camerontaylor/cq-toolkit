#!/usr/bin/env python3
"""Deterministic offline oracle for the TS inbox triage context assembly.

Test tooling only. It runs the PRODUCTION ``crq_repair.triage.context`` against
a repository whose every answer is a recorded fact, and records what Python
actually does: the packed context, the ordered repository reads, and the
exception class when the call fails.

Every external effect is injected. The repository is :class:`FakeRepo`: carry,
tree entries, blobs, ``git grep`` output and ``git log`` output come from the
case, and a case can make any of those raise a named exception. Nothing opens a
real repository, runs Git, reads a queue or ledger, calls a judge or provider,
or touches a host service. No production module is modified.

The TypeScript test (``test/policy/crq/triageContext.test.ts``) replays the same
facts through ``assembleTriageContext`` and compares the context, the exact
ordered reads and the error type. A case where Python raises something
``phase`` does not catch (``AttributeError``) records ``raises`` and the port
must refuse; a case flagged ``ts_refuses`` is one where Python's behaviour
depends on the live ``Repository`` internals for a type the ledger schema never
produces and the port is deliberately stricter.

Regenerate with ``python3 triage_context_vectors.py --write`` and verify with
``python3 triage_context_vectors.py --check``. Output is deterministic: sorted
keys, ``ensure_ascii``, no timestamps or host paths.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

import review_ledger as ledger
from crq_repair import triage
from triage_plan_vectors import ABSENT, BLOB, TARGET, TIP

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-context" / "cases.json"
SCHEMA = "cq.crq-triage-context-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair/triage.py"

CAUGHT = (KeyError, TypeError, ValueError, ledger.IntegrityError,
          subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError)
RAISERS = {
    "KeyError": lambda: KeyError("x"),
    "TypeError": lambda: TypeError("x"),
    "ValueError": lambda: ValueError("x"),
    "IntegrityError": lambda: ledger.IntegrityError("x"),
    "CalledProcessError": lambda: subprocess.CalledProcessError(1, "git"),
    "TimeoutExpired": lambda: subprocess.TimeoutExpired("git", 1),
    "OSError": lambda: OSError("x"),
}

PATH = "src/a.py"
CONTRACT = "docs/current-contract-and-backlog.md"
OID_A, OID_B, OID_C, OID_D, OID_E = ("1" * 40, "2" * 40, "3" * 40, "4" * 40, "5" * 40)
OLD_BLOB, TIP_BLOB, CONTRACT_BLOB = ("6" * 40, "7" * 40, "8" * 40)


def b64(value: str | bytes) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return base64.b64encode(raw).decode("ascii")


def numbered(prefix: str, count: int) -> str:
    return "".join("%s line %d content\n" % (prefix, number) for number in range(1, count + 1))


# ---------------------------------------------------------------------------
# The fake repository: records every read, answers from the case
# ---------------------------------------------------------------------------

class FakeRepo:
    def __init__(self, spec: dict, calls: list) -> None:
        self.spec = spec
        self.calls = calls

    def _fail(self, key: str) -> None:
        name = self.spec.get("failures", {}).get(key)
        if name is not None:
            raise RAISERS[name]()

    def begin_invocation(self) -> None:
        self.calls.append(["begin"])

    def carry(self, old, new, name, lines):
        # The live Repository raises TypeError for a non-string commit.
        if not isinstance(old, str) or not isinstance(new, str):
            raise TypeError("expected string or bytes-like object")
        self.calls.append(["carry", old, new, name, sorted(lines)])
        self._fail("carry")
        result = self.spec["carry"]
        return result["path"], set(result["lines"])

    def entries(self, commit):
        if not isinstance(commit, str):
            raise TypeError("expected string or bytes-like object")
        self.calls.append(["entries", commit])
        self._fail("entries:" + commit)
        return {path: {"blob": blob} for path, blob in self.spec["entries"][commit].items()}

    def git(self, *args, check=True):
        if args[:2] == ("cat-file", "blob"):
            self.calls.append(["blob", args[2]])
            self._fail("blob:" + args[2])
            return base64.b64decode(self.spec["blobs"][args[2]])
        if args[:4] == ("grep", "-n", "-F", "-e"):
            assert check is False and args[6] == "--"
            self.calls.append(["grep", args[4], args[5], args[7]])
            self._fail("grep")
            return base64.b64decode(self.spec["grep"])
        if args[:4] == ("log", "-n", "40", "--format=%H %s"):
            assert args[5] == "--"
            self.calls.append(["history", args[4], args[6]])
            self._fail("history")
            return base64.b64decode(self.spec["history"])
        raise AssertionError("unexpected git read: %r" % (args,))


# ---------------------------------------------------------------------------
# Case construction
# ---------------------------------------------------------------------------

def finding(**over) -> dict:
    value = {
        "id": "f1", "severity": "major", "path": PATH, "title": "Title", "body": "Body",
        "anchor_status": "verified", "blob": BLOB, "intervals": [[3, 4]],
    }
    value.update(over)
    return {k: v for k, v in value.items() if v is not ABSENT}


def make_row(*, row_over=None, **finding_over) -> dict:
    value = {"finding": finding(**finding_over), "status": "untriaged", "review_id": "r1",
             "target": TARGET, "previous_event_id": None}
    value.update(row_over or {})
    return {k: v for k, v in value.items() if v is not ABSENT}


def case(name: str, row: dict | None = None, *, escalate=False, tip=TIP, ts_refuses=False, **over) -> dict:
    spec = {
        "name": name, "kind": "context", "row": make_row() if row is None else row,
        "tip": tip, "escalate": escalate, "ts_refuses": ts_refuses,
        "carry": {"path": PATH, "lines": [3, 4]},
        "entries": {TIP: {PATH: TIP_BLOB}, TARGET: {PATH: OLD_BLOB}},
        "blobs": {TIP_BLOB: b64(numbered("tip", 60)), OLD_BLOB: b64(numbered("old", 8))},
        "grep": b64(""), "history": b64(""), "failures": {},
    }
    spec.update(over)
    return spec


def with_blobs(**blobs) -> dict:
    return {key: b64(value) for key, value in blobs.items()}


# ---------------------------------------------------------------------------
# Running Python
# ---------------------------------------------------------------------------

def run_context(spec: dict) -> dict:
    calls: list = []
    repo = FakeRepo(spec, calls)
    row = json.loads(json.dumps(spec["row"]))
    if spec["escalate"]:
        row["_escalate"] = True
    try:
        packed = triage.context(repo, row, spec["tip"])
    except CAUGHT as exc:
        return {"error": {"type": type(exc).__name__}, "calls": calls}
    except (AttributeError, IndexError, RuntimeError) as exc:
        return {"raises": type(exc).__name__, "calls": calls}
    return {"result": json.loads(json.dumps(packed)), "calls": calls}


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def excerpt_case(name: str, content: str, body: str, *, path: str = PATH, extra_files=None, **over) -> dict:
    """An escalated context whose primary file is ``content`` and whose finding body is ``body``."""
    files = {path: content, **(extra_files or {})}
    blobs = {TIP_BLOB: b64(numbered("tip", 60)), OLD_BLOB: b64(numbered("old", 8))}
    entries = {path: TIP_BLOB}
    for index, (file_path, text) in enumerate(files.items(), start=1):
        oid = ("%x" % (0xa0 + index)) * 20
        blobs[oid] = b64(text)
        entries[file_path] = oid
    return case(name, make_row(path=path, body=body, intervals=[]), escalate=True,
                carry={"path": None, "lines": []},
                entries={TIP: entries, TARGET: {path: OLD_BLOB}}, blobs=blobs, **over)


def cases() -> list[dict]:
    out: list[dict] = []
    add = out.append

    # --- numbers in the finding survive packing exactly ------------------------
    # JSON.parse rounds 2**53 + 1, so these only hold when the port retains
    # the integer lexeme and the float kind through to the packed context.
    add(case("finding-keeps-integers-beyond-two-to-the-53",
             make_row(metadata={"sequence": 9007199254740993, "negative": -9007199254740993,
                                "huge": 10 ** 40, "small": 7})))
    add(case("finding-keeps-float-kind-and-repr",
             make_row(metadata={"whole": 1.0, "exponent": 1e22, "tenth": 0.1, "negative_zero": -0.0,
                                "nested": [{"score": 2.50}, 3]})))

    # --- the window around the carried lines ---------------------------------
    add(case("anchored-window-around-carried-lines", carry={"path": PATH, "lines": [30, 33]}))
    add(case("window-clamps-at-file-start", carry={"path": PATH, "lines": [2]}))
    add(case("window-clamps-at-file-end", carry={"path": PATH, "lines": [58, 60]}))
    add(case("window-start-beyond-end-is-empty", carry={"path": PATH, "lines": [500]}))
    add(case("unanchored-finding-takes-the-first-window", make_row(intervals=[]),
             carry={"path": None, "lines": []}))
    add(case("falsy-intervals-are-not-anchored",
             make_row(intervals=0), carry={"path": None, "lines": []}))
    add(case("missing-intervals-key-is-not-anchored",
             make_row(intervals=ABSENT), carry={"path": None, "lines": []}))
    add(case("carry-path-renames-the-tip-file", carry={"path": "src/renamed.py", "lines": [3]},
             entries={TIP: {"src/renamed.py": TIP_BLOB, PATH: OID_A}, TARGET: {PATH: OLD_BLOB}}))
    add(case("carry-returns-no-path-falls-back-to-finding-path", carry={"path": None, "lines": []}))
    add(case("carry-returns-empty-path-falls-back-to-finding-path", carry={"path": "", "lines": []}))
    add(case("name-absent-from-tip-gives-no-region", carry={"path": "src/gone.py", "lines": [3]}))
    add(case("recovered-anchor-supplies-intervals-and-path",
             make_row(row_over={"recovered_anchor": {"path": "src/moved.py", "blob": BLOB,
                                                     "intervals": [[5, 6], [9, 9]]}}, intervals=[]),
             carry={"path": "src/moved.py", "lines": [5, 9]},
             entries={TIP: {"src/moved.py": TIP_BLOB}, TARGET: {PATH: OLD_BLOB}}))
    add(case("tip-file-with-unicode-line-separators",
             carry={"path": PATH, "lines": [2, 3]},
             blobs=with_blobs(**{TIP_BLOB: "a\x0bb\x0cc\x1cd\x1de\x1ef\x85g h i\r\nj\rk\nl\n",
                                 OLD_BLOB: "x"})))
    add(case("tip-file-with-invalid-utf8-is-replaced", carry={"path": PATH, "lines": [1]},
             blobs={TIP_BLOB: b64(b"ok\xff\xfe\n\xed\xa0\x80 surrogate\n\xf0\x9f\x98 truncated\n\xc0\xaf over\nend\xe2\x82"),
                    OLD_BLOB: b64(b"old\xff\n")}))
    add(case("tip-file-bom-is-kept", carry={"path": PATH, "lines": [1]},
             blobs={TIP_BLOB: b64(b"\xef\xbb\xbfbom line\nsecond\n"), OLD_BLOB: b64("x")}))
    add(case("empty-tip-file", carry={"path": PATH, "lines": [1]}, blobs=with_blobs(**{TIP_BLOB: "", OLD_BLOB: "x"})))
    add(case("tip-file-without-trailing-newline", carry={"path": PATH, "lines": [2]},
             blobs=with_blobs(**{TIP_BLOB: "a\nb\nc", OLD_BLOB: "x"})))

    # --- the original region and the content search --------------------------
    add(case("original-region-joins-selected-old-lines",
             make_row(intervals=[[2, 3], [6, 6]]),
             carry={"path": PATH, "lines": [2]}))
    add(case("original-region-skips-lines-beyond-the-old-file",
             make_row(intervals=[[2, 2], [7, 20]]), carry={"path": PATH, "lines": [2]}))
    add(case("original-region-is-capped-at-16000-code-points",
             make_row(intervals=[[1, 1]]), carry={"path": PATH, "lines": [1]},
             blobs=with_blobs(**{TIP_BLOB: "tip\n", OLD_BLOB: "x" * 15998 + "\U0001F600\U0001F601\U0001F602\nsecond line is long enough\n"})))
    add(case("no-grep-when-carry-found-lines",
             make_row(intervals=[[2, 2]]), carry={"path": PATH, "lines": [4]},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "a\nthis line is long enough\nc\n"}),
             grep=b64("SHOULD-NOT-BE-READ")))
    add(case("grep-runs-when-carry-lost-the-lines",
             make_row(intervals=[[2, 2]]), carry={"path": None, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "a\n   padded needle line   \nc\n"}),
             grep=b64("src/a.py:7:padded needle line\n")))
    add(case("needle-is-the-first-stripped-line-of-twelve-or-more",
             make_row(intervals=[[1, 3]]), carry={"path": PATH, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10),
                                 OLD_BLOB: "short\n 　exactly12chr \nlonger than twelve\n"}),
             grep=b64("hit\n")))
    add(case("needle-of-eleven-characters-does-not-qualify",
             make_row(intervals=[[1, 2]]), carry={"path": PATH, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "short\n eleven-chr\n"}),
             grep=b64("SHOULD-NOT-BE-READ")))
    add(case("needle-is-capped-at-200-code-points",
             make_row(intervals=[[1, 1]]), carry={"path": PATH, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "\U0001F600" * 300 + "\n"}),
             grep=b64("hit\n")))
    add(case("grep-output-is-capped-and-decoded-with-replacement",
             make_row(intervals=[[1, 1]]), carry={"path": PATH, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "a long enough needle line\n"}),
             grep=b64(b"\xff" + b"x" * 15997 + "\U0001F600\U0001F601\U0001F602".encode())))
    add(case("old-file-line-separators-split-the-original",
             make_row(intervals=[[1, 3]]), carry={"path": PATH, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10),
                                 OLD_BLOB: "a needle line is long c\n"}),
             grep=b64("hit\n")))

    # --- the current contract -------------------------------------------------
    contract_entries = {TIP: {PATH: TIP_BLOB, CONTRACT: CONTRACT_BLOB}, TARGET: {PATH: OLD_BLOB}}
    add(case("contract-absent"))
    add(case("contract-present-and-short", entries=contract_entries,
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    CONTRACT_BLOB: b64("# Contract\nbody\n")}))
    add(case("contract-exactly-at-the-limit", entries=contract_entries,
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    CONTRACT_BLOB: b64("x" * 24000)}))
    add(case("contract-truncated-by-code-point", entries=contract_entries,
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    CONTRACT_BLOB: b64("x" * 23999 + "\U0001F600\U0001F601\U0001F602")}))
    add(case("contract-with-invalid-utf8", entries=contract_entries,
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    CONTRACT_BLOB: b64(b"a\xffb\xed\xa0\x80c")}))
    add(case("empty-contract-blob-is-present", entries=contract_entries,
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    CONTRACT_BLOB: b64("")}))

    # --- history --------------------------------------------------------------
    add(case("history-is-capped-at-16000-code-points",
             history=b64(b"x" * 15999 + "\U0001F600\U0001F601\U0001F602".encode())))
    add(case("history-with-invalid-utf8", history=b64(b"abc def\xff\n")))

    # --- escalation: additional sources ---------------------------------------
    small = "alpha\nbeta\ngamma\n"
    add(case("escalate-off-reads-no-additional-sources",
             make_row(body="see src/b.py and docs/x.md"),
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64(small)}))
    add(case("escalate-reads-the-file-then-cited-paths-in-body-order",
             make_row(title="mentions lib/t.py", body="also src/b.py then docs/x.md then lib/t.py"),
             escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A, "docs/x.md": OID_B, "lib/t.py": OID_C}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    OID_A: b64(small), OID_B: b64("docs\n"), OID_C: b64("tool\n")}))
    add(case("escalate-stops-at-three-sources",
             make_row(body="a/b.py c/d.py e/f.py g/h.py"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "a/b.py": OID_A, "c/d.py": OID_B, "e/f.py": OID_C, "g/h.py": OID_D}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    OID_A: b64("a\n"), OID_B: b64("b\n"), OID_C: b64("c\n"), OID_D: b64("d\n")}))
    add(case("escalate-skips-paths-not-in-the-tree-and-dedupes",
             make_row(body="src/b.py src/b.py nowhere/x.py src/b.py"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64("b\n")}))
    add(case("escalate-trailing-dots-are-stripped-only-for-missing-paths",
             make_row(body="see src/b.py. and src/c.py.. and dotted.dir/f.py."), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A, "src/c.py": OID_B, "dotted.dir/f.py.": OID_C}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}),
                    OID_A: b64("b\n"), OID_B: b64("c\n"), OID_C: b64("f\n")}))
    add(case("escalate-path-pattern-is-ascii-only",
             make_row(body="x/é.py é/y.py a b/c-d_e.f/g"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "b/c-d_e.f/g": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64("g\n")}))
    add(case("escalate-falsy-title-and-body-are-empty-strings",
             make_row(title="", body=""), escalate=True))
    add(case("escalate-title-and-body-join-with-one-space",
             make_row(title="see src/b.py", body="/c.py"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64("b\n")}))
    add(case("escalate-a-secondary-file-with-invalid-utf8",
             make_row(body="src/b.py"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64(b"\xffb\xed\xa0\x80\n")}))

    # --- source_excerpt -------------------------------------------------------
    big = numbered("big", 600)                      # well over 8000 characters
    assert len(big) > 8000
    add(excerpt_case("excerpt-small-file-is-whole", small, "src/a.py:2"))
    add(excerpt_case("excerpt-file-at-the-8000-boundary", "x" * 8000, "src/a.py:2"))
    add(excerpt_case("excerpt-file-one-past-the-boundary-without-citation", "x" * 8001, "nothing cited"))
    add(excerpt_case("excerpt-big-file-without-citations-is-a-prefix", big, "nothing cited"))
    add(excerpt_case("excerpt-big-file-with-one-citation", big, "see src/a.py:300"))
    add(excerpt_case("excerpt-citation-before-line-21-starts-at-the-top", big, "src/a.py:3 and src/a.py:21 and src/a.py:22"))
    add(excerpt_case("excerpt-duplicate-citations-collapse", big, "src/a.py:300 src/a.py:300 src/a.py:300"))
    add(excerpt_case("excerpt-citations-after-the-first-four-are-ignored", big,
                     "src/a.py:100 src/a.py:200 src/a.py:300 src/a.py:400 src/a.py:500"))
    add(excerpt_case("excerpt-all-citations-past-the-end-fall-back-to-a-prefix", big, "src/a.py:9000 src/a.py:9999"))
    add(excerpt_case("excerpt-one-citation-past-the-end-is-skipped", big, "src/a.py:9000 src/a.py:100"))
    add(excerpt_case("excerpt-citation-at-the-last-line", big, "src/a.py:600"))
    add(excerpt_case("excerpt-region-text-is-capped-at-2000", "".join("x" * 500 + "\n" for _ in range(40)), "src/a.py:10"))
    add(excerpt_case("excerpt-budget-runs-out-across-regions",
                     "".join("y" * 300 + "\n" for _ in range(60)),
                     "src/a.py:8 src/a.py:20 src/a.py:32 src/a.py:44"))
    add(excerpt_case("excerpt-code-point-budget-with-astral-text",
                     "".join("a" * 30 + "\U0001F600" * 5 + "\n" for _ in range(300)), "src/a.py:100 src/a.py:200"))
    add(excerpt_case("excerpt-keepends-with-unicode-separators",
                     "".join("a b\x0cc\r\nd\re\n" * 3 for _ in range(400)), "src/a.py:100"))
    add(excerpt_case("excerpt-citations-do-not-overlap", big, "src/a.py:5src/a.py:100src/a.py:200"))
    add(excerpt_case("excerpt-citation-needs-a-digit", big, "src/a.py: 100 src/a.py:x src/a.py:"))
    add(excerpt_case("excerpt-other-files-citations-are-ignored", big, "lib/other.py:100",
                     extra_files={"lib/other.py": numbered("o", 5)}))
    add(excerpt_case("excerpt-unicode-digits-in-a-citation", big, "src/a.py:٣٠٠ and src/a.py:１００"))
    add(excerpt_case("excerpt-math-digits-in-a-citation", big, "src/a.py:\U0001D7D8\U0001D7E0\U0001D7ECx"))
    add(excerpt_case("excerpt-citation-with-leading-zeros", big, "src/a.py:000000200"))
    add(excerpt_case("excerpt-special-characters-in-the-path-are-literal",
                     big, "src/a+b[1].py:100", path="src/a+b[1].py"))
    add(excerpt_case("excerpt-path-with-regex-dot-is-literal", big, "srcXa.py:100 src/a.py:101", path="src/a.py"))
    add(excerpt_case("excerpt-4300-digit-citation-is-past-the-end", big, "src/a.py:" + "9" * 4300))
    add(excerpt_case("excerpt-4301-digit-citation-is-a-value-error", big, "src/a.py:" + "9" * 4301))
    add(excerpt_case("excerpt-4301-digit-with-leading-zeros-is-a-value-error", big, "src/a.py:" + "0" * 4300 + "7"))
    add(excerpt_case("excerpt-4301-unicode-digits-are-a-value-error", big, "src/a.py:" + "٣" * 4301))
    add(excerpt_case("excerpt-oversize-citation-after-a-small-file-is-still-a-value-error", small,
                     "src/a.py:2 src/a.py:" + "1" * 4301))
    add(excerpt_case("excerpt-oversize-citation-beyond-the-first-four-is-still-a-value-error", big,
                     "src/a.py:1 src/a.py:2 src/a.py:3 src/a.py:4 src/a.py:5 src/a.py:" + "1" * 4301))
    # primary-file line citations
    add(excerpt_case("excerpt-primary-lines-citations", big, "problem at line 120 and lines 300"))
    add(excerpt_case("excerpt-primary-line-citation-is-case-insensitive", big, "LINE 120 Lines 300 LiNe 400"))
    add(excerpt_case("excerpt-primary-line-turkic-i-and-long-s", big,
                     "LİNE 120 lıne 200 lineſ 300 LINES 400"))
    add(excerpt_case("excerpt-primary-line-whitespace-forms", big,
                     "line 120 line　200 line\t\n300 line\x1c400 line\x85500"))
    add(excerpt_case("excerpt-primary-line-needs-whitespace-and-a-digit", big,
                     "line120 line x line  line s 5 lines: 6 inline 7 outlines 8"))
    add(excerpt_case("excerpt-primary-line-unicode-digits", big, "line ٤٠٠ lines ２００"))
    add(excerpt_case("excerpt-primary-line-inside-a-word", big, "pipeline 120 headlines 220"))
    add(excerpt_case("excerpt-primary-lines-come-after-path-citations", big,
                     "line 500 src/a.py:100 line 400 src/a.py:200 line 300"))
    add(excerpt_case("excerpt-line-words-ignored-for-a-secondary-file", big, "line 100 and lines 200 lib/o.py:300",
                     path="src/b.py", extra_files={"lib/o.py": big}))
    add(excerpt_case("excerpt-line-words-ignored-with-a-small-primary", small, "line 2"))
    add(excerpt_case("excerpt-4301-digit-line-number-is-a-value-error", big, "line " + "7" * 4301))

    # --- failures Python's phase catches --------------------------------------
    for exception in RAISERS:
        add(case("failure-carry-" + exception, failures={"carry": exception}))
        add(case("failure-tip-entries-" + exception, failures={"entries:" + TIP: exception}))
        add(case("failure-tip-blob-" + exception, failures={"blob:" + TIP_BLOB: exception}))
        add(case("failure-target-entries-" + exception, failures={"entries:" + TARGET: exception}))
        add(case("failure-old-blob-" + exception, failures={"blob:" + OLD_BLOB: exception}))
        add(case("failure-history-" + exception, failures={"history": exception}))
    add(case("failure-grep-OSError", make_row(intervals=[[2, 2]]), carry={"path": None, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "a\nneedle line long enough\n"}),
             failures={"grep": "OSError"}))
    add(case("failure-grep-TimeoutExpired", make_row(intervals=[[2, 2]]), carry={"path": None, "lines": []},
             blobs=with_blobs(**{TIP_BLOB: numbered("tip", 10), OLD_BLOB: "a\nneedle line long enough\n"}),
             failures={"grep": "TimeoutExpired"}))
    add(case("failure-contract-blob-CalledProcessError",
             entries={TIP: {PATH: TIP_BLOB, CONTRACT: CONTRACT_BLOB}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), CONTRACT_BLOB: b64("c")},
             failures={"blob:" + CONTRACT_BLOB: "CalledProcessError"}))
    add(case("failure-extra-source-blob-OSError", make_row(body="src/b.py"), escalate=True,
             entries={TIP: {PATH: TIP_BLOB, "src/b.py": OID_A}, TARGET: {PATH: OLD_BLOB}},
             blobs={**with_blobs(**{TIP_BLOB: numbered("tip", 60), OLD_BLOB: numbered("old", 8)}), OID_A: b64("b\n")},
             failures={"blob:" + OID_A: "OSError"}))
    add(case("failure-first-error-wins-carry-before-entries",
             failures={"carry": "OSError", "entries:" + TIP: "ValueError"}))
    add(case("failure-target-path-missing-from-target-tree-is-a-key-error",
             entries={TIP: {PATH: TIP_BLOB}, TARGET: {"src/other.py": OLD_BLOB}}))
    add(case("failure-target-tree-not-read-without-anchor", make_row(intervals=[]),
             carry={"path": None, "lines": []}, entries={TIP: {PATH: TIP_BLOB}}))

    # --- damaged rows ---------------------------------------------------------
    add(case("row-without-finding-is-a-key-error", {"target": TARGET}))
    add(case("anchored-row-without-target-is-a-key-error", make_row(row_over={"target": ABSENT})))
    add(case("unanchored-row-without-target-is-a-key-error-after-reads",
             make_row(intervals=[], row_over={"target": ABSENT}), carry={"path": None, "lines": []}))
    add(case("recovered-anchor-without-path-is-a-key-error",
             make_row(row_over={"recovered_anchor": {"blob": BLOB, "intervals": [[1, 1]]}})))
    add(case("anchored-non-string-target-is-a-type-error", make_row(row_over={"target": 5})))
    add(case("unanchored-non-string-target-is-a-type-error-at-history",
             make_row(intervals=[], row_over={"target": ["x"]}), carry={"path": None, "lines": []}))
    add(case("anchored-path-missing-from-finding-after-carry-fallback",
             make_row(path=ABSENT, intervals=[[1, 1]], row_over={"recovered_anchor": {"path": "src/a.py", "intervals": [[1, 1]]}}),
             carry={"path": None, "lines": []}))
    for label, intervals in {
        "intervals-overlap": [[1, 3], [3, 4]],
        "intervals-descending": [[5, 6], [1, 2]],
        "intervals-end-before-start": [[4, 2]],
        "intervals-zero-start": [[0, 2]],
        "intervals-negative": [[-3, 2]],
        "intervals-past-the-million-line-bound": [[1, 1000001]],
        "intervals-total-past-the-bound": [[1, 600000], [600001, 1000001]],
        "intervals-float-bound": [[1, 2.5]],
        "intervals-bool-bound": [[True, 2]],
        "intervals-string-bounds": [["1", "2"]],
        "intervals-null-bound": [[None, 2]],
        "intervals-three-element-pair-is-a-value-error": [[1, 2, 3]],
        "intervals-one-element-pair-is-a-value-error": [[1]],
        "intervals-empty-pair-is-a-value-error": [[]],
        "intervals-int-element-is-a-type-error": [5],
        "intervals-null-element-is-a-type-error": [None],
        "intervals-bool-element-is-a-type-error": [True],
        "intervals-two-char-string-element-is-an-integrity-error": ["ab"],
        "intervals-three-char-string-element-is-a-value-error": ["abc"],
        "intervals-empty-string-element-is-a-value-error": [""],
        "intervals-astral-pair-string-element-is-an-integrity-error": ["\U0001F600\U0001F601"],
        "intervals-two-key-object-element-is-an-integrity-error": [{"a": 1, "b": 2}],
        "intervals-one-key-object-element-is-a-value-error": [{"a": 1}],
        "intervals-empty-object-element-is-a-value-error": [{}],
        "intervals-valid-then-bad-shape": [[1, 2], [5]],
        "intervals-bad-integrity-before-bad-shape": [[3, 4], [1, 2], [5]],
        "intervals-bad-shape-before-bad-integrity": [[1, 2], 5, [1, 1]],
        "intervals-string-value-is-a-value-error": "abc",
        "intervals-two-char-string-value-is-a-value-error": "ab",
        "intervals-int-value-is-a-type-error": 5,
        "intervals-float-value-is-a-type-error": 1.5,
        "intervals-true-value-is-a-type-error": True,
        "intervals-object-value-is-a-value-error": {"a": 1},
        "intervals-two-key-object-value-is-a-value-error": {"a": 1, "b": 2},
        "intervals-two-char-key-object-value-is-an-integrity-error": {"ab": 1},
        "intervals-nested-value-error-order": [[1, 2], "x"],
        "intervals-end-one-past-the-ceiling-is-an-integrity-error": [[1000001, 1000001]],
        "intervals-range-past-the-ceiling-is-an-integrity-error": [[3, 1000001]],
    }.items():
        add(case("damaged-" + label, make_row(intervals=intervals), carry={"path": PATH, "lines": [1]}))
    add(case("intervals-end-at-the-ceiling-is-accepted", make_row(intervals=[[1000000, 1000000]]),
             carry={"path": PATH, "lines": [1000000]}))
    add(case("recovered-anchor-damaged-intervals-win-over-the-finding",
             make_row(row_over={"recovered_anchor": {"path": PATH, "blob": BLOB, "intervals": [[2, 1]]}})))

    # --- Python raises something phase does not catch -------------------------
    add(case("finding-that-is-an-array-raises-attribute-error", {"finding": [1], "target": TARGET}))
    add(case("finding-that-is-a-string-raises-attribute-error", {"finding": "x", "target": TARGET}))
    add(case("finding-that-is-null-raises-attribute-error", {"finding": None, "target": TARGET}))

    # --- Python is lenient or repository-dependent; the port is stricter -------
    add(case("ts-stricter-non-string-finding-path", make_row(path=5, intervals=[]),
             carry={"path": None, "lines": []}, ts_refuses=True))
    add(case("ts-stricter-null-finding-path", make_row(path=None, intervals=[]),
             carry={"path": None, "lines": []}, ts_refuses=True))
    add(case("ts-stricter-non-string-recovered-anchor-path",
             make_row(row_over={"recovered_anchor": {"path": 5, "blob": BLOB, "intervals": [[1, 1]]}}),
             carry={"path": None, "lines": []}, ts_refuses=True))
    add(case("ts-stricter-non-string-title", make_row(title=5), escalate=True, ts_refuses=True))
    add(case("ts-stricter-non-string-body", make_row(body=["x"]), escalate=True, ts_refuses=True))

    return out


def run_case(spec: dict) -> dict:
    out = run_context(spec)
    expected = {"name": spec["name"], "kind": spec["kind"],
                "input": {k: v for k, v in spec.items() if k not in ("name", "kind", "ts_refuses")},
                "ts_refuses": spec["ts_refuses"]}
    expected.update(out)
    return expected


def build() -> dict:
    results = [run_case(spec) for spec in cases()]
    names = [item["name"] for item in results]
    if len(names) != len(set(names)):
        raise AssertionError("duplicate vector case names")
    return {"schema": SCHEMA, "source": SOURCE_PATH,
            "constants": {"tip": TIP, "target": TARGET, "path": PATH, "contract": CONTRACT},
            "cases": results}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq triage-context oracle fixture")
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
        print("triage-context fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
