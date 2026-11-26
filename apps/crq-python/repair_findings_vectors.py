#!/usr/bin/env python3
"""Deterministic offline oracle for ``crq_repair.findings``.

Test tooling only. Every case writes raw bytes to a ``review.ndjson`` and calls
the PRODUCTION ``crq_repair.findings(path, provenance=...)``, recording either
the rows (as Python's own ``json.dumps`` text, so ints, floats and NaN keep
their exact spelling) or the exception class and message that escaped.

Hand-written cases pin the fidelity traps: a BOM, bytes that are not UTF-8,
``splitlines`` boundaries beyond ``\\n``, JSON lines that are not objects,
duplicate keys, ``NaN``, non-str bodies, Unicode ``\\d``/``\\s``/``re.I``,
oversized line numbers and the publisher's deduplicated ordinal. A seeded
generator adds mutated finding streams.

Regenerate with ``python3.14 repair_findings_vectors.py --write`` and verify
with ``--check`` (``test_repair_findings_vectors.py`` does the latter).
"""
from __future__ import annotations

import argparse
import base64
import json
import random
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crq_repair  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-repair-findings" / "cases.json"
SCHEMA = "cq.crq-repair-findings-vector/v1"
SEEDS = 300


def ev(**kw) -> str:
    return json.dumps(kw)


def finding(**kw) -> str:
    base = {"type": "finding", "severity": "major", "fileName": "a.py", "comment": "bad"}
    base.update(kw)
    return json.dumps(base)


def nd(*lines: str) -> bytes:
    return ("\n".join(lines) + "\n").encode("utf-8")


def fixed_cases() -> list[tuple[str, bytes]]:
    f = finding
    return [
        ("empty", b""),
        ("only-blank-lines", b"\n\n \n"),
        ("not-json-skipped", nd("garbage", "{bad", f())),
        ("severity-filter", nd(*(f(severity=s) for s in ("critical", "major", "minor", "blocker", "fatal", "none", "Major", "")))),
        ("severity-non-str", nd(f(severity=1), f(severity=["major"]), f(severity=None), f(severity=True))),
        ("type-filter", nd(ev(type="note", severity="major"), ev(severity="major"), f())),
        ("codegen-over-comment", nd(f(codegenInstructions="cg", comment="cm"))),
        ("comment-fallback", nd(f(codegenInstructions="", comment="cm"), f(codegenInstructions=None, comment=""))),
        ("both-empty-body", nd(f(comment=""), f(comment=None))),
        ("suggestion-str", nd(f(suggestions="fix it"))),
        ("suggestion-list", nd(f(suggestions=["a", {"b": 1, "c": [1.5, None, True]}, "é"]))),
        ("suggestion-dict-float", nd(f(suggestions={"x": 1.0, "y": 1e300, "z": -0.0}))),
        ("suggestion-falsy", nd(f(suggestions=""), f(suggestions=[]), f(suggestions=0), f(suggestions=None))),
        ("body-list-type-error", nd(f(comment=["x"]))),
        ("body-dict-type-error", nd(f(comment={"x": 1}))),
        ("body-int-type-error", nd(f(comment=7))),
        ("body-bool-type-error", nd(f(comment=True))),
        ("body-float-type-error", nd(f(comment=1.5))),
        ("body-list-with-suggestion", nd(f(comment=["x"], suggestions="s"))),
        ("body-int-with-suggestion", nd(f(comment=7, suggestions="s"))),
        ("line-around", nd(f(comment="see around line 12 now"))),
        ("line-around-lines", nd(f(comment="Around Lines 7-9"))),
        ("line-at-line", nd(f(comment="AT LINE   40"))),
        ("line-first-match", nd(f(comment="at line 3 and around line 9"))),
        ("line-none", nd(f(comment="at line x"), f(comment="line 5"), f(comment="at  line 5"))),
        ("line-in-suggestion", nd(f(comment="c", suggestions="at line 99"))),
        ("line-leading-zero", nd(f(comment="at line 007"))),
        ("line-zero", nd(f(comment="at line 0"))),
        ("line-huge", nd(f(comment="at line 99999999999999999999"))),
        ("line-limit-4300", nd(f(comment="at line " + "9" * 4300))),
        ("line-limit-4301", nd(f(comment="at line " + "9" * 4301))),
        ("line-unicode-digits", nd(f(comment="at line ٣٤"), f(comment="at line １２"))),
        ("line-unicode-space", nd(f(comment="at line 42"), f(comment="at line 42"), f(comment="at line᠎42"), f(comment="at line\x1c42"), f(comment="at line\x8542"), f(comment="at line﻿42"))),
        ("line-re-ignorecase", nd(f(comment="AT LİNE 5"), f(comment="at lıne 5"), f(comment="ſ"), f(comment="arſund line 6"), f(comment="arounK line 6"), f(comment="at Kine 6"))),
        ("line-crossing-newline", nd(f(comment="at line\n12"), f(comment="around\tline 4"))),
        ("path-types", nd(f(fileName=None), ev(type="finding", severity="major", comment="x"), f(fileName=5), f(fileName=1.0), f(fileName=["a"]), f(fileName={"k": 1}), f(fileName=True), f(fileName=""))),
        ("splitlines-boundaries", ("{}\x0b{}\x0c" .format(f(comment="one"), f(comment="two")) + f(comment="three") + "\x1c" + f(comment="four") + "\x85" + f(comment="five") + " " + f(comment="six") + " " + f(comment="seven") + "\r" + f(comment="eight") + "\r\n" + f(comment="nine")).encode("utf-8")),
        ("no-trailing-newline", f(comment="solo").encode("utf-8")),
        ("crlf-lines", (f(comment="a") + "\r\n" + f(comment="b") + "\r\n").encode("utf-8")),
        ("utf8-bom-first-line", b"\xef\xbb\xbf" + nd(f(comment="bom first"), f(comment="after"))),
        ("utf8-bom-mid", nd(f(comment="a")) + b"\xef\xbb\xbf" + nd(f(comment="b"))),
        ("invalid-utf8-in-body", b'{"type":"finding","severity":"major","fileName":"a.py","comment":"bad \xff\xfe at line 3"}\n'),
        ("invalid-utf8-truncated-seq", b'{"type":"finding","severity":"major","comment":"x\xe2\x82"}\n{"type":"finding","severity":"major","comment":"y\xf0\x9f"}\n'),
        ("invalid-utf8-surrogate-bytes", b'{"type":"finding","severity":"major","comment":"\xed\xa0\x80z"}\n'),
        ("invalid-utf8-breaks-json", b'{"type":"finding","severity":"major","comment":"ok"}\n\xff{"type":"finding","severity":"critical","comment":"two"}\n'),
        ("escaped-lone-surrogate", nd('{"type":"finding","severity":"major","comment":"x\\ud800y","fileName":"\\udc00"}')),
        ("json-line-list", nd(f(comment="a"), "[1, 2]")),
        ("json-line-null", nd("null", f(comment="a"))),
        ("json-line-str", nd('"text"')),
        ("json-line-int", nd("5")),
        ("json-line-float", nd("1.5")),
        ("json-line-bool", nd("true")),
        ("json-line-after-finding", nd(f(comment="a"), "false")),
        ("json-line-nan", nd("NaN")),
        ("duplicate-keys-last-wins", nd('{"type":"finding","severity":"minor","severity":"major","comment":"a","comment":"b"}')),
        ("nan-values", nd('{"type":"finding","severity":"major","fileName":NaN,"comment":"x","id":Infinity,"source_id":-Infinity}')),
        ("nan-suggestion", nd('{"type":"finding","severity":"major","comment":"x","suggestions":[NaN, Infinity, -Infinity]}')),
        ("big-ints", nd('{"type":"finding","severity":"major","comment":"x","id":123456789012345678901234567890,"fileName":9007199254740993,"suggestions":[9007199254740993]}')),
        ("float-spellings", nd('{"type":"finding","severity":"major","comment":"x","id":1.0,"source_id":1e5,"review_id":-0.0,"thread_id":1E-7,"source_thread_id":12345678901234567890.5}')),
        ("source-keys", nd(f(id="i", source_id="s", review_id="r", thread_id="t", source_thread_id="st", extra="no"))),
        ("source-null-skipped", nd(f(id=None, source_id=0, review_id="", thread_id=False, source_thread_id=[]))),
        ("source-nested", nd(f(id={"a": [1, {"b": None}]}, review_id=[1, 2.5, "é"]))),
        ("ordinal-single", nd(f(comment="one", title="T"), f(comment="two", title="U", severity="critical"))),
        ("ordinal-counts-lower-severity", nd(f(severity="minor", comment="m", title="M"), f(comment="c", title="C"))),
        ("ordinal-counts-non-finding-never", nd(ev(type="note", comment="n"), f(comment="c"))),
        ("ordinal-exact-duplicate", nd(f(comment="dup", title="D"), f(comment="dup", title="D"), f(comment="after", title="A"))),
        ("ordinal-duplicate-different-severity", nd(f(comment="dup", severity="minor"), f(comment="dup", severity="major"))),
        ("ordinal-line-swap", nd(f(comment="c", startLine=9, endLine=3), f(comment="c2", startLine=4))),
        ("ordinal-line-fill", nd(f(comment="c", endLine=8), f(comment="c3", startLine=5), f(comment="c4", startLine=0, endLine=0))),
        ("ordinal-line-types", nd(f(comment="c", startLine=True, endLine=2.0), f(comment="c5", startLine="3", endLine=-1), f(comment="c6", startLine=10**30))),
        ("ordinal-title-comment", nd(f(comment=None, title=" tt "), f(comment="  x  ", title=None), f(comment=" ", title=" ", severity="critical"))),
        ("ordinal-title-str-of-values", nd(f(title=5, comment="a"), f(title=1.5, comment="b"), f(title=["x", 1], comment="c"), f(title={"k": True}, comment="d"), f(title=True, comment="e"), f(title=0, comment="f"))),
        ("ordinal-title-unicode-strip", nd(f(title=" t　", comment="g"), f(title="\x1ct\x1f", comment="h"), f(title="﻿t﻿", comment="i"))),
        ("ordinal-path-nonstr-never-matches", nd(f(fileName=5, comment="p"), f(fileName=None, comment="q"), ev(type="finding", severity="major", comment="r"))),
        ("ordinal-path-empty", nd(f(fileName="", comment="e"))),
        ("ordinal-whitespace-text", nd(f(comment="  padded  ", title=" t "))),
        ("ordinal-nbsp-text-vs-body", nd(f(comment=" x "), f(comment=" x  "))),
        ("ordinal-splitlines-dedupe", ("{}\x0b{}\n".format(f(comment="same"), f(comment="same"))).encode("utf-8")),
        ("ordinal-non-object-line", nd("[1]", f(comment="a"))),
    ]


KEYS = ["type", "severity", "fileName", "comment", "title", "codegenInstructions", "suggestions",
        "startLine", "endLine", "id", "source_id", "review_id", "thread_id", "source_thread_id"]
VALUES = [None, True, False, 0, 1, 7, -3, 10**25, 1.0, 2.5, -0.0, "", " ", "a.py", "x", "at line 12", "around lines 3-4",
          "major", "critical", "minor", "finding", " q ", "T　", [], ["a"], [1, "b"], {}, {"k": [1]}]


def fuzz_cases() -> list[tuple[str, bytes]]:
    out = []
    for seed in range(SEEDS):
        rng = random.Random(seed)
        lines = []
        for _ in range(rng.randint(1, 6)):
            roll = rng.random()
            if roll < 0.08:
                lines.append(rng.choice(["not json", "[1]", "null", '"s"', "", " ", "12"]))
                continue
            row = {"type": "finding", "severity": rng.choice(["major", "critical", "minor", "major", "critical"]),
                   "fileName": rng.choice(["a.py", "b.py", None, 3]), "comment": rng.choice(["x", "y", "at line 5", "around line 9 here"]),
                   "title": rng.choice(["t1", "t2", "", None])}
            for key in rng.sample(KEYS, rng.randint(0, 5)):
                if rng.random() < 0.7 and key in ("type", "severity", "comment"):
                    row[key] = rng.choice(["finding", "major", "critical", "c", "at line 8"]) if key != "type" else rng.choice(["finding", "finding", "note"])
                else:
                    row[key] = rng.choice(VALUES)
            lines.append(json.dumps(row))
        text = "\n".join(lines) + rng.choice(["\n", "", "\r\n"])
        out.append((f"fuzz-{seed:03d}", text.encode("utf-8")))
    return out


def run_one(data: bytes, provenance: bool) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "review.ndjson"
        path.write_bytes(data)
        try:
            rows = crq_repair.findings(path, provenance=provenance)
        except Exception as exc:  # noqa: BLE001 - the class is the datum
            return {"error": [type(exc).__name__, str(exc)]}
        return {"rows_text": json.dumps(rows, ensure_ascii=True)}


def build() -> dict:
    cases = []
    names = set()
    for name, data in fixed_cases() + fuzz_cases():
        assert name not in names, name
        names.add(name)
        cases.append({"name": name, "bytes_b64": base64.b64encode(data).decode("ascii"),
                      "plain": run_one(data, False), "provenance": run_one(data, True)})
    return {"schema": SCHEMA, "cases": cases}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1) + "\n"


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
        print("repair-findings fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
