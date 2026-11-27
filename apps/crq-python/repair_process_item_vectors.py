#!/usr/bin/env python3
"""Deterministic offline oracle for the composed ``process_item`` -> ``process`` seam.

Test tooling only. It runs the PRODUCTION ``crq_repair.process_item`` (the serial
item loop, ``crq_repair.py`` ``process_item``) with the PRODUCTION
``crq_repair.process`` (the rung machine) underneath it, over a throwaway
directory, and records per scenario what Python does end to end:

* the TRACE of every injected seam call, in order (``runner_disabled``,
  ``blocked``, ``dispatch_paused``, ``narrate``, ``publish_refusal``, the
  ``git worktree add`` ``command`` call, ``retain``, ``git``, ``cat-file``,
  ``dispatch``, ``mechanical``, ``rate_limit_pause``, ``random.random``);
* every file SAVE (``atomic``), in order, as the text it wrote, and the
  ``state/repair`` tree left behind (directories and files);
* the list the caller sees afterwards (job order and each ``repair_base``, since
  ``process_item`` sorts and rebases the caller's dicts in place);
* the value ``process_item`` returned, or the exception type and message that
  escaped it.

Only effects are replaced; the sort, canonical-delivery check, base chaining,
result/progress selection, resume, the judge and ``pending`` (unless a scenario
stubs it) are the real production code over real files under a temporary root.
The fixtures are ordinary synthetic data: no repository, network, provider,
credential or signer is touched. Scenario paths start with ``/T``.

The non-dict prior ``result.json`` scenarios (list, string, number, null, bool)
observe what Python does today and record it as-is; nothing here changes either
language's error semantics.

Regenerate with ``python3 repair_process_item_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import repair_rung_machine_vectors as rung  # noqa: E402  (production service loader + builders)

service = rung.service
FIXTURE = HERE / "fixtures" / "crq-process-item" / "cases.json"
SCHEMA = "cq.crq-process-item-vector/v1"
NOW = rung.NOW
BASE = rung.BASE
ok = rung.ok
prior = rung.prior
config = rung.config
CLEAN_GIT = rung.CLEAN_GIT
EXC = rung.EXC
FixedDatetime = rung.FixedDatetime
Exhausted = rung.Exhausted

SCENARIOS: list[dict] = []
GAPS: list[str] = []


def ijob(number, run="R", **extra):
    """A synthetic job of item ``item-1``: ``crq-<run>-F<number>``."""
    job_id = f"crq-{run}-F{number}"
    return rung.job(**{"job": job_id, "run": run, **extra})


def tip(char):
    return char * 40


def scenario(name, jobs, *, files=None, config_=None, trees=(), plain_dirs=(), git=None, triage=None,
             pending="real", **seams):
    SCENARIOS.append({
        "name": name,
        "jobs": jobs,
        "config": config() if config_ is None else config_,
        "files": files or {},
        "triage": triage or {},
        "trees": list(trees),
        "plain_dirs": list(plain_dirs),
        "git": CLEAN_GIT if git is None else git,
        "pending": pending,
        "seams": {key: list(value) for key, value in seams.items()},
    })


def wt(job_id):
    return f"/T/wts/crq-repair-item-1-{job_id}"


def build_scenarios() -> None:
    passed = [{"verdict": "pass"}]
    # ---- FIXED chaining ---------------------------------------------------
    scenario("chain: a FIXED job's last commit is the next job's repair_base",
             [ijob(1), ijob(2)],
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("chain: three jobs, tip follows the latest FIXED commit",
             [ijob(1), ijob(2), ijob(3)],
             dispatch=[ok(commits=(tip("1"), tip("3"))), ok(commits=(tip("2"),)), ok(commits=(tip("4"),))],
             mechanical=passed * 3)
    scenario("chain: jobs given out of order run F1 first and are re-sorted for the caller",
             [ijob(2), ijob(1)],
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("chain: a minor finding sorts after a major one",
             [ijob(1, finding={"severity": "minor", "path": "src/a.py"}), ijob(2)],
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("chain: a different run keeps its own repair_base",
             [ijob(1, run="R"), ijob(1, run="S"), ijob(2, run="R")],
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),)), ok(commits=(tip("3"),))],
             mechanical=passed * 3)
    scenario("chain: a not-FIXED job does not move the tip",
             [ijob(1), ijob(2)],
             dispatch=[{"stop": "error", "summary": "one"}, {"stop": "error", "summary": "two"},
                       {"stop": "error", "summary": "three"}, ok(commits=(tip("2"),))],
             mechanical=passed)
    # ---- rate-limit deferral and pauses ----------------------------------
    scenario("deferral: a rate-limited job stops the item, the next job never starts",
             [ijob(1), ijob(2)],
             dispatch=[{"stop": "rate-limit", "summary": "429"}], rate_limit_pause=["2026-11-26T13:00:00Z"])
    scenario("deferral: a rate-limit after a FIXED job stops the chain",
             [ijob(1), ijob(2), ijob(3)],
             dispatch=[ok(commits=(tip("1"),)), {"stop": "rate-limit", "summary": "429"}],
             mechanical=passed, rate_limit_pause=["2026-11-26T13:00:00Z"])
    scenario("pause: a live provider pause before the first job ends the pass with rate-limit",
             [ijob(1), ijob(2)], dispatch_paused=["paused until later"])
    scenario("pause: a pause that appears after a job ends the pass with rate-limit",
             [ijob(1), ijob(2)],
             dispatch=[ok(commits=(tip("1"),))], mechanical=passed, dispatch_paused=[None, None, "paused"])
    scenario("blocked: the GLM window stops the item before any job",
             [ijob(1), ijob(2)], blocked=[True])
    scenario("runner-disabled: a marker before the first job refuses and publishes",
             [ijob(1), ijob(2)], runner_disabled=[True])
    scenario("runner-disabled: a marker between jobs stops the rest of the item",
             [ijob(1), ijob(2)],
             dispatch=[ok(commits=(tip("1"),))], mechanical=passed, runner_disabled=[False, True])
    scenario("worktree: a failed git worktree add raises RuntimeError",
             [ijob(1), ijob(2)], worktree_add=[128])
    scenario("worktree: an existing worktree is not re-added",
             [ijob(1)], plain_dirs=[wt("crq-R-F1")],
             dispatch=[ok(commits=(tip("1"),))], mechanical=passed)
    # ---- canonical delivery ---------------------------------------------
    fid = "e" * 64
    scenario("canonical: an undelivered finding is skipped and narrated, the next job runs",
             [ijob(1, canonical_finding_id=fid), ijob(2)],
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    scenario("canonical: a delivered finding runs",
             [ijob(1, canonical_finding_id=fid)],
             triage={fid: {"status": "delivered", "receipt": {"repair_task": "crq-R-F1"}}},
             dispatch=[ok(commits=(tip("1"),))], mechanical=passed)
    scenario("canonical: a malformed finding id is skipped without reading a row",
             [ijob(1, canonical_finding_id="not-a-hash"), ijob(2)],
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    # ---- prior result passthrough ---------------------------------------
    done = prior(verdict="FIXED", commits=[tip("9")], reason="done", finished_at="2026-11-26T11:30:00Z")
    scenario("prior: a terminal FIXED result is returned untouched and its tip chains",
             [ijob(1), ijob(2)], files={"crq-R-F1": {"result": done}},
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    scenario("prior: a terminal FAILED result is returned untouched and does not chain",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"result": prior(verdict="FAILED", reason="no", finished_at=NOW)}},
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    scenario("prior: a still-deferred result (retry_after in the future) is returned and stops the item",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"result": prior(retry_after="2026-11-26T13:00:00Z")}})
    for label, falsy in [("zero", 0), ("null", None), ("false", False), ("empty list", [])]:
        scenario(f"prior: a terminal FIXED result with a falsy non-string retry_after ({label}) is passed through",
                 [ijob(1), ijob(2)], files={"crq-R-F1": {"result": {**done, "retry_after": falsy}}},
                 dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    # ---- resume ----------------------------------------------------------
    scenario("resume: an elapsed retry_after re-runs the job and the FIXED tip chains",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"result": prior(retry_after="2026-11-26T11:00:00Z")}},
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("resume: progress.json at next_rung 1 resumes at A1",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"progress": prior(next_rung=1, attempts=[rung.attempt("A0")])}},
             dispatch=[ok(commits=(tip("1"),)), ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("resume: pending_mechanical resumes in the recorded tree and chains its commit",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"progress": prior(
                 worktree=wt("crq-R-F1"), next_rung=0, attempts=[rung.attempt("A0", "ok", changed=True)],
                 pending_mechanical={"rung": 0, "commits": [tip("5")], "fixer_reason": "r"})}},
             trees=[wt("crq-R-F1")], plain_dirs=[wt("crq-R-F1")],
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed + passed)
    scenario("resume: a pending_mechanical whose tree is gone fails closed and does not chain",
             [ijob(1), ijob(2)],
             files={"crq-R-F1": {"progress": prior(
                 worktree="/T/elsewhere", next_rung=0, attempts=[rung.attempt("A0", "ok", changed=True)],
                 pending_mechanical={"rung": 0, "commits": [tip("5")], "fixer_reason": "r"})}},
             plain_dirs=[wt("crq-R-F1")],
             dispatch=[ok(commits=(tip("2"),))], mechanical=passed)
    # ---- shape errors ----------------------------------------------------
    scenario("shape: a FIXED result with no commits raises IndexError after writing the result",
             [ijob(1), ijob(2)],
             dispatch=[ok(commits=())], mechanical=passed)
    scenario("shape: a job without repair_base raises KeyError before any seam",
             [{k: v for k, v in ijob(1).items() if k != "repair_base"}])
    # ---- non-dict prior result.json -------------------------------------
    # Observed, not decided: ``pending`` (real) calls ``prior.get`` first and
    # raises AttributeError before ``process`` runs; with ``pending`` stubbed
    # true, ``process`` raises the same AttributeError from its own ``prior.get``.
    for label, value in [("list", [1, 2]), ("string", "oops"), ("number", 7), ("float", 1.5),
                         ("null", None), ("bool", True)]:
        for mode in ("real", "true"):
            scenario(f"non-dict prior {label}: pending {mode}",
                     [ijob(1), ijob(2)], files={"crq-R-F1": {"result": value}}, pending=mode,
                     plain_dirs=[wt("crq-R-F1")],
                     dispatch=[ok(commits=(tip("2"),))], mechanical=passed)


def _real(tmp: Path, path: str) -> Path:
    return tmp / path.removeprefix("/T/")


def _prepare(spec: dict, tmp: Path) -> None:
    for path in spec["trees"]:
        (_real(tmp, path) / ".git").mkdir(parents=True, exist_ok=True)
    for path in spec["plain_dirs"]:
        _real(tmp, path).mkdir(parents=True, exist_ok=True)
    for fid, row in spec["triage"].items():
        target = tmp / "root" / "state/backfill/findings/triage" / (fid + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(row), encoding="utf-8")
    for job_id, entry in spec["files"].items():
        directory = tmp / "root" / "state" / "repair" / job_id
        directory.mkdir(parents=True, exist_ok=True)
        for key in ("result", "progress"):
            if key in entry:
                path = directory / (key + ".json")
                path.write_text(json.dumps(entry[key]), encoding="utf-8")
                stamp = 2_000_000_000 if key == "progress" else 1_000_000_000
                os.utime(path, ns=(stamp, stamp))


def _tree(tmp: Path) -> list[str]:
    base = tmp / "root" / "state" / "repair"
    found = []
    if base.is_dir():
        for path in sorted(base.rglob("*")):
            found.append(str(path.relative_to(base)) + ("/" if path.is_dir() else ""))
    return found


def _run(spec: dict) -> dict:
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="process-item-")))
    prefix = str(tmp)
    trace: list = []
    writes: list = []

    def scrub(value):
        return json.loads(json.dumps(value, default=str, ensure_ascii=True).replace(prefix, "/T"))

    def unscrub(value):
        return json.loads(json.dumps(value).replace("/T", prefix))

    spec = unscrub(spec)
    seams = copy.deepcopy(spec["seams"])

    def next_answer(name):
        queue = seams.get(name) or []
        if not queue:
            raise Exhausted(name)
        item = queue.pop(0)
        if isinstance(item, dict) and set(item) == {"raise"}:
            info = item["raise"]
            raise EXC[info["kind"]](info["message"])
        return item

    def scripted(name, default):
        trace.append([name])
        return next_answer(name) if seams.get(name) else default

    def blocked(repair, now=None):
        return scripted("blocked", False)

    def runner_disabled():
        return scripted("runner_disabled", False)

    def dispatch_paused(config_):
        return scripted("dispatch_paused", None)

    def narrate(message):
        trace.append(["narrate", scrub(message)])

    def publish_refusal():
        trace.append(["publish_refusal"])

    def retain(w, base, directory, include_clean=False):
        trace.append(["retain", scrub(str(w)), base, scrub(str(directory)), bool(include_clean)])

    def retain_nested(w, base, directory):
        trace.append(["retain_preserving_nested", scrub(str(w)), base, scrub(str(directory))])

    def git(cwd, *args):
        trace.append(["git", scrub(str(cwd)), *[scrub(str(a)) for a in args]])
        answer = spec["git"].get(" ".join(args), "")
        if isinstance(answer, dict) and "raise" in answer:
            info = answer["raise"]
            raise EXC[info["kind"]](info["message"])
        return answer

    def command(argv, cwd=None, **kwargs):
        if argv[:3] == ["git", "worktree", "add"]:
            trace.append(["worktree_add", scrub(str(argv[-2])), argv[-1], scrub(str(cwd))])
            code = next_answer("worktree_add") if seams.get("worktree_add") else 0
            return types.SimpleNamespace(returncode=code, stdout="", stderr="")
        assert argv[:3] == ["git", "cat-file", "blob"], argv
        trace.append(["cat_file", scrub(str(cwd)), scrub(argv[3])])
        return types.SimpleNamespace(returncode=128, stdout="", stderr="")

    def dispatch(config_, role, current, w, directory, judge=False):
        trace.append(["dispatch", scrub(role), scrub(copy.deepcopy(current)), scrub(str(w)),
                      scrub(str(directory)), bool(judge)])
        return next_answer("dispatch")

    def mechanical(config_, w, base, commits, job_id, directory):
        trace.append(["mechanical", scrub(str(w)), base, scrub(commits), job_id, scrub(str(directory))])
        return next_answer("mechanical")

    def rate_limit_pause(report, job_id):
        trace.append(["rate_limit_pause", scrub(report), job_id])
        return next_answer("rate_limit_pause")

    real_atomic = service.atomic

    def atomic(path, value):
        real_atomic(path, value)
        writes.append({"path": scrub(str(path)), "text": scrub(Path(path).read_text(encoding="utf-8"))})

    def rand():
        trace.append(["random"])
        return 0.99

    patches = {
        "ROOT": tmp / "root", "blocked": blocked, "runner_disabled": runner_disabled,
        "dispatch_paused": dispatch_paused, "narrate": narrate, "publish_refusal": publish_refusal,
        "retain": retain, "retain_preserving_nested": retain_nested, "git": git, "command": command,
        "dispatch": dispatch, "mechanical": mechanical, "rate_limit_pause": rate_limit_pause,
        "atomic": atomic, "utc": lambda: NOW,
        "dt": types.SimpleNamespace(datetime=FixedDatetime, timezone=dt.timezone, timedelta=dt.timedelta),
        "random": types.SimpleNamespace(random=rand),
    }
    if spec["pending"] == "true":
        patches["pending"] = lambda job_id: True
    saved = {name: getattr(service, name) for name in patches}
    os.environ["LANG"] = "C.UTF-8"
    jobs = copy.deepcopy(spec["jobs"])
    outcome: dict = {}
    try:
        for name, value in patches.items():
            setattr(service, name, value)
        _prepare(spec, tmp)
        try:
            outcome = {"returned": scrub(service.process_item(copy.deepcopy(spec["config"]), jobs))}
        except Exhausted as gap:
            GAPS.append(f"{spec['name']!r}: ran out of scripted {gap} answers")
            outcome = {"gap": str(gap)}
        except Exception as exc:  # the recorded subject: what escapes process_item
            outcome = {"raises": type(exc).__name__, "message": scrub(str(exc))}
        state = _tree(tmp)
    finally:
        for name, value in saved.items():
            setattr(service, name, value)
        shutil.rmtree(tmp, ignore_errors=True)
    after = [{"job": j.get("job") if isinstance(j, dict) else None,
              "repair_base": j.get("repair_base") if isinstance(j, dict) else None} for j in scrub(jobs)]
    return {"trace": trace, "writes": writes, "jobs_after": after, "state": state, **outcome}


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    cases = [{"name": spec["name"], "scenario": spec, "expected": _run(copy.deepcopy(spec))} for spec in SCENARIOS]
    if GAPS:
        raise SystemExit("scenario scripting gaps:\n  " + "\n  ".join(GAPS))
    return {"schema": SCHEMA, "now": NOW, "base": BASE, "cases": cases}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(case, ensure_ascii=True, separators=(",", ":")) for case in document["cases"]]
    return json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n"


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
        print("process-item fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
