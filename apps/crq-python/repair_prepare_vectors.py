#!/usr/bin/env python3
"""Deterministic offline oracle for the TS repair-prepare binding slice.

Test tooling only. It imports the PRODUCTION `crq_repair.bounded` and
`repair_tick.prepare_current_job`, fakes every external effect (git, the
secret scanner, the queue writer, the canonical inbox and the clock) and
records what the Python runtime actually produces: digests, prepared ids,
exact atomic job bytes, exact run-record bytes, git read order, accept/refuse
outcomes, and the legacy harvest binding decisions.

No production module is modified. No model, network, ceres, systemd, signer,
ledger, queue or host state is touched: every case runs in a temp directory.

Regenerate with ``python3 repair_prepare_vectors.py --write`` and verify with
``python3 repair_prepare_vectors.py --check``. Output is deterministic
(ensure_ascii, sorted case order, no timestamps or host paths).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import crq
import repair_tick
import review_ledger as ledger
from crq_repair import atomic, bounded
from finding_delivery import Inbox

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "repair-prepare" / "cases.json"
SCHEMA = "cq.crq-repair-prepare-vector/v1"

SOURCE = "a" * 40
HISTORICAL = "b" * 40
BLOB = "c" * 40
OTHER = "d" * 40
OTHER_BLOB = "e" * 40
CANONICAL = "f" * 64
OLD = "crq-historical-F1"
ITEM = "pr1-merged"
OLD_RUN = "old-run"
PINNED_SOURCE = "\nfirst\nsecond\n"
ISO = "2026-11-11T00:00:00Z"

identity = bounded.identity


def _full_source_patch(path, text):
    """The production full-source scan patch, kept byte-identical."""
    lines = text.splitlines()
    return (
        "diff --git a/" + path + " b/" + path + "\n"
        "--- /dev/null\n+++ b/" + path + "\n"
        "@@ -0,0 +1," + str(len(lines)) + " @@\n"
        + "\n".join("+" + line for line in lines) + "\n"
    )


def _instructions_patch(text):
    """The production fix-instructions scan patch, kept byte-identical."""
    lines = text.split("\n")
    return (
        "diff --git a/crq-fix-instructions.txt b/crq-fix-instructions.txt\n"
        "--- /dev/null\n+++ b/crq-fix-instructions.txt\n"
        "@@ -0,0 +1," + str(len(lines)) + " @@\n"
        + "\n".join("+" + line for line in lines) + "\n"
    )


def _scan_evidence(scan_calls, scan_results, run):
    """The redacted evidence the TS read-gate layer derives from a fake scan."""
    evidence = []
    for call, result in zip(scan_calls, scan_results):
        if result.get("error"):
            continue
        instructions = "crq-fix-instructions.txt" in call["patch"]
        report = result["report"]
        has_hits = report["denylist_hits"] > 0 or report["gitleaks"] == "hits"
        if report["gitleaks"] == "error":
            verdict = "error"
        elif result["clean"] == has_hits:
            verdict = "inconsistent"
        elif result["clean"] and report["gitleaks"] == "not-run":
            verdict = "skipped"
        elif result["clean"]:
            verdict = "clean"
        else:
            verdict = "dirty"
        evidence.append({
            "kind": "fix-instructions" if instructions else "full-source",
            "name": run + ("-instructions-scan.json" if instructions else "-secret-scan.json"),
            "patch_sha256": hashlib.sha256(call["patch"].encode()).hexdigest(),
            "patch_length": len(call["patch"]),
            "clean": result["clean"],
            "verdict": verdict,
            "report": report,
        })
    return evidence


def _show_calls(run_calls):
    """Convert `git show <sha>:<path>` argv to the TS seam's two arguments."""
    calls = []
    for argv in run_calls:
        if len(argv) == 3 and argv[:2] == ["git", "show"]:
            sha, _, path = argv[2].partition(":")
            calls.append([sha, path])
    return calls


def _handoff_args(inbox):
    """The recorded `Inbox.handoff` calls, without model or host state."""
    return [
        {
            "finding_id": call.args[0],
            "previous_task": call.args[1],
            "job_id": call.args[2].get("job"),
            "at": call.args[3],
        }
        for call in inbox.handoff.call_args_list
    ]


def _expected_inbox_reads(queue, canonical, pin, root):
    """The inbox ids `canonical_rounds` reads, in order, including misses."""
    reads = []
    if not canonical:
        return reads
    for item in queue["items"]:
        runs = item.get("repair_runs", {})
        if not isinstance(runs, dict):
            return reads
        for record in runs.values():
            if not isinstance(record, dict):
                return reads
            if record.get("pin") != pin:
                continue
            value = record.get("canonical_finding_id")
            for old_id in record.get("jobs", []):
                reads.append(old_id)
                old_path = root / "state" / "repair" / "inbox" / (old_id + ".json")
                if old_path.exists():
                    try:
                        value = json.loads(old_path.read_text()).get("canonical_finding_id") or value
                    except (OSError, ValueError):
                        return reads
                elif value is None and str(item.get("id", "")).startswith("backfill-finding-"):
                    return reads
                if value == canonical:
                    break
    return reads


def _triage_row(*, status="delivered", repair_task=None, extra=None):
    row = {
        "review_id": "1" * 64,
        "finding": {"id": CANONICAL},
        "canonical_id": CANONICAL,
        "previous_event_id": "event-1",
        "status": status,
        "receipt": {"repair_task": repair_task} if repair_task is not None else {},
    }
    row.update(extra or {})
    return row


class _Publication:
    """The minimal outbox `Inbox.handoff` uses."""

    def __init__(self):
        self.events = []

    def retained(self):
        return list(self.events)

    def spool(self, value):
        self.events.append(value)


def _dump(value):
    """The exact `crq_repair.atomic` bytes for a value."""
    return json.dumps(value, indent=2) + "\n"


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


def _queue_item(*, canonical=None, previous_round=False, previous_record_canonical=True):
    runs = {
        OLD_RUN: {
            "jobs": [OLD],
            "base": HISTORICAL,
            "pin": HISTORICAL,
            "state": "queued",
        }
    }
    if previous_round:
        previous = {
            "jobs": ["crq-previous-F1"],
            "base": SOURCE,
            "pin": SOURCE,
            "state": "done",
        }
        if previous_record_canonical:
            previous["canonical_finding_id"] = canonical
        runs["revalidated-previous"] = previous
    item = {
        "id": ITEM,
        "pr": 1,
        "kind": "merged",
        "state": "done",
        "repair_runs": runs,
    }
    if canonical is not None:
        item["canonical_finding_id"] = canonical
    return item


def _evidence(finding, **overrides):
    value = {
        "source_sha": SOURCE,
        "source_blob_sha": BLOB,
        "finding_sha256": identity(finding),
        "verdict": "still-valid",
        "reviewer": "independent-test-reviewer",
        "reason": "Pinned source retains the unstable initialization metadata comparison.",
    }
    value.update(overrides)
    return value


def _round_count(queue, item, canonical, root=None):
    """The production round count for this pin, with its existing basis."""
    if canonical:
        from finding_delivery import canonical_rounds
        return {
            "basis": "canonical-finding",
            "count": canonical_rounds(root or Path("/unused"), queue, canonical, SOURCE),
        }
    history = [
        record
        for candidate in queue["items"]
        if candidate.get("pr") == item.get("pr")
        for record in candidate.get("repair_runs", {}).values()
    ]
    return {
        "basis": "pr-pin",
        "count": sum(record.get("pin") == SOURCE for record in history),
    }


class _Root:
    """The minimal `crq_repair` service surface `prepare_current_job` uses."""

    def __init__(self, root, max_rounds, *, scan_spec=None, source_text=PINNED_SOURCE,
                 show_error=False):
        self.ROOT = root
        self.STATE = root / "state"
        self.CLONE = Path("/unused")
        self.CONFIG = {
            "clone": "/unused",
            "repair": {"max_rounds_per_pin": max_rounds},
        }
        self.iso = lambda: ISO
        self.run_calls = []
        self.scan_calls = []
        self.scan_results = []
        self.scan_spec = scan_spec or {}
        self.source_text = source_text
        self.show_error = show_error

    def run(self, argv, **kwargs):
        self.run_calls.append(list(argv))
        if self.show_error:
            raise RuntimeError("git show failed: synthetic")
        return SimpleNamespace(stdout=self.source_text)

    def secret_scan_diff(self, patch, path, **kwargs):
        self.scan_calls.append({"patch": patch, "path": Path(path).name})
        kind = "instructions" if "crq-fix-instructions.txt" in patch else "source"
        spec = self.scan_spec.get(kind, {})
        if spec.get("error"):
            self.scan_results.append({"kind": kind, "error": True})
            raise RuntimeError("secret scan unavailable: synthetic")
        clean = bool(spec.get("clean", True))
        report = spec.get("report") or {
            "denylist_rules": 0,
            "denylist_hits": 0,
            "gitleaks": "clean",
            "gitleaks_hits": 0,
        }
        self.scan_results.append({"kind": kind, "clean": clean, "report": report})
        return clean, report

    def save_queue(self, queue):
        atomic(self.ROOT / "state" / "queue.json", queue)


def _prepare_case(spec):
    """Run one prepare case in a temp root and record the oracle result."""
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        canonical = spec.get("canonical")
        old = _old_job(**(spec.get("old_overrides") or {}))
        if canonical is not None:
            old["canonical_finding_id"] = canonical
        queue = {"items": [_queue_item(canonical=canonical,
                                       previous_round=spec.get("previous_round", False))]}
        item = queue["items"][0]
        if "queue_item_overrides" in spec:
            item.update(spec["queue_item_overrides"])
        evidence = _evidence(old["finding"], **(spec.get("evidence_overrides") or {}))
        preserve = bool(spec.get("preserve_worktree", False))

        atomic(bounded.job_path(root, OLD), old)
        if canonical is not None and spec.get("previous_round"):
            atomic(bounded.job_path(root, "crq-previous-F1"),
                   _old_job(job="crq-previous-F1", run="revalidated-previous",
                            repair_base=SOURCE, canonical_finding_id=canonical))
        for name, value in (spec.get("extra_jobs") or {}).items():
            atomic(bounded.job_path(root, name), value)

        # Compute the production round count BEFORE the call mutates the queue.
        round_count = _round_count(queue, item, canonical, root)
        service = _Root(
            root,
            spec.get("max_rounds", 2),
            scan_spec=spec.get("scan_spec"),
            source_text=spec.get("source_text", PINNED_SOURCE),
            show_error=bool(spec.get("show_error")),
        )
        queue_before = _dump(queue)
        calls = []
        tip = spec.get("tip", SOURCE)
        blob = spec.get("blob", BLOB)
        path = old["finding"].get("path")

        def fake_git(clone, *args):
            calls.append(list(args))
            if args == ("rev-parse", "origin/main"):
                if spec.get("tip_error"):
                    raise RuntimeError("git rev-parse failed: synthetic")
                return tip
            if args == ("rev-parse", SOURCE + ":" + path):
                if spec.get("blob_error"):
                    raise RuntimeError("git rev-parse failed: synthetic")
                return blob
            raise AssertionError("unexpected git call: " + repr(args))

        inbox = mock.Mock() if canonical is not None else None
        patches = [mock.patch.object(bounded, "git", side_effect=fake_git)]
        if inbox is not None:
            patches.append(mock.patch.object(repair_tick, "finding_inbox", return_value=inbox))
        try:
            for patch in patches:
                patch.start()
            job_id = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence, preserve_worktree=preserve
            )
            job_bytes = bounded.job_path(root, job_id).read_bytes().decode()
            run = job_id[len("crq-"):-len("-F1")]
            record = queue["items"][0]["repair_runs"][run]
            record_bytes = _dump(record)
            job = json.loads(job_bytes)
            first_calls = copy.deepcopy(calls)
            first_run_calls = copy.deepcopy(service.run_calls)
            first_scan_calls = copy.deepcopy(service.scan_calls)
            first_scan_results = copy.deepcopy(service.scan_results)
            first_handoff = inbox.handoff.call_count if canonical is not None else 0
            first_handoff_args = _handoff_args(inbox) if canonical is not None else []
            queue_bytes = (root / "state" / "queue.json").read_text()
            # Idempotence: the second call returns the same id and does not
            # add a run or rewrite the job bytes.
            second = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence, preserve_worktree=preserve
            )
            idempotent_calls = calls[len(first_calls):]
            idempotent_bytes = bounded.job_path(root, job_id).read_bytes().decode()
            record_after = copy.deepcopy(queue["items"][0]["repair_runs"][run])
            second_handoff = inbox.handoff.call_count if canonical is not None else 0
            expected = {
                "ok": True,
                "job_id": job_id,
                "run": run,
                "finding_sha256": job["finding_sha256"],
                "revalidation_sha256": record["revalidation_sha256"],
                "job_bytes": job_bytes,
                "record_bytes": record_bytes,
                "git_calls": first_calls,
                "idempotent_git_calls": idempotent_calls,
                "second_job_id": second,
                "idempotent_job_bytes_unchanged": idempotent_bytes == job_bytes,
                "idempotent_record_unchanged": record_after == record,
                "recovery_worktree": job.get("recovery_worktree", False),
                "old_record_state": queue["items"][0]["repair_runs"][OLD_RUN]["state"],
                "run_count": len(queue["items"][0]["repair_runs"]),
                "scanned_names": sorted({Path(entry["path"]).name for entry in service.scan_calls}),
                "scanned_source_patch": any(
                    "+++ b/" + str(path) in entry["patch"]
                    for entry in service.scan_calls
                ),
                "scanned_instructions": any(
                    "crq-fix-instructions.txt" in entry["patch"]
                    for entry in service.scan_calls
                ),
                "full_source_read": any(
                    argv[:3] == ["git", "show", SOURCE + ":" + str(path)]
                    for argv in service.run_calls
                ),
                "show_calls": _show_calls(first_run_calls),
                "scan_calls": first_scan_calls,
                "scan_results": first_scan_results,
                "scan_evidence": _scan_evidence(first_scan_calls, first_scan_results, run),
                "queue_bytes": queue_bytes,
                "prepared_job_bytes": idempotent_bytes,
                "handoff_calls": first_handoff,
                "handoff_args": first_handoff_args,
                "idempotent_handoff_calls": second_handoff - first_handoff,
                "idempotent_handoff_args": (
                    _handoff_args(inbox)[first_handoff:] if canonical is not None else []
                ),
            }
            if spec.get("select_on_prepared"):
                try:
                    bounded.select_job(
                        root, service.CONFIG, job_id, SOURCE, job["finding_sha256"]
                    )
                    expected["python_select"] = {"ok": True}
                except Exception as exc:  # the production select gate refused
                    expected["python_select"] = {
                        "ok": False,
                        "error": type(exc).__name__,
                        "message": str(exc),
                    }
        except Exception as exc:  # the vector records the oracle's refusal
            expected = {
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
                "git_calls": calls,
                "old_job_bytes_unchanged": (
                    bounded.job_path(root, OLD).read_bytes()
                    == _dump(old).encode()
                ),
                "run_count": len(queue["items"][0]["repair_runs"]),
                "show_calls": _show_calls(service.run_calls),
                "scan_calls": copy.deepcopy(service.scan_calls),
                "scan_results": copy.deepcopy(service.scan_results),
                "handoff_calls": inbox.handoff.call_count if canonical is not None else 0,
                "handoff_args": _handoff_args(inbox) if canonical is not None else [],
                "queue_unchanged": _dump(queue) == queue_before,
            }
        finally:
            for patch in reversed(patches):
                patch.stop()

        expected["round_count"] = round_count
        return expected


def _prepare_gate_case(spec):
    """Run one read-gate prepare case: scans, lazy round reads and writes."""
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        canonical = spec.get("canonical")
        old = _old_job(**(spec.get("old_overrides") or {}))
        if canonical is not None:
            old["canonical_finding_id"] = canonical
        queue = {"items": [_queue_item(
            canonical=canonical,
            previous_round=spec.get("previous_round", False),
            previous_record_canonical=spec.get("previous_record_canonical", True),
        )]}
        if "queue_extra" in spec:
            queue.update(spec["queue_extra"])
        item = queue["items"][0]
        if "queue_item_overrides" in spec:
            item.update(spec["queue_item_overrides"])
        evidence = _evidence(old["finding"], **(spec.get("evidence_overrides") or {}))
        preserve = bool(spec.get("preserve_worktree", False))

        atomic(bounded.job_path(root, OLD), old)
        inbox_jobs = {}
        if (canonical is not None and spec.get("previous_round")
                and spec.get("write_previous_job", True)):
            previous = _old_job(
                job="crq-previous-F1",
                run="revalidated-previous",
                repair_base=SOURCE,
                canonical_finding_id=canonical,
            )
            atomic(bounded.job_path(root, "crq-previous-F1"), previous)
            inbox_jobs["crq-previous-F1"] = _dump(previous)
        for name, value in (spec.get("extra_jobs") or {}).items():
            atomic(bounded.job_path(root, name), value)
            inbox_jobs[name] = _dump(value)

        queue_before = _dump(queue)
        round_error = None
        try:
            round_count = _round_count(queue, item, canonical, root)
        except Exception as exc:  # the production round read refused
            round_count = None
            round_error = {"error": type(exc).__name__, "message": str(exc)}
        inbox_reads = _expected_inbox_reads(queue, canonical, SOURCE, root)

        service = _Root(
            root,
            spec.get("max_rounds", 2),
            scan_spec=spec.get("scan_spec"),
            source_text=spec.get("source_text", PINNED_SOURCE),
            show_error=bool(spec.get("show_error")),
        )
        calls = []
        path = old["finding"].get("path")
        tip = spec.get("tip", SOURCE)
        blob = spec.get("blob", BLOB)

        def fake_git(clone, *args):
            calls.append(list(args))
            if args == ("rev-parse", "origin/main"):
                if spec.get("tip_error"):
                    raise RuntimeError("git rev-parse failed: synthetic")
                return tip
            if args == ("rev-parse", SOURCE + ":" + path):
                if spec.get("blob_error"):
                    raise RuntimeError("git rev-parse failed: synthetic")
                return blob
            raise AssertionError("unexpected git call: " + repr(args))

        inbox = mock.Mock() if canonical is not None else None
        if inbox is not None and spec.get("handoff_error"):
            inbox.handoff.side_effect = ledger.IntegrityError(spec["handoff_error"])
        patches = [mock.patch.object(bounded, "git", side_effect=fake_git)]
        if inbox is not None:
            patches.append(mock.patch.object(repair_tick, "finding_inbox", return_value=inbox))
        try:
            for patch in patches:
                patch.start()
            job_id = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence, preserve_worktree=preserve
            )
            job_bytes = bounded.job_path(root, job_id).read_text()
            queue_bytes = (root / "state" / "queue.json").read_text()
            run = job_id[len("crq-"):-len("-F1")]
            record = queue["items"][0]["repair_runs"][run]
            first_calls = copy.deepcopy(calls)
            first_run_calls = copy.deepcopy(service.run_calls)
            first_scan_calls = copy.deepcopy(service.scan_calls)
            first_scan_results = copy.deepcopy(service.scan_results)
            first_handoff_args = _handoff_args(inbox) if canonical is not None else []
            expected = {
                "ok": True,
                "job_id": job_id,
                "run": run,
                "job_bytes": job_bytes,
                "record_bytes": _dump(record),
                "queue_bytes": queue_bytes,
                "old_record_error": queue["items"][0]["repair_runs"][OLD_RUN].get("error"),
                "old_record_state": queue["items"][0]["repair_runs"][OLD_RUN].get("state"),
                "git_calls": first_calls,
                "show_calls": _show_calls(first_run_calls),
                "scan_calls": first_scan_calls,
                "scan_results": first_scan_results,
                "scan_evidence": _scan_evidence(first_scan_calls, first_scan_results, run),
                "round_count": round_count,
                "round_count_error": round_error,
                "inbox_reads": inbox_reads,
                "inbox_jobs": inbox_jobs,
                "handoff_calls": len(first_handoff_args),
                "handoff_args": first_handoff_args,
            }
            second = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence, preserve_worktree=preserve
            )
            expected["second_job_id"] = second
            expected["idempotent_handoff_calls"] = (
                inbox.handoff.call_count - len(first_handoff_args)
                if canonical is not None else 0
            )
            expected["idempotent_handoff_args"] = (
                _handoff_args(inbox)[len(first_handoff_args):]
                if canonical is not None else []
            )
            expected["idempotent_job_bytes_unchanged"] = (
                bounded.job_path(root, job_id).read_text() == job_bytes
            )
            expected["idempotent_queue_bytes_unchanged"] = (
                (root / "state" / "queue.json").read_text() == queue_bytes
            )
            expected["prepared_job_bytes"] = bounded.job_path(root, job_id).read_text()
        except Exception as exc:  # the vector records the oracle's refusal
            expected = {
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
                "git_calls": calls,
                "show_calls": _show_calls(service.run_calls),
                "scan_calls": copy.deepcopy(service.scan_calls),
                "scan_results": copy.deepcopy(service.scan_results),
                "handoff_calls": inbox.handoff.call_count if canonical is not None else 0,
                "handoff_args": _handoff_args(inbox) if canonical is not None else [],
                "old_job_bytes_unchanged": (
                    bounded.job_path(root, OLD).read_bytes() == _dump(old).encode()
                ),
                "queue_unchanged": _dump(queue) == queue_before,
                "round_count": round_count,
                "round_count_error": round_error,
                "inbox_reads": inbox_reads,
                "inbox_jobs": inbox_jobs,
            }
        finally:
            for patch in reversed(patches):
                patch.stop()

        expected["name"] = spec["name"]
        expected["input"] = {
            "old_job_id": OLD,
            "old_job_json": _dump(old),
            "queue_json": queue_before,
            "source_sha": SOURCE,
            "evidence_json": _dump(evidence),
            "source_text": spec.get("source_text", PINNED_SOURCE),
            "show_error": bool(spec.get("show_error")),
            "current_tip": spec.get("tip", SOURCE),
            "blob_oid": spec.get("blob", BLOB),
            "max_rounds_per_pin": spec.get("max_rounds", 2),
            "preserve_worktree": preserve,
        }
        if "ts_refusal" in spec:
            expected["ts_refusal"] = spec["ts_refusal"]
        return expected


def _harvest_case(name, prepared, result, *, allow_legacy):
    """Run production `repair_tick.harvest` for one result artifact."""
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        job_id = prepared["job"]
        run = job_id[len("crq-"):-len("-F1")]
        item = _queue_item()
        item["repair_runs"][run] = {
            "jobs": [job_id],
            "base": SOURCE,
            "pin": SOURCE,
            "state": "queued",
        }
        queue = {"items": [item]}
        atomic(bounded.job_path(root, job_id), prepared)
        atomic(root / "state" / "repair" / job_id / "result.json", result)
        service = SimpleNamespace(
            ROOT=root,
            STATE=root / "state",
            CONFIG={"repair": {}},
            iso=lambda: ISO,
        )
        repair_tick.harvest(service, queue, item)
        record = item["repair_runs"][run]
        return {
            "name": name,
            "prepared_json": _dump(prepared),
            "result_json": _dump(result),
            "allow_missing_prepared_source_sha": allow_legacy,
            "expect": {
                "accepted": record.get("state") in ("ready", "done"),
                "state": record.get("state"),
                "error": record.get("error"),
            },
        }


def build():
    """Build the whole deterministic oracle document."""
    prepare_specs = [
        {"name": "major-no-instructions"},
        {"name": "major-with-instructions",
         "evidence_overrides": {"fix_instructions": "Keep both sources and add an order regression test."}},
        {"name": "preserve-worktree", "preserve_worktree": True},
        {"name": "canonical-minor-round-one", "canonical": CANONICAL,
         "previous_round": True,
         "old_overrides": {"finding": {
             "path": "src/lock.ts", "line": 2, "severity": "minor",
             "body": "Finding data", "id": "thread-1"}}},
        {"name": "lossless-extras",
         "evidence_overrides": {
             "extra": {
                 "float": 1.0,
                 "unicode": "\U0001f642",
                 "big": 12345678901234567890,
                 "nested": [True, None, {"z": 0, "a": 1}],
             }
         }},
        {"name": "non-bmp-reviewer-and-instructions",
         "evidence_overrides": {
             "reviewer": "\U0001f642" * 3,
             "fix_instructions": "\U0001f642" * 2000,
         }},
        # Refusals, in the Python validation order.
        {"name": "refuse-old-job-identity",
         "old_overrides": {"job": "crq-other-F1"}},
        {"name": "refuse-source-sha-invalid", "source_sha": "not-a-sha"},
        {"name": "refuse-source-not-tip", "tip": OTHER},
        {"name": "refuse-tip-unreadable", "tip_error": True},
        {"name": "refuse-legacy-minor", "old_overrides": {"finding": {
            "path": "src/lock.ts", "line": 2, "severity": "minor",
            "body": "Finding data", "id": "thread-1"}}},
        {"name": "refuse-path-absolute", "old_overrides": {"finding": {
            "path": "/etc/file", "line": 2, "severity": "major",
            "body": "Finding data", "id": "thread-1"}}},
        {"name": "refuse-blob-mismatch", "blob": OTHER_BLOB},
        {"name": "refuse-blob-unreadable", "blob_error": True},
        {"name": "refuse-finding-digest", "evidence_overrides": {"finding_sha256": OTHER}},
        {"name": "refuse-verdict", "evidence_overrides": {"verdict": "superseded"}},
        {"name": "refuse-reviewer-empty", "evidence_overrides": {"reviewer": ""}},
        {"name": "refuse-reason-too-long", "evidence_overrides": {"reason": "x" * 4001}},
        {"name": "refuse-instructions-empty",
         "evidence_overrides": {"fix_instructions": ""}},
        {"name": "refuse-instructions-too-long",
         "evidence_overrides": {"fix_instructions": "x" * 2001}},
        {"name": "refuse-instructions-nul",
         "evidence_overrides": {"fix_instructions": "bad\x00text"}},
        {"name": "refuse-round-ceiling", "previous_round": True, "max_rounds": 1},
        {"name": "refuse-lineage-missing",
         "queue_item_overrides": {"repair_runs": {}}},
        # A PRESENT invalid canonical identity: Python preparation writes the
        # job (truthiness skips the handoff), then Python selection refuses it
        # via require_canonical_delivery. This slice fails closed instead of
        # proposing a job Python cannot select.
        {"name": "refuse-canonical-id-invalid", "canonical": "",
         "select_on_prepared": True,
         "ts_refusal": "canonical-finding-id-invalid"},
    ]

    # Case-specific source sha override for the grammar refusal.
    for spec in prepare_specs:
        if spec["name"] == "refuse-source-sha-invalid":
            spec["source_override"] = spec["source_sha"]

    prepare_cases = []
    for spec in prepare_specs:
        source_sha = spec.get("source_override", SOURCE)
        # The shared runner uses SOURCE; the grammar case is separated below.
        if source_sha != SOURCE:
            expected = _prepare_source_grammar_case(spec)
        else:
            expected = _prepare_case(spec)
        expected["name"] = spec["name"]
        expected["input"] = _prepare_input(spec, expected["round_count"])
        if "ts_refusal" in spec:
            expected["ts_refusal"] = spec["ts_refusal"]
        prepare_cases.append(expected)

    # Harvest cases use one accepted prepared job and vary the artifact.
    prepared = next(case for case in prepare_cases if case["name"] == "major-no-instructions")
    prepared_job = json.loads(prepared["job_bytes"])
    prepared_job["job"] = "crq-revalidated-harvest-F1"
    prepared_job["run"] = "revalidated-harvest"

    base_result = {
        "job": prepared_job["job"],
        "item": prepared_job["item"],
        "repair_base": SOURCE,
        "source_sha": SOURCE,
        "finding_sha256": prepared_job["finding_sha256"],
        "origin_job": prepared_job["origin_job"],
        "verdict": "NOT-FIXED",
        "reason": "No change warranted",
        "commits": [],
        "attempts": [],
        "judge": None,
        "started_at": ISO,
    }
    harvest_cases = [
        _harvest_case("legacy-match", prepared_job, base_result, allow_legacy=False),
        _harvest_case("legacy-source-sha-mismatch", prepared_job,
                      {**base_result, "source_sha": OTHER}, allow_legacy=False),
        _harvest_case("legacy-finding-sha-mismatch", prepared_job,
                      {**base_result, "finding_sha256": OTHER}, allow_legacy=False),
        _harvest_case("legacy-origin-job-mismatch", prepared_job,
                      {**base_result, "origin_job": "crq-other-F1"}, allow_legacy=False),
        _harvest_case("legacy-result-job-mismatch", prepared_job,
                      {**base_result, "job": "crq-other-F1"}, allow_legacy=False),
        # Python's legacy skip is unconditional; the TS check requires the
        # explicit caller opt-in (covered separately by the TS test).
        _harvest_case("legacy-missing-prepared-source-sha", 
                      {**prepared_job, "source_sha": None},
                      {**base_result, "source_sha": OTHER}, allow_legacy=True),
    ]

    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/crq_repair/bounded.py + repair_tick.prepare_current_job",
        "prepare_cases": prepare_cases,
        "harvest_cases": harvest_cases,
        "gate_cases": _gate_cases(),
        "round_cases": _round_cases(),
        "delivery_cases": _delivery_cases(),
        "handoff_cases": _handoff_cases(),
        "allowlist_cases": _allowlist_cases(),
        "patch_cases": _patch_cases(),
        "path_cases": _path_cases(),
    }


def _prepare_input(spec, round_count=None):
    old = _old_job(**(spec.get("old_overrides") or {}))
    canonical = spec.get("canonical")
    if canonical is not None:
        old["canonical_finding_id"] = canonical
    queue = {"items": [_queue_item(canonical=canonical,
                                   previous_round=spec.get("previous_round", False))]}
    if "queue_item_overrides" in spec:
        queue["items"][0].update(spec["queue_item_overrides"])
    evidence = _evidence(old["finding"], **(spec.get("evidence_overrides") or {}))
    return {
        "old_job_id": OLD,
        "old_job_json": _dump(old),
        "queue_item_json": _dump(queue["items"][0]),
        "source_sha": spec.get("source_override", SOURCE),
        "evidence_json": _dump(evidence),
        "current_tip": spec.get("tip", SOURCE),
        "blob_oid": spec.get("blob", BLOB),
        "round_count": (
            round_count
            if round_count is not None
            else _round_count(queue, queue["items"][0], canonical)
        ),
        "max_rounds_per_pin": spec.get("max_rounds", 2),
        "preserve_worktree": bool(spec.get("preserve_worktree", False)),
    }


def _prepare_source_grammar_case(spec):
    """Python refuses a malformed source sha before any git read."""
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        old = _old_job()
        queue = {"items": [_queue_item()]}
        evidence = _evidence(old["finding"])
        atomic(bounded.job_path(root, OLD), old)
        service = _Root(root, spec.get("max_rounds", 2))
        calls = []

        def fake_git(clone, *args):
            calls.append(list(args))
            return SOURCE

        with mock.patch.object(bounded, "git", side_effect=fake_git):
            try:
                repair_tick.prepare_current_job(
                    service, queue, OLD, spec["source_override"], evidence
                )
                expected = {"ok": True, "git_calls": calls}
            except Exception as exc:
                expected = {
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": str(exc),
                    "git_calls": calls,
                    "old_job_bytes_unchanged": (
                        bounded.job_path(root, OLD).read_bytes() == _dump(old).encode()
                    ),
                    "run_count": len(queue["items"][0]["repair_runs"]),
                }
        expected["round_count"] = {"basis": "pr-pin", "count": 0}
        return expected


def _round_cases():
    """Production `canonical_rounds` and the PR-pin history count."""
    import tempfile
    cases = []

    def run(name, queue, canonical, setup):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inbox_jobs = setup(root) or {}
            reads = _expected_inbox_reads(queue, canonical, SOURCE, root)
            try:
                result = _round_count(queue, queue["items"][0], canonical, root)
                cases.append({
                    "name": name,
                    "queue_json": _dump(queue),
                    "canonical": canonical,
                    "pin": SOURCE,
                    "ok": True,
                    "basis": result["basis"],
                    "count": result["count"],
                    "inbox_reads": reads,
                    "inbox_jobs": inbox_jobs,
                })
            except Exception as exc:
                cases.append({
                    "name": name,
                    "queue_json": _dump(queue),
                    "canonical": canonical,
                    "pin": SOURCE,
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": str(exc),
                    "inbox_reads": reads,
                    "inbox_jobs": inbox_jobs,
                })

    def no_inbox(root):
        return {}

    def inbox(name, canonical):
        def write(root):
            path = root / "state" / "repair" / "inbox" / (name + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            text = _dump({"job": name, "canonical_finding_id": canonical})
            path.write_text(text, encoding="utf-8")
            return {name: text}
        return write

    def unreadable(name):
        def write(root):
            path = root / "state" / "repair" / "inbox" / (name + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{", encoding="utf-8")
            return {name: "{"}
        return write

    run("pr-pin-two", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE},
            "b": {"pin": SOURCE},
        }},
        {"id": "other-pr", "pr": 2, "repair_runs": {"c": {"pin": SOURCE}}},
    ]}, None, no_inbox)
    run("pr-pin-none", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {"a": {"pin": OTHER}}},
    ]}, None, no_inbox)
    run("canonical-record", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "canonical_finding_id": CANONICAL, "jobs": [OLD]},
        }},
    ]}, CANONICAL, inbox(OLD, CANONICAL))
    run("canonical-inbox-fallback", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "jobs": [OLD]},
        }},
    ]}, CANONICAL, inbox(OLD, CANONICAL))
    run("canonical-inbox-overrides", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "canonical_finding_id": OTHER, "jobs": [OLD]},
        }},
    ]}, CANONICAL, inbox(OLD, CANONICAL))
    run("canonical-no-match", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "canonical_finding_id": OTHER, "jobs": [OLD]},
        }},
    ]}, CANONICAL, inbox(OLD, OTHER))
    run("canonical-missing-jobs", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "canonical_finding_id": CANONICAL},
        }},
    ]}, CANONICAL, no_inbox)
    run("canonical-other-pin", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": OTHER, "canonical_finding_id": CANONICAL, "jobs": [OLD]},
        }},
    ]}, CANONICAL, no_inbox)
    run("canonical-backfill-missing", {"items": [
        {"id": "backfill-finding-1", "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "jobs": [OLD]},
        }},
    ]}, CANONICAL, no_inbox)
    run("canonical-backfill-falsy", {"items": [
        {"id": "backfill-finding-1", "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "canonical_finding_id": "", "jobs": [OLD]},
        }},
    ]}, CANONICAL, no_inbox)
    run("canonical-unreadable-inbox", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {
            "a": {"pin": SOURCE, "jobs": [OLD]},
        }},
    ]}, CANONICAL, unreadable(OLD))
    run("canonical-non-object-record", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": {"a": []}},
    ]}, CANONICAL, no_inbox)
    run("canonical-non-object-runs", {"items": [
        {"id": ITEM, "pr": 1, "repair_runs": []},
    ]}, CANONICAL, no_inbox)
    return cases


def _delivery_cases():
    """Production `bounded.require_canonical_delivery` outcomes."""
    import tempfile

    cases = []
    job = {"job": "crq-prepared-F1", "canonical_finding_id": CANONICAL}

    def run(name, job_value, row_text, present=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if present:
                path = root / "state/backfill/findings/triage" / (CANONICAL + ".json")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(row_text, encoding="utf-8")
            try:
                bounded.require_canonical_delivery(root, job_value)
                cases.append({
                    "name": name,
                    "job_json": _dump(job_value),
                    "row_json": row_text if present else None,
                    "present": present,
                    "ok": True,
                })
            except Exception as exc:
                cases.append({
                    "name": name,
                    "job_json": _dump(job_value),
                    "row_json": row_text if present else None,
                    "present": present,
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": str(exc),
                })

    delivered = _triage_row(status="delivered", repair_task="crq-prepared-F1")
    run("delivered", job, _dump(delivered))
    run("legacy-no-canonical", {"job": "crq-prepared-F1"}, None, present=False)
    run("invalid-id", {"job": "crq-prepared-F1", "canonical_finding_id": "bad"}, None, present=False)
    run("missing-row", job, None, present=False)
    run("unreadable-row", job, "{")
    run("not-delivered", job, _dump(_triage_row(status="triaged", repair_task="crq-prepared-F1")))
    run("wrong-owner", job, _dump(_triage_row(status="delivered", repair_task="crq-other-F1")))
    run("non-object-row", job, "[]")
    run("duplicate-key", job,
        '{"status":"triaged","status":"delivered","receipt":{"repair_task":"crq-prepared-F1"}}')
    run("float-value", job, _dump({**delivered, "extra": 1.0}))
    return cases


def _handoff_cases():
    """Production `Inbox.handoff` preconditions against a temp triage row."""
    import tempfile

    cases = []
    job = {"job": "crq-prepared-F1", "canonical_finding_id": CANONICAL, "origin_job": OLD}

    def run(name, job_value, row_text, present=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state/backfill/findings"
            (root / "triage").mkdir(parents=True)
            if present:
                (root / "triage" / (CANONICAL + ".json")).write_text(row_text, encoding="utf-8")
            publication = _Publication()
            inbox = Inbox(root, publication)
            try:
                inbox.handoff(CANONICAL, OLD, job_value, ISO)
                after = json.loads((root / "triage" / (CANONICAL + ".json")).read_text())
                cases.append({
                    "name": name,
                    "job_json": _dump(job_value),
                    "row_json": row_text if present else None,
                    "present": present,
                    "ok": True,
                    "already_handed_off": not publication.events,
                    "spooled": len(publication.events),
                    "status": after.get("status"),
                    "receipt_repair_task": after.get("receipt", {}).get("repair_task"),
                })
            except Exception as exc:
                message = "missing triage row" if isinstance(exc, FileNotFoundError) else str(exc)
                cases.append({
                    "name": name,
                    "job_json": _dump(job_value),
                    "row_json": row_text if present else None,
                    "present": present,
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": message,
                    "spooled": len(publication.events),
                })

    run("old-owner", job, _dump(_triage_row(status="triaged", repair_task=OLD)))
    run("already-prepared", job, _dump(_triage_row(status="delivered", repair_task="crq-prepared-F1")))
    run("owner-mismatch", job, _dump(_triage_row(status="triaged", repair_task="crq-other-F1")))
    run("identity-mismatch", {**job, "canonical_finding_id": OTHER},
        _dump(_triage_row(status="triaged", repair_task=OLD)))
    run("legacy-missing-canonical", {"job": "crq-prepared-F1", "origin_job": OLD},
        _dump(_triage_row(status="triaged", repair_task=OLD)))
    run("missing-row", job, None, present=False)
    run("unreadable-row", job, "{")
    return cases


def _allowlist_cases():
    """`crq.ALLOWLIST_PATHS` decisions for representative paths."""
    paths = [
        ".git/config", "a/.git/config", "node_modules/x", "a/node_modules/x",
        "dist/x", "a/dist/x", ".gjc/x", "a/.gjc/x", ".DS_Store", "a/.DS_Store",
        "policy/denylist/patterns.yml", "a/policy/denylist/patterns.yml",
        "src/lock.ts", "a/.gitignore", "a/distx/file", "a/node_modulesx/file",
    ]
    return [
        {"path": path, "allow": any(re.search(pattern, path) for pattern in crq.ALLOWLIST_PATHS)}
        for path in paths
    ]


def _patch_cases():
    """Exact scan-patch bytes for edge source and instruction texts."""
    texts = [
        "", "a", "a\n", "a\nb", "a\r\nb\r\n", "a\vb\fc\x1cd\x85e\u2028f\u2029g",
        "\n\n", "a\r", "a\U0001f642b",
    ]
    return {
        "source": [
            {"path": "src/lock.ts", "text": text,
             "patch": _full_source_patch("src/lock.ts", text)}
            for text in texts
        ],
        "instructions": [
            {"text": text, "patch": _instructions_patch(text)}
            for text in texts
        ],
    }


def _gate_cases():
    """Prepare cases that exercise the read gates and the exact writes."""
    clean = {"denylist_rules": 0, "denylist_hits": 0, "gitleaks": "clean", "gitleaks_hits": 0}
    not_run = {"denylist_rules": 0, "denylist_hits": 0, "gitleaks": "not-run", "gitleaks_hits": 0}
    denylist = {"denylist_rules": 1, "denylist_hits": 1, "gitleaks": "clean", "gitleaks_hits": 0}
    gitleaks = {"denylist_rules": 0, "denylist_hits": 0, "gitleaks": "hits", "gitleaks_hits": 1}
    gitleaks_error = {"denylist_rules": 0, "denylist_hits": 0, "gitleaks": "error", "gitleaks_hits": 0}
    minor = {"finding": {
        "path": "src/lock.ts", "line": 2, "severity": "minor",
        "body": "Finding data", "id": "thread-1",
    }}
    instructions = {"fix_instructions": "Keep both sources and add an order regression test."}
    specs = [
        {"name": "scan-clean-source-only"},
        {"name": "scan-clean-with-instructions", "evidence_overrides": instructions},
        {"name": "scan-not-run", "scan_spec": {"source": {"clean": True, "report": not_run}}},
        {"name": "scan-denylist-dirty",
         "scan_spec": {"source": {"clean": False, "report": denylist}},
         "ts_refusal": "source-secret-scan-failed"},
        {"name": "scan-gitleaks-dirty",
         "scan_spec": {"source": {"clean": False, "report": gitleaks}},
         "ts_refusal": "source-secret-scan-failed"},
        {"name": "scan-gitleaks-error",
         "scan_spec": {"source": {"clean": False, "report": gitleaks_error}},
         "ts_refusal": "secret-scan-unavailable"},
        {"name": "scan-instructions-dirty",
         "evidence_overrides": instructions,
         "scan_spec": {"instructions": {"clean": False, "report": denylist}},
         "ts_refusal": "instructions-secret-scan-failed"},
        {"name": "scan-instructions-not-run",
         "evidence_overrides": instructions,
         "scan_spec": {"instructions": {"clean": True, "report": not_run}}},
        {"name": "scan-unavailable",
         "scan_spec": {"source": {"error": True}},
         "ts_refusal": "secret-scan-unavailable"},
        {"name": "show-unavailable", "show_error": True,
         "ts_refusal": "source-read-unavailable"},
        {"name": "show-empty-source", "source_text": ""},
        {"name": "show-crlf-source", "source_text": "a\r\nb\r\n"},
        {"name": "preserve-worktree-stale", "preserve_worktree": True},
        {"name": "legacy-round-pr-pin",
         "queue_item_overrides": {"repair_runs": {
             OLD_RUN: {"jobs": [OLD], "base": HISTORICAL, "pin": HISTORICAL, "state": "queued"},
             "previous": {"jobs": ["crq-previous-F1"], "base": SOURCE, "pin": SOURCE, "state": "done"},
         }}},
        {"name": "canonical-handoff-old-owner", "canonical": CANONICAL,
         "previous_round": True, "old_overrides": minor, "handoff_owner": "old"},
        {"name": "canonical-handoff-prepared-owner", "canonical": CANONICAL,
         "previous_round": True, "old_overrides": minor, "handoff_owner": "prepared"},
        {"name": "canonical-round-inbox-fallback", "canonical": CANONICAL,
         "previous_round": True, "previous_record_canonical": False,
         "old_overrides": minor},
        {"name": "canonical-round-backfill-missing", "canonical": CANONICAL,
         "previous_round": True, "previous_record_canonical": False,
         "write_previous_job": False, "old_overrides": {**minor, "item": "backfill-finding-1"},
         "queue_item_overrides": {"id": "backfill-finding-1"},
         "ts_refusal": "round-history-unreadable"},
        {"name": "canonical-handoff-unavailable", "canonical": CANONICAL,
         "previous_round": True, "old_overrides": minor,
         "handoff_error": "canonical finding row is unreadable",
         "ts_refusal": "canonical-handoff-unavailable"},
        {"name": "canonical-handoff-mismatch", "canonical": CANONICAL,
         "previous_round": True, "old_overrides": minor,
         "handoff_error": "prepared retry no longer owns canonical finding",
         "ts_refusal": "canonical-handoff-mismatch"},
        {"name": "canonical-round-ceiling", "canonical": CANONICAL,
         "previous_round": True, "old_overrides": minor, "max_rounds": 1,
         "ts_refusal": "round-ceiling"},
        {"name": "lossless-queue",
         "queue_extra": {"repair_own_commits": [], "meta": {"float": 1.0, "big": 12345678901234567890}},
         "queue_item_overrides": {"extra": {"z": 0, "a": 1}}},
    ]
    cases = []
    for spec in specs:
        case = _prepare_gate_case(spec)
        if "handoff_owner" in spec:
            case["handoff_owner"] = spec["handoff_owner"]
        cases.append(case)
    return cases


def _path_cases():
    values = [
        "a", "a/", "a//b", "a/./b", "./a", ".", "", "/abs", "../x",
        "a/../b", "a/..", "a/b/", "a\\b", 'a"b', "a\tb", "\u00e9/x",
        "a/././b", "a//", "//a", "a/b//",
    ]
    cases = []
    for value in values:
        try:
            cases.append({"input": value, "ok": True, "path": bounded.source_path({"path": value})})
        except Exception as exc:
            cases.append({"input": value, "ok": False, "message": str(exc)})
    return cases


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Emit the repair-prepare oracle fixture")
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
        print("repair-prepare fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
