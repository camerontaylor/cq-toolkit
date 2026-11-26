"""Differential oracle for the composed S6 tick shadow: the real `crq.tick`
(apps/crq-python) run once over a frozen state-root copy, with a deterministic
stub for every effect the TypeScript composition also cannot reach offline.

Test tooling only. Usage: python3 -I composedTickShadowOracle.py <apps/crq-python dir>
Reads {"root": <frozen copy>, "spec": {"now": ISO, "runnerRoot": path,
"rootField": str, "home": scratch dir, "clone": offline clone, "config": {overrides}}} on stdin and prints
{"log": [...], "phaseCalls": [...]} as JSON. Everything else is left on disk
under `root`: queue.json, events.jsonl, status.json, status.md, next-review-at
and heartbeat.json (WATCHDOG_HOME is the root itself).

The same stubs, by name, sit in composedTickShadowTs.ts:

* `start_one` admits nothing (`(False, False)`); the TS `startOne` returns the
  same "nothing started, no coverage candidate".
* `fetch` and `enroll` are no-ops; the TS forge returns empty listings, so its
  open-PR enrollment finds nothing to enroll either.
* `usage_slots.read_usage` reports one slot remaining; the TS vendor probes do too.
* `notify_owner` is recorded, never sent.
* the clock is `spec.now`.

Everything else runs for real: backfill, archive_legacy, reconcile,
write_status, write_heartbeat, client_health.record, coverage, the cooldown
and the slot deadline. Nothing leaves the process and nothing outside
`root` is written.
"""
import datetime as dt
import json
import os
import sys
from pathlib import Path
from unittest import mock


def main() -> None:
    payload = json.load(sys.stdin)
    root = Path(payload["root"])
    spec = payload["spec"]
    # The summary reads XDG_STATE_HOME or ~/.local/state: point both into scratch.
    os.environ["HOME"] = spec["home"]
    os.environ["XDG_STATE_HOME"] = spec["home"] + "/xdg"
    sys.path.insert(0, sys.argv[1])
    import crq

    fixed = dt.datetime.fromisoformat(spec["now"].replace("Z", "+00:00"))
    config = dict(crq.CONFIG)
    config.update(spec.get("config") or {})
    config["clone"] = spec["clone"]
    calls = []

    patches = [
        mock.patch.object(crq, "STATE", root),
        mock.patch.object(crq, "QUEUE", root / "queue.json"),
        mock.patch.object(crq, "EVENTS", root / "events.jsonl"),
        mock.patch.object(crq, "RUNS", root / "runs"),
        mock.patch.object(crq, "LEDGER", root / "ledger"),
        mock.patch.object(crq, "LOCK", root / "tick.lock"),
        mock.patch.object(crq, "ROOT", Path(spec["rootField"])),
        mock.patch.object(crq, "RUNNER_ROOT", Path(spec["runnerRoot"])),
        mock.patch.object(crq, "WATCHDOG_HOME", root),
        mock.patch.object(crq, "CONFIG", config),
        mock.patch.object(crq, "CLONE", Path(spec["clone"])),
        mock.patch.object(crq, "now", lambda: fixed),
        mock.patch.object(crq, "fetch", lambda *a, **k: None),
        mock.patch.object(crq, "enroll", lambda q, dry: []),
        mock.patch.object(crq.usage_slots, "read_usage", lambda *a, **k: {"remaining": 1}),
        mock.patch.object(
            crq,
            "start_one",
            lambda q, log, dry, only, ignore_quiet, capture_current=True: (
                calls.append("start_one"),
                (False, False),
            )[1],
        ),
        mock.patch.object(crq, "notify_owner", lambda *a, **k: None),
    ]
    for patch in patches:
        patch.start()
    log = crq.tick(
        bool(spec.get("dry")), spec.get("only"), bool(spec.get("ignoreQuiet"))
    )
    json.dump({"log": log, "phaseCalls": calls}, sys.stdout)


main()
