#!/usr/bin/env python3
"""Deterministic offline oracle for ``review_transport._retained_records``.

Test tooling only. Each case lays raw file bytes under the two real spool
locations of a throwaway state directory, calls the PRODUCTION
``review_transport._retained_records`` and records what Python did: the
returned records (canonical JSON) or the exception class it let escape.

The TypeScript test ``test/adapters/crq/retainedRecordsParity.test.ts``
replays the same files through ``createReviewEffects(...).retainedRecords``.

Regenerate with ``python3.14 retained_records_vectors.py --write``; verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import review_ledger as ledger
import review_transport
from ledger_vector_emit_b1 import _review

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-retained-records" / "cases.json"
PUB = "backfill/publication"
OUT = "record-outbox"


def _b(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True).encode("utf-8")


def _file(root: str, name: str, raw: bytes) -> Dict[str, str]:
    return {"root": root, "name": name, "b64": base64.b64encode(raw).decode("ascii")}


def _record(event_type: str = "review", **over: Any) -> Dict[str, Any]:
    base = _review()
    if event_type != "review":
        base = {**base, "event_type": event_type}
    base.update(over)
    return base


def _import_result(source_key: Any, ident: Any = "x") -> Dict[str, Any]:
    return {"event_type": "import-result", "source_key": source_key, "id": ident}


def cases() -> List[Dict[str, Any]]:
    valid = _review()
    wrong_hash = {**valid, "id": "0" * 64}
    unknown_key = {**valid, "id": "u" * 64, "surprise": 1}
    bad_time = {**valid, "id": "t" * 64, "occurred_at": "yesterday"}
    no_payload = {k: v for k, v in valid.items() if k != "payload"}
    no_payload["id"] = "p" * 64
    int_id = {**valid, "id": 7}
    out: List[Dict[str, Any]] = []

    def add(name: str, files: List[Dict[str, str]]) -> None:
        out.append({"name": name, "files": files})

    add("empty", [])
    add("six-probe-records", [
        _file(PUB, "1-valid.json", ledger.canonical(valid)),
        _file(PUB, "2-wrong-hash.json", _b(wrong_hash)),
        _file(PUB, "3-unknown-key.json", _b(unknown_key)),
        _file(PUB, "4-bad-time.json", _b(bad_time)),
        _file(PUB, "5-no-payload.json", _b(no_payload)),
        _file(PUB, "6-int-id.json", _b(int_id)),
    ])
    add("wrong-hash-alone", [_file(OUT, "a.json", _b(wrong_hash))])
    add("integer-id", [_file(OUT, "a.json", _b(int_id))])
    add("null-id-then-missing-id-skipped", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": None})),
        _file(OUT, "b.json", _b({"event_type": "review"})),
    ])
    add("missing-id-escapes-keyerror", [_file(OUT, "a.json", _b({"event_type": "review"}))])
    add("missing-id-import-result-escapes-keyerror", [
        _file(OUT, "a.json", _b({"event_type": "import-result", "source_key": "record:z"}))])
    add("unhashable-list-id", [_file(OUT, "a.json", _b({"event_type": "review", "id": [1]}))])
    add("unhashable-object-id", [_file(OUT, "a.json", _b({"event_type": "review", "id": {}}))])
    add("true-id-collides-with-one", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": True})),
        _file(OUT, "b.json", _b({"event_type": "review", "id": 1})),
        _file(OUT, "c.json", _b({"event_type": "review", "id": 2})),
    ])
    add("false-id-collides-with-zero", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": 0})),
        _file(OUT, "b.json", _b({"event_type": "review", "id": False})),
    ])
    add("big-int-ids-dedupe-exactly", [
        _file(OUT, "a.json", b'{"event_type": "review", "id": 9007199254740991}'),
        _file(OUT, "b.json", b'{"event_type": "review", "id": 9007199254740990}'),
        _file(OUT, "c.json", b'{"event_type": "review", "id": 9007199254740991}'),
    ])
    add("out-of-range-int-refused-by-loads", [
        _file(OUT, "a.json", b'{"event_type": "review", "id": 123456789012345678901234567890}'),
    ])
    add("string-and-int-id-differ", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": "1"})),
        _file(OUT, "b.json", _b({"event_type": "review", "id": 1})),
    ])
    add("array-top-level-escapes-attributeerror", [_file(OUT, "a.json", b"[1]")])
    add("string-top-level-escapes-attributeerror", [_file(OUT, "a.json", b'"x"')])
    add("null-top-level-escapes-attributeerror", [_file(OUT, "a.json", b"null")])
    add("number-top-level-escapes-attributeerror", [_file(OUT, "a.json", b"5")])
    add("array-after-valid-escapes", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": "ok"})),
        _file(OUT, "b.json", b"[]"),
    ])
    add("truncated-and-bad-utf8-and-float-and-duplicate-skipped", [
        _file(OUT, "a.json", b'{"event_type": "review", "id"'),
        _file(OUT, "b.json", b'{"a": "\xff\xfe"}'),
        _file(OUT, "c.json", b'{"event_type": "review", "id": "f", "x": 1.5}'),
        _file(OUT, "d.json", b'{"event_type": "review", "id": "d", "id": "e"}'),
        _file(OUT, "e.json", b"\xef\xbb\xbf" + _b({"event_type": "review", "id": "bom"})),
        _file(OUT, "z.json", _b({"event_type": "review", "id": "ok"})),
    ])
    add("empty-file-skipped", [_file(OUT, "a.json", b"")])
    add("non-json-name-ignored", [
        _file(OUT, "a.txt", _b({"event_type": "review", "id": "t"})),
        _file(OUT, "a.json.tmp", _b({"event_type": "review", "id": "u"})),
        _file(OUT, "b.json", _b({"event_type": "review", "id": "v"})),
    ])
    add("dotfile-json-name-included", [
        _file(OUT, ".json", _b({"event_type": "review", "id": "dot"})),
        _file(OUT, ".hidden.json", _b({"event_type": "review", "id": "hid"})),
    ])
    add("sorted-by-name-then-roots-in-order", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": "out-a"})),
        _file(PUB, "z.json", _b({"event_type": "review", "id": "pub-z"})),
        _file(PUB, "b.json", _b({"event_type": "review", "id": "pub-b"})),
        _file(OUT, "dup.json", _b({"event_type": "review", "id": "pub-b"})),
    ])
    add("astral-name-sorts-by-code-point", [
        _file(OUT, "\U00010000.json", _b({"event_type": "review", "id": "astral"})),
        _file(OUT, "￿.json", _b({"event_type": "review", "id": "bmp"})),
    ])
    add("import-result-record-prefix", [
        _file(OUT, "a.json", _b(_import_result("record:one", "q1"))),
        _file(OUT, "b.json", _b(_import_result("record:one", "q1"))),
        _file(OUT, "c.json", _b(_import_result("other:one", "q2"))),
        _file(OUT, "d.json", _b(_import_result(5, "q3"))),
        _file(OUT, "e.json", _b(_import_result(["record:x"], "q4"))),
        _file(OUT, "f.json", _b(_import_result(None, "q5"))),
        _file(OUT, "g.json", _b(_import_result("record:two", 9))),
        _file(OUT, "h.json", _b({"event_type": "import-result", "id": "q6"})),
    ])
    add("other-event-types-ignored", [
        _file(OUT, "a.json", _b({"event_type": "finding", "id": "f"})),
        _file(OUT, "b.json", _b({"event_type": 5, "id": "g"})),
        _file(OUT, "c.json", _b({"id": "h"})),
        _file(OUT, "d.json", _b({"event_type": "Review", "id": "i"})),
    ])
    add("review-then-import-result-share-id", [
        _file(OUT, "a.json", _b({"event_type": "review", "id": "same"})),
        _file(OUT, "b.json", _b(_import_result("record:s", "same"))),
    ])
    add("directory-named-json-skipped-via-oserror", [
        _file(OUT, "z.json", _b({"event_type": "review", "id": "ok"})),
    ])
    return out


def run_case(case: Dict[str, Any]) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp)
        for item in case["files"]:
            directory = state / item["root"] / "pending"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / item["name"]).write_bytes(base64.b64decode(item["b64"]))
        if case["name"].startswith("directory-named-json"):
            directory = state / OUT / "pending"
            (directory / "a-dir.json").mkdir()
        try:
            records = review_transport._retained_records(SimpleNamespace(STATE=state))
        except Exception as exc:  # the oracle records every escape
            return {"error": type(exc).__name__}
        return {"records": [json.dumps(r, sort_keys=True, ensure_ascii=True) for r in records]}


def build() -> Dict[str, Any]:
    rows = []
    for case in cases():
        rows.append({**case, "expect": run_case(case)})
    return {"schema": "crq-retained-records-vectors-v1", "cases": rows}


def render(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the retained-records oracle fixture")
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
        print("retained-records fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
