#!/usr/bin/env python3
"""Deterministic offline oracle for the TS ``repairDriverOutput`` validators.

Test tooling only. It drives the PRODUCTION ``crq_repair.drivers`` ``invoke``
functions with every external effect replaced, and records what Python does:

* codex: ``_stream_codex`` is replaced by a stub that writes the case's raw
  ``last.json`` bytes (or nothing) and returns a clean exit, so the recorded
  result is the validation tail of ``codex.invoke`` (48eedd939, c6a87eb95);
* paseo: ``command`` answers launch/inspect/logs/stop/archive from the case's
  recorded ``logs`` stdout and return code, so the recorded outcome is the
  verdict gate of ``paseo.invoke`` (a508c93ca);
* cq: ``command`` either raises ``TimeoutExpired`` or returns recorded stdout
  while creating the case's session files in a throwaway job directory, so the
  recorded ``session.json`` is the best-effort link of ``cq.invoke`` (2eb6b4770).

No process is spawned, no network, queue, state, signer or host is touched.
The TypeScript test (``test/adapters/crq/repairDriverOutput.test.ts``) replays
every case. Where Python lets an exception escape, the class name is recorded.

Regenerate with ``python3.14 repair_driver_output_vectors.py --write``; verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from crq_repair.drivers import codex, cq, paseo  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-driver-output" / "cases.json"
SCHEMA = "cq.crq-driver-output-vector/v1"


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=True)


# ---------------------------------------------------------------- codex

FIXER_OK = {"changed": True, "summary": "s", "commits": ["a" * 40]}
JUDGE_OK = {"verdict": "valid", "reason": "r"}


def codex_cases() -> list[tuple[str, bool, bytes]]:
    fixer = lambda **kw: dumps({**FIXER_OK, **kw}).encode()  # noqa: E731
    judge = lambda **kw: dumps({**JUDGE_OK, **kw}).encode()  # noqa: E731
    out: list[tuple[str, bool, bytes]] = [
        ("fixer ok", False, fixer()),
        ("fixer ok with empty commits", False, fixer(commits=[])),
        ("fixer ok with extra keys passes through", False, fixer(extra=[1, {"a": None}], zed=1.5)),
        ("fixer stop key is overwritten in place", False,
         b'{"stop":"x","changed":false,"summary":"s","commits":[]}'),
        ("fixer changed as int 1 is refused", False, fixer(changed=1)),
        ("fixer changed as int 0 is refused", False, fixer(changed=0)),
        ("fixer changed as string is refused", False, fixer(changed="true")),
        ("fixer changed null is refused", False, fixer(changed=None)),
        ("fixer summary null is refused", False, fixer(summary=None)),
        ("fixer summary number is refused", False, fixer(summary=7)),
        ("fixer empty summary is accepted", False, fixer(summary="")),
        ("fixer commits as string is refused", False, fixer(commits="abc")),
        ("fixer commits as object is refused", False, fixer(commits={})),
        ("fixer commits with a non-string member is refused", False, fixer(commits=["a", 1])),
        ("fixer commits with a null member is refused", False, fixer(commits=[None])),
        ("fixer commits nested list member is refused", False, fixer(commits=[["a"]])),
        ("fixer missing changed", False, b'{"summary":"s","commits":[]}'),
        ("fixer missing summary", False, b'{"changed":true,"commits":[]}'),
        ("fixer missing commits", False, b'{"changed":true,"summary":"s"}'),
        ("fixer empty object", False, b"{}"),
        ("fixer judge-shaped object", False, judge()),
        ("fixer wrong-typed field with a missing one reports required fields", False,
         b'{"changed":1}'),
        ("fixer duplicate keys: the last value wins", False,
         b'{"changed":false,"summary":"s","commits":[],"changed":true}'),
        ("fixer duplicate key makes a valid field invalid", False,
         b'{"changed":true,"summary":"s","commits":[],"changed":"x"}'),
        ("fixer NaN in an extra field", False,
         b'{"changed":true,"summary":"s","commits":[],"n":NaN,"i":-Infinity}'),
        ("fixer NaN in a typed field", False, b'{"changed":NaN,"summary":"s","commits":[]}'),
        ("fixer surrounding JSON whitespace", False,
         b' \t\r\n{"changed":true,"summary":"s","commits":[]} \n'),
        ("fixer non-ascii summary", False, '{"changed":true,"summary":"é\U0001f600","commits":[]}'.encode()),
        ("fixer escaped surrogate pair", False, b'{"changed":true,"summary":"\\ud83d\\ude00","commits":[]}'),
        ("fixer array output", False, b"[]"),
        ("fixer array of fixer objects", False, b'[{"changed":true,"summary":"s","commits":[]}]'),
        ("fixer string output", False, b'"x"'),
        ("fixer null output", False, b"null"),
        ("fixer number output", False, b"1"),
        ("fixer true output", False, b"true"),
        ("fixer empty output", False, b""),
        ("fixer whitespace-only output", False, b"  \n"),
        ("fixer truncated object", False, b'{"changed":true,"summary":"s"'),
        ("fixer trailing garbage", False, fixer() + b" x"),
        ("fixer two objects", False, fixer() + fixer()),
        ("fixer trailing comma", False, b'{"changed":true,"summary":"s","commits":[],}'),
        ("fixer single quotes", False, b"{'changed':true}"),
        ("fixer leading BOM", False, b"\xef\xbb\xbf" + fixer()),
        ("fixer invalid UTF-8", False, b'{"changed":true,"summary":"\xff","commits":[]}'),
        ("fixer lone UTF-8 continuation byte", False, b"\x80"),
        ("fixer NUL byte", False, b'{"changed":true,"summary":"s","commits":[]}\x00'),
        ("fixer raw newline in a string", False, b'{"changed":true,"summary":"a\nb","commits":[]}'),
        ("fixer CRLF between tokens", False, b'{\r\n"changed":true,\r\n"summary":"s",\r\n"commits":[]\r\n}'),
        ("fixer form feed whitespace is not JSON whitespace", False,
         b'\x0c{"changed":true,"summary":"s","commits":[]}'),
        ("fixer bare lone surrogate escape", False, b'{"changed":true,"summary":"\\ud800","commits":[]}'),
        ("fixer deep nesting in an extra key", False,
         b'{"changed":true,"summary":"s","commits":[],"x":' + b"[" * 200 + b"]" * 200 + b"}"),
        ("fixer huge integer extra", False,
         b'{"changed":true,"summary":"s","commits":[],"x":123456789012345678901234567890}'),
        ("fixer float forms extra", False, b'{"changed":true,"summary":"s","commits":[],"x":1.0,"y":1e5,"z":-0}'),
        ("fixer key with unicode escape", False, b'{"chang\\u0065d":true,"summary":"s","commits":[]}'),
        ("fixer proto-style key passes through", False,
         b'{"__proto__":{"a":1},"changed":true,"summary":"s","commits":[]}'),
    ]
    for verdict in ("valid", "invalid", "unsure"):
        out.append((f"judge {verdict}", True, judge(verdict=verdict)))
    out += [
        ("judge extra keys pass through", True, judge(note=[1, 2], other={"k": "v"})),
        ("judge reason is passed through unchecked: number", True, judge(reason=5)),
        ("judge reason is passed through unchecked: null", True, judge(reason=None)),
        ("judge reason is passed through unchecked: object", True, judge(reason={"a": 1})),
        ("judge stop key is overwritten in place", True, b'{"verdict":"valid","stop":"x","reason":"r"}'),
        ("judge capitalised verdict is outside the enum", True, judge(verdict="Valid")),
        ("judge padded verdict is outside the enum", True, judge(verdict="valid ")),
        ("judge unknown verdict", True, judge(verdict="maybe")),
        ("judge empty verdict", True, judge(verdict="")),
        ("judge null verdict", True, judge(verdict=None)),
        ("judge true verdict", True, judge(verdict=True)),
        ("judge number verdict", True, judge(verdict=1)),
        ("judge list verdict", True, judge(verdict=["valid"])),
        ("judge object verdict", True, judge(verdict={"valid": 1})),
        ("judge missing verdict", True, b'{"reason":"r"}'),
        ("judge missing reason", True, b'{"verdict":"valid"}'),
        ("judge fixer-shaped object", True, fixer()),
        ("judge empty object", True, b"{}"),
        ("judge duplicate verdict: the last value wins", True,
         b'{"verdict":"valid","reason":"r","verdict":"bad"}'),
        ("judge array output", True, b"[]"),
        ("judge empty output", True, b""),
        ("judge BOM", True, b"\xef\xbb\xbf" + judge()),
        ("judge invalid UTF-8", True, b'{"verdict":"valid","reason":"\xc3\x28"}'),
        ("judge NaN reason", True, b'{"verdict":"valid","reason":NaN}'),
    ]
    return out


def run_codex(judge: bool, raw: bytes) -> dict:
    def stream(argv, cwd, env, timeout, log_path):
        Path(argv[argv.index("-o") + 1]).write_bytes(raw)
        return 0, [], "", False

    with tempfile.TemporaryDirectory() as tmp:
        config = {"repair": {"codex_budget_launcher": "/bin/launch", "codex_budget_launcher_verified": True,
                             "budget": {"wall_clock_min": 1, "max_tokens": 10}}}
        role = {"model": "m"}
        with mock.patch.object(codex, "_stream_codex", stream):
            try:
                result = codex.invoke(config, role, {"job": "j"}, tmp, tmp, judge=judge)
            except Exception as exc:  # recorded, never expected
                return {"raises": type(exc).__name__}
    if result.get("stop") == "ok":
        return {"ok": True, "result": dumps(result)}
    return {"ok": False, "failure": dumps(result)}


# ---------------------------------------------------------------- paseo

def paseo_cases() -> list[tuple[str, str, int]]:
    ok = '{"verdict":"valid","reason":"r"}'
    return [
        ("plain verdict", ok, 0),
        ("verdict reason first", '{"reason":"r","verdict":"invalid"}', 0),
        ("verdict unsure", '{"verdict":"unsure","reason":""}', 0),
        ("prose before the object", "Here you go:\n" + ok, 0),
        ("prose before the object contains a brace-free preamble", "answer -> " + ok + "\n", 0),
        ("trailing newline", ok + "\n", 0),
        ("trailing spaces and tabs", ok + " \t\r\n", 0),
        ("trailing form feed is Python whitespace", ok + "\x0c", 0),
        ("trailing vertical tab is Python whitespace", ok + "\x0b", 0),
        ("trailing file separator is Python whitespace", ok + "\x1c\x1d\x1e\x1f", 0),
        ("trailing NEL is Python whitespace", ok + "\x85", 0),
        ("trailing no-break space is Python whitespace", ok + "\xa0", 0),
        ("trailing ideographic space is Python whitespace", ok + "　", 0),
        ("trailing zero-width space is not whitespace", ok + "​", 0),
        ("trailing BOM is not whitespace", ok + "﻿", 0),
        ("trailing NUL is not whitespace", ok + "\x00", 0),
        ("trailing prose", ok + " thanks", 0),
        ("trailing second valid verdict", ok + ok, 0),
        ("trailing invalid verdict after a valid one", ok + '\n{"verdict":"invalid","reason":"x"}', 0),
        ("trailing brace", ok + "}", 0),
        ("trailing newline then prose", ok + "\nDone.", 0),
        ("extra key", '{"verdict":"valid","reason":"r","extra":1}', 0),
        ("missing reason", '{"verdict":"valid"}', 0),
        ("missing verdict", '{"reason":"r"}', 0),
        ("empty object", "{}", 0),
        ("different key names", '{"verdict":"valid","why":"r"}', 0),
        ("verdict outside the enum", '{"verdict":"maybe","reason":"r"}', 0),
        ("verdict capitalised", '{"verdict":"Valid","reason":"r"}', 0),
        ("verdict null", '{"verdict":null,"reason":"r"}', 0),
        ("verdict list", '{"verdict":["valid"],"reason":"r"}', 0),
        ("verdict object", '{"verdict":{},"reason":"r"}', 0),
        ("verdict true", '{"verdict":true,"reason":"r"}', 0),
        ("reason number", '{"verdict":"valid","reason":1}', 0),
        ("reason null", '{"verdict":"valid","reason":null}', 0),
        ("reason list", '{"verdict":"valid","reason":["r"]}', 0),
        ("reason NaN", '{"verdict":"valid","reason":NaN}', 0),
        ("duplicate keys: the last value wins", '{"verdict":"valid","reason":"r","verdict":"unsure"}', 0),
        ("duplicate key leaves an extra-looking pair", '{"verdict":"valid","verdict":"valid","reason":"r"}', 0),
        ("braces and quotes inside the reason", '{"verdict":"valid","reason":"a } { \\" b"}', 0),
        ("escaped backslash before the closing quote", '{"verdict":"valid","reason":"a\\\\"}', 0),
        ("unicode reason", '{"verdict":"valid","reason":"é\U0001f600"}', 0),
        ("escaped unicode reason", '{"verdict":"valid","reason":"\\u00e9\\ud83d\\ude00"}', 0),
        ("nested object in reason", '{"verdict":"valid","reason":{"a":1}}', 0),
        ("array before the object", "[1] " + ok, 0),
        ("first brace opens a non-verdict object", '{"note":1} ' + ok, 0),
        ("truncated object", '{"verdict":"valid","reason":"r"', 0),
        ("unterminated string", '{"verdict":"valid","reason":"r', 0),
        ("trailing comma", '{"verdict":"valid","reason":"r",}', 0),
        ("single quotes", "{'verdict':'valid','reason':'r'}", 0),
        ("unquoted keys", '{verdict:"valid",reason:"r"}', 0),
        ("raw newline inside the reason", '{"verdict":"valid","reason":"a\nb"}', 0),
        ("no brace at all", "valid", 0),
        ("empty logs", "", 0),
        ("whitespace-only logs", " \n", 0),
        ("non-zero logs exit with a valid body", ok, 1),
        ("non-zero logs exit with no body", "", 2),
        ("brace only", "{", 0),
        ("code fence around the object", "```json\n" + ok + "\n```", 0),
        ("code fence after the object", ok + "\n```", 0),
        ("BOM before the object", "﻿" + ok, 0),
        ("whitespace inside the object", '{ "verdict" : "valid" ,\n "reason" : "r" }', 0),
    ]


def run_paseo(text: str, returncode: int) -> dict:
    calls: list[list[str]] = []

    def command(argv, cwd=None, env=None, timeout=1200):
        calls.append(list(argv))
        out, rc = "", 0
        if "run" in argv:
            out = '{"agentId":"agent-1"}'
        elif "inspect" in argv:
            out = '{"Status":"idle"}'
        elif "logs" in argv:
            out, rc = text, returncode
        return subprocess.CompletedProcess(argv, rc, out, "")

    config = {"repair": {"paseo_host": "h", "paseo_read_only_mode": "ro", "paseo_budget_launcher": "/bin/launch",
                         "paseo_budget_launcher_verified": True,
                         "budget": {"wall_clock_min": 1, "max_tokens": 10}}}
    with tempfile.TemporaryDirectory() as tmp, mock.patch.object(paseo, "command", command), \
            mock.patch.object(paseo.time, "sleep"), contextlib.redirect_stderr(io.StringIO()):
        try:
            result = paseo.invoke(config, {"model": "m"}, {"job": "j"}, tmp, tmp)
        except Exception as exc:
            return {"raises": type(exc).__name__}
        persisted = Path(tmp, "judge-result.json")
        return {"result": dumps(result),
                "persisted": dumps(json.loads(persisted.read_text())) if persisted.exists() else None}


# ---------------------------------------------------------------- cq

JOB = {"job": "job-1", "pr": 0,
       "finding": {"path": "a.py", "line": 1, "body": "b"},
       "source_snapshot": {"path": "a.py", "line_start": 1, "line_end": 1, "source": "1: x",
                           "source_sha": "s", "source_blob_sha": "b", "finding_sha256": "f"}}


def cq_cases() -> list[dict]:
    """Each case: existing session files, files this run creates, and how the run ends."""
    ok = '{"status":"ok","value":{"verdict":"pass","changed":false,"commits":[],"summary":"s"}}'
    return [
        {"label": "wall clock with one created session", "existing": [], "created": ["abc.jsonl"], "end": "timeout"},
        {"label": "wall clock with no sessions", "existing": [], "created": [], "end": "timeout", "no_dir": True},
        {"label": "wall clock with a regular file at the sessions path", "existing": [], "created": [],
         "end": "timeout", "sessions_is_file": True},
        {"label": "wall clock with an empty sessions dir", "existing": [], "created": [], "end": "timeout"},
        {"label": "wall clock never claims an earlier run session", "existing": ["old.jsonl"], "created": [],
         "end": "timeout"},
        {"label": "wall clock with two created sessions has no current id", "existing": [],
         "created": ["b.jsonl", "a.jsonl"], "end": "timeout"},
        {"label": "wall clock with one created among older sessions", "existing": ["z-old.jsonl", "a-old.jsonl"],
         "created": ["mid.jsonl"], "end": "timeout"},
        {"label": "wall clock sorts session ids by code point", "existing": ["￿.jsonl", "\U0001f600.jsonl"],
         "created": ["m.jsonl"], "end": "timeout"},
        {"label": "wall clock ignores non-jsonl files", "existing": ["x.jsonl", "x.json", "x.jsonl.bak", "README"],
         "created": [], "end": "timeout"},
        {"label": "wall clock with only a non-jsonl file lists the dir but no ids", "existing": ["note.txt"],
         "created": [], "end": "timeout"},
        {"label": "multi-dot session name keeps the inner dots", "existing": [], "created": ["a.b.jsonl"],
         "end": "timeout"},
        {"label": "a bare .jsonl file is its own stem", "existing": [], "created": [".jsonl"], "end": "timeout"},
        {"label": "a bare .jsonl file among others", "existing": ["x.jsonl"], "created": [".jsonl"],
         "end": "timeout"},
        {"label": "double-dot name", "existing": [], "created": ["..jsonl"], "end": "timeout"},
        {"label": "unicode session id", "existing": [], "created": ["sé\U0001f600.jsonl"], "end": "timeout"},
        {"label": "work id from the environment", "existing": [], "created": ["abc.jsonl"], "end": "timeout",
         "work_id": "w-1"},
        {"label": "empty work id stays an empty string", "existing": [], "created": ["abc.jsonl"], "end": "timeout",
         "work_id": ""},
        {"label": "normal run with one created session", "existing": [], "created": ["s1.jsonl"],
         "end": "stdout", "stdout": ok},
        {"label": "normal run value sessionId wins", "existing": [], "created": ["s1.jsonl"], "end": "stdout",
         "stdout": '{"status":"ok","value":{"verdict":"pass","sessionId":"vsid"}}'},
        {"label": "normal run non-string sessionId falls back to the created file", "existing": [],
         "created": ["s1.jsonl"], "end": "stdout",
         "stdout": '{"status":"ok","value":{"verdict":"pass","sessionId":7}}'},
        {"label": "normal run empty sessionId falls back to the created file", "existing": [],
         "created": ["s1.jsonl"], "end": "stdout",
         "stdout": '{"status":"ok","value":{"verdict":"pass","sessionId":""}}'},
        {"label": "normal run non-string sessionId without a created file is null", "existing": [], "created": [],
         "end": "stdout", "stdout": '{"status":"ok","value":{"verdict":"pass","sessionId":["x"]}}'},
        {"label": "normal run value sessionId wins over two created files", "existing": [],
         "created": ["a.jsonl", "b.jsonl"], "end": "stdout",
         "stdout": '{"status":"ok","value":{"verdict":"pass","sessionId":"vsid"}}'},
        {"label": "normal run two created files have no current id", "existing": [],
         "created": ["a.jsonl", "b.jsonl"], "end": "stdout", "stdout": ok},
        {"label": "normal run never claims an earlier run session", "existing": ["old.jsonl"], "created": [],
         "end": "stdout", "stdout": ok},
        {"label": "normal run unparseable stdout still links the session", "existing": [],
         "created": ["s1.jsonl"], "end": "stdout", "stdout": "not json"},
        {"label": "normal run non-object stdout still links the session", "existing": [],
         "created": ["s1.jsonl"], "end": "stdout", "stdout": "[1]"},
        {"label": "normal run non-object value still links the session", "existing": [],
         "created": ["s1.jsonl"], "end": "stdout", "stdout": '{"value":[1]}'},
        {"label": "normal run result key is read when value is absent", "existing": [], "created": [],
         "end": "stdout", "stdout": '{"status":"ok","result":{"verdict":"pass","sessionId":"rsid"}}'},
        {"label": "normal run error status still links the session", "existing": [], "created": ["s1.jsonl"],
         "end": "stdout", "stdout": '{"status":"error","error":"boom"}'},
        {"label": "normal run no sessions dir", "existing": [], "created": [], "end": "stdout", "stdout": ok,
         "no_dir": True},
        {"label": "normal run with a regular file at the sessions path", "existing": [], "created": [],
         "end": "stdout", "stdout": ok, "sessions_is_file": True},
    ]


def run_cq(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        sessions = directory / "sessions"
        if case.get("sessions_is_file"):
            sessions.write_text("not a directory\n")
        elif not case.get("no_dir"):
            sessions.mkdir()
        for name in case["existing"]:
            (sessions / name).write_text("{}\n")

        def command(argv, cwd=None, env=None, timeout=1200):
            for name in case["created"]:
                sessions.mkdir(exist_ok=True)
                (sessions / name).write_text("{}\n")
            if case["end"] == "timeout":
                raise subprocess.TimeoutExpired(argv, timeout, output="partial", stderr="")
            return subprocess.CompletedProcess(argv, 0, case["stdout"], "")

        config = {"repo": "r/r", "repair": {"cq_bin": "/cq", "budget": {"wall_clock_min": 1}}}
        env = {"CQ_WORK_ID": case["work_id"]} if "work_id" in case else {}
        with mock.patch.object(cq, "command", command), mock.patch.dict(cq.os.environ, env, clear=True):
            try:
                result = cq.invoke(config, {"model": "p/m"}, JOB, tmp, directory)
            except Exception as exc:
                return {"raises": type(exc).__name__}
        link = directory / "session.json"
        record = json.loads(link.read_text()) if link.exists() else None
        if record is not None and record.get("sessionsDir") is not None:
            record["sessionsDir"] = "<sessions>"
        return {"record": record, "stop": result.get("stop")}


def build() -> dict:
    codex_out = [{"label": label, "judge": judge, "output_b64": b64(raw), "expect": run_codex(judge, raw)}
                 for label, judge, raw in codex_cases()]
    paseo_out = [{"label": label, "logs": text, "returncode": rc, "expect": run_paseo(text, rc)}
                 for label, text, rc in paseo_cases()]
    cq_out = [{**{k: v for k, v in case.items()}, "expect": run_cq(case)} for case in cq_cases()]
    return {"schema": SCHEMA, "source": "apps/crq-python/crq_repair/drivers",
            "codex": codex_out, "paseo": paseo_out, "cq": cq_out}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq driver-output oracle fixture")
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
        print("driver-output fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
