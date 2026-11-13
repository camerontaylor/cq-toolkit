#!/usr/bin/env python3
"""Deterministic B1 vectors for the pure ``review_ledger`` contract.

Test tooling only: importing this module has no runtime effect and crq never
imports it. The B1 TypeScript port (``src/policy/crq/ledger.ts``) replays
``fixtures/crq-ledger-b1/vectors.json`` so every record-validation, canonical
byte, digest and replay decision is compared with this Python oracle at the
same commit.

Every record is public and synthetic. No filesystem path, host, credential,
process id or timestamp is recorded, so regeneration is byte-identical on
every host and Python 3.14+ patch level.

Regenerate with ``python3 ledger_vector_emit_b1.py --write`` and verify with
``--check``. ``--stdout`` prints the whole document for the determinism test.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Callable, Dict, List

import review_ledger as ledger

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-ledger-b1" / "vectors.json"
SCHEMA = "cq.crq-ledger-b1-vector/v1"
AT = "2026-10-30T00:00:00Z"
SHA = "a" * 40
SHA64 = "b" * 64
ARTIFACT = {"sha256": "c" * 64, "location": "/fixtures/artifacts/" + "c" * 64}


def _case(name: str, source: str, inputs: Dict[str, Any], *,
          value: Any = None, error: str | None = None,
          message: str | None = None) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": error is None}
    if error is None:
        expect["value"] = value
    else:
        expect["error"] = error
        if message:
            expect["message"] = message
    return {"name": name, "source": source, "input": inputs, "expect": expect}


def _capture(name: str, source: str, inputs: Dict[str, Any],
             call: Callable[[], Any]) -> Dict[str, Any]:
    try:
        value = call()
    except Exception as exc:  # the vector records the oracle's refusal
        return _case(name, source, inputs, error=type(exc).__name__, message=str(exc))
    return _case(name, source, inputs, value=value)


def _family(name: str, cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"family": name, "cases": cases}


def _utf16_units(text: str) -> List[int]:
    data = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[index:index + 2], "little")
            for index in range(0, len(data), 2)]


def _canonical(value: Any) -> Dict[str, str]:
    raw = ledger.canonical(value)
    return {"canonical": raw.decode("utf-8"), "sha256": hashlib.sha256(raw).hexdigest()}


def _rehash(value: Dict[str, Any]) -> Dict[str, Any]:
    value["id"] = ledger.digest({k: v for k, v in value.items() if k != "id"})
    return value


def _changed(value: Dict[str, Any], change: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
    """Copy an existing record and apply a change without recomputing its id.

    Use this when the recorded identity itself is the defect. Rehashing here
    would silently repair the case under test.
    """
    bad = copy.deepcopy(value)
    change(bad)
    return bad


def _regenerated(value: Dict[str, Any], change: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
    """Copy, apply a change, then recompute the id.

    Use this only when the mutation targets a check that runs after the hash
    check, so the named semantic condition is the only defect.
    """
    return _rehash(_changed(value, change))


def _review(*, source: str = "run-1", path: str = "src/a.ts", findings: List[Dict[str, Any]] | None = None,
            **payload_overrides: Any) -> Dict[str, Any]:
    rows = [{"path": path, "blob": SHA, "intervals": [[1, 2]]}]
    payload: Dict[str, Any] = {
        "repo": ledger.REPO,
        "subject_id": "subject",
        "job_id": "subject:0",
        "attempt_id": "subject:0:1",
        "source": {"repo": ledger.REPO, "producer": "crq-runner-app", "type": "crq-run",
                   "id": source, "authenticated": True},
        **{key: SHA for key in ("base", "head", "head_tree", "target", "target_tree")},
        "policy_digest": SHA64,
        "scope_digest": ledger.digest(rows),
        "paths": [{"path": path, "blob": SHA, "mode": "100644", "disposition": "included",
                   "reason": "verified", "baseline": {}}],
        "requested_scope": copy.deepcopy(rows),
        "input_scope": copy.deepcopy(rows),
        "reviewed_scope": copy.deepcopy(rows),
        "completion": {"terminal": True, "skipped": False, "scope_verified": True,
                       "exit_code": 0, "errors": []},
        "outcome": "completed",
        "artifacts": [ARTIFACT],
        "findings": findings or [],
    }
    payload.update(payload_overrides)
    return ledger.event("review", ledger.REPO + ":crq-runner-app:" + source, AT, payload)


def _record(*, source: str = "import-1", producer: str = "agent", **payload_overrides: Any) -> Dict[str, Any]:
    """An S3b manual/agent report record: unverified, uncredited, provenance split."""
    rows: List[Dict[str, Any]] = []
    payload: Dict[str, Any] = {
        "repo": ledger.REPO,
        "subject_id": "subject",
        "job_id": "record:" + producer + ":" + source,
        "attempt_id": "record:" + "d" * 16,
        "source": {"repo": ledger.REPO, "producer": producer, "type": producer,
                   "id": source + ":" + "d" * 16, "authenticated": False},
        "provenance": {"authenticated_submitter": "queue-client",
                       "claimed_reviewer": "helper-agent",
                       "forge_evidence": "off-forge-import",
                       "completion_evidence": None,
                       "scope_confidence": "unknown",
                       "independence": "agent lane: separate session, unverified"},
        **{key: "0" * 40 for key in ("base", "head", "head_tree", "target", "target_tree")},
        "policy_digest": ledger.digest({"unknown-policy": True}),
        "scope_digest": ledger.digest(rows),
        "paths": [],
        "requested_scope": [],
        "input_scope": [],
        "reviewed_scope": [],
        "completion": {"terminal": False, "skipped": False, "scope_verified": False,
                       "exit_code": -1, "errors": ["no verifiable completion evidence"]},
        "outcome": "unverified",
        "artifacts": [{"sha256": "d" * 64, "location": "/fixtures/artifacts/" + "d" * 64,
                       "kind": "report"}],
        "findings": [],
    }
    payload.update(payload_overrides)
    return ledger.event("review", f"{ledger.REPO}:{producer}:{source}:" + "d" * 16, AT, payload)


def _finding(*, path: str = "src/a.ts", interval: List[int] | None = None) -> Dict[str, Any]:
    return {"id": "e" * 64, "severity": "major", "source_id": None, "path": path,
            "blob": SHA, "intervals": [interval or [1, 1]], "title": "标题 😀",
            "body": "details \u0001 with control", "status": "untriaged",
            "anchor_status": "verified"}


def _job_state(*, job_id: str = "fixture:0", state: str = "pending",
               reason: str = "inventory enqueue", **overrides: Any) -> Dict[str, Any]:
    payload = {"family": "fixture", "subject_id": "subject", "job_id": job_id,
               "generation": 0, "attempt": 0, "state": state, "failures": 0,
               "next_eligible_at": None, "reason": reason, **overrides}
    source_key = "job:" + payload["job_id"] + ":" + ledger.digest(payload)
    return ledger.event("job-state", source_key, AT, payload)


def _import(*, result: str = "unverified", review_id: str | None = None,
            duplicate_id: str | None = None, ident: str = "1") -> Dict[str, Any]:
    return ledger.event("import-result", "import:" + ident, AT, {
        "source": {"repo": ledger.REPO, "producer": "fixture", "type": "author-cli",
                   "id": ident, "authenticated": False},
        "source_digest": ARTIFACT["sha256"], "result": result,
        "reason": "No authenticated scope", "review_id": review_id,
        "duplicate_id": duplicate_id, "artifacts": [ARTIFACT],
    })


def _review_findings(source: str = "run-1") -> Dict[str, Any]:
    return _review(source=source, path="src/雪.ts", findings=[_finding(path="src/雪.ts")])


def canonical_vectors() -> Dict[str, Any]:
    cases = []
    for name, value in (
        ("nested-unicode", {"b": "雪😀", "a": [True, False, None, "\u0001"], "c": {"é": 2, "e": 1}}),
        ("utf16be-key-order", {"\uffff": 1, "\U00010000": 2, "a": 3, "\u00e9": 4}),
        ("integer-bounds", {"maximum": 9007199254740991, "minimum": -9007199254740991}),
        ("float-refused", {"bad": 1.5}),
        ("integer-beyond-json-range", {"bad": 9007199254740992}),
        ("negative-integer-beyond-json-range", {"bad": -9007199254740992}),
        ("non-scalar-unicode", {"bad": "\ud800"}),
    ):
        cases.append(_capture(name, "review_ledger.canonical+digest", {"value": value},
                              lambda value=value: _canonical(value)))
    return _family("canonical", cases)


def loads_vectors() -> Dict[str, Any]:
    raws = (
        ("valid-unicode", '{"雪":"😀","n":1,"z":-0}'),
        ("valid-integer-bound", "[9007199254740991]"),
        ("duplicate-key", '{"a":1,"a":2}'),
        ("float", "1.0"),
        ("exponent", "1e2"),
        ("nan-constant", "NaN"),
        ("infinity-constant", "Infinity"),
        ("negative-infinity-constant", "-Infinity"),
        ("integer-beyond-json-range", "[9007199254740992]"),
        ("lone-surrogate-escape", '"\\ud800"'),
        ("trailing-data", "[] extra"),
        ("malformed", "{"),
        ("empty", ""),
        # Python's parse_float/parse_constant refusals happen while scanning,
        # so they outrank a later syntax error; its object_pairs_hook runs at
        # object close, so an earlier duplicate does not.
        ("float-before-trailing-comma", "[1.0,]"),
        ("syntax-before-nan", "{broken NaN}"),
        ("duplicate-before-trailing-comma", '{"a":1,"a":2,}'),
        ("duplicate-at-close", '{"a":1,"a":2}'),
        ("duplicate-before-syntax", '{"a":1,"a":2,"b":}'),
        ("duplicate-before-nan", '{"a":1,"a":2,"b":NaN}'),
        ("nan-before-trailing-comma", "[NaN,]"),
        ("float-before-syntax", "[1.0, broken]"),
        ("float-before-bare-exponent", "[1.5e]"),
        ("float-before-bare-exponent-sign", "[1.5E+]"),
        ("integer-before-bare-exponent", "[1e]"),
        # Python combines escaped surrogate pairs into one scalar.
        ("escaped-surrogate-pair", '"\\ud83d\\ude00"'),
    )
    cases = [
        _capture(name, "review_ledger.loads", {"raw": raw},
                 lambda raw=raw: ledger.loads(raw))
        for name, raw in raws
    ]

    payload = '{"雪":"😀","n":1}'
    byte_cases = (
        ("bytes-utf8-bom", b"\xef\xbb\xbf" + payload.encode("utf-8")),
        ("bytes-utf16le-bom", b"\xff\xfe" + payload.encode("utf-16-le")),
        ("bytes-utf16be-bom", b"\xfe\xff" + payload.encode("utf-16-be")),
        ("bytes-utf32le-bom", b"\xff\xfe\x00\x00" + payload.encode("utf-32-le")),
        ("bytes-utf32be-bom", b"\x00\x00\xfe\xff" + payload.encode("utf-32-be")),
        ("bytes-utf16le-heuristic", payload.encode("utf-16-le")),
        ("bytes-utf16be-heuristic", payload.encode("utf-16-be")),
        ("bytes-utf32le-heuristic", payload.encode("utf-32-le")),
        ("bytes-utf32be-heuristic", payload.encode("utf-32-be")),
        # surrogatepass decodes the surrogate, then canonical() refuses it.
        ("bytes-raw-surrogate-utf8", b'"\xed\xa0\x80"'),
        # Adjacent raw surrogate code points stay separate in Python, while JS
        # would merge them into an astral scalar.
        ("bytes-adjacent-surrogates-utf8", b'"\xed\xa0\xbd\xed\xb8\x80"'),
        ("bytes-adjacent-surrogates-utf32",
         b"\xff\xfe\x00\x00"
         + b"".join(code.to_bytes(4, "little") for code in (0x22, 0xD83D, 0xDE00, 0x22))),
        ("bytes-utf16-surrogate-pair",
         b"\xff\xfe" + b"".join(unit.to_bytes(2, "little")
                                for unit in (0x22, 0xD83D, 0xDE00, 0x22))),
        ("bytes-utf16-unpaired-surrogate",
         b"\xff\xfe" + b"".join(unit.to_bytes(2, "little")
                                for unit in (0x22, 0xD83D, 0x61, 0x22))),
        ("bytes-utf32-scalar",
         b"\xff\xfe\x00\x00"
         + b"".join(code.to_bytes(4, "little") for code in (0x22, 0x1F600, 0x22))),
        ("bytes-invalid-utf8", b"\x80"),
        ("bytes-truncated-utf32", b"{\x00\x00\x00}\x00\x00"),
    )
    cases.extend(
        _capture(name, "review_ledger.loads", {"bytes": list(raw)},
                 lambda raw=raw: ledger.loads(raw))
        for name, raw in byte_cases
    )

    # A raw surrogate cannot survive json.dumps(ensure_ascii=True) as a
    # distinct code unit, so record the exact UTF-16 units instead.
    surrogate_inputs = (
        ("escape-high-literal-low", '"' + "\\ud83d" + "\ude00" + '"'),
        ("literal-high-escape-low", '"' + "\ud83d" + "\\ude00" + '"'),
        ("literal-high-alone", '"' + "\ud83d" + '"'),
        ("literal-low-alone", '"' + "\ude00" + '"'),
        ("raw-astral", '"😀"'),
    )
    cases.extend(
        _capture(name, "review_ledger.loads", {"utf16": _utf16_units(raw)},
                 lambda raw=raw: ledger.loads(raw))
        for name, raw in surrogate_inputs
    )
    return _family("loads", cases)


def timestamp_vectors() -> Dict[str, Any]:
    def stamp(value: Any) -> Dict[str, int]:
        parsed = ledger.timestamp(value)
        return {"year": parsed.year, "month": parsed.month, "day": parsed.day,
                "hour": parsed.hour, "minute": parsed.minute, "second": parsed.second}

    values = (
        ("exact-utc", "2026-10-30T00:00:00Z"),
        ("leap-day", "2024-02-29T23:59:59Z"),
        ("fraction-refused", "2026-10-30T00:00:00.5Z"),
        ("offset-refused", "2026-10-30T10:00:00+10:00"),
        ("space-separator-refused", "2026-10-30 00:00:00Z"),
        ("invalid-month", "2026-13-01T00:00:00Z"),
        ("invalid-day", "2026-02-30T00:00:00Z"),
        ("year-zero", "0000-01-01T00:00:00Z"),
        ("unicode-digits", "٢٠٢٦-١١-٠٩T٠٠:٠٠:٠٠Z"),
        # strptime's %Y accepts any Unicode decimal digits.
        ("unicode-year", "٢٠٢٦-11-09T00:00:00Z"),
        # %d, %H, %M and %S accept a Unicode digit after an ASCII digit.
        ("unicode-second-day", "2026-11-1٢T00:00:00Z"),
        ("unicode-second-hour", "2026-11-09T0٢:00:00Z"),
        ("unicode-second-minute", "2026-11-09T00:5٩:00Z"),
        ("unicode-second-second", "2026-11-09T00:00:5٩Z"),
        # %m is ASCII-only, and a leading non-ASCII digit is refused.
        ("unicode-month-refused", "2026-١١-09T00:00:00Z"),
        ("unicode-leading-day-refused", "2026-11-٢٢T00:00:00Z"),
        ("non-string", 1),
    )
    return _family("timestamp", [
        _capture(name, "review_ledger.timestamp", {"value": value},
                 lambda value=value: stamp(value))
        for name, value in values
    ])


def path_vectors() -> Dict[str, Any]:
    values = (
        ("nested", "src/ops/crq/tick.ts"),
        ("unicode", "docs/雪.md"),
        ("dot-directory", ".github/workflows/ci.yml"),
        ("absolute-refused", "/etc/passwd"),
        ("parent-refused", "src/../secret"),
        ("backslash-refused", "src\\a.ts"),
        ("empty-refused", ""),
        ("nul-refused", "src/a\u0000b.ts"),
        ("duplicate-slash-refused", "src//a.ts"),
        ("trailing-slash-refused", "src/"),
        ("dot-segment-refused", "src/./a.ts"),
        ("single-dot-refused", "."),
        ("non-string-refused", 1),
    )
    return _family("path", [
        _capture(name, "review_ledger.path", {"value": value},
                 lambda value=value: ledger.path(value))
        for name, value in values
    ])


def intervals_vectors() -> Dict[str, Any]:
    values = (
        ("single-range", [[1, 3]]),
        ("adjacent-ranges-merge-into-one-set", [[1, 2], [3, 4]]),
        ("gap-preserved", [[1, 2], [5, 6]]),
        ("maximum-line", [[1000000, 1000000]]),
        ("overlap-refused", [[1, 3], [3, 5]]),
        ("reversed-refused", [[3, 1]]),
        ("zero-start-refused", [[0, 1]]),
        ("negative-start-refused", [[-1, 1]]),
        ("boolean-refused", [[True, 2]]),
        ("float-refused", [[1.0, 2]]),
        ("end-too-large", [[1, 1000001]]),
    )
    return _family("intervals", [
        _capture(name, "review_ledger.intervals", {"rows": rows},
                 lambda rows=rows: sorted(ledger.intervals(rows)))
        for name, rows in values
    ])


def scope_vectors() -> Dict[str, Any]:
    def projection(rows: List[Dict[str, Any]]) -> List[Any]:
        return sorted(([path, blob, sorted(lines)] for (path, blob), lines in ledger.scope(rows).items()),
                      key=lambda row: (row[0], row[1]))

    values = (
        ("keyed-by-path-and-blob", [
            {"path": "src/a.ts", "blob": SHA, "intervals": [[1, 2]]},
            {"path": "src/a.ts", "blob": "d" * 40, "intervals": [[3, 3]]},
        ]),
        ("duplicate-path-blob-refused", [
            {"path": "src/a.ts", "blob": SHA, "intervals": [[1, 2]]},
            {"path": "src/a.ts", "blob": SHA, "intervals": [[3, 4]]},
        ]),
    )
    return _family("scope", [
        _capture(name, "review_ledger.scope", {"rows": rows},
                 lambda rows=rows: projection(rows))
        for name, rows in values
    ])


def event_vectors() -> Dict[str, Any]:
    def record(kind: str, source_key: str, occurred_at: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        value = ledger.event(kind, source_key, occurred_at, payload)
        return {"value": value, "canonical": ledger.canonical(value).decode("utf-8"),
                "sha256": ledger.digest(value), "record_path": ledger.record_path(value)}

    github = _review(source="run-github")
    github["payload"]["source"] = {"repo": ledger.REPO, "producer": "coderabbitai[bot]",
                                   "type": "github-review", "id": "review-1", "authenticated": True}
    github["source_key"] = ledger.REPO + ":coderabbitai[bot]:review-1"
    _rehash(github)

    finding_payload = {"finding_id": "e" * 64, "review_id": github["id"],
                       "previous_event_id": None, "action": "confirmed",
                       "evidence": {"target": SHA, "anchor_verified": True}, "actor": "operator"}

    job = {"family": "fixture", "subject_id": "subject", "job_id": "fixture:0",
           "generation": 0, "attempt": 0, "state": "pending", "failures": 0,
           "next_eligible_at": None, "reason": "inventory enqueue"}

    cases = [
        _capture("review-completed-unicode", "review_ledger.event",
                 {"kind": "review",
                  "source_key": ledger.REPO + ":crq-runner-app:run-雪",
                  "occurred_at": AT,
                  "payload": _review_findings("run-雪")["payload"]},
                 lambda: record("review", ledger.REPO + ":crq-runner-app:run-雪", AT,
                                _review_findings("run-雪")["payload"])),
        _capture("review-github-source", "review_ledger.event",
                 {"kind": "review", "source_key": github["source_key"],
                  "occurred_at": AT, "payload": github["payload"]},
                 lambda: record("review", github["source_key"], AT, github["payload"])),
        _capture("finding-event-confirmed", "review_ledger.event",
                 {"kind": "finding-event", "source_key": "triage:1",
                  "occurred_at": AT, "payload": finding_payload},
                 lambda: record("finding-event", "triage:1", AT, finding_payload)),
        _capture("import-result-unverified", "review_ledger.event",
                 {"kind": "import-result", "source_key": "import:1",
                  "occurred_at": AT, "payload": _import()["payload"]},
                 lambda: record("import-result", "import:1", AT, _import()["payload"])),
        _capture("job-state-inventory-enrollment", "review_ledger.event",
                 {"kind": "job-state",
                  "source_key": "job:fixture:0:" + ledger.digest(job),
                  "occurred_at": AT, "payload": job},
                 lambda: record("job-state", "job:fixture:0:" + ledger.digest(job), AT, job)),
        _capture("job-state-quarantine-release", "review_ledger.event",
                 {"kind": "job-state",
                  "source_key": "job:fixture:1:" + ledger.digest({**job, "job_id": "fixture:1",
                                                                  "state": "quarantine-released",
                                                                  "operator": "owner"}),
                  "occurred_at": AT,
                  "payload": {**job, "job_id": "fixture:1", "state": "quarantine-released",
                              "operator": "owner"}},
                 lambda: record("job-state",
                                "job:fixture:1:" + ledger.digest({**job, "job_id": "fixture:1",
                                                                  "state": "quarantine-released",
                                                                  "operator": "owner"}),
                                AT, {**job, "job_id": "fixture:1",
                                     "state": "quarantine-released", "operator": "owner"})),
    ]
    return _family("event", cases)


def validate_vectors() -> Dict[str, Any]:
    review = _review_findings()
    github = _review(source="run-github")
    github["payload"]["source"] = {"repo": ledger.REPO, "producer": "coderabbitai[bot]",
                                   "type": "github-review", "id": "review-1", "authenticated": True}
    github["source_key"] = ledger.REPO + ":coderabbitai[bot]:review-1"
    _rehash(github)
    record = _record()
    manual_record = _record(source="note-1", producer="manual")

    finding_event = ledger.event("finding-event", "triage:1", AT, {
        "finding_id": "e" * 64, "review_id": github["id"], "previous_event_id": None,
        "action": "confirmed", "evidence": {"target": SHA, "anchor_verified": True},
        "actor": "operator"})
    job = _job_state()
    imported = _import()

    values: List[tuple[str, Dict[str, Any]]] = [
        ("valid-review", review),
        ("valid-github-review", github),
        ("valid-agent-record", record),
        ("valid-manual-record", manual_record),
        ("valid-finding-event", finding_event),
        ("valid-job-state", job),
        ("valid-import-result", imported),
        # Keep the original id: the id/hash mismatch is the defect under test.
        ("tampered-id", _changed(review, lambda v: v.__setitem__("id", "0" * 64))),
        ("unknown-field", _regenerated(review, lambda v: v.__setitem__("extra", 1))),
        ("missing-required", _regenerated(review, lambda v: v.pop("source_key"))),
        ("schema-version", _regenerated(review, lambda v: v.__setitem__("schema", "cq.review-ledger/v2"))),
        # canonical() refuses floats, so the id cannot be recomputed here. The
        # schema type check runs before the hash check and is the defect under
        # test.
        ("float-in-integer", _changed(job, lambda v: v["payload"].__setitem__("generation", 0.0))),
        ("boolean-in-integer", _regenerated(job, lambda v: v["payload"].__setitem__("attempt", True))),
        ("source-identity-mismatch", _regenerated(review, lambda v: v.__setitem__("source_key", "wrong"))),
        ("scope-digest-mismatch",
         _regenerated(review, lambda v: v["payload"].__setitem__("scope_digest", "0" * 64))),
        ("reviewed-exceeds-requested",
         _regenerated(review, lambda v: v["payload"]["reviewed_scope"][0].__setitem__("intervals", [[1, 3]]))),
        ("reviewed-exceeds-input",
         _regenerated(review, lambda v: v["payload"]["input_scope"][0].__setitem__("intervals", [[2, 2]]))),
        ("duplicate-path-disposition",
         _regenerated(review, lambda v: v["payload"]["paths"].append(copy.deepcopy(v["payload"]["paths"][0])))),
        ("credit-on-excluded-path",
         _regenerated(review, lambda v: v["payload"]["paths"][0].__setitem__("disposition", "deleted"))),
        ("verified-finding-without-anchor",
         _regenerated(review, lambda v: v["payload"]["findings"][0]["intervals"].clear())),
        ("completed-not-creditable",
         _regenerated(review, lambda v: v["payload"]["completion"].__setitem__("errors", ["error"]))),
        ("record-provenance-missing",
         _regenerated(record, lambda v: v["payload"].pop("provenance"))),
        ("record-provenance-on-vendor-run",
         _regenerated(review, lambda v: v["payload"].__setitem__(
             "provenance", {"authenticated_submitter": "op", "claimed_reviewer": "x",
                            "forge_evidence": "off-forge-import",
                            "completion_evidence": None, "scope_confidence": "unknown",
                            "independence": None}))),
        ("record-forge-evidence-unknown",
         _regenerated(record, lambda v: v["payload"]["provenance"].__setitem__(
             "forge_evidence", "someone-said-so"))),
        ("record-supersedes-self",
         # Not _regenerated: rehashing would recompute the id and the
         # supersedes pointer would no longer name the event's own id, so the
         # semantic defect would vanish and the vector would validate as ok.
         # The stale hash is intentional here; the identity check runs after
         # provenance, so the self-supersede refusal is the observed failure.
         _changed(record, lambda v: v["payload"].__setitem__("supersedes", v["id"]))),
        ("record-supersedes-on-vendor-run",
         _regenerated(review, lambda v: v["payload"].__setitem__("supersedes", "e" * 64))),
        ("record-completed-without-evidence",
         _regenerated(record, lambda v: v["payload"].update(
             {"outcome": "completed",
              "completion": {"terminal": True, "skipped": False, "scope_verified": False,
                             "exit_code": 0, "errors": []}}))),
        ("missing-evidence", _regenerated(finding_event, lambda v: v["payload"].__setitem__("evidence", {}))),
        ("fixed-without-verification",
         _regenerated(finding_event, lambda v: v["payload"].update(
             {"action": "fixed", "evidence": {"fixing_commit": SHA}}))),
        ("delivered-without-task",
         _regenerated(finding_event, lambda v: v["payload"].update(
             {"action": "delivered", "evidence": {"acknowledgement": "ok"}}))),
        ("confirmed-without-anchor",
         _regenerated(finding_event, lambda v: v["payload"].update(
             {"action": "confirmed", "evidence": {"target": SHA}}))),
        ("quarantine-without-operator",
         _regenerated(job, lambda v: v["payload"].__setitem__("state", "quarantine-released"))),
        ("bad-next-eligible",
         _regenerated(job, lambda v: v["payload"].__setitem__("next_eligible_at", "night"))),
        ("import-credited-without-review",
         _regenerated(imported, lambda v: v["payload"].__setitem__("result", "credited"))),
        ("import-duplicate-without-duplicate",
         _regenerated(imported, lambda v: v["payload"].__setitem__("result", "duplicate"))),
        ("occurred-at-invalid",
         _regenerated(review, lambda v: v.__setitem__("occurred_at", "2026-02-30T00:00:00Z"))),
    ]
    return _family("validate", [
        _capture(name, "review_ledger.validate", {"value": value},
                 lambda value=value: ledger.validate(value))
        for name, value in values
    ])


def record_path_vectors() -> Dict[str, Any]:
    return _family("record_path", [
        _capture("month-padding", "review_ledger.record_path",
                 {"value": {"occurred_at": "2026-01-02T00:00:00Z", "id": "d" * 64}},
                 lambda: ledger.record_path({"occurred_at": "2026-01-02T00:00:00Z", "id": "d" * 64})),
        _capture("year-padding", "review_ledger.record_path",
                 {"value": {"occurred_at": "0001-12-31T00:00:00Z", "id": "d" * 64}},
                 lambda: ledger.record_path({"occurred_at": "0001-12-31T00:00:00Z", "id": "d" * 64})),
        _capture("invalid-timestamp", "review_ledger.record_path",
                 {"value": {"occurred_at": "2026-02-30T00:00:00Z", "id": "d" * 64}},
                 lambda: ledger.record_path({"occurred_at": "2026-02-30T00:00:00Z", "id": "d" * 64})),
    ])


def creditable_vectors() -> Dict[str, Any]:
    review = _review()
    github = _review(source="run-github")
    github["payload"]["source"] = {"repo": ledger.REPO, "producer": "coderabbitai[bot]",
                                   "type": "github-review", "id": "review-1", "authenticated": True}
    github["source_key"] = ledger.REPO + ":coderabbitai[bot]:review-1"
    _rehash(github)
    job = _job_state()

    def variant(change: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        return _regenerated(review, change)

    values = (
        ("crq-run-completed", review),
        ("github-review-completed", github),
        ("author-cli-not-creditable", _regenerated(review, lambda v: v["payload"]["source"].update(
            {"type": "author-cli", "producer": "author"}))),
        ("not-terminal", variant(lambda v: v["payload"]["completion"].__setitem__("terminal", False))),
        ("skipped", variant(lambda v: v["payload"]["completion"].__setitem__("skipped", True))),
        ("scope-unverified", variant(lambda v: v["payload"]["completion"].__setitem__("scope_verified", False))),
        ("exit-code", variant(lambda v: v["payload"]["completion"].__setitem__("exit_code", 1))),
        ("errors", variant(lambda v: v["payload"]["completion"].__setitem__("errors", ["e"]))),
        ("blocked-outcome", variant(lambda v: v["payload"].__setitem__("outcome", "blocked"))),
        ("non-review-event", job),
    )
    return _family("creditable", [
        _capture(name, "review_ledger.creditable", {"value": value},
                 lambda value=value: ledger.creditable(value))
        for name, value in values
    ])


def independence_vectors() -> Dict[str, Any]:
    unverified = _import(result="unverified", ident="u")
    rejected = _import(result="rejected", ident="r")
    linked = _import(result="credited", review_id="f" * 64, ident="c")
    enrollment = _job_state()
    transition = _job_state(attempt=1, reason="transition")
    operated = _job_state(operator="owner")

    def payload_deleted(value: Dict[str, Any], field: str) -> Dict[str, Any]:
        changed = copy.deepcopy(value)
        del changed["payload"][field]
        return changed

    def payload_set(value: Dict[str, Any], field: str, replacement: Any) -> Dict[str, Any]:
        changed = copy.deepcopy(value)
        changed["payload"][field] = replacement
        return changed

    def payload_replaced(value: Dict[str, Any], replacement: Any) -> Dict[str, Any]:
        changed = copy.deepcopy(value)
        changed["payload"] = replacement
        return changed

    def top_deleted(value: Dict[str, Any], field: str) -> Dict[str, Any]:
        changed = copy.deepcopy(value)
        del changed[field]
        return changed

    def top_set(value: Dict[str, Any], field: str, replacement: Any) -> Dict[str, Any]:
        changed = copy.deepcopy(value)
        changed[field] = replacement
        return changed

    def job_with(**changes: Any) -> Dict[str, Any]:
        """A valid enrollment with changed fields and a matching source key."""
        value = _job_state()
        value["payload"].update(changes)
        payload = value["payload"]
        value["source_key"] = "job:" + payload["job_id"] + ":" + ledger.digest(payload)
        return value

    import_rule = _import()
    import_cases = [
        ("unverified", unverified), ("rejected", rejected),
        ("credited-not-independent", linked),
        ("review-id-present-not-independent",
         _regenerated(unverified, lambda v: v["payload"].__setitem__("review_id", "f" * 64))),
        # Python's tuple membership compares, never hashes: list/dict/number
        # results are non-matches, while missing keys remain KeyError.
        ("matrix-result-null", payload_set(import_rule, "result", None)),
        ("matrix-result-false", payload_set(import_rule, "result", False)),
        ("matrix-result-true", payload_set(import_rule, "result", True)),
        ("matrix-result-zero", payload_set(import_rule, "result", 0)),
        ("matrix-result-one", payload_set(import_rule, "result", 1)),
        ("matrix-result-list", payload_set(import_rule, "result", [])),
        ("matrix-result-dict", payload_set(import_rule, "result", {})),
        ("matrix-result-other-string", payload_set(import_rule, "result", "other")),
        ("matrix-result-rejected", payload_set(import_rule, "result", "rejected")),
        ("matrix-result-missing", payload_deleted(import_rule, "result")),
        ("matrix-review-id-missing", payload_deleted(import_rule, "review_id")),
        ("matrix-review-id-false", payload_set(import_rule, "review_id", False)),
        ("matrix-review-id-zero", payload_set(import_rule, "review_id", 0)),
        ("matrix-review-id-list", payload_set(import_rule, "review_id", [])),
        ("matrix-review-id-dict", payload_set(import_rule, "review_id", {})),
        ("matrix-duplicate-id-missing", payload_deleted(import_rule, "duplicate_id")),
        ("matrix-duplicate-id-false", payload_set(import_rule, "duplicate_id", False)),
        ("matrix-duplicate-id-zero", payload_set(import_rule, "duplicate_id", 0)),
        ("matrix-duplicate-id-list", payload_set(import_rule, "duplicate_id", [])),
        ("matrix-event-type-missing", top_deleted(import_rule, "event_type")),
        ("matrix-event-type-null", top_set(import_rule, "event_type", None)),
        ("matrix-event-type-list", top_set(import_rule, "event_type", [])),
        ("matrix-event-type-other-result-missing",
         payload_deleted(top_set(import_rule, "event_type", "other"), "result")),
        ("matrix-payload-missing", top_deleted(import_rule, "payload")),
        ("matrix-payload-null", payload_replaced(import_rule, None)),
        ("matrix-payload-list", payload_replaced(import_rule, [])),
        ("matrix-payload-string", payload_replaced(import_rule, "x")),
        ("matrix-payload-number", payload_replaced(import_rule, 1)),
        ("matrix-payload-bool", payload_replaced(import_rule, True)),
    ]
    enrollment_cases = [
        ("initial-enrollment", enrollment),
        ("attempt-transition-not-initial", transition),
        ("operator-not-initial", operated),
        ("reason-not-inventory", _job_state(reason="other")),
        ("next-eligible-not-initial", _job_state(next_eligible_at=AT)),
        ("matrix-reason-missing", payload_deleted(enrollment, "reason")),
        ("matrix-reason-other", payload_set(enrollment, "reason", "other")),
        ("matrix-reason-null", payload_set(enrollment, "reason", None)),
        ("matrix-reason-list", payload_set(enrollment, "reason", [])),
        ("matrix-reason-other-state-missing",
         payload_deleted(payload_set(enrollment, "reason", "other"), "state")),
        ("matrix-state-missing", payload_deleted(enrollment, "state")),
        ("matrix-state-other", payload_set(enrollment, "state", "other")),
        ("matrix-state-null", payload_set(enrollment, "state", None)),
        ("matrix-state-list", payload_set(enrollment, "state", [])),
        ("matrix-attempt-missing", payload_deleted(enrollment, "attempt")),
        ("matrix-attempt-false", job_with(attempt=False)),
        ("matrix-attempt-true", payload_set(enrollment, "attempt", True)),
        ("matrix-attempt-one", payload_set(enrollment, "attempt", 1)),
        ("matrix-attempt-float-zero", payload_set(enrollment, "attempt", 0.0)),
        ("matrix-attempt-null", payload_set(enrollment, "attempt", None)),
        ("matrix-attempt-string", payload_set(enrollment, "attempt", "0")),
        ("matrix-attempt-list", payload_set(enrollment, "attempt", [])),
        ("matrix-attempt-dict", payload_set(enrollment, "attempt", {})),
        ("matrix-failures-missing", payload_deleted(enrollment, "failures")),
        ("matrix-failures-false", job_with(failures=False)),
        ("matrix-generation-false", job_with(generation=False)),
        ("matrix-next-eligible-missing", payload_deleted(enrollment, "next_eligible_at")),
        ("matrix-next-eligible-false", payload_set(enrollment, "next_eligible_at", False)),
        ("matrix-next-eligible-zero", payload_set(enrollment, "next_eligible_at", 0)),
        ("matrix-next-eligible-string", payload_set(enrollment, "next_eligible_at", "x")),
        ("matrix-next-eligible-list", payload_set(enrollment, "next_eligible_at", [])),
        ("matrix-operator-present", payload_set(enrollment, "operator", "owner")),
        ("matrix-operator-null", payload_set(enrollment, "operator", None)),
        ("matrix-operator-present-source-key-missing",
         top_deleted(payload_set(enrollment, "operator", "owner"), "source_key")),
        ("matrix-source-key-missing", top_deleted(enrollment, "source_key")),
        ("matrix-source-key-null", top_set(enrollment, "source_key", None)),
        ("matrix-source-key-false", top_set(enrollment, "source_key", False)),
        ("matrix-source-key-number", top_set(enrollment, "source_key", 1)),
        ("matrix-source-key-list", top_set(enrollment, "source_key", [])),
        ("matrix-source-key-dict", top_set(enrollment, "source_key", {})),
        ("matrix-source-key-wrong", top_set(enrollment, "source_key", "job:wrong")),
        ("matrix-job-id-missing", payload_deleted(enrollment, "job_id")),
        ("matrix-job-id-null", payload_set(enrollment, "job_id", None)),
        ("matrix-job-id-bool", payload_set(enrollment, "job_id", True)),
        ("matrix-job-id-number", payload_set(enrollment, "job_id", 1)),
        ("matrix-job-id-list", payload_set(enrollment, "job_id", [])),
        ("matrix-job-id-dict", payload_set(enrollment, "job_id", {})),
        ("matrix-event-type-missing", top_deleted(enrollment, "event_type")),
        ("matrix-event-type-null", top_set(enrollment, "event_type", None)),
        ("matrix-event-type-list", top_set(enrollment, "event_type", [])),
        ("matrix-event-type-other-payload-missing",
         top_deleted(top_set(enrollment, "event_type", "other"), "payload")),
        ("matrix-payload-missing", top_deleted(enrollment, "payload")),
        ("matrix-payload-null", payload_replaced(enrollment, None)),
        ("matrix-payload-list", payload_replaced(enrollment, [])),
        ("matrix-payload-string", payload_replaced(enrollment, "x")),
        ("matrix-payload-number", payload_replaced(enrollment, 1)),
        ("matrix-payload-bool", payload_replaced(enrollment, True)),
    ]
    duplicate = _job_state(subject_id="other")
    batch_cases = (
        ("homogeneous-imports", [unverified, rejected], []),
        ("distinct-enrollments", [enrollment, _job_state(job_id="fixture:1")], []),
        ("duplicate-job", [duplicate], [enrollment]),
        ("mixed-kinds", [enrollment, unverified], []),
        ("transition", [transition], []),
    )

    cases: List[Dict[str, Any]] = []
    cases += [_capture("import-" + name if name.startswith("matrix-") else name,
                       "review_ledger.independent_import", {"value": value},
                       lambda value=value: ledger.independent_import(value))
              for name, value in import_cases]
    cases += [_capture("enroll-" + name if name.startswith("matrix-") else name,
                       "review_ledger.initial_inventory_enrollment", {"value": value},
                       lambda value=value: ledger.initial_inventory_enrollment(value))
              for name, value in enrollment_cases]
    cases += [_capture(name, "review_ledger.independent_batch",
                       {"values": values, "previous": previous},
                       lambda values=values, previous=previous:
                       ledger.independent_batch(values, previous))
              for name, values, previous in batch_cases]
    return _family("independence", cases)


def sequence_vectors() -> Dict[str, Any]:
    review = _review(path="src/雪.ts", findings=[_finding(path="src/雪.ts")])
    review_id = review["id"]
    finding_id = "e" * 64
    first = ledger.event("finding-event", "triage:1", AT, {
        "finding_id": finding_id, "review_id": review_id, "previous_event_id": None,
        "action": "needs-human", "evidence": {"reason": "ambiguous"}, "actor": "operator"})
    second = ledger.event("finding-event", "triage:2", AT, {
        "finding_id": finding_id, "review_id": review_id, "previous_event_id": first["id"],
        "action": "dismissed", "evidence": {"reason": "superseded by fix"}, "actor": "operator"})
    fork = ledger.event("finding-event", "triage:3", AT, {
        "finding_id": finding_id, "review_id": review_id, "previous_event_id": None,
        "action": "dismissed", "evidence": {"reason": "fork"}, "actor": "operator"})
    imported = _import(result="credited", review_id=review_id)
    missing = _import(result="credited", review_id="f" * 64)

    def ids(values: List[Dict[str, Any]]) -> List[str]:
        return sorted(ledger.validate_sequence(values))

    def same_review_twice() -> List[Dict[str, Any]]:
        return [review, ledger.loads(ledger.canonical(review))]

    conflict = _regenerated(review, lambda v: v.__setitem__("occurred_at", "2026-10-31T00:00:00Z"))

    collision_review = _review(source="run-2", findings=[_finding()])

    cases = [
        _capture("review-then-finding-events", "review_ledger.validate_sequence",
                 {"values": [review, first, second]}, lambda: ids([review, first, second])),
        _capture("duplicate-record-id-is-idempotent", "review_ledger.validate_sequence",
                 {"values": same_review_twice()}, lambda: ids(same_review_twice())),
        _capture("source-evidence-conflict", "review_ledger.validate_sequence",
                 {"values": [review, conflict]}, lambda: ids([review, conflict])),
        _capture("stale-predecessor", "review_ledger.validate_sequence",
                 {"values": [review, second]}, lambda: ids([review, second])),
        _capture("forked-predecessor", "review_ledger.validate_sequence",
                 {"values": [review, first, fork]}, lambda: ids([review, first, fork])),
        _capture("finding-occurrence-collision", "review_ledger.validate_sequence",
                 {"values": [review, collision_review]}, lambda: ids([review, collision_review])),
        _capture("import-credited-links-review", "review_ledger.validate_sequence",
                 {"values": [review, imported]}, lambda: ids([review, imported])),
        _capture("import-missing-review", "review_ledger.validate_sequence",
                 {"values": [missing]}, lambda: ids([missing])),
        _capture("unknown-finding", "review_ledger.validate_sequence",
                 {"values": [first]}, lambda: ids([first])),
    ]
    return _family("sequence", cases)


def document() -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/ledger_vector_emit_b1.py",
        "families": [
            canonical_vectors(),
            loads_vectors(),
            timestamp_vectors(),
            path_vectors(),
            intervals_vectors(),
            scope_vectors(),
            event_vectors(),
            validate_vectors(),
            record_path_vectors(),
            creditable_vectors(),
            independence_vectors(),
            sequence_vectors(),
        ],
    }


def render() -> str:
    return json.dumps(document(), indent=2, ensure_ascii=True, sort_keys=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="rewrite the checked-in vectors")
    parser.add_argument("--check", action="store_true", help="fail when the checked-in vectors are stale")
    parser.add_argument("--stdout", action="store_true", help="print the document")
    options = parser.parse_args()
    text = render()
    if options.stdout:
        sys.stdout.buffer.write(text.encode("utf-8"))
        return 0
    if options.check:
        existing = FIXTURE.read_bytes() if FIXTURE.exists() else b""
        if existing != text.encode("utf-8"):
            print(f"{FIXTURE} is stale; run python3 ledger_vector_emit_b1.py --write",
                  file=sys.stderr)
            return 1
        return 0
    if options.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(text.encode("utf-8"))
        print(f"wrote {FIXTURE}", file=sys.stderr)
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
