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
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import repair_tick
from crq_repair import atomic, bounded

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


def _queue_item(*, canonical=None, previous_round=False):
    runs = {
        OLD_RUN: {
            "jobs": [OLD],
            "base": HISTORICAL,
            "pin": HISTORICAL,
            "state": "queued",
        }
    }
    if previous_round:
        runs["revalidated-previous"] = {
            "jobs": ["crq-previous-F1"],
            "base": SOURCE,
            "pin": SOURCE,
            "state": "done",
            "canonical_finding_id": canonical,
        }
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


def _round_count(queue, item, canonical):
    """The production round count for this pin, with its existing basis."""
    if canonical is not None:
        from finding_delivery import canonical_rounds
        return {
            "basis": "canonical-finding",
            "count": canonical_rounds(Path("/unused"), queue, canonical, SOURCE),
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

    def __init__(self, root, max_rounds):
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

    def run(self, argv, **kwargs):
        self.run_calls.append(list(argv))
        return SimpleNamespace(stdout=PINNED_SOURCE)

    def secret_scan_diff(self, patch, path, **kwargs):
        self.scan_calls.append({"patch": patch, "path": str(path)})
        return True, {}

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
        round_count = _round_count(queue, item, canonical)
        service = _Root(root, spec.get("max_rounds", 2))
        calls = []
        tip = spec.get("tip", SOURCE)
        blob = spec.get("blob", BLOB)
        path = old["finding"].get("path")

        def fake_git(clone, *args):
            calls.append(list(args))
            if args == ("rev-parse", "origin/main"):
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
            # Idempotence: the second call returns the same id and does not
            # add a run or rewrite the job bytes.
            second = repair_tick.prepare_current_job(
                service, queue, OLD, SOURCE, evidence, preserve_worktree=preserve
            )
            idempotent_calls = calls[len(first_calls):]
            idempotent_bytes = bounded.job_path(root, job_id).read_bytes().decode()
            record_after = copy.deepcopy(queue["items"][0]["repair_runs"][run])
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
            }
            if canonical is not None:
                expected["handoff_calls"] = inbox.handoff.call_count
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
            }
        finally:
            for patch in reversed(patches):
                patch.stop()

        expected["round_count"] = round_count
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
        expected["input"] = _prepare_input(spec)
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
        "path_cases": _path_cases(),
    }


def _prepare_input(spec):
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
        "round_count": _round_count(
            queue, queue["items"][0], canonical
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
