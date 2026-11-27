#!/usr/bin/env python3
"""Deterministic offline oracle for the repair-harvest effects that were still injected.

Test tooling only. It runs the PRODUCTION ``repair_tick.finalize_publication``
(``repair_tick.py:867``) with ``crq.run`` / ``crq.gh_json`` / ``crq.new_item`` /
``crq.save_queue`` / ``crq.iso`` (``crq.py:108``, ``:177``, ``:294``, ``:3104``) against a FAKE ``gh``
script on a temporary ``PATH``, the compaction branch of ``crq.save_queue`` (``crq.py:294-302``,
``admission_history.log_compaction``), and the gitleaks block of ``crq.secret_scan_diff``
(``crq.py:639-669``) against a FAKE ``gitleaks`` on a temporary ``PATH``. The TypeScript side runs the
same two scripts, written from this file's fixture, so both sides see byte-identical binaries.

Nothing here touches a live forge, token, network or queue. Clock: ``crq.now`` is frozen.
Paths start with ``/T``; the oracle substitutes its temporary directory both ways.

Regenerate with ``python3.14 repair_harvest_rest_vectors.py --write``; verify with ``--check``.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import io
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
import admission_history  # noqa: E402
import crq  # noqa: E402
import repair_tick  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-repair-harvest-rest" / "cases.json"
SCHEMA = "cq.crq-repair-harvest-rest-vector/v1"
FROZEN = dt.datetime(2026, 11, 27, 1, 2, 3, 999000, tzinfo=dt.timezone.utc)

# The fake `gh`: logs argv, answers `pr list` before/after a create, and `pr create` per spec.
GH_SCRIPT = r"""#!/usr/bin/env python3
import json, os, sys
d = os.environ["GH_FAKE_DIR"]
spec = json.load(open(os.path.join(d, "spec.json")))
with open(os.path.join(d, "log.jsonl"), "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
created = os.path.join(d, "created")
if sys.argv[1:3] == ["pr", "list"]:
    if spec.get("list_code"):
        sys.stderr.write(spec.get("list_stderr", ""))
        sys.exit(spec["list_code"])
    sys.stdout.write(spec["list_after"] if os.path.exists(created) else spec["list_before"])
elif sys.argv[1:3] == ["pr", "create"]:
    sys.stderr.write(spec["create_stderr"])
    if spec["create_code"] == 0 and spec.get("lands", True):
        open(created, "w").close()
    sys.exit(spec["create_code"])
else:
    sys.exit(97)
"""

# The fake `gitleaks`: logs argv (report path elided) and stdin, writes the report per spec.
GITLEAKS_SCRIPT = r"""#!/usr/bin/env python3
import json, os, sys
d = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(d, "spec.json")))
argv = sys.argv[1:]
report = argv[argv.index("--report-path") + 1]
argv[argv.index("--report-path") + 1] = "<report>"
data = sys.stdin.buffer.read()
with open(os.path.join(d, "log.json"), "w") as f:
    json.dump({"argv": argv, "stdin": data.hex()}, f)
if spec.get("report") is not None:
    with open(report, "w") as f:
        f.write(spec["report"])
sys.exit(spec["code"])
"""

QUEUE_TEXT = ('{"items": [{"id": "r1", "pr": 7, "kind": "open", "state": "pending", "order": 3, "weight": 1.0},'
              ' {"id": "m1", "pr": 8, "kind": "merged", "state": "repairing", "order": 1}],'
              ' "retained": 1.50}')
PRS_ONE = '[{"number": 41, "url": "https://example.test/pull/41", "state": "OPEN", "headRefOid": "hA"}]'
PRS_WRONG_HEAD = '[{"number": 41, "url": "u", "state": "OPEN", "headRefOid": "other"}]'
PRS_TWO = ('[{"number": 41, "url": "u", "state": "OPEN", "headRefOid": "hA"},'
           ' {"number": 42, "url": "u2", "state": "OPEN", "headRefOid": "hA"}]')

SCENARIOS: list[dict] = []


def add(name: str, op: str, **kw) -> None:
    SCENARIOS.append({"name": name, "op": op, **copy.deepcopy(kw)})


def finalize(name: str, *, gh: dict, queue_text: str = QUEUE_TEXT, item_index: int = 0, backlog=None,
             fix_pr_cycles=None, publication=None, record=None) -> None:
    base_gh = {"list_before": "[]", "list_after": PRS_ONE, "create_code": 0, "create_stderr": ""}
    add(name, "finalize", queue_text=queue_text, item_index=item_index,
        backlog=backlog or {"open": None, "limit": None}, fix_pr_cycles=fix_pr_cycles,
        publication=publication or {"head": "hA", "target": "t", "branch": "crq/fix-run-a", "commits": ["c1"],
                                    "open_pr": False},
        record=record, gh={**base_gh, **gh})


def build_scenarios() -> None:
    # --- gh pr create + new_item + save_queue through the real finalize_publication ---------
    finalize("create lands, the PR is enrolled", gh={})
    finalize("create lands, fix_pr_cycles 2 is overwritten to prior_cycles 0 for a kind=open item", gh={},
             fix_pr_cycles=2)
    finalize("an existing PR is adopted without a create", gh={"list_before": PRS_ONE})
    finalize("create exits non-zero: RuntimeError with the stderr tail", gh={"create_code": 3,
             "create_stderr": "  boom \r\nsecond line\n  "})
    finalize("create stderr is clipped at 400 code points", gh={"create_code": 1, "create_stderr": "é" * 500})
    finalize("create exit 1 with empty stderr", gh={"create_code": 1})
    finalize("create lands but the listing finds nothing: identity refusal", gh={"list_after": "[]"})
    finalize("create lands at another head: identity refusal", gh={"list_after": PRS_WRONG_HEAD})
    finalize("create lands but two PRs match: identity refusal", gh={"list_after": PRS_TWO})
    finalize("the re-list fails after a create", gh={"list_code": 1, "list_stderr": "nope", "list_before": "[]"})
    finalize("a backfill item reserves a slot and releases it on a failed create",
             gh={"create_code": 1, "create_stderr": "x"}, queue_text=QUEUE_TEXT.replace('"r1"', '"backfill-finding-9"'),
             backlog={"open": 2, "limit": 5})
    finalize("a backfill item holds without a free slot", gh={}, queue_text=QUEUE_TEXT.replace('"r1"', '"backfill-finding-9"'),
             backlog={"open": 5, "limit": 5})
    finalize("a backfill item keeps the reserved slot on a created PR", gh={},
             queue_text=QUEUE_TEXT.replace('"r1"', '"backfill-finding-9"'), backlog={"open": 1, "limit": 5})
    finalize("the fix PR is already enrolled, so no new item", gh={},
             queue_text=QUEUE_TEXT.replace('"m1", "pr": 8', '"m1", "pr": 41'))
    finalize("a non-dict queue entry fails the enroll", gh={},
             queue_text=QUEUE_TEXT.replace('{"id": "m1"', '"junk", {"id": "m1"'))
    finalize("an item with an unrelated float stays byte-identical in the saved queue", gh={},
             queue_text=QUEUE_TEXT.replace('"weight": 1.0', '"weight": 1e2'))
    finalize("pr create attempts exhausted: stale", gh={}, publication={
        "head": "hA", "target": "t", "branch": "crq/fix-run-a", "commits": [], "open_pr": False,
        "pr_create_attempts": 3})
    finalize("a unicode branch and reason body", gh={}, publication={
        "head": "hA", "target": "t", "branch": "crq/fix-run-a", "commits": [], "open_pr": False},
        record={"jobs": ["crq-job-a"], "state": "ready",
                "verdicts": [{"job": "crq-job-a", "verdict": "FIXED", "reason": "a|b\nc ü"}]})
    # --- admission-history compaction log in save_queue ----------------------------------------
    marker = admission_history.MARKER
    for label, value in (("1", "1"), ("1.0", "1.0"), ("true", "true"), ("2", "2"), ('"1"', '"1"'), ("0", "0"),
                         ("null", "null"), ("[1]", "[1]"), ("1e0", "1e0"), ("1.5", "1.5")):
        for pending in ("fresh", "stale", "missing", "none"):
            add(f"compaction: marker {label}, pending {pending}", "compaction",
                queue_text=f'{{"items": [], "{marker}": {value}, "n": 1.0}}', pending=pending)
    add("compaction: no marker, pending fresh", "compaction", queue_text='{"items": []}', pending="fresh")
    add("compaction: a list document with a pending load is an AttributeError", "compaction",
        queue_text="[1, 2]", pending="fresh")
    add("compaction: a list document without a pending load writes", "compaction", queue_text="[1, 2]",
        pending="none")
    add("compaction: a null document with a pending load is an AttributeError", "compaction", queue_text="null",
        pending="fresh")
    add("compaction: a second save does not log again", "compaction", pending="fresh", twice=True,
        queue_text=f'{{"items": [], "{marker}": 1}}')
    add("compaction: pending is cleared by a save that does not log", "compaction", pending="stale", twice=True,
        queue_text=f'{{"items": [], "{marker}": 1}}')
    # --- gitleaks invocation -------------------------------------------------------------------
    diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1 @@\n+hello\n"
    for name, spec in (
        ("clean report", {"code": 0, "report": "[]"}),
        ("one finding", {"code": 0, "report": '[{"RuleID": "generic-api-key", "StartLine": 5}]'}),
        ("two findings, one without a line", {"code": 0, "report": '[{"RuleID": "a", "StartLine": 5}, {"RuleID": "b"}]'}),
        ("a finding without a rule", {"code": 0, "report": '[{"StartLine": 2}]'}),
        ("exit 2 is a gitleaks-error hit", {"code": 2, "report": "[]"}),
        ("exit 1 ignores a written report", {"code": 1, "report": '[{"RuleID": "a", "StartLine": 5}]'}),
        ("exit 0 with no report file", {"code": 0, "report": None}),
        ("exit 0 with an empty report file", {"code": 0, "report": ""}),
        ("a string line number", {"code": 0, "report": '[{"RuleID": "a", "StartLine": "5"}]'}),
        ("a float line number", {"code": 0, "report": '[{"RuleID": "a", "StartLine": 5.0}]'}),
        ("a zero line number", {"code": 0, "report": '[{"RuleID": "a", "StartLine": 0}]'}),
        ("a non-string rule", {"code": 0, "report": '[{"RuleID": 4, "StartLine": 1}]'}),
        ("a non-dict finding", {"code": 0, "report": "[1]"}),
        ("a null report", {"code": 0, "report": "null"}),
        ("an object report", {"code": 0, "report": '{"RuleID": "a"}'}),
        ("a malformed report", {"code": 0, "report": "{"}),
    ):
        add(f"gitleaks: {name}", "gitleaks", diff=diff.encode().hex(), spec=spec, present=True)
    add("gitleaks: a missing binary reports not-run", "gitleaks", diff=diff.encode().hex(),
        spec={"code": 0, "report": "[]"}, present=False)
    for name, text in (("an empty diff", ""), ("CRLF and a lone CR survive stdin", "a\r\nb\rc\n"),
                       ("non-ASCII and astral text", "é日本\U0001F600\n"), ("no trailing newline", "x")):
        add(f"gitleaks: {name}", "gitleaks", diff=text.encode().hex(), spec={"code": 0, "report": "[]"}, present=True)
    # `str(TimeoutExpired)` for c.run's 600 s bound; the 600 s run itself is not waited for.
    add("run timeout text", "timeout-text", argv=["gh", "pr", "create", "--repo", "o/r", "--base", "main",
                                                   "--head", "b", "--title", "t", "--body-file", "/T/p.md"])


def _sub(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "/T")
    if isinstance(value, list):
        return [_sub(v, tmp) for v in value]
    if isinstance(value, dict):
        return {k: _sub(v, tmp) for k, v in value.items()}
    return value


def _install(directory: Path, name: str, script: str) -> None:
    path = directory / name
    path.write_text(script)
    path.chmod(0o755)


def _error(exc: BaseException) -> dict:
    return {"error": type(exc).__name__, "message": str(exc)}


def _run_finalize(spec: dict, root: Path, tmp: str) -> dict:
    state, clone, bindir, fake = root / "state", root / "clone", root / "bin", root / "fake"
    for d in (state / "repair" / "crq-job-a", clone, bindir, fake):
        d.mkdir(parents=True, exist_ok=True)
    (state / "queue.json").write_text(spec["queue_text"])
    q = json.loads(spec["queue_text"])
    _install(bindir, "gh", GH_SCRIPT)
    (fake / "spec.json").write_text(json.dumps(spec["gh"]))
    item = q["items"][spec["item_index"]]
    record = copy.deepcopy(spec.get("record")) or {
        "jobs": ["crq-job-a"], "state": "ready", "verdicts": [{"job": "crq-job-a", "verdict": "FIXED", "reason": "ok"}]}
    publication = copy.deepcopy(spec["publication"])
    out: dict = {}
    repair_tick.TICK_BACKLOG.update(open=spec["backlog"]["open"], limit=spec["backlog"]["limit"])
    env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}", "GH_FAKE_DIR": str(fake)}
    try:
        with contextlib.ExitStack() as stack:
            for name, value in (("STATE", state), ("EVENTS", state / "events.jsonl"), ("QUEUE", state / "queue.json"),
                                ("CLONE", clone), ("REPO", "o/r")):
                stack.enter_context(mock.patch.object(crq, name, value))
            stack.enter_context(mock.patch.object(crq, "now", lambda: FROZEN))
            stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
            stack.enter_context(mock.patch.object(repair_tick, "repair_provenance", return_value=[]))
            repair = {} if spec["fix_pr_cycles"] is None else {"fix_pr_cycles": spec["fix_pr_cycles"]}
            c = SimpleNamespace(STATE=state, REPO="o/r", run=crq.run, gh_json=crq.gh_json,
                                save_queue=crq.save_queue, iso=crq.iso, new_item=crq.new_item,
                                CONFIG={"repair": repair})
            try:
                repair_tick.finalize_publication(c, q, item, "run-a", record, publication)
                out["error"] = None
            except BaseException as exc:  # noqa: BLE001 - the class is the datum
                out.update(_error(exc))
    finally:
        backlog = dict(repair_tick.TICK_BACKLOG)
        repair_tick.TICK_BACKLOG.update(open=None, limit=None)
    out["backlog"] = backlog
    out["queue"] = q
    out["item"] = item
    out["record"] = record
    out["publication"] = publication
    for key, rel in (("queue_bytes", "state/queue.json"), ("events", "state/events.jsonl"),
                     ("body", "state/repair/crq-job-a/fix-pr.md"), ("journal", "state/repair/crq-job-a/publication.json")):
        path = root / rel
        out[key] = path.read_bytes().hex() if path.exists() else None
    log = fake / "log.jsonl"
    out["gh_log"] = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return out


def _run_compaction(spec: dict, root: Path) -> dict:
    state = root / "state"
    state.mkdir()
    queue = state / "queue.json"
    queue.write_text(spec["queue_text"])
    out: dict = {}
    with mock.patch.object(crq, "QUEUE", queue), mock.patch.object(crq, "_pending_admission_compaction", None):
        pending = spec["pending"]
        if pending != "none":
            crq._pending_admission_compaction = crq.queue_identity()
        if pending == "stale":
            queue.write_text(spec["queue_text"] + " ")
        if pending == "missing":
            queue.unlink()
        err = io.StringIO()
        saves: list[dict] = []
        for _ in range(2 if spec.get("twice") else 1):
            err = io.StringIO()
            entry: dict = {}
            try:
                with contextlib.redirect_stderr(err):
                    crq.save_queue(json.loads(spec["queue_text"]))
                entry["error"] = None
            except BaseException as exc:  # noqa: BLE001
                entry.update(_error(exc))
            entry["stderr"] = err.getvalue()
            entry["queue_bytes"] = queue.read_bytes().hex() if queue.exists() else None
            entry["pending_cleared"] = crq._pending_admission_compaction is None
            saves.append(entry)
        out["saves"] = saves
    return out


def _run_gitleaks(spec: dict, root: Path) -> dict:
    bindir = root / "bin"
    bindir.mkdir()
    (bindir / "spec.json").write_text(json.dumps(spec["spec"]))
    # PATH holds only this directory, so the scripts' `env python3` shebang needs a python3 in it too.
    (bindir / "python3").symlink_to(sys.executable)
    if spec["present"]:
        _install(bindir, "gitleaks", GITLEAKS_SCRIPT)
    diff = bytes.fromhex(spec["diff"]).decode()
    out: dict = {}
    # Only the gitleaks block is under test: the denylist is replaced by an empty rule set.
    with mock.patch.object(crq, "denylist_rules", lambda classes=None: []), \
            mock.patch.dict(os.environ, {"PATH": str(bindir)}):
        try:
            ok, result = crq.secret_scan_diff(diff, root / "scan.json", base="b", head="h")
            out.update(error=None, ok=ok, status=result["gitleaks"],
                       hits=[{k: v for k, v in h.items() if k != "file"} for h in result["gitleaks_hits"]])
        except BaseException as exc:  # noqa: BLE001
            out.update(_error(exc))
    log = bindir / "log.json"
    out["invocation"] = json.loads(log.read_text()) if log.exists() else None
    return out


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        op = spec["op"]
        if op == "finalize":
            out = _run_finalize(spec, root, tmp)
        elif op == "compaction":
            out = _run_compaction(spec, root)
        elif op == "gitleaks":
            out = _run_gitleaks(spec, root)
        else:
            out = {"text": str(subprocess.TimeoutExpired(spec["argv"], 600))}
        return _sub(out, tmp)


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    return {"schema": SCHEMA, "gh_script": GH_SCRIPT, "gitleaks_script": GITLEAKS_SCRIPT,
            "cases": [{"name": s["name"], "scenario": s, "expected": _run(copy.deepcopy(s))} for s in SCENARIOS]}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(c, ensure_ascii=True, separators=(",", ":")) for c in document["cases"]]
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
        print("repair-harvest-rest fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
