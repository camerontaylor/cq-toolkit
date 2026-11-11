#!/usr/bin/env python3
"""Deterministic B1 vectors for finding identity, ingest and replay recovery.

Test tooling only: importing this module has no runtime effect and crq never
imports it. It drives the real ``finding_delivery.Inbox`` against a temporary
directory and records the resulting row bytes, lock/read/write order and
exception class. The TypeScript port replays the same file.

Every record is public and synthetic. No filesystem path, host, credential,
process id or timestamp is recorded, so regeneration is byte-identical on every
host and Python 3.14+ patch level.

Regenerate with ``python3 finding_inbox_vector_emit_b1.py --write`` and verify
with ``--check``. ``--stdout`` prints the whole document for the determinism
test.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence

import finding_delivery as delivery
import ledger_vector_emit_b1 as base
import review_ledger as ledger

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-finding-inbox-b1" / "vectors.json"
SCHEMA = "cq.crq-finding-inbox-b1-vector/v1"
AT = base.AT
SHA = base.SHA
SHA64 = "b" * 64
VID = "e" * 64
ALLOWED_ERRORS = (
    "IntegrityError",
    "KeyError",
    "TypeError",
    "AttributeError",
    "ValueError",
    "JSONDecodeError",
    "UnicodeDecodeError",
)

_UNSET = object()


def _case(
    name: str,
    source: str,
    inputs: Dict[str, Any],
    *,
    value: Any = _UNSET,
    error: Optional[str] = None,
    message: Optional[str] = None,
    after: Optional[List[Dict[str, Any]]] = None,
    effects: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": error is None}
    if error is None:
        if value is not _UNSET:
            expect["value"] = value
    else:
        expect["error"] = error
        if message is not None:
            expect["message"] = message
    if after is not None:
        expect["after"] = after
    if effects is not None:
        expect["effects"] = effects
    return {"name": name, "source": source, "input": inputs, "expect": expect}


def _capture(
    name: str,
    source: str,
    inputs: Dict[str, Any],
    call: Callable[[], Any],
    *,
    expected_error: Optional[str] = None,
    expected_message: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        value = call()
    except Exception as exc:
        if expected_error is None:
            raise
        if type(exc).__name__ != expected_error:
            raise AssertionError(
                f"{name}: expected {expected_error}, got {type(exc).__name__}: {exc}"
            ) from exc
        if expected_message is not None and str(exc) != expected_message:
            raise AssertionError(
                f"{name}: expected message {expected_message!r}, got {str(exc)!r}"
            ) from exc
        return _case(name, source, inputs, error=expected_error, message=expected_message)
    if expected_error is not None:
        raise AssertionError(f"{name}: expected {expected_error}, operation succeeded")
    return _case(name, source, inputs, value=value)


@contextlib.contextmanager
def _record() -> Iterator[List[Dict[str, Any]]]:
    """Record only triage-row locks, reads and writes for one operation."""
    events: List[Dict[str, Any]] = []
    original_locked = ledger.locked
    original_atomic = ledger.atomic
    original_read_bytes = Path.read_bytes

    @contextlib.contextmanager
    def locked(path: Path) -> Iterator[None]:
        events.append({"kind": "lock", "phase": "enter", "target": Path(path).name})
        try:
            with original_locked(path):
                yield
        finally:
            events.append({"kind": "lock", "phase": "exit", "target": Path(path).name})

    def atomic(path: Path, data: bytes) -> None:
        target = Path(path).name
        if target.endswith(".json"):
            target = target[:-5]
        events.append(
            {
                "kind": "write",
                "target": target,
                "sha256": hashlib.sha256(data).hexdigest(),
                "canonical": data.decode("utf-8"),
            }
        )
        return original_atomic(path, data)

    def read_bytes(self: Path) -> bytes:
        data = original_read_bytes(self)
        if self.parent.name == "triage" and self.suffix == ".json":
            events.append({"kind": "read", "sha256": hashlib.sha256(data).hexdigest()})
        return data

    ledger.locked = locked
    ledger.atomic = atomic
    Path.read_bytes = read_bytes
    try:
        yield events
    finally:
        ledger.locked = original_locked
        ledger.atomic = original_atomic
        Path.read_bytes = original_read_bytes


def _row(root: Path, finding_id: str) -> Optional[Dict[str, Any]]:
    path = root / "triage" / (finding_id + ".json")
    if not path.exists():
        return None
    data = path.read_bytes()
    return {
        "id": finding_id,
        "canonical": data.decode("utf-8"),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _rows(root: Path) -> List[Dict[str, Any]]:
    directory = root / "triage"
    if not directory.exists():
        return []
    return [_row(root, path.stem) for path in sorted(directory.glob("*.json"))]  # type: ignore[list-item]


def _temp_case(
    name: str,
    source: str,
    inputs: Dict[str, Any],
    setup: Callable[[Path, delivery.Inbox, ledger.Outbox], None],
    operation: Callable[[delivery.Inbox], Any],
    *,
    expected_error: Optional[str] = None,
    expected_message: Optional[str] = None,
    effects: bool = True,
) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "findings"
        root.mkdir(parents=True, exist_ok=True)
        outbox = ledger.Outbox(Path(td) / "outbox", ledger.ArtifactStore(Path(td) / "artifacts"))
        inbox = delivery.Inbox(root, outbox)
        setup(root, inbox, outbox)
        recorded: List[Dict[str, Any]] = []
        caught: Optional[BaseException] = None
        value: Any = _UNSET
        with _record() as recorded:
            try:
                value = operation(inbox)
            except Exception as exc:
                caught = exc
        after = _rows(root)
        if caught is not None:
            if expected_error is None:
                raise caught
            if type(caught).__name__ != expected_error:
                raise AssertionError(
                    f"{name}: expected {expected_error}, got {type(caught).__name__}: {caught}"
                ) from caught
            if expected_message is not None and str(caught) != expected_message:
                raise AssertionError(
                    f"{name}: expected message {expected_message!r}, got {str(caught)!r}"
                ) from caught
            return _case(
                name,
                source,
                inputs,
                error=expected_error,
                message=expected_message,
                after=after,
                effects=recorded if effects else None,
            )
        if expected_error is not None:
            raise AssertionError(f"{name}: expected {expected_error}, operation succeeded")
        return _case(
            name,
            source,
            inputs,
            value=value,
            after=after,
            effects=recorded if effects else None,
        )


def _raw_finding(**overrides: Any) -> Dict[str, Any]:
    value: Dict[str, Any] = {
        "severity": "major",
        "path": "src/a.ts",
        "blob": SHA,
        "intervals": [[1, 1]],
        "title": "标题 😀",
        "body": "details \u0001 with control",
    }
    value.update(overrides)
    return value


def _normalized(finding: Optional[Dict[str, Any]] = None, run: str = "run-1") -> Dict[str, Any]:
    return delivery.normalize("crq-runner-app", run, finding or _raw_finding())


def _review(findings: Sequence[Dict[str, Any]], source: str = "run-1") -> Dict[str, Any]:
    return base._review(source=source, findings=list(findings))


def _event(
    action: str,
    evidence: Dict[str, Any],
    *,
    finding_id: str,
    review_id: str,
    previous: Optional[str] = None,
    actor: str = "crq-repair",
) -> Dict[str, Any]:
    payload = {
        "finding_id": finding_id,
        "review_id": review_id,
        "previous_event_id": previous,
        "action": action,
        "evidence": evidence,
        "actor": actor,
    }
    source_key = "finding:" + finding_id + ":" + ledger.digest(
        {"action": action, "evidence": evidence, "previous": previous}
    )
    return ledger.event("finding-event", source_key, AT, payload)


def _seed_rows(root: Path, rows: Sequence[Dict[str, Any]]) -> None:
    for row in rows:
        ledger.atomic(root / "triage" / (row["id"] + ".json"), row["canonical"].encode())


def _seed_input(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{"id": row["id"], "canonical": row["canonical"]} for row in rows]


def occurrence_vectors() -> Dict[str, Any]:
    cases = [
        _capture(
            "source-id-present",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding(source_id="vendor-1")},
            lambda: delivery.occurrence(
                "crq-runner-app", "run-1", _raw_finding(source_id="vendor-1")
            ),
        ),
        _capture(
            "source-id-null",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding(source_id=None)},
            lambda: delivery.occurrence(
                "crq-runner-app", "run-1", _raw_finding(source_id=None)
            ),
        ),
        _capture(
            "source-id-empty",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding(source_id="")},
            lambda: delivery.occurrence("crq-runner-app", "run-1", _raw_finding(source_id="")),
        ),
        _capture(
            "source-id-unicode",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding(source_id="ベンダー😀")},
            lambda: delivery.occurrence(
                "crq-runner-app", "run-1", _raw_finding(source_id="ベンダー😀")
            ),
        ),
        _capture(
            "content-unicode",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding()},
            lambda: delivery.occurrence("crq-runner-app", "run-1", _raw_finding()),
        ),
        _capture(
            "content-intervals",
            "finding_delivery.occurrence",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": _raw_finding(intervals=[[4, 5], [1, 2]]),
            },
            lambda: delivery.occurrence(
                "crq-runner-app", "run-1", _raw_finding(intervals=[[4, 5], [1, 2]])
            ),
        ),
        _capture(
            "run-differs",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-2", "finding": _raw_finding()},
            lambda: delivery.occurrence("crq-runner-app", "run-2", _raw_finding()),
        ),
        _capture(
            "producer-differs",
            "finding_delivery.occurrence",
            {"producer": "other", "run_id": "run-1", "finding": _raw_finding()},
            lambda: delivery.occurrence("other", "run-1", _raw_finding()),
        ),
        _capture(
            "occurrence-missing-title",
            "finding_delivery.occurrence",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": {k: v for k, v in _raw_finding().items() if k != "title"},
            },
            lambda: delivery.occurrence(
                "crq-runner-app",
                "run-1",
                {k: v for k, v in _raw_finding().items() if k != "title"},
            ),
            expected_error="KeyError",
            expected_message="'title'",
        ),
        _capture(
            "occurrence-non-object",
            "finding_delivery.occurrence",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": []},
            lambda: delivery.occurrence("crq-runner-app", "run-1", []),
            expected_error="AttributeError",
        ),
    ]
    return {"family": "occurrence", "cases": cases}


def normalize_vectors() -> Dict[str, Any]:
    cases = [
        _capture(
            "normalize-verified",
            "finding_delivery.normalize",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding()},
            lambda: delivery.normalize("crq-runner-app", "run-1", _raw_finding()),
        ),
        _capture(
            "normalize-unverified-missing-path",
            "finding_delivery.normalize",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": _raw_finding(path=None),
            },
            lambda: delivery.normalize("crq-runner-app", "run-1", _raw_finding(path=None)),
        ),
        _capture(
            "normalize-unverified-empty-intervals",
            "finding_delivery.normalize",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": _raw_finding(intervals=[]),
            },
            lambda: delivery.normalize("crq-runner-app", "run-1", _raw_finding(intervals=[])),
        ),
        _capture(
            "normalize-source-id-absent",
            "finding_delivery.normalize",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": _raw_finding()},
            lambda: delivery.normalize("crq-runner-app", "run-1", _raw_finding()),
        ),
        _capture(
            "normalize-source-id-empty",
            "finding_delivery.normalize",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": _raw_finding(source_id=""),
            },
            lambda: delivery.normalize("crq-runner-app", "run-1", _raw_finding(source_id="")),
        ),
        _capture(
            "normalize-missing-severity",
            "finding_delivery.normalize",
            {
                "producer": "crq-runner-app",
                "run_id": "run-1",
                "finding": {k: v for k, v in _raw_finding().items() if k != "severity"},
            },
            lambda: delivery.normalize(
                "crq-runner-app",
                "run-1",
                {k: v for k, v in _raw_finding().items() if k != "severity"},
            ),
            expected_error="KeyError",
            expected_message="'severity'",
        ),
        _capture(
            "normalize-non-object",
            "finding_delivery.normalize",
            {"producer": "crq-runner-app", "run_id": "run-1", "finding": []},
            lambda: delivery.normalize("crq-runner-app", "run-1", []),
            expected_error="TypeError",
        ),
    ]
    return {"family": "normalize", "cases": cases}


def transition_vectors() -> Dict[str, Any]:
    finding = _normalized()
    fid = finding["id"]
    review = _review([finding])
    base_row = {
        "review_id": review["id"],
        "finding": finding,
        "target": SHA,
        "canonical_id": fid,
        "previous_event_id": None,
        "status": "untriaged",
    }
    cases: List[Dict[str, Any]] = []

    def add(
        name: str,
        event: Dict[str, Any],
        *,
        row_overrides: Optional[Dict[str, Any]] = None,
        expected_error: Optional[str] = None,
        expected_message: Optional[str] = None,
    ) -> None:
        row = copy.deepcopy(base_row)
        row.update(row_overrides or {})
        seed = {"id": fid, "canonical": ledger.canonical(row).decode("utf-8")}

        def setup(root: Path, inbox: delivery.Inbox, outbox: ledger.Outbox) -> None:
            _seed_rows(root, [seed])

        def operation(inbox: delivery.Inbox) -> Any:
            before = _row(inbox.root, fid)
            result = inbox._recover_event(event)
            after = _row(inbox.root, fid)
            if not result:
                return {"kind": "predecessor-mismatch"}
            kind = "already-applied" if before is not None and after == before else "apply"
            value: Dict[str, Any] = {"kind": kind}
            if kind == "apply":
                value["canonical"] = after["canonical"]  # type: ignore[index]
            return value

        cases.append(
            _temp_case(
                name,
                "finding_delivery.Inbox._recover_event",
                {"row": row, "event": event},
                setup,
                operation,
                expected_error=expected_error,
                expected_message=expected_message,
                effects=False,
            )
        )

    already_event = _event(
        "confirmed",
        {"target": SHA, "anchor_verified": True},
        finding_id=fid,
        review_id=review["id"],
    )
    add(
        "transition-already-applied",
        already_event,
        row_overrides={"previous_event_id": already_event["id"], "status": "confirmed"},
    )
    add(
        "transition-predecessor-mismatch",
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        ),
        row_overrides={"previous_event_id": VID},
    )
    add(
        "transition-status-update",
        _event(
            "confirmed",
            {
                "target": SHA,
                "reason": "valid",
                "anchor_verified": True,
                "mapped_path": "src/a.ts",
                "mapped_intervals": [[1, 1]],
            },
            finding_id=fid,
            review_id=review["id"],
            actor="crq-triage/judge",
        ),
    )
    add(
        "transition-delivered-receipt",
        _event(
            "delivered",
            {"acknowledgement": "a" * 64, "repair_task": "crq-task"},
            finding_id=fid,
            review_id=review["id"],
            actor="crq-repair-adapter",
        ),
    )
    add(
        "transition-target-outcome",
        _event(
            "needs-human",
            {
                "target": SHA,
                "mapped_path": "src/a.ts",
                "mapped_intervals": [[1, 1]],
                "reason": "operator attention",
            },
            finding_id=fid,
            review_id=review["id"],
        ),
    )
    add(
        "transition-outcome-without-target",
        _event(
            "needs-human",
            {"reason": "operator attention"},
            finding_id=fid,
            review_id=review["id"],
        ),
        row_overrides={
            "target_current": SHA,
            "mapped_path": "src/a.ts",
            "mapped_intervals": [[1, 1]],
        },
    )
    add(
        "transition-duplicate-with-target",
        _event(
            "duplicate",
            {
                "target": SHA,
                "canonical_id": VID,
                "mapped_path": "src/a.ts",
                "mapped_intervals": [[1, 1]],
            },
            finding_id=fid,
            review_id=review["id"],
        ),
    )
    add(
        "transition-duplicate-without-target",
        _event(
            "duplicate",
            {"canonical_id": VID},
            finding_id=fid,
            review_id=review["id"],
        ),
    )
    add(
        "transition-failure-class-null",
        _event(
            "needs-human",
            {"reason": "operator attention"},
            finding_id=fid,
            review_id=review["id"],
        ),
    )
    add(
        "transition-context-error-cleared",
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        ),
        row_overrides={"context_error": {"type": "KeyError"}},
    )
    add(
        "transition-recovered-anchor",
        _event(
            "confirmed",
            {
                "target": SHA,
                "anchor_verified": True,
                "recovered_anchor": {
                    "path": "src/a.ts",
                    "blob": SHA,
                    "intervals": [[1, 1]],
                    "anchor_recovered_from": SHA64,
                },
            },
            finding_id=fid,
            review_id=review["id"],
        ),
    )
    add(
        "transition-empty-anchor",
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True, "recovered_anchor": {}},
            finding_id=fid,
            review_id=review["id"],
        ),
    )

    missing_evidence = copy.deepcopy(
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        )
    )
    missing_evidence["payload"].pop("evidence")
    add(
        "transition-missing-evidence",
        missing_evidence,
        expected_error="KeyError",
        expected_message="'evidence'",
    )

    evidence_not_object = copy.deepcopy(
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        )
    )
    evidence_not_object["payload"]["evidence"] = []
    add("transition-evidence-not-object", evidence_not_object, expected_error="AttributeError")

    missing_action = copy.deepcopy(
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        )
    )
    missing_action["payload"].pop("action")
    add(
        "transition-missing-action",
        missing_action,
        expected_error="KeyError",
        expected_message="'action'",
    )

    missing_id = copy.deepcopy(
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        )
    )
    missing_id.pop("id")
    add(
        "transition-missing-id",
        missing_id,
        expected_error="KeyError",
        expected_message="'id'",
    )

    missing_payload = copy.deepcopy(
        _event(
            "confirmed",
            {"target": SHA, "anchor_verified": True},
            finding_id=fid,
            review_id=review["id"],
        )
    )
    missing_payload.pop("payload")
    add(
        "transition-missing-payload",
        missing_payload,
        expected_error="KeyError",
        expected_message="'payload'",
    )

    add(
        "transition-duplicate-missing-canonical",
        _event(
            "duplicate",
            {"target": SHA, "mapped_path": "src/a.ts", "mapped_intervals": [[1, 1]]},
            finding_id=fid,
            review_id=review["id"],
        ),
        expected_error="KeyError",
        expected_message="'canonical_id'",
    )

    return {"family": "transition", "cases": cases}


def ingest_vectors() -> Dict[str, Any]:
    finding = _normalized()
    fid = finding["id"]
    review = _review([finding])
    cases: List[Dict[str, Any]] = []

    def add(
        name: str,
        target_review: Dict[str, Any],
        *,
        seeds: Sequence[Dict[str, Any]] = (),
        repeat: int = 1,
        expected_error: Optional[str] = None,
        expected_message: Optional[str] = None,
    ) -> None:
        inputs: Dict[str, Any] = {"review": target_review, "repeat": repeat}
        if seeds:
            inputs["seed"] = _seed_input(seeds)

        def setup(root: Path, inbox: delivery.Inbox, outbox: ledger.Outbox) -> None:
            _seed_rows(root, seeds)

        def operation(inbox: delivery.Inbox) -> Any:
            for _ in range(repeat):
                inbox.ingest(target_review)
            return _UNSET

        cases.append(
            _temp_case(
                name,
                "finding_delivery.Inbox.ingest",
                inputs,
                setup,
                operation,
                expected_error=expected_error,
                expected_message=expected_message,
            )
        )

    add("ingest-fresh", review)
    add("ingest-replay", review, repeat=2)

    other_review = _review([finding], source="seed")
    seed_row = {
        "id": fid,
        "canonical": ledger.canonical(
            {
                "review_id": other_review["id"],
                "finding": finding,
                "target": SHA,
                "canonical_id": fid,
                "previous_event_id": None,
                "status": "untriaged",
            }
        ).decode("utf-8"),
    }
    add(
        "ingest-review-id-conflict",
        review,
        seeds=[seed_row],
        expected_error="IntegrityError",
        expected_message="finding occurrence conflict",
    )

    conflict_finding = {**finding, "title": "Different title"}
    conflict_review = _review([conflict_finding], source="run-1")
    conflict_seed = {
        "id": fid,
        "canonical": ledger.canonical(
            {
                "review_id": conflict_review["id"],
                "finding": finding,
                "target": SHA,
                "canonical_id": fid,
                "previous_event_id": None,
                "status": "untriaged",
            }
        ).decode("utf-8"),
    }
    add(
        "ingest-finding-conflict",
        conflict_review,
        seeds=[conflict_seed],
        expected_error="IntegrityError",
        expected_message="finding occurrence conflict",
    )

    second = _normalized(_raw_finding(path="src/b.ts", title="Second"), run="run-2")
    multiple = _review([finding, second])
    add("ingest-multiple-order", multiple)

    later_seed = {
        "id": second["id"],
        "canonical": ledger.canonical(
            {
                "review_id": _review([{**second, "title": "Seed"}], source="seed")["id"],
                "finding": {**second, "title": "Seed"},
                "target": SHA,
                "canonical_id": second["id"],
                "previous_event_id": None,
                "status": "untriaged",
            }
        ).decode("utf-8"),
    }
    add(
        "ingest-later-conflict",
        _review([finding, second]),
        seeds=[later_seed],
        expected_error="IntegrityError",
        expected_message="finding occurrence conflict",
    )

    missing_target = copy.deepcopy(review)
    missing_target["payload"].pop("target")
    add(
        "ingest-unvalidated-missing-target",
        missing_target,
        expected_error="IntegrityError",
    )

    bad_id_review = copy.deepcopy(review)
    bad_id_review["payload"]["findings"][0]["id"] = "not-a-sha"
    add(
        "ingest-unvalidated-finding-id",
        bad_id_review,
        expected_error="IntegrityError",
    )

    add("ingest-empty-findings", _review([], source="run-1"))

    return {"family": "ingest", "cases": cases}


def recover_vectors() -> Dict[str, Any]:
    finding = _normalized()
    fid = finding["id"]
    review = _review([finding])
    base_row = {
        "review_id": review["id"],
        "finding": finding,
        "target": SHA,
        "canonical_id": fid,
        "previous_event_id": None,
        "status": "untriaged",
    }
    confirmed = _event(
        "confirmed",
        {
            "target": SHA,
            "reason": "valid",
            "anchor_verified": True,
            "mapped_path": "src/a.ts",
            "mapped_intervals": [[1, 1]],
        },
        finding_id=fid,
        review_id=review["id"],
        actor="crq-triage/judge",
    )
    delivered = _event(
        "delivered",
        {"acknowledgement": "a" * 64, "repair_task": "crq-task"},
        previous=confirmed["id"],
        finding_id=fid,
        review_id=review["id"],
        actor="crq-repair-adapter",
    )
    cases: List[Dict[str, Any]] = []

    def add(
        name: str,
        events: Sequence[Dict[str, Any]],
        *,
        rows: Sequence[Dict[str, Any]] = (),
        repeat: int = 1,
        expected_error: Optional[str] = None,
        expected_message: Optional[str] = None,
        acknowledged: bool = False,
    ) -> None:
        inputs: Dict[str, Any] = {"events": list(events), "repeat": repeat}
        if rows:
            inputs["seed"] = _seed_input(rows)
        if acknowledged:
            inputs["acknowledged"] = True

        def setup(root: Path, inbox: delivery.Inbox, outbox: ledger.Outbox) -> None:
            _seed_rows(root, rows)
            if acknowledged:
                ids = {value["id"] for value in events}
                for value in events:
                    outbox.spool(value)
                    outbox.acknowledge(value, ids)

        def operation(inbox: delivery.Inbox) -> Any:
            chosen: Sequence[Dict[str, Any]] = events
            if acknowledged:
                chosen = inbox.publication.retained()
            for _ in range(repeat):
                inbox.recover(chosen)
            return _UNSET

        cases.append(
            _temp_case(
                name,
                "finding_delivery.Inbox.recover",
                inputs,
                setup,
                operation,
                expected_error=expected_error,
                expected_message=expected_message,
            )
        )

    seed_row = {"id": fid, "canonical": ledger.canonical(base_row).decode("utf-8")}
    already_row = {
        "id": fid,
        "canonical": ledger.canonical({**base_row, "previous_event_id": confirmed["id"], "status": "confirmed"}).decode(
            "utf-8"
        ),
    }
    mismatch_row = {
        "id": fid,
        "canonical": ledger.canonical({**base_row, "previous_event_id": delivered["id"]}).decode("utf-8"),
    }

    add("recover-already-applied", [confirmed], rows=[already_row])
    add("recover-predecessor-mismatch", [confirmed], rows=[mismatch_row])
    add(
        "recover-missing-row",
        [
            _event(
                "confirmed",
                {"target": SHA, "anchor_verified": True},
                finding_id=VID,
                review_id=review["id"],
            )
        ],
    )
    missing_finding_id = copy.deepcopy(confirmed)
    missing_finding_id["payload"].pop("finding_id")
    add(
        "recover-missing-finding-id",
        [missing_finding_id],
        rows=[seed_row],
        expected_error="KeyError",
        expected_message="'finding_id'",
    )
    add("recover-reverse-order-chain", [delivered, confirmed], rows=[seed_row])
    add("recover-idempotent-second-pass", [confirmed], rows=[seed_row], repeat=2)
    add("recover-non-finding-events", [review, confirmed], rows=[seed_row])
    add("recover-acknowledged-chain", [delivered, confirmed], rows=[seed_row], acknowledged=True)

    bad = _event(
        "confirmed",
        {"target": VID, "anchor_verified": True},
        previous=confirmed["id"],
        finding_id=fid,
        review_id=review["id"],
    )
    bad["payload"].pop("evidence")
    add(
        "recover-partial-write-before-refusal",
        [confirmed, bad],
        rows=[seed_row],
        expected_error="KeyError",
        expected_message="'evidence'",
    )

    malformed_rows = {
        "recover-row-malformed-json": (b"{", "JSONDecodeError", None),
        "recover-row-duplicate-key": (
            b'{"a":1,"a":2}',
            "IntegrityError",
            "duplicate JSON key",
        ),
        "recover-row-float": (
            b'{"a":1.0}',
            "IntegrityError",
            "unsupported numeric JSON value",
        ),
    }
    for name, (data, error, message) in malformed_rows.items():
        row = {"id": fid, "canonical": data.decode("utf-8")}
        add(
            name,
            [confirmed],
            rows=[row],
            expected_error=error,
            expected_message=message,
        )

    return {"family": "recover", "cases": cases}


def document() -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/finding_inbox_vector_emit_b1.py",
        "families": [
            occurrence_vectors(),
            normalize_vectors(),
            transition_vectors(),
            ingest_vectors(),
            recover_vectors(),
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
        print(text, end="")
        return 0
    if options.check:
        existing = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else ""
        if existing != text:
            print(
                f"{FIXTURE} is stale; run python3 finding_inbox_vector_emit_b1.py --write",
                file=sys.stderr,
            )
            return 1
        return 0
    if options.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        print(f"wrote {FIXTURE}", file=sys.stderr)
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
