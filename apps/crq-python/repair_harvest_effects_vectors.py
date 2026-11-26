#!/usr/bin/env python3
"""Deterministic offline oracle for the file-backed repair-harvest effects.

Test tooling only. Two sections, both driving PRODUCTION code:

* ``cleanup``: ``crq_repair.retain.cleanup_harvested`` (retain.py:20) over a
  throwaway Git clone with a real linked worktree, a real ``git worktree remove``
  and hand-written retained snapshots. Scenarios are declarative (no paths, no
  hashes); the TS replay builds the same tree and compares what survives and the
  exception class that escaped.
* ``outcome``: ``repair_tick.mark_finding_outcome`` (repair_tick.py:287) and the
  FIXED-sibling write of ``repair_tick.record_unpublished_siblings``
  (repair_tick.py:339) over a real inbox, triage row and publication outbox,
  including the trap inputs the typed harvest fixture never reaches (falsy and
  non-string finding ids, a missing verdict, an unhashable verdict).

Regenerate with ``python3.14 repair_harvest_effects_vectors.py --write`` and
verify with ``--check``. Output is deterministic (ensure_ascii, no host paths).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
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
from crq_repair import retain  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-repair-harvest-effects" / "cases.json"
SCHEMA = "cq.crq-repair-harvest-effects-vector/v1"

ITEM = "it-1"
JOB = "job-1"
NAME = "crq-repair-" + ITEM + "-" + JOB
ARCHIVES = ("staged.patch", "unstaged.patch", "committed.patch", "untracked.tar", "commits.bundle")
GIT_ENV = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def canonical_token(manifest) -> str:
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_snapshot(parent: Path, head: str, base_sha: str, kind: str) -> Path:
    """One retained snapshot. ``kind`` names the single defect, if any."""
    contents = {name: ("archive:" + name).encode() for name in ARCHIVES}
    manifest = {"base": base_sha, "head": head, "commits": [], "untracked": [],
                "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}}
    if kind == "bad-head":
        manifest["head"] = "f" * 40
    elif kind == "bad-base":
        manifest["base"] = "e" * 40
    elif kind == "no-sha":
        del manifest["sha256"]
    manifest_text = json.dumps(manifest)
    if kind == "list-manifest":
        manifest, manifest_text = [], "[]"
    token = canonical_token(manifest)
    directory = parent / ("retained-" + ("misnamed" if kind == "misnamed" else token))
    directory.mkdir(parents=True)
    for name, data in contents.items():
        if kind == "tamper" and name == "staged.patch":
            data = b"tampered"
        if kind == "missing-archive" and name == "commits.bundle":
            continue
        (directory / name).write_bytes(data)
    (directory / "manifest.json").write_text("{" if kind == "bad-json" else manifest_text)
    return directory


def place(directory: Path, kind: str, where: str, head: str, base_sha: str, tmp: Path) -> None:
    if where == "direct":
        parent = directory
    elif where == "nested":
        parent = directory / "deep" / "er"
    elif where == "non-utf8":
        parent = directory / os.fsdecode(b"\xffdir")
    elif where == "under-symlink":
        outside = tmp / "outside-snapshots"
        outside.mkdir()
        parent = outside
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "link").symlink_to(outside, target_is_directory=True)
    elif where == "symlinked-snapshot":
        elsewhere = tmp / "elsewhere"
        elsewhere.mkdir()
        real = write_snapshot(elsewhere, head, base_sha, kind)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / real.name).symlink_to(real, target_is_directory=True)
        return
    else:
        raise AssertionError(where)
    parent.mkdir(parents=True, exist_ok=True)
    write_snapshot(parent, head, base_sha, kind)


def cleanup_case(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as temporary:
        tmp = Path(temporary).resolve()
        clone, root = tmp / "clone", tmp / "wt"
        directory = tmp / "state" / "repair" / JOB
        clone.mkdir()
        root.mkdir()
        with mock.patch.dict(os.environ, GIT_ENV):
            git(clone, "init", "-q", "-b", "main")
            (clone / "f.txt").write_text("one\n")
            git(clone, "add", "f.txt")
            git(clone, "commit", "-q", "-m", "base")
            base_sha = git(clone, "rev-parse", "HEAD")
            dirname = NAME + ("-A2" if spec.get("dir") == "a2" else "")
            wt = root / dirname
            git(clone, "worktree", "add", "-q", "-b", "br", str(wt))
            head = git(wt, "rev-parse", "HEAD")
            dirty = spec.get("dirty")
            if dirty == "untracked":
                (wt / "u.txt").write_text("x")
            elif dirty == "ignored":
                with (clone / ".git" / "info" / "exclude").open("a") as handle:
                    handle.write("ig.txt\n")
                (wt / "ig.txt").write_text("x")
            elif dirty == "staged":
                (wt / "s.txt").write_text("x")
                git(wt, "add", "s.txt")
            if spec.get("locked"):
                git(clone, "worktree", "lock", str(wt))
            for snapshot in spec.get("snapshots", []):
                place(directory, snapshot["kind"], snapshot.get("where", "direct"), head, base_sha, tmp)
            result = {"verdict": spec.get("verdict", "FIXED"), "repair_base": base_sha}
            target = spec.get("result_worktree", "self")
            if target == "self":
                result["worktree"] = str(wt)
            elif target == "a2":
                result["worktree"] = str(root / (NAME + "-A2"))
            elif target == "outside":
                (tmp / "other").mkdir()
                result["worktree"] = str(tmp / "other" / dirname)
            elif target == "symlink":
                (root / "link").symlink_to(wt, target_is_directory=True)
                result["worktree"] = str(root / "link")
            elif target != "absent":
                raise AssertionError(target)
            if spec.get("drop_base"):
                del result["repair_base"]
            error = None
            try:
                returned = retain.cleanup_harvested(clone, root, directory, ITEM, JOB, result,
                                                    alternate=bool(spec.get("alternate")))
            except BaseException as exc:  # noqa: BLE001 - the class is the datum
                returned, error = None, type(exc).__name__
            survivors = sorted(p.name for p in root.iterdir() if p.name.startswith("crq-repair-"))
        return {"returned": returned, "error": error, "survivors": survivors}


def cleanup_specs() -> list[dict]:
    good = [{"kind": "good"}]
    specs = [
        ("fixed-clean-proven-removes", {"snapshots": good}),
        ("not-fixed-clean-proven-removes", {"verdict": "NOT-FIXED", "snapshots": good}),
        ("failed-verdict-keeps", {"verdict": "FAILED", "snapshots": good}),
        ("stale-verdict-keeps", {"verdict": "STALE", "snapshots": good}),
        ("no-snapshot-keeps", {}),
        ("dirty-untracked-keeps", {"dirty": "untracked", "snapshots": good}),
        ("dirty-ignored-keeps", {"dirty": "ignored", "snapshots": good}),
        ("dirty-staged-keeps", {"dirty": "staged", "snapshots": good}),
        ("bad-head-keeps", {"snapshots": [{"kind": "bad-head"}]}),
        ("bad-base-keeps", {"snapshots": [{"kind": "bad-base"}]}),
        ("tampered-archive-keeps", {"snapshots": [{"kind": "tamper"}]}),
        ("missing-archive-keeps", {"snapshots": [{"kind": "missing-archive"}]}),
        ("malformed-manifest-keeps", {"snapshots": [{"kind": "bad-json"}]}),
        ("list-manifest-keeps", {"snapshots": [{"kind": "list-manifest"}]}),
        ("manifest-without-digests-keeps", {"snapshots": [{"kind": "no-sha"}]}),
        ("misnamed-snapshot-keeps", {"snapshots": [{"kind": "misnamed"}]}),
        ("bad-then-good-removes", {"snapshots": [{"kind": "bad-head"}, {"kind": "good", "where": "nested"}]}),
        ("nested-snapshot-removes", {"snapshots": [{"kind": "good", "where": "nested"}]}),
        ("non-utf8-directory-snapshot-removes", {"snapshots": [{"kind": "good", "where": "non-utf8"}]}),
        ("snapshot-beyond-symlinked-directory-keeps", {"snapshots": [{"kind": "good", "where": "under-symlink"}]}),
        ("symlinked-snapshot-directory-removes", {"snapshots": [{"kind": "good", "where": "symlinked-snapshot"}]}),
        ("result-without-repair-base-keeps", {"snapshots": good, "drop_base": True}),
        ("result-worktree-absent-keeps", {"snapshots": good, "result_worktree": "absent"}),
        ("result-worktree-outside-root-keeps", {"snapshots": good, "result_worktree": "outside"}),
        ("result-worktree-symlink-keeps", {"snapshots": good, "result_worktree": "symlink"}),
        ("alternate-names-missing-sibling-keeps", {"snapshots": good, "alternate": True}),
        ("a2-tree-removes", {"dir": "a2", "snapshots": good}),
        ("a2-tree-alternate-flips-to-missing-keeps", {"dir": "a2", "snapshots": good, "alternate": True}),
        ("a2-result-alternate-flips-to-base-tree-removes",
         {"snapshots": good, "result_worktree": "a2", "alternate": True}),
        ("a2-result-without-alternate-missing-keeps", {"snapshots": good, "result_worktree": "a2"}),
        ("locked-worktree-refuses-removal", {"snapshots": good, "locked": True}),
    ]
    return [{"name": name, "spec": spec} for name, spec in specs]


# ---------------------------------------------------------------- outcome section

def _outcome_run(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        state = base._state(root)
        row_path = state / "backfill/findings/triage" / (base.FINDING + ".json")
        row = base._row(repair_task=case.get("repair_task", base.JOB))
        base._write(row_path, row)
        store = base.ledger.ArtifactStore(root / "artifacts")
        outbox = base.ledger.Outbox(state / "backfill/publication", store)
        seeded, latest = base._seed_chain(())
        for value in seeded:
            outbox.spool(value)
        row["previous_event_id"] = latest
        base._write(row_path, row)
        c = SimpleNamespace(STATE=state, CONFIG={"repair": {"max_finding_retries": base.MAX_RETRIES}},
                            iso=lambda: base.AT)
        job = copy.deepcopy(case["job"])
        result = copy.deepcopy(case.get("result"))

        def settings(_state, **_kwargs):
            return {"durable_artifact_root": str(root / "artifacts")}

        error = None
        before = base._row_bytes(row_path)
        with mock.patch("backfill_runtime.settings", settings):
            try:
                if case["op"] == "mark":
                    repair_tick.mark_finding_outcome(c, job, result)
                else:
                    sibling = job["job"]
                    base._write(state / "repair/inbox" / (sibling + ".json"), job)
                    (state / "repair" / sibling).mkdir(parents=True, exist_ok=True)
                    base._write(state / "repair" / sibling / "result.json", result)
                    repair_tick.record_unpublished_siblings(c, {"jobs": [sibling]}, set())
            except BaseException as exc:  # noqa: BLE001 - the class is the datum
                error = type(exc).__name__
        return {"error": error, "row_before": json.loads(before),
                "row_after": json.loads(base._row_bytes(row_path)),
                "events": [v for v in outbox.retained() if v["source_key"].startswith("repair-outcome:")
                           and not v["source_key"].startswith("repair-outcome:seed-")]}


def _job(**over) -> dict:
    value = base._job_doc()
    value.update(over)
    return value


def outcome_cases() -> list[dict]:
    fixed = {"job": base.JOB, "item": base.ITEM, "verdict": "FIXED", "reason": "ready"}

    def mark(name, result, job=None, **extra):
        return {"name": name, "op": "mark", "job": job if job is not None else _job(),
                "result": result, **extra}

    cases = [
        mark("failed-exhausted", {"verdict": "FAILED", "reason": "stopped"}),
        mark("failed-owner-decision-needs-human", {"verdict": "FAILED", "failure_class": "owner-decision", "reason": "pick one"}),
        mark("failed-non-string-class-normalizes", {"verdict": "FAILED", "failure_class": 5, "reason": "odd class"}),
        mark("failed-list-class-normalizes", {"verdict": "FAILED", "failure_class": ["x"], "reason": "list class"}),
        mark("failed-empty-reason-uses-verdict", {"verdict": "FAILED", "reason": ""}),
        mark("failed-zero-reason-uses-verdict", {"verdict": "FAILED", "reason": 0}),
        mark("failed-non-string-reason", {"verdict": "FAILED", "reason": 7}),
        mark("not-fixed-truthy-text-evidence-dismisses", {"verdict": "NOT-FIXED", "reason": "r", "unchanged_evidence": "seen"}),
        mark("not-fixed-empty-dict-evidence-retriages", {"verdict": "NOT-FIXED", "reason": "r", "unchanged_evidence": {}}),
        mark("not-fixed-zero-evidence-owner-needs-human", {"verdict": "NOT-FIXED", "failure_class": "owner-decision", "unchanged_evidence": 0}),
        mark("stale-retriages", {"verdict": "STALE"}),
        mark("fixed-writes-nothing", fixed),
        mark("unknown-verdict-writes-nothing", {"verdict": "WEIRD"}),
        mark("lowercase-verdict-writes-nothing", {"verdict": "failed"}),
        mark("null-verdict-writes-nothing", {"verdict": None}),
        mark("missing-verdict-key-error", {"reason": "x"}),
        mark("list-verdict-unhashable", {"verdict": ["FAILED"]}),
        mark("dict-verdict-unhashable", {"verdict": {"a": 1}}),
        mark("no-finding-id-writes-nothing", {"verdict": "FAILED"}, job=_job(canonical_finding_id=None)),
        mark("empty-finding-id-writes-nothing", {"verdict": "FAILED"}, job=_job(canonical_finding_id="")),
        mark("zero-finding-id-writes-nothing", {"verdict": "FAILED"}, job=_job(canonical_finding_id=0)),
        mark("empty-list-finding-id-writes-nothing", {"verdict": "FAILED"}, job=_job(canonical_finding_id=[])),
        mark("int-finding-id-type-error", {"verdict": "FAILED"}, job=_job(canonical_finding_id=5)),
        mark("list-finding-id-type-error", {"verdict": "FAILED"}, job=_job(canonical_finding_id=["x"])),
        mark("missing-job-id-key-error", {"verdict": "FAILED"},
             job={k: v for k, v in base._job_doc().items() if k != "job"}),
        mark("missing-repair-base-writes-null-base", {"verdict": "FAILED"},
             job={k: v for k, v in base._job_doc().items() if k != "repair_base"}),
        mark("row-bound-to-newer-job-preserved", {"verdict": "FAILED", "reason": "late"}, repair_task="crq-newer"),
    ]
    sibling_result = {"job": "sib-1", "item": base.ITEM, "verdict": "FIXED"}
    sib_job = _job(job="sib-1", item=base.ITEM)
    cases += [
        {"name": "sibling-fixed-needs-human", "op": "sibling", "job": sib_job, "result": sibling_result,
         "repair_task": "sib-1"},
        {"name": "sibling-fixed-null-base", "op": "sibling",
         "job": {k: v for k, v in sib_job.items() if k != "repair_base"}, "result": sibling_result,
         "repair_task": "sib-1"},
        {"name": "sibling-fixed-row-bound-to-newer-preserved", "op": "sibling", "job": sib_job,
         "result": sibling_result, "repair_task": "crq-newer"},
    ]
    return cases


def build() -> dict:
    cleanup = [{"name": s["name"], "spec": s["spec"], "expected": cleanup_case(s["spec"])}
               for s in cleanup_specs()]
    names = [c["name"] for c in cleanup]
    assert len(names) == len(set(names)), "duplicate cleanup names"
    outcome = [{**case, "expected": _outcome_run(case)} for case in outcome_cases()]
    names = [c["name"] for c in outcome]
    assert len(names) == len(set(names)), "duplicate outcome names"
    seeded, latest = base._seed_chain(())
    return {"schema": SCHEMA, "seed_events": seeded, "seed_head": latest, "item": ITEM, "job": JOB, "finding_id": base.FINDING,
            "at": base.AT, "max_finding_retries": base.MAX_RETRIES,
            "cleanup_cases": cleanup, "outcome_cases": outcome}


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
        print("repair-harvest-effects fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
