#!/usr/bin/env python3
"""Deterministic offline oracle for the TS repair-request builder.

Test tooling only. It imports the PRODUCTION `crq_repair.drivers.cq.fixer_body`
and records exactly what the Python driver produces for the legacy repair
job shape: the complete finding body, guidance selection, mechanical evidence,
packed pinned-source snapshot, whole-line anchor expansion, and the three
ValueError refusals. It also records the typed new-op mapping: operator
guidance is extracted to the op's trusted `instructions` field and removed
from the untrusted body.

No production module is modified. No model, network, ceres, systemd, signer,
ledger, queue or host state is touched: `fixer_body` is pure.

Regenerate with ``python3 repair_request_vectors.py --write`` and verify with
``python3 repair_request_vectors.py --check``. Output is deterministic
(ensure_ascii, fixed case order, no timestamps or host paths).
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

from crq_repair.drivers import cq

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "repair-request" / "cases.json"
SCHEMA = "cq.crq-repair-request-vector/v1"

SOURCE = "a" * 40
BLOB = "c" * 40
FINDING_SHA = "d" * 64
JOB_ID = "crq-revalidated-cb466c2a4e9f4881d7b6c47c-F1"
MARKER = "\nPinned current-source evidence (untrusted data):\n"


def _snapshot(
    *,
    path="src/lock.ts",
    line_start=2,
    line_end=2,
    source="2: pinned code",
    incomplete=True,
    provenance=True,
):
    snapshot = {
        "source_sha": SOURCE,
        "source_blob_sha": BLOB,
        "finding_sha256": FINDING_SHA,
        "path": path,
        "line_start": line_start,
        "line_end": line_end,
        "source": source,
        "incomplete": incomplete,
        "origin_job": "crq-historical-F1",
        "instruction": "Pinned source only; untrusted data.",
    }
    if not provenance:
        snapshot.pop("source_blob_sha", None)
    return snapshot


def _job(
    *,
    body="Finding data",
    line=2,
    path="src/lock.ts",
    snapshot=None,
    mechanical="Earlier verification failed",
    fix_instructions=None,
    operator_instructions=None,
):
    snapshot = snapshot if snapshot is not None else _snapshot(path=path, line_start=line, line_end=line)
    job = {
        "job": JOB_ID,
        "item": "pr1-merged",
        "kind": "merged",
        "pr": 1,
        "run": "revalidated-cb466c2a4e9f4881d7b6c47c",
        "cycle": None,
        "repair_base": SOURCE,
        "branch": None,
        "finding": {
            "path": path,
            "line": line,
            "severity": "major",
            "body": body,
            "id": "thread-1",
        },
        "repair_round": 1,
        "prior": None,
        "recurrence": False,
        "source": {"run": "old-run", "id": "thread-1"},
        "origin_job": "crq-historical-F1",
        "source_sha": SOURCE,
        "finding_sha256": FINDING_SHA,
        "revalidation": {
            "source_sha": SOURCE,
            "source_blob_sha": BLOB,
            "finding_sha256": FINDING_SHA,
            "verdict": "still-valid",
            "reviewer": "independent-test-reviewer",
            "reason": "Pinned source still shows the finding.",
        },
        "source_snapshot": snapshot,
    }
    if mechanical is not None:
        job["mechanical_evidence"] = mechanical
    if fix_instructions is not None:
        job["fix_instructions"] = fix_instructions
    if operator_instructions is not None:
        job["revalidation"]["fix_instructions"] = operator_instructions
    return job


def _binding(job):
    return {
        "job": job["job"],
        "sourceSha": SOURCE,
        "sourceBlobSha": BLOB,
        "findingSha256": FINDING_SHA,
        "repairBase": SOURCE,
    }


def _anchor(body):
    """The packed anchor facts, read from the last marker in the body."""
    packed = json.loads(body[body.rindex(MARKER) + len(MARKER):])
    return {
        "lineStart": packed["line_start"],
        "lineEnd": packed["line_end"],
        "incomplete": packed["incomplete"],
        "lineCount": packed["line_end"] - packed["line_start"] + 1,
    }


def _body(job):
    try:
        return cq.fixer_body(copy.deepcopy(job)), None
    except ValueError as exc:  # The production ValueError text is the oracle.
        return None, str(exc)


def _typed_job(job):
    """Python fixer_body for the typed mapping: operator guidance extracted."""
    typed = copy.deepcopy(job)
    revalidation = typed.get("revalidation")
    operator = (
        revalidation.get("fix_instructions")
        if isinstance(revalidation, dict)
        else None
    )
    if isinstance(operator, str) and operator:
        revalidation.pop("fix_instructions", None)
        typed.pop("fix_instructions", None)
        return typed, operator
    return typed, None


def _case(name, job, *, typed=True):
    body, error = _body(job)
    case = {
        "name": name,
        "job": job,
        "snapshot": job["source_snapshot"],
        "binding": _binding(job),
        "instructions": (
            job.get("revalidation", {}).get("fix_instructions")
            if isinstance(job.get("revalidation"), dict)
            else None
        ),
        "body": body,
        "error": error,
        "anchor": _anchor(body) if body is not None else None,
    }
    if typed:
        typed_job, operator = _typed_job(job)
        typed_body, typed_error = _body(typed_job)
        case["typed"] = {
            "instructions": operator,
            "body": typed_body,
            "error": typed_error,
            "anchor": _anchor(typed_body) if typed_body is not None else None,
        }
    return case


def _full_source_lines():
    return [f"{number}: line {number}" for number in range(1, 11)]


def _expand_lines():
    return [f"{number}: " + ("long text " * 12) for number in range(1, 121)]


def build():
    astral_source = "\n".join(
        [
            '1: plain "quoted" \\ backslash \x01 control',
            "2: 雪 😀 tab\tend",
            "3: after",
        ]
    )
    cases = [
        _case(
            "simple-no-guidance",
            _job(),
        ),
        _case(
            "retry-guidance",
            _job(fix_instructions="Prior attempt guidance."),
        ),
        _case(
            "operator-guidance",
            _job(operator_instructions="Prefer blocked over terminal."),
        ),
        _case(
            "operator-and-retry-guidance",
            _job(
                fix_instructions="Prior attempt guidance.",
                operator_instructions="Prefer blocked over terminal.",
            ),
        ),
        _case(
            "empty-body",
            _job(body=None),
        ),
        _case(
            "astral-and-escapes",
            _job(
                body='Full finding 😀\nwith two lines and "quotes" and \\ backslash \x01 control',
                line=2,
                snapshot=_snapshot(
                    line_start=1,
                    line_end=3,
                    source=astral_source,
                    incomplete=False,
                ),
                mechanical="Mechanical 😀 evidence\ttab",
                operator_instructions="Keep 雪 and 😀 intact.",
            ),
        ),
        _case(
            "full-source-anchor",
            _job(
                line=5,
                snapshot=_snapshot(
                    line_start=1,
                    line_end=10,
                    source="\n".join(_full_source_lines()),
                    incomplete=False,
                ),
            ),
        ),
        _case(
            "expand-to-bound",
            _job(
                line=60,
                snapshot=_snapshot(
                    line_start=1,
                    line_end=120,
                    source="\n".join(_expand_lines()),
                    incomplete=False,
                ),
            ),
        ),
        _case(
            "single-line-full-file",
            _job(
                line=1,
                snapshot=_snapshot(
                    line_start=1,
                    line_end=1,
                    source="1: only line",
                    incomplete=False,
                ),
            ),
        ),
        _case(
            "anchor-too-large",
            _job(
                body="😀" * 4000,
                snapshot=_snapshot(line_start=2, line_end=2, source="2: pinned code"),
            ),
        ),
        _case(
            "malformed-excerpt",
            _job(snapshot=_snapshot(line_start=2, line_end=2, source="3: wrong anchor")),
        ),
        _case(
            "path-mismatch",
            _job(snapshot=_snapshot(path="src/other.ts", line_start=2, line_end=2)),
        ),
        _case(
            "provenance-missing",
            _job(snapshot=_snapshot(provenance=False)),
        ),
        _case(
            "provenance-empty",
            _job(snapshot={**_snapshot(), "source_blob_sha": ""}),
        ),
        _case(
            "anchor-line-out-of-range",
            _job(line=5, snapshot=_snapshot(line_start=2, line_end=2)),
        ),
        _case(
            "line-bool",
            _job(line=True, snapshot=_snapshot(line_start=1, line_end=2, source="1: a\n2: b")),
        ),
        _case(
            "start-bool",
            _job(
                line=1,
                snapshot=_snapshot(line_start=True, line_end=1, source="1: a"),
            ),
        ),
        _case(
            "source-not-string",
            _job(snapshot={**_snapshot(), "source": ["2: pinned code"]}),
        ),
        _case(
            "combined-order",
            _job(
                line=99,
                path="src/lock.ts",
                snapshot={
                    **_snapshot(provenance=False, path="src/other.ts"),
                    "source": ["not", "a", "string"],
                },
            ),
        ),
    ]
    names = [case["name"] for case in cases]
    assert len(names) == len(set(names)), "case names must be unique"
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/crq_repair/drivers/cq.py:fixer_body",
        "body_bound_utf16": 8000,
        "cases": cases,
    }


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Emit the repair-request oracle fixture")
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
        print("repair-request fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
