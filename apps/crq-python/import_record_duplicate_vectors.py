#!/usr/bin/env python3
"""Deterministic offline oracle for the retained-record scan in ``review_record.import_record``.

Test tooling only. A fixed manual submission is imported against hostile
``existing`` lists (the loosely shaped records ``_retained_records`` returns,
since it validates nothing) through the PRODUCTION
``review_record.import_record``. Each case records the action string or the
exception class Python let escape. The TypeScript test
``test/policy/crq/reviewRecordDuplicate.test.ts`` replays it.

Regenerate with ``python3.14 import_record_duplicate_vectors.py --write``;
verify with ``--check``. Output is deterministic.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import review_record

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-import-record-duplicate" / "cases.json"
AT = "2026-01-02T03:04:05Z"
REPORT = b"## Review\nLooks fine.\n"
SUBMITTED = {
    "producer": "manual",
    "id": "report-1",
    "report_bytes": REPORT,
    "authenticated_submitter": "reviewer-login",
}
DIGEST = hashlib.sha256(REPORT).hexdigest()
SOURCE_KEY = review_record.normalize_record(SUBMITTED, AT)[0]["source_key"]


def _rec(**over: Any) -> Dict[str, Any]:
    base = {"event_type": "review", "source_key": SOURCE_KEY, "id": "d" * 64,
            "payload": {"artifacts": [{"sha256": DIGEST}]}}
    base.update(over)
    return {k: v for k, v in base.items() if v is not ...}


def _arts(artifacts: Any) -> Dict[str, Any]:
    return _rec(payload={"artifacts": artifacts})


def cases() -> List[Dict[str, Any]]:
    other = {"sha256": "0" * 64}
    mine = {"sha256": DIGEST}
    return [
        ("duplicate-of-string-id", [_rec()]),
        ("integer-id-is-typeerror", [_rec(id=7)]),
        ("null-id-is-typeerror", [_rec(id=None)]),
        ("true-id-is-typeerror", [_rec(id=True)]),
        ("false-id-is-typeerror", [_rec(id=False)]),
        ("missing-id-is-keyerror", [_rec(id=...)]),
        ("missing-payload-is-keyerror", [_rec(payload=...)]),
        ("empty-list-payload-is-typeerror", [_rec(payload=[])]),
        ("string-payload-is-typeerror", [_rec(payload="x")]),
        ("null-payload-is-typeerror", [_rec(payload=None)]),
        ("int-payload-is-typeerror", [_rec(payload=5)]),
        ("payload-without-artifacts-is-keyerror", [_rec(payload={})]),
        ("string-artifacts-iterate-characters-typeerror", [_arts("abc")]),
        ("empty-string-artifacts-match-nothing", [_arts("")]),
        ("null-artifacts-not-iterable", [_arts(None)]),
        ("int-artifacts-not-iterable", [_arts(5)]),
        ("true-artifacts-not-iterable", [_arts(True)]),
        ("empty-object-artifacts-match-nothing", [_arts({})]),
        ("object-artifacts-iterate-keys-typeerror", [_arts({"k": 1})]),
        ("entry-without-sha256-is-keyerror", [_arts([{}])]),
        ("integer-entry-is-typeerror", [_arts([1])]),
        ("string-entry-is-typeerror", [_arts(["x"])]),
        ("null-entry-is-typeerror", [_arts([None])]),
        ("list-entry-is-typeerror", [_arts([[]])]),
        ("non-string-sha256-matches-nothing", [_arts([{"sha256": 1}])]),
        ("matching-entry-before-bad-entry-short-circuits", [_arts([mine, 1])]),
        ("bad-entry-before-matching-entry-raises", [_arts([1, mine])]),
        ("non-matching-digest-records-new", [_arts([other])]),
        ("other-source-key-with-bad-payload-skipped", [_rec(source_key="x", payload=[])]),
        ("non-review-with-bad-payload-skipped", [_rec(event_type="import-result", payload=[])]),
        ("non-matching-then-duplicate", [_arts([other]), _rec(id="e" * 64)]),
        ("first-duplicate-wins", [_rec(id="a" * 64), _rec(id="b" * 64)]),
        ("duplicate-then-bad-record-never-reached", [_rec(), _rec(payload=[])]),
        ("bad-record-then-duplicate-raises", [_rec(payload=[]), _rec()]),
    ]


def run(existing: List[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        events, action = review_record.import_record(dict(SUBMITTED), AT, existing)
    except Exception as exc:
        return {"error": type(exc).__name__}
    return {"action": action, "events": len(events)}


def build() -> Dict[str, Any]:
    rows = [{"name": name, "existing": existing, "expect": run(existing)}
            for name, existing in cases()]
    return {
        "schema": "crq-import-record-duplicate-vectors-v1",
        "submitted": {"producer": "manual", "id": "report-1", "report": REPORT.decode("ascii"),
                      "submitter": "reviewer-login", "at": AT},
        "cases": rows,
    }


def render(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the import-record duplicate oracle fixture")
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
        print("import-record duplicate fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
