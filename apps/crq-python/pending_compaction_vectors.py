#!/usr/bin/env python3
"""Deterministic offline oracle for the loader half of the pending admission-history compaction.

Test tooling only. It runs the PRODUCTION ``crq.load_queue`` and ``crq.save_queue`` (``crq.py:267-302``)
over a temporary ``queue.json`` and records, after every operation of a sequence, what a caller can
see: the returned queue, the error class, ``sys.stderr`` (the ``admission compaction`` log line), the
bytes on disk and whether ``crq._pending_admission_compaction`` is set (and the file size it recorded).
The TypeScript side replays the same sequences with ``pendingCompactionLoader`` and
``fileRepairSaveQueue`` sharing one ``QueueCompaction``.

Nothing here touches a live forge, token, network or queue. Paths start with ``/T``.

Regenerate with ``python3.14 pending_compaction_vectors.py --write``; verify with ``--check``.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crq  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-pending-compaction" / "cases.json"
SCHEMA = "cq.crq-pending-compaction-vector/v1"

SCENARIOS: list[dict] = []


def hx(text: str | bytes) -> str:
    return (text if isinstance(text, bytes) else text.encode("utf-8")).hex()


def add(name: str, queue, ops: list[dict]) -> None:
    raw = queue if isinstance(queue, (str, bytes)) else json.dumps(queue)
    SCENARIOS.append({"name": name, "queue_hex": hx(raw), "ops": ops})


def load(persist: bool = False) -> dict:
    return {"op": "load", "persist": persist}


def save(doc=None) -> dict:
    """Save the last loaded queue (``doc`` None) or the given document."""
    return {"op": "save", "doc": None if doc is None else json.dumps(doc)}


def rewrite(text: str | bytes) -> dict:
    return {"op": "rewrite", "text_hex": hx(text)}


def replace(text: str | bytes) -> dict:
    return {"op": "replace", "text_hex": hx(text)}


UNLINK = {"op": "unlink"}


def row(n: int, **extra) -> dict:
    return {"at": f"t{n}", "item": f"i{n}", "ordinary_eligible": n % 2 == 0, "effective_remaining": n,
            "decision": "admit", "observation": {"successful": True, "observed_at": "x", "remaining": n,
                                                 "noise": "dropped"},
            "reservations": {"a": {"quota_state": "reserved"}, "b": {"quota_state": "held"},
                             "c": {"quota_state": "reserved"}},
            **extra}


def history_queue(rows: int = 3, **top) -> dict:
    return {"items": [{"id": "a", "kind": "open", "state": "pending", "cycles": [{"head": "h"}], "boost": 2},
                      {"id": "b", "kind": "open", "state": "blocked", "cycles": [], "boost": 1},
                      {"id": "c", "kind": "promotion", "boost": 3}],
            "backfill_admissions": [row(n) for n in range(rows)], "ratio": 2.5, **top}


def build_scenarios() -> None:
    legacy = history_queue()
    current = history_queue(backfill_admission_history_version=1)
    plain = {"items": [{"id": "a", "kind": "open", "state": "pending", "cycles": []}]}

    add("load: legacy history compacts and records the identity", legacy, [load()])
    add("load: a current marker records nothing", current, [load()])
    add("load: no history records nothing", plain, [load()])
    add("load: marker 0 with history compacts", history_queue(backfill_admission_history_version=0), [load()])
    add("load: marker 0 without history records nothing and keeps the marker",
        {**plain, "backfill_admission_history_version": 0}, [load()])
    add("load: 300 rows keep the last 256 and compact", history_queue(300), [load()])
    add("load: exactly 256 rows with a current marker is untouched", history_queue(256, backfill_admission_history_version=1), [load()])
    add("load: empty history array compacts", {"items": [], "backfill_admissions": []}, [load()])
    add("load: key order and extra top-level members survive", {"zeta": 1, "items": [], "alpha": [1, 2.5, None],
                                                                 "backfill_admissions": [row(1)]}, [load()])

    add("sequence: load then save logs once and clears", legacy, [load(), save(), save()])
    add("sequence: persist logs immediately and clears", legacy, [load(True), load(), save()])
    add("sequence: persist writes the compacted bytes", legacy, [load(True)])
    add("sequence: persist on a non-compacting load writes nothing", current, [load(True)])
    add("sequence: repeated loads overwrite and one save logs once", legacy, [load(), load(), save(), save()])
    add("sequence: load persist twice logs once", legacy, [load(True), load(True)])
    add("sequence: save of a different queue without the marker clears without a log", legacy,
        [load(), save({"items": []}), save()])
    add("sequence: save of a different queue with the marker logs", legacy,
        [load(), save({"items": [], "backfill_admission_history_version": 1}), save()])
    add("sequence: marker true in the saved queue still logs (1 == True)", legacy,
        [load(), save({"items": [], "backfill_admission_history_version": True})])
    add("sequence: marker 1.0 in the saved queue still logs (1 == 1.0)", legacy,
        [load(), save({"items": [], "backfill_admission_history_version": 1.0})])
    add("sequence: marker 2 in the saved queue does not log", legacy,
        [load(), save({"items": [], "backfill_admission_history_version": 2})])
    add("sequence: a rewritten file makes the pending identity stale", legacy,
        [load(), rewrite(json.dumps(legacy) + " "), save(), save()])
    add("sequence: a replaced file (new inode) makes the pending identity stale", legacy,
        [load(), replace(json.dumps(legacy)), save()])
    add("sequence: a non-compacting load keeps a stale pending until the next save", legacy,
        [load(), rewrite(json.dumps(history_queue(backfill_admission_history_version=1))), load(), save()])
    add("sequence: a non-compacting load after persist does not re-record", legacy,
        [load(True), load(), save()])
    add("sequence: a compacting load after a stale pending overwrites it", legacy,
        [load(), rewrite(json.dumps(history_queue(5))), load(), save()])
    add("sequence: save with no pending never logs", current, [load(), save()])
    add("sequence: a missing file after a load keeps the pending and the save writes", legacy,
        [load(), UNLINK, save(), save()])
    add("sequence: load of a missing file after a pending load raises and keeps the pending", legacy,
        [load(), UNLINK, load(), save()])
    add("sequence: a failed read after a pending load keeps the pending", legacy,
        [load(), rewrite("{"), load(), save()])
    add("sequence: a failed persist load does not record", legacy, [rewrite("{"), load(True), save()])
    add("sequence: save returns the document unretired and load retires it", legacy, [load(), save(), load()])
    add("sequence: load persist then edit then persist again", legacy,
        [load(True), rewrite(json.dumps(history_queue(7))), load(True), save()])

    # --- Python fidelity traps on the read -------------------------------------------------------
    add("read: a missing queue file is FileNotFoundError", b"", [UNLINK, load()])
    add("read: an empty file is a delimiter ValueError", "", [load()])
    add("read: whitespace only", " \n", [load()])
    add("read: a top-level array is rejected", "[1, 2]", [load()])
    add("read: a top-level string is rejected", '"x"', [load()])
    add("read: trailing queue data is rejected", '{"items": []} x', [load()])
    add("read: trailing comma in the queue is rejected", '{"items": [],}', [load()])
    add("read: trailing comma in the history is rejected", '{"backfill_admissions": [{},],}', [load()])
    add("read: a duplicate top-level key is an IntegrityError", '{"items": [], "items": []}', [load()])
    add("read: a duplicate key inside a row is an IntegrityError",
        '{"items": [], "backfill_admissions": [{"at": 1, "at": 2}]}', [load()])
    add("read: a duplicate key inside an item is an IntegrityError",
        '{"items": [{"id": "a", "id": "b"}]}', [load()])
    add("read: invalid UTF-8 is a UnicodeDecodeError", b'{"items": [], "note": "\xff"}', [load()])
    add("read: a non-object admission row is an AttributeError", '{"items": [], "backfill_admissions": [1]}', [load()])
    add("read: a null admission row is an AttributeError", '{"items": [], "backfill_admissions": [null]}', [load()])
    add("read: a string admission row is an AttributeError", '{"items": [], "backfill_admissions": ["x"]}', [load()])
    add("read: an object where the history array belongs is a delimiter ValueError",
        '{"items": [], "backfill_admissions": {"a": 1}}', [load()])
    add("read: marker true is unsupported", '{"items": [], "backfill_admission_history_version": true}', [load()])
    add("read: marker 1.0 is unsupported", '{"items": [], "backfill_admission_history_version": 1.0}', [load()])
    add("read: marker 2 is unsupported", '{"items": [], "backfill_admission_history_version": 2}', [load()])
    add("read: marker -1 is unsupported", '{"items": [], "backfill_admission_history_version": -1}', [load()])
    add("read: marker string is unsupported", '{"items": [], "backfill_admission_history_version": "1"}', [load()])
    add("read: marker null is unsupported", '{"items": [], "backfill_admission_history_version": null}', [load()])
    add("read: a failing marker with history never records", '{"backfill_admissions": [], "backfill_admission_history_version": 2}',
        [load(), save()])
    add("read: observation null and absent both summarize to null",
        {"items": [], "backfill_admissions": [{"observation": None}, {}, {"observation": {"x": 1}}]}, [load()])
    add("read: a precomputed reservation_counts is kept verbatim",
        {"items": [], "backfill_admissions": [{"reservation_counts": {"z": 9}}]}, [load()])
    add("read: reservations missing summarizes to an empty count",
        {"items": [], "backfill_admissions": [{"at": "t"}]}, [load()])
    add("read: unknown quota_state defaults to unknown",
        {"items": [], "backfill_admissions": [{"reservations": {"a": {}, "b": {"quota_state": "x"}}}]}, [load()])
    add("read: unicode text round-trips", {"items": [{"id": "café \U0001f600"}],
                                           "backfill_admissions": [{"at": " é"}]}, [load()])
    add("read: big integers stay exact", '{"items": [], "n": 123456789012345678901234567890, "backfill_admissions": []}', [load()])
    add("read: a chunk-straddling document (70000 bytes of items) loads",
        {"items": [{"id": f"i{n:05d}", "kind": "open", "state": "done"} for n in range(1500)],
         "backfill_admissions": [row(n) for n in range(3)]}, [load()])
    add("read: items retire pass pops boost and closes a second-cycle open", legacy, [load()])
    add("read: optional_cycle keeps a completed open pending",
        {"items": [{"id": "a", "kind": "open", "state": "pending", "cycles": [{}], "optional_cycle": True}],
         "backfill_admissions": []}, [load()])
    add("read: promotion items are skipped by the retirement pass",
        {"items": [{"id": "p", "kind": "promotion", "boost": 4, "state": "pending", "cycles": [{}]}],
         "backfill_admissions": []}, [load()])


def _error(exc: BaseException) -> dict:
    return {"error": type(exc).__name__, "message": str(exc)}


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state"
        state.mkdir()
        queue = state / "queue.json"
        queue.write_bytes(bytes.fromhex(spec["queue_hex"]))
        steps: list[dict] = []
        last = None
        with mock.patch.object(crq, "QUEUE", queue), mock.patch.object(crq, "_pending_admission_compaction", None):
            for op in spec["ops"]:
                err = io.StringIO()
                step: dict = {"op": op["op"], "error": None}
                try:
                    with contextlib.redirect_stderr(err):
                        if op["op"] == "load":
                            last = crq.load_queue(persist_compaction=op["persist"])
                            step["queue"] = json.dumps(last, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
                        elif op["op"] == "save":
                            crq.save_queue(copy.deepcopy(last) if op["doc"] is None else json.loads(op["doc"]))
                        elif op["op"] == "rewrite":
                            queue.write_bytes(bytes.fromhex(op["text_hex"]))
                        elif op["op"] == "replace":
                            tmpfile = state / "queue.json.new"
                            tmpfile.write_bytes(bytes.fromhex(op["text_hex"]))
                            os.replace(tmpfile, queue)
                        else:
                            queue.unlink()
                except BaseException as exc:  # noqa: BLE001
                    step.update(error=type(exc).__name__, message=str(exc).replace(tmp, "/T"))
                    step.pop("queue", None)
                step["stderr"] = err.getvalue().replace(tmp, "/T")
                step["queue_bytes"] = queue.read_bytes().hex() if queue.exists() else None
                pending = crq._pending_admission_compaction
                step["pending_size"] = None if pending is None else pending[3]
                steps.append(step)
        return {"steps": steps}


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    return {"schema": SCHEMA,
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
        print("pending-compaction fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
