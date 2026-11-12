#!/usr/bin/env python3
"""Deterministic offline oracle for the TS repair selection port.

Test tooling only. It imports the PRODUCTION ``crq_repair.bounded`` helpers
``select_job``, ``drain_order`` and ``drain_job`` and records what Python
actually decides: inbox ordering (mtime then name), the drain's run/stale/skip
classification with its exact message, the explicit selector's accepted job or
refusal, and the exact ordered Git reads each decision performed.

Every external effect is injected: ``bounded.git`` and ``bounded.command``
answer from a recorded map, inbox/queue/triage files live in a throwaway temp
directory, and ``started`` is a real result/progress file. No production
module is modified and no production repository, queue, state, network, model,
signer or host service is touched.

The TypeScript test replays the same injected facts through the pure port and
compares the canonical result bytes and the Git read order. Python refusal
messages are mapped to the port's typed refusal codes by ``_refusal``; an
unmapped message aborts generation so a new Python branch cannot pass silently.

Regenerate with ``python3 repair_selection_vectors.py --write`` and verify with
``python3 repair_selection_vectors.py --check``. Output is deterministic:
sorted keys, ``ensure_ascii``, no timestamps or host paths.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from crq_repair import bounded
from runtime_target import DEFAULT_REF

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-repair-selection" / "cases.json"
SCHEMA = "cq.crq-repair-selection-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair/bounded.py"
CONFIG = {"clone": "/unused"}

PIN = "a" * 40
TIP = "b" * 40
BLOB = "c" * 40
OTHER_BLOB = "d" * 40
BRANCH_HEAD = "e" * 40
CANONICAL = "f" * 64
ORIGIN = "crq-origin-F1"
OLD = "crq-run1-F1"
RUN = "run1"
ITEM = "pr1-merged"
PREPARED_JOB = "crq-revalidated-fixture-F1"
PREPARED_RUN = "revalidated-fixture"

# Python refusal message -> the port's typed refusal. ``None`` is a run.
REFUSALS = {
    "full immutable source SHA required": "source-sha-invalid",
    "expected one exact CRQ job id": "job-id-invalid",
    "job path outside inbox": "job-path-invalid",
    "job identity/source pin mismatch; historical jobs cannot be repinned": "job-identity-mismatch",
    "finding evidence digest mismatch": "finding-digest-mismatch",
    "invalid canonical finding identity": "canonical-delivery-invalid",
    "canonical delivery state unavailable": "canonical-delivery-unavailable",
    "canonical finding is not delivered to this repair task": "canonical-delivery-mismatch",
    "source SHA is not the observed current default-branch tip": "prepared-source-not-tip",
    "prepared source is no longer the default-branch tip": "prepared-source-not-tip",
    "only critical/major or canonical minor findings can be prepared": "severity-not-repairable",
    "only critical/major or canonical minor findings are repaired": "severity-not-repairable",
    "finding path required": "finding-path-invalid",
    "finding path must be repository-relative": "finding-path-invalid",
    "revalidation does not bind source, finding, blob and verdict": "evidence-binding-mismatch",
    "named revalidation reviewer and concrete reason required": "evidence-text-invalid",
    "prepared job must preserve historical finding lineage": "origin-job-missing",
    "selected job lacks matching queued tick-owned preparation": "no-queued-run",
    "selected job revalidation lineage mismatch": "revalidation-lineage-mismatch",
    "job identity mismatch": "job-identity-mismatch",
    "no queued tick-owned repair run": "no-queued-run",
    "job pin differs from its tick-owned repair run": "pin-record-mismatch",
    "pinned source path missing": "pinned-path-missing",
    "finding path is absent at the job pin": "pinned-path-absent",
    "reviewed PR head is already on the default branch": "pr-head-on-default",
    "PR branch is gone from origin (closed or deleted)": "pr-branch-gone",
    "PR branch changed the finding source since the pin": "pr-branch-source-changed",
    "finding source changed on the default branch since the pin": "default-source-changed",
}
PREFIX_REFUSALS = (
    ("unreadable job: ", "job-unreadable"),
    ("malformed job: ", "selection-malformed"),
)


def _refusal(message: str) -> str | None:
    if message == "":
        return None
    if message in REFUSALS:
        return REFUSALS[message]
    for prefix, code in PREFIX_REFUSALS:
        if message.startswith(prefix):
            return code
    raise AssertionError("unmapped Python refusal: " + message)


def _error_refusal(exc: BaseException) -> str:
    if isinstance(exc, FileNotFoundError):
        return "job-unreadable"
    if isinstance(exc, json.JSONDecodeError):
        return "job-unreadable"
    if isinstance(exc, ValueError):
        return _refusal(str(exc))  # type: ignore[return-value]
    if isinstance(exc, OSError):
        return "job-unreadable"
    raise AssertionError("unmapped Python error: " + type(exc).__name__)


def _dump(value) -> str:
    """The on-disk bytes. Sorted so a fixture parse and a Python parse agree."""
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump(value), encoding="utf-8")


def _finding(**overrides):
    finding = {"path": "src/kept.ts", "line": 2, "severity": "major", "body": "Finding data"}
    finding.update(overrides)
    return finding


def _legacy_job(**overrides):
    job = {
        "job": OLD,
        "item": ITEM,
        "kind": "merged",
        "pr": 1,
        "run": RUN,
        "cycle": 1,
        "repair_base": PIN,
        "branch": None,
        "finding": _finding(),
        "repair_round": 1,
        "prior": None,
        "recurrence": False,
    }
    job.update(overrides)
    return job


def _record(**overrides):
    record = {
        "jobs": [OLD],
        "pin": PIN,
        "base": PIN,
        "branch": None,
        "open_pr": False,
        "round": 1,
        "state": "queued",
    }
    record.update(overrides)
    return record


def _queue(record=None, *, items=None):
    if items is not None:
        return {"items": items}
    return {
        "items": [
            {
                "id": ITEM,
                "pr": 1,
                "kind": "merged",
                "state": "repairing",
                "repair_runs": {RUN: _record() if record is None else record},
            }
        ]
    }


def _prepared(**overrides):
    finding = _finding()
    evidence = {
        "source_sha": PIN,
        "source_blob_sha": BLOB,
        "finding_sha256": bounded.identity(finding),
        "verdict": "still-valid",
        "reviewer": "independent-test-reviewer",
        "reason": "Pinned source retains the unstable initialization comparison.",
    }
    job = {
        "job": PREPARED_JOB,
        "item": ITEM,
        "kind": "merged",
        "pr": 1,
        "run": PREPARED_RUN,
        "cycle": None,
        "repair_base": PIN,
        "branch": None,
        "finding": finding,
        "repair_round": 1,
        "origin_job": ORIGIN,
        "source_sha": PIN,
        "finding_sha256": evidence["finding_sha256"],
        "revalidation": evidence,
        "prior": None,
        "recurrence": False,
    }
    job.update(overrides)
    return job, evidence


def _prepared_queue(job, evidence, **overrides):
    record = {
        "jobs": [job["job"]],
        "pin": PIN,
        "base": PIN,
        "branch": None,
        "open_pr": False,
        "round": 1,
        "state": "queued",
        "origin_job": job.get("origin_job"),
        "revalidation_sha256": bounded.identity(evidence),
    }
    record.update(overrides)
    return {
        "items": [
            {
                "id": ITEM,
                "pr": 1,
                "kind": "merged",
                "state": "repairing",
                "repair_runs": {job["run"]: record},
            }
        ]
    }


def _git(*, tip=PIN, blobs=None, ancestors=None, branches=None):
    return {
        "tip": tip,
        "blobs": dict(blobs or {}),
        "ancestors": [list(entry) for entry in (ancestors or [])],
        "branches": dict(branches or {}),
    }


def _at_pin(**extra):
    blobs = {PIN + ":src/kept.ts": BLOB, DEFAULT_REF + ":src/kept.ts": BLOB}
    blobs.update(extra)
    return _git(blobs=blobs)


READS: list[str] = []


def _fake_git(clone, *args):
    READS.append(" ".join(args))
    spec = _CURRENT_GIT
    if args == ("rev-parse", DEFAULT_REF):
        return spec["tip"]
    if len(args) == 2 and args[0] == "rev-parse":
        oid = spec["blobs"].get(args[1])
        if oid is None:
            raise RuntimeError("git rev-parse failed: synthetic")
        return oid
    raise AssertionError("unexpected bounded.git read: " + " ".join(args))


def _fake_command(argv, cwd=None, env=None, timeout=1200):
    assert argv[:1] == ["git"], "unexpected non-git command: " + repr(argv)
    rest = argv[1:]
    READS.append(" ".join(rest))
    spec = _CURRENT_GIT
    if len(rest) == 4 and rest[:3] == ["rev-parse", "--verify", "--quiet"]:
        target = rest[3]
        if target.startswith("refs/remotes/origin/") and target.endswith("^{commit}"):
            branch = target[len("refs/remotes/origin/") : -len("^{commit}")]
            oid = spec["branches"].get(branch)
        else:
            oid = spec["blobs"].get(target)
        if oid is None:
            return SimpleNamespace(returncode=1, stdout="", stderr="")
        return SimpleNamespace(returncode=0, stdout=oid + "\n", stderr="")
    if len(rest) == 4 and rest[:2] == ["merge-base", "--is-ancestor"]:
        allowed = [rest[2], rest[3], True] in spec["ancestors"]
        return SimpleNamespace(returncode=0 if allowed else 1, stdout="", stderr="")
    raise AssertionError("unexpected bounded.command read: " + " ".join(rest))


_CURRENT_GIT: dict = _git()


def _row(root: Path, fid: str, row=None, row_text=None) -> None:
    if row is None and row_text is None:
        return
    path = root / "state/backfill/findings/triage" / (fid + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    if row_text is not None:
        path.write_text(row_text, encoding="utf-8")
    else:
        _write(path, row)


def _inbox(root: Path, job_id: str, job=None, raw=None) -> None:
    path = root / "state/repair/inbox" / (job_id + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        path.write_text(raw, encoding="utf-8")
    elif job is not None:
        _write(path, job)


def _expected_job(job):
    return {"job": job, "job_keys": list(job) if isinstance(job, dict) else None}


def _drain_case(
    name: str,
    *,
    job_id: str = OLD,
    job=None,
    raw: str | None = None,
    queue=None,
    git=None,
    row=None,
    row_text=None,
    started: bool = False,
) -> dict:
    global _CURRENT_GIT
    _CURRENT_GIT = _git() if git is None else git
    queue_value = _queue() if queue is None else queue
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        _inbox(root, job_id, job, raw)
        _write(root / "state/queue.json", queue_value)
        fid = job.get("canonical_finding_id") if isinstance(job, dict) else None
        if isinstance(fid, str) and fid:
            _row(root, fid, row, row_text)
        if started:
            _write(root / "state/repair" / job_id / "progress.json", {"attempts": []})
        READS.clear()
        with mock.patch.object(bounded, "git", side_effect=_fake_git), mock.patch.object(
            bounded, "command", side_effect=_fake_command
        ):
            status, selected, reason = bounded.drain_job(root, CONFIG, queue_value, job_id)
    return {
        "kind": "drain",
        "name": name,
        "job_id": job_id,
        "job": job,
        "job_raw": raw,
        "queue": queue_value,
        "triage_row": row,
        "triage_row_raw": row_text,
        "started": started,
        "git": _CURRENT_GIT,
        "git_reads": list(READS),
        "expected": {
            "status": status,
            "refusal": _refusal(reason),
            **_expected_job(selected),
        },
    }


def _selection(job, source_sha, job_id):
    evidence = job["revalidation"]
    return {
        "state": "queued",
        "canonicalDelivery": "verified",
        "severity": "repairable",
        "base": source_sha,
        "jobs": [job_id],
        "originJob": job["origin_job"],
        "revalidationSha256": bounded.identity(evidence),
    }


def _select_case(
    name: str,
    *,
    job_id: str = PREPARED_JOB,
    job=None,
    raw: str | None = None,
    queue=None,
    git=None,
    row=None,
    row_text=None,
    source_sha: str = PIN,
    finding_sha256: str | None = None,
) -> dict:
    global _CURRENT_GIT
    _CURRENT_GIT = _git(blobs={PIN + ":src/kept.ts": BLOB}) if git is None else git
    queue_value = _queue() if queue is None else queue
    digest = finding_sha256
    if digest is None and isinstance(job, dict):
        digest = bounded.identity(job["finding"])
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        _inbox(root, job_id, job, raw)
        _write(root / "state/queue.json", queue_value)
        fid = job.get("canonical_finding_id") if isinstance(job, dict) else None
        if isinstance(fid, str) and fid:
            _row(root, fid, row, row_text)
        READS.clear()
        with mock.patch.object(bounded, "git", side_effect=_fake_git), mock.patch.object(
            bounded, "command", side_effect=_fake_command
        ):
            try:
                selected = bounded.select_job(root, CONFIG, job_id, source_sha, digest)
                expected = {
                    "ok": True,
                    "selectedJobId": job_id,
                    "job": selected,
                    "job_keys": list(selected),
                    "selection": _selection(selected, source_sha, job_id),
                }
            except (ValueError, OSError) as exc:
                expected = {
                    "ok": False,
                    "refusal": _error_refusal(exc),
                    "error_type": type(exc).__name__,
                }
    return {
        "kind": "select",
        "name": name,
        "job_id": job_id,
        "job": job,
        "job_raw": raw,
        "queue": queue_value,
        "triage_row": row,
        "triage_row_raw": row_text,
        "source_sha": source_sha,
        "finding_sha256": digest,
        "git": _CURRENT_GIT,
        "git_reads": list(READS),
        "expected": expected,
    }


def _order_case(name: str, spec) -> dict:
    """``spec`` is ``[(name, mtime, symlink_target_or_None)]``."""
    with tempfile.TemporaryDirectory() as directory:
        inbox = Path(directory) / "state/repair/inbox"
        inbox.mkdir(parents=True)
        for entry_name, mtime, target in spec:
            path = inbox / entry_name
            if target is not None:
                (inbox / target).write_text("{}", encoding="utf-8")
                path.symlink_to(inbox / target)
            else:
                path.write_text("{}", encoding="utf-8")
            os.utime(path, (mtime, mtime), follow_symlinks=False)
        started = bounded.drain_order(Path(directory))
    return {
        "kind": "order",
        "name": name,
        "entries": [
            {"name": entry_name, "mtime": mtime, "symlink": target is not None}
            for entry_name, mtime, target in spec
        ],
        "expected": {"jobs": started},
    }


def build() -> dict:
    prepared_job, prepared_evidence = _prepared()
    prepared_queue = _prepared_queue(prepared_job, prepared_evidence)

    cases = [
        # Ordering: drain_order filters the *.json glob, JOB_ID, symlinks, then
        # sorts by (st_mtime, name). Directories that match are included.
        _order_case("order-empty", []),
        _order_case(
            "order-mtime-then-name",
            [
                ("crq-late.json", 30.0, None),
                ("crq-early.json", 10.0, None),
                ("crq-tie-b.json", 20.0, None),
                ("crq-tie-a.json", 20.0, None),
            ],
        ),
        _order_case(
            "order-filter",
            [
                ("crq-valid.json", 5.0, None),
                (".hidden.json", 1.0, None),
                ("not-a-job.json", 2.0, None),
                ("crq-upper.JSON", 3.0, None),
                ("crq-valid.json.json", 4.0, None),
                ("crq-link.json", 0.5, "crq-valid.json"),
            ],
        ),
        _order_case(
            "order-fractional-mtime",
            [
                ("crq-b.json", 1.25, None),
                ("crq-a.json", 1.5, None),
                ("crq-c.json", 1.5, None),
            ],
        ),
        # Legacy drain: pin binding, source drift, resume, open-PR branches.
        _drain_case("legacy-run-binds-pin", job=_legacy_job(), git=_at_pin()),
        _drain_case(
            "legacy-default-source-changed",
            job=_legacy_job(),
            git=_at_pin(**{DEFAULT_REF + ":src/kept.ts": OTHER_BLOB}),
        ),
        _drain_case(
            "legacy-pin-path-absent",
            job=_legacy_job(),
            git=_git(blobs={DEFAULT_REF + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "legacy-pin-path-absent-started",
            job=_legacy_job(),
            git=_git(blobs={DEFAULT_REF + ":src/kept.ts": BLOB}),
            started=True,
        ),
        _drain_case(
            "legacy-open-pr-head-on-default",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True)),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}, ancestors=[[PIN, DEFAULT_REF, True]]),
        ),
        _drain_case(
            "legacy-open-pr-branch-gone",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True, branch="feat/x")),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "legacy-open-pr-branch-at-pin",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True, branch="feat/x")),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}, branches={"feat/x": PIN}),
        ),
        _drain_case(
            "legacy-open-pr-branch-other-same-blob",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True, branch="feat/x")),
            git=_git(
                blobs={PIN + ":src/kept.ts": BLOB, BRANCH_HEAD + ":src/kept.ts": BLOB},
                branches={"feat/x": BRANCH_HEAD},
            ),
        ),
        _drain_case(
            "legacy-open-pr-branch-other-changed-blob",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True, branch="feat/x")),
            git=_git(
                blobs={PIN + ":src/kept.ts": BLOB, BRANCH_HEAD + ":src/kept.ts": OTHER_BLOB},
                branches={"feat/x": BRANCH_HEAD},
            ),
        ),
        _drain_case(
            "legacy-open-pr-branch-dash-prefixed",
            job=_legacy_job(),
            queue=_queue(_record(open_pr=True, branch="-feat/x")),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case("legacy-resume-skips-source-drift", job=_legacy_job(), git=_at_pin(), started=True),
        _drain_case(
            "legacy-preserves-existing-binding-keys",
            job=_legacy_job(source_sha=TIP, finding_sha256="0" * 64, origin_job=ORIGIN),
            git=_at_pin(),
        ),
        # Queue states that must never be selected.
        _drain_case("queue-state-ready", job=_legacy_job(), queue=_queue(_record(state="ready"))),
        _drain_case("queue-state-done", job=_legacy_job(), queue=_queue(_record(state="done"))),
        _drain_case("queue-state-publish-failed", job=_legacy_job(), queue=_queue(_record(state="publish_failed"))),
        _drain_case("queue-jobs-other", job=_legacy_job(), queue=_queue(_record(jobs=["crq-other-F1"]))),
        _drain_case("queue-jobs-empty", job=_legacy_job(), queue=_queue(_record(jobs=[]))),
        _drain_case("queue-record-empty", job=_legacy_job(), queue=_queue({})),
        _drain_case("queue-item-missing", job=_legacy_job(), queue=_queue(items=[])),
        _drain_case("queue-base-mismatch", job=_legacy_job(), queue=_queue(_record(base=TIP))),
        _drain_case("queue-jobs-string-contains", job=_legacy_job(), queue=_queue(_record(jobs=OLD)), git=_at_pin()),
        _drain_case(
            "queue-jobs-object-contains",
            job=_legacy_job(),
            queue=_queue(_record(jobs={OLD: True})),
            git=_at_pin(),
        ),
        _drain_case(
            "queue-jobs-string-not-contains",
            job=_legacy_job(),
            queue=_queue(_record(jobs="crq-other-F1")),
        ),
        _drain_case(
            "queue-matches-missing-item-and-id",
            job={key: value for key, value in _legacy_job().items() if key != "item"},
            queue={"items": [{"state": "repairing", "repair_runs": {RUN: _record()}}]},
            git=_at_pin(),
        ),
        _drain_case(
            "queue-matches-null-item-and-missing-id",
            job=_legacy_job(item=None),
            queue={"items": [{"state": "repairing", "repair_runs": {RUN: _record()}}]},
            git=_at_pin(),
        ),
        # Job/selection refusals.
        _drain_case("repair-base-invalid", job=_legacy_job(repair_base="not-a-sha")),
        _drain_case("severity-minor-legacy", job=_legacy_job(finding=_finding(severity="minor"))),
        _drain_case("severity-info", job=_legacy_job(finding=_finding(severity="info"))),
        _drain_case(
            "severity-minor-canonical-delivered",
            job=_legacy_job(canonical_finding_id=CANONICAL, finding=_finding(severity="minor")),
            row={"status": "delivered", "receipt": {"repair_task": OLD}},
            git=_at_pin(),
        ),
        _drain_case("finding-path-absolute", job=_legacy_job(finding=_finding(path="/etc/passwd"))),
        _drain_case("finding-path-parent", job=_legacy_job(finding=_finding(path="../escape.ts"))),
        _drain_case("finding-path-newline", job=_legacy_job(finding=_finding(path="src/a.ts\n+++ b/x"))),
        _drain_case("canonical-id-invalid", job=_legacy_job(canonical_finding_id="canonical")),
        _drain_case("canonical-row-missing", job=_legacy_job(canonical_finding_id=CANONICAL)),
        _drain_case(
            "canonical-row-not-delivered",
            job=_legacy_job(canonical_finding_id=CANONICAL),
            row={"status": "confirmed", "receipt": {"repair_task": OLD}},
        ),
        _drain_case(
            "canonical-row-wrong-task",
            job=_legacy_job(canonical_finding_id=CANONICAL),
            row={"status": "delivered", "receipt": {"repair_task": "crq-other-F1"}},
        ),
        _drain_case(
            "canonical-row-receipt-null",
            job=_legacy_job(canonical_finding_id=CANONICAL),
            row={"status": "delivered", "receipt": None},
        ),
        _drain_case(
            "canonical-row-array",
            job=_legacy_job(canonical_finding_id=CANONICAL),
            row_text="[]",
        ),
        _drain_case(
            "canonical-row-invalid-json",
            job=_legacy_job(canonical_finding_id=CANONICAL),
            row_text="{broken",
        ),
        _drain_case("job-identity-mismatch", job=_legacy_job(job="crq-other-F1")),
        _drain_case("job-unreadable-json", raw="{broken"),
        _drain_case("job-json-array", raw="[1, 2]"),
        _drain_case("job-unreadable-missing", job_id="crq-missing-F1"),
        _drain_case("finding-missing", job=_legacy_job(**{"finding": None})),
        _drain_case("finding-not-object", job=_legacy_job(finding=[])),
        # Prepared jobs: the strict one-job selector, including its tip check.
        _drain_case(
            "prepared-run",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=prepared_queue,
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-source-not-tip",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=prepared_queue,
            git=_git(tip=TIP, blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-origin-job-missing",
            job_id=PREPARED_JOB,
            job=_prepared()[0] | {"origin_job": None},
            queue=prepared_queue,
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-digest-mismatch",
            job_id=PREPARED_JOB,
            job=_prepared()[0] | {"finding_sha256": "0" * 64},
            queue=prepared_queue,
        ),
        _drain_case(
            "prepared-evidence-blob-mismatch",
            job_id=PREPARED_JOB,
            job=_prepared()[0]
            | {
                "revalidation": {
                    **_prepared()[1],
                    "source_blob_sha": OTHER_BLOB,
                }
            },
            queue=prepared_queue,
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-evidence-text-blank",
            job_id=PREPARED_JOB,
            job=_prepared()[0]
            | {
                "revalidation": {
                    **_prepared()[1],
                    "reviewer": "   ",
                }
            },
            queue=prepared_queue,
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-revalidation-lineage-mismatch",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, revalidation_sha256="0" * 64),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-record-jobs-two",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=_prepared_queue(
                prepared_job, prepared_evidence, jobs=[PREPARED_JOB, "crq-other-F1"]
            ),
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-resumed-not-tip",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=prepared_queue,
            git=_git(tip=TIP, blobs={PIN + ":src/kept.ts": BLOB}),
            started=True,
        ),
        _drain_case(
            "prepared-canonical-mismatch",
            job_id=PREPARED_JOB,
            job=prepared_job | {"canonical_finding_id": CANONICAL},
            queue=prepared_queue,
            row={"status": "delivered", "receipt": {"repair_task": "crq-other-F1"}},
            git=_git(blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _drain_case(
            "prepared-record-state-not-queued",
            job_id=PREPARED_JOB,
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, state="done"),
        ),
        # Explicit selection: exactly one named job, or a typed refusal.
        _select_case("select-prepared", job=prepared_job, queue=prepared_queue),
        _select_case("select-source-sha-invalid", job=prepared_job, queue=prepared_queue, source_sha="nope"),
        _select_case("select-job-id-invalid", job_id="bad id", job=prepared_job, queue=prepared_queue),
        _select_case(
            "select-finding-digest-mismatch",
            job=prepared_job,
            queue=prepared_queue,
            finding_sha256="0" * 64,
        ),
        _select_case(
            "select-historical-repair-base",
            job=prepared_job | {"repair_base": TIP},
            queue=prepared_queue,
        ),
        _select_case("select-queue-record-missing", job=prepared_job, queue=_queue(items=[])),
        _select_case(
            "select-record-base-mismatch",
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, base=TIP),
        ),
        _select_case(
            "select-record-jobs-extra",
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, jobs=[PREPARED_JOB, "crq-other-F1"]),
        ),
        _select_case(
            "select-record-origin-mismatch",
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, origin_job="crq-other-F1"),
        ),
        _select_case(
            "select-record-revalidation-mismatch",
            job=prepared_job,
            queue=_prepared_queue(prepared_job, prepared_evidence, revalidation_sha256="0" * 64),
        ),
        _select_case("select-job-missing", job_id="crq-missing-F1", queue=prepared_queue),
        _select_case(
            "select-origin-job-missing",
            job=prepared_job | {"origin_job": None},
            queue=prepared_queue,
        ),
        _select_case(
            "select-canonical-invalid",
            job=prepared_job | {"canonical_finding_id": "canonical"},
            queue=prepared_queue,
        ),
        _select_case(
            "select-canonical-unavailable",
            job=prepared_job | {"canonical_finding_id": CANONICAL},
            queue=prepared_queue,
        ),
        _select_case(
            "select-canonical-mismatch",
            job=prepared_job | {"canonical_finding_id": CANONICAL},
            queue=prepared_queue,
            row={"status": "superseded", "receipt": {"repair_task": PREPARED_JOB}},
        ),
        _select_case(
            "select-evidence-binding-mismatch",
            job=prepared_job
            | {"revalidation": {**prepared_evidence, "source_blob_sha": OTHER_BLOB}},
            queue=prepared_queue,
        ),
        _select_case(
            "select-evidence-text-invalid",
            job=prepared_job | {"revalidation": {**prepared_evidence, "reason": " \t "}},
            queue=prepared_queue,
        ),
        _select_case(
            "select-source-not-tip",
            job=prepared_job,
            queue=prepared_queue,
            git=_git(tip=TIP, blobs={PIN + ":src/kept.ts": BLOB}),
        ),
        _select_case(
            "select-finding-path-invalid",
            job=prepared_job | {"finding": _finding(path="../escape.ts")},
            queue=prepared_queue,
        ),
        _select_case(
            "select-severity-not-repairable",
            job=prepared_job | {"finding": _finding(severity="minor")},
            queue=prepared_queue,
        ),
        _select_case(
            "select-job-unreadable-json",
            raw="{broken",
            job=None,
            queue=prepared_queue,
            finding_sha256="0" * 64,
        ),
    ]
    document = {
        "schema": SCHEMA,
        "source": {
            "path": SOURCE_PATH,
            "functions": _source_proof(),
        },
        "default_ref": DEFAULT_REF,
        "constants": {
            "pin": PIN,
            "tip": TIP,
            "blob": BLOB,
            "other_blob": OTHER_BLOB,
            "branch_head": BRANCH_HEAD,
            "canonical": CANONICAL,
            "origin_job": ORIGIN,
            "legacy_job": OLD,
            "prepared_job": PREPARED_JOB,
        },
        "cases": cases,
    }
    _assert_unique(cases)
    return document


def _source_proof() -> dict:
    module = Path(inspect.getsourcefile(bounded.drain_job)).resolve()
    names = (
        "select_job",
        "drain_order",
        "drain_job",
        "require_canonical_delivery",
        "repairable_severity",
        "validate_revalidation",
        "identity",
        "check_sha",
        "source_path",
        "job_path",
        "blob_at",
        "started",
    )
    return {
        "module_sha256": hashlib.sha256(module.read_bytes()).hexdigest(),
        **{
            name: hashlib.sha256(inspect.getsource(getattr(bounded, name)).encode("utf-8")).hexdigest()
            for name in names
        },
    }


def _assert_unique(cases: list[dict]) -> None:
    names = [case["name"] for case in cases]
    if len(names) != len(set(names)):
        raise AssertionError("duplicate vector case names")


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq repair-selection oracle fixture")
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
        print("repair-selection fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
