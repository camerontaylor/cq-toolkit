#!/usr/bin/env python3
"""Deterministic offline oracle for the TS finding delivery and repair transport.

Test tooling only. It drives the PRODUCTION ``finding_delivery.Inbox.deliver``,
``canonical_rounds``, ``repair_transport`` and ``configured_repair_transport``
inside one throwaway sandbox directory laid out like production
(``<sandbox>/state/backfill/findings`` for the inbox, ``.../publication`` for the
outbox, ``<sandbox>/state/repair/...`` for the repair inbox and retained
snapshots) and records what Python actually does: the return value or
exception class, the transport and scan calls, the lock/write/spool order, the
final files, the queue and the sandbox tree.

Every external effect is injected. The transport is a stub (``ok`` receipt,
refusal shapes, raising) or the real ``repair_transport`` with stub scans, or
the real ``configured_repair_transport`` over a fake context. A sentinel file
sits beside the sandbox: each case records that the sentinel and its sibling
listing are unchanged, so nothing outside the sandbox was touched. No
production module is modified and no production queue, state, network, model,
signer or host service is touched.

The TypeScript test (``test/ops/crq/findingDelivery.test.ts``) replays the same
specs through ``FindingDelivery`` and ``repairTransport`` over memory seams and
compares everything recorded here. Where Python lets an exception escape, the
class name is recorded and the port refuses with the same Python class.

Regenerate with ``python3.14 finding_delivery_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterator, List

import finding_delivery
import repair_tick
import review_ledger as ledger
from finding_disposition_vectors import FID, RID, FixtureArtifacts, _finding_event, _finding_row, _row
from ledger_vector_emit_b1 import AT, SHA

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-finding-delivery" / "cases.json"
HEAD = "1" * 40
JOB = "crq-backfill-" + "7" * 64
ACK = "8" * 64


class Trap(AssertionError):
    """A vector referenced a fact the spec never supplied: a bug in the vector."""


class StubError(RuntimeError):
    """The stub transport refused."""


class TracedOutbox(ledger.Outbox):
    def __init__(self, root: Path, artifacts: Any, trace: List[str]) -> None:
        super().__init__(root, artifacts)
        self.trace = trace

    def retained(self) -> Any:
        self.trace.append("retained")
        return super().retained()

    def spool(self, value: Any) -> Any:
        self.trace.append("spool")
        return super().spool(value)


@contextlib.contextmanager
def _patched(trace: List[str]) -> Iterator[None]:
    original_locked, original_atomic = ledger.locked, ledger.atomic

    @contextlib.contextmanager
    def locked(path: Any) -> Iterator[None]:
        name = Path(path).name
        trace.append("lock:" + name)
        try:
            with original_locked(path):
                yield
        finally:
            trace.append("unlock:" + name)

    def atomic(path: Any, data: bytes) -> None:
        path = Path(path)
        trace.append("write:" + path.parent.name + "/" + path.name)
        return original_atomic(path, data)

    ledger.locked, ledger.atomic = locked, atomic
    try:
        yield
    finally:
        ledger.locked, ledger.atomic = original_locked, original_atomic


def _text(value: Any) -> str:
    """Sorted compact ASCII JSON; unlike ledger.canonical it also holds floats."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _entry_bytes(entry: Any) -> bytes:
    """A spec file: canonical JSON, raw bytes, or a filler of one repeated byte."""
    if isinstance(entry, dict) and "raw_hex" in entry:
        return bytes.fromhex(entry["raw_hex"])
    if isinstance(entry, dict) and "rle" in entry:
        return b"".join(bytes([value]) * count for value, count in entry["rle"])
    if isinstance(entry, dict) and "fill" in entry:
        return bytes([entry["fill"][0]]) * entry["fill"][1]
    return _text(entry).encode("ascii")


def _write_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _tree(sandbox: Path) -> List[str]:
    out = []
    for p in sorted(sandbox.rglob("*")):
        if p.is_file() and not p.name.endswith(".lock") and not p.name.startswith("tmp"):
            out.append(p.relative_to(sandbox).as_posix())
    return out


def _digests(sandbox: Path) -> Dict[str, str]:
    """SHA-256 of the exact bytes of every file the tree lists."""
    return {rel: hashlib.sha256((sandbox / rel).read_bytes()).hexdigest() for rel in _tree(sandbox)}


def _dir_text(directory: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if directory.exists():
        for p in sorted(directory.glob("*.json")):
            data = p.read_bytes()
            try:
                out[p.name[:-5]] = _text(ledger.loads(data))
            except Exception:  # noqa: BLE001 - an unparseable file is recorded as hex
                out[p.name[:-5]] = "hex:" + data.hex()
    return out


class FakeContext:
    """The slice of the crq context ``configured_repair_transport`` reads."""

    def __init__(self, sandbox: Path, spec: Dict[str, Any], calls: List[Any], queue_saves: List[str]) -> None:
        self.ROOT, self.STATE = sandbox, sandbox / "state"
        self.CONFIG = spec.get("config", {"repair": {}})
        self.spec, self.calls, self.queue_saves = spec, calls, queue_saves

    def save_queue(self, queue: Any) -> None:
        self.calls.append(["save_queue"])
        self.queue_saves.append(_text(queue))

    def _rel(self, path: Any) -> str:
        return Path(path).relative_to(self.STATE).as_posix()

    def secret_scan(self, base: Any, head: Any, path: Any) -> Any:
        self.calls.append(["secret_scan", base, head, self._rel(path)])
        if "scan_return" in self.spec:
            return self.spec["scan_return"]
        return self.spec.get("source_clean", True), None

    def secret_scan_diff(self, patch: str, path: Any, base: Any = None, head: Any = None) -> Any:
        self.calls.append(["secret_scan_diff", patch, base, head, self._rel(path)])
        rel = self._rel(path)
        key = "instructions_return" if rel.endswith("repair-instructions-scan.json") else "diff_return"
        if key in self.spec:
            return self.spec[key]
        marker = self.spec.get("deny_marker")
        return not (marker is not None and marker in patch), None


class FakeRuntime:
    def __init__(self, calls: List[Any]) -> None:
        self.subjects = self
        self.calls = calls

    def projection(self, repo: Any, target: Any, names: Any) -> Any:
        self.calls.append(["projection", repo, target, list(names)])
        return "base-" + str(target), "head-" + str(target)


def _plain_scans(spec: Dict[str, Any], calls: List[Any]) -> Dict[str, Any]:
    def scan(target: Any, name: Any) -> Any:
        calls.append(["scan", target, name])
        return spec.get("source_clean", True)

    def scan_instructions(text: Any, target: Any) -> Any:
        calls.append(["scan_instructions", text, target])
        verdict = spec.get("instructions", True)
        if verdict == "raise":
            raise StubError("scan_instructions raised")
        return verdict

    def scan_finding(text: Any, target: Any, path: Any) -> Any:
        calls.append(["scan_finding", text, target, path])
        return spec.get("finding_clean", True)

    return {"scan": scan, "scan_instructions": scan_instructions, "scan_finding": scan_finding}


def _make_transport(spec: Dict[str, Any], sandbox: Path, queue: Any, calls: List[Any],
                    queue_saves: List[str], mode: Dict[str, Any]) -> Any:
    kind = mode["mode"]

    def save_queue(value: Any) -> None:
        calls.append(["save_queue"])
        queue_saves.append(_text(value))

    if kind == "stub":
        def stub(key: str, request: Any) -> Any:
            calls.append(["transport", key, _text(request)])
            return copy.deepcopy(mode["receipt"])
        return stub
    if kind == "raise":
        def refuse(key: str, request: Any) -> Any:
            calls.append(["transport", key, _text(request)])
            raise StubError("transport refused")
        return refuse
    if kind == "plain":
        scans = _plain_scans(spec, calls)
        absent = mode.get("absent", [])
        return finding_delivery.repair_transport(
            sandbox, queue, save_queue, scans["scan"], mode.get("max_rounds", spec.get("max_rounds", 2)),
            None if "instructions" in absent else scans["scan_instructions"],
            None if "finding" in absent else scans["scan_finding"])
    if kind == "configured":
        context = FakeContext(sandbox, spec, calls, queue_saves)
        return finding_delivery.configured_repair_transport(context, "repo", queue, FakeRuntime(calls))
    raise Trap(kind)


def _locate(sandbox: Path, spec: Dict[str, Any]) -> None:
    root = sandbox / "state" / "backfill" / "findings"
    for fid, row in spec.get("rows", {}).items():
        _write_file(root / "triage" / (fid + ".json"), _entry_bytes(row))
    for key, value in spec.get("delivery", {}).items():
        _write_file(root / "delivery" / (key + ".json"), _entry_bytes(value))
    for key, value in spec.get("receipts", {}).items():
        _write_file(root / "receipts" / (key + ".json"), _entry_bytes(value))
    for job, value in spec.get("inbox", {}).items():
        _write_file(sandbox / "state" / "repair" / "inbox" / (job + ".json"), _entry_bytes(value))
    for rel, value in spec.get("repair_files", {}).items():
        _write_file(sandbox / "state" / "repair" / rel, _entry_bytes(value))


def run(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Execute every step of one spec and return the recorded outcomes."""
    steps: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as directory:
        outer = Path(directory)
        sentinel = outer / "sentinel.txt"
        sentinel.write_text("untouched", encoding="utf-8")
        sandbox = outer / "sandbox"
        (sandbox / "state" / "backfill").mkdir(parents=True)
        inbox_root = sandbox / "state" / "backfill" / "findings"
        trace: List[str] = []
        outbox = TracedOutbox(sandbox / "state" / "backfill" / "publication", FixtureArtifacts({}), trace)
        inbox = finding_delivery.Inbox(inbox_root, outbox)
        _locate(sandbox, spec)
        for event in spec.get("retained", []):
            outbox.spool(event)
        queue = copy.deepcopy(spec.get("queue", {"items": []}))
        for step in spec["steps"]:
            for fid, row in step.get("seed_rows", {}).items():
                _write_file(inbox_root / "triage" / (fid + ".json"), _entry_bytes(row))
            calls: List[Any] = []
            queue_saves: List[str] = []
            trace.clear()
            method = step["method"]
            outcome: Dict[str, Any]
            with _patched(trace):
                try:
                    transport = _make_transport(spec, sandbox, queue, calls, queue_saves,
                                                step.get("transport", {"mode": "plain"}))
                    if method == "deliver":
                        value = inbox.deliver(step["args"][0], transport, step["args"][1])
                    elif method == "accept":
                        value = transport(*copy.deepcopy(step["args"]))
                    elif method == "canonical_rounds":
                        args = copy.deepcopy(step["args"])
                        value = finding_delivery.canonical_rounds(sandbox, queue, *args, **step.get("kwargs", {}))
                    else:
                        raise Trap(method)
                    outcome = {"returns": _text(value)}
                except Trap:
                    raise
                except Exception as error:  # noqa: BLE001 - the class name is the recorded fact
                    outcome = {"raises": type(error).__name__, "message": str(error).replace(str(outer), "<sandbox>")}
            outcome.update(
                calls=calls, queue_saves=queue_saves, trace=list(trace), queue=_text(queue),
                rows=_dir_text(inbox_root / "triage"), delivery=_dir_text(inbox_root / "delivery"),
                receipts=_dir_text(inbox_root / "receipts"),
                repair_inbox=_dir_text(sandbox / "state" / "repair" / "inbox"),
                pending=_dir_text(sandbox / "state" / "backfill" / "publication" / "pending"),
                tree=_tree(sandbox),
                digests=_digests(sandbox),
                outside_untouched=(sentinel.read_text(encoding="utf-8") == "untouched"
                                   and sorted(p.name for p in outer.iterdir()) == ["sandbox", "sentinel.txt"]),
            )
            steps.append(outcome)
    return {"steps": steps}


# ---------------------------------------------------------------- builders

def _case(name: str, steps: List[Dict[str, Any]], **spec: Any) -> Dict[str, Any]:
    return {"name": name, "spec": {"steps": steps, **spec}}


def _deliver(fid: str = FID, at: str = AT, seed_rows: Any = None, **transport: Any) -> Dict[str, Any]:
    step: Dict[str, Any] = {"method": "deliver", "args": [fid, at]}
    if seed_rows:
        step["seed_rows"] = seed_rows
    if transport:
        step["transport"] = transport
    return step


def _accept(key: str, request: Any, **transport: Any) -> Dict[str, Any]:
    return {"method": "accept", "args": [key, request], "transport": transport or {"mode": "plain"}}


def _rounds(canonical_id: str, pin: str, **kwargs: Any) -> Dict[str, Any]:
    return {"method": "canonical_rounds", "args": [canonical_id, pin], "kwargs": kwargs}


STUB_RECEIPT = {"acknowledgement": ACK, "repair_task": JOB}


def _confirmed(**over: Any) -> Dict[str, Any]:
    finding = _finding_row()
    value = _row(finding, RID, status="confirmed", target_current=HEAD, mapped_path="src/a.ts",
                 mapped_intervals=[[1, 2]], previous_event_id="p0")
    value.update(over)
    return value


def _request(**over: Any) -> Dict[str, Any]:
    finding = _finding_row()
    value = {"canonical_id": FID, "finding_id": FID, "review_id": RID, "target": HEAD, "path": "src/a.ts",
             "intervals": [[1, 2]], "finding": finding}
    value.update(over)
    return value


def _digest(canonical: str, confirmation: Any) -> str:
    return ledger.digest({"canonical": canonical, "confirmation": confirmation})


def _repair_event(previous: Any, evidence: Dict[str, Any], *, actor: str = "crq-repair", key: str = "k0",
                  action: str = "needs-human") -> Dict[str, Any]:
    return _finding_event(previous, action, evidence, actor=actor, review_id=RID, key=key)


def _patch_entry(data: bytes) -> Dict[str, Any]:
    """Run-length encode large patches so the fixture stays small."""
    if len(data) < 1000:
        return {"raw_hex": data.hex()}
    runs: List[List[int]] = []
    for byte in data:
        if runs and runs[-1][0] == byte:
            runs[-1][1] += 1
        else:
            runs.append([byte, 1])
    return {"rle": runs}


def _retained(job: str, patches: Dict[str, bytes] | None = None, *, subdir: str = "", base: Any = HEAD,
              manifest: Dict[str, Any] | None = None, token: str | None = None,
              sha_over: Dict[str, str] | None = None, drop: List[str] | None = None,
              **extra: Any) -> Dict[str, Any]:
    """Files of one retained snapshot under ``state/repair/<job>/``."""
    patches = patches or {}
    names = ("committed.patch", "staged.patch", "unstaged.patch")
    shas = {n: hashlib.sha256(patches.get(n, b"")).hexdigest() for n in names}
    shas.update(sha_over or {})
    value = {"base": base, "sha256": shas, "untracked": ["new.txt"], **extra}
    if manifest is not None:
        value = manifest
    digest = token or hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    prefix = job + "/" + (subdir + "/" if subdir else "") + "retained-" + digest
    files: Dict[str, Any] = {prefix + "/manifest.json": value}
    for n in names:
        if n not in (drop or []):
            files[prefix + "/" + n] = _patch_entry(patches.get(n, b""))
    return files


def _retry_case(name: str, *, receipt: Any = None, event_evidence: Dict[str, Any] | None = None,
                files: Dict[str, Any] | None = None, inbox: Dict[str, Any] | None = None,
                row_over: Dict[str, Any] | None = None, extra_events: List[Dict[str, Any]] | None = None,
                head_actor: str = "crq-repair", transport: Dict[str, Any] | None = None,
                tip: Dict[str, Any] | None = None) -> Dict[str, Any]:
    evidence = {"repair_task": JOB, "repair_base": HEAD, "reason": "needs work"}
    evidence.update(event_evidence or {})
    event = tip or _repair_event("p0", evidence, actor=head_actor)
    receipt_value = STUB_RECEIPT if receipt is None else receipt
    row = _confirmed(**{"receipt": receipt_value, "previous_event_id": event["id"], **(row_over or {})})
    return _case(name, [_deliver(**(transport or {"mode": "stub", "receipt": STUB_RECEIPT}))],
                 rows={FID: row}, retained=[*(extra_events or []), event],
                 repair_files=files or {}, inbox=inbox or {})


def _patch_bytes(*paths: str) -> bytes:
    return b"".join(f"diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n@@ -1 +1 @@\n-x\n+y\n".encode() for p in paths)


# ------------------------------------------------------------------- cases

def basic_cases() -> List[Dict[str, Any]]:
    stub = {"mode": "stub", "receipt": STUB_RECEIPT}
    good = _confirmed()
    key = FID
    cases = [
        _case("deliver-ok-stub-transport", [_deliver(**stub)], rows={FID: good}),
        _case("deliver-ok-real-transport", [_deliver(mode="plain")], rows={FID: good}),
        _case("deliver-ok-configured-transport", [_deliver(mode="configured")], rows={FID: good}),
        _case("deliver-ok-twice-second-returns-stored-receipt",
              [_deliver(**stub), _deliver(mode="raise")], rows={FID: good}),
        _case("deliver-already-delivered-returns-receipt",
              [_deliver(mode="raise")],
              rows={FID: _confirmed(status="delivered", receipt=STUB_RECEIPT)}),
        _case("deliver-already-delivered-receipt-is-not-validated",
              [_deliver(mode="raise")], rows={FID: _confirmed(status="delivered", receipt=[1, "x"])}),
        _case("deliver-delivered-without-receipt-keyerror",
              [_deliver(mode="raise")], rows={FID: {k: v for k, v in _confirmed(status="delivered").items()}}),
        _case("deliver-untriaged-refused", [_deliver(**stub)], rows={FID: _confirmed(status="untriaged")}),
        _case("deliver-needs-human-refused", [_deliver(**stub)], rows={FID: _confirmed(status="needs-human")}),
        _case("deliver-status-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "status"}}),
        _case("deliver-row-missing-filenotfound", [_deliver(**stub)]),
        _case("deliver-row-not-json-decode-error", [_deliver(**stub)], rows={FID: {"raw_hex": "7b"}}),
        _case("deliver-row-not-utf8-decode-error", [_deliver(**stub)], rows={FID: {"raw_hex": "ff"}}),
        _case("deliver-row-is-a-list-typeerror", [_deliver(**stub)], rows={FID: [1]}),
        _case("deliver-canonical-id-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "canonical_id"}}),
        _case("deliver-review-id-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "review_id"}}),
        _case("deliver-target-current-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "target_current"}}),
        _case("deliver-mapped-path-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "mapped_path"}}),
        _case("deliver-mapped-intervals-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "mapped_intervals"}}),
        _case("deliver-finding-missing-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "finding"}}),
        _case("deliver-canonical-id-int-typeerror", [_deliver(**stub)], rows={FID: _confirmed(canonical_id=7)}),
        _case("deliver-canonical-id-none-typeerror", [_deliver(**stub)], rows={FID: _confirmed(canonical_id=None)}),
        _case("deliver-canonical-id-differs-from-finding-id", [_deliver(**stub)],
              rows={FID: _confirmed(canonical_id="c" * 64)}),
        _case("deliver-request-carries-null-target-and-path", [_deliver(**stub)],
              rows={FID: _confirmed(target_current=None, mapped_path=None, mapped_intervals=None)}),
        _case("deliver-receipt-keys-preserved-unicode", [_deliver(mode="stub", receipt={
            "acknowledgement": ACK, "repair_task": JOB, "note": "café \U0001f600", "n": 1.0, "z": 0})],
            rows={FID: good}),
        # Transport receipts.
        _case("deliver-receipt-without-ack-refused", [_deliver(mode="stub", receipt={"repair_task": JOB})], rows={FID: good}),
        _case("deliver-receipt-without-task-refused", [_deliver(mode="stub", receipt={"acknowledgement": ACK})], rows={FID: good}),
        _case("deliver-receipt-empty-ack-refused", [_deliver(mode="stub", receipt={"acknowledgement": "", "repair_task": JOB})], rows={FID: good}),
        _case("deliver-receipt-zero-task-refused", [_deliver(mode="stub", receipt={"acknowledgement": ACK, "repair_task": 0})], rows={FID: good}),
        _case("deliver-receipt-empty-dict-refused", [_deliver(mode="stub", receipt={})], rows={FID: good}),
        _case("deliver-receipt-none-attributeerror", [_deliver(mode="stub", receipt=None)], rows={FID: good}),
        _case("deliver-receipt-list-attributeerror", [_deliver(mode="stub", receipt=[ACK, JOB])], rows={FID: good}),
        _case("deliver-receipt-string-attributeerror", [_deliver(mode="stub", receipt="ok")], rows={FID: good}),
        _case("deliver-receipt-truthy-nonstring-accepted-then-event-valid",
              [_deliver(mode="stub", receipt={"acknowledgement": 1, "repair_task": True})], rows={FID: good}),
        _case("deliver-transport-raises-leaves-request-saved", [_deliver(mode="raise")], rows={FID: good}),
        _case("deliver-transport-raises-then-retry-succeeds", [_deliver(mode="raise"), _deliver(**stub)],
              rows={FID: good}),
        # Saved request / receipt files.
        _case("deliver-saved-request-equal-is-kept", [_deliver(**stub)], rows={FID: good},
              delivery={key: _request()}),
        _case("deliver-saved-request-python-equal-numbers-kept", [_deliver(**stub)], rows={FID: good},
              delivery={key: _request(intervals=[[1.0, 2]])}),
        _case("deliver-saved-request-key-order-irrelevant", [_deliver(**stub)], rows={FID: good},
              delivery={key: dict(reversed(list(_request().items())))}),
        _case("deliver-saved-request-differs-rekeys", [_deliver(**stub)], rows={FID: good},
              delivery={key: _request(path="other.ts")}),
        _case("deliver-saved-request-differs-and-rekeyed-equal",
              [_deliver(**stub)], rows={FID: good},
              delivery={key: _request(path="other.ts"), _digest(FID, "p0"): _request()}),
        _case("deliver-saved-request-differs-and-rekeyed-differs",
              [_deliver(**stub)], rows={FID: good},
              delivery={key: _request(path="other.ts"), _digest(FID, "p0"): _request(path="third.ts")}),
        _case("deliver-saved-request-differs-previous-event-missing-keyerror",
              [_deliver(**stub)],
              rows={FID: {k: v for k, v in good.items() if k != "previous_event_id"}},
              delivery={key: _request(path="other.ts")}),
        _case("deliver-saved-request-not-json", [_deliver(**stub)], rows={FID: good},
              delivery={key: {"raw_hex": "00"}}),
        _case("deliver-saved-request-list-differs", [_deliver(**stub)], rows={FID: good}, delivery={key: [1]}),
        _case("deliver-receipt-file-exists-skips-transport", [_deliver(mode="raise")], rows={FID: good},
              receipts={key: STUB_RECEIPT}),
        _case("deliver-receipt-file-without-task-refused", [_deliver(mode="raise")], rows={FID: good},
              receipts={key: {"acknowledgement": ACK}}),
        _case("deliver-receipt-file-list-attributeerror", [_deliver(mode="raise")], rows={FID: good},
              receipts={key: [1]}),
        _case("deliver-receipt-file-corrupt-decode-error", [_deliver(mode="raise")], rows={FID: good},
              receipts={key: {"raw_hex": "7b"}}),
        # Redelivery after a failed repair keys by the confirmation event.
        _case("deliver-redelivery-keys-by-confirmation", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=STUB_RECEIPT, previous_event_id="p9")}),
        _case("deliver-empty-receipt-dict-is-falsy-plain-key", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={})}),
        _case("deliver-receipt-without-task-no-retry-block", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"acknowledgement": ACK}, previous_event_id="p9")}),
        _case("deliver-receipt-none-attributeerror-on-get", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=None)}),
        _case("deliver-receipt-string-attributeerror-on-get", [_deliver(**stub)],
              rows={FID: _confirmed(receipt="x")}),
        _case("deliver-receipt-zero-attributeerror-on-get", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=0)}),
        _case("deliver-receipt-list-attributeerror-on-get", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=[])}),
        _case("deliver-previous-task-int-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": 5, "acknowledgement": ACK})}),
        _case("deliver-previous-task-list-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": ["crq-x"], "acknowledgement": ACK})}),
        _case("deliver-previous-task-bad-pattern-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "task-1", "acknowledgement": ACK})}),
        _case("deliver-previous-task-trailing-newline-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "crq-a\n", "acknowledgement": ACK})}),
        _case("deliver-previous-task-unicode-letter-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "crq-é", "acknowledgement": ACK})}),
        _case("deliver-previous-task-bare-prefix-refused", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "crq-", "acknowledgement": ACK})}),
        _case("deliver-previous-task-empty-skips", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "", "acknowledgement": ACK})}),
        _case("deliver-previous-task-valid-no-events-found", [_deliver(**stub)],
              rows={FID: _confirmed(receipt={"repair_task": "crq-a.b_c-d", "acknowledgement": ACK})}),
        _case("deliver-previous-event-unhashable-typeerror", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=STUB_RECEIPT, previous_event_id=["x"])}),
        _case("deliver-previous-event-dict-unhashable-typeerror", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=STUB_RECEIPT, previous_event_id={"a": 1})}),
        _case("deliver-previous-event-missing-key-keyerror", [_deliver(**stub)],
              rows={FID: {k: v for k, v in _confirmed(receipt=STUB_RECEIPT).items() if k != "previous_event_id"}}),
        _case("deliver-previous-event-null-with-receipt", [_deliver(**stub)],
              rows={FID: _confirmed(receipt=STUB_RECEIPT, previous_event_id=None)}),
        _case("deliver-recovers-retained-events-before-delivery", [_deliver(**stub)],
              rows={FID: _confirmed(previous_event_id="p0")},
              retained=[_finding_event("p0", "needs-retriage", {"failure_class": "x"}, review_id=RID, key="r0")]),
        _case("deliver-retained-recovery-to-delivered-returns-receipt", [_deliver(mode="raise")],
              rows={FID: _confirmed(previous_event_id="p0")},
              retained=[_finding_event("p0", "delivered", STUB_RECEIPT, actor="crq-repair-adapter",
                                       review_id=RID, key="r1")]),
    ]
    return cases


def retry_cases() -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    add = cases.append
    old_inbox = {"job": JOB, "canonical_finding_id": FID, "repair_base": HEAD}

    add(_retry_case("retry-no-manifests-says-no-snapshot"))
    add(_retry_case("retry-reason-missing-says-unavailable", event_evidence={"reason": None}))
    add(_retry_case("retry-reason-empty-says-unavailable", event_evidence={"reason": ""}))
    add(_retry_case("retry-reason-zero-says-unavailable", event_evidence={"reason": 0}))
    add(_retry_case("retry-reason-number", event_evidence={"reason": 42}))
    add(_retry_case("retry-reason-true", event_evidence={"reason": True}))
    add(_retry_case("retry-reason-list-repr", event_evidence={"reason": ["a", 1, None, True]}))
    add(_retry_case("retry-reason-dict-repr", event_evidence={"reason": {"k": "v'q", "n": [1]}}))
    add(_retry_case("retry-reason-truncated-to-1200", event_evidence={"reason": "r" * 1500}))
    add(_retry_case("retry-reason-truncated-by-code-points", event_evidence={"reason": "\U0001f600" * 1300}))
    add(_retry_case("retry-reason-nul-removed-after-slice", event_evidence={"reason": "a\x00b" * 400}))
    add(_retry_case("retry-reason-newlines-kept", event_evidence={"reason": "a\r\nb c"}))
    add(_retry_case("retry-summary-total-capped-at-2000", event_evidence={"reason": "r" * 1200},
                    files=_retained(JOB, {"committed.patch": _patch_bytes(*[f"dir/{'p' * 90}{i}.ts" for i in range(10)])})))

    one = _retained(JOB, {"committed.patch": _patch_bytes("src/a.ts"),
                          "staged.patch": _patch_bytes("src/b.ts", "src/c.ts"),
                          "unstaged.patch": b""})
    add(_retry_case("retry-one-manifest-summarised", files=one))
    add(_retry_case("retry-nested-manifest-found-by-glob", files=_retained(JOB, {"committed.patch": _patch_bytes("n.ts")}, subdir="a/b")))
    add(_retry_case("retry-manifest-order-is-path-sorted",
                    files={**_retained(JOB, {"committed.patch": _patch_bytes("z.ts")}, subdir="z"),
                           **_retained(JOB, {"committed.patch": _patch_bytes("a.ts")}, subdir="a"),
                           **_retained(JOB, {"committed.patch": _patch_bytes("m.ts")}, subdir="")}))
    twelve: Dict[str, Any] = {}
    for i in range(12):
        twelve.update(_retained(JOB, {"committed.patch": _patch_bytes(f"f{i}.ts")}, subdir=f"s{i:02d}"))
    add(_retry_case("retry-only-first-ten-manifests-read", files=twelve))
    broken_after_ten = dict(twelve)
    broken_after_ten.update(_retained(JOB, {"committed.patch": b"x"}, subdir="s99", token="0" * 64))
    add(_retry_case("retry-eleventh-manifest-is-never-read", files=broken_after_ten))
    many = _retained(JOB, {"committed.patch": _patch_bytes(*[f"p{i}.ts" for i in range(14)])})
    add(_retry_case("retry-changed-paths-capped-at-ten", files=many))
    add(_retry_case("retry-untracked-count-list", files=_retained(JOB, untracked=["a", "b", "c"])))
    add(_retry_case("retry-untracked-absent-is-zero", files=_retained(JOB, manifest={
        "base": HEAD, "sha256": {n: hashlib.sha256(b"").hexdigest() for n in ("committed.patch", "staged.patch", "unstaged.patch")}})))
    add(_retry_case("retry-untracked-string-counts-code-points", files=_retained(JOB, untracked="a\U0001f600b")))
    add(_retry_case("retry-untracked-dict-counts-keys", files=_retained(JOB, untracked={"a": 1, "b": 2})))
    add(_retry_case("retry-untracked-null-typeerror", files=_retained(JOB, untracked=None)))
    add(_retry_case("retry-untracked-int-typeerror", files=_retained(JOB, untracked=5)))
    add(_retry_case("retry-untracked-bool-typeerror", files=_retained(JOB, untracked=True)))
    add(_retry_case("retry-sizes-are-full-lengths", files=_retained(JOB, {
        "committed.patch": b"a" * 300000, "staged.patch": b"bb", "unstaged.patch": b"c"})))

    # Patch parsing traps.
    add(_retry_case("retry-patch-only-prefixed-lines-count", files=_retained(JOB, {
        "committed.patch": b" diff --git a/x b/x\nxdiff --git a/y b/y\ndiff --git a/z b/z\ndiff --git \n"})))
    add(_retry_case("retry-patch-crlf-and-lone-cr-split", files=_retained(JOB, {
        "committed.patch": b"diff --git a/a b/a\r\ndiff --git a/b b/b\rdiff --git a/c b/c\n"})))
    add(_retry_case("retry-patch-unicode-line-separators-split", files=_retained(JOB, {
        "committed.patch": "diff --git a/a diff --git b\u0085diff --git c\x0bdiff --git d\x0cdiff --git e\x1cdiff --git f".encode()})))
    add(_retry_case("retry-patch-invalid-utf8-replaced", files=_retained(JOB, {
        "committed.patch": b"diff --git a/\xff\xfe.ts b/\xc3.ts\ndiff --git a/\xe2\x82 b\n"})))
    add(_retry_case("retry-patch-bom-kept", files=_retained(JOB, {
        "committed.patch": b"\xef\xbb\xbfdiff --git a/x b/x\ndiff --git a/y b/y\n"})))
    cut = b"diff --git a/" + b"a" * (200000 - 13 - 1) + "é".encode() + b"\ndiff --git a/after b/after\n"
    add(_retry_case("retry-patch-cut-at-200000-bytes-mid-character", files=_retained(JOB, {"committed.patch": cut})))
    cut_exact = b"diff --git a/" + b"b" * (200000 - 13) + b"\ndiff --git a/after b/after\n"
    add(_retry_case("retry-patch-cut-at-200000-bytes-exact", files=_retained(JOB, {"committed.patch": cut_exact})))
    add(_retry_case("retry-patch-nul-bytes-in-path-removed", files=_retained(JOB, {
        "committed.patch": b"diff --git a/x\x00y b/x\x00y\n"})))
    add(_retry_case("retry-patch-spans-three-files", files=_retained(JOB, {
        "committed.patch": _patch_bytes("c.ts"), "staged.patch": _patch_bytes("s.ts"), "unstaged.patch": _patch_bytes("u.ts")})))

    # Integrity refusals on retained snapshots.
    add(_retry_case("retry-diff-just-over-2000000-refused", files=_oversize(2_000_001)))
    add(_retry_case("retry-diff-exactly-2000000-accepted", files=_oversize(2_000_000)))
    add(_retry_case("retry-diff-exactly-2000000-digest-mismatch", files=_oversize(2_000_000, digest_ok=False)))
    add(_retry_case("retry-diff-digest-mismatch-refused", files=_retained(JOB, {"committed.patch": b"abc"}, sha_over={"committed.patch": "0" * 64})))
    add(_retry_case("retry-diff-digest-case-sensitive", files=_retained(JOB, {"committed.patch": b"abc"},
                                                                      sha_over={"committed.patch": hashlib.sha256(b"abc").hexdigest().upper()})))
    add(_retry_case("retry-manifest-token-mismatch-refused", files=_retained(JOB, token="0" * 64)))
    add(_retry_case("retry-manifest-base-mismatch-refused", files=_retained(JOB, base="2" * 40)))
    add(_retry_case("retry-manifest-base-null-vs-evidence-refused", files=_retained(JOB, base=None)))
    add(_retry_case("retry-manifest-missing-patch-filenotfound", files=_retained(JOB, drop=["staged.patch"])))
    add(_retry_case("retry-manifest-sha-table-missing-keyerror", files=_retained(JOB, manifest={
        "base": HEAD, "sha256": {"committed.patch": hashlib.sha256(b"").hexdigest()}, "untracked": []})))
    add(_retry_case("retry-manifest-sha-field-missing-keyerror", files=_retained(JOB, manifest={"base": HEAD})))
    add(_retry_case("retry-manifest-is-list-attributeerror", files=_retained(JOB, manifest=[1])))
    add(_retry_case("retry-manifest-is-string-attributeerror", files=_retained(JOB, manifest="x")))
    add(_retry_case("retry-manifest-unicode-token-ascii-escaped", files=_retained(JOB, {"committed.patch": b""},
                                                                                 note="café \U0001f600")))
    add(_retry_case("retry-manifest-not-json-decode-error", files={f"{JOB}/retained-" + "0" * 64 + "/manifest.json": {"raw_hex": "7b"}}))
    add(_retry_case("retry-manifest-not-utf8-decode-error", files={f"{JOB}/retained-" + "0" * 64 + "/manifest.json": {"raw_hex": "ff"}}))
    add(_retry_case("retry-manifest-duplicate-keys-refused", files={f"{JOB}/retained-" + "0" * 64 + "/manifest.json": {
        "raw_hex": b'{"base":"a","base":"b"}'.hex()}}))
    add(_retry_case("retry-other-job-manifests-ignored", files=_retained("crq-other", {"committed.patch": _patch_bytes("o.ts")})))
    add(_retry_case("retry-non-retained-directory-ignored", files={f"{JOB}/keep/manifest.json": {"base": "x"}}))

    # Unbound legacy snapshots: base comes from the prior inbox job or not at all.
    legacy = {"event_evidence": {"repair_base": None}}
    for name, inbox, extra in (
        ("retry-legacy-base-from-inbox-job", {JOB: {**old_inbox, "repair_base": HEAD}}, {}),
        ("retry-legacy-inbox-job-missing-trusts-nothing", {}, {}),
        ("retry-legacy-inbox-without-base-ack-mismatch", {JOB: {"job": JOB, "canonical_finding_id": FID}}, {}),
        ("retry-legacy-inbox-job-name-mismatch-refused", {JOB: {**old_inbox, "job": "crq-x"}}, {}),
        ("retry-legacy-inbox-canonical-mismatch-refused", {JOB: {**old_inbox, "canonical_finding_id": "c" * 64}}, {}),
        ("retry-legacy-inbox-job-missing-attribute-refused", {JOB: {"canonical_finding_id": FID, "repair_base": HEAD}}, {}),
        ("retry-legacy-inbox-list-attributeerror", {JOB: [1]}, {}),
        ("retry-legacy-inbox-corrupt-decode-error", {JOB: {"raw_hex": "7b"}}, {}),
    ):
        ack = ledger.digest({**old_inbox, "repair_base": HEAD})
        receipt = {"acknowledgement": ack, "repair_task": JOB}
        add(_retry_case(name, receipt=receipt, files=_retained(JOB, {"committed.patch": _patch_bytes("l.ts")}),
                        inbox=inbox, **legacy))
    add(_retry_case("retry-legacy-ack-mismatch-refused", receipt={"acknowledgement": "0" * 64, "repair_task": JOB},
                    files=_retained(JOB), inbox={JOB: old_inbox}, **legacy))
    add(_retry_case("retry-legacy-receipt-without-ack-refused", receipt={"repair_task": JOB},
                    files=_retained(JOB), inbox={JOB: old_inbox}, **legacy))
    add(_retry_case("retry-legacy-no-manifests-never-reads-inbox", receipt=STUB_RECEIPT, inbox={JOB: [1]}, **legacy))
    add(_retry_case("retry-legacy-evidence-base-empty-string-is-unbound",
                    event_evidence={"repair_base": ""}, files=_retained(JOB, {"committed.patch": _patch_bytes("l.ts")}),
                    inbox={JOB: old_inbox}, receipt={"acknowledgement": ledger.digest(old_inbox), "repair_task": JOB}))

    # Event chain walk.
    pending = _repair_event(None, {"repair_task": "crq-other", "repair_base": HEAD}, actor="crq-repair", key="older")
    mismatch = _repair_event(pending["id"], {"repair_task": "crq-else", "repair_base": HEAD}, actor="crq-repair", key="newer")
    good = _repair_event(pending["id"], {"repair_task": JOB, "repair_base": HEAD, "reason": "deep"}, actor="crq-repair", key="deep")
    walker = _repair_event(good["id"], {"note": "x"}, actor="crq-triage", key="walker")
    add(_retry_case("retry-walks-past-non-repair-event", tip=walker, extra_events=[good, pending],
                    files=_retained(JOB, {"committed.patch": _patch_bytes("w.ts")})))
    add(_retry_case("retry-walks-past-other-task-event", tip=mismatch, extra_events=[pending]))
    add(_retry_case("retry-chain-ends-without-match-no-guidance", tip=pending, extra_events=[]))
    add(_retry_case("retry-actor-must-be-crq-repair", head_actor="crq-triage"))
    add(_retry_case("retry-actor-adapter-is-not-repair", head_actor="crq-repair-adapter"))
    add(_retry_case("retry-delivered-event-is-not-repair-actor", tip=_finding_event(
        "p0", "delivered", STUB_RECEIPT, actor="crq-repair-adapter", review_id=RID, key="del")))
    add(_retry_case("retry-previous-row-event-not-retained", row_over={"previous_event_id": "e" * 64}))
    return cases


def _oversize(size: int, *, digest_ok: bool = True) -> Dict[str, Any]:
    fills = {"committed.patch": (97, 10), "staged.patch": (98, size), "unstaged.patch": (99, 10)}
    shas = {n: hashlib.sha256(bytes([v]) * c).hexdigest() for n, (v, c) in fills.items()}
    if not digest_ok:
        shas["staged.patch"] = "0" * 64
    token_value = {"base": HEAD, "sha256": shas, "untracked": []}
    token = hashlib.sha256(json.dumps(token_value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    prefix = f"{JOB}/retained-{token}"
    return {prefix + "/manifest.json": token_value,
            **{prefix + "/" + n: {"fill": list(f)} for n, f in fills.items()}}


def _item(item_id: str, runs: Dict[str, Any], **over: Any) -> Dict[str, Any]:
    return {"id": item_id, "kind": "merged", "pr": 0, "state": "repairing", "cycles": [], "repair_runs": runs, **over}


def _run_record(jobs: List[Any], pin: Any = HEAD, **over: Any) -> Dict[str, Any]:
    return {"jobs": jobs, "pin": pin, "base": pin, "branch": None, "open_pr": False, "round": 1,
            "state": "queued", "canonical_finding_id": FID, **over}


def _old_job(job: str, canonical: Any = FID, **over: Any) -> Dict[str, Any]:
    return {"job": job, "item": "backfill-finding-x", "canonical_finding_id": canonical, **over}


def rounds_cases() -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    add = cases.append

    def r(name: str, queue: Any, *args: Any, inbox: Dict[str, Any] | None = None, **kwargs: Any) -> None:
        add(_case(name, [_rounds(*(args or (FID, HEAD)), **kwargs)], queue=queue, inbox=inbox or {}))

    r("rounds-empty-queue", {"items": []})
    r("rounds-counts-one-run-with-record-canonical",
      {"items": [_item("backfill-finding-a", {"r1": _run_record(["j1"])})]})
    r("rounds-inbox-canonical-overrides-record",
      {"items": [_item("i", {"r1": _run_record(["j1"], canonical_finding_id="c" * 64)})]}, inbox={"j1": _old_job("j1")})
    r("rounds-inbox-canonical-null-falls-back-to-record",
      {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": _old_job("j1", None)})
    r("rounds-inbox-canonical-empty-falls-back-to-record",
      {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": _old_job("j1", "")})
    r("rounds-inbox-without-canonical-falls-back",
      {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": {"job": "j1"}})
    r("rounds-other-pin-skipped",
      {"items": [_item("i", {"r1": _run_record(["j1"], pin="2" * 40)})]})
    r("rounds-pin-null-in-record-skipped",
      {"items": [_item("i", {"r1": _run_record(["j1"], pin=None)})]})
    r("rounds-pin-argument-null-matches-null",
      {"items": [_item("i", {"r1": _run_record(["j1"], pin=None)})]}, FID, None)
    r("rounds-one-per-run-even-with-many-jobs",
      {"items": [_item("i", {"r1": _run_record(["j1", "j2", "j3"])})]})
    r("rounds-excluded-job-is-skipped",
      {"items": [_item("i", {"r1": _run_record(["j1"])})]}, FID, HEAD, exclude_job="j1")
    r("rounds-excluded-job-only-first-skipped",
      {"items": [_item("i", {"r1": _run_record(["j1", "j2"])})]}, FID, HEAD, exclude_job="j1")
    r("rounds-sums-across-runs-and-items",
      {"items": [_item("i", {"r1": _run_record(["j1"]), "r2": _run_record(["j2"])}),
                 _item("k", {"r3": _run_record(["j3"])})]})
    r("rounds-different-canonical-not-counted",
      {"items": [_item("i", {"r1": _run_record(["j1"], canonical_finding_id="c" * 64)})]})
    r("rounds-record-canonical-null-no-inbox-non-backfill-ok",
      {"items": [_item("plain-item", {"r1": _run_record(["j1"], canonical_finding_id=None)})]})
    r("rounds-record-canonical-absent-backfill-finding-refused",
      {"items": [_item("backfill-finding-z", {"r1": {k: v for k, v in _run_record(["j1"]).items() if k != "canonical_finding_id"}})]})
    r("rounds-record-canonical-null-backfill-finding-refused",
      {"items": [_item("backfill-finding-z", {"r1": _run_record(["j1"], canonical_finding_id=None)})]})
    r("rounds-backfill-finding-with-inbox-binding-ok",
      {"items": [_item("backfill-finding-z", {"r1": _run_record(["j1"], canonical_finding_id=None)})]}, inbox={"j1": _old_job("j1")})
    r("rounds-excluded-job-skips-binding-refusal",
      {"items": [_item("backfill-finding-z", {"r1": _run_record(["j1"], canonical_finding_id=None)})]}, FID, HEAD, exclude_job="j1")
    r("rounds-item-id-absent-defaults-empty",
      {"items": [{"repair_runs": {"r1": _run_record(["j1"], canonical_finding_id=None)}}]})
    r("rounds-item-id-int-attributeerror",
      {"items": [_item(5, {"r1": _run_record(["j1"], canonical_finding_id=None)})]})
    r("rounds-item-without-runs-ignored", {"items": [{"id": "x"}]})
    r("rounds-runs-list-attributeerror", {"items": [_item("i", [1])]})
    r("rounds-runs-null-attributeerror", {"items": [_item("i", None)]})
    r("rounds-run-record-list-attributeerror", {"items": [_item("i", {"r1": [1]})]})
    r("rounds-run-record-null-attributeerror", {"items": [_item("i", {"r1": None})]})
    r("rounds-item-not-dict-attributeerror", {"items": ["x"]})
    r("rounds-item-null-attributeerror", {"items": [None]})
    r("rounds-items-missing-keyerror", {})
    r("rounds-items-null-typeerror", {"items": None})
    r("rounds-items-int-typeerror", {"items": 3})
    r("rounds-items-dict-iterates-keys-attributeerror", {"items": {"a": 1}})
    r("rounds-items-string-iterates-characters-attributeerror", {"items": "ab"})
    r("rounds-jobs-absent-no-count", {"items": [_item("i", {"r1": {k: v for k, v in _run_record(["j1"]).items() if k != "jobs"}})]})
    r("rounds-jobs-null-typeerror", {"items": [_item("i", {"r1": _run_record(None)})]})
    r("rounds-jobs-string-iterates-characters", {"items": [_item("i", {"r1": _run_record("ab")})]})
    r("rounds-jobs-dict-iterates-keys", {"items": [_item("i", {"r1": _run_record({"j1": 1})})]})
    r("rounds-jobs-int-entry-typeerror", {"items": [_item("i", {"r1": _run_record([7])})]})
    r("rounds-jobs-null-entry-typeerror", {"items": [_item("i", {"r1": _run_record([None])})]})
    r("rounds-jobs-null-entry-excluded-by-null", {"items": [_item("i", {"r1": _run_record([None])})]}, FID, HEAD, exclude_job=None)
    r("rounds-inbox-file-list-attributeerror", {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": [1]})
    r("rounds-inbox-file-corrupt-decode-error", {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": {"raw_hex": "7b"}})
    r("rounds-inbox-file-not-utf8", {"items": [_item("i", {"r1": _run_record(["j1"])})]}, inbox={"j1": {"raw_hex": "ff"}})
    r("rounds-canonical-argument-int-never-equal", {"items": [_item("i", {"r1": _run_record(["j1"])})]}, 7, HEAD)
    r("rounds-pin-equal-numbers", {"items": [_item("i", {"r1": _run_record(["j1"], pin=1)})]}, FID, 1.0)
    r("rounds-pin-true-equals-one", {"items": [_item("i", {"r1": _run_record(["j1"], pin=True)})]}, FID, 1)
    r("rounds-canonical-equal-numbers", {"items": [_item("i", {"r1": _run_record(["j1"], canonical_finding_id=1.0)})]}, 1, HEAD)
    r("rounds-jobs-with-slash-reads-nested-inbox", {"items": [_item("i", {"r1": _run_record(["a/b"])})]})
    return cases


def accept_cases() -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    add = cases.append
    key = "5" * 64
    job_id = "crq-backfill-" + key
    plain = {"mode": "plain"}

    def acc(name: str, request: Any = None, *, transport: Dict[str, Any] | None = None, **spec: Any) -> None:
        add(_case(name, [_accept(key, _request() if request is None else request, **(transport or plain))], **spec))

    def sans(*names: str) -> Dict[str, Any]:
        return {k: v for k, v in _request().items() if k not in names}

    acc("accept-fresh-job-creates-inbox-item-and-saves")
    acc("accept-configured-fresh-job", transport={"mode": "configured"})
    acc("accept-configured-config-ceiling-one", transport={"mode": "configured"}, config={"repair": {"max_rounds_per_pin": 1}},
        queue={"items": [_item("i", {"r1": _run_record(["j1"])})]})
    acc("accept-configured-config-ceiling-zero", transport={"mode": "configured"}, config={"repair": {"max_rounds_per_pin": 0}})
    acc("accept-configured-config-ceiling-null-typeerror", transport={"mode": "configured"},
        config={"repair": {"max_rounds_per_pin": None}})
    acc("accept-configured-config-repair-missing-keyerror", transport={"mode": "configured"}, config={})
    acc("accept-configured-source-scan-rejects", transport={"mode": "configured"}, source_clean=False)
    acc("accept-configured-finding-scan-rejects-marker", _request(finding={**_finding_row(), "body": "SECRET here"}),
        transport={"mode": "configured"}, deny_marker="SECRET")
    acc("accept-configured-finding-scan-checks-both-names", _request(path="src/SECRETPATH.ts"),
        transport={"mode": "configured"}, deny_marker="SECRETPATH")
    # The context's scan seams return (verdict, evidence) tuples: the transport
    # must take element 0 (scan, scan_finding) or unpack exactly two (instructions).
    cfg = {"mode": "configured"}
    ins = _request(retry_instructions="go on", prior_repair_task=JOB)
    acc("accept-configured-scan-tuple-false-refused", transport=cfg, scan_return=[False, None])
    acc("accept-configured-scan-tuple-true-accepted", transport=cfg, scan_return=[True, None])
    acc("accept-configured-scan-tuple-true-extra-elements", transport=cfg, scan_return=[True, None, 9])
    acc("accept-configured-scan-bare-bool-typeerror", transport=cfg, scan_return=True)
    acc("accept-configured-scan-empty-list-indexerror", transport=cfg, scan_return=[])
    acc("accept-configured-scan-empty-string-indexerror", transport=cfg, scan_return="")
    acc("accept-configured-scan-empty-dict-keyerror", transport=cfg, scan_return={})
    acc("accept-configured-scan-string-first-char-truthy", transport=cfg, scan_return="0x")
    acc("accept-configured-finding-tuple-false-refused", transport=cfg, diff_return=[False, None])
    acc("accept-configured-finding-bare-true-typeerror", transport=cfg, diff_return=True)
    acc("accept-configured-finding-empty-list-indexerror", transport=cfg, diff_return=[])
    acc("accept-configured-instructions-tuple-false-valueerror", ins, transport=cfg, instructions_return=[False, None])
    acc("accept-configured-instructions-tuple-true-ok", ins, transport=cfg, instructions_return=[True, None])
    acc("accept-configured-instructions-bare-bool-typeerror", ins, transport=cfg, instructions_return=True)
    acc("accept-configured-instructions-one-element-valueerror", ins, transport=cfg, instructions_return=[True])
    acc("accept-configured-instructions-three-elements-valueerror", ins, transport=cfg, instructions_return=[True, None, 1])
    acc("accept-configured-instructions-two-char-string-unpacks", ins, transport=cfg, instructions_return="ab")
    acc("accept-configured-instructions-two-key-dict-unpacks", ins, transport=cfg, instructions_return={"a": 1, "b": 2})
    acc("accept-configured-instructions-falsy-first-string", ins, transport=cfg, instructions_return=["", None])
    acc("accept-configured-finding-path-newline-rejected", _request(path="a\nb.ts"), transport={"mode": "configured"})
    acc("accept-configured-finding-path-cr-rejected", _request(path="a\rb.ts"), transport={"mode": "configured"})
    acc("accept-configured-finding-path-non-string-rejected", _request(path=7), transport={"mode": "configured"})
    acc("accept-configured-finding-path-null-rejected", _request(path=None), transport={"mode": "configured"})
    acc("accept-configured-finding-multiline-body-lines", _request(finding={**_finding_row(), "title": "T", "body": "l1\nl2\r\nl3\n"}),
        transport={"mode": "configured"})
    acc("accept-configured-finding-empty-body", _request(finding={**_finding_row(), "title": "", "body": ""}),
        transport={"mode": "configured"})
    acc("accept-configured-finding-unicode-body", _request(finding={**_finding_row(), "title": "t u", "body": "b\x85c"}),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-scanned", _request(retry_instructions="fix it\nnow", prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-splitlines-boundaries",
        _request(retry_instructions="a\rb c\x85d\x0be\x0cf\x1cg", prior_repair_task=JOB), transport={"mode": "configured"})
    acc("accept-configured-instructions-marker-valueerror", _request(retry_instructions="SECRET", prior_repair_task=JOB),
        transport={"mode": "configured"}, deny_marker="SECRET")
    acc("accept-configured-instructions-blank-valueerror", _request(retry_instructions=" \t\n", prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-empty-valueerror", _request(retry_instructions="", prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-nul-valueerror", _request(retry_instructions="a\x00b", prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-2000-ok", _request(retry_instructions="x" * 2000, prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-2001-valueerror", _request(retry_instructions="x" * 2001, prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-astral-count-by-code-points",
        _request(retry_instructions="\U0001f600" * 2000, prior_repair_task=JOB), transport={"mode": "configured"})
    acc("accept-configured-instructions-non-string-valueerror", _request(retry_instructions=5, prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-list-valueerror", _request(retry_instructions=["x"], prior_repair_task=JOB),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-null-treated-absent", _request(retry_instructions=None),
        transport={"mode": "configured"})
    acc("accept-configured-instructions-without-prior-task-keyerror", _request(retry_instructions="go"),
        transport={"mode": "configured"})

    acc("accept-plain-without-finding-scan-refused", transport={"mode": "plain", "absent": ["finding"]})
    acc("accept-plain-without-instructions-scan-refused", _request(retry_instructions="go", prior_repair_task=JOB),
        transport={"mode": "plain", "absent": ["instructions"]})
    acc("accept-plain-without-instructions-scan-fine-when-no-guidance", transport={"mode": "plain", "absent": ["instructions"]})
    acc("accept-plain-instructions-scan-false-refused", _request(retry_instructions="go", prior_repair_task=JOB), instructions=False)
    acc("accept-plain-instructions-scan-raises", _request(retry_instructions="go", prior_repair_task=JOB), instructions="raise")
    acc("accept-plain-source-scan-false-refused", source_clean=False)
    acc("accept-plain-finding-scan-false-refused", finding_clean=False)
    acc("accept-plain-finding-scan-falsy-zero-refused", finding_clean=0)
    acc("accept-plain-source-scan-falsy-none-refused", source_clean=None)
    acc("accept-plain-scan-truthy-string-accepted", source_clean="yes", finding_clean=[1])
    acc("accept-plain-instructions-truthy-accepted", _request(retry_instructions="go", prior_repair_task=JOB), instructions=1)
    acc("accept-plain-instructions-empty-string-still-scanned", _request(retry_instructions="", prior_repair_task=JOB))

    # Ceiling.
    ceil_queue = {"items": [_item("i", {"r1": _run_record(["j1"]), "r2": _run_record(["j2"])})]}
    acc("accept-ceiling-reached-refused", queue=ceil_queue)
    acc("accept-ceiling-not-reached", queue={"items": [_item("i", {"r1": _run_record(["j1"])})]})
    acc("accept-ceiling-custom-one", queue={"items": [_item("i", {"r1": _run_record(["j1"])})]}, max_rounds=1)
    acc("accept-ceiling-zero-always-refuses-new", max_rounds=0)
    acc("accept-ceiling-other-pin-not-counted", queue={"items": [_item("i", {"r1": _run_record(["j1"], pin="2" * 40),
                                                                         "r2": _run_record(["j2"], pin="2" * 40)})]})
    acc("accept-ceiling-skipped-when-job-already-exists", queue=ceil_queue,
        inbox={job_id: _job_for(key)})
    acc("accept-ceiling-excludes-own-job", queue={"items": [_item("i", {"r1": _run_record([job_id]), "r2": _run_record(["j2"])})]})
    acc("accept-ceiling-refusal-before-scans", queue=ceil_queue, source_clean=False)
    acc("accept-ceiling-counts-canonical-binding-refusal", queue={"items": [_item("backfill-finding-z", {
        "r1": _run_record(["j1"], canonical_finding_id=None)})]})
    acc("accept-ceiling-max-rounds-float", queue={"items": [_item("i", {"r1": _run_record(["j1"])})]}, max_rounds=1.5)

    # Request shape.
    acc("accept-request-canonical-id-missing-keyerror", sans("canonical_id"))
    acc("accept-request-target-missing-keyerror", sans("target"))
    acc("accept-request-finding-missing-keyerror", sans("finding"))
    acc("accept-request-path-missing-keyerror", sans("path"))
    acc("accept-request-intervals-missing-keyerror", sans("intervals"))
    acc("accept-request-review-id-missing-keyerror", sans("review_id"))
    acc("accept-request-review-id-missing-after-scans", {**sans("review_id")}, source_clean=False)
    acc("accept-request-severity-missing-keyerror", _request(finding={k: v for k, v in _finding_row().items() if k != "severity"}))
    acc("accept-request-title-missing-keyerror", _request(finding={k: v for k, v in _finding_row().items() if k != "title"}))
    acc("accept-request-body-missing-keyerror", _request(finding={k: v for k, v in _finding_row().items() if k != "body"}))
    acc("accept-request-title-int-typeerror", _request(finding={**_finding_row(), "title": 5}))
    acc("accept-request-body-null-typeerror", _request(finding={**_finding_row(), "body": None}))
    acc("accept-request-finding-list-typeerror", _request(finding=[1]))
    acc("accept-request-finding-string-typeerror", _request(finding="abc"))
    acc("accept-request-intervals-empty-indexerror", _request(intervals=[]))
    acc("accept-request-intervals-null-typeerror", _request(intervals=None))
    acc("accept-request-intervals-int-typeerror", _request(intervals=5))
    acc("accept-request-intervals-dict-keyerror", _request(intervals={"a": 1}))
    acc("accept-request-intervals-string-indexes-characters", _request(intervals="ab"))
    acc("accept-request-intervals-inner-empty-indexerror", _request(intervals=[[]]))
    acc("accept-request-intervals-inner-int-typeerror", _request(intervals=[5]))
    acc("accept-request-intervals-float-line", _request(intervals=[[1.5, 2]]))
    acc("accept-request-intervals-string-line", _request(intervals=[["7", 2]]))
    acc("accept-request-path-null", _request(path=None))
    acc("accept-request-target-nonstring-int", _request(target=5))
    acc("accept-request-target-null", _request(target=None))
    acc("accept-request-target-with-slash-job-written-nested", _request(canonical_id="a/b"))
    acc("accept-request-canonical-id-int-typeerror-on-compare", _request(canonical_id=7))
    acc("accept-request-extra-keys-ignored", _request(extra="x", more=[1]))
    acc("accept-request-unicode-title-body", _request(finding={**_finding_row(), "title": "Té", "body": "\U0001f600\nz"}))
    acc("accept-request-severity-null", _request(finding={**_finding_row(), "severity": None}))
    acc("accept-request-request-is-list-typeerror", [1])

    # Idempotent replay and conflict.
    first = _accept(key, _request())
    add(_case("accept-replay-same-request-is-idempotent", [first, first]))
    add(_case("accept-replay-writes-no-second-inbox-file", [first, first, first]))
    add(_case("accept-replay-does-not-appends-second-item", [first, _accept(key, _request(review_id="z" * 64))]))
    acc("accept-existing-job-reused-equal", inbox={job_id: _job_for(key)})
    acc("accept-existing-job-round-preserved", inbox={job_id: _job_for(key, repair_round=5)})
    acc("accept-existing-job-round-null-preserved", inbox={job_id: _job_for(key, repair_round=None)})
    acc("accept-existing-job-round-float", inbox={job_id: _job_for(key, repair_round=2.0)})
    acc("accept-existing-job-python-equal-bool-for-int", inbox={job_id: _job_for(key, pr=False)})
    acc("accept-existing-job-python-equal-float-for-int", inbox={job_id: _job_for(key, pr=0.0)})
    acc("accept-existing-job-key-order-irrelevant", inbox={job_id: dict(reversed(list(_job_for(key).items())))})
    acc("accept-existing-job-conflict-finding", inbox={job_id: _job_for(key, finding={"severity": "x"})})
    acc("accept-existing-job-conflict-extra-key", inbox={job_id: _job_for(key, extra=1)})
    acc("accept-existing-job-conflict-missing-key", inbox={job_id: {k: v for k, v in _job_for(key).items() if k != "recurrence"}})
    acc("accept-existing-job-conflict-base", inbox={job_id: _job_for(key, repair_base="2" * 40)})
    acc("accept-existing-job-without-round-key-conflict", inbox={job_id: {k: v for k, v in _job_for(key).items() if k != "repair_round"}})
    acc("accept-existing-job-list-attributeerror", inbox={job_id: [1]})
    acc("accept-existing-job-null-json-attributeerror", inbox={job_id: None})
    acc("accept-existing-job-corrupt-decode-error", inbox={job_id: {"raw_hex": "7b"}})
    acc("accept-existing-job-not-utf8", inbox={job_id: {"raw_hex": "ff"}})
    acc("accept-existing-job-with-guidance-matches", _request(retry_instructions="go", prior_repair_task=JOB),
        inbox={job_id: _job_for(key, fix_instructions="go", prior_repair_task=JOB)})
    acc("accept-existing-job-without-guidance-conflicts-with-guidance", _request(retry_instructions="go", prior_repair_task=JOB),
        inbox={job_id: _job_for(key)})
    acc("accept-existing-job-guidance-vs-none-conflict", inbox={job_id: _job_for(key, fix_instructions="go", prior_repair_task=JOB)})
    acc("accept-existing-job-scan-refusal-still-first", inbox={job_id: _job_for(key)}, source_clean=False)

    # Queue shape and supersession.
    own_item = _item("backfill-finding-" + key, {"backfill-" + key: _run_record([job_id])})
    acc("accept-queue-item-already-present-not-duplicated", queue={"items": [own_item]})
    acc("accept-queue-appends-after-existing-items", queue={"items": [_item("keep", {})]})
    acc("accept-queue-items-missing-keyerror", queue={})
    acc("accept-queue-items-dict-typeerror", queue={"items": {"a": 1}})
    acc("accept-queue-item-without-id-keyerror", queue={"items": [{"repair_runs": {}}]})
    acc("accept-queue-item-id-list-nonmatching", queue={"items": [{"id": ["x"], "repair_runs": {}}]})
    acc("accept-queue-items-null-typeerror", queue={"items": None})
    acc("accept-queue-extra-keys-preserved", queue={"items": [], "version": 3, "meta": {"k": [1, 2]}})
    acc("accept-queue-existing-job-new-item-round-from-existing", queue={"items": []}, inbox={job_id: _job_for(key, repair_round=9)})

    older = ["queued", "ready", "publish_failed"]
    for state in older + ["running", "done", "failed", "stale", "published"]:
        acc(f"accept-supersede-run-state-{state}",
            queue={"items": [_item("old", {"r-old": _run_record(["j-old"], state=state)})]},
            inbox={"j-old": _old_job("j-old")},
            max_rounds=9)
    acc("accept-supersede-skips-fix-pr-truthy",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"], fix_pr=12)})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-skips-fix-pr-zero-supersedes",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"], fix_pr=0)})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-skips-fix-merged-truthy",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"], fix_merged="yes")})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-skips-fix-merged-empty-supersedes",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"], fix_merged="")})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-other-canonical-untouched",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"])})]}, inbox={"j-old": _old_job("j-old", "c" * 64)})
    acc("accept-supersede-no-inbox-file-untouched",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"])})]})
    acc("accept-supersede-own-job-skipped",
        queue={"items": [_item("own", {"r-own": _run_record([job_id])})]}, inbox={job_id: _job_for(key)})
    acc("accept-supersede-state-absent-is-skipped",
        queue={"items": [_item("old", {"r-old": {k: v for k, v in _run_record(["j-old"]).items() if k != "state"}})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-state-list-skipped",
        queue={"items": [_item("old", {"r-old": _run_record(["j-old"], state=["queued"])})]}, inbox={"j-old": _old_job("j-old")})
    acc("accept-supersede-marks-item-done-once-per-run-hit",
        queue={"items": [_item("old", {"r1": _run_record(["j1"]), "r2": _run_record(["j2"], state="ready")})]},
        inbox={"j1": _old_job("j1"), "j2": _old_job("j2")}, max_rounds=9)
    acc("accept-supersede-multiple-jobs-in-run-update-repeats",
        queue={"items": [_item("old", {"r1": _run_record(["j1", "j2"])})]}, inbox={"j1": _old_job("j1"), "j2": _old_job("j2")}, max_rounds=9)
    acc("accept-supersede-stale-keeps-existing-error-key-replaced",
        queue={"items": [_item("old", {"r1": _run_record(["j1"], error="old error")})]}, inbox={"j1": _old_job("j1")})
    acc("accept-supersede-old-inbox-canonical-null-not-equal",
        queue={"items": [_item("old", {"r1": _run_record(["j1"])})]}, inbox={"j1": _old_job("j1", None)})
    acc("accept-supersede-old-inbox-list-attributeerror",
        queue={"items": [_item("old", {"r1": _run_record(["j1"])})]}, inbox={"j1": [1]}, max_rounds=9)
    acc("accept-supersede-job-int-typeerror",
        queue={"items": [_item("old", {"r1": _run_record([5])})]}, max_rounds=9)
    acc("accept-supersede-jobs-null-typeerror-after-save-skipped",
        queue={"items": [_item("old", {"r1": _run_record(None)})]}, max_rounds=9)
    acc("accept-supersede-runs-list-attributeerror",
        queue={"items": [_item("old", [1])]}, max_rounds=9)
    acc("accept-supersede-item-not-dict-attributeerror", queue={"items": ["x"]}, max_rounds=9)
    acc("accept-supersede-partial-mutation-then-typeerror-is-kept",
        queue={"items": [_item("old", {"r1": _run_record(["j1"], pin="other"), "r2": _run_record([5], pin="other")})]},
        inbox={"j1": _old_job("j1")}, max_rounds=9)
    acc("accept-supersede-run-record-list-attributeerror",
        queue={"items": [_item("old", {"r1": [1]})]}, max_rounds=9)
    acc("accept-supersede-items-mutated-in-place-before-save-then-saved",
        queue={"items": [_item("old", {"r1": _run_record(["j1"])}), _item("old2", {"r2": _run_record(["j2"])})]},
        inbox={"j1": _old_job("j1"), "j2": _old_job("j2")}, max_rounds=9)
    return cases


def _job_for(key: str, **over: Any) -> Dict[str, Any]:
    finding = _finding_row()
    job_id = "crq-backfill-" + key
    value = {"job": job_id, "item": "backfill-finding-" + key, "kind": "merged", "pr": 0, "run": "backfill-" + key,
             "cycle": None, "repair_base": HEAD, "branch": None,
             "finding": {"severity": finding["severity"], "path": "src/a.ts", "line": 1,
                         "body": finding["title"] + "\n" + finding["body"]},
             "repair_round": 1, "prior": None, "recurrence": False, "review_diff": "", "review_id": RID,
             "canonical_finding_id": FID}
    value.update(over)
    return value


def combined_cases() -> List[Dict[str, Any]]:
    """Deliver through the REAL transport, end to end."""
    cases: List[Dict[str, Any]] = []
    good = _confirmed()
    real = {"mode": "plain"}
    cases.append(_case("e2e-deliver-real-creates-job-item-and-receipt", [_deliver(**real)], rows={FID: good}))
    cases.append(_case("e2e-deliver-real-source-scan-rejected-leaves-request-saved", [_deliver(**real)],
                       rows={FID: good}, source_clean=False))
    cases.append(_case("e2e-deliver-real-ceiling-leaves-request-saved", [_deliver(**real)], rows={FID: good},
                       max_rounds=0))
    cases.append(_case("e2e-deliver-real-ceiling-then-raised-limit-succeeds",
                       [_deliver(**real), _deliver(**real, max_rounds=9)], rows={FID: good},
                       queue={"items": [_item("i", {"r1": _run_record(["j1"]), "r2": _run_record(["j2"])})]},
                       inbox={"j1": _old_job("j1"), "j2": _old_job("j2")}))
    cases.append(_case("e2e-deliver-real-finding-scan-rejected", [_deliver(**real)], rows={FID: good}, finding_clean=False))
    cases.append(_case("e2e-deliver-real-rows-with-slash-in-path", [_deliver(**real)],
                       rows={FID: _confirmed(mapped_path="a/b c/d.ts")}))
    cases.append(_case("e2e-deliver-real-intervals-empty-indexerror", [_deliver(**real)],
                       rows={FID: _confirmed(mapped_intervals=[])}))
    cases.append(_case("e2e-deliver-real-intervals-null-typeerror", [_deliver(**real)],
                       rows={FID: _confirmed(mapped_intervals=None)}))
    cases.append(_case("e2e-deliver-real-finding-without-title-keyerror", [_deliver(**real)],
                       rows={FID: _confirmed(finding={"severity": "x"})}))

    # Retry through the real transport carries guidance into the job.
    evidence = {"repair_task": JOB, "repair_base": HEAD, "reason": "needs work"}
    event = _repair_event("p0", evidence)
    ack = ledger.digest({"job": JOB})
    row = _confirmed(receipt={"acknowledgement": ack, "repair_task": JOB}, previous_event_id=event["id"])
    files = _retained(JOB, {"committed.patch": _patch_bytes("src/a.ts")})
    cases.append(_case("e2e-retry-real-transport-carries-guidance", [_deliver(**real)], rows={FID: row},
                       retained=[event], repair_files=files))
    cases.append(_case("e2e-retry-configured-transport-scans-guidance", [_deliver(mode="configured")], rows={FID: row},
                       retained=[event], repair_files=files))
    cases.append(_case("e2e-retry-guidance-marker-refused", [_deliver(mode="configured")], rows={FID: row},
                       retained=[event], repair_files=files, deny_marker="needs work"))
    cases.append(_case("e2e-retry-real-without-instruction-scanner-refused",
                       [_deliver(mode="plain", absent=["instructions"])], rows={FID: row}, retained=[event],
                       repair_files=files))
    cases.append(_case("e2e-retry-after-delivery-two-confirmations",
                       [_deliver(**real), _deliver(**real)], rows={FID: good}))
    # A second confirmation (new previous_event_id, prior receipt kept) must
    # derive a new key and a distinct repair task.
    again = _confirmed(receipt={"acknowledgement": ACK, "repair_task": JOB}, previous_event_id="p1")
    cases.append(_case("e2e-redelivery-after-second-confirmation-new-key-and-task",
                       [_deliver(**real), _deliver(seed_rows={FID: again}, **real)], rows={FID: good}))
    return cases


def build() -> Dict[str, Any]:
    cases = []
    for case in [*basic_cases(), *retry_cases(), *rounds_cases(), *accept_cases(), *combined_cases()]:
        if case is None:
            continue
        try:
            # Run the spec exactly as the replay will read it (keys sorted), so
            # dict iteration order cannot differ between oracle and port.
            spec = json.loads(json.dumps(case["spec"], sort_keys=True))
            cases.append({**case, "spec": spec, "result": run(spec)})
        except Trap as error:
            raise Trap(f"{case['name']}: {error}") from error
    names = [case["name"] for case in cases]
    if len(names) != len(set(names)):
        duplicates = sorted({n for n in names if names.count(n) > 1})
        raise Trap(f"duplicate case names: {duplicates}")
    return {"schema": "cq.finding-delivery-vectors/v1", "cases": cases}


def render(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the finding-delivery oracle fixture")
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
        print("finding-delivery fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
