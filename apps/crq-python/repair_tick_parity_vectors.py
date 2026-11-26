#!/usr/bin/env python3
"""Deterministic offline oracle for the repair-side tick passes.

Test tooling only. Every case drives the PRODUCTION ``repair_tick.backfill``,
``repair_tick.archive_legacy`` and ``repair_tick.harvest`` (the last under the
exception handler of ``crq.tick``'s harvest loop, crq.py:3614) in that order, over seeded
on-disk state: queue, runs, legacy ledger, repair inbox, result artifacts,
triage rows, publication outbox and rollout. It records, per phase, the queue
and the exception class that escaped (the queue a failed phase leaves is its
pre-phase queue, since an escaping exception aborts the tick), the harvest log,
the stub-effect call log and the resulting file tree.

Effects the TypeScript port does not bind yet are replaced by one deterministic
stub that the TS replay mirrors line for line: ``require_canonical_delivery``,
``make_worktree``/``remove_worktree``, ``crq_repair.verify``, ``mechanical``,
``save_queue``, ``publish`` and the replay-budget clock. ``mark_finding_outcome``,
``record_unpublished_siblings`` and ``cleanup_harvested`` run for real.

Regenerate with ``python3.14 repair_tick_parity_vectors.py --write`` and verify
with ``--check`` (``test_repair_tick_parity_vectors.py`` does the latter).
Output is deterministic (ensure_ascii, no host paths: the temp root is scrubbed
to ``<ROOT>``).
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import repair_harvest_vectors as base  # noqa: E402
import repair_tick  # noqa: E402
import review_receipt  # noqa: E402
import review_ledger as ledger  # noqa: E402

RECEIPT_KIND = review_receipt.KIND
FIXTURE = HERE / "fixtures" / "crq-repair-tick-parity" / "cases.json"
SCHEMA = "cq.crq-repair-tick-parity-vector/v1"

AT = "2026-11-27T00:00:00Z"
WALL = 1700000000.5
FINDING = base.FINDING
SEEDS = 36
GIT_ENV = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}

GIT_DEFAULT = {"rev-parse origin/main": "tip0"}


def bytes_doc(value: bytes) -> dict:
    return {"__bytes_b64": base64.b64encode(value).decode("ascii")}


def spec_text(value, root: Path) -> bytes:
    """A layout value: text (with ``{ROOT}``), raw bytes, or a JSON document."""
    if isinstance(value, dict) and "__bytes_b64" in value:
        return base64.b64decode(value["__bytes_b64"])
    if isinstance(value, str):
        return value.replace("{ROOT}", str(root)).encode("utf-8")
    return (json.dumps(value).replace("{ROOT}", str(root))).encode("utf-8")


def layout(spec: dict, root: Path) -> None:
    for rel, value in spec.get("files", {}).items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(spec_text(value, root))
    for run, files in spec.get("runs", {}).items():
        directory = root / "runs" / run
        directory.mkdir(parents=True, exist_ok=True)
        if "meta" in files:
            (directory / "meta.json").write_bytes(spec_text(files["meta"], root))
        if "review" in files:
            (directory / "review.ndjson").write_bytes(spec_text(files["review"], root))
    (root / "ledger").mkdir(parents=True, exist_ok=True)
    for name in spec.get("ledger", []):
        (root / "ledger" / name).write_text(name)
    (root / "worktrees").mkdir(parents=True, exist_ok=True)


def ledger_layout(spec: dict, root: Path):
    """The finding ledger: rollout, triage row bound to ``row_task`` and the seeded chain."""
    if not spec.get("finding_ledger"):
        return None
    state = root
    for directory in (state / "backfill/findings/triage", state / "backfill/publication/pending",
                      state / "artifacts", state / "repair/inbox"):
        directory.mkdir(parents=True, exist_ok=True)
    store = ledger.ArtifactStore(root / "artifacts")
    outbox = ledger.Outbox(state / "backfill/publication", store)
    seeded, latest = base._seed_chain(())
    for value in seeded:
        outbox.spool(value)
    row = base._row(repair_task=spec.get("row_task"))
    row["previous_event_id"] = latest
    base._write(state / "backfill/findings/triage" / (FINDING + ".json"), row)
    if not spec.get("no_rollout"):
        (state / "backfill-rollout.json").write_text(ROLLOUT_TEXT.replace("{ROOT}", str(root)))
    return outbox


def tree(root: Path) -> dict:
    out = {}
    for path in sorted(root.rglob("*")):
        parts = path.relative_to(root).parts
        if parts[0] in ("clone", "stub") or ".git" in parts:
            continue
        rel = "/".join(parts)
        if path.is_symlink():
            out[rel] = "-> " + os.readlink(path)
        elif path.is_file():
            out[rel] = path.read_bytes().decode("utf-8", "replace").replace(str(root), "<ROOT>")
    return out


def scrub(value, root: Path):
    return json.loads(json.dumps(value, ensure_ascii=True).replace(str(root), "<ROOT>"))


def failure(mode: str, text: str):
    if mode == "ok":
        return None
    if mode == "ValueError":
        return ValueError(text)
    if mode == "DetectorUnavailable":
        from crq_repair import DetectorUnavailable
        return DetectorUnavailable(text)
    if mode == "RuntimeError":
        return RuntimeError(text)
    raise AssertionError(mode)


MECHANICAL_STUB = """
import json, pathlib
from crq_repair import DetectorUnavailable
SPEC = json.loads(pathlib.Path(__file__).with_name('mechanical.json').read_text())
LOG = pathlib.Path(__file__).with_name('calls.log')
def mechanical(config, worktree, predecessor, commits, job_id, directory):
    with LOG.open('a') as handle:
        handle.write('mechanical ' + job_id + '\\n')
    mode = SPEC.get(job_id, 'ok')
    if mode == 'ValueError':
        raise ValueError('mechanical rejected ' + job_id)
    if mode == 'DetectorUnavailable':
        raise DetectorUnavailable('detector down ' + job_id)
"""


def run_python(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        layout(spec, root)
        outbox = ledger_layout(spec, root)
        stub = root / "stub"
        stub.mkdir()
        (stub / "crq_repair.py").write_text(MECHANICAL_STUB)
        (stub / "mechanical.json").write_text(json.dumps(spec.get("mechanical", {})))
        class Calls(list):
            """Stub calls in order; the mechanical stub logs to a file, drained on every append."""
            seen = 0

            def drain(self):
                path = stub / "calls.log"
                if path.exists():
                    lines = path.read_text().splitlines()
                    super().extend(lines[self.seen:])
                    self.seen = len(lines)

            def append(self, value):
                self.drain()
                super().append(value)

        calls = Calls()
        git_answers = spec.get("git", GIT_DEFAULT)

        def git(*args, **_kwargs):
            return git_answers[" ".join(args)]

        def save_queue(_q):
            calls.append("save_queue")

        def make_worktree(name, commit):
            calls.append("make_worktree " + name + " " + commit)
            return root / "wt" / name, "br-" + name

        def remove_worktree(path, branch):
            calls.append("remove_worktree " + str(path).replace(str(root), "<ROOT>") + " " + branch)

        def verify(_worktree, predecessor, commits, job_id):
            calls.append("verify " + job_id + " " + str(predecessor) + " " + ",".join(commits))
            error = failure(spec.get("verify", {}).get(job_id, "ok"), "verify rejected " + job_id)
            if error is not None:
                raise error

        def delivery(_root, expected, **_kwargs):
            job = expected.get("job")
            calls.append("canonical " + str(job))
            mode = spec.get("canonical", {}).get(job, "ok")
            if mode == "mismatch":
                raise ValueError("canonical delivery mismatch for " + str(job))
            if mode == "unavailable":
                raise ValueError("canonical delivery state unavailable: " + str(job))

        def publish(_c, _q, _item, run, _record, fixed):
            calls.append("publish " + run + " " + str(len(fixed)))
            if spec.get("publish", "ok") == "raise":
                raise ValueError("publish rejected " + run)

        def findings(path, *, provenance=False):
            run = Path(path).parent.name
            out = []
            for row in spec.get("findings", {}).get(run, []):
                value = dict(row["finding"])
                if provenance:
                    value["_source"] = dict(row["source"])
                out.append(value)
            return out

        c = SimpleNamespace(
            REPO="o/r", STATE=root, RUNS=root / "runs", LEDGER=root / "ledger", ROOT=stub,
            CONFIG={"repair": {"merged_current": {"enabled": bool(spec.get("merged_current")),
                                                  "unused": 1},
                               "max_rounds_per_pin": spec.get("max_rounds", 2),
                               "max_finding_retries": 2}},
            item_repo=lambda item: item.get("repo") or "o/r", iso=lambda: AT, git=git,
            save_queue=save_queue, make_worktree=make_worktree, remove_worktree=remove_worktree,
            WT_ROOT=root / "worktrees")
        if spec.get("clone"):
            clone = root / "clone"
            clone.mkdir()
            subprocess.run(["git", "init", "--quiet", str(clone)], check=True,
                           env={**os.environ, **GIT_ENV}, capture_output=True)
            c.CLONE = clone
        repair_tick.begin_tick(c, count=spec.get("budget", 25), clock=lambda: 0.0,
                               wall=lambda: spec.get("wall", WALL))
        q = copy.deepcopy(spec["queue"])
        result: dict = {}
        log: list[str] = []

        def phase(name, work):
            nonlocal q
            before = copy.deepcopy(q)
            try:
                work(q)
                result[name] = {"error": None, "queue": copy.deepcopy(q)}
            except BaseException as exc:  # noqa: BLE001 - the class is the datum
                q = before
                result[name] = {"error": type(exc).__name__, "queue": copy.deepcopy(q)}

        def harvest_phase(queue):
            # crq.py:3606-3620, minus the review/receipt branches the seeds never reach.
            for item in list(repair_tick_live(queue)):
                if item["state"] == "reviewing":
                    raise AssertionError("the seeds never reach harvest_review")
                if item["state"] == "addressing":
                    item["state"] = "repair_failed"
                    item["last_error"] = "legacy addressing retained for manual reconciliation; no new dispatch"
                if item.get("repair_runs"):
                    try:
                        log.extend(repair_tick.harvest(c, queue, item))
                    except Exception as exc:
                        key = "repair_error" if item["kind"] == RECEIPT_KIND else "last_error"
                        item[key] = "repair harvest failed: " + str(exc)[:300]

        with mock.patch.object(repair_tick, "findings", findings), \
                mock.patch.object(repair_tick, "require_canonical_delivery", delivery), \
                mock.patch.object(repair_tick, "verify", verify), \
                mock.patch.object(repair_tick, "publish", publish), \
                mock.patch.dict(sys.modules, {}):
            phase("backfill", lambda value: repair_tick.backfill(c, value))
            phase("archive", lambda value: repair_tick.archive_legacy(c, value))
            phase("harvest", harvest_phase)
            if result["harvest"]["error"] is not None:
                log.clear()  # an escaping exception aborts the tick; its partial log is lost
        calls.drain()
        events = []
        if outbox is not None:
            events = [v for v in outbox.retained() if v["source_key"].startswith("repair-outcome:")
                      and not v["source_key"].startswith("repair-outcome:seed-")]
        return scrub({"phases": result, "log": log, "calls": calls, "events": events,
                      "tree": tree(root)}, root)


def repair_tick_live(queue):
    return [item for item in queue["items"] if item.get("kind") != "promotion"]


# ---------------------------------------------------------------- case builders

def finding(n: int) -> dict:
    return {"severity": "major", "path": "f%d.ts" % n, "line": n, "body": "fix %d" % n}


def rows(*numbers):
    return [{"finding": finding(n), "source": {"id": "s%d" % n, "finding_number": n}} for n in numbers]


def open_item(pr: int, **extra) -> dict:
    return {"id": "pr%d" % pr, "kind": "open", "pr": pr, "state": "repairing",
            "cycles": [{"run_id": "r%d" % pr, "findings": 2}], **extra}


def run_files(pr: int, **meta) -> dict:
    return {"meta": {"run_id": "r%d" % pr, "base": "b%d" % pr, "head": "h%d" % pr,
                     "pr_branch": "feat/%d" % pr, "cycle": 1, **meta},
            "review": "{}\n"}


def git_for(*prs, tip="tip0") -> dict:
    out = {"rev-parse origin/main": tip}
    for pr in prs:
        out["rev-list b%d..h%d" % (pr, pr)] = ""
        out["diff b%d h%d" % (pr, pr)] = "DIFF%d" % pr
    return out


def result_doc(job: str, item: str, verdict: str = "NOT-FIXED", **over) -> dict:
    value = {"job": job, "item": item, "verdict": verdict, "reason": "because"}
    value.update(over)
    return value


def fixed_result(job: str, item: str, base_sha: str, root_dir: str | None = None, **over) -> dict:
    value = result_doc(job, item, "FIXED", commits=["a" * 40], repair_base=base_sha,
                       attempts=[{"rung": "A0"}],
                       worktree="{ROOT}/worktrees/crq-repair-%s-%s" % (item, job))
    value.update(over)
    return value


def inbox(job: str, item: str, **over) -> dict:
    value = {"job": job, "item": item, "finding": finding(1), "repair_base": "b0"}
    value.update(over)
    return value


def terminal_record(jobs, state="failed", verdicts=None, **over) -> dict:
    value = {"jobs": list(jobs), "base": "b0", "state": state, "pin": "b0"}
    if verdicts is not None:
        value["verdicts"] = verdicts
    value.update(over)
    return value


def named_cases() -> list[dict]:
    F = FINDING
    cases = []

    def case(name, queue, **extra):
        cases.append({"name": name, "queue": queue, **extra})

    case("empty-queue", {"items": []})
    case("empty-queue-already-backfilled", {"items": [], "legacy_repair_backfilled": "x"})
    case("empty-queue-backfilled-archives", {"items": [], "legacy_repair_backfilled": "x"},
         ledger=["a-findings.md", "b.txt", "c-findings.md"])
    case("one-item-no-cycles", {"items": [{"id": "pr1", "kind": "open", "pr": 1, "state": "done"}]})
    case("one-item-no-evidence-with-findings-count-is-missing",
         {"items": [open_item(1)]}, git=git_for(1))
    case("one-item-no-evidence-without-signal-is-quiet",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1"}]}]})
    case("one-item-signer-run-is-missing",
         {"items": [{**open_item(1), "cycles": [{"run_id": "signer:x"}]}]})
    case("one-item-blocking-is-missing",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1"}], "blocking": [{"run": "r1"}]}]})
    case("one-item-evidence-enqueues", {"items": [open_item(1)]},
         runs={"r1": run_files(1)}, git=git_for(1), findings={"r1": rows(1, 2)})
    case("one-item-evidence-no-findings-is-missing",
         {"items": [open_item(1)]}, runs={"r1": run_files(1)}, git=git_for(1))
    case("one-item-meta-names-another-run",
         {"items": [open_item(1)]}, runs={"r1": run_files(1, run_id="r9")}, git=git_for(1),
         findings={"r1": rows(1)})
    case("one-item-local-review-meta-skipped",
         {"items": [open_item(1)]}, runs={"r1": run_files(1, kind="local-review")}, git=git_for(1))
    case("one-item-local-review-cycle-skipped",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1", "source": "local-review"}]}]})
    case("one-item-foreign-repo-skipped",
         {"items": [{**open_item(1), "repo": "x/y"}]}, runs={"r1": run_files(1)},
         git=git_for(1), findings={"r1": rows(1)})
    case("one-item-main-kind-uses-default-tip",
         {"items": [{**open_item(1), "kind": "main"}]}, runs={"r1": run_files(1)},
         git=git_for(1), findings={"r1": rows(1, 2, 3)})
    case("one-item-own-commits-not-enqueued",
         {"items": [open_item(1)], "repair_own_commits": ["c1"]}, runs={"r1": run_files(1)},
         git={**git_for(1), "rev-list b1..h1": "c1\n"}, findings={"r1": rows(1)})
    case("one-item-round-ceiling",
         {"items": [open_item(1), {**open_item(1), "id": "pr1-delta", "kind": "delta",
                                   "cycles": [{"run_id": "r1d", "findings": 1}]}]},
         runs={"r1": run_files(1), "r1d": run_files(1, run_id="r1d")},
         git={**git_for(1), "rev-list b1..h1": ""}, findings={"r1": rows(1), "r1d": rows(2)},
         max_rounds=1)
    case("one-item-bad-job-id-grammar",
         {"items": [open_item(1, cycles=[{"run_id": "r 1", "findings": 1}])]},
         runs={"r 1": run_files(1, run_id="r 1")}, git=git_for(1), findings={"r 1": rows(1)})
    case("one-item-merged-current-disabled",
         {"items": [{**open_item(1), "kind": "merged-current", "receipt_id": "rc1",
                     "capture": {"target": "t0"}}]},
         runs={"r1": run_files(1)}, git=git_for(1), findings={"r1": rows(1)})
    case("one-item-merged-current-enabled-receipt",
         {"items": [{**open_item(1), "kind": "merged-current", "receipt_id": "rc1",
                     "capture": {"target": "t0"}}]},
         merged_current=True, runs={"r1": run_files(1)}, git=git_for(1), findings={"r1": rows(1)},
         files={"receipts/rc1.json": {"outcome": "terminal-with-findings",
                                      "findings": [{"severity": "major", "path": "f1.ts"}]}})
    case("one-item-merged-current-receipt-missing",
         {"items": [{**open_item(1), "kind": "merged-current", "receipt_id": "rc1",
                     "capture": {"target": "t0"}}]},
         merged_current=True, runs={"r1": run_files(1)}, git=git_for(1), findings={"r1": rows(1)})
    case("many-items-mixed",
         {"items": [open_item(1), open_item(2), {**open_item(3), "kind": "main"},
                    {**open_item(4), "repo": "x/y"}, {"id": "pr5", "kind": "promotion", "state": "done"},
                    {**open_item(6), "cycles": []}]},
         runs={"r1": run_files(1), "r2": run_files(2), "r3": run_files(3), "r4": run_files(4)},
         git=git_for(1, 2, 3, 4), findings={"r1": rows(1), "r2": rows(1, 2), "r3": rows(3)})
    case("many-items-all-quiet-backfills-and-archives",
         {"items": [{"id": "pr%d" % n, "kind": "open", "pr": n, "state": "done", "cycles": []}
                    for n in range(1, 7)]},
         ledger=["x-findings.md"])
    case("archive-blocked-by-open-record",
         {"items": [{**open_item(1), "repair_runs": {"r1": terminal_record(["j"], "queued")}}],
          "legacy_repair_backfilled": "x"}, ledger=["x-findings.md"])
    case("archive-allowed-when-all-terminal",
         {"items": [{**open_item(1), "repair_runs": {"r1": terminal_record(["j"], "done")}}],
          "legacy_repair_backfilled": "x"}, ledger=["x-findings.md"])
    case("archive-already-archived",
         {"items": [], "legacy_repair_backfilled": "x", "legacy_ledger_archived": "y"},
         ledger=["x-findings.md"])
    case("archive-skipped-while-missing-nonempty",
         {"items": [], "legacy_repair_backfilled": "x", "legacy_repair_missing": [{"item": "i"}]},
         ledger=["x-findings.md"])
    # ---- error classes the passes let escape
    case("error-cycles-not-a-list", {"items": [{**open_item(1), "cycles": "abc"}]})
    case("error-cycles-dict", {"items": [{**open_item(1), "cycles": {"run_id": "r1"}}]})
    case("error-cycle-without-run-id", {"items": [{**open_item(1), "cycles": [{"findings": 1}]}]})
    case("error-cycle-not-a-dict", {"items": [{**open_item(1), "cycles": [5]}]})
    case("error-run-id-not-a-string", {"items": [{**open_item(1), "cycles": [{"run_id": 5}]}]})
    case("error-item-without-id-missing-evidence",
         {"items": [{"kind": "open", "pr": 1, "state": "done", "cycles": [{"run_id": "r1", "findings": 1}]}]})
    case("error-item-not-a-dict", {"items": [5]})
    case("error-items-key-missing", {})
    case("error-meta-malformed-json",
         {"items": [open_item(1)]}, runs={"r1": {"meta": "{", "review": "{}\n"}}, git=git_for(1))
    case("error-meta-not-a-dict",
         {"items": [open_item(1)]}, runs={"r1": {"meta": [1], "review": "{}\n"}}, git=git_for(1))
    case("error-meta-non-utf8",
         {"items": [open_item(1)]},
         runs={"r1": {"meta": bytes_doc(b'{"run_id":"r1","base":"b\xff"}'), "review": "{}\n"}},
         git=git_for(1))
    case("error-meta-without-base",
         {"items": [open_item(1)]},
         runs={"r1": {"meta": {"run_id": "r1", "head": "h1"}, "review": "{}\n"}},
         findings={"r1": rows(1)})
    case("error-git-unanswered",
         {"items": [open_item(1)]}, runs={"r1": run_files(1)}, git={}, findings={"r1": rows(1)})
    case("error-repair-runs-not-a-dict",
         {"items": [{**open_item(1), "repair_runs": [1]}], "legacy_repair_backfilled": "x"})
    case("error-repair-record-not-a-dict",
         {"items": [{**open_item(1), "repair_runs": {"r1": "x"}}], "legacy_repair_backfilled": "x"})
    case("error-repair-record-without-state",
         {"items": [{**open_item(1), "repair_runs": {"r1": {"jobs": []}}}],
          "legacy_repair_backfilled": "x"})
    # ---- truthiness
    case("truthy-backfilled-zero-is-not-backfilled", {"items": [], "legacy_repair_backfilled": 0})
    case("truthy-backfilled-empty-string", {"items": [], "legacy_repair_backfilled": ""})
    case("truthy-backfilled-empty-list-is-false", {"items": [], "legacy_repair_backfilled": []})
    case("truthy-backfilled-one-is-true", {"items": [], "legacy_repair_backfilled": 1},
         ledger=["x-findings.md"])
    case("truthy-backfilled-float-zero", {"items": [], "legacy_repair_backfilled": 0.0})
    case("truthy-missing-empty-list-is-false",
         {"items": [], "legacy_repair_backfilled": "x", "legacy_repair_missing": []},
         ledger=["x-findings.md"])
    case("truthy-missing-zero-is-false",
         {"items": [], "legacy_repair_backfilled": "x", "legacy_repair_missing": 0},
         ledger=["x-findings.md"])
    case("truthy-missing-dict-blocks",
         {"items": [], "legacy_repair_backfilled": "x", "legacy_repair_missing": {"a": 1}},
         ledger=["x-findings.md"])
    case("truthy-cycle-findings-zero-is-quiet",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1", "findings": 0}]}]})
    case("truthy-cycle-severity-counts-empty-dict-is-quiet",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1", "severity_counts": {}}]}]})
    case("truthy-cycle-severity-counts-nonempty-is-missing",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1", "severity_counts": {"major": 1}}]}]})
    case("truthy-item-last-error-empty-uses-default-reason",
         {"items": [{**open_item(1), "last_error": ""}]}, runs={"r1": run_files(1)}, git=git_for(1),
         findings={"r1": rows(1)}, own=True)
    case("truthy-existing-run-id-int-vs-str-meta",
         {"items": [open_item(1)]}, runs={"r1": run_files(1, run_id=1)}, git=git_for(1))
    case("truthy-cycle-source-non-string",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r1", "source": ["local-review"]}]}]})
    case("fidelity-run-id-unicode",
         {"items": [{**open_item(1), "cycles": [{"run_id": "ré", "findings": 1}]}]},
         runs={"ré": run_files(1, run_id="ré")}, git=git_for(1),
         findings={"ré": rows(1)})
    case("fidelity-run-id-line-separator",
         {"items": [{**open_item(1), "cycles": [{"run_id": "r x", "findings": 1}]}]},
         git=git_for(1))
    case("fidelity-rev-list-splitlines-form-feed",
         {"items": [open_item(1)], "repair_own_commits": ["c1", "c2"]}, runs={"r1": run_files(1)},
         git={**git_for(1), "rev-list b1..h1": "c1\x0cc2\n"}, findings={"r1": rows(1)})
    case("fidelity-rev-list-splitlines-crlf",
         {"items": [open_item(1)], "repair_own_commits": ["c1", "c2"]}, runs={"r1": run_files(1)},
         git={**git_for(1), "rev-list b1..h1": "c1\r\nc2\r\n"}, findings={"r1": rows(1)})
    case("fidelity-queue-float-and-large-int",
         {"items": [{**open_item(1), "cycles": [], "score": 1.0, "big": 12345678901234567890,
                     "neg": -0.0, "exp": 1e21}]})
    case("fidelity-queue-unicode-and-key-order",
         {"z": 1, "items": [{"state": "done", "id": "pé", "kind": "open", "cycles": []}], "a": 2})

    # ---- harvest: open runs (no ledger rows, no stubs needed)
    def hv(name, record, results=None, jobs_inbox=None, item=None, **extra):
        item_id = "pr7"
        files = {}
        jobs = record.get("jobs", []) if isinstance(record, dict) else []
        for n, job in enumerate(jobs):
            if isinstance(job, str):
                files["repair/inbox/%s.json" % job] = (jobs_inbox or {}).get(job, inbox(job, item_id))
        for job, doc in (results or {}).items():
            files["repair/%s/result.json" % job] = doc
        for key, doc in (jobs_inbox or {}).items():
            files["repair/inbox/%s.json" % key] = doc
        queue_item = item or {"id": item_id, "kind": "open", "pr": 7, "state": "repairing",
                              "repair_runs": {"run-1": record}}
        case(name, {"items": [queue_item], "legacy_repair_backfilled": "x"},
             files={**files, **extra.pop("files", {})}, **extra)

    J1, J2 = "crq-run-1-F1", "crq-run-1-F2"
    open_record = {"jobs": [J1], "base": "b0", "state": "queued", "pin": "b0"}
    hv("harvest-no-result-yet-stays-queued", open_record)
    hv("harvest-not-fixed-done", open_record, results={J1: result_doc(J1, "pr7")})
    hv("harvest-failed-terminal", open_record, results={J1: result_doc(J1, "pr7", "FAILED")})
    hv("harvest-stale-done", open_record, results={J1: result_doc(J1, "pr7", "STALE")})
    hv("harvest-unknown-verdict-terminal", open_record, results={J1: result_doc(J1, "pr7", "WEIRD")})
    hv("harvest-lowercase-verdict-terminal", open_record, results={J1: result_doc(J1, "pr7", "fixed")})
    hv("harvest-retry-after-waits", open_record,
       results={J1: result_doc(J1, "pr7", retry_after="soon")})
    hv("harvest-retry-after-zero-proceeds", open_record,
       results={J1: result_doc(J1, "pr7", retry_after=0)})
    hv("harvest-result-identity-mismatch", open_record, results={J1: result_doc("other", "pr7")})
    hv("harvest-result-item-mismatch", open_record, results={J1: result_doc(J1, "other")})
    hv("harvest-result-malformed-json", open_record, results={J1: "{not json"})
    hv("harvest-result-non-utf8", open_record, results={J1: bytes_doc(b'{"job":"\xff"}')})
    hv("harvest-result-bom", open_record, results={J1: "﻿" + json.dumps(result_doc(J1, "pr7"))})
    hv("harvest-result-nan-reason", open_record,
       results={J1: '{"job":"%s","item":"pr7","verdict":"NOT-FIXED","reason":"r","x":NaN}' % J1})
    hv("harvest-result-list", open_record, results={J1: [1]})
    hv("harvest-result-null", open_record, results={J1: None})
    hv("harvest-result-reason-int", open_record, results={J1: result_doc(J1, "pr7", reason=5)})
    hv("harvest-result-reason-missing", open_record,
       results={J1: {"job": J1, "item": "pr7", "verdict": "NOT-FIXED"}})
    hv("harvest-source-binding-mismatch", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={J1: inbox(J1, "pr7", source_sha="s", finding_sha256="f", origin_job="o")})
    hv("harvest-source-binding-match", open_record,
       results={J1: result_doc(J1, "pr7", source_sha="s", finding_sha256="f", origin_job="o")},
       jobs_inbox={J1: inbox(J1, "pr7", source_sha="s", finding_sha256="f", origin_job="o")})
    hv("harvest-inbox-missing", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={})
    cases[-1]["files"].pop("repair/inbox/%s.json" % J1)
    hv("harvest-inbox-malformed", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={J1: "{"})
    # The rest of the malformed-inbox family (deviation 5): Python lets the error escape
    # into last_error, TS terminalises the run. One seed per shape.
    for nm, doc in (("list", [1, 2]), ("scalar", 7), ("null", None),
                    ("non-utf8", bytes_doc(b'{"job":"\xff"}')),
                    ("bom", bytes_doc(b'\xef\xbb\xbf{"job":"x"}'))):
        hv("harvest-inbox-%s" % nm, open_record, results={J1: result_doc(J1, "pr7")},
           jobs_inbox={J1: doc})
    # The identity guard (PR #2241 F9/F10): Python harvests a swapped inbox normally.
    hv("harvest-inbox-job-swapped", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={J1: inbox("crq-else", "pr7")})
    hv("harvest-inbox-item-differs", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={J1: inbox(J1, "pr-other")})
    hv("harvest-inbox-without-finding", open_record, results={J1: result_doc(J1, "pr7")},
       jobs_inbox={J1: {"job": J1, "item": "pr7"}})
    hv("harvest-job-id-outside-grammar", {"jobs": ["../x"], "base": "b0", "state": "queued"},
       results={})
    hv("harvest-job-id-not-string", {"jobs": [5], "base": "b0", "state": "queued"})
    hv("harvest-record-without-base", {"jobs": [J1], "state": "queued"},
       results={J1: result_doc(J1, "pr7")})
    hv("harvest-record-without-jobs", {"base": "b0", "state": "queued"})
    hv("harvest-record-empty-jobs", {"jobs": [], "base": "b0", "state": "queued"})
    hv("harvest-record-state-unknown-ignored", {"jobs": [J1], "base": "b0", "state": "weird"})
    hv("harvest-record-state-not-string", {"jobs": [J1], "base": "b0", "state": 5})
    hv("harvest-two-jobs-second-pending",
       {"jobs": [J1, J2], "base": "b0", "state": "queued"}, results={J1: result_doc(J1, "pr7")})
    hv("harvest-two-jobs-both-done",
       {"jobs": [J1, J2], "base": "b0", "state": "ready"},
       results={J1: result_doc(J1, "pr7"), J2: result_doc(J2, "pr7")})
    hv("harvest-two-jobs-one-failed",
       {"jobs": [J1, J2], "base": "b0", "state": "publish_failed"},
       results={J1: result_doc(J1, "pr7"), J2: result_doc(J2, "pr7", "FAILED")})
    hv("harvest-two-runs", {"jobs": [J1], "base": "b0", "state": "queued"},
       results={J1: result_doc(J1, "pr7")},
       item={"id": "pr7", "kind": "open", "pr": 7, "state": "repairing",
             "repair_runs": {"run-1": {"jobs": [J1], "base": "b0", "state": "queued"},
                             "run-2": {"jobs": ["crq-run-2-F1"], "base": "b0", "state": "queued"}}},
       files={"repair/inbox/crq-run-2-F1.json": inbox("crq-run-2-F1", "pr7"),
              "repair/crq-run-2-F1/result.json": result_doc("crq-run-2-F1", "pr7", "STALE")})
    hv("harvest-item-state-done-not-rewritten", open_record,
       results={J1: result_doc(J1, "pr7")},
       item={"id": "pr7", "kind": "open", "pr": 7, "state": "done",
             "repair_runs": {"run-1": open_record}})
    hv("harvest-receipt-kind-terminal", open_record, results={J1: result_doc(J1, "pr7", "FAILED")},
       item={"id": "pr7", "kind": "merged-current", "state": "repairing",
             "repair_runs": {"run-1": open_record}})
    hv("harvest-item-without-state-key", open_record, results={J1: result_doc(J1, "pr7")},
       item={"id": "pr7", "kind": "open", "pr": 7, "repair_runs": {"run-1": open_record}})
    hv("harvest-item-without-kind-key", open_record, results={J1: result_doc(J1, "pr7")},
       item={"id": "pr7", "state": "repairing", "repair_runs": {"run-1": open_record}})
    hv("harvest-addressing-item-moved-to-repair-failed", open_record,
       item={"id": "pr7", "kind": "open", "state": "addressing", "repair_runs": {"run-1": open_record}})
    hv("harvest-promotion-item-not-live", open_record, results={J1: result_doc(J1, "pr7")},
       item={"id": "pr7", "kind": "promotion", "state": "repairing",
             "repair_runs": {"run-1": open_record}})
    hv("harvest-repair-runs-empty-dict-not-visited", open_record,
       item={"id": "pr7", "kind": "open", "state": "repairing", "repair_runs": {}})
    hv("harvest-repair-runs-list-error", open_record,
       item={"id": "pr7", "kind": "open", "state": "repairing", "repair_runs": [1]})
    hv("harvest-repair-runs-string-error", open_record,
       item={"id": "pr7", "kind": "open", "state": "repairing", "repair_runs": "x"})
    # ---- FIXED: validation, then the stubbed worktree/verify/mechanical/publish
    fx = fixed_result(J1, "pr7", "b0")
    hv("fixed-published", open_record, results={J1: fx})
    hv("fixed-publish-raises", open_record, results={J1: fx}, publish="raise")
    hv("fixed-no-commits", open_record, results={J1: fixed_result(J1, "pr7", "b0", commits=[])})
    hv("fixed-bad-commit-sha", open_record, results={J1: fixed_result(J1, "pr7", "b0", commits=["xyz"])})
    hv("fixed-commit-non-string", open_record, results={J1: fixed_result(J1, "pr7", "b0", commits=[5])})
    hv("fixed-commits-not-list", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", commits="a" * 40)})
    hv("fixed-commit-newline-suffix-not-full-match", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", commits=["a" * 40 + "\n"])})
    hv("fixed-bad-rung", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", attempts=[{"rung": "B0"}])})
    hv("fixed-no-attempts", open_record, results={J1: fixed_result(J1, "pr7", "b0", attempts=[])})
    hv("fixed-attempts-not-list", open_record, results={J1: fixed_result(J1, "pr7", "b0", attempts={})})
    hv("fixed-attempt-not-dict", open_record, results={J1: fixed_result(J1, "pr7", "b0", attempts=[1])})
    hv("fixed-worktree-outside", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", worktree="{ROOT}/elsewhere/crq-repair-pr7")})
    hv("fixed-worktree-legacy-name", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", worktree="{ROOT}/worktrees/crq-repair-pr7")})
    hv("fixed-worktree-a2", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", worktree="{ROOT}/worktrees/crq-repair-pr7-%s-A2" % J1)})
    hv("fixed-worktree-missing-key", open_record,
       results={J1: {k: v for k, v in fx.items() if k != "worktree"}})
    hv("fixed-worktree-not-string", open_record, results={J1: fixed_result(J1, "pr7", "b0", worktree=5)})
    hv("fixed-worktree-nul", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", worktree="{ROOT}/worktrees/a\u0000b")})
    hv("fixed-worktree-dotdot", open_record,
       results={J1: fixed_result(J1, "pr7", "b0",
                                 worktree="{ROOT}/worktrees/../worktrees/crq-repair-pr7-%s" % J1)})
    hv("fixed-predecessor-mismatch", open_record,
       results={J1: fixed_result(J1, "pr7", "other")})
    hv("fixed-reason-not-string", open_record, results={J1: fixed_result(J1, "pr7", "b0", reason=None)})
    hv("fixed-verify-rejects", open_record, results={J1: fx}, verify={J1: "ValueError"})
    hv("fixed-verify-detector-unavailable", open_record, results={J1: fx},
       verify={J1: "DetectorUnavailable"})
    hv("fixed-verify-runtime-error", open_record, results={J1: fx}, verify={J1: "RuntimeError"})
    hv("fixed-mechanical-rejects", open_record, results={J1: fx}, mechanical={J1: "ValueError"})
    hv("fixed-mechanical-detector-unavailable", open_record, results={J1: fx},
       mechanical={J1: "DetectorUnavailable"})
    hv("fixed-chain-two-jobs-predecessor-advances",
       {"jobs": [J1, J2], "base": "b0", "state": "queued"},
       results={J1: fx, J2: fixed_result(J2, "pr7", "a" * 40, commits=["b" * 40])})
    hv("fixed-chain-second-wrong-predecessor",
       {"jobs": [J1, J2], "base": "b0", "state": "queued"},
       results={J1: fx, J2: fixed_result(J2, "pr7", "b0", commits=["b" * 40])})
    hv("fixed-mixed-with-failed-sibling",
       {"jobs": [J1, J2], "base": "b0", "state": "queued"},
       results={J1: fx, J2: result_doc(J2, "pr7", "FAILED")})
    hv("fixed-canonical-mismatch-stales-run", open_record, results={J1: fx}, canonical={J1: "mismatch"})
    hv("fixed-canonical-unavailable-retries", open_record, results={J1: fx}, canonical={J1: "unavailable"})
    hv("fixed-dry-wt-unreached-on-bad-commits", open_record,
       results={J1: fixed_result(J1, "pr7", "b0", commits=[])}, canonical={J1: "mismatch"})
    return cases


def ledger_cases() -> list[dict]:
    """Terminal-failed, unpublished-sibling and finding-outcome cases over a real ledger."""
    cases = []
    A, B = "crq-run-1-F1", "crq-run-1-F2"
    item_id = "pr7"
    fid = FINDING

    def lcase(name, record, results=None, jobs_inbox=None, row_task=A, item_extra=None, **extra):
        files = {}
        for job in record.get("jobs", []):
            if isinstance(job, str):
                files["repair/inbox/%s.json" % job] = inbox(job, item_id, canonical_finding_id=fid,
                                                            review_id=base.REVIEW)
        files.update({"repair/inbox/%s.json" % k: v for k, v in (jobs_inbox or {}).items()})
        for job, doc in (results or {}).items():
            files["repair/%s/result.json" % job] = doc
        item = {"id": item_id, "kind": "open", "pr": 7, "state": "repair_failed",
                "repair_runs": {"run-1": record}, **(item_extra or {})}
        cases.append({"name": name, "queue": {"items": [item], "legacy_repair_backfilled": "x"},
                      "files": files, "finding_ledger": True, "row_task": row_task, **extra})

    invalid = lambda job, reason="invalid repair result: bad": {  # noqa: E731
        "job": job, "item": item_id, "verdict": "FAILED", "reason": reason, "finding": finding(1)}
    failed = lambda jobs, verdicts, **over: terminal_record(jobs, "failed", verdicts, **over)  # noqa: E731

    # open runs that terminalize through a real ledger write
    open_record = {"jobs": [A], "base": "b0", "state": "queued", "pin": "b0"}
    lcase("ledger-failed-result-writes-retriage", open_record,
          results={A: result_doc(A, item_id, "FAILED")})
    lcase("ledger-failed-owner-decision-needs-human", open_record,
          results={A: result_doc(A, item_id, "FAILED", failure_class="owner-decision")})
    lcase("ledger-not-fixed-with-evidence-dismisses", open_record,
          results={A: result_doc(A, item_id, "NOT-FIXED", unchanged_evidence="seen")})
    lcase("ledger-not-fixed-without-evidence-retriages", open_record,
          results={A: result_doc(A, item_id, "NOT-FIXED")})
    lcase("ledger-stale-retriages", open_record, results={A: result_doc(A, item_id, "STALE")})
    lcase("ledger-row-bound-to-newer-job-preserved", open_record,
          results={A: result_doc(A, item_id, "FAILED")}, row_task="crq-newer")
    lcase("ledger-no-triage-binding", open_record, results={A: result_doc(A, item_id, "FAILED")},
          row_task=None)
    lcase("ledger-invalid-result-terminal-failure-writes-outcome", open_record,
          results={A: result_doc("other", item_id)})
    lcase("ledger-invalid-result-save-queue-ordering", open_record,
          results={A: {"job": A, "item": item_id, "verdict": "FIXED", "commits": []}})
    lcase("ledger-two-jobs-first-ok-second-malformed",
          {"jobs": [A, B], "base": "b0", "state": "queued"},
          results={A: result_doc(A, item_id, "FAILED"), B: "{"})
    lcase("ledger-no-rollout-file-value-error", open_record,
          results={A: result_doc(A, item_id, "FAILED")}, no_rollout=True)
    lcase("ledger-job-without-finding-id-noop", open_record,
          results={A: result_doc(A, item_id, "FAILED")},
          jobs_inbox={A: inbox(A, item_id)})
    lcase("ledger-finding-id-falsy-noop", open_record,
          results={A: result_doc(A, item_id, "FAILED")},
          jobs_inbox={A: inbox(A, item_id, canonical_finding_id="")})
    lcase("ledger-finding-id-int-type-error", open_record,
          results={A: result_doc(A, item_id, "FAILED")},
          jobs_inbox={A: inbox(A, item_id, canonical_finding_id=5)})
    lcase("ledger-finding-id-unknown-row-missing", open_record,
          results={A: result_doc(A, item_id, "FAILED")},
          jobs_inbox={A: inbox(A, item_id, canonical_finding_id="d" * 64)})
    lcase("ledger-failure-class-non-string-normalizes", open_record,
          results={A: result_doc(A, item_id, "FAILED", failure_class=5)})
    lcase("ledger-reason-empty-uses-verdict", open_record,
          results={A: result_doc(A, item_id, "FAILED", reason="")})
    lcase("ledger-fixed-writes-nothing-then-publishes", open_record,
          results={A: fixed_result(A, item_id, "b0")})
    # terminal-failed replay (the ledger write failed before the flag was set)
    lcase("replay-failed-run-writes-outcome-and-flags", failed([A], [invalid(A)]))
    lcase("replay-failed-run-already-settled-skips", failed([A], [invalid(A)], siblings_recorded=[A]))
    lcase("replay-failed-run-settled-extra-string-ignored",
          failed([A], [invalid(A)], siblings_recorded=[A, "zzz", 5]))
    lcase("replay-failed-run-settled-not-a-list",
          failed([A], [invalid(A)], siblings_recorded="crq-run-1-F1"))
    lcase("replay-failed-run-recorded-null",
          failed([A], [invalid(A)], siblings_recorded=None))
    lcase("replay-failed-run-non-string-job-ignored-by-settled",
          failed([A, 5], [invalid(A)], siblings_recorded=[A]))
    lcase("replay-verdict-not-invalid-prefix-skipped", failed([A], [invalid(A, "plain failure")]))
    lcase("replay-verdict-reason-missing-skipped",
          failed([A], [{"job": A, "item": item_id, "verdict": "FAILED"}]))
    lcase("replay-verdict-reason-not-string-error",
          failed([A], [{"job": A, "item": item_id, "verdict": "FAILED", "reason": 5}]))
    lcase("replay-verdict-job-not-in-jobs-identity-error", failed([A], [invalid("crq-other-F1")]))
    lcase("replay-verdict-item-mismatch-identity-error",
          failed([A], [{**invalid(A), "item": "other"}]))
    lcase("replay-inbox-identity-mismatch-error", failed([A], [invalid(A)]),
          jobs_inbox={A: inbox("crq-else", item_id, canonical_finding_id=fid)})
    lcase("replay-inbox-missing-file-error", failed([A], [invalid(A)]), drop_inbox=[A])
    lcase("replay-verdicts-non-dict-entries-error", failed([A], ["x"]))
    lcase("replay-verdicts-not-a-list", failed([A], {"a": 1}))
    lcase("replay-no-canonical-id-flags-without-write", failed([A], [invalid(A)]),
          jobs_inbox={A: inbox(A, item_id)})
    lcase("replay-save-queue-then-outcome", failed([A], [invalid(A)]))
    # unpublished siblings
    sibling = lambda: {"jobs": [A, B], "base": "b0", "state": "failed",  # noqa: E731
                       "verdicts": [invalid(A)]}
    lcase("sibling-fixed-needs-human", sibling(), results={B: fixed_result(B, item_id, "b0")},
          row_task=B)
    lcase("sibling-fixed-row-bound-to-other-task-preserved", sibling(),
          results={B: fixed_result(B, item_id, "b0")}, row_task="crq-newer")
    lcase("sibling-not-fixed-records-own-verdict", sibling(), results={B: result_doc(B, item_id)},
          row_task=B)
    lcase("sibling-failed-owner-decision", sibling(),
          results={B: result_doc(B, item_id, "FAILED", failure_class="owner-decision")}, row_task=B)
    lcase("sibling-unreadable-stays-unrecorded", sibling())
    lcase("sibling-result-malformed-stays-unrecorded", sibling(), results={B: "{"})
    lcase("sibling-result-not-dict-skipped", sibling(), results={B: [1]})
    lcase("sibling-inbox-malformed-skipped", sibling(), results={B: result_doc(B, item_id)},
          jobs_inbox={B: "{"})
    lcase("sibling-no-finding-id-flags-done", sibling(), results={B: result_doc(B, item_id)},
          jobs_inbox={B: inbox(B, item_id)})
    lcase("sibling-identity-mismatch-records-failure", sibling(),
          results={B: result_doc("other", item_id)}, row_task=B)
    lcase("sibling-item-mismatch-records-failure", sibling(),
          results={B: result_doc(B, "other")}, row_task=B)
    lcase("sibling-source-binding-mismatch-records-failure", sibling(),
          results={B: result_doc(B, item_id)}, row_task=B,
          jobs_inbox={B: inbox(B, item_id, canonical_finding_id=fid, review_id=base.REVIEW,
                               source_sha="s")})
    lcase("sibling-unknown-verdict-flags-without-write", sibling(),
          results={B: result_doc(B, item_id, "WEIRD")}, row_task=B)
    lcase("sibling-ledger-write-fails-first-error-raised", sibling(),
          results={B: result_doc(B, item_id, "FAILED")}, row_task=B, no_rollout=True)
    lcase("sibling-two-siblings-one-fails-other-recorded",
          {"jobs": [A, B, "crq-run-1-F3"], "base": "b0", "state": "failed", "verdicts": [invalid(A)]},
          results={B: result_doc(B, item_id, "FAILED"),
                   "crq-run-1-F3": result_doc("crq-run-1-F3", item_id, "STALE")},
          jobs_inbox={B: inbox(B, item_id, canonical_finding_id="d" * 64),
                      "crq-run-1-F3": inbox("crq-run-1-F3", item_id, canonical_finding_id=fid)},
          row_task="crq-run-1-F3")
    # replay budget
    two = {"items": [
        {"id": "pr7", "kind": "open", "state": "repair_failed",
         "repair_runs": {"run-1": failed([A], [invalid(A)])}},
        {"id": "pr8", "kind": "open", "state": "repair_failed",
         "repair_runs": {"run-2": failed(["crq-run-2-F1"], [{**invalid("crq-run-2-F1"), "item": "pr8"}])}}],
        "legacy_repair_backfilled": "x"}
    two_files = {"repair/inbox/%s.json" % A: inbox(A, "pr7", canonical_finding_id=fid),
                 "repair/inbox/crq-run-2-F1.json": inbox("crq-run-2-F1", "pr8", canonical_finding_id=fid)}
    for name, extra in [
            ("budget-one-replay-then-announces", {"budget": 1}),
            ("budget-zero-announces-once", {"budget": 0}),
            ("budget-two-replays-both", {"budget": 2}),
            ("budget-default", {})]:
        cases.append({"name": name, "queue": copy.deepcopy(two), "files": two_files,
                      "finding_ledger": True, "row_task": A, **extra})
    recent = copy.deepcopy(two)
    recent["items"][0]["repair_runs"]["run-1"]["replay_attempted"] = WALL - 10
    cases.append({"name": "budget-recent-attempt-skipped-no-budget-spent", "queue": recent,
                  "files": two_files, "finding_ledger": True, "row_task": A, "budget": 1})
    old = copy.deepcopy(two)
    old["items"][0]["repair_runs"]["run-1"]["replay_attempted"] = WALL - 5000
    cases.append({"name": "budget-old-attempt-retried", "queue": old, "files": two_files,
                  "finding_ledger": True, "row_task": A})
    future = copy.deepcopy(two)
    future["items"][0]["repair_runs"]["run-1"]["replay_attempted"] = WALL + 100
    cases.append({"name": "budget-future-attempt-retried", "queue": future, "files": two_files,
                  "finding_ledger": True, "row_task": A})
    for label, value in [("bool-true", True), ("string", "yesterday"), ("null", None), ("list", [1])]:
        trap = copy.deepcopy(two)
        trap["items"][0]["repair_runs"]["run-1"]["replay_attempted"] = value
        cases.append({"name": "budget-attempt-" + label, "queue": trap, "files": two_files,
                      "finding_ledger": True, "row_task": A, "wall": 500.5})
    same_instant = copy.deepcopy(two)
    same_instant["items"][0]["repair_runs"]["run-1"]["replay_attempted"] = WALL
    cases.append({"name": "budget-attempt-same-instant-skipped", "queue": same_instant,
                  "files": two_files, "finding_ledger": True, "row_task": A})
    # cleanup (real `cleanup_harvested` over a clone with no worktree)
    cases.append({"name": "cleanup-terminal-run-with-clone-no-worktree",
                  "queue": {"items": [{"id": "pr7", "kind": "open", "state": "repairing",
                                       "repair_runs": {"run-1": {
                                           "jobs": [A], "base": "b0", "state": "done",
                                           "verdicts": [result_doc(A, "pr7")]}}}],
                            "legacy_repair_backfilled": "x"}, "clone": True})
    cases.append({"name": "cleanup-verdict-job-outside-grammar-skipped",
                  "queue": {"items": [{"id": "pr7", "kind": "open", "state": "repairing",
                                       "repair_runs": {"run-1": {
                                           "jobs": [A], "base": "b0", "state": "done",
                                           "verdicts": [result_doc("../x", "pr7"), "str",
                                                        result_doc(5, "pr7"), {"verdict": "FIXED"}]}}}],
                            "legacy_repair_backfilled": "x"}, "clone": True})
    cases.append({"name": "cleanup-result-worktree-names-existing-dir",
                  "queue": {"items": [{"id": "pr7", "kind": "open", "state": "repairing",
                                       "repair_runs": {"run-1": {
                                           "jobs": [A], "base": "b0", "state": "done",
                                           "verdicts": [fixed_result(A, "pr7", "b0")]}}}],
                            "legacy_repair_backfilled": "x"},
                  "clone": True,
                  "files": {"worktrees/crq-repair-pr7-%s/marker" % A: "x"}})
    cases.append({"name": "cleanup-without-clone-skipped",
                  "queue": {"items": [{"id": "pr7", "kind": "open", "state": "repairing",
                                       "repair_runs": {"run-1": {
                                           "jobs": [A], "base": "b0", "state": "done",
                                           "verdicts": [result_doc(A, "pr7")]}}}],
                            "legacy_repair_backfilled": "x"}})
    cases.append({"name": "cleanup-failed-run-with-clone-and-replay",
                  "queue": {"items": [{"id": "pr7", "kind": "open", "state": "repair_failed",
                                       "repair_runs": {"run-1": failed([A], [invalid(A)])}}],
                            "legacy_repair_backfilled": "x"},
                  "files": {"repair/inbox/%s.json" % A: inbox(A, "pr7", canonical_finding_id=fid)},
                  "finding_ledger": True, "row_task": A, "clone": True})
    return cases


def generated(seed: int) -> dict:
    """A seeded pipeline: legacy cycles -> backfill enqueues jobs -> results -> harvest."""
    rng = random.Random(seed)
    items, runs, git, finds, files, canonical, verify, mechanical = [], {}, {}, {}, {}, {}, {}, {}
    prs = list(range(20, 20 + rng.randint(1, 4)))
    git["rev-parse origin/main"] = "tip%d" % rng.randint(0, 9)
    for pr in prs:
        kind = rng.choice(["open", "open", "main", "delta"])
        item = {"id": "pr%d" % pr, "kind": kind, "pr": pr, "state": rng.choice(["repairing", "done", "pending"]),
                "cycles": [{"run_id": "r%d" % pr, "findings": rng.randint(0, 2)}]}
        if rng.random() < 0.15:
            item["repo"] = "x/y"
        if rng.random() < 0.1:
            item["cycles"].append({"run_id": "g%d" % pr, "source": "local-review"})
        items.append(item)
        evidence = rng.random() < 0.85
        if evidence:
            meta = {"run_id": "r%d" % pr, "base": "b%d" % pr, "head": "h%d" % pr,
                    "pr_branch": "feat/%d" % pr if rng.random() < 0.8 else None, "cycle": rng.randint(1, 3)}
            if rng.random() < 0.15:
                meta["pr_head"] = "p%d" % pr
            if rng.random() < 0.08:
                meta["run_id"] = "other"
            runs["r%d" % pr] = {"meta": meta, "review": "{}\n"}
            head = meta.get("pr_head", meta["head"])
            git["rev-list b%d..%s" % (pr, head)] = rng.choice(["", "", "c1\n"])
            git["diff b%d h%d" % (pr, pr)] = "DIFF%d" % pr
            count = rng.randint(0, 3)
            finds["r%d" % pr] = rows(*range(1, count + 1))
            is_open = kind in ("open", "delta") and bool(meta.get("pr_branch"))
            predecessor = head if is_open else git["rev-parse origin/main"]
            for n in range(1, count + 1):
                job = "crq-r%d-F%d" % (pr, n)
                roll = rng.random()
                if roll < 0.2:
                    continue
                if roll < 0.55:
                    verdict = rng.choice(["NOT-FIXED", "FAILED", "STALE"])
                    doc = result_doc(job, "pr%d" % pr, verdict)
                elif roll < 0.85:
                    doc = fixed_result(job, "pr%d" % pr, predecessor)
                    if rng.random() < 0.3:
                        doc[rng.choice(["commits", "attempts", "worktree", "repair_base", "reason"])] = \
                            rng.choice([None, [], "x", 5, {}])
                    predecessor = "a" * 40
                    if rng.random() < 0.3:
                        verify[job] = rng.choice(["ValueError", "DetectorUnavailable", "RuntimeError"])
                    if rng.random() < 0.2:
                        mechanical[job] = rng.choice(["ValueError", "DetectorUnavailable"])
                elif roll < 0.92:
                    doc = rng.choice(["{", "[1]", "null", "7"])
                else:
                    doc = result_doc(rng.choice(["x", job]), rng.choice(["pr%d" % pr, "z"]),
                                     rng.choice(["FIXED", "NOT-FIXED"]))
                files["repair/%s/result.json" % job] = doc
                if rng.random() < 0.15:
                    canonical[job] = rng.choice(["mismatch", "unavailable"])
        if rng.random() < 0.2:
            item["repair_runs"] = {"old": terminal_record(["crq-old-F1"], rng.choice(
                ["done", "stale", "published", "failed", "queued"]))}
    queue = {"items": items}
    if rng.random() < 0.15:
        queue["legacy_repair_backfilled"] = rng.choice(["x", 0, "", 1])
    return {"name": "seed-%03d" % seed, "queue": queue, "runs": runs, "git": git, "findings": finds,
            "files": files, "canonical": canonical, "verify": verify, "mechanical": mechanical,
            "publish": rng.choice(["ok", "ok", "raise"]), "budget": rng.choice([0, 1, 25]),
            "ledger": rng.choice([[], ["a-findings.md"]]), "max_rounds": rng.choice([1, 2, 3]),
            "merged_current": rng.random() < 0.3, "clone": rng.random() < 0.5}


def cases() -> list[dict]:
    out = named_cases() + ledger_cases() + [generated(seed) for seed in range(SEEDS)]
    for case in out:
        case.setdefault("git", GIT_DEFAULT if case["name"].startswith(("harvest", "fixed", "ledger", "replay",
                                                                      "sibling", "budget", "cleanup")) else {})
        for key in case.pop("drop_inbox", []):
            case["files"].pop("repair/inbox/%s.json" % key, None)
    return out


def as_text(value):
    """Every layout value reaches both sides as bytes-or-text, never as a re-serialised document."""
    if isinstance(value, dict) and "__bytes_b64" in value:
        return value
    return value if isinstance(value, str) else json.dumps(value)


def textual(spec: dict) -> dict:
    spec["files"] = {k: as_text(v) for k, v in spec.get("files", {}).items()}
    for files in spec.get("runs", {}).values():
        for key in ("meta", "review"):
            if key in files:
                files[key] = as_text(files[key])
    return spec


ROLLOUT_TEXT = json.dumps({
    "operational_ruling": "r", "no_live_run_verification": "v",
    "owner_branch_ruleset_evidence": "e", "durable_artifact_root": "{ROOT}/artifacts",
    "runner_identity": "crq-runner-app", "publisher_spool": {"ssh_alias": "p@h", "ssh_key": "k"}})


def build() -> dict:
    out = []
    for spec in cases():
        spec = textual(copy.deepcopy(spec))
        no_rollout = spec.pop("no_rollout", False)
        spec["no_rollout"] = no_rollout
        out.append({**spec, "expected": run_python(spec)})
    names = [c["name"] for c in out]
    assert len(names) == len(set(names)), "duplicate case names"
    seeded, latest = base._seed_chain(())
    row = base._row(repair_task=None)
    row["previous_event_id"] = latest
    return {"schema": SCHEMA, "triage_row": row, "rollout_text": ROLLOUT_TEXT, "at": AT,
            "wall": WALL, "finding_id": FINDING, "review_id": base.REVIEW,
            "seed_events": seeded, "cases": out}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=False) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("repair-tick-parity fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
