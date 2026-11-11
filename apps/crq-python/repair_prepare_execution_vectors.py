#!/usr/bin/env python3
"""Deterministic offline oracle for the TS repair-preparation executor.

Test tooling only. It imports the PRODUCTION ``repair_tick.prepare_current_job``,
``finding_delivery.Inbox`` and ``review_ledger.Outbox``, fakes only git, the
secret scanner and the queue writer, and records what the Python runtime
actually does in a temp root: the ordered effect trace (tick/findings/outbox
locks, job/triage/outbox/queue writes), the exact state bytes, and the
partial-failure retry behaviour.

The fake ``_Root`` models ``crq.py repair-prepare``: the whole preparation runs
inside the caller's ``tick.lock`` scope. The real ``Inbox.handoff`` supplies
the nested ``findings.lock``/``outbox.lock`` order at
``state/backfill/findings`` and ``state/backfill/publication``, exactly as
``repair_tick.finding_inbox`` binds them. No production module is modified and
no model, network, ceres, systemd, signer, queue or host state is touched.

Regenerate with ``python3 repair_prepare_execution_vectors.py --write`` and
verify with ``--check``. Output is deterministic (sorted case order,
``ensure_ascii``, no timestamps or host paths).
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import crq_repair
import finding_delivery
import repair_tick
import review_ledger as ledger
from crq_repair import bounded
from runtime_target import DEFAULT_REF

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-repair-prepare-execution" / "cases.json"
SCHEMA = "cq.crq-repair-prepare-execution-vector/v1"

SOURCE = "a" * 40
HISTORICAL = "b" * 40
BLOB = "c" * 40
CANONICAL = "f" * 64
OLD = "crq-historical-F1"
FOREIGN = "crq-foreign-F1"
ITEM = "pr1-merged"
OLD_RUN = "old-run"
PINNED_SOURCE = "\nfirst\nsecond\n"
ISO = "2026-11-11T00:00:00Z"

CLEAN_REPORT = {
    "denylist_rules": 0,
    "denylist_hits": 0,
    "gitleaks": "clean",
    "gitleaks_hits": 0,
}


def _dump(value):
    """The exact ``crq_repair.atomic`` bytes for a value."""
    return json.dumps(value, indent=2) + "\n"


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _old_job(**overrides):
    job = {
        "job": OLD,
        "item": ITEM,
        "kind": "merged",
        "pr": 1,
        "run": OLD_RUN,
        "cycle": 1,
        "repair_base": HISTORICAL,
        "branch": None,
        "finding": {
            "path": "src/lock.ts",
            "line": 2,
            "severity": "major",
            "body": "Finding data",
            "id": "thread-1",
        },
        "repair_round": 1,
        "prior": None,
        "recurrence": False,
        "review_diff": "diff --git a/src/lock.ts b/src/lock.ts\n",
        "source": {"run": OLD_RUN, "id": "thread-1", "thread_id": "th-1"},
    }
    job.update(overrides)
    return job


def _previous_record():
    return {
        "jobs": ["crq-previous-F1"],
        "base": SOURCE,
        "pin": SOURCE,
        "state": "done",
        "canonical_finding_id": CANONICAL,
    }


def _queue_initial(*, canonical, previous_round=False):
    runs = {
        OLD_RUN: {
            "jobs": [OLD],
            "base": HISTORICAL,
            "pin": HISTORICAL,
            "state": "queued",
        }
    }
    if previous_round:
        runs["revalidated-previous"] = _previous_record()
    return {"items": [{"id": ITEM, "pr": 1, "kind": "merged", "state": "done",
                       "repair_runs": runs}]}


def _evidence(finding):
    return {
        "source_sha": SOURCE,
        "source_blob_sha": BLOB,
        "finding_sha256": bounded.identity(finding),
        "verdict": "still-valid",
        "reviewer": "independent-test-reviewer",
        "reason": "Pinned source retains the unstable initialization metadata comparison.",
    }


def _prepared_id(evidence, preserve):
    """The production prepared id for this binding, for state seeding."""
    binding = {"origin_job": OLD, "source_sha": SOURCE, "evidence": evidence}
    if preserve:
        binding["preserve_worktree"] = True
    run = "revalidated-" + bounded.identity(binding)[:24]
    return run, "crq-" + run + "-F1"


def _triage_row(repair_task, *, status="delivered"):
    return {
        "review_id": "1" * 64,
        "finding": {"id": CANONICAL, "path": "src/lock.ts"},
        "canonical_id": CANONICAL,
        "previous_event_id": "event-1",
        "status": status,
        "receipt": {"repair_task": repair_task},
    }


class _Trace:
    """One ordered, redacted effect log plus the attempt's injected failures."""

    def __init__(self, failures=None):
        self.entries = []
        self.failures = dict(failures or {})

    def record(self, entry):
        self.entries.append(entry)

    def take(self, target):
        remaining = self.failures.get(target, 0)
        if remaining <= 0:
            return False
        self.failures[target] = remaining - 1
        return True


class _RecordingInbox:
    """Records the handoff boundary around the real ``Inbox.handoff``."""

    def __init__(self, inbox, trace):
        self.inbox = inbox
        self.trace = trace

    @property
    def publication(self):
        return self.inbox.publication

    def handoff(self, finding_id, previous_task, job, at):
        self.trace.record({
            "kind": "handoff",
            "phase": "enter",
            "finding_id": finding_id,
            "prepared_job_id": job.get("job"),
        })
        try:
            value = self.inbox.handoff(finding_id, previous_task, job, at)
        except Exception:
            self.trace.record({"kind": "handoff", "phase": "exit", "outcome": "error"})
            raise
        self.trace.record({"kind": "handoff", "phase": "exit", "outcome": "ok"})
        return value


class _Root:
    """The fake ``crq`` service surface ``prepare_current_job`` uses."""

    def __init__(self, root, *, trace, scan_spec, source_text, tip, blob):
        self.ROOT = root
        self.STATE = root / "state"
        self.CLONE = Path("/unused")
        self.CONFIG = {"clone": "/unused", "repair": {"max_rounds_per_pin": 2}}
        self.iso = lambda: ISO
        self.trace = trace
        self.scan_spec = scan_spec or {}
        self.source_text = source_text
        self.tip = tip
        self.blob = blob
        self.scan_calls = []
        self.scan_results = []

    def run(self, argv, **kwargs):
        return SimpleNamespace(stdout=self.source_text)

    def secret_scan_diff(self, patch, path, **kwargs):
        self.scan_calls.append(Path(path).name)
        kind = "instructions" if "crq-fix-instructions.txt" in patch else "source"
        spec = self.scan_spec.get(kind, {})
        if spec.get("error"):
            raise RuntimeError("secret scan unavailable: synthetic")
        clean = bool(spec.get("clean", True))
        report = dict(spec.get("report") or CLEAN_REPORT)
        self.scan_results.append({"kind": kind, "clean": clean, "report": report})
        return clean, report

    def save_queue(self, queue):
        # The patched ``repair_tick.atomic`` records and may fail this write.
        repair_tick.atomic(self.ROOT / "state" / "queue.json", queue)


def _state(root):
    inbox = root / "state" / "repair" / "inbox"
    triage = root / "state" / "backfill" / "findings" / "triage"
    pending = root / "state" / "backfill" / "publication" / "pending"
    queue = root / "state" / "queue.json"
    return {
        "jobs": [
            {"id": path.stem, "canonical": path.read_text()} for path in sorted(inbox.glob("*.json"))
        ],
        "queue": queue.read_text() if queue.exists() else None,
        "triage": [
            {"id": path.stem, "canonical": path.read_text()} for path in sorted(triage.glob("*.json"))
        ],
        "retained": [
            {"id": path.stem, "canonical": path.read_text()} for path in sorted(pending.glob("*.json"))
        ],
    }


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump(value))


def _read_queue(root):
    return json.loads((root / "state" / "queue.json").read_text())


def _attempt(root, spec, *, failures=None, retry_row=None):
    """Run one traced preparation attempt against the current disk state."""
    trace = _Trace(failures)
    if retry_row is not None:
        _write_json(root / "state" / "backfill" / "findings" / "triage" / (CANONICAL + ".json"),
                    retry_row)

    queue = _read_queue(root)
    old = json.loads((root / "state" / "repair" / "inbox" / (OLD + ".json")).read_text())
    evidence = _evidence(old["finding"])
    path = old["finding"]["path"]
    service = _Root(
        root,
        trace=trace,
        scan_spec=spec.get("scan_spec"),
        source_text=spec.get("source_text", PINNED_SOURCE),
        tip=spec.get("tip", SOURCE),
        blob=spec.get("blob", BLOB),
    )
    service.CONFIG["repair"]["max_rounds_per_pin"] = spec.get("max_rounds", 2)

    real_atomic = crq_repair.atomic
    real_ledger_atomic = ledger.atomic
    real_locked = ledger.locked

    def state_target(value):
        path_obj = Path(value)
        if path_obj.name == "queue.json":
            return "queue"
        if path_obj.parent.name == "inbox":
            return "job"
        return "state"

    def traced_atomic(value, data):
        target = state_target(value)
        if trace.take(target):
            trace.record({"kind": "write", "target": target, "outcome": "error"})
            raise OSError("synthetic " + target + " write failure")
        real_atomic(Path(value), data)
        text = _dump(data)
        entry = {"kind": "write", "target": target, "sha256": _sha(text), "canonical": text}
        if target == "job":
            entry["id"] = Path(value).stem
        trace.record(entry)

    def traced_ledger_atomic(filename, data):
        path_obj = Path(filename)
        target = ("triage" if path_obj.parent.name == "triage"
                  else "outbox" if path_obj.parent.name == "pending" else "other")
        if trace.take(target):
            trace.record({"kind": "write", "target": target, "outcome": "error"})
            raise OSError("synthetic " + target + " write failure")
        real_ledger_atomic(path_obj, data)
        text = bytes(data).decode()
        trace.record({"kind": "write", "target": target, "sha256": _sha(text), "canonical": text})

    def traced_locked(filename):
        @contextlib.contextmanager
        def scope():
            name = Path(filename).name
            trace.record({"kind": "lock", "phase": "enter", "target": name})
            try:
                with real_locked(filename):
                    yield
            finally:
                trace.record({"kind": "lock", "phase": "exit", "target": name})

        return scope()

    def fake_git(clone, *args):
        if args == ("rev-parse", DEFAULT_REF):
            return service.tip
        if args == ("rev-parse", SOURCE + ":" + path):
            return service.blob
        raise AssertionError("unexpected git call: " + repr(args))

    def inbox_factory(_root):
        outbox = ledger.Outbox(
            root / "state" / "backfill" / "publication",
            ledger.ArtifactStore(root / "state" / "backfill" / "artifacts"),
        )
        return _RecordingInbox(
            finding_delivery.Inbox(root / "state" / "backfill" / "findings", outbox),
            trace,
        )

    trace.record({"kind": "lock", "phase": "enter", "target": "tick.lock"})
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(bounded, "git", new=fake_git))
        stack.enter_context(mock.patch.object(repair_tick, "atomic", new=traced_atomic))
        stack.enter_context(mock.patch.object(ledger, "atomic", new=traced_ledger_atomic))
        stack.enter_context(mock.patch.object(ledger, "locked", new=traced_locked))
        stack.enter_context(mock.patch.object(repair_tick, "finding_inbox", new=inbox_factory))
        try:
            job_id = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence,
                preserve_worktree=bool(spec.get("preserve_worktree", False)),
            )
            outcome = {"status": "ok", "job_id": job_id}
        except Exception as exc:  # the runtime's refusal/failure, recorded verbatim
            outcome = {"status": "error", "type": type(exc).__name__, "message": str(exc)}
        finally:
            trace.record({"kind": "lock", "phase": "exit", "target": "tick.lock"})

    return {
        "outcome": outcome,
        "trace": trace.entries,
        "scan_calls": service.scan_calls,
        "scan_results": service.scan_results,
        "state": _state(root),
    }


def _case(spec):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        canonical = bool(spec.get("canonical"))
        old = _old_job()
        if canonical:
            old["canonical_finding_id"] = CANONICAL
        _write_json(root / "state" / "repair" / "inbox" / (OLD + ".json"), old)
        _write_json(root / "state" / "queue.json",
                    _queue_initial(canonical=canonical,
                                   previous_round=bool(spec.get("previous_round", False))))
        evidence = _evidence(old["finding"])
        _run, job_id = _prepared_id(evidence, bool(spec.get("preserve_worktree", False)))
        if canonical:
            owner = {"old": OLD, "prepared": job_id, "foreign": FOREIGN}[
                spec.get("row_owner", "old")
            ]
            _write_json(root / "state" / "backfill" / "findings" / "triage" / (CANONICAL + ".json"),
                        _triage_row(owner))

        if spec.get("prepared"):
            # A real successful first preparation seeds job/queue/triage/outbox;
            # the recorded attempt is the runtime's idempotent second call.
            setup = _attempt(root, spec)
            if setup["outcome"]["status"] != "ok":
                raise AssertionError("prepared setup failed: " + repr(setup["outcome"]))

        setup_state = _state(root)
        first = _attempt(root, spec, failures=spec.get("failures"))
        attempts = [{"label": "first", **first}]
        if spec.get("retry"):
            retry_row = _triage_row(OLD) if spec.get("fix_row_on_retry") else None
            attempts.append({
                "label": "retry",
                **_attempt(root, spec, failures=spec.get("retry_failures"), retry_row=retry_row),
            })

        return {
            "name": spec["name"],
            "input": {
                "old_job_json": _dump(old),
                "old_job_id": OLD,
                "queue_json": setup_state["queue"],
                "source_sha": SOURCE,
                "evidence_json": _dump(evidence),
                "max_rounds_per_pin": spec.get("max_rounds", 2),
                "preserve_worktree": bool(spec.get("preserve_worktree", False)),
            },
            "gate_effects": {
                "current_tip": spec.get("tip", SOURCE),
                "blob_oid": spec.get("blob", BLOB),
                "source_text": spec.get("source_text", PINNED_SOURCE),
            },
            "setup": setup_state,
            "job_id": job_id,
            "handoff_at": ISO,
            "race_row_owner": spec.get("race_row_owner"),
            "retry_row_owner": "old" if spec.get("fix_row_on_retry") else None,
            "ts_refusal": spec.get("ts_refusal"),
            "attempts": attempts,
        }


def _execution_cases():
    specs = [
        {"name": "new-canonical-old-owner", "canonical": True},
        {"name": "new-canonical-prepared-owner", "canonical": True,
         "row_owner": "prepared"},
        {"name": "new-non-canonical"},
        {"name": "new-preserve-worktree-canonical", "canonical": True,
         "preserve_worktree": True},
        {"name": "refuse-scan-dirty",
         "scan_spec": {"source": {"clean": False, "report": {
             "denylist_rules": 1, "denylist_hits": 1,
             "gitleaks": "clean", "gitleaks_hits": 0}}},
         "ts_refusal": "source-secret-scan-failed"},
        {"name": "refuse-round-ceiling", "canonical": True, "previous_round": True,
         "max_rounds": 1, "ts_refusal": "round-ceiling"},
        {"name": "idempotent-canonical", "canonical": True, "prepared": True},
        {"name": "idempotent-non-canonical", "prepared": True},
        {"name": "fail-job-write", "failures": {"job": 1}, "retry": True},
        {"name": "fail-handoff-owner-mismatch", "canonical": True,
         "row_owner": "foreign", "race_row_owner": "old", "retry": True,
         "fix_row_on_retry": True},
        {"name": "fail-outbox-write", "canonical": True, "failures": {"outbox": 1},
         "retry": True},
        {"name": "fail-row-write", "canonical": True, "failures": {"triage": 1},
         "retry": True},
        {"name": "fail-queue-write", "canonical": True, "failures": {"queue": 1},
         "retry": True},
    ]
    return [_case(spec) for spec in specs]


def build():
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/repair_tick.py + finding_delivery.Inbox.handoff",
        "execution_cases": _execution_cases(),
    }


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Emit the repair-preparation executor oracle")
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
        print("repair-prepare-execution fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
