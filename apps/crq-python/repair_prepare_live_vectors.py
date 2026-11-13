#!/usr/bin/env python3
"""Deterministic live-oracle recorder for the ``crq repair-prepare`` acceptance test.

Test tooling only. It creates a scratch git repository from the recorded file
set, runs the PRODUCTION ``repair_tick.prepare_current_job`` with REAL
``git rev-parse``/``git show`` reads against that repository, and records the
exact job, queue, triage and outbox bytes the Python runtime writes for one
canonical and one non-canonical historical job.

Only the secret scanner and the clock are faked: neither contributes to the
recorded bytes. ``finding_inbox`` is bound to a real ``finding_delivery.Inbox``
over a real ``review_ledger.Outbox`` in the temp state root, so the triage row
and the spooled event are produced by production code.

The TypeScript acceptance test rebuilds the repository from ``repository.files``
and requires the recorded ``source_sha``/``source_blob_sha``; a host whose Git
produces different object names fails loudly instead of comparing loose bytes.

Regenerate with ``python3 repair_prepare_live_vectors.py --write`` and verify
with ``--check``. Output is deterministic: fixed file set, fixed commit
identity and date, fixed case order, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import finding_delivery
import repair_tick
import review_ledger as ledger
from crq_repair import bounded

from repair_prepare_execution_vectors import (
    CANONICAL,
    CLEAN_REPORT,
    HISTORICAL,
    ITEM,
    OLD,
    OLD_RUN,
    _dump,
    _old_job,
    _queue_initial,
    _Root,
    _triage_row,
    _write_json,
)

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-repair-prepare-live" / "cases.json"
SCHEMA = "cq.crq-repair-prepare-live-vector/v1"
ISO = "2026-11-11T00:00:00Z"

FILES = {
    "src/lock.ts": "\nfirst\nsecond\n",
    "policy/denylist/patterns.yml": (
        "rules:\n"
        "  - id: class:fixture-marker\n"
        "    description: fixture marker (never present in the clean source)\n"
        "    regex: '\\bSECRET-[A-Z0-9]{4}\\b'\n"
        "    sample: 'SECRET-ABCD'\n"
        "clean_probes:\n"
        "  - 'nothing secret here'\n"
    ),
}

COMMIT = {
    "message": "fixture: deterministic repair-prepare source",
    "author_name": "crq fixture",
    "author_email": "crq-fixture@example.invalid",
    "date": "2026-11-11T00:00:00+0000",
}


def _git(root: Path, *args: str, env: dict[str, str]) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, env=env, check=False
    )
    if completed.returncode:
        raise RuntimeError("git " + " ".join(args) + " failed: " + completed.stderr[:400])
    return completed.stdout.strip()


def _git_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": COMMIT["author_name"],
            "GIT_AUTHOR_EMAIL": COMMIT["author_email"],
            "GIT_AUTHOR_DATE": COMMIT["date"],
            "GIT_COMMITTER_NAME": COMMIT["author_name"],
            "GIT_COMMITTER_EMAIL": COMMIT["author_email"],
            "GIT_COMMITTER_DATE": COMMIT["date"],
        }
    )
    return env


def scratch_repository(root: Path) -> tuple[str, str]:
    """Write the recorded file set, commit it deterministically, set origin/main."""
    for relative, text in FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="")
        os.chmod(path, 0o644)
    env = _git_env()
    _git(root, "init", "-q", "--object-format=sha1", "-b", "main", str(root), env=env)
    _git(root, "-C", str(root), "-c", "core.autocrlf=false", "add", "-A", env=env)
    _git(root, "-C", str(root), "commit", "-q", "-m", COMMIT["message"], env=env)
    _git(root, "-C", str(root), "update-ref", "refs/remotes/origin/main", "HEAD", env=env)
    source_sha = _git(root, "-C", str(root), "rev-parse", "origin/main", env=env)
    blob = _git(root, "-C", str(root), "rev-parse", f"{source_sha}:src/lock.ts", env=env)
    return source_sha, blob


def _inbox(root: Path):
    outbox = ledger.Outbox(
        root / "state" / "backfill" / "publication",
        ledger.ArtifactStore(root / "state" / "backfill" / "artifacts"),
    )
    return finding_delivery.Inbox(root / "state" / "backfill" / "findings", outbox)


def _live_case(
    root: Path, repo: Path, *, canonical: bool, source_sha: str, blob: str
) -> dict:
    old = _old_job()
    if canonical:
        old["canonical_finding_id"] = CANONICAL
    _write_json(root / "state" / "repair" / "inbox" / (OLD + ".json"), old)
    _write_json(root / "state" / "queue.json", _queue_initial(canonical=canonical))
    evidence = {
        "source_sha": source_sha,
        "source_blob_sha": blob,
        "finding_sha256": bounded.identity(old["finding"]),
        "verdict": "still-valid",
        "reviewer": "independent-test-reviewer",
        "reason": "Pinned source retains the unstable initialization metadata comparison.",
    }
    if canonical:
        _write_json(
            root / "state" / "backfill" / "findings" / "triage" / (CANONICAL + ".json"),
            _triage_row(OLD),
        )
    old_input = (root / "state" / "repair" / "inbox" / (OLD + ".json")).read_text(
        encoding="utf-8"
    )
    queue_input = (root / "state" / "queue.json").read_text(encoding="utf-8")
    triage_input = (
        (root / "state" / "backfill" / "findings" / "triage" / (CANONICAL + ".json")).read_text(
            encoding="utf-8"
        )
        if canonical
        else None
    )
    def run_git(argv, **kwargs):
        done = subprocess.run(argv, capture_output=True, text=True, check=False, **kwargs)
        if done.returncode != 0:
            raise RuntimeError(f"git failed: {' '.join(argv)}: {done.stderr.strip()}")
        return done

    service = _Root(
        root,
        trace=SimpleNamespace(record=lambda entry: None),
        scan_spec=None,
        source_text=FILES["src/lock.ts"],
        tip=source_sha,
        blob=blob,
    )
    service.CONFIG["clone"] = str(repo)
    service.CONFIG["repair"]["max_rounds_per_pin"] = 2
    service.CLONE = repo
    service.run = run_git

    def inbox_factory(_root: Path):
        return _inbox(root)

    queue = json.loads((root / "state" / "queue.json").read_text(encoding="utf-8"))
    with mock.patch.object(repair_tick, "finding_inbox", new=inbox_factory):
        job_id = repair_tick.prepare_current_job(
            service, queue, OLD, source_sha, evidence
        )

    inbox = root / "state" / "repair" / "inbox"
    pending = root / "state" / "backfill" / "publication" / "pending"
    triage = root / "state" / "backfill" / "findings" / "triage"
    event_files = sorted(pending.glob("*.json"))
    return {
        "job_id": job_id,
        "evidence": evidence,
        "old_job_canonical": old_input,
        "queue_input_canonical": queue_input,
        "triage_input_canonical": triage_input,
        "job_canonical": (inbox / (job_id + ".json")).read_text(encoding="utf-8"),
        "queue_canonical": (root / "state" / "queue.json").read_text(encoding="utf-8"),
        "triage_canonical": (
            (triage / (CANONICAL + ".json")).read_text(encoding="utf-8")
            if canonical
            else None
        ),
        "outbox_canonical": (
            event_files[0].read_text(encoding="utf-8") if event_files else None
        ),
    }


def build() -> dict:
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        repo = base / "repo"
        repo.mkdir()
        source_sha, blob = scratch_repository(repo)
        finding_sha256 = bounded.identity(_old_job()["finding"])
        cases = {}
        for name, canonical in (("canonical", True), ("non_canonical", False)):
            root = base / name
            root.mkdir()
            cases[name] = _live_case(
                root, repo, canonical=canonical, source_sha=source_sha, blob=blob
            )
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/repair_tick.py prepare_current_job over a real scratch repository",
        "note": (
            "Recorded from production prepare_current_job with real git reads and "
            "the real finding Inbox/Outbox. Only the secret scanner and the clock "
            "are faked; neither contributes to these bytes."
        ),
        "repository": {
            **COMMIT,
            "files": FILES,
            "source_sha": source_sha,
            "source_blob_sha": blob,
        },
        "state": {
            "old_job_id": OLD,
            "item_id": ITEM,
            "old_run": OLD_RUN,
            "historical_repair_base": HISTORICAL,
            "canonical_finding_id": CANONICAL,
            "finding_sha256": finding_sha256,
            "handoff_at": ISO,
            "clean_scan_report": CLEAN_REPORT,
        },
        "cases": cases,
    }


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Emit the repair-prepare live oracle")
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
        print("repair-prepare live fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
