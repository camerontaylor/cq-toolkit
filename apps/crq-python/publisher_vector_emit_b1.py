#!/usr/bin/env python3
"""Deterministic B1 vectors for publication ordering and the durable outbox.

Test tooling only: importing this module has no runtime effect and crq never
imports it. It drives the real ``review_ledger.GitLedger.publish`` and
``review_ledger.Outbox`` with injected Git, transport and artifact fakes, then
records the exact canonical record bytes, batch composition, acknowledgements
and refusal class. The TypeScript replay in
``src/policy/crq/publication.ts`` and ``src/ops/review/internal/crq/`` compares against
this oracle at the same commit.

Every record is public and synthetic. No filesystem path, host, credential,
process id or timestamp is recorded, so regeneration is byte-identical on every
host and Python 3.14+ patch level. Git object ids are computed by the fake and
are never emitted.

Regenerate with ``python3 publisher_vector_emit_b1.py --write`` and verify with
``--check``. ``--stdout`` prints the whole document for the determinism test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from typing import Any, Dict, List, Sequence

import ledger_vector_emit_b1 as base
import review_ledger as ledger

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-publisher-b1" / "vectors.json"
SCHEMA = "cq.crq-publisher-b1-vector/v1"
AT = base.AT
SHA = base.SHA

# Public synthetic artifact references. The oracle verifies these against an
# injected store so no host path ever enters a record or the vectors.
ARTIFACT_OK = base.ARTIFACT
ARTIFACT_BAD = {"sha256": "d" * 64, "location": "/fixtures/artifacts/" + "d" * 64}
SYNTHETIC_ARTIFACTS = {ARTIFACT_OK["sha256"]: ARTIFACT_OK, ARTIFACT_BAD["sha256"]: ARTIFACT_BAD}


class OracleArtifacts(ledger.ArtifactStore):
    """Accept the public synthetic references; refuse configured ones."""

    def __init__(self, root: Path, refused: Sequence[str] = ()):
        super().__init__(root)
        self.refused = set(refused)

    def verify(self, reference: Dict[str, Any]) -> None:
        if reference.get("sha256") in self.refused:
            raise ledger.IntegrityError("missing or corrupt retained artifact")
        synthetic = SYNTHETIC_ARTIFACTS.get(reference.get("sha256"))
        if synthetic is not None and reference == synthetic:
            return
        super().verify(reference)


class RecordingOutbox(ledger.Outbox):
    """The real outbox, recording the order in which acknowledgements succeed."""

    def __init__(self, root: Path, artifacts: ledger.ArtifactStore):
        super().__init__(root, artifacts)
        self.acks: List[str] = []

    def acknowledge(self, value: Dict[str, Any], remote_ids: Dict[str, str]) -> None:
        super().acknowledge(value, remote_ids)
        self.acks.append(value["id"])


class OracleLedger(ledger.GitLedger):
    """Real publish loop over an in-memory linear ledger and a fake Git index."""

    def __init__(
        self,
        repo: Path,
        values: Sequence[Dict[str, Any]] = (),
        *,
        failures: int = 0,
        accept_then_fail: bool = False,
        concurrent: Sequence[Dict[str, Any]] = (),
        drop_on_fetch: Sequence[str] = (),
    ):
        super().__init__(repo)
        self.values = list(values)
        self.head = "0" * 40 if not self.values else "1" * 40
        self.failures = failures
        self.accept_then_fail = accept_then_fail
        self.concurrent = list(concurrent)
        self.drop_after_apply = set(drop_on_fetch)
        self.drop_next_fetch: set[str] = set()
        self.fetch_calls = 0
        self.push_calls = 0
        self.batches: List[List[Dict[str, Any]]] = []
        self.staged: Dict[str, bytes] = {}
        self.blobs: Dict[str, bytes] = {}
        self.trees: Dict[str, Dict[str, bytes]] = {}
        self.commits: Dict[str, tuple[str, Dict[str, bytes]]] = {}

    def git(self, *args: str, env=None, input=None, check=True, timeout=300) -> bytes:
        verb = args[0]
        if verb == "rev-parse":
            # Keep the publisher lock inside the owned temp directory.
            return b".\n"
        if verb == "read-tree":
            self.staged = {}
            return b""
        if verb == "hash-object":
            data = input or b""
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            self.blobs[blob] = data
            return blob.encode() + b"\n"
        if verb == "update-index":
            _mode, blob, path = args[3].split(",", 2)
            self.staged[path] = self.blobs[blob]
            return b""
        if verb == "write-tree":
            hasher = hashlib.sha1()
            for path, data in sorted(self.staged.items()):
                hasher.update(path.encode())
                hasher.update(b"\0")
                hasher.update(hashlib.sha1(data).digest())
            tree = hasher.hexdigest()
            self.trees[tree] = dict(self.staged)
            return tree.encode() + b"\n"
        if verb == "commit-tree":
            tree, parent, message = args[1], args[3], args[5]
            commit = hashlib.sha1((tree + "\n" + parent + "\n" + message).encode()).hexdigest()
            self.commits[commit] = (parent, dict(self.trees[tree]))
            if self.concurrent:
                self._append_concurrent()
            return commit.encode() + b"\n"
        raise AssertionError(f"unexpected fake git call: {args!r}")

    def fetch(self) -> tuple[str, List[Dict[str, Any]]]:
        self.fetch_calls += 1
        values = list(self.values)
        if self.drop_next_fetch:
            values = [value for value in values if value["id"] not in self.drop_next_fetch]
            self.drop_next_fetch = set()
        return self.head, values

    def push(self, base: str, head: str) -> None:
        self.push_calls += 1
        parent, staged = self.commits[head]
        if parent != base or base != self.head:
            raise OSError("non-fast-forward")
        if self.accept_then_fail:
            self.accept_then_fail = False
            self._apply(head, staged)
            raise OSError("push timed out after the remote accepted it")
        if self.failures:
            self.failures -= 1
            raise OSError("push refused")
        self._apply(head, staged)

    def _apply(self, head: str, staged: Dict[str, bytes]) -> None:
        records = [ledger.loads(data) for _, data in sorted(staged.items())]
        records.sort(key=lambda value: (value["event_type"] != "review", value["id"]))
        self.values.extend(records)
        self.head = head
        self.batches.append(records)
        if self.drop_after_apply:
            self.drop_next_fetch = set(self.drop_after_apply)

    def _append_concurrent(self) -> None:
        records = list(self.concurrent)
        self.concurrent = []
        records.sort(key=lambda value: (value["event_type"] != "review", value["id"]))
        self.values.extend(records)
        self.head = hashlib.sha1(
            ("concurrent" + self.head + records[0]["id"]).encode()
        ).hexdigest()


def _case(name: str, source: str, inputs: Dict[str, Any], *, value: Any = None,
          error: str | None = None, message: str | None = None) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": error is None}
    if error is None:
        expect["value"] = value
    else:
        expect["error"] = error
        if message is not None:
            expect["message"] = message
    return {"name": name, "source": source, "input": inputs, "expect": expect}


def _family(name: str, cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"family": name, "cases": cases}


def _record_evidence(value: Dict[str, Any]) -> Dict[str, Any]:
    raw = ledger.canonical(value)
    evidence: Dict[str, Any] = {
        "id": value["id"],
        "path": ledger.record_path(value),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    if len(raw) <= 4096:
        evidence["canonical"] = raw.decode("utf-8")
    return evidence


def _batch_evidence(batches: Sequence[Sequence[Dict[str, Any]]]) -> List[List[Dict[str, Any]]]:
    return [[_record_evidence(value) for value in batch] for batch in batches]


def _job_event(*, job_id: str = "fixture:0", source_key: str | None = None,
               state: str = "pending", reason: str = "fixture transition",
               **overrides: Any) -> Dict[str, Any]:
    payload = {"family": "fixture", "subject_id": "subject", "job_id": job_id,
               "generation": 0, "attempt": 0, "state": state, "failures": 0,
               "next_eligible_at": None, "reason": reason, **overrides}
    key = source_key or "job:" + job_id + ":" + ledger.digest(payload)
    return ledger.event("job-state", key, AT, payload)


def _import(*, ident: str = "1", artifact: Dict[str, Any] = ARTIFACT_OK,
            result: str = "unverified", review_id: str | None = None,
            duplicate_id: str | None = None) -> Dict[str, Any]:
    return ledger.event("import-result", "import:" + ident, AT, {
        "source": {"repo": ledger.REPO, "producer": "fixture", "type": "author-cli",
                   "id": ident, "authenticated": False},
        "source_digest": artifact["sha256"], "result": result, "reason": "fixture",
        "review_id": review_id, "duplicate_id": duplicate_id, "artifacts": [artifact],
    })


def _review(*, source: str = "run-1", path: str = "src/a.ts",
            findings: List[Dict[str, Any]] | None = None,
            artifact: Dict[str, Any] = ARTIFACT_OK) -> Dict[str, Any]:
    return base._review(source=source, path=path, findings=findings,
                        artifacts=[artifact], outcome="skipped")


def _finding(ident: str = "e" * 64, *, path: str = "src/a.ts") -> Dict[str, Any]:
    value = base._finding(path=path)
    value["id"] = ident
    return value


def _finding_event(review: Dict[str, Any], finding: Dict[str, Any], *,
                   previous: str | None = None, reason: str = "fixture",
                   action: str = "confirmed") -> Dict[str, Any]:
    return ledger.event(
        "finding-event",
        "finding:" + finding["id"] + ":" + ledger.digest(
            {"previous": previous, "action": action, "reason": reason}),
        AT,
        {"finding_id": finding["id"], "review_id": review["id"],
         "previous_event_id": previous, "action": action,
         "evidence": {"target": SHA, "reason": reason, "anchor_verified": True},
         "actor": "fixture"},
    )


def _event_before_review(review: Dict[str, Any], finding: Dict[str, Any]) -> Dict[str, Any]:
    """A finding event whose id sorts before its review, so causal order is real."""
    for index in range(1000):
        value = _finding_event(review, finding, reason="fixture-" + str(index))
        if value["id"] < review["id"]:
            return value
    raise AssertionError("could not construct a causally reversed event id")


def _write_pending(outbox: ledger.Outbox, value: Dict[str, Any]) -> None:
    """Seed a retained record without the spool-time artifact check."""
    ledger.atomic(outbox.root / "pending" / (value["id"] + ".json"), ledger.canonical(value))


def _write_ack(outbox: ledger.Outbox, ident: str) -> None:
    ledger.atomic(outbox.root / "ack" / (ident + ".json"), ledger.canonical({"id": ident}))


def _reordered(value: Any) -> Any:
    """The same mapping with every object's keys reversed."""
    if isinstance(value, dict):
        return {key: _reordered(value[key]) for key in reversed(list(value))}
    if isinstance(value, list):
        return [_reordered(item) for item in value]
    return value


def _semantically_equal_replay(value: Dict[str, Any]) -> Dict[str, Any]:
    """A Python-equal record with a different key order and `False` for `0`."""
    reordered = _reordered(value)
    reordered["payload"]["attempt"] = False
    return reordered


def _id_before(anchor: Dict[str, Any], prefix: str) -> Dict[str, Any]:
    """A job event whose id sorts before `anchor` in pending order."""
    for index in range(1000):
        value = _job_event(job_id=prefix + "-" + str(index))
        if value["id"] < anchor["id"]:
            return value
    raise AssertionError("could not construct an id before " + anchor["id"])


def outbox_vectors() -> Dict[str, Any]:
    record = _job_event(job_id="fixture:replay")

    def spool_replay() -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
            first = outbox.spool(record)
            second = outbox.spool(record)
            return {"ids": [first, second],
                    "pending": _batch_evidence([outbox.pending()])[0],
                    "retained": [value["id"] for value in outbox.retained()]}

    def spool_conflict() -> Dict[str, Any]:
        other = _job_event(job_id="fixture:conflict")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
            outbox.spool(record)
            # A different valid record under this id is only reachable by a
            # tampered/racing file, which is exactly the replay conflict.
            ledger.atomic(outbox.root / "pending" / (record["id"] + ".json"),
                          ledger.canonical(other))
            outbox.spool(record)
            return {}

    def artifact_refusal() -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication",
                                     OracleArtifacts(root / "artifacts",
                                                     refused=[ARTIFACT_OK["sha256"]]))
            outbox.spool(_import(ident="artifact-refused"))
            return {}

    def ack_requires_remote() -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
            outbox.spool(record)
            outbox.acknowledge(record, {})
            return {}

    def pending_excludes_ack() -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
            outbox.spool(record)
            outbox.acknowledge(record, {record["id"]})
            return {"pending": outbox.pending(), "retained": [v["id"] for v in outbox.retained()],
                    "acks": list(outbox.acks)}

    def semantic_replay() -> Dict[str, Any]:
        reordered = _semantically_equal_replay(record)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
            outbox.spool(record)
            before = ledger.canonical(reordered)
            ledger.atomic(outbox.root / "pending" / (record["id"] + ".json"), before)
            second = outbox.spool(record)
            after = ledger.canonical(record)
            return {"ids": [second],
                    "pending": _batch_evidence([outbox.pending()])[0],
                    "retained": [value["id"] for value in outbox.retained()],
                    "pre_sha256": hashlib.sha256(before).hexdigest(),
                    "post_sha256": hashlib.sha256(after).hexdigest()}

    cases = [
        _case("spool-idempotent-replay", "review_ledger.Outbox.spool", {"value": record},
              value=spool_replay()),
        _case("spool-replay-conflict", "review_ledger.Outbox.spool",
              {"value": record, "conflicting": _job_event(job_id="fixture:conflict")},
              error="IntegrityError", message="outbox replay conflict"),
        _case("spool-verifies-artifact", "review_ledger.Outbox.spool",
              {"value": _import(ident="artifact-refused")},
              error="IntegrityError", message="missing or corrupt retained artifact"),
        _case("acknowledge-requires-remote", "review_ledger.Outbox.acknowledge",
              {"value": record, "remote": []},
              error="IntegrityError",
              message="publication requires remote acknowledgement"),
        _case("pending-excludes-ack", "review_ledger.Outbox.pending", {"value": record},
              value=pending_excludes_ack()),
        _case("spool-semantic-replay", "review_ledger.Outbox.spool",
              {"value": record, "reordered": _semantically_equal_replay(record)},
              value=semantic_replay()),
    ]
    # Capture failures for the effect cases, keeping their partial state.
    for case, action in ((cases[1], spool_conflict), (cases[2], artifact_refusal),
                         (cases[3], ack_requires_remote)):
        try:
            action()
        except ledger.IntegrityError as exc:  # the vector records the oracle's refusal
            case["expect"]["error"] = type(exc).__name__
            case["expect"]["message"] = str(exc)
        else:
            raise AssertionError(case["name"] + ": oracle did not refuse")
    return _family("outbox", cases)


def _publish_case(name: str, *, ledger_values: Sequence[Dict[str, Any]] = (),
                  pending: Sequence[Dict[str, Any]] = (),
                  direct: Sequence[Dict[str, Any]] = (),
                  acked: Sequence[str] = (),
                  failures: int = 0, accept_then_fail: bool = False,
                  concurrent: Sequence[Dict[str, Any]] = (),
                  drop_on_fetch: Sequence[str] = (),
                  refused_artifacts: Sequence[str] = (),
                  refusals: tuple[type[BaseException], ...] = (ledger.IntegrityError,),
                  ) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        repo = root / "publisher.git"
        repo.mkdir()
        outbox = RecordingOutbox(root / "publication", OracleArtifacts(root / "artifacts"))
        for value in pending:
            outbox.spool(value)
        for value in direct:
            _write_pending(outbox, value)
        for ident in acked:
            _write_ack(outbox, ident)
        if refused_artifacts:
            outbox.artifacts = OracleArtifacts(root / "artifacts", refused=refused_artifacts)
        remote = OracleLedger(repo, ledger_values, failures=failures,
                              accept_then_fail=accept_then_fail,
                              concurrent=concurrent, drop_on_fetch=drop_on_fetch)
        try:
            outcome: Dict[str, Any] = {"ok": True}
            remote.publish(outbox)
        except refusals as exc:  # the vector records the oracle's refusal
            outcome = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
        value = {
            "fetch_calls": remote.fetch_calls,
            "push_calls": remote.push_calls,
            "batches": _batch_evidence(remote.batches),
            "acks": list(outbox.acks),
            "pending": sorted(record["id"] for record in outbox.pending()),
        }
        expect: Dict[str, Any] = {"ok": outcome["ok"]}
        if outcome["ok"]:
            expect["value"] = value
        else:
            expect.update(error=outcome["error"], message=outcome["message"], value=value)
        return {"name": name, "source": "review_ledger.GitLedger.publish",
                "input": {"ledger": list(ledger_values), "pending": list(pending),
                          "direct": list(direct), "acked": list(acked),
                          "failures": failures, "accept_then_fail": accept_then_fail,
                          "concurrent": list(concurrent),
                          "drop_on_fetch": list(drop_on_fetch),
                          "refused_artifacts": list(refused_artifacts)},
                "expect": expect}


def publish_vectors() -> Dict[str, Any]:
    idle = _job_event(job_id="fixture:idle")
    enrollment = base._job_state(job_id="fixture:enroll")
    enrollment_two = base._job_state(job_id="fixture:enroll-2")
    enrollment_three = base._job_state(job_id="fixture:enroll-3")
    independent = [_import(ident="batch-" + str(index)) for index in range(65)]
    boundary_enrollment = base._job_state(job_id="fixture:boundary")
    boundary_import = _import(ident="boundary-import")
    boundary_enrollment_two = base._job_state(job_id="fixture:boundary-2")

    finding = _finding("f" * 64)
    review = _review(source="causal", findings=[finding])
    event = _event_before_review(review, finding)

    finding_fork = _finding("a" * 64)
    review_fork = _review(source="fork", findings=[finding_fork])
    fork_first = _finding_event(review_fork, finding_fork, reason="fork-first")
    fork_second = _finding_event(review_fork, finding_fork, reason="fork-second")

    orphan_review = _review(source="orphan", findings=[_finding("b" * 64)])
    orphan_event = _finding_event(orphan_review, _finding("b" * 64), reason="orphan")

    mid_review = _review(source="midstream", findings=[_finding("c" * 64)])
    mid_import = _import(ident="midstream", artifact=ARTIFACT_BAD,
                         result="credited", review_id=mid_review["id"])

    # UTF-8 bytes, not JavaScript characters: the UTF-16 length stays below
    # the 1 MiB bound while the canonical UTF-8 bytes cross it.
    oversized = _job_event(job_id="fixture:oversized",
                           reason="a" * 1_000_000 + "雪" * 20_000)

    invalid_a = _job_event(job_id="fixture:invalid-a", source_key="fixed-conflict",
                           state="pending")
    invalid_b = _job_event(job_id="fixture:invalid-b", source_key="fixed-conflict",
                           state="failed")

    retry = _job_event(job_id="fixture:retry")
    timeout = _job_event(job_id="fixture:timeout")
    dropped = _job_event(job_id="fixture:dropped")
    concurrent_ours = _job_event(job_id="fixture:ours")
    concurrent_theirs = _job_event(job_id="fixture:theirs")
    failing = _job_event(job_id="fixture:failing")
    already = _job_event(job_id="fixture:already")
    ack_before_oversize = _id_before(oversized, "fixture:ack-before-oversize")
    ack_before_midstream = _job_event(job_id="fixture:ack-before-midstream")

    def malformed_jobs(position: str) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Three retained jobs sorted by id, with one missing payload.reason.

        The two well-formed records are already on the remote, so Python
        acknowledges the prefix before the malformed record and stops before
        acknowledging anything after it.
        """
        records = sorted(
            [_job_event(job_id="fixture:malformed-" + suffix) for suffix in "abc"],
            key=lambda value: value["id"],
        )
        index = {"first": 0, "middle": 1, "last": 2}[position]
        del records[index]["payload"]["reason"]
        remote = [value for offset, value in enumerate(records) if offset != index]
        return remote, records

    malformed_first, first_records = malformed_jobs("first")
    malformed_middle, middle_records = malformed_jobs("middle")
    malformed_last, last_records = malformed_jobs("last")

    def malformed_import(position: str) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Three retained records with a list-valued import result at position.

        Python's tuple membership compares rather than hashes, so the import is
        classified as a non-import, both remote-held job records are
        acknowledged, and only batch validation refuses the malformed record.
        """
        jobs = [_job_event(job_id="fixture:import-list-" + suffix) for suffix in "ab"]
        index = {"first": 0, "middle": 1, "last": 2}[position]
        for attempt in range(1000):
            malformed = _import(ident="malformed-import-" + position + "-" + str(attempt))
            records = sorted(jobs + [malformed], key=lambda value: value["id"])
            if records.index(malformed) == index:
                break
        else:
            raise AssertionError("could not place malformed import at " + position)
        malformed["payload"]["result"] = []
        remote = [value for offset, value in enumerate(records) if offset != index]
        return remote, records

    import_first, import_first_records = malformed_import("first")
    import_middle, import_middle_records = malformed_import("middle")
    import_last, import_last_records = malformed_import("last")
    unhashable_dependency = _import(ident="unhashable-dependency")
    unhashable_dependency["payload"]["review_id"] = []
    unhashable_dependency["payload"]["duplicate_id"] = None

    return _family("publish", [
        _publish_case("idle-outbox", ledger_values=[idle]),
        _publish_case("initial-remote-acks", ledger_values=[already], pending=[already]),
        _publish_case("single-enrollment", pending=[enrollment]),
        _publish_case("enrollment-batch-merge",
                      pending=[enrollment, enrollment_two, enrollment_three]),
        _publish_case("import-batch-merge", pending=independent[:3]),
        _publish_case("import-batch-limit", pending=independent),
        _publish_case("kind-boundary-separates-batches",
                      pending=[boundary_enrollment, boundary_import, boundary_enrollment_two]),
        _publish_case("finding-event-causal-order", pending=[event, review]),
        _publish_case("finding-event-missing-review", pending=[orphan_event]),
        _publish_case("forked-predecessor", ledger_values=[review_fork, fork_first],
                      pending=[fork_second]),
        _publish_case("record-over-limit-utf8", pending=[oversized]),
        _publish_case("push-failure-retries", pending=[retry], failures=1),
        _publish_case("accepted-then-timeout", pending=[timeout], accept_then_fail=True),
        _publish_case("concurrent-remote-append", pending=[concurrent_ours],
                      concurrent=[concurrent_theirs]),
        _publish_case("invalid-fetch", ledger_values=[invalid_a, invalid_b]),
        _publish_case("ack-missing-after-push", pending=[dropped],
                      drop_on_fetch=[dropped["id"]]),
        _publish_case("midstream-artifact-failure", pending=[mid_review, mid_import],
                      refused_artifacts=[ARTIFACT_BAD["sha256"]]),
        _publish_case("partial-ack-before-oversize",
                      ledger_values=[ack_before_oversize],
                      pending=[ack_before_oversize, oversized]),
        _publish_case("partial-ack-before-midstream-artifact",
                      ledger_values=[ack_before_midstream],
                      pending=[ack_before_midstream, mid_review, mid_import],
                      refused_artifacts=[ARTIFACT_BAD["sha256"]]),
        _publish_case("malformed-first-retained-job", ledger_values=malformed_first,
                      direct=first_records, refusals=(KeyError,)),
        _publish_case("malformed-middle-retained-job", ledger_values=malformed_middle,
                      direct=middle_records, refusals=(KeyError,)),
        _publish_case("malformed-last-retained-job", ledger_values=malformed_last,
                      direct=last_records, refusals=(KeyError,)),
        _publish_case("malformed-import-result-list-first", ledger_values=import_first,
                      direct=import_first_records),
        _publish_case("malformed-import-result-list-middle", ledger_values=import_middle,
                      direct=import_middle_records),
        _publish_case("malformed-import-result-list-last", ledger_values=import_last,
                      direct=import_last_records),
        _publish_case("unhashable-import-dependency", ledger_values=[already],
                      direct=[unhashable_dependency], refusals=(TypeError,)),
        _publish_case("three-push-failures", pending=[failing], failures=3),
    ])


def document() -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/publisher_vector_emit_b1.py",
        "families": [outbox_vectors(), publish_vectors()],
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
            print(f"{FIXTURE} is stale; run python3 publisher_vector_emit_b1.py --write",
                  file=sys.stderr)
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
