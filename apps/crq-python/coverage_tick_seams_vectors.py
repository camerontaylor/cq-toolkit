#!/usr/bin/env python3
"""Deterministic offline oracle for the CoverageEffects tick seams.

Test tooling only. It drives the PRODUCTION ``crq.parse_iso``,
``crq.live_items``, ``crq.sort_key`` (through ``sorted``), ``crq.deps_met`` and
``backfill_runtime.settings(STATE, dispatch=True)`` and records what Python
actually does: the value, or the exception class where Python lets one escape.

* ``crq.now`` is fixed, and ``crq.REPO``, ``crq.REPOS`` and ``crq.CONFIG`` are
  patched per case, so ranking is reproducible.
* ``settings`` runs over a throwaway state directory holding the case's
  ``backfill-rollout.json`` bytes, and over a throwaway ``ROOT`` holding the
  case's three policy files. Nothing touches a real queue, state directory,
  network or host service.

The TypeScript test (``test/adapters/crq/coverageTickSeams.test.ts``) replays
the same specs through ``src/adapters/crq/coverageTickSeams.ts``.

Regenerate with ``python3.14 coverage_tick_seams_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import backfill_runtime  # noqa: E402
import crq  # noqa: E402

SCHEMA = "crq-coverage-tick-seams-oracle/1"
FIXTURE = HERE / "fixtures" / "crq-coverage-tick-seams" / "cases.json"
NOW = "2026-11-20T12:00:00Z"
PRIMARY = "owner/primary"


def failure(error: BaseException) -> dict:
    return {"raises": type(error).__name__, "message": str(error)}


def guarded(call, scrub: str | None = None) -> dict:
    try:
        return {"ok": call()}
    except BaseException as error:  # noqa: BLE001 - the oracle records every escape
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        out = failure(error)
        if scrub:  # a host temp path is not a fact about Python
            out["message"] = out["message"].replace(scrub, "<tmp>")
        return out


# ------------------------------------------------------------------ parse_iso

PARSE_INPUTS: list[Any] = [
    "2026-11-20T12:00:00Z", "2026-11-20T12:00:00.000Z", "2026-11-20T12:00:00.123Z",
    "2026-11-20T12:00:00", "2026-11-20t12:00:00z", "2026-11-20T12:00:00ZZZ",
    "2026-11-20T12:00:00+08:00", "2026-11-20T12:00:00.000000Z",
    "2026-1-2T3:4:5Z", "2026-02-30T00:00:00Z", "2026-11-20T24:00:00Z", "2026-11-20T23:59:60Z",
    "not a time", "2026-11-20", "", " 2026-11-20T12:00:00Z", "2026-11-20T12:00:00Z extra",
    "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "0000-01-01T00:00:00Z",
    5, 1.5, True, ["2026-11-20T12:00:00Z"], {"a": 1}, None, 0, 0.0, False, [], {},
]


def parse_case(value: Any) -> dict:
    def call():
        parsed = crq.parse_iso(value)
        if parsed is None:
            return None
        return int(parsed.timestamp() * 1000)
    return {"input": value, "outcome": guarded(call)}


# ------------------------------------------------------------- queue helpers


def item(id_: str, kind: str = "open", **extra: Any) -> dict:
    out = {"id": id_, "kind": kind, "state": "pending"}
    out.update(extra)
    return out


AGED = "2026-11-20T10:00:00Z"
FRESH = "2026-11-20T11:59:00Z"

QUEUES: list[dict] = [
    {"name": "kinds", "items": [
        item("cov", "coverage", order=1), item("open", "open", order=2),
        item("delta", "delta", order=3), item("merged-delta", "delta", followup="merged", order=4),
        item("merged", "merged", order=5), item("followup", "merged", source="followup", order=6),
        item("backlog", "merged", source="backlog", order=7), item("author", "author", order=8),
        item("backfill", "backfill", order=9), item("receipt", "merged-current", order=10),
        item("promo", "promotion", order=11), item("noorder", "open"),
    ]},
    {"name": "operator-priority-and-order", "items": [
        item("a", "merged", order=1), item("b", "merged", order=2, operator_priority=True),
        item("c", "merged", order=2), item("d", "merged", order=1, operator_priority=False),
        item("e", "merged", operator_priority=True, order=50), item("f", "merged", order=1.5),
        item("g", "merged", order=0), item("h", "open", order=0), item("i", "open", order=5),
    ]},
    {"name": "optional-and-author-cycles", "items": [
        item("open0", "open", order=1), item("open1", "open", order=2, cycles=[{"n": 1}]),
        item("auth1", "author", order=3, author={"cycle": 1}), item("auth2", "author", order=4, author={"cycle": 2}),
        item("auth-none", "author", order=5), item("auth3", "author", order=6, author={"cycle": 3}),
    ]},
    {"name": "local-review-aging", "items": [
        item("lr-first", "local-review", order=1),
        item("lr-gen2-aged", "local-review", order=2, generation=2, created_at=AGED),
        item("lr-gen2-fresh", "local-review", order=3, generation=2, created_at=FRESH),
        item("lr-repeat", "local-review", order=4, repeat_requested=True, created_at=AGED),
        item("lr-ancestry", "local-review", order=5, ancestry_repeat=True, created_at=FRESH),
        item("lr-no-created", "local-review", order=6, generation=3),
        item("lr-bad-created", "local-review", order=7, generation=3, created_at="garbage"),
        item("lr-repeat-str", "local-review", order=8, repeat_requested="yes", created_at=AGED),
    ]},
    {"name": "repo-ranks", "items": [
        item("p", "merged", order=1), item("q-tier1", "merged", order=2, repo="owner/Other"),
        item("q-gone", "merged", order=3, repo="owner/removed"), item("q-empty", "merged", order=4, repo=""),
        item("q-primary-case", "merged", order=5, repo="OWNER/Primary"),
        item("q-open", "open", order=6, repo="owner/other"), item("q-cov", "coverage", order=7, repo="owner/removed"),
    ]},
    {"name": "dependencies", "items": [
        item("root", "merged", order=1), item("done", "merged", order=2, state="done"),
        item("skip", "merged", order=3, state="skipped"), item("rev", "merged", order=4, state="reviewing"),
        item("opt", "open", order=5, state="reviewing", cycles=[{"n": 1}]),
        item("d-root", "merged", order=6, depends_on="root"), item("d-done", "merged", order=7, depends_on="done"),
        item("d-skip", "merged", order=8, depends_on="skip"), item("d-rev", "merged", order=9, depends_on="rev"),
        item("d-opt", "merged", order=10, depends_on="opt"), item("d-gone", "merged", order=11, depends_on="gone"),
        item("d-empty", "merged", order=12, depends_on=""), item("d-null", "merged", order=13, depends_on=None),
        item("d-zero", "merged", order=14, depends_on=0), item("d-promo", "merged", order=15, depends_on="promo"),
        item("promo", "promotion", order=16, state="reviewing"),
    ]},
]

CONFIGS: list[dict] = [
    {"name": "default", "aging": None, "repos": []},
    {"name": "ranked", "aging": 5, "repos": [{"repo": "owner/other", "rank_tier": 1}, {"repo": "owner/Idle", "rank_tier": 4}]},
    {"name": "aging-zero", "aging": 0, "repos": [{"repo": "owner/other", "rank_tier": 0}]},
]


def queue_case(queue: dict, config: dict) -> dict:
    q = {"items": copy.deepcopy(queue["items"])}
    crq_config = {"repo": PRIMARY}
    if config["aging"] is not None:
        crq_config["local_review_aging_minutes"] = config["aging"]
    fixed = dt.datetime(2026, 11, 20, 12, 0, 0, tzinfo=dt.timezone.utc)
    with mock.patch.object(crq, "now", lambda: fixed), mock.patch.object(crq, "CONFIG", crq_config), \
            mock.patch.object(crq, "REPO", PRIMARY), mock.patch.object(crq, "REPOS", copy.deepcopy(config["repos"])):
        live = [i["id"] for i in crq.live_items(q)]
        ordered = guarded(lambda: [i["id"] for i in sorted(crq.live_items(q), key=crq.sort_key)])
        deps = {i["id"]: guarded(lambda i=i: bool(crq.deps_met(q, i))) for i in q["items"]}
    return {"queue": queue["name"], "items": queue["items"], "config": config["name"], "live": live, "sorted": ordered, "deps": deps}


MALFORMED: list[dict] = [
    {"name": "items-not-a-list", "queue": {"items": "nope"}},
    {"name": "items-missing", "queue": {}},
    {"name": "item-not-a-dict", "queue": {"items": [item("a"), 7]}},
]


def malformed_case(spec: dict) -> dict:
    def call():
        return [i["id"] for i in crq.live_items(copy.deepcopy(spec["queue"]))]
    return {"name": spec["name"], "queue": spec["queue"], "live": guarded(call)}


# ------------------------------------------------------------------ settings

POLICY_GOOD = {
    "tiers": {"version": 1}, "required-list": {"version": 1},
    "limits": {"version": 1, "max_files": 8, "max_file_bytes": 200000, "max_total_bytes": 500000,
               "reviewer": {"verified": True, "version": "0.9.2", "max_files": 8, "max_diff_bytes": 262144,
                            "evidence": "docs/evidence.json"}},
}


def limits(**reviewer: Any) -> dict:
    base = copy.deepcopy(POLICY_GOOD["limits"])
    for key, value in reviewer.items():
        if value == "__drop__":
            base["reviewer"].pop(key, None)
        else:
            base["reviewer"][key] = value
    return base


def rollout(**over: Any) -> dict:
    out = {"enabled": True, "operational_ruling": "r", "no_live_run_verification": "n",
           "owner_branch_ruleset_evidence": "e", "durable_artifact_root": "/var/evidence",
           "runner_identity": "crq-runner-app",
           "publisher_spool": {"ssh_alias": "svc@host.example", "ssh_key": "/keys/id"}}
    for key, value in over.items():
        if value == "__drop__":
            out.pop(key, None)
        else:
            out[key] = value
    return out


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


SETTINGS: list[dict] = [
    {"name": "absent", "rollout": None},
    {"name": "enabled-ok", "rollout": dump(rollout())},
    {"name": "enabled-ok-key-alias", "rollout": dump(rollout(publisher_spool={"ssh_alias": "svc@h", "key": "/k"}))},
    {"name": "disabled", "rollout": dump(rollout(enabled=False))},
    {"name": "enabled-string-true", "rollout": dump(rollout(enabled="true"))},
    {"name": "enabled-one", "rollout": dump(rollout(enabled=1))},
    {"name": "enabled-missing", "rollout": dump(rollout(enabled="__drop__"))},
    {"name": "disabled-but-incomplete", "rollout": dump({"enabled": False})},
    {"name": "incomplete-missing-ruling", "rollout": dump(rollout(operational_ruling="__drop__"))},
    {"name": "incomplete-empty-ruling", "rollout": dump(rollout(operational_ruling=""))},
    {"name": "wrong-runner", "rollout": dump(rollout(runner_identity="someone"))},
    {"name": "spool-not-dict", "rollout": dump(rollout(publisher_spool=["x"]))},
    {"name": "spool-extra-key", "rollout": dump(rollout(publisher_spool={"ssh_alias": "svc@h", "ssh_key": "/k", "x": 1}))},
    {"name": "spool-bad-alias", "rollout": dump(rollout(publisher_spool={"ssh_alias": "nope", "ssh_key": "/k"}))},
    {"name": "spool-blank-key", "rollout": dump(rollout(publisher_spool={"ssh_alias": "svc@h", "ssh_key": "  "}))},
    {"name": "spool-newline-key", "rollout": dump(rollout(publisher_spool={"ssh_alias": "svc@h", "ssh_key": "a\nb"}))},
    {"name": "not-an-object", "rollout": "[1, 2]"},
    {"name": "scalar", "rollout": "7"},
    {"name": "malformed-json", "rollout": "{"},
    {"name": "duplicate-key", "rollout": '{"enabled": true, "enabled": true}'},
    {"name": "float-value", "rollout": dump(rollout(extra=1.5)).replace('"extra": 1.5', '"extra": 1.5')},
    {"name": "non-utf8", "rollout_hex": "7b22656e61626c6564223a20747275652c20ff7d"},
    {"name": "empty-file", "rollout": ""},
    {"name": "limits-unverified", "rollout": dump(rollout()), "policy": {"limits": limits(verified=False)}},
    {"name": "limits-no-evidence", "rollout": dump(rollout()), "policy": {"limits": limits(evidence="")}},
    {"name": "limits-no-diff-bytes", "rollout": dump(rollout()), "policy": {"limits": limits(max_diff_bytes="__drop__")}},
    {"name": "limits-diff-bytes-zero", "rollout": dump(rollout()), "policy": {"limits": limits(max_diff_bytes=0)}},
    {"name": "limits-diff-bytes-float", "rollout": dump(rollout()), "policy": {"limits_text": json.dumps(POLICY_GOOD["limits"]).replace("262144", "262144.0")}},
    {"name": "limits-files-zero", "rollout": dump(rollout()), "policy": {"limits": {**POLICY_GOOD["limits"], "max_files": 0}}},
    {"name": "limits-missing-key", "rollout": dump(rollout()), "policy": {"limits": {k: v for k, v in POLICY_GOOD["limits"].items() if k != "max_total_bytes"}}},
    {"name": "limits-missing-reviewer", "rollout": dump(rollout()), "policy": {"limits": {k: v for k, v in POLICY_GOOD["limits"].items() if k != "reviewer"}}},
    {"name": "tiers-missing", "rollout": dump(rollout()), "policy": {"tiers": None}},
    {"name": "required-list-malformed", "rollout": dump(rollout()), "policy": {"required-list_text": "{"}},
    {"name": "limits-not-consulted-when-disabled", "rollout": dump(rollout(enabled=False)), "policy": {"limits_text": "{"}},
    {"name": "state-root-is-a-file", "rollout": None, "state_kind": "file"},
    {"name": "rollout-symlink-loop", "rollout": None, "state_kind": "loop"},
    {"name": "limits-not-consulted-when-absent", "rollout": None, "policy": {"limits_text": "{"}},
]


def policy_files(spec: dict | None) -> dict[str, str | None]:
    spec = spec or {}
    files: dict[str, str | None] = {}
    for name in ("tiers", "limits", "required-list"):
        if name + "_text" in spec:
            files[name] = spec[name + "_text"]
        elif name in spec:
            files[name] = None if spec[name] is None else json.dumps(spec[name])
        else:
            files[name] = json.dumps(POLICY_GOOD[name])
    return files


def settings_case(spec: dict) -> dict:
    files = policy_files(spec.get("policy"))
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state"
        (root / "policy").mkdir()
        state.mkdir()
        if spec.get("state_kind") == "file":  # `exists()` swallows ENOTDIR
            state.rmdir()
            state.write_text("", encoding="utf-8")
        elif spec.get("state_kind") == "loop":  # ... and ELOOP
            (state / "backfill-rollout.json").symlink_to("backfill-rollout.json")
        for name, text in files.items():
            if text is not None:
                (root / "policy" / f"review-{name}.json").write_text(text, encoding="utf-8")
        if spec.get("rollout_hex") is not None:
            (state / "backfill-rollout.json").write_bytes(bytes.fromhex(spec["rollout_hex"]))
        elif spec.get("rollout") is not None:
            (state / "backfill-rollout.json").write_text(spec["rollout"], encoding="utf-8")
        with mock.patch.object(backfill_runtime, "ROOT", root):
            outcome = guarded(lambda: bool(backfill_runtime.settings(state, dispatch=True)), scrub=str(root))
    return {"name": spec["name"], "spec": {**spec, "policy_files": files}, "outcome": outcome}


def build() -> dict:
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/crq.py:116,256,3172; apps/crq-python/backfill_runtime.py:37",
        "now": NOW, "primary": PRIMARY,
        "parse_iso": [parse_case(v) for v in PARSE_INPUTS],
        "queues": [queue_case(q, c) for q in QUEUES for c in CONFIGS],
        "configs": CONFIGS,
        "malformed": [malformed_case(m) for m in MALFORMED],
        "settings": [settings_case(s) for s in SETTINGS],
    }


def tagged(value: Any) -> Any:
    """Keep what JSON would lose: floats stay floats and big ints stay exact."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, float):
        return {"$float": repr(value)}
    if isinstance(value, int):
        return {"$int": str(value)} if abs(value) > 2**53 else value
    if isinstance(value, list):
        return [tagged(v) for v in value]
    return {k: tagged(v) for k, v in value.items()}


def render(document: dict) -> str:
    return json.dumps(tagged(document), ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq coverage tick seams oracle fixture")
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
        print("coverage tick seams fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
