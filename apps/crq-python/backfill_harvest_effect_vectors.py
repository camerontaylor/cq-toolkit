#!/usr/bin/env python3
"""Deterministic offline oracle for the ``backfill_runtime.harvest`` effect.

Test tooling only. It runs the PRODUCTION ``backfill_runtime.harvest``
(``backfill_runtime.py:355``) over a throwaway run directory and a plain queue,
with ``crq.classify`` and ``crq.set_rate_cooldown`` real. Only the seams the TS
effect leaves injected are stubbed, and the TS replay stubs them identically:
``services`` (stub Git repo, real ``ArtifactStore``), ``state_event``,
``c.save_queue``, ``c.remove_worktree``, the publication outbox and
``finding_delivery.Inbox``. Each stub appends one line to a call log, so the
effect order is compared as well as the final queue.

A scenario records the returned string, the exception class that escaped, the
final queue, the call log and whether ``review-event.json`` was left behind.
Temporary paths are substituted with ``/T`` so the fixture is host independent.

Regenerate with ``python3.14 backfill_harvest_effect_vectors.py --write`` and
verify with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import backfill_runtime as runtime  # noqa: E402
import crq  # noqa: E402
import finding_delivery  # noqa: E402
import review_ledger as ledger  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-backfill-harvest-effect" / "cases.json"
SCHEMA = "cq.crq-backfill-harvest-effect-vector/v1"
AT = "2026-10-30T00:00:00Z"
ENDED = "2026-10-30T01:00:00Z"
HEAD, BASE, TARGET = "a" * 40, "c" * 40, "d" * 40
SCOPE = [{"path": "a", "blob": "b" * 40, "intervals": [[1, 2]]}]
ITEM = {"id": "j", "kind": "backfill", "state": "reviewing", "vendor_state": "live", "family": "f",
        "scope": SCOPE, "attempt_id": "a", "run": {"run_id": "r", "band": "background", "started_at": AT},
        "failures": 0, "subject_id": "s", "job_id": "s:0", "generation": 0, "base": BASE, "head": HEAD,
        "head_tree": "e" * 40, "target": TARGET, "target_tree": "f" * 40, "construction_policy_digest": "9" * 64,
        "scope_digest": ledger.digest(SCOPE), "paths": [{"path": "a", "blob": "b" * 40, "mode": "100644", "disposition": "included", "reason": "verified",
                                                                          "baseline": {}}]}
QUEUE = {"items": [ITEM], "backfill_reservations": {"a": {"item": "j", "vendor_run_id": "r", "quota_state": "reserved"}}}
META = {"run_id": "r", "item_id": "j", "backfill": {"attempt_id": "a"}, "worktree": "/T/wt", "wt_branch": "crq/r",
        "head": HEAD}
DEFAULT_BACKOFF_MIN = 7


def hexs(text: str) -> str:
    return text.encode("utf-8", "surrogatepass").hex()


def lines(*rows: object) -> str:
    return hexs("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))


QUOTA = {"type": "error", "errorType": "rate_limit", "recoverable": True}
QUOTA_WAIT = {**QUOTA, "metadata": {"waitTime": "30 minutes"}}
AUTH = {"type": "error", "errorType": "auth"}
COMPLETE = {"type": "complete", "status": "review_completed", "head": HEAD, "reviewedFiles": SCOPE}
FINDING = {"type": "finding", "severity": "major", "fileName": "a", "comment": "fix it", "id": "v1"}

SCENARIOS: list[dict] = []


def scenario(name, *, raw, exit_code=1, queue=None, meta=None, exit_doc=None, cls=None, verified=True,
             retained=None, drop=(), configured=True):
    SCENARIOS.append({"name": name, "raw": raw, "exit_code": exit_code, "queue": queue or {}, "meta": meta or {},
                      "exit_doc": exit_doc, "cls": cls, "verified": verified,
                      "drop": list(drop), "configured": configured})


def with_item(**over):
    return {"items": [{**copy.deepcopy(ITEM), **over}]}


def build_scenarios() -> None:
    # Failure arm.
    scenario("quota, verified: deferred with cooldown", raw=lines(QUOTA))
    scenario("quota with classified wait", raw=lines(QUOTA_WAIT))
    scenario("quota, verified, queue backoff", raw=lines(QUOTA), queue={"rl_backoff_min": 3})
    scenario("quota, existing later cooldown kept", raw=lines(QUOTA), queue={"cooldown_until": "2026-10-30T09:00:00Z"})
    scenario("quota, existing earlier cooldown replaced", raw=lines(QUOTA), queue={"cooldown_until": "2026-10-30T01:01:00Z"})
    scenario("quota, string queue backoff is unusable", raw=lines(QUOTA), queue={"rl_backoff_min": "3"})
    scenario("quota, negative queue backoff is unusable", raw=lines(QUOTA), queue={"rl_backoff_min": -3})
    scenario("quota, unverified terminal retains ownership", raw=lines(QUOTA), verified=False)
    scenario("quota mixed with auth: pauses", raw=lines(QUOTA, AUTH))
    scenario("quota mixed with auth, unverified: pauses and retains", raw=lines(QUOTA, AUTH), verified=False)
    scenario("quota mixed with another failure: integrity",
             raw=lines(QUOTA, {"type": "error", "errorType": "boom"}))
    scenario("auth failure pauses", raw=lines(AUTH))
    scenario("generic failure", raw=lines({"type": "error", "errorType": "boom"}))
    scenario("generic failure, unverified terminal still terminal", raw=lines({"type": "error", "errorType": "boom"}),
             verified=False)
    scenario("empty stream, nonzero exit", raw="", exit_code=2)
    scenario("non-UTF-8 stream", raw="ff" + lines(AUTH))
    scenario("second failure on a quarantined family", raw=lines(AUTH),
             queue={"backfill_families": {"f": {"failures": 5, "quarantined": False, "next_eligible_at": None}}})
    scenario("third failure blocks", raw=lines({"type": "error", "errorType": "boom"}),
             queue=with_item(failures=2))
    scenario("prior attempt for the run is not repeated", raw=lines(AUTH),
             queue=with_item(attempts=[{"run_id": "r", "outcome": "x"}]))
    scenario("capacity run already counted", raw=lines(AUTH), queue={"backfill_capacity_runs": ["r"]})
    scenario("capacity day row preseeded", raw=lines(AUTH),
             queue={"backfill_daily_capacity": {"2026-10-30": {"spare_admissions": 4, "completed_partitions": 2}}})
    scenario("meta without worktree: no cleanup", raw=lines(AUTH), meta={"worktree": None})
    scenario("meta without branch: no cleanup", raw=lines(AUTH), meta={"wt_branch": ""})
    scenario("no reservation for the attempt", raw=lines(QUOTA), queue={"backfill_reservations": {}})
    scenario("reservation owned by another item", raw=lines(QUOTA),
             queue={"backfill_reservations": {"a": {"item": "other", "vendor_run_id": "r"}}})
    scenario("reservation bound to another run", raw=lines(AUTH),
             queue={"backfill_reservations": {"a": {"item": "j", "vendor_run_id": "zz"}}})
    scenario("item run bound to another run", raw=lines(AUTH), queue=with_item(run={"run_id": "zz"}))
    scenario("meta run id differs", raw=lines(AUTH), meta={"run_id": "zz"})
    scenario("exit code differs from exit.json", raw=lines(AUTH), exit_doc={"exit": 3, "ended_at": ENDED})
    scenario("exit.json lacks ended_at", raw=lines(AUTH), exit_doc={"exit": 1})
    scenario("exit.json ended_at not a timestamp", raw=lines(AUTH), exit_doc={"exit": 1, "ended_at": "soon"})
    scenario("exit.json missing", raw=lines(AUTH), drop=["exit.json"])
    scenario("review.ndjson missing", raw=lines(AUTH), drop=["review.ndjson"])
    scenario("rollout not configured", raw=lines(AUTH), configured=False)
    # Counted arm.
    scenario("counted completion", raw=lines(COMPLETE), exit_code=0)
    scenario("counted completion with a vendor finding", raw=lines(FINDING, COMPLETE), exit_code=0)
    scenario("counted completion, unverified terminal still completes", raw=lines(COMPLETE), exit_code=0, verified=False)
    scenario("counted, wrong reviewed head: scope unverified", raw=lines({**COMPLETE, "head": "9" * 40}), exit_code=0)
    scenario("counted, path-only receipt: scope unverified",
             raw=lines({**COMPLETE, "reviewedFiles": [{"path": "a"}]}), exit_code=0)
    scenario("counted completion publishes once on a second queue", raw=lines(COMPLETE), exit_code=0,
             queue={"backfill_capacity_runs": ["r"]})


class StubRepo:
    def entries(self, rev):
        return {"a": {"blob": "b" * 40}}

    def retain(self, store, revs):
        return store.put(("bundle:" + " ".join(revs)).encode())

    def verify_review(self, event):
        return None


def shape(value: dict) -> str:
    """Event identity minus artifact locations, which live under the random temp root."""
    payload = value["payload"]
    return " ".join([value["event_type"], value["source_key"], payload["outcome"], "findings=" + str(len(payload["findings"])),
                     "artifacts=" + str(len(payload["artifacts"]))])


def resolve(spec: dict) -> dict:
    """The fully merged inputs, so the replay needs none of this module's constants."""
    queue = copy.deepcopy(QUEUE)
    queue.update(copy.deepcopy(spec["queue"]))
    return {"queue": queue, "meta": {**copy.deepcopy(META), **spec["meta"]},
            "exit_doc": spec["exit_doc"] or {"exit": spec["exit_code"], "ended_at": ENDED}}


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state"
        rdir = state / "runs" / "r"
        rdir.mkdir(parents=True)
        durable = root / "durable"
        raw = bytes.fromhex(spec["raw"])
        resolved = resolve(spec)
        meta, exit_doc = resolved["meta"], resolved["exit_doc"]
        files = {"review.ndjson": raw, "exit.json": ledger.canonical(exit_doc), "meta.json": ledger.canonical(meta)}
        for name, data in files.items():
            if name not in spec["drop"]:
                (rdir / name).write_bytes(data)
        if spec["configured"]:
            ledger.atomic(state / "backfill-rollout.json", ledger.canonical({
                "enabled": True, "durable_artifact_root": str(durable), "runner_identity": "crq-runner-app",
                "operational_ruling": "x", "no_live_run_verification": "x", "owner_branch_ruleset_evidence": "x",
                "publisher_spool": {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "/fixture/key"}}))
        queue = resolved["queue"]
        item = queue["items"][0]
        log: list[str] = []
        c = SimpleNamespace(STATE=state, CLONE=root / "clone", iso=lambda: AT, CONFIG={"rate_limit_default_backoff_min": DEFAULT_BACKOFF_MIN})
        c.classify = crq.classify
        c.set_rate_cooldown = crq.set_rate_cooldown
        c.save_queue = lambda q: log.append("save")
        c.remove_worktree = lambda path, branch: log.append("cleanup " + str(path) + " " + str(branch))
        store = ledger.ArtifactStore(durable)
        outbox = SimpleNamespace(spool=lambda value: log.append("spool " + shape(value)))

        def services(_c, _config):
            return StubRepo(), store, outbox, None

        def state_event(_c, q, it, at, reason, operator=None, state=None):
            log.append("event " + at + " " + reason)
            q.setdefault("stub_events", []).append({"at": at, "reason": reason, "state": it["state"]})

        class Inbox:
            def __init__(self, path, _outbox):
                pass

            def ingest(self, value):
                log.append("ingest " + shape(value))

        out: dict = {}
        cls = spec["cls"]
        if cls is None:
            try:
                cls = crq.classify(rdir / "review.ndjson", spec["exit_code"])
            except BaseException as exc:  # noqa: BLE001
                out["classify_error"] = type(exc).__name__
                cls = {"counted": False, "outcome": "error"}
        with mock.patch.object(runtime, "services", services), mock.patch.object(runtime, "state_event", state_event), \
                mock.patch.object(finding_delivery, "Inbox", Inbox):
            try:
                out["result"] = runtime.harvest(c, queue, item, rdir, meta, cls, spec["exit_code"],
                                                terminal_verified=spec["verified"])
                out["error"] = None
            except BaseException as exc:  # noqa: BLE001 - the class is the datum
                out["result"] = None
                out["error"] = type(exc).__name__
        out["cls"] = cls
        # The event id hashes artifact locations under the random temp root; the replay
        # asserts a 64-hex id and masks it the same way.
        for row in queue["items"]:
            if "publication_event_id" in row:
                assert len(row["publication_event_id"]) == 64
                row["publication_event_id"] = "EVENT"
        out["queue"] = queue
        out["log"] = log
        out["review_event"] = (rdir / "review-event.json").exists()
        return json.loads(json.dumps(out, sort_keys=True).replace(tmp, "/T"))


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    return {"schema": SCHEMA, "cases": [{"name": s["name"], "scenario": s, "input": resolve(s), "expected": _run(copy.deepcopy(s))}
                                        for s in SCENARIOS]}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    rows = [json.dumps(c, ensure_ascii=True, sort_keys=True, separators=(",", ":")) for c in document["cases"]]
    return json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(rows) + "\n]}\n"


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
        print("backfill-harvest-effect fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
