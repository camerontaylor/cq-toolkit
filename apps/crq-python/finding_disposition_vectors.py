#!/usr/bin/env python3
"""Deterministic offline oracle for the TS finding-inbox disposition methods.

Test tooling only. It drives the PRODUCTION ``finding_delivery.Inbox``
``context_error``, ``recovered_anchor``, ``triage`` and ``repair_outcome``
against a throwaway temp directory (real ``triage/*.json`` rows, a real
``review_ledger.Outbox``) and records what Python actually does: the return
value, the exception class, the final canonical rows, the spooled outbox
events, the lock/spool/write effect order and the ordered repository reads.

Every external effect is injected. The repository answers from recorded facts
and raises ``CalledProcessError`` for anything it has no fact for. Artifact
bytes live in a fixture table: ``ArtifactStore.verify`` is replaced by a
table lookup and ``Path.read_bytes`` serves the virtual
``/fixtures/artifacts/`` locations, so event ids never depend on a host path.
No production module is modified and no production queue, state, network,
model, signer or host service is touched.

The TypeScript test (``test/ops/crq/findingDisposition.test.ts``) replays the
same specs through ``FindingDispositions`` and compares everything recorded
here. Cases where Python raises an uncaught exception record the class name
and the port must refuse with the same Python class.

Regenerate with ``python3.14 finding_disposition_vectors.py --write`` and
verify with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``,
no timestamps or host paths.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterator, List
from unittest import mock

import finding_delivery
import review_ledger as ledger
from ledger_vector_emit_b1 import AT, SHA, _finding, _record, _review

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-finding-disposition" / "cases.json"
VIRTUAL = "/fixtures/artifacts/sha256/"
BLOB = "b" * 40
BLOB2 = "d" * 40
HEAD = "1" * 40
NEXT = "2" * 40
FIX = "3" * 40
FID = "e" * 64
FID2 = "f" * 64
RID = "9" * 64


class Trap(AssertionError):
    """A vector referenced a fact the spec never supplied: a bug in the vector."""


def _hex(text: str) -> str:
    return text.encode("utf-8").hex()


class FakeRepo:
    def __init__(self, facts: Dict[str, Any], calls: List[List[Any]]) -> None:
        self.facts, self.calls = facts, calls

    def _fail(self, *argv: str) -> None:
        raise subprocess.CalledProcessError(128, ["git", *argv])

    def resolve(self, value: str) -> str:
        self.calls.append(["resolve", value])
        if value not in self.facts.get("resolve", {}):
            self._fail("rev-parse", value)
        return self.facts["resolve"][value]

    def entries(self, commit: str) -> Dict[str, Any]:
        self.calls.append(["entries", commit])
        if commit not in self.facts.get("entries", {}):
            self._fail("ls-tree", commit)
        return copy.deepcopy(self.facts["entries"][commit])

    def git(self, *argv: str) -> bytes:
        self.calls.append(["git", *argv])
        if argv[:2] != ("cat-file", "blob") or argv[2] not in self.facts.get("blobs", {}):
            self._fail(*argv)
        return bytes.fromhex(self.facts["blobs"][argv[2]])

    def carry(self, old: str, new: str, path: str, lines: set) -> Any:
        ordered = sorted(lines)
        self.calls.append(["carry", old, new, path, ordered])
        for fact in self.facts.get("carry", []):
            if [fact["old"], fact["next"], fact["path"], fact["lines"]] == [old, new, path, ordered]:
                return fact["name"], set(fact["mapped"])
        raise Trap(f"no carry fact for {old} {new} {path} {ordered}")


class FixtureArtifacts:
    """`ArtifactStore.verify` as a table lookup (virtual, host-independent)."""

    def __init__(self, table: Dict[str, Any]) -> None:
        self.table = table

    def verify(self, reference: Dict[str, Any]) -> None:
        entry = self.table.get(reference["sha256"])
        if entry is None or entry.get("verify") == "fail":
            raise ledger.IntegrityError("missing or corrupt retained artifact")

    def put(self, data: bytes) -> Dict[str, str]:
        raise Trap("vectors never put artifacts")


class TracedOutbox(ledger.Outbox):
    def __init__(self, root: Path, artifacts: Any, trace: List[str]) -> None:
        super().__init__(root, artifacts)
        self.trace = trace

    def retained(self) -> Any:
        self.trace.append("retained")
        return super().retained()

    def spool(self, value: Any) -> Any:
        self.trace.append("spool")
        return super().spool(value)


def _artifact_bytes(entry: Dict[str, Any]) -> bytes:
    read = entry.get("read", "ok")
    if read == "missing":
        raise FileNotFoundError("fixture artifact is missing")
    return bytes.fromhex(entry["swapped_hex"] if read == "swapped" else entry["hex"])


@contextlib.contextmanager
def _patched(table: Dict[str, Any], trace: List[str]) -> Iterator[None]:
    original_locked, original_atomic, original_read = ledger.locked, ledger.atomic, Path.read_bytes

    @contextlib.contextmanager
    def locked(path: Any) -> Iterator[None]:
        name = Path(path).name
        trace.append("lock:" + name)
        try:
            with original_locked(path):
                yield
        finally:
            trace.append("unlock:" + name)

    def atomic(path: Any, data: bytes) -> None:
        path = Path(path)
        trace.append("write:" + path.parent.name + "/" + path.name)
        return original_atomic(path, data)

    def read_bytes(self: Path) -> bytes:
        text = str(self)
        if text.startswith(VIRTUAL):
            entry = table.get(text[len(VIRTUAL):])
            if entry is None:
                raise FileNotFoundError(text)
            return _artifact_bytes(entry)
        return original_read(self)

    ledger.locked, ledger.atomic, Path.read_bytes = locked, atomic, read_bytes
    try:
        yield
    finally:
        ledger.locked, ledger.atomic, Path.read_bytes = original_locked, original_atomic, original_read


def _text(value: Any) -> str:
    return ledger.canonical(value).decode("utf-8")


def _snapshot(root: Path, pub: Path) -> Dict[str, Any]:
    rows = {p.name[:-5]: _text(ledger.loads(p.read_bytes())) for p in sorted((root / "triage").glob("*.json"))}
    pending = {p.name[:-5]: _text(ledger.loads(p.read_bytes()))
               for p in sorted((pub / "pending").glob("*.json"))} if (pub / "pending").exists() else {}
    return {"rows": rows, "pending": pending}


def _write_rows(root: Path, rows: Dict[str, Any]) -> None:
    for fid, row in rows.items():
        ledger.atomic(root / "triage" / (fid + ".json"), ledger.canonical(row))


def _call(inbox: finding_delivery.Inbox, repo: FakeRepo, call: Dict[str, Any]) -> Any:
    method, args, kwargs = call["method"], copy.deepcopy(call.get("args", [])), copy.deepcopy(call.get("kwargs", {}))
    if method == "context_error":
        return inbox.context_error(*args)
    if method == "recovered_anchor":
        return inbox.recovered_anchor(args[0], repo, args[1])
    if method == "triage":
        return inbox.triage(args[0], repo, *args[1:], **kwargs)
    if method == "repair_outcome":
        return inbox.repair_outcome(*args, **kwargs)
    raise Trap(method)


def run(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Execute every step of one spec and return the recorded outcomes."""
    table = spec.get("artifacts", {})
    steps: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as directory:
        root, pub = Path(directory) / "findings", Path(directory) / "publication"
        trace: List[str] = []
        outbox = TracedOutbox(pub, FixtureArtifacts(table), trace)
        inbox = finding_delivery.Inbox(root, outbox)
        _write_rows(root, spec.get("rows", {}))
        for event in spec.get("retained", []):
            outbox.spool(event)
        for step in spec["steps"]:
            if "reset" in step:
                for p in (root / "triage").glob("*.json"):
                    p.unlink()
                _write_rows(root, step["reset"])
                steps.append({"reset": True})
                continue
            calls: List[List[Any]] = []
            trace.clear()
            outcome: Dict[str, Any]
            with _patched(table, trace):
                try:
                    value = _call(inbox, FakeRepo(spec.get("repo", {}), calls), step)
                    outcome = {"returns": None if value is None else (value if isinstance(value, bool) else _text(value)),
                               "kind": "none" if value is None else ("bool" if isinstance(value, bool) else "json")}
                except Trap:
                    raise
                except Exception as error:  # noqa: BLE001 - the class name is the recorded fact
                    outcome = {"raises": type(error).__name__,
                               "message": str(error).replace(str(root), "<root>")}
            outcome.update(calls=calls, trace=list(trace), **_snapshot(root, pub))
            steps.append(outcome)
    return {"steps": steps}


# ---------------------------------------------------------------- builders

def _artifact(raw: str, **entry: Any) -> Dict[str, Any]:
    data = raw.encode("utf-8")
    return {"hex": data.hex(), **entry}


def _reference(raw: str) -> Dict[str, str]:
    sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return {"sha256": sha, "location": VIRTUAL + sha}


def _vendor(*events: Dict[str, Any]) -> str:
    return "\n".join(json.dumps(event) for event in events) + "\n"


def _finding_row(**over: Any) -> Dict[str, Any]:
    value = {**_finding(path="src/a.ts"), "id": FID, "title": "Title", "body": "Body",
             "intervals": [[1, 2]], "blob": BLOB, "status": "untriaged", "anchor_status": "verified"}
    value.update(over)
    return value


def _row(finding: Dict[str, Any], review_id: str, **over: Any) -> Dict[str, Any]:
    value = {"review_id": review_id, "finding": finding, "target": SHA, "canonical_id": finding["id"],
             "previous_event_id": None, "status": "untriaged"}
    value.update(over)
    return value


def _run_review(finding: Dict[str, Any], raw: str, *, source: str = "run-1", **over: Any) -> Dict[str, Any]:
    return _review(source=source, findings=[finding], artifacts=[_reference(raw)], **over)


def _repo(**over: Any) -> Dict[str, Any]:
    value: Dict[str, Any] = {
        "resolve": {HEAD: HEAD, "main": HEAD, "next": NEXT, "fix": FIX},
        "entries": {SHA: {"src/a.ts": {"blob": BLOB}}, HEAD: {"src/a.ts": {"blob": BLOB2}}},
        "blobs": {BLOB: _hex("one\ntwo\nthree\n"), BLOB2: _hex("one\ntwo\nthree\n")},
        "carry": [],
    }
    value.update(over)
    return value


def _carry(*, lines: List[int], name: str | None, mapped: List[int], old: str = SHA, new: str = HEAD,
           path: str = "src/a.ts") -> Dict[str, Any]:
    return {"old": old, "next": new, "path": path, "lines": lines, "name": name, "mapped": mapped}


def _event(kind: str, key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return ledger.event(kind, key, AT, payload)


def _finding_event(previous: Any, action: str, evidence: Dict[str, Any], *, actor: str = "crq-triage",
                   review_id: str, fid: str = FID, key: str | None = None) -> Dict[str, Any]:
    return _event("finding-event", key or f"finding:{fid}:{ledger.digest([previous, action, evidence])}", {
        "finding_id": fid, "review_id": review_id, "previous_event_id": previous,
        "action": action, "evidence": evidence, "actor": actor})


def _case(name: str, steps: List[Dict[str, Any]], **spec: Any) -> Dict[str, Any]:
    return {"name": name, "spec": {"steps": steps, **spec}}


def _triage(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    return {"method": "triage", "args": list(args), "kwargs": kwargs}


def _ctx(*args: Any) -> Dict[str, Any]:
    return {"method": "context_error", "args": list(args)}


def _anchor(row: Dict[str, Any], reviews: List[Any]) -> Dict[str, Any]:
    return {"method": "recovered_anchor", "args": [row, reviews]}


def _outcome(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    return {"method": "repair_outcome", "args": list(args), "kwargs": kwargs}


# ------------------------------------------------------------------- cases

def context_cases() -> List[Dict[str, Any]]:
    finding = _finding_row()
    base = _row(finding, RID, previous_event_id="p1")
    with_error = {**base, "context_error": "old"}
    return [
        _case("ctx-set-error", [_ctx(FID, "p1", "boom")], rows={FID: base}),
        _case("ctx-set-empty-string-is-not-none", [_ctx(FID, "p1", "")], rows={FID: base}),
        _case("ctx-snapshot-superseded", [_ctx(FID, "stale", "boom")], rows={FID: base}),
        _case("ctx-clear-present", [_ctx(FID, "p1", None)], rows={FID: with_error}),
        _case("ctx-clear-absent-no-write", [_ctx(FID, "p1", None)], rows={FID: base}),
        _case("ctx-null-expected-matches-null-row", [_ctx(FID, None, "x")],
              rows={FID: _row(finding, RID)}),
        _case("ctx-one-equals-true", [_ctx(FID, True, "x")], rows={FID: {**base, "previous_event_id": 1}}),
        _case("ctx-zero-equals-false", [_ctx(FID, False, "x")], rows={FID: {**base, "previous_event_id": 0}}),
        _case("ctx-string-vs-number", [_ctx(FID, "1", "x")], rows={FID: {**base, "previous_event_id": 1}}),
        _case("ctx-missing-row", [_ctx(FID, None, "x")], rows={}),
        _case("ctx-row-without-previous", [_ctx(FID, None, "x")], rows={FID: {"review_id": RID}}),
        _case("ctx-structured-error", [_ctx(FID, "p1", {"a": [1, "é"]})], rows={FID: base}),
    ]


def anchor_cases() -> List[Dict[str, Any]]:
    event = {"type": "finding", "fileName": "src/a.ts", "title": "Title", "comment": "Body",
             "startLine": 1, "endLine": 2}
    raw = _vendor({"type": "start"}, event, {"type": "complete"})
    finding = _finding_row(anchor_status="unverified", intervals=[])
    review = _run_review(finding, raw)
    row = _row(finding, review["id"])
    table = {_reference(raw)["sha256"]: _artifact(raw)}
    reviews = [review]
    foreign = _record(findings=[finding], target=SHA, artifacts=[{**_reference(raw), "kind": "report"}])
    row_foreign = _row(finding, foreign["id"])

    def variant(name: str, raw_text: str, *, finding_over: Dict[str, Any] | None = None, repo: Any = None,
                artifact: Dict[str, Any] | None = None, review_over: Dict[str, Any] | None = None,
                row_over: Dict[str, Any] | None = None) -> Dict[str, Any]:
        f = {**finding, **(finding_over or {})}
        rv = _run_review(f, raw_text, **(review_over or {}))
        r = {**_row(f, rv["id"]), **(row_over or {})}
        ref = _reference(raw_text)["sha256"]
        return _case(name, [_anchor(r, [rv])], artifacts={ref: _artifact(raw_text, **(artifact or {}))},
                     repo=repo or _repo(), rows={})

    def event_raw(**over: Any) -> str:
        value = {**event, **over}
        return _vendor({k: v for k, v in value.items() if v is not ...})

    cases = [
        _case("anchor-cached-returned-as-copy", [_anchor({**row, "recovered_anchor": {"path": "x", "odd": [1]}}, [])],
              repo=_repo(), rows={}),
        _case("anchor-cached-empty-dict-is-falsy", [_anchor({**row, "recovered_anchor": {}}, [])],
              repo=_repo(), rows={}),
        _case("anchor-no-matching-review", [_anchor(row, [])], repo=_repo(), rows={}),
        _case("anchor-ignores-non-review-events",
              [_anchor(row, [_finding_event(None, "needs-human", {"r": 1}, review_id=review["id"])])],
              repo=_repo(), rows={}),
        _case("anchor-review-without-event-type", [_anchor(row, [{"id": review["id"]}])], repo=_repo(), rows={}),
        _case("anchor-review-without-id", [_anchor(row, [{"event_type": "review"}])], repo=_repo(), rows={}),
        _case("anchor-recovers", [_anchor(row, reviews)], artifacts=table, repo=_repo(), rows={}),
        _case("anchor-tampered-review-raises-integrity",
              [_anchor(row, [{**review, "source_key": review["source_key"] + "x"}])],
              artifacts=table, repo=_repo(), rows={}),
        _case("anchor-target-mismatch", [_anchor({**row, "target": "9" * 40}, reviews)],
              artifacts=table, repo=_repo(), rows={}),
        _case("anchor-finding-absent-from-review", [_anchor({**row, "finding": {**finding, "title": "Other"}}, reviews)],
              artifacts=table, repo=_repo(), rows={}),
        _case("anchor-producer-not-runner", [_anchor(row_foreign, [foreign])], artifacts=table, repo=_repo(), rows={}),
        _case("anchor-artifact-verify-fails", [_anchor(row, reviews)],
              artifacts={_reference(raw)["sha256"]: _artifact(raw, verify="fail")}, repo=_repo(), rows={}),
        _case("anchor-artifact-missing", [_anchor(row, reviews)],
              artifacts={_reference(raw)["sha256"]: _artifact(raw, read="missing")}, repo=_repo(), rows={}),
        _case("anchor-artifact-swapped-after-verify", [_anchor(row, reviews)],
              artifacts={_reference(raw)["sha256"]: _artifact(raw, read="swapped", swapped_hex=_hex(raw + "x"))},
              repo=_repo(), rows={}),
        # The swapped bytes are a *valid* run whose anchor differs (lines 2-3), so only the
        # post-verify SHA recheck separates None from a recovered anchor.
        _case("anchor-artifact-swapped-to-valid-run-with-other-anchor", [_anchor(row, reviews)],
              artifacts={_reference(raw)["sha256"]: _artifact(
                  raw, read="swapped", swapped_hex=_hex(event_raw(startLine=2, endLine=3)))},
              repo=_repo(), rows={}),
        variant("anchor-path-fallback", event_raw(fileName=..., path="src/a.ts"), ),
        variant("anchor-body-fallback", event_raw(comment=..., body="Body")),
        variant("anchor-empty-comment-falls-to-body", event_raw(comment="", body="Body")),
        variant("anchor-default-title", event_raw(title=""),
                finding_over={"title": "Unverified vendor finding anchor"}),
        variant("anchor-json-dumps-body",
                _vendor({"type": "finding", "fileName": "src/a.ts", "title": "Title",
                         "startLine": 1, "endLine": 2, "z": "é😀", "a": [1, 2.5, None, True]}),
                finding_over={"body": json.dumps({"type": "finding", "fileName": "src/a.ts", "title": "Title",
                                                  "startLine": 1, "endLine": 2, "z": "é😀",
                                                  "a": [1, 2.5, None, True]})}),
        variant("anchor-two-candidates", _vendor(event, event)),
        variant("anchor-zero-candidates", _vendor({**event, "title": "Other"})),
        variant("anchor-non-finding-type-skipped", _vendor({**event, "type": "note"})),
        variant("anchor-no-intervals", event_raw(startLine=..., endLine=...)),
        variant("anchor-explicit-intervals", event_raw(startLine=..., endLine=..., intervals=[[1, 1], [3, 3]])),
        variant("anchor-interval-past-end", event_raw(endLine=4)),
        variant("anchor-interval-at-end", event_raw(endLine=3)),
        variant("anchor-entry-missing", event_raw(), repo=_repo(entries={SHA: {}})),
        variant("anchor-entry-empty-dict", event_raw(), repo=_repo(entries={SHA: {"src/a.ts": {}}})),
        variant("anchor-blob-moved", event_raw(), repo=_repo(entries={SHA: {"src/a.ts": {"blob": BLOB2}}})),
        variant("anchor-entry-without-blob-key", event_raw(), repo=_repo(entries={SHA: {"src/a.ts": {"mode": 1}}})),
        variant("anchor-entries-git-error-propagates", event_raw(), repo=_repo(entries={})),
        variant("anchor-cat-file-error-propagates", event_raw(), repo=_repo(blobs={})),
        variant("anchor-empty-blob-has-no-lines", event_raw(), repo=_repo(blobs={BLOB: ""})),
        variant("anchor-no-trailing-newline", event_raw(endLine=3), repo=_repo(blobs={BLOB: _hex("a\nb\nc")})),
        variant("anchor-crlf-lines-counted-by-lf", event_raw(endLine=2), repo=_repo(blobs={BLOB: _hex("a\r\nb\r\n")})),
        variant("anchor-duplicate-vendor-key-is-swallowed",
                '{"type":"finding","type":"finding"}\n'),
        variant("anchor-malformed-vendor-json-is-swallowed", "{not json\n"),
        variant("anchor-vendor-non-object-is-swallowed", "[1]\n"),
        variant("anchor-vendor-nonfinite-is-swallowed", '{"type":"finding","x":NaN}\n'),
        _invalid_utf8_case(finding),
    ]
    return cases


def _invalid_utf8_case(finding: Dict[str, Any]) -> Dict[str, Any]:
    data = b'{"type":"finding"}\n\xff\n'
    sha = hashlib.sha256(data).hexdigest()
    review = _review(source="run-bytes", findings=[finding],
                     artifacts=[{"sha256": sha, "location": VIRTUAL + sha}])
    return _case("anchor-vendor-invalid-utf8-is-swallowed", [_anchor(_row(finding, review["id"]), [review])],
                 artifacts={sha: {"hex": data.hex()}}, repo=_repo(), rows={})


def _verified_row(*, previous: Any = None, **over: Any) -> Dict[str, Any]:
    return {**_row(_finding_row(), RID, previous_event_id=previous), **over}


def _quote_repo(blob_hex: str, **over: Any) -> Dict[str, Any]:
    base = {"entries": {SHA: {"src/a.ts": {"blob": BLOB}, "src/b.ts": {"blob": BLOB2}},
                        HEAD: {"src/a.ts": {"blob": BLOB}, "src/b.ts": {"blob": BLOB2}}},
            "blobs": {BLOB: blob_hex, BLOB2: blob_hex},
            "carry": [_carry(lines=[1, 2], name="src/a.ts", mapped=[1, 2])]}
    base.update(over)
    return _repo(**base)


def triage_cases() -> List[Dict[str, Any]]:
    full = _carry(lines=[1, 2], name="src/a.ts", mapped=[1, 2])
    partial = _carry(lines=[1, 2], name="src/a.ts", mapped=[1])
    lost = _carry(lines=[1, 2], name=None, mapped=[])
    verified = _verified_row()
    cases: List[Dict[str, Any]] = []

    def t(name: str, *args: Any, row: Dict[str, Any] | None = None, repo: Dict[str, Any] | None = None,
          rows: Dict[str, Any] | None = None, **kwargs: Any) -> None:
        call_args = list(args) or [FID, HEAD, "confirmed", "agent", "looks real", AT]
        cases.append(_case(name, [_triage(*call_args, **kwargs)],
                           rows=rows if rows is not None else {FID: row or verified},
                           repo=repo or _repo(carry=[full])))

    t("triage-confirmed-full-carry")
    t("triage-confirmed-partial-carry-needs-human", repo=_repo(carry=[partial]))
    t("triage-confirmed-partial-carry-failure-class-becomes-evidence", repo=_repo(carry=[partial]),
      failure_class="stale")
    t("triage-confirmed-lost-anchor", repo=_repo(carry=[lost]))
    t("triage-failure-class-empty-string-is-falsy", failure_class="")
    t("triage-failure-class-recorded", failure_class="owner-decision")
    t("triage-needs-human-keeps-mapping", FID, HEAD, "needs-human", "agent", "unsure", AT)
    t("triage-expected-previous-matches", expected_previous_event_id=None)
    t("triage-expected-previous-stale", expected_previous_event_id="stale")
    t("triage-expected-previous-one-equals-true", row=_verified_row(previous=1), expected_previous_event_id=True)
    t("triage-empty-actor", FID, HEAD, "confirmed", "", "r", AT)
    t("triage-empty-reason", FID, HEAD, "confirmed", "a", "", AT)
    t("triage-null-actor", FID, HEAD, "confirmed", None, "r", AT)
    t("triage-unresolvable-target", FID, "gone", "confirmed", "a", "r", AT)
    t("triage-missing-row", FID, HEAD, "confirmed", "a", "r", AT, rows={})
    t("triage-row-without-finding", row={"review_id": RID})
    t("triage-finding-without-anchor-status", row=_row({k: v for k, v in _finding_row().items()
                                                          if k != "anchor_status"}, RID))
    t("triage-invalid-anchor-intervals-raise", row=_row(_finding_row(intervals=[[2, 1]]), RID))
    t("triage-unverified-without-recovery", row=_row(_finding_row(anchor_status="unverified", intervals=[]), RID))
    t("triage-row-missing-canonical-id-after-spool", row={k: v for k, v in verified.items() if k != "canonical_id"})
    t("triage-missing-previous-event-id", row={k: v for k, v in verified.items() if k != "previous_event_id"})
    t("triage-fixed", FID, HEAD, "fixed", "agent", "verified by test", AT, fixing_commit="fix")
    t("triage-already-fixed", FID, HEAD, "already-fixed", "agent", "r", AT, fixing_commit="fix")
    t("triage-fixed-without-commit", FID, HEAD, "fixed", "agent", "r", AT)
    t("triage-fixed-empty-commit", FID, HEAD, "fixed", "agent", "r", AT, fixing_commit="")
    t("triage-fixed-unresolvable-commit", FID, HEAD, "fixed", "agent", "r", AT, fixing_commit="nope")
    t("triage-superseded-with-commit", FID, HEAD, "superseded", "agent", "r", AT, fixing_commit="fix")
    t("triage-superseded-without-commit", FID, HEAD, "superseded", "agent", "r", AT)
    t("triage-superseded-unresolvable-commit", FID, HEAD, "superseded", "agent", "r", AT, fixing_commit="nope")
    other = _row(_finding_row(id=FID2), RID)
    t("triage-duplicate", FID, HEAD, "duplicate", "agent", "same", AT, canonical_id=FID2,
      rows={FID: verified, FID2: other})
    t("triage-duplicate-of-self", FID, HEAD, "duplicate", "agent", "same", AT, canonical_id=FID)
    t("triage-duplicate-unknown-canonical", FID, HEAD, "duplicate", "agent", "same", AT, canonical_id=FID2)
    t("triage-duplicate-without-canonical", FID, HEAD, "duplicate", "agent", "same", AT)
    t("triage-duplicate-empty-canonical", FID, HEAD, "duplicate", "agent", "same", AT, canonical_id="")
    t("triage-canonical-id-ignored-unless-duplicate", FID, HEAD, "needs-human", "agent", "r", AT, canonical_id=FID2)
    t("triage-unknown-action-passes-through", FID, HEAD, "wontfix", "agent", "r", AT)
    t("triage-bad-timestamp-shape", FID, HEAD, "needs-human", "agent", "r", "2026-10-30T00:00:00+00:00")
    t("triage-bad-timestamp-calendar", FID, HEAD, "needs-human", "agent", "r", "2026-02-30T00:00:00Z")
    t("triage-bad-timestamp-month", FID, HEAD, "needs-human", "agent", "r", "2026-13-01T00:00:00Z")
    t("triage-clears-context-error", row={**verified, "context_error": "old"})
    t("triage-needs-human-clears-context-error", FID, HEAD, "needs-human", "agent", "unsure", AT,
      row={**verified, "context_error": "old"})
    t("triage-numeric-reason", FID, HEAD, "needs-human", "agent", 7, AT)
    t("triage-structured-reason", FID, HEAD, "needs-human", "agent", {"why": ["é"]}, AT)

    # --- explicit current anchor (the quote check)
    def q(name: str, quoted: Any, lines: Any, blob_text: str | bytes = "one\ntwo\nthree\n", *,
          path: str = "src/a.ts", row: Dict[str, Any] | None = None, repo: Dict[str, Any] | None = None) -> None:
        blob_hex = blob_text.hex() if isinstance(blob_text, bytes) else _hex(blob_text)
        t(name, FID, HEAD, "confirmed", "agent", "r", AT, row=row, repo=repo or _quote_repo(blob_hex, carry=[full]),
          current_path=path, current_lines=lines, quoted_text=quoted)

    q("quote-matches-single-line", "two", [[2, 2]])
    q("quote-matches-range", "one\ntwo", [[1, 2]])
    q("quote-matches-split-ranges", "one\nthree", [[1, 1], [3, 3]])
    q("quote-mismatch", "TWO", [[2, 2]])
    q("quote-none", None, [[2, 2]])
    q("quote-number", 2, [[2, 2]])
    q("quote-empty", "", [[2, 2]], "\n\n")
    q("quote-whitespace-only-ascii", " ", [[1, 1]], " \n")
    q("quote-whitespace-only-nbsp", " ", [[1, 1]], " \n")
    q("quote-whitespace-only-ideographic", "　", [[1, 1]], "　\n")
    q("quote-zero-width-space-is-not-whitespace", "​", [[1, 1]], "​\n")
    q("quote-leading-space-must-match-exactly", " two", [[2, 2]], "one\n two\n")
    q("quote-line-past-end", "three", [[3, 4]])
    q("quote-line-zero", "one", [[0, 1]])
    q("quote-empty-intervals", "one", [])
    q("quote-null-intervals", "one", None)
    q("quote-unsorted-intervals", "one\ntwo", [[2, 2], [1, 1]])
    q("quote-overlapping-intervals", "one", [[1, 2], [2, 3]])
    q("quote-string-intervals", "one", "1-2")
    q("quote-unknown-path", "one", [[1, 1]], path="src/missing.ts")
    q("quote-other-path", "one", [[1, 1]], path="src/b.ts")
    q("quote-entry-not-object", "one", [[1, 1]],
      repo=_quote_repo(_hex("one\n"), entries={SHA: {"src/a.ts": 3}, HEAD: {}}))
    q("quote-entry-without-blob", "one", [[1, 1]],
      repo=_quote_repo(_hex("one\n"), entries={SHA: {"src/a.ts": {}}, HEAD: {}}))
    q("quote-entries-git-error-propagates", "one", [[1, 1]], repo=_quote_repo(_hex("one\n"), entries={}))
    q("quote-cat-file-error-propagates", "one", [[1, 1]], repo=_quote_repo(_hex("one\n"), blobs={}))
    q("quote-invalid-utf8-blob", "one", [[1, 1]], b"one\n\xff\n")
    q("quote-overlong-utf8-blob", "one", [[1, 1]], b"one\n\xc0\xaf\n")
    q("quote-surrogate-utf8-blob", "one", [[1, 1]], b"one\n\xed\xa0\x80\n")
    q("quote-bom-is-kept", "﻿one", [[1, 1]], "﻿one\n")
    q("quote-bom-stripped-mismatch", "one", [[1, 1]], "﻿one\n")
    q("quote-crlf-splits-once", "one\ntwo", [[1, 2]], "one\r\ntwo\r\n")
    q("quote-bare-cr-splits", "one\ntwo", [[1, 2]], "one\rtwo\r")
    q("quote-vertical-tab-splits", "one\ntwo", [[1, 2]], "one\x0btwo\n")
    q("quote-form-feed-splits", "one\ntwo", [[1, 2]], "one\x0ctwo\n")
    q("quote-file-separator-splits", "one\ntwo", [[1, 2]], "one\x1ctwo\n")
    q("quote-group-separator-splits", "one\ntwo", [[1, 2]], "one\x1dtwo\n")
    q("quote-record-separator-splits", "one\ntwo", [[1, 2]], "one\x1etwo\n")
    q("quote-next-line-splits", "one\ntwo", [[1, 2]], "one\x85two\n")
    q("quote-line-separator-splits", "one\ntwo", [[1, 2]], "one two\n")
    q("quote-paragraph-separator-splits", "one\ntwo", [[1, 2]], "one two\n")
    q("quote-unit-separator-does-not-split", "one\x1ftwo", [[1, 1]], "one\x1ftwo\n")
    q("quote-trailing-blank-lines-counted", "", [[3, 3]], "one\n\n\n")
    q("quote-no-trailing-newline", "three", [[3, 3]], "one\ntwo\nthree")
    q("quote-empty-blob", "", [[1, 1]], "")
    q("quote-over-unverified-finding", "two", [[2, 2]],
      row=_row(_finding_row(anchor_status="unverified", intervals=[]), RID))
    q("quote-over-verified-lost-anchor", "two", [[2, 2]], repo=_quote_repo(_hex("one\ntwo\n"), carry=[lost]))
    # Large intervals: a JS `Math.min(...set)` spread throws RangeError past the argument limit.
    q("quote-huge-interval-past-end", "x", [[1, 200000]], "x\n" * 3)
    t("quote-needs-human-ignores-current-path", FID, HEAD, "needs-human", "agent", "r", AT,
      repo=_quote_repo(_hex("one\n"), carry=[full]), current_path="src/a.ts", current_lines=[[1, 1]],
      quoted_text="one")
    t("quote-unicode-text", FID, HEAD, "confirmed", "agent", "r", AT,
      repo=_quote_repo(_hex("日本語\n😀\n"), carry=[full]), current_path="src/a.ts", current_lines=[[1, 2]],
      quoted_text="日本語\n😀")

    # --- recovered anchors reach triage
    event = {"type": "finding", "fileName": "src/a.ts", "title": "Title", "comment": "Body",
             "startLine": 1, "endLine": 2}
    raw = _vendor(event)
    unverified = _finding_row(anchor_status="unverified", intervals=[])
    review = _run_review(unverified, raw)
    ref = _reference(raw)["sha256"]
    table = {ref: _artifact(raw)}
    urow = _row(unverified, review["id"])
    recover_carry = _carry(lines=[1, 2], name="src/a.ts", mapped=[1, 2])
    cases.append(_case("triage-recovers-anchor-from-retained-review",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT)], rows={FID: urow},
                       retained=[review], artifacts=table, repo=_repo(carry=[recover_carry])))
    cases.append(_case("triage-recovers-anchor-from-reviews-argument",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT, reviews=[review])],
                       rows={FID: urow}, artifacts=table, repo=_repo(carry=[recover_carry])))
    cases.append(_case("triage-recovered-anchor-partial-carry",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT, failure_class="x")],
                       rows={FID: urow}, retained=[review], artifacts=table,
                       repo=_repo(carry=[_carry(lines=[1, 2], name="src/a.ts", mapped=[2])])))
    cases.append(_case("triage-cached-recovered-anchor-skips-review-lookup",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT)],
                       rows={FID: {**urow, "recovered_anchor": {"path": "src/a.ts", "blob": BLOB,
                                                                "intervals": [[1, 2]],
                                                                "anchor_recovered_from": "c" * 64}}},
                       repo=_repo(carry=[recover_carry])))
    cases.append(_case("triage-recovered-anchor-git-error-propagates",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT)], rows={FID: urow},
                       retained=[review], artifacts=table, repo=_repo(entries={HEAD: {}})))

    # --- retained recovery runs first
    advance = _finding_event(None, "needs-human", {"reason": "earlier"}, review_id=RID)
    cases.append(_case("triage-recovers-retained-events-first",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT)], rows={FID: verified},
                       retained=[advance], repo=_repo(carry=[full])))
    cases.append(_case("triage-after-recovery-snapshot-check",
                       [_triage(FID, HEAD, "confirmed", "agent", "r", AT, expected_previous_event_id=None)],
                       rows={FID: verified}, retained=[advance], repo=_repo(carry=[full])))
    cases.append(_case("triage-twice-chains-previous",
                       [_triage(FID, HEAD, "needs-human", "agent", "first", AT),
                        _triage(FID, HEAD, "confirmed", "agent", "second", AT)],
                       rows={FID: verified}, repo=_repo(carry=[full])))
    cases.append(_case("triage-same-disposition-replays-idempotently",
                       [_triage(FID, HEAD, "needs-human", "agent", "first", AT),
                        {"reset": {FID: verified}},
                        _triage(FID, HEAD, "needs-human", "agent", "first", AT)],
                       rows={FID: verified}, repo=_repo(carry=[full])))
    return cases


def outcome_cases() -> List[Dict[str, Any]]:
    finding = _finding_row()
    delivered = {"repair_task": "job-1", "acknowledgement": "ack"}
    base = _row(finding, RID, status="delivered", previous_event_id="p0", receipt=delivered)
    cases: List[Dict[str, Any]] = []

    def o(name: str, *args: Any, row: Dict[str, Any] | None = None, retained: List[Any] | None = None,
          **kwargs: Any) -> None:
        call_args = list(args) or [FID, "job-1", "fixed", "merged", AT]
        cases.append(_case(name, [_outcome(*call_args, **kwargs)], rows={FID: row or base},
                           retained=retained or []))

    o("outcome-fixed", fixing_commit="fix", fix_pr="https://example.test/pr/1")
    o("outcome-fixed-without-commit-refuses-in-ledger")
    o("outcome-other-job-preserved", FID, "job-2", "fixed", "merged", AT, fixing_commit="fix")
    o("outcome-not-delivered-preserved", FID, "job-1", "fixed", "merged", AT, fixing_commit="fix",
      row={**base, "status": "needs-human"})
    o("outcome-no-receipt", FID, "job-1", "needs-human", "no fix", AT, row={k: v for k, v in base.items() if k != "receipt"})
    o("outcome-empty-receipt", FID, "job-1", "needs-human", "no fix", AT, row={**base, "receipt": {}})
    o("outcome-empty-repair-task", FID, "job-9", "needs-human", "no fix", AT,
      row={**base, "receipt": {"repair_task": ""}})
    o("outcome-null-repair-task", FID, "job-9", "needs-human", "no fix", AT,
      row={**base, "receipt": {"repair_task": None}})
    o("outcome-receipt-null-raises", FID, "job-1", "needs-human", "r", AT, row={**base, "receipt": None})
    o("outcome-receipt-string-raises", FID, "job-1", "needs-human", "r", AT, row={**base, "receipt": "x"})
    o("outcome-receipt-list-raises", FID, "job-1", "needs-human", "r", AT, row={**base, "receipt": [1]})
    o("outcome-missing-row", FID, "job-1", "needs-human", "r", AT, row={})
    o("outcome-row-without-review-id", FID, "job-1", "needs-human", "r", AT,
      row={k: v for k, v in base.items() if k != "review_id"})
    o("outcome-row-without-previous", FID, "job-1", "needs-human", "r", AT,
      row={k: v for k, v in base.items() if k != "previous_event_id"})
    o("outcome-falsy-optionals-are-dropped", FID, "job-1", "needs-human", "r", AT, repair_base="",
      failure_class="", fixing_commit="", source_evidence={})
    o("outcome-truthy-optionals-recorded", FID, "job-1", "needs-human", "r", AT, repair_base="base",
      failure_class="boom", fixing_commit="fix", source_evidence={"k": ["v"]}, fix_pr=0)
    o("outcome-source-evidence-list", FID, "job-1", "needs-human", "r", AT, source_evidence=[1])
    o("outcome-bad-timestamp", FID, "job-1", "needs-human", "r", "yesterday")

    review_id = RID

    def chain(*links: Any) -> List[Dict[str, Any]]:
        events, previous = [], None
        for action, klass, actor in links:
            evidence = {"failure_class": klass} if klass is not ... else {"reason": "x"}
            if action == "confirmed":
                evidence = {**evidence, "target": HEAD, "anchor_verified": True}
            event = _finding_event(previous, action, evidence, actor=actor, review_id=review_id,
                                   key=f"chain:{len(events)}")
            events.append(event)
            previous = event["id"]
        return events

    def retried(name: str, links: Any, *, retries: int | None = None, fail: Any = "boom",
                row_previous: Any = "tip", action: str = "needs-retriage") -> None:
        events = chain(*links)
        previous = (events[-1]["id"] if events else None) if row_previous == "tip" else row_previous
        kwargs: Dict[str, Any] = {"failure_class": fail}
        if retries is not None:
            kwargs["max_finding_retries"] = retries
        cases.append(_case(name, [_outcome(FID, "job-1", action, "r", AT, **kwargs)],
                           rows={FID: {**base, "previous_event_id": previous}}, retained=events))

    two = [("needs-retriage", "boom", "crq-repair"), ("needs-human", "boom", "crq-repair")]
    retried("outcome-retry-under-limit", two[:1])
    retried("outcome-retry-at-limit-escalates", two)
    retried("outcome-retry-limit-zero", [], retries=0)
    retried("outcome-retry-limit-one", two[:1], retries=1)
    retried("outcome-retry-limit-large", two, retries=9)
    retried("outcome-retry-skips-owner-decision", [("needs-human", "owner-decision", "crq-repair")] * 2)
    retried("outcome-retry-skips-human-actor", [("needs-human", "boom", "alice")] * 2)
    retried("outcome-retry-skips-other-actions", [("confirmed", "boom", "crq-triage")] * 2)
    retried("outcome-retry-skips-event-without-class", [("needs-human", ..., "crq-repair")] * 2)
    retried("outcome-retry-skips-empty-class", [("needs-human", "", "crq-repair")] * 2)
    retried("outcome-owner-decision-class-skips-history", two, fail="owner-decision")
    retried("outcome-empty-class-skips-history", two, fail="")
    retried("outcome-other-action-skips-history", two, action="needs-human")
    retried("outcome-history-incomplete", two, row_previous="missing-event")
    retried("outcome-history-null-previous-no-events", [], row_previous=None)
    retried("outcome-history-previous-is-empty-string", [], row_previous="")
    retried("outcome-history-previous-is-list-unhashable", [], row_previous=["x"])
    retried("outcome-history-previous-is-dict-unhashable", [], row_previous={"a": 1})
    retried("outcome-history-previous-is-number", [], row_previous=7)
    retried("outcome-history-previous-is-true", [], row_previous=True)

    first = _finding_event("p0", "fixed", {"repair_task": "job-1", "reason": "merged", "fix_pr": None,
                                           "fixing_commit": "fix", "verification": "merged"},
                           actor="crq-repair", review_id=review_id, key="seed")
    token = ledger.digest({"job": "job-1", "action": "fixed",
                           "evidence": {"repair_task": "job-1", "reason": "merged", "fix_pr": None,
                                        "fixing_commit": "fix", "verification": "merged"}})
    dup = _finding_event("p0", "fixed", {"repair_task": "job-1", "reason": "merged", "fix_pr": None,
                                         "fixing_commit": "fix", "verification": "merged"},
                         actor="crq-repair", review_id=review_id, key="repair-outcome:" + token)
    del first
    o("outcome-retained-duplicate-token-is-idempotent", FID, "job-1", "fixed", "merged", AT,
      fixing_commit="fix", retained=[dup])
    # The retained event does not chain onto the row (different predecessor), so recovery cannot
    # apply it and only the source-key token check keeps the second event from being spooled.
    evidence = {"repair_task": "job-1", "reason": "merged", "fix_pr": None,
                "fixing_commit": "fix", "verification": "merged"}
    off_chain = _finding_event("elsewhere", "fixed", evidence, actor="crq-repair",
                               review_id=review_id, key="repair-outcome:" + token)
    o("outcome-retained-token-off-chain-is-idempotent", FID, "job-1", "fixed", "merged", AT,
      fixing_commit="fix", retained=[off_chain])
    other_token = _finding_event("elsewhere", "fixed", evidence, actor="crq-repair",
                                 review_id=review_id, key="repair-outcome:other")
    o("outcome-retained-other-token-off-chain-spools", FID, "job-1", "fixed", "merged", AT,
      fixing_commit="fix", retained=[other_token])
    cases.append(_case("outcome-replay-after-lost-row-write",
                       [_outcome(FID, "job-1", "fixed", "merged", AT, fixing_commit="fix"),
                        {"reset": {FID: base}},
                        _outcome(FID, "job-1", "fixed", "merged", AT, fixing_commit="fix")],
                       rows={FID: base}))
    cases.append(_case("outcome-second-call-is-preserved-after-first",
                       [_outcome(FID, "job-1", "fixed", "merged", AT, fixing_commit="fix"),
                        _outcome(FID, "job-1", "fixed", "merged", AT, fixing_commit="fix")],
                       rows={FID: base}))
    o("outcome-recovers-retained-first", FID, "job-1", "needs-human", "r", AT,
      row=_row(finding, RID, status="delivered", receipt=delivered, previous_event_id=None),
      retained=[_finding_event(None, "delivered", {"repair_task": "job-1", "acknowledgement": "ack"},
                               actor="crq-repair", review_id=RID, key="handoff")])
    return cases


def build() -> Dict[str, Any]:
    cases = []
    for case in [*context_cases(), *anchor_cases(), *triage_cases(), *outcome_cases()]:
        try:
            cases.append({**case, "result": run(case["spec"])})
        except Trap as error:
            raise Trap(f"{case['name']}: {error}") from error
    names = [case["name"] for case in cases]
    if len(names) != len(set(names)):
        raise Trap("duplicate case names")
    return {"schema": "cq.finding-disposition-vectors/v1", "cases": cases}


def render(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the finding-disposition oracle fixture")
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
        print("finding-disposition fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
