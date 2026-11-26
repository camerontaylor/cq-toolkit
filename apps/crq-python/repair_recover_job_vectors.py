#!/usr/bin/env python3
"""Deterministic offline oracle for the TS port of the ``recover_job`` shell.

Test tooling only. It runs the PRODUCTION ``crq_repair.recover_job``
(``crq_repair.py:1395-1528``) over a throwaway directory and records, per
scenario, exactly what Python does:

* the TRACE of every injected seam call, in order, with its arguments
  (``ran_locked``, ``load_queue``, retained publication events,
  ``runner_disabled``, ``narrate``, ``publish_refusal``, ``blocked``,
  ``dispatch``, ``prepare_current_job``, ``secret_scan_diff`` and the
  ``recovery.recover`` call with what each of its closures answered);
* the value ``recover_job`` returned, or the exception class (and message,
  where the code under test authored it) that escaped it.

Only effects are replaced: ``crq`` (the lock, the queue, the scanner),
``repair_tick`` (the inbox and preparation), ``recovery.recover`` (a scripted
driver that calls the three closures it is handed) and the service's
``dispatch`` / ``blocked`` / ``runner_disabled`` / ``narrate`` /
``publish_refusal``. The role check, ``job_path`` and the job and triage-row
file reads, ``check_owner`` and ``triage_context_safe`` are the real production
code, run against real files under a temporary root.

Scenario paths start with ``/T``; the oracle substitutes its temporary
directory and substitutes it back in every recorded value, so the fixture is
host independent. Nothing outside the temporary directory is read or written
and no provider, queue, signer, network or host service is touched.

Regenerate with ``python3 repair_recover_job_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-recover-job" / "cases.json"
SCHEMA = "cq.crq-recover-job-vector/v1"
JOB = "crq-R-F1"
FID = "a" * 64
MESSAGE_KINDS = ["ValueError", "KeyError", "RuntimeError", "OSError"]
EXC = {"ValueError": ValueError, "KeyError": KeyError, "RuntimeError": RuntimeError, "OSError": OSError}


def _service():
    """Load the production repair service module, not a copy of it."""
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("repair_recover_job_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()


class Exhausted(BaseException):
    """A scenario ran out of scripted answers: never caught by ``except Exception``."""


def raising(kind, message):
    return {"raise": {"kind": kind, "message": message}}


def roles(driver="cq"):
    return {"judge_critical": {"driver": driver, "model": "m-judge-critical"}, "fixer": {"driver": "cq"}}


def config(driver="cq", **extra):
    base = {"repair": {"roles": roles(driver)}, "clone": "/T/clone"}
    base.update(extra)
    return base


def queue(run_record=None, item="item-1"):
    record = {"jobs": [JOB], "state": "failed"} if run_record is None else run_record
    return {"items": [{"id": item, "repair_runs": {"R": record}}]}


def job_doc(**extra):
    doc = {"job": JOB, "item": "item-1", "run": "R"}
    doc.update(extra)
    return doc


def context(**extra):
    base = {"finding": {"path": "src/a.py", "title": "t"}, "retained_patch": "", "retained_attempts": [],
            "current_contract": {"path": "docs/c.md", "text": ""}}
    base.update(extra)
    return base


SCENARIOS: list[dict] = []


def scenario(name, *, job_id=JOB, config_=None, job_file=None, files=None, queue_=None, retained=None,
             ran_locked=(True, True, True), runner_disabled=(), blocked=(), dispatch=(), prepare=(),
             scan=(), script=(), recover_returns="recovered"):
    job_text = json.dumps(job_doc()) if job_file is None else job_file
    spec = {
        "name": name, "job_id": job_id, "config": config() if config_ is None else config_,
        "files": {"state/repair/inbox/" + JOB + ".json": job_text} if files is None else files,
        "queue": queue() if queue_ is None else queue_, "retained": [] if retained is None else retained,
        "seams": {"ran_locked": list(ran_locked), "runner_disabled": list(runner_disabled),
                  "blocked": list(blocked), "dispatch": list(dispatch), "prepare": list(prepare),
                  "scan": list(scan)},
        "script": list(script), "recover_returns": recover_returns,
    }
    SCENARIOS.append(spec)
    return spec


def judge_op(old=None, ctx=None, directory="/T/root/state/repair/crq-R-F1"):
    return {"op": "judge", "old": {"job": JOB, "run": "R"} if old is None else old,
            "context": {"k": "v"} if ctx is None else ctx, "directory": directory}


def prepare_op(old_id=JOB, tip="t" * 40, evidence=None):
    return {"op": "prepare", "old_id": old_id, "tip": tip, "evidence": {"verdict": "still-valid"} if evidence is None else evidence}


def scan_op(ctx=None, output="/T/root/state/repair/crq-R-F1/triage-scan.json"):
    return {"op": "scan", "context": context() if ctx is None else ctx, "output": output}


def canonical_files(status="delivered", repair_task=JOB, **row_extra):
    row = {"status": status, "receipt": {"repair_task": repair_task}}
    row.update(row_extra)
    return {
        "state/repair/inbox/" + JOB + ".json": json.dumps(job_doc(canonical_finding_id=FID)),
        "state/backfill/findings/triage/" + FID + ".json": json.dumps(row),
    }


def build_scenarios() -> None:
    # --- the role precondition and the job read ------------------------------------------
    scenario("role: a non-cq critical judge is a ValueError", config_=config("codex"))
    scenario("role: a missing driver is not cq", config_={"repair": {"roles": {"judge_critical": {}}}, "clone": "/T/c"})
    scenario("role: a null driver is not cq", config_={"repair": {"roles": {"judge_critical": {"driver": None}}}})
    scenario("role: a missing judge_critical is a KeyError", config_={"repair": {"roles": {}}})
    scenario("role: missing roles is a KeyError", config_={"repair": {}})
    scenario("role: missing repair is a KeyError", config_={})
    scenario("role: a list repair is a TypeError", config_={"repair": []})
    scenario("role: a string role is an AttributeError", config_={"repair": {"roles": {"judge_critical": "cq"}}})
    scenario("role: a null role is an AttributeError", config_={"repair": {"roles": {"judge_critical": None}}})
    scenario("job: a missing job file is an OSError", files={})
    scenario("job: an unparsable job file is a ValueError", job_file="{not json")
    scenario("job: a non-grammar id is a ValueError before any read", job_id="bad id")
    scenario("job: an id with a slash is a ValueError", job_id="crq-R/../x")
    scenario("job: a non-dict job fails check_owner with an AttributeError", job_file="[1]")
    scenario("job: a non-UTF-8 job file is a ValueError", job_file="\udcff")

    # --- the up-front lock and the ownership refusals ----------------------------------------
    scenario("lock: a busy tick defers recovery without calling recover", ran_locked=(False,))
    scenario("lock: a lock acquisition failure escapes", ran_locked=(raising("OSError", "lock timeout"),))
    scenario("owner: a queue without the item is not tick-owned", queue_={"items": []})
    scenario("owner: a record not listing the job is not tick-owned", queue_=queue({"jobs": ["crq-R-F9"]}))
    scenario("owner: a published fix_pr is refused", queue_=queue({"jobs": [JOB], "fix_pr": 7}))
    scenario("owner: a done record is refused", queue_=queue({"jobs": [JOB], "state": "done"}))
    scenario("owner: a stale record without a prepared retry is refused", queue_=queue({"jobs": [JOB], "state": "stale"}))
    scenario("owner: an invalid canonical identity is refused",
             files={"state/repair/inbox/" + JOB + ".json": json.dumps(job_doc(canonical_finding_id="XYZ"))})
    scenario("owner: a missing triage row is an OSError",
             files={"state/repair/inbox/" + JOB + ".json": json.dumps(job_doc(canonical_finding_id=FID))})
    scenario("owner: a delivered canonical finding passes", files=canonical_files(), script=[])
    scenario("owner: a reassigned canonical finding is refused", files=canonical_files(repair_task="crq-R-F9"))
    scenario("owner: a needs-human row owned by another actor is refused",
             files=canonical_files("needs-human", previous_event_id="e1"),
             retained=[{"id": "e1", "payload": {"actor": "someone", "finding_id": FID}}])
    scenario("owner: a needs-human row written by crq-repair for this job passes",
             files=canonical_files("needs-human", previous_event_id="e1"),
             retained=[{"id": "e1", "payload": {"actor": "crq-repair", "finding_id": FID,
                                                   "evidence": {"repair_task": JOB}}}])
    scenario("owner: a non-dict queue is an AttributeError", queue_=[])
    scenario("owner: a null items list is a TypeError", queue_={"items": None})
    scenario("owner: an unhashable run key is a TypeError", job_file=json.dumps(job_doc(run=[1])))
    scenario("owner: a string jobs field matches by substring", queue_=queue({"jobs": "xx" + JOB + "xx"}))

    # --- recover is handed the three closures and its result returned as is ------------------
    scenario("recover: the result is returned untouched", recover_returns={"verdict": "FIXED", "n": 1})
    scenario("recover: a null result is returned", recover_returns=None)

    # --- the judge closure ----------------------------------------------------------------------
    scenario("judge: a live runner marker defers without a model call", runner_disabled=(True,),
             script=[judge_op()])
    scenario("judge: any truthy marker value defers", runner_disabled=("yes",), script=[judge_op()])
    scenario("judge: a falsy marker value proceeds", runner_disabled=(0,), blocked=(False,), dispatch=({"stop": "ok"},),
             script=[judge_op()])
    scenario("judge: the GLM blackout defers without a model call", runner_disabled=(False,), blocked=(True,),
             script=[judge_op()])
    scenario("judge: a truthy blackout value defers", runner_disabled=(None,), blocked=([1],), script=[judge_op()])
    scenario("judge: dispatch is reached with the recovery-judge directory", runner_disabled=(False,),
             blocked=(False,), dispatch=({"stop": "ok", "verdict": "still-valid", "reason": "r"},),
             script=[judge_op(ctx={"retained_patch": "p", "n": 1})])
    scenario("judge: a dispatch failure is recorded, not swallowed", runner_disabled=(False,), blocked=(False,),
             dispatch=(raising("RuntimeError", "provider exploded"),), script=[judge_op()])
    scenario("judge: old without a job key is a KeyError after both gates", runner_disabled=(False,),
             blocked=(False,), script=[judge_op(old={"run": "R"})])
    scenario("judge: old without a run key is a KeyError", runner_disabled=(False,), blocked=(False,),
             script=[judge_op(old={"job": JOB})])
    scenario("judge: a non-dict old is a TypeError", runner_disabled=(False,), blocked=(False,),
             script=[judge_op(old=[JOB])])
    scenario("judge: the gates run before old is read", runner_disabled=(True,), script=[judge_op(old=None)])
    scenario("judge: a missing clone is a KeyError", config_={"repair": {"roles": roles()}},
             runner_disabled=(False,), blocked=(False,), script=[judge_op()])

    # --- the prepare closure --------------------------------------------------------------------
    scenario("prepare: prepares under the lock after re-checking ownership", ran_locked=(True, True),
             prepare=({"prepared": "crq-R-F2"},), script=[prepare_op()])
    scenario("prepare: a busy tick defers preparation", ran_locked=(True, False), script=[prepare_op()])
    scenario("prepare: a preparation failure propagates", ran_locked=(True, True),
             prepare=(raising("ValueError", "source SHA is not the observed current default-branch tip"),),
             script=[prepare_op()])
    scenario("prepare: a falsy preparation result is returned as is", ran_locked=(True, True), prepare=(None,),
             script=[prepare_op()])
    scenario("prepare: ownership lost between the checks is refused without preparing", ran_locked=(True, True),
             queue_=[queue(), {"items": []}], script=[prepare_op()])
    scenario("prepare: the queue is loaded again for preparation", ran_locked=(True, True),
             prepare=({"ok": 1},), script=[prepare_op(evidence={"a": [1, 2.5, None]})])

    # --- the scan closure -----------------------------------------------------------------------
    scenario("scan: a clean context scans patch-free then the whole context", scan=(True,), script=[scan_op()])
    scenario("scan: an unclean whole context answers the raw verdict", scan=(False,), script=[scan_op()])
    scenario("scan: the raw verdict is returned, not a bool", scan=([0],), script=[scan_op()])
    scenario("scan: an unclean retained patch stops at once",
             scan=(False,), script=[scan_op(context(retained_patch="secret"))])
    scenario("scan: a clean retained patch continues",
             scan=(True, True), script=[scan_op(context(retained_patch="fine"))])
    scenario("scan: a falsy verdict string on the patch stops", scan=("",),
             script=[scan_op(context(retained_patch="p"))])
    scenario("scan: a non-string truthy patch is passed to the scanner as is", scan=(True, True),
             script=[scan_op(context(retained_patch=[1]))])
    scenario("scan: attempt patches are indexed and falsy patches skipped but counted",
             scan=(True, True, True, True),
             script=[scan_op(context(retained_attempts=[{"patches": ["", None, "a"]}, {"patches": ["b", "c"]}]))])
    scenario("scan: an unclean attempt patch stops the walk", scan=(True, False),
             script=[scan_op(context(retained_attempts=[{"patches": ["a"]}, {"patches": ["b", "c"]}]))])
    scenario("scan: an unclean second attempt part stops there", scan=(True, True, False),
             script=[scan_op(context(retained_attempts=[{"patches": ["a", "b"]}, {"patches": ["c"]}]))])
    scenario("scan: a contract diff is scanned with Python splitlines",
             scan=(True, True),
             script=[scan_op(context(current_contract={"path": "docs/c.md", "text": "a\r\nb\x0bc d\x85e\x1cf\n"}))])
    scenario("scan: an empty-line contract keeps its blank lines",
             scan=(True, True),
             script=[scan_op(context(current_contract={"path": "p.md", "text": "a\n\nb"}))])
    scenario("scan: an unclean contract stops before the whole-context scan", scan=(False,),
             script=[scan_op(context(current_contract={"path": "p.md", "text": "tok"}))])
    scenario("scan: a falsy contract text is not scanned", scan=(True,),
             script=[scan_op(context(current_contract={"path": 5, "text": ""}))])
    scenario("scan: a truthy non-string contract path is a TypeError",
             script=[scan_op(context(current_contract={"path": 5, "text": "x"}))])
    scenario("scan: a missing contract path is a KeyError",
             script=[scan_op(context(current_contract={"text": "x"}))])
    scenario("scan: a truthy non-string contract text is an AttributeError",
             script=[scan_op(context(current_contract={"path": "p", "text": ["a"]}))])
    scenario("scan: the path is checked before the text kind",
             script=[scan_op(context(current_contract={"path": None, "text": ["a"]}))])
    scenario("scan: a missing retained_patch is a KeyError", script=[scan_op({"finding": {"path": "a"}})])
    scenario("scan: a list context is a TypeError", script=[scan_op([1])])
    scenario("scan: a null retained_attempts is a TypeError", script=[scan_op(context(retained_attempts=None))])
    scenario("scan: a string retained_attempts iterates characters into a TypeError",
             script=[scan_op(context(retained_attempts="ab"))])
    scenario("scan: a dict retained_attempts iterates keys into a TypeError",
             script=[scan_op(context(retained_attempts={"patches": []}))])
    scenario("scan: an attempt without patches is a KeyError",
             script=[scan_op(context(retained_attempts=[{}]))])
    scenario("scan: an int patches list is a TypeError",
             script=[scan_op(context(retained_attempts=[{"patches": 3}]))])
    scenario("scan: a missing current_contract is a KeyError",
             script=[scan_op({"finding": {"path": "a"}, "retained_patch": "", "retained_attempts": []})])
    scenario("scan: a missing contract text is a KeyError",
             script=[scan_op(context(current_contract={"path": "p"}))])
    scenario("scan: a null contract is a TypeError", script=[scan_op(context(current_contract=None))])
    scenario("scan: the whole-context scan uses current_path when present", scan=(True,),
             script=[scan_op(context(current_path="src/z.py"))])
    scenario("scan: a context with no path at all is a KeyError after the earlier scans", scan=(True,),
             script=[scan_op({"retained_patch": "x", "retained_attempts": [],
                              "current_contract": {"path": "p", "text": ""}})])
    scenario("scan: a truthy non-string current_path is a TypeError", scan=(True,),
             script=[scan_op(context(current_path=5))])
    scenario("scan: a truthy non-string finding path is a TypeError", scan=(True,),
             script=[scan_op(context(finding={"path": 7}))])
    scenario("scan: the finding path default is used when both paths are falsy", scan=(True,),
             script=[scan_op(context(finding={"path": ""}))])
    scenario("scan: strings are flattened in document order with splitlines edges", scan=(True,),
             script=[scan_op(context(finding={"path": "src/a.py", "t": "x\r\ny z", "n": [1, "q", {"k": "w"}]}))])
    scenario("scan: the output name replaces the last component", scan=(True, True),
             script=[scan_op(context(retained_patch="p"), output="/T/root/odd.dir/x.json")])

    # --- several closure calls in one recover ----------------------------------------------------
    scenario("flow: judge, prepare and scan in one recover", ran_locked=(True, True),
             runner_disabled=(False,), blocked=(False,), dispatch=({"stop": "ok"},), prepare=({"p": 1},), scan=(True,),
             script=[scan_op(), judge_op(), prepare_op()])


def _run(spec: dict) -> dict:
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="recover-job-")))
    prefix = str(tmp)
    trace: list = []

    def scrub(value):
        text = json.dumps(value, default=str, ensure_ascii=True)
        return json.loads(text.replace(prefix, "/T"))

    def unscrub(value):
        return json.loads(json.dumps(value).replace("/T", prefix))

    spec = unscrub(spec)
    seams = copy.deepcopy(spec["seams"])
    queue_state = copy.deepcopy(spec["queue"])
    queues = queue_state if isinstance(queue_state, list) and queue_state and isinstance(queue_state[0], dict) \
        and "items" in queue_state[0] else None

    def answer(name):
        items = seams[name]
        if not items:
            raise Exhausted(name)
        item = items.pop(0)
        if isinstance(item, dict) and set(item) == {"raise"}:
            info = item["raise"]
            raise EXC[info["kind"]](info["message"])
        return item

    def ran_locked(fn):
        result = answer("ran_locked")
        trace.append(["ran_locked", bool(result)])
        if result:
            fn()
        return result

    def load_queue():
        trace.append(["load_queue"])
        if queues is not None:
            return queues.pop(0) if len(queues) > 1 else queues[0]
        return queue_state

    def secret_scan_diff(diff, output):
        trace.append(["secret_scan_diff", scrub(diff), scrub(str(output))])
        return (answer("scan"),)

    def finding_inbox(c):
        trace.append(["finding_inbox"])

        def retained():
            trace.append(["retained"])
            return copy.deepcopy(spec["retained"])
        return types.SimpleNamespace(publication=types.SimpleNamespace(retained=retained))

    def prepare_current_job(c, queue_arg, old_id, tip, evidence, preserve_worktree=False):
        trace.append(["prepare_current_job", scrub(queue_arg), old_id, tip, scrub(evidence), preserve_worktree])
        return answer("prepare")

    def runner_disabled():
        trace.append(["runner_disabled"])
        return answer("runner_disabled")

    def blocked(repair, now=None):
        trace.append(["blocked", scrub(repair)])
        return answer("blocked")

    def narrate(message):
        trace.append(["narrate", message])

    def publish_refusal():
        trace.append(["publish_refusal"])

    def dispatch(config_, role, request, clone, directory, judge=False):
        trace.append(["dispatch", scrub(role), scrub(request), scrub(clone), scrub(str(directory)), bool(judge)])
        return answer("dispatch")

    def recover(root, config_, job_id, scan, judge, prepare):
        trace.append(["recover", scrub(str(root)), job_id])
        outcomes = []
        for op in spec["script"]:
            entry = {"op": op["op"]}
            try:
                if op["op"] == "judge":
                    entry["returned"] = scrub(judge(op["old"], op["context"], Path(op["directory"])))
                elif op["op"] == "prepare":
                    entry["returned"] = scrub(prepare(op["old_id"], op["tip"], op["evidence"]))
                else:
                    entry["returned"] = scrub(scan(op["context"], Path(op["output"])))
            except Exhausted:
                raise
            except Exception as exc:
                name = type(exc).__name__
                entry["raises"] = name
                if name in MESSAGE_KINDS:
                    entry["message"] = scrub(str(exc))
            outcomes.append(entry)
        trace.append(["recover-ops", outcomes])
        return spec["recover_returns"]

    fake_crq = types.ModuleType("crq")
    fake_crq.load_queue = load_queue
    fake_crq.ran_locked = ran_locked
    fake_crq.secret_scan_diff = secret_scan_diff
    fake_tick = types.ModuleType("repair_tick")
    fake_tick.finding_inbox = finding_inbox
    fake_tick.prepare_current_job = prepare_current_job
    fake_recovery = types.SimpleNamespace(recover=recover)

    import crq_repair
    patches = {"ROOT": tmp / "root", "runner_disabled": runner_disabled, "blocked": blocked, "narrate": narrate,
               "publish_refusal": publish_refusal, "dispatch": dispatch}
    saved = {name: getattr(service, name) for name in patches}
    saved_modules = {name: sys.modules.get(name) for name in ("crq", "repair_tick")}
    had_recovery = "recovery" in vars(crq_repair)
    saved_recovery = vars(crq_repair).get("recovery")
    os.environ["LANG"] = "C.UTF-8"
    try:
        for name, value in patches.items():
            setattr(service, name, value)
        sys.modules["crq"] = fake_crq
        sys.modules["repair_tick"] = fake_tick
        crq_repair.recovery = fake_recovery
        for rel, text in spec["files"].items():
            path = tmp / "root" / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", errors="surrogateescape")
        (tmp / "root" / "state/repair/inbox").mkdir(parents=True, exist_ok=True)
        try:
            try:
                returned = service.recover_job(copy.deepcopy(spec["config"]), spec["job_id"])
            except Exhausted as gap:
                GAPS.append(f"{spec['name']!r}: ran out of scripted {gap} answers")
                return {"trace": trace, "gap": str(gap)}
            outcome = {"returned": scrub(returned)}
        except Exception as exc:  # the recorded subject: what escapes recover_job()
            name = type(exc).__name__
            outcome = {"raises": name}
            if name in MESSAGE_KINDS:
                outcome["message"] = scrub(str(exc))
    finally:
        for name, value in saved.items():
            setattr(service, name, value)
        for name, module in saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        if had_recovery:
            crq_repair.recovery = saved_recovery
        else:
            vars(crq_repair).pop("recovery", None)
        shutil.rmtree(tmp, ignore_errors=True)
    return {"trace": trace, **outcome}


GAPS: list[str] = []


def build() -> dict:
    SCENARIOS.clear()
    GAPS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    cases = [{"name": s["name"], "scenario": s, "expected": _run(copy.deepcopy(s))} for s in SCENARIOS]
    if GAPS:
        raise SystemExit("scenario scripting gaps:\n  " + "\n  ".join(GAPS))
    return {"schema": SCHEMA, "job": JOB, "cases": cases}


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
        print("recover-job fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
