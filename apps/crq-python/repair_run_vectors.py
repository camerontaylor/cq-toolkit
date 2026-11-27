#!/usr/bin/env python3
"""Deterministic offline oracle for the TS port of the ``run`` result lane (S2).

Test tooling only. It runs the PRODUCTION ``crq_repair.run`` (the
``--triage-dry-run`` branch and the drain tail), ``crq_repair.drain`` and
``crq_repair.main`` (``crq_repair.py:972-1073, 1558-1698``) over a throwaway
root and records, per scenario, the ordered trace of every injected seam call
and the value (or exception class) that came out.

Only effects are replaced: ``runner_disabled``, ``worker_limit``,
``dispatch_paused``, ``fetch_clone``, ``triage_phase``, ``drain_order``,
``drain_job``, ``unreadable_result``, ``pending``, ``hold_backfill_groups``,
``drain_items``, ``narrate`` and ``write_result``. The inbox and queue file
reads, the grouping, the stable priority sort, the result folding, the real
``service.lock`` flock (a scenario holds it from a second descriptor) and the
``state/repair`` mkdir are the real production code against real files under a
temporary root. The oracle also records what each file read produced
(``reads``) so the TS replay can inject the same outcomes.

Regenerate with ``python3 repair_run_vectors.py --write``; verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-run-lane" / "cases.json"
SCHEMA = "cq.crq-run-lane-vector/v1"
EXC = {"ValueError": ValueError, "KeyError": KeyError, "RuntimeError": RuntimeError,
       "OSError": OSError, "AttributeError": AttributeError, "TypeError": TypeError}
BASE_CONFIG = {"repair": {"enabled": True, "spend_authorization": "x", "roles": {}}}


def _service():
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("repair_run_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()


class Exhausted(BaseException):
    """A scenario ran out of scripted answers: never caught by ``except Exception``."""


SCENARIOS: list[dict] = []
GAPS: list[str] = []


def raising(kind, message):
    return {"raise": {"kind": kind, "message": message}}


def scenario(name, kind, **spec):
    base = {"name": name, "kind": kind, "config": copy.deepcopy(BASE_CONFIG), "files": {}, "answers": {},
            "lock": "free", "state_dir_blocked": False, "argv": []}
    base.update(spec)
    SCENARIOS.append(base)


def answers(**given):
    """Per-seam answer lists; a seam without an entry answers its default."""
    return given


def job(item, **extra):
    return json.dumps({"item": item, **extra})


def drain_scn(name, **spec):
    scenario(name, "drain", **spec)


def build_scenarios() -> None:
    # --- drain admission ------------------------------------------------------------------
    drain_scn("drain: runner disabled at the start narrates and returns a refused status",
              answers=answers(runner_disabled=[True]))
    drain_scn("drain: missing repair key is a KeyError", config={}, answers=answers(runner_disabled=[False]))
    drain_scn("drain: repair null is enough for the key read", config={"repair": None},
              answers=answers(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                              triage_phase=[None], drain_order=[[]]))
    drain_scn("drain: worker_limit failure propagates before dispatch_paused",
              answers=answers(runner_disabled=[False], worker_limit=[raising("ValueError", "bad worker limit")]))
    drain_scn("drain: rate limit pause returns a paused status",
              answers=answers(runner_disabled=[False], dispatch_paused=["2030-01-01T00:00:00Z"]))
    drain_scn("drain: empty pause text is falsy",
              answers=answers(runner_disabled=[False, False], dispatch_paused=["", None],
                              fetch_clone=[None], triage_phase=[None], drain_order=[[]]))
    drain_scn("drain: fetch error narrates 200 characters",
              answers=answers(runner_disabled=[False], dispatch_paused=[None], fetch_clone=["e" * 250]))
    drain_scn("drain: fetch error clipped by code point",
              answers=answers(runner_disabled=[False], dispatch_paused=[None], fetch_clone=["\U0001F600" * 201]))
    drain_scn("drain: an empty fetch error is still an error",
              answers=answers(runner_disabled=[False], dispatch_paused=[None], fetch_clone=[""]))
    drain_scn("drain: marker written during the fetch stops before triage",
              answers=answers(runner_disabled=[False, True], dispatch_paused=[None], fetch_clone=[None]))
    # --- the triage fold --------------------------------------------------------------------
    base = dict(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                drain_order=[[]])
    drain_scn("drain: triage report rides inside the result",
              answers=answers(**base, triage_phase=[{"phase": "triage", "n": 2}]))
    drain_scn("drain: no triage leaves the plain drained result",
              answers=answers(**base, triage_phase=[None]))
    drain_scn("drain: an empty triage report is not None",
              answers=answers(**base, triage_phase=[{}]))
    drain_scn("drain: triage failure is narrated and the pass continues",
              answers=answers(**base, triage_phase=[raising("ValueError", "backfill " + "x" * 400)]))
    drain_scn("drain: triage failure clipped by code point",
              answers=answers(**base, triage_phase=[raising("RuntimeError", "\U0001F600" * 301)]))
    drain_scn("drain: triage KeyError narrates the repr'd key",
              answers=answers(**base, triage_phase=[raising("KeyError", "missing")]))
    drain_scn("drain: triage OSError is also deferred",
              answers=answers(**base, triage_phase=[raising("OSError", "disk")]))
    drain_scn("drain: a pause after triage returns the result with the report",
              answers=answers(runner_disabled=[False, False], dispatch_paused=[None, "later"], fetch_clone=[None],
                              triage_phase=[{"t": 1}]))
    # --- grouping ---------------------------------------------------------------------------
    gbase = dict(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                 triage_phase=[None])
    inbox = "state/repair/inbox/"
    drain_scn("drain: jobs group by item in drain order, duplicates kept",
              files={inbox + "a.json": job("x"), inbox + "b.json": job("y"), inbox + "c.json": job("x")},
              answers=answers(**gbase, drain_order=[["a", "b", "c", "a"]]))
    drain_scn("drain: unreadable and non-dict jobs are skipped",
              raw_files={inbox + "bin.json": [255, 254, 250]},
              files={inbox + "bad.json": "{not json", inbox + "list.json": "[1, 2]", inbox + "null.json": "null",
                     inbox + "num.json": "3", inbox + "str.json": '"s"', inbox + "ok.json": job("x")},
              answers=answers(**gbase, drain_order=[["gone", "bad", "bin", "list", "null", "num", "str", "ok"]]))
    drain_scn("drain: non-string and absent items are not grouped",
              files={inbox + "i.json": job(7), inbox + "n.json": job(None), inbox + "m.json": "{}",
                     inbox + "b.json": job(True), inbox + "e.json": job(""), inbox + "l.json": job(["x"])},
              answers=answers(**gbase, drain_order=[["i", "n", "m", "b", "e", "l"]]))
    drain_scn("drain: duplicate keys keep the last value",
              files={inbox + "d.json": '{"item": "first", "item": "second"}'},
              answers=answers(**gbase, drain_order=[["d"]]))
    drain_scn("drain: non-UTF-8 job bytes are a skipped read",
              raw_files={inbox + "u.json": [255, 254, 253], inbox + "ok.json": [123, 125]},
              answers=answers(**gbase, drain_order=[["u", "ok"]]))
    drain_scn("drain: non-UTF-8 job beside a good job",
              raw_files={inbox + "u.json": [255, 254, 253]}, files={inbox + "ok.json": job("x")},
              answers=answers(**gbase, drain_order=[["u", "ok"]]))
    # --- the queue --------------------------------------------------------------------------
    qbase = dict(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                 triage_phase=[{"t": 1}], drain_order=[[]])
    drain_scn("drain: an absent queue is the empty queue", answers=answers(**qbase))
    drain_scn("drain: a queue is read once and handed to hold",
              files={"state/queue.json": json.dumps({"items": [{"id": "x"}]})}, answers=answers(**qbase))
    drain_scn("drain: a list queue is passed through", files={"state/queue.json": "[1]"}, answers=answers(**qbase))
    drain_scn("drain: an unparsable queue keeps the triage report and errors",
              files={"state/queue.json": "{nope"}, answers=answers(**qbase))
    drain_scn("drain: a non-UTF-8 queue is a read failure",
              raw_files={"state/queue.json": [255, 254]}, answers=answers(**qbase))
    drain_scn("drain: an empty queue file is a read failure",
              files={"state/queue.json": ""}, answers=answers(**qbase))
    # The read error names the queue path; a deep root makes `str(exc)` exceed the 300 clip.
    drain_scn("drain: a long queue error is clipped",
              root_parts=["d" * 120, "d" * 120, "d" * 120], dirs=["state/queue.json"],
              answers=answers(**qbase))
    # --- priority, hold and the worker pool ---------------------------------------------------
    pbase = dict(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                 triage_phase=[None])
    pfiles = {inbox + "a1.json": job("a"), inbox + "b1.json": job("b"), inbox + "c1.json": job("c"),
              inbox + "b2.json": job("b")}
    drain_scn("drain: critical and major items sort before minor, stably",
              files=pfiles,
              answers=answers(**pbase, drain_order=[["a1", "b1", "c1", "b2"]],
                              drain_job={"a1": ["run", {"item": "a", "finding": {"severity": "minor"}}],
                                         "b1": ["run", {"item": "b", "finding": {"severity": "minor"}}],
                                         "b2": ["run", {"item": "b", "finding": {"severity": "major"}}],
                                         "c1": ["run", {"item": "c", "finding": {"severity": "critical"}}]},
                              pending=["a1", "b1", "b2", "c1"], drain_items=[[]]))
    drain_scn("drain: every priority gate",
              files={inbox + n + ".json": job(i) for n, i in
                     [("s", "skip"), ("o", "other"), ("u", "unread"), ("p", "nopend"), ("e", "empty"),
                      ("n", "none"), ("f", "nofinding"), ("c", "crit")]},
              answers=answers(**pbase, drain_order=[["s", "o", "u", "p", "e", "n", "f", "c"]],
                              drain_job={"s": ["skip", {"item": "skip", "finding": {"severity": "critical"}}],
                                         "o": ["run", {"item": "else", "finding": {"severity": "critical"}}],
                                         "u": ["run", {"item": "unread", "finding": {"severity": "critical"}}],
                                         "p": ["run", {"item": "nopend", "finding": {"severity": "critical"}}],
                                         "e": ["run", {}], "n": ["run", None],
                                         "f": ["run", {"item": "nofinding"}],
                                         "c": ["run", {"item": "crit", "finding": {"severity": "major"}}]},
                              unreadable=["u"], pending=["s", "o", "u", "e", "n", "f", "c"],
                              drain_items=[[]]))
    drain_scn("drain: a non-dict finding is an AttributeError",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]],
                              drain_job={"x": ["run", {"item": "x", "finding": None}]}, pending=["x"]))
    drain_scn("drain: a non-dict finding on a non-pending job is never read",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]],
                              drain_job={"x": ["run", {"item": "x", "finding": [1]}]}, pending=[],
                              drain_items=[[]]))
    drain_scn("drain: a severity of another type is minor",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]],
                              drain_job={"x": ["run", {"item": "x", "finding": {"severity": ["major"]}}]},
                              pending=["x"], drain_items=[[]]))
    drain_scn("drain: held groups are dropped before priority",
              files=pfiles,
              answers=answers(**pbase, drain_order=[["a1", "b1", "c1", "b2"]], hold=["b"],
                              drain_job={"a1": ["run", {"item": "a"}], "c1": ["run", {"item": "c"}]},
                              pending=[], drain_items=[[]]))
    drain_scn("drain: worker failures are sorted into the error result",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[["b", "a", "B"]]))
    drain_scn("drain: worker failures sort by code point not UTF-16 unit",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[["\U0001F600", "～", "é", "z"]]))
    drain_scn("drain: the worker failure list is clipped to 300 after the prefix",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[["f" + str(i) * 40 for i in range(12)]]))
    drain_scn("drain: a duplicate failure id is kept",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[["a", "a"]]))
    drain_scn("drain: drain_items failure propagates",
              files={inbox + "x.json": job("x")},
              answers=answers(**pbase, drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[raising("OSError", "pool")]))
    drain_scn("drain: triage report survives a worker failure",
              files={inbox + "x.json": job("x")},
              answers=answers(runner_disabled=[False, False], dispatch_paused=[None, None], fetch_clone=[None],
                              triage_phase=[{"t": 9}], drain_order=[["x"]], drain_job={"x": ["skip", None]},
                              drain_items=[["z"]]))
    # --- run(): the dry-run lane ------------------------------------------------------------
    dry = ["--triage-dry-run"]
    scenario("dry-run: the triage report is the artifact", "run", argv=dry,
             answers=answers(triage_phase=[{"phase": "triage", "dry_run": True}]))
    scenario("dry-run: no triage is explicit", "run", argv=dry, answers=answers(triage_phase=[None]))
    scenario("dry-run: an empty report is a report", "run", argv=dry, answers=answers(triage_phase=[{}]))
    scenario("dry-run: a held service.lock is busy and triage never runs", "run", argv=dry, lock="held",
             answers=answers(triage_phase=[{"phase": "unused"}]))
    scenario("dry-run: a triage failure escapes", "run", argv=dry,
             answers=answers(triage_phase=[raising("RuntimeError", "judge died")]))
    scenario("dry-run: a blocked state directory escapes", "run", argv=dry, state_dir_blocked=True,
             answers=answers(triage_phase=[None]))
    scenario("dry-run: the lock is released after the report", "run", argv=dry, relock=True,
             answers=answers(triage_phase=[{"ok": 1}]))
    # --- run(): the drain tail ----------------------------------------------------------------
    scenario("tail: a deferred drain result is exit 0", "run",
             answers=answers(drain=[{"status": "deferred", "reason": "runner-disabled"}]))
    scenario("tail: an empty drain result stays empty", "run", answers=answers(drain=[{}]))
    scenario("tail: drained result is exit 0", "run",
             answers=answers(drain=[{"status": "drained", "triage": {"t": 1}}]))
    scenario("tail: error result is exit 1", "run",
             answers=answers(drain=[{"status": "error", "error": "worker failures: a"}]))
    scenario("tail: a different status is exit 0", "run", answers=answers(drain=[{"status": "refused"}]))
    scenario("tail: a held service.lock is busy and drain never runs", "run", lock="held",
             answers=answers(drain=[{"status": "drained"}]))
    scenario("tail: a drain failure escapes", "run", answers=answers(drain=[raising("ValueError", "bad")]))
    # --- main(): the failure lane -------------------------------------------------------------
    for label, kind, message in [
        ("short", "ValueError", "boom"),
        ("clipped past 200 and 300", "RuntimeError", "m" * 450),
        ("astral clipped by code point", "OSError", "\U0001F600" * 350),
        ("multi-line", "ValueError", "line one\nline two"),
        ("empty", "RuntimeError", ""),
        ("key error repr", "KeyError", "digest"),
        ("non-ascii", "TypeError", "café ☃"),
    ]:
        scenario("main: " + label, "main", answers=answers(run=[raising(kind, message)]))
    scenario("main: a normal run writes its result", "main", answers=answers(run=[[3, {"status": "x"}]]))
    scenario("main: a None result writes nothing", "main", answers=answers(run=[[0, None]]))


def _scrub(value, tmp):
    # The placeholder keeps the temp path's length, so a clip Python applied to an unscrubbed
    # message still lands on the same character of the scrubbed text.
    return json.loads(json.dumps(value).replace(str(tmp), "/T".ljust(len(str(tmp)), "_")))


def _read_outcome(path: Path):
    """The outcome of Python's ``json.loads(path.read_text())`` at ``path``."""
    try:
        return {"ok": json.loads(path.read_text())}
    except (OSError, ValueError) as exc:
        return {"raise": {"kind": type(exc).__name__, "message": str(exc)}}


def _exc_record(exc, tmp):
    name = type(exc).__name__
    record = {"raises": name}
    if name in EXC:
        record["message"] = _scrub(str(exc), tmp)
    return record


def _run(spec):
    tmp = Path(tempfile.mkdtemp(prefix="crq-run-lane-", dir="/tmp"))
    root = tmp.joinpath(*spec.get("root_parts", []), "root")
    root.mkdir(parents=True)
    trace: list = []
    answers_ = copy.deepcopy(spec["answers"])
    lock_fd = None
    reads: dict = {}

    def take(seam):
        queue = answers_.get(seam)
        if queue is None and seam == "worker_limit":
            return None  # validation only: answers unless a scenario scripts a failure
        if queue is None and seam == "drain_items":
            return []  # no failed workers unless a scenario scripts them
        if not queue:
            raise Exhausted(seam)
        item = queue.pop(0)
        if isinstance(item, dict) and set(item) == {"raise"}:
            raise EXC[item["raise"]["kind"]](item["raise"]["message"])
        return item

    def make(seam):
        def seam_fn(*call):
            trace.append([seam, *[_scrub(a, tmp) for a in call if not isinstance(a, Path) and not callable(a)]])
            return take(seam)
        return seam_fn

    def drain_job(root_, config, queue, job_id):
        trace.append(["drain_job", job_id, _scrub(queue, tmp)])
        status, doc = answers_.get("drain_job", {}).get(job_id, ["skip", None])
        return status, copy.deepcopy(doc), None

    def hold(groups, dispatchable=None):
        trace.append(["hold_backfill_groups", [[k, v] for k, v in groups.items()]])
        dropped = set(answers_.get("hold", []))
        return {k: v for k, v in groups.items() if k not in dropped}

    def drain_items(config, groups, order):
        trace.append(["drain_items", [[k, v] for k, v in groups.items()], list(order)])
        return take("drain_items")

    def drain_order(root_):
        trace.append(["drain_order"])
        return take("drain_order")

    def narrate(text):
        trace.append(["narrate", _scrub(text, tmp)])

    unreadable = set(answers_.get("unreadable", []))
    pending_ids = set(answers_.get("pending", []))
    patches = {
        "ROOT": root, "runner_disabled": make("runner_disabled"), "worker_limit": make("worker_limit"),
        "dispatch_paused": make("dispatch_paused"), "fetch_clone": make("fetch_clone"),
        "triage_phase": None, "drain_order": drain_order, "drain_job": drain_job,
        "unreadable_result": lambda job_id: job_id in unreadable, "pending": lambda job_id: job_id in pending_ids,
        "hold_backfill_groups": hold, "drain_items": drain_items, "narrate": narrate, "blocked": lambda r: False,
    }
    def triage_phase(config, dry_run=False):
        trace.append(["triage_phase", _scrub(config, tmp), dry_run])
        return take("triage_phase")

    patches["triage_phase"] = triage_phase
    if spec["kind"] == "run" and "drain" in answers_:
        def drain_stub(config):
            trace.append(["drain"])
            return take("drain")
        patches["drain"] = drain_stub
    if spec["kind"] == "main":
        def run_stub(argv=None):
            trace.append(["run", argv])
            return take("run")
        patches["run"] = run_stub
        patches["write_result"] = lambda result: trace.append(["write_result", _scrub(result, tmp)])
    if spec["kind"] != "drain":
        patches["runner_disabled"] = lambda: False
    saved = {name: getattr(service, name) for name in patches if hasattr(service, name)}
    try:
        for name, value in patches.items():
            setattr(service, name, value)
        for rel, text in spec["files"].items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        for rel, data in spec.get("raw_files", {}).items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bytes(data))
        for rel in spec.get("dirs", []):
            (root / rel).mkdir(parents=True, exist_ok=True)
        (root / "state/repair/inbox").mkdir(parents=True, exist_ok=True)
        (root / "config.json").write_text(json.dumps(spec["config"]), encoding="utf-8")
        if spec["kind"] == "drain":
            for rel in [p for p in list(spec["files"]) + list(spec.get("raw_files", {})) + spec.get("dirs", [])
                        if p.startswith("state/repair/inbox/") or p == "state/queue.json"]:
                if rel == "state/queue.json" or (root / rel).exists():
                    reads[rel] = _read_outcome(root / rel)
        if spec["state_dir_blocked"]:
            shutil.rmtree(root / "state/repair")
            (root / "state/repair").write_text("not a directory", encoding="utf-8")
        if spec["lock"] == "held":
            lock_fd = open(root / "state/repair/service.lock", "a")
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if spec["kind"] == "drain":
                returned = service.drain(copy.deepcopy(spec["config"]))
                outcome = {"returned": _scrub(returned, tmp)}
            elif spec["kind"] == "run":
                code, result = service.run(spec["argv"])
                outcome = {"returned": [code, _scrub(result, tmp)]}
                if spec.get("relock"):
                    probe = open(root / "state/repair/service.lock", "a")
                    try:
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        outcome["relocked"] = True
                    except BlockingIOError:
                        outcome["relocked"] = False
                    finally:
                        probe.close()
            else:
                code = service.main([])
                outcome = {"returned": code}
        except Exhausted as gap:
            GAPS.append(f"{spec['name']!r}: ran out of scripted {gap} answers")
            return {"trace": trace, "gap": str(gap)}
        except Exception as exc:  # the recorded subject: what escapes the entry point
            outcome = _exc_record(exc, tmp)
    finally:
        for name, value in saved.items():
            setattr(service, name, value)
        for name in patches:
            if name not in saved:
                vars(service).pop(name, None)
        if lock_fd is not None:
            lock_fd.close()
        shutil.rmtree(tmp, ignore_errors=True)
    if spec["kind"] == "main":
        outcome = _main_outcome(trace, outcome)
    expected = {"trace": trace, **outcome}
    if spec["kind"] == "drain":
        expected["reads"] = _scrub(reads, tmp)
    return expected


def _main_outcome(trace, outcome):
    """Fold the traceback narration to its stable part: Python's frames are not portable."""
    for entry in trace:
        if entry[0] == "narrate" and entry[1].startswith("Traceback (most recent call last):"):
            entry[1] = {"traceback_ends_with": entry[1].rsplit("\n", 2)[-2] + "\n"}
    return outcome


GAPS: list[str] = []


def build() -> dict:
    SCENARIOS.clear()
    GAPS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    cases = []
    for s in SCENARIOS:
        expected = _run(copy.deepcopy(s))
        if s["kind"] == "drain":
            s = {**s, "reads": expected.pop("reads", {})}
        cases.append({"name": s["name"], "scenario": s, "expected": expected})
    assert not GAPS, GAPS
    return {"schema": SCHEMA, "cases": cases}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(case, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
             for case in document["cases"]]
    return json.dumps(head, ensure_ascii=True, sort_keys=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("run-lane fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
