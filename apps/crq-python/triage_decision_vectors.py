#!/usr/bin/env python3
"""Deterministic offline oracle for the TS triage ``decision`` port.

Test tooling only. It drives the PRODUCTION ``crq_repair.triage.decision`` with
an injected fake repository and records what Python actually decides: the
``(status, reason, extras)`` tuple, the ordered repository reads, and, when
Python raises, the exception class and whether the repository injected it.

Every Git fact is supplied by the case: ``resolve`` answers, raw ``git``
stdout bytes (hex), ``lineage`` results and ``entries`` blobs, each of which
may instead raise a named exception. A read the case did not provide raises
``AssertionError``, which ``decision`` never catches, so an unexpected read
aborts ``build()`` instead of being recorded. No production module is modified
and no repository, queue, state, network, model, signer or host service is
touched.

The TypeScript test (``test/policy/crq/triageDecision.test.ts``) replays the
same facts through ``triageDecision`` and compares the tuple and the read
order. Cases where Python raises an uncaught ``KeyError``/``AttributeError``
(not injected by the repository) record the class name and the port refuses;
an exception the repository injected must propagate unchanged. Cases flagged
``ts_refuses`` are ones where Python is lenient about a type the ledger schema
never produces and the port is deliberately stricter.

Rows and reports are stored as ordered JSON text (``row_json`` /
``report_json``): the fixture is written with ``sort_keys=True``, which would
otherwise reorder them.

Regenerate with ``python3 triage_decision_vectors.py --write`` and verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import review_ledger as ledger
from crq_repair import triage

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-decision" / "cases.json"
SCHEMA = "cq.crq-triage-decision-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair/triage.py"

TIP = "b" * 40
TARGET = "a" * 40
COMMIT = "d" * 40
OTHER = "e" * 40
BLOB = "c" * 40
PATH = "src/a.py"

EXCEPTIONS = {
    "KeyError": lambda: KeyError("x"),
    "TypeError": lambda: TypeError("x"),
    "ValueError": lambda: ValueError("x"),
    "IntegrityError": lambda: ledger.IntegrityError("x"),
    "CalledProcessError": lambda: subprocess.CalledProcessError(1, "git"),
    "TimeoutExpired": lambda: subprocess.TimeoutExpired("git", 1),
    "OSError": lambda: OSError("x"),
    "UnicodeDecodeError": lambda: UnicodeDecodeError("utf-8", b"\xff", 0, 1, "x"),
}


def dump(value) -> str:
    return json.dumps(value, ensure_ascii=True)


def hexed(text: str) -> str:
    return text.encode("utf-8").hex()


class FakeRepo:
    def __init__(self, spec: dict) -> None:
        self.spec = spec
        self.calls: list[list] = []
        self.injected: str | None = None

    def _answer(self, table: dict, key: str, what: str):
        if key not in table:
            raise AssertionError("unexpected %s: %s" % (what, key))
        entry = table[key]
        if "raises" in entry:
            self.injected = entry["raises"]
            raise EXCEPTIONS[entry["raises"]]()
        return entry

    def resolve(self, value):
        self.calls.append(["resolve", value])
        return self._answer(self.spec["resolve"], dump(value), "resolve")["result"]

    def git(self, *args):
        self.calls.append(["git", *args])
        return bytes.fromhex(self._answer(self.spec["git"], dump(list(args)), "git")["hex"])

    def lineage(self, target, commit, path):
        self.calls.append(["lineage", target, commit, path])
        return self._answer(self.spec["lineage"], dump([target, commit, path]), "lineage")["result"]

    def entries(self, tip):
        self.calls.append(["entries", tip])
        repo = self

        class Entries:
            def __getitem__(self, path):
                repo.calls.append(["entry", dump(path)])
                table = repo.spec["entries"]
                key = dump(path)
                if key not in table:
                    raise KeyError(path)
                return {"blob": repo._answer(table, key, "entry")["blob"]}

        return Entries()


def run_python(spec: dict) -> dict:
    repo = FakeRepo(spec)
    row = json.loads(spec["row_json"])
    report = json.loads(spec["report_json"])
    try:
        status, reason, extras = triage.decision(repo, row, TIP, report)
    except AssertionError:
        raise
    except Exception as exc:  # noqa: BLE001 - the class name is the recorded fact
        name = type(exc).__name__
        return {"calls": repo.calls, "raises": name, "injected": repo.injected == name}
    return {"calls": repo.calls, "status": status, "reason": reason, "extras_json": dump(extras)}


# ---------------------------------------------------------------------------
# Case construction
# ---------------------------------------------------------------------------

ABSENT = object()


def base_row(**over) -> dict:
    value = {"target": TARGET, "finding": {"path": PATH, "id": "f1"}}
    value.update(over)
    return {k: v for k, v in value.items() if v is not ABSENT}


def report(**over) -> dict:
    value = {"reason": "because", "verdict": "valid"}
    value.update(over)
    return {k: v for k, v in value.items() if v is not ABSENT}


def case(name: str, rep, *, row=ABSENT, resolve=None, git=None, lineage=None, entries=None,
         ts_refuses: bool = False) -> dict:
    return {
        "name": name,
        "row_json": json.dumps(base_row() if row is ABSENT else row, ensure_ascii=True),
        "report_json": json.dumps(rep, ensure_ascii=True),
        "resolve": resolve or {},
        "git": git or {},
        "lineage": lineage or {},
        "entries": entries or {},
        "ts_refuses": ts_refuses,
    }


def gitk(*args) -> str:
    return dump(list(args))


REV = gitk("rev-list", TARGET + ".." + TIP)
DIFF = gitk("diff-tree", "--root", "--no-commit-id", "--name-only", "--first-parent", "-m", "-r", COMMIT)


def fix_facts(*, rev=None, diff=None, resolved=COMMIT, lineage_result=None, lineage_raises=None,
              value=COMMIT, resolve_raises=None):
    """The reads a fixed/superseded report makes, each overridable per case."""
    resolve_entry = {"raises": resolve_raises} if resolve_raises else {"result": resolved}
    lineage_entry = {"raises": lineage_raises} if lineage_raises else {"result": lineage_result}
    return {
        "resolve": {dump(value): resolve_entry},
        "git": {
            REV: rev if rev is not None else {"hex": hexed(COMMIT + "\n")},
            DIFF: diff if diff is not None else {"hex": hexed(PATH + "\n")},
        },
        "lineage": {dump([TARGET, COMMIT, PATH]): lineage_entry},
    }


def text_blob(text: str, *, raw_hex: str | None = None) -> dict:
    return {"hex": raw_hex if raw_hex is not None else hexed(text)}


CAT = gitk("cat-file", "blob", BLOB)


def valid_facts(text: str | None = None, *, raw_hex: str | None = None, cat_raises=None,
                path: str = PATH, entry_raises=None):
    cat = {"raises": cat_raises} if cat_raises else text_blob(text or "", raw_hex=raw_hex)
    entry = {"raises": entry_raises} if entry_raises else {"blob": BLOB}
    return {"git": {CAT: cat}, "entries": {dump(path): entry}}


def cases() -> list[dict]:
    out: list[dict] = []
    add = out.append

    # --- reason gate ----------------------------------------------------------
    for label, value in (("missing", ABSENT), ("null", None), ("number", 1), ("list", ["x"]),
                         ("empty", ""), ("spaces", "   "), ("newline-tab", "\n\t"),
                         ("nbsp-em-space", "  "), ("file-separator", "\x1c\x1d\x1e\x1f"),
                         ("next-line", "\x85"), ("line-separator", "  ")):
        add(case("reason %s is no reason" % label, report(reason=value, verdict="invalid")))
    add(case("reason is kept verbatim, padding and all", report(reason="  padded  ", verdict="invalid")))
    add(case("reason that only looks blank to JavaScript trim is still a reason",
             report(reason="﻿", verdict="invalid")))
    add(case("reason gate wins over a refused context scan",
             report(reason="", context_scan_refused=True, verdict="unsure")))

    # --- context_scan_refused and unsure ---------------------------------------
    for label, value in (("true", True), ("one", 1), ("text", "yes"), ("list", [0]), ("object", {"a": 1}),
                         ("float", 0.5)):
        add(case("context_scan_refused %s admits to investigation" % label,
                 report(context_scan_refused=value, verdict="fixed")))
    for label, value in (("false", False), ("zero", 0), ("empty", ""), ("empty list", []),
                         ("empty object", {}), ("zero float", 0.0), ("null", None)):
        add(case("context_scan_refused %s does not refuse" % label,
                 report(context_scan_refused=value, verdict="invalid")))
    add(case("unsure goes to the fixer", report(verdict="unsure", reason="not sure")))
    add(case("refused scan on a valid report skips every read",
             report(context_scan_refused=True, verdict="valid", current_path=PATH)))

    # --- simple verdicts --------------------------------------------------------
    add(case("invalid is dismissed", report(verdict="invalid")))
    add(case("duplicate-of carries canonical_of", report(verdict="duplicate-of", canonical_of="f-9")))
    add(case("duplicate-of without canonical_of carries null", report(verdict="duplicate-of")))
    add(case("duplicate-of keeps any canonical_of type", report(verdict="duplicate-of", canonical_of=["a", 1])))
    for label, value in (("missing", ABSENT), ("null", None), ("unknown", "maybe"), ("wrong case", "Invalid"),
                         ("trailing space", "valid "), ("number", 1), ("list", ["valid"]),
                         ("object", {"v": 1}), ("empty", "")):
        add(case("verdict %s needs a human" % label, report(verdict=value)))

    # --- report is not an object -------------------------------------------------
    # Python's first line is report.get(...): a non-dict has no .get.
    for label, value in (("list", []), ("string", "valid"), ("null", None), ("number", 3)):
        add(case("report %s raises AttributeError" % label, value))

    # --- fixed / superseded ------------------------------------------------------
    fixed = report(verdict="fixed", fixing_commit=COMMIT)
    superseded = report(verdict="superseded", fixing_commit=COMMIT)
    add(case("fixed with a verified ancestor that touches the path", fixed, **fix_facts()))
    add(case("superseded with a verified ancestor skips diff-tree", superseded, **fix_facts(diff={"hex": "ff"})))
    # The superseded run above gives diff-tree invalid bytes: reading it would be a caught
    # UnicodeDecodeError, and the recorded read order shows it never happens.
    add(case("superseded does not need the path in the diff", superseded, **fix_facts(diff={"hex": hexed("other.py\n")})))
    add(case("fixed accepts the lineage-mapped path", fixed,
             **fix_facts(lineage_result="src/b.py", diff={"hex": hexed("src/b.py\n")})))
    add(case("fixed does not accept the original path when lineage maps elsewhere", fixed,
             **fix_facts(lineage_result="src/b.py")))
    add(case("falsy lineage result falls back to the finding path", fixed, **fix_facts(lineage_result="")))
    add(case("null lineage result falls back to the finding path", fixed, **fix_facts(lineage_result=None)))
    add(case("fixed whose diff misses the path is unverified", fixed,
             **fix_facts(diff={"hex": hexed("elsewhere.py\n")})))
    add(case("fixed commit outside target..tip is unverified", fixed,
             **fix_facts(rev={"hex": hexed(OTHER + "\n")})))
    add(case("empty rev-list is unverified", fixed, **fix_facts(rev={"hex": ""})))
    add(case("rev-list with several commits and CRLF", fixed,
             **fix_facts(rev={"hex": hexed(OTHER + "\r\n" + COMMIT + "\r\n")})))
    add(case("rev-list split at vertical tab and form feed", fixed,
             **fix_facts(rev={"hex": hexed(OTHER + "\x0b" + COMMIT + "\x0c")})))
    add(case("rev-list split at next-line and line separator", fixed,
             **fix_facts(rev={"hex": hexed(OTHER + "\x85" + COMMIT + " ")})))
    add(case("rev-list line with padding does not match", fixed,
             **fix_facts(rev={"hex": hexed(" " + COMMIT + "\n")})))
    add(case("rev-list leading byte-order mark does not match", fixed,
             **fix_facts(rev={"hex": "efbbbf" + hexed(COMMIT + "\n")})))
    add(case("diff-tree path containing a line separator is split", fixed,
             **fix_facts(lineage_result="src/a b.py", diff={"hex": hexed("src/a b.py\n")})))
    add(case("diff-tree with CRLF names", fixed, **fix_facts(diff={"hex": hexed("x\r\n" + PATH + "\r\n")})))
    add(case("rev-list invalid utf-8 is a caught UnicodeDecodeError", fixed,
             **fix_facts(rev={"hex": "ff" + hexed(COMMIT)})))
    add(case("diff-tree invalid utf-8 is a caught UnicodeDecodeError", fixed,
             **fix_facts(diff={"hex": hexed(PATH) + "c0af"})))
    add(case("rev-list overlong utf-8 is rejected", fixed, **fix_facts(rev={"hex": "c0af"})))
    add(case("rev-list encoded surrogate is rejected", fixed, **fix_facts(rev={"hex": "eda080"})))
    for name in ("IntegrityError", "TypeError", "ValueError", "CalledProcessError"):
        add(case("resolve %s is unverified" % name, fixed, **fix_facts(resolve_raises=name)))
    for name in ("KeyError", "OSError", "TimeoutExpired"):
        add(case("resolve %s propagates" % name, fixed, **fix_facts(resolve_raises=name)))
    for label, value in (("missing", ABSENT), ("null", None), ("number", 7), ("list", [COMMIT])):
        rep = report(verdict="fixed", fixing_commit=value)
        add(case("fixing_commit %s is resolved as given" % label, rep,
                 resolve={dump(None if value is ABSENT else value): {"raises": "TypeError"}}))
    add(case("fixing_commit is replaced by the resolved id", report(verdict="fixed", fixing_commit=COMMIT.upper()),
             **{**fix_facts(value=COMMIT.upper()), "resolve": {dump(COMMIT.upper()): {"result": COMMIT}}}))
    for name in ("CalledProcessError", "ValueError", "TypeError", "IntegrityError"):
        facts = fix_facts()
        facts["git"][REV] = {"raises": name}
        add(case("rev-list %s is unverified" % name, fixed, **facts))
    for name in ("OSError", "TimeoutExpired", "KeyError"):
        facts = fix_facts()
        facts["git"][REV] = {"raises": name}
        add(case("rev-list %s propagates" % name, fixed, **facts))
    for name in ("CalledProcessError", "IntegrityError", "TypeError", "ValueError"):
        add(case("lineage %s is unverified" % name, fixed, **fix_facts(lineage_raises=name)))
    for name in ("OSError", "KeyError"):
        add(case("lineage %s propagates" % name, fixed, **fix_facts(lineage_raises=name)))
    for name in ("CalledProcessError", "ValueError"):
        facts = fix_facts()
        facts["git"][DIFF] = {"raises": name}
        add(case("diff-tree %s is unverified" % name, fixed, **facts))
    for name in ("OSError", "TimeoutExpired"):
        facts = fix_facts()
        facts["git"][DIFF] = {"raises": name}
        add(case("diff-tree %s propagates" % name, fixed, **facts))
    # Row shape: only the fixed/superseded path reads the row.
    add(case("row is never read for a valid-free verdict", report(verdict="invalid")))
    add(case("row target missing raises KeyError after resolve", fixed,
             row={"finding": {"path": PATH}}, resolve={dump(COMMIT): {"result": COMMIT}}))
    for label, value in (("null", None), ("number", 5), ("list", [TARGET])):
        add(case("row target %s is a caught TypeError" % label, fixed, row=base_row(target=value),
                 resolve={dump(COMMIT): {"result": COMMIT}}))
    add(case("row finding missing raises KeyError", fixed, row={"target": TARGET},
             **{**fix_facts(), "lineage": {}}))
    for label, value in (("null", None), ("string", "src/a.py"), ("list", [PATH]), ("number", 1)):
        add(case("row finding %s is a caught TypeError" % label, fixed, row=base_row(finding=value),
                 **{**fix_facts(), "lineage": {}}))
    add(case("row finding without path raises KeyError", fixed, row=base_row(finding={"id": "f1"}),
             **{**fix_facts(), "lineage": {}}))
    for label, value in (("row null", None), ("row list", []), ("row string", "x")):
        add(case("%s is a caught TypeError for fixed" % label, fixed, row=value,
                 resolve={dump(COMMIT): {"result": COMMIT}}))
    add(case("row null is never read for superseded-free verdicts", report(verdict="unsure"), row=None))
    add(case("finding path that is not a string is refused by the port", fixed,
             row=base_row(finding={"path": 7}),
             **{**fix_facts(), "lineage": {dump([TARGET, COMMIT, 7]): {"result": None}}}, ts_refuses=True))

    # --- valid ---------------------------------------------------------------------
    def valid(name, text=None, *, lines=ABSENT, quote="two", path=PATH, raw_hex=None, cat_raises=None,
              entry_raises=None, entries_path=None, **over):
        rep = report(verdict="valid", current_path=path, current_lines=[[2, 2]] if lines is ABSENT else lines,
                     quoted_text=quote, **over)
        rep = {k: v for k, v in rep.items() if v is not ABSENT}
        add(case(name, rep, **valid_facts(text, raw_hex=raw_hex, cat_raises=cat_raises,
                                          path=entries_path or path, entry_raises=entry_raises)))

    base = "one\ntwo\nthree\n"
    valid("exact single line", base)
    valid("exact keeps the reported lines verbatim", base, lines=[[2, 2]])
    valid("exact multi line", base, lines=[[1, 2]], quote="one\ntwo")
    valid("exact non-contiguous intervals join with newline", base, lines=[[1, 1], [3, 3]], quote="one\nthree")
    valid("exact on the last line without trailing newline", "one\ntwo\nthree", lines=[[3, 3]], quote="three")
    valid("crlf blob lines compare without the carriage return", "one\r\ntwo\r\nthree\r\n")
    valid("form feed in the blob is a line break", "a\x0cb\n", lines=[[1, 2]], quote="a\nb")
    valid("file separator in the blob is a line break", "a\x1cb\n", lines=[[2, 2]], quote="b")
    valid("next-line and line separator split the blob", "a\x85b c\n", lines=[[3, 3]], quote="c")
    valid("quote line containing a form feed never matches a split line", "a\x0cb\n", lines=[[1, 1]], quote="a\x0cb")
    valid("byte-order mark stays on the first line", "﻿one\ntwo\n", lines=[[2, 2]])
    valid("quote that omits the byte-order mark mismatches", "﻿one\ntwo\n", lines=[[1, 1]], quote="one")
    valid("quote that carries the byte-order mark matches", "﻿one\ntwo\n", lines=[[1, 1]], quote="﻿one")
    valid("quote padding is part of the comparison", "  two  \n", lines=[[1, 1]], quote="  two  ")
    valid("quote with trailing newline recovers nothing from a single line", base, lines=[[2, 2]], quote="two\n")
    valid("unicode text", "café\n\U0001f600 x\n", lines=[[2, 2]], quote="\U0001f600 x")

    # drift recovery
    valid("drift: unique single-line match is re-anchored", base, lines=[[3, 3]], quote="two")
    valid("drift: unique multi-line match is re-anchored", base, lines=[[3, 3]], quote="two\nthree")
    valid("drift: lines past the end are re-anchored", base, lines=[[40, 41]], quote="three")
    valid("drift: ambiguous quote is not re-anchored", "x\ny\nx\ny\n", lines=[[9, 9]], quote="x\ny")
    valid("drift: absent quote is not re-anchored", base, lines=[[1, 1]], quote="nope")
    valid("drift: partial-line quote is not matched", base, lines=[[1, 1]], quote="tw")
    valid("drift: quote longer than the file", "a\n", lines=[[1, 1]], quote="a\nb\nc")
    valid("drift: empty blob", "", lines=[[1, 1]], quote="x")
    valid("drift: empty selection list recovers", base, lines=[], quote="three")
    valid("drift: empty string selection recovers", base, lines="", quote="three")
    valid("drift: empty object selection recovers", base, lines={}, quote="three")
    valid("drift: quote split only on newline, blob split on every break", "a\x0cb\n", lines=[[9, 9]], quote="a\nb")
    valid("drift: crlf quote does not match crlf-stripped lines", "one\r\ntwo\r\n", lines=[[9, 9]], quote="one\r\ntwo")
    valid("drift: blank middle line in the quote", "a\n\nb\n", lines=[[9, 9]], quote="a\n\nb")
    valid("drift: quote ending in a newline needs a blank last line", "a\n\n", lines=[[9, 9]], quote="a\n")
    valid("drift: repeated lines near the end are ambiguous", "z\nz\n", lines=[[9, 9]], quote="z")
    valid("drift: two-line quote matching once among repeats", "z\nz\nq\n", lines=[[9, 9]], quote="z\nq")
    valid("drift keeps other report fields", base, lines=[[3, 3]], quote="two", canonical_of="ignored")

    # quote checks
    for label, value in (("missing", ABSENT), ("null", None), ("number", 4), ("list", ["two"]),
                         ("empty", ""), ("blank", "  \t"), ("unicode blank", "  "),
                         ("file separator blank", "\x1c")):
        valid("quote %s fails verification" % label, base, quote=value)

    # intervals
    for label, value in (("float bounds", [[1.0, 2]]), ("bool bound", [[True, 2]]), ("string bound", [["1", 2]]),
                         ("null bound", [[None, 2]]), ("overlap", [[1, 2], [2, 3]]),
                         ("descending", [[3, 3], [1, 1]]), ("zero start", [[0, 1]]),
                         ("negative start", [[-3, 1]]), ("end before start", [[3, 2]]),
                         ("triple", [[1, 2, 3]]), ("single", [[1]]), ("flat list", [1, 2]),
                         ("non-iterable number", 4), ("null", None), ("non-empty string", "ab"),
                         ("non-empty object", {"a": 1}), ("end over limit", [[1, 1000001]]),
                         ("huge int", [[1, 10 ** 30]]), ("true", True), ("pair as string", ["ab"]),
                         ("total over limit", [[1, 500000], [500001, 1000001]])):
        valid("intervals %s fail verification" % label, base, lines=value, quote="two")
    valid("intervals of one million lines still verify as drift", base, lines=[[1, 1000000]], quote="two")
    add(case("current_lines missing fails verification",
             report(verdict="valid", current_path=PATH, quoted_text="two"), **valid_facts(base)))
    add(case("current_path missing fails verification",
             report(verdict="valid", current_lines=[[2, 2]], quoted_text="two")))
    add(case("current_lines missing is checked before the path is looked up",
             report(verdict="valid", current_path="never/read.py", quoted_text="two")))

    # entries and blob reads
    valid("path not in the tip tree fails verification", base, entry_raises="KeyError")
    valid("unhashable path raises a caught TypeError", base, path=[], entries_path=[], entry_raises="TypeError")
    valid("entries IntegrityError is caught", base, entry_raises="IntegrityError")
    valid("entries ValueError is caught", base, entry_raises="ValueError")
    valid("entries CalledProcessError propagates", base, entry_raises="CalledProcessError")
    valid("entries OSError propagates", base, entry_raises="OSError")
    valid("entries TimeoutExpired propagates", base, entry_raises="TimeoutExpired")
    valid("cat-file CalledProcessError propagates", base, cat_raises="CalledProcessError")
    valid("cat-file OSError propagates", base, cat_raises="OSError")
    valid("cat-file ValueError is caught", base, cat_raises="ValueError")
    valid("cat-file IntegrityError is caught", base, cat_raises="IntegrityError")
    valid("cat-file TypeError is caught", base, cat_raises="TypeError")
    valid("invalid utf-8 blob is a caught UnicodeDecodeError", raw_hex=hexed("one\n") + "ff" + hexed("\n"))
    valid("overlong utf-8 blob is rejected", raw_hex="c0af")
    valid("surrogate-encoding blob is rejected", raw_hex="eda080")
    valid("truncated multibyte blob is rejected", raw_hex=hexed("one\ntwo") + "e2")
    valid("valid verdict in a report with extra fields keeps only the anchor", base, canonical_of="x",
          fixing_commit=COMMIT)
    valid("verdict valid with non-string current_path that is a known entry", base, path=7, entries_path=7)
    return out


# ---------------------------------------------------------------------------
# Build / render / CLI
# ---------------------------------------------------------------------------

def build() -> dict:
    built = []
    for spec in cases():
        entry = dict(spec)
        entry["expected"] = run_python(spec)
        built.append(entry)
    names = [item["name"] for item in built]
    assert len(names) == len(set(names)), "case names must be unique"
    return {"schema": SCHEMA, "source": SOURCE_PATH, "tip": TIP, "cases": built}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--stdout", action="store_true")
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
        sys.stderr.write("fixture is stale: run python3 triage_decision_vectors.py --write\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
