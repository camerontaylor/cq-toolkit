"""`publish-effects.json`: real oracle fixtures for the remaining publisher
effect sections (migration lane A1, follow-up to `emit.py`).

Separate from `fixtures/a1-status/emit.py` on purpose: this file is owned by
the summary-publish slice and drives the real `status_summary.publish`,
`repair_tick.digest` and `backfill_report.finding_triage` with only the
process seams patched (systemd probe, gh lookup, XDG environment), so the
`repair`, `finding_triage` and `systemd_timers` values, the title cache and
the full compact publish bytes come from the producers themselves.

Every input is plain JSON with fixed timestamps; mtimes are injected with
`os.utime` and the repair digest clock is frozen by patching
`datetime.datetime.now`, so the bytes are host-independent.

Families:

- `systemd`: `status_summary.systemd_activity` over patched `command` stdout
  (unavailable probe, loaded/active units, not-found units, monotonic
  timespans with month/year units, fractional and huge epoch stamps,
  missing-unit observation) with the realtime/monotonic clock pair recorded.
- `repair-digest`: `repair_tick.digest` over a temp state tree with real
  inbox files, verdict shapes (FIXED/NOT-FIXED/STALE/unknown, judge
  valid/invalid/absent/str), fix_pr and source_publication_error capture,
  drainable/undrainable/consumed/orphaned stems, result retry_after
  truthiness, progress running, corrupt inbox job and corrupt result
  refusals.
- `triage`: `backfill_report.finding_triage(strict=False, limit=32)` over
  real triage rows: valid rows with typed failure classes, unknown classes,
  context errors, mapped_path/target_current resolution, corrupt/broken
  rows, and the 32-row preview bound (40 rows -> omitted counts).
- `publish-full`: the whole `status_summary.publish` document over a temp
  state tree (real repair digest and triage, patched systemd and gh, empty
  and caching previous summaries) with the exact compact bytes; includes
  the no-tick refusal and the corrupt previous summary paths.

Usage:
    python3 fixtures/publish-effects/emit.py --write   # regenerate
    python3 fixtures/publish-effects/emit.py --check   # fail when stale
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest.mock
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
CRQ = HERE.parent.parent
sys.path.insert(0, str(CRQ))

import backfill_report  # noqa: E402
import repair_tick  # noqa: E402
import status_summary  # noqa: E402

SCHEMA = "cq.crq-publish-effects-vector/v1"
FIXED_NOW = 1_794_225_600.0  # 2026-11-09T12:00:00Z
FIXED_MONOTONIC = 500.0
OLDEST_MTIME = 1_794_000_000.0  # 2026-11-09T06:40:00Z


def _compact(value: Any) -> str:
    """The exact `status_summary.publish` reserialisation (compact, ASCII)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def _utc_iso(epoch: float) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _call(source: str, inputs: Dict[str, Any], call: Callable[[], Any], *, bytes_key: Optional[str] = None) -> Dict[str, Any]:
    try:
        value = call()
    except Exception as exc:  # the oracle refusal is part of the contract
        expect: Dict[str, Any] = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
    else:
        expect = {"ok": True, "value": value}
        if bytes_key is not None:
            expect[bytes_key] = _compact(value)
    return {"name": source, "source": source, "input": inputs, "expect": expect}


def _family(name: str, cases: List[Dict[str, Any]], description: str) -> Dict[str, Any]:
    return {"name": name, "description": description, "cases": cases}


# --------------------------------------------------------------- systemd


def systemd_family() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []

    def case(name: str, *, output: Optional[str], probe_error: bool = False) -> Dict[str, Any]:
        def run() -> Tuple[Dict[str, Any], Dict[str, Any]]:
            if probe_error:
                with unittest.mock.patch.object(
                    status_summary, "command", side_effect=RuntimeError("unavailable")
                ):
                    return status_summary.systemd_activity()
            with unittest.mock.patch.object(status_summary, "command", return_value=output or ""):
                with unittest.mock.patch.object(status_summary.time, "time", return_value=FIXED_NOW):
                    with unittest.mock.patch.object(
                        status_summary.time, "clock_gettime", return_value=FIXED_MONOTONIC
                    ):
                        return status_summary.systemd_activity()

        inputs = {"output": output, "probe_error": probe_error,
                  "realtime": FIXED_NOW, "monotonic": FIXED_MONOTONIC}
        result = _call("status_summary.systemd_activity", inputs, run)
        result["name"] = name
        if result["expect"].get("ok"):
            timers, services = result["expect"]["value"]
            result["expect"]["value"] = {"timers": timers, "services": services}
            result["expect"]["bytes"] = _compact(result["expect"]["value"])
        return result

    cases.append(case("probe-unavailable", output=None, probe_error=True))
    cases.append(case(
        "loaded-and-active",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=@1700000000\nNextElapseUSecRealtime=@1794225000\n"
            "\nId=crq-watchdog.timer\nLoadState=not-found\nActiveState=inactive\n"
        ),
    ))
    cases.append(case(
        "monotonic-month-year",
        output="\n\n".join(
            f"Id={unit}\nLoadState=loaded\nActiveState=active\n"
            f"LastTriggerUSec=@1700000000\nNextElapseUSecMonotonic={value}"
            for unit, value in (
                ("crq-watchdog.timer", "1month 2d 3h"),
                ("crq-tick.timer", "1y 2month 13h 30min"),
            )
        ),
    ))
    cases.append(case(
        "fractional-stamps-truncate",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=@1700000000.5\nNextElapseUSecRealtime=@1794225999.999\n"
        ),
    ))
    cases.append(case(
        "huge-stamp-is-unavailable",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=@99999999999999999999\n"
        ),
    ))
    cases.append(case(
        "bad-timespan-is-unavailable",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=@1700000000\nNextElapseUSecMonotonic=5quux\n"
        ),
    ))
    cases.append(case(
        "empty-realtime-falls-back-to-monotonic",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=\nNextElapseUSecRealtime=0\nNextElapseUSecMonotonic=2h\n"
        ),
    ))
    cases.append(case(
        "missing-unit-stays-observed-unavailable",
        output="Id=crq-slot.timer\nLoadState=loaded\nActiveState=active\n",
    ))
    cases.append(case(
        "unexpected-last-trigger-format",
        output=(
            "Id=crq-tick.timer\nLoadState=loaded\nActiveState=active\n"
            "LastTriggerUSec=2026-11-09T12:00:00Z\n"
        ),
    ))
    return _family("systemd", cases, "status_summary.systemd_activity over patched probe output")


# ---------------------------------------------------------- repair digest


def _state_tree() -> tempfile.TemporaryDirectory:
    return tempfile.TemporaryDirectory()


def _write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


class _FrozenDateTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return cls.fromtimestamp(FIXED_NOW, tz)


def _digest_with_frozen_clock(root: Path, queue: Dict[str, Any]) -> Dict[str, Any]:
    real_datetime = dt.datetime
    with unittest.mock.patch.object(dt, "datetime", _FrozenDateTime):
        try:
            return repair_tick.digest(root, queue)
        finally:
            pass


def repair_digest_family() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []
    inbox_mtimes = {"crq-abc-F1": OLDEST_MTIME, "crq-def-F1": OLDEST_MTIME + 600.0,
                    "crq-ghi-F1": OLDEST_MTIME + 1200.0, "crq-old-F9": OLDEST_MTIME,
                    "crq-consumed-F1": OLDEST_MTIME + 300.0, "crq-sym-F1": OLDEST_MTIME + 60.0,
                    "crq-future-F1": 2_000_000_000.0, "crq-bad-F1": OLDEST_MTIME,
                    "crq-retry-F1": OLDEST_MTIME, "crq-retry0-F1": OLDEST_MTIME,
                    "crq-run-F1": OLDEST_MTIME, "crq-nores-F1": OLDEST_MTIME}

    def case(name: str, *, queue: Dict[str, Any], files: Dict[str, str],
             symlinks: Optional[Dict[str, str]] = None,
             inbox: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        tmp = _state_tree()
        try:
            root = Path(tmp.name)
            for relative, text in files.items():
                _write(root, relative, text)
            for stem, mtime in inbox_mtimes.items():
                if stem == "crq-sym-F1":
                    continue  # created as the symlink below
                path = root / "state/repair/inbox" / f"{stem}.json"
                if inbox is not None and stem in inbox:
                    path.write_text(inbox[stem])
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("{}")
                os.utime(path, (mtime, mtime))
            for link, target in (symlinks or {}).items():
                link_path = root / "state/repair/inbox" / link
                link_path.symlink_to(root / target)
                os.utime(link_path, (inbox_mtimes.get(link[:-5], OLDEST_MTIME),) * 2)

            def run() -> Dict[str, Any]:
                return _digest_with_frozen_clock(root, queue)

            result = _call("repair_tick.digest", {"queue": queue}, run, bytes_key="bytes")
            result["name"] = name
            return result
        finally:
            tmp.cleanup()

    verdict = lambda job, v, rung="A0", judge=None: (
        {"job": job, "verdict": v, "attempts": [{"rung": rung}],
         **({"judge": {"verdict": judge}} if judge is not None else {})}
    )
    queued = lambda jobs: {"state": "queued", "jobs": jobs}
    items = lambda *runs: [{"id": "i", "kind": "open", "state": "pending", "repair_runs": {
        f"r{n}": record for n, record in enumerate(runs)}}]

    cases.append(case(
        "verdicts-and-fix-prs",
        queue={"items": items(
            {"fix_pr": 42, "verdicts": [verdict("crq-consumed-F1", "FIXED", "A1", "valid")]},
            {"source_publication_error": "boom", "verdicts": [verdict("j2", "NOT-FIXED")]},
            {"verdicts": [verdict("j3", "STALE", "A2", "invalid")]},
            {"verdicts": [verdict("j4", "UNKNOWN", "A0")]},
        ), "last_tick": "x"},
        files={},
    ))
    cases.append(case(
        "drainable-pending-running-deferred",
        queue={"items": items(queued(["crq-abc-F1", "crq-ghi-F1", "crq-run-F1", "crq-retry-F1"]))},
        files={
            "state/repair/crq-abc-F1/result.json": '{"retry_after": 30}',
            "state/repair/crq-run-F1/progress.json": "{}",
            "state/repair/crq-retry-F1/result.json": '{"retry_after": "later"}',
        },
    ))
    cases.append(case(
        "retry-after-falsy-is-skipped",
        queue={"items": items(queued(["crq-retry0-F1"]))},
        files={"state/repair/crq-retry0-F1/result.json": '{"retry_after": 0}'},
    ))
    cases.append(case(
        "undrainable-consumed-orphaned",
        queue={"items": items(
            queued(["crq-abc-F1"]),
            {"state": "terminal", "jobs": ["crq-consumed-F1"],
             "verdicts": [verdict("crq-consumed-F1", "FIXED", "A0")]},
        )},
        files={"state/repair/crq-consumed-F1/result.json": "{}"},
    ))
    cases.append(case(
        "symlinked-job-is-still-inbox",
        queue={"items": items(queued(["crq-sym-F1"]))},
        files={},
        symlinks={"crq-sym-F1.json": "state/repair/inbox/crq-abc-F1.json"},
    ))
    cases.append(case(
        "future-mtime-clamps-to-zero-age",
        queue={"items": items(queued(["crq-future-F1"]))},
        files={},
    ))
    cases.append(case(
        "bad-job-id-never-drains",
        queue={"items": items(queued(["retired-crq-signer-7f440274a8+-F1", "crq-ghi-F1"]))},
        files={},
    ))
    cases.append(case(
        "empty-queue-and-empty-inbox",
        queue={"items": []},
        files={},
    ))
    cases.append(case(
        "corrupt-inbox-job-refuses",
        queue={"items": items(queued(["crq-bad-F1"]))},
        files={},
        inbox={"crq-bad-F1": "broken"},
    ))
    cases.append(case(
        "corrupt-result-refuses",
        queue={"items": items(queued(["crq-abc-F1"]))},
        files={"state/repair/crq-abc-F1/result.json": "broken"},
    ))
    cases.append(case(
        "missing-attempts-keyerror",
        queue={"items": items({"verdicts": [{"job": "j", "verdict": "FIXED"}]})},
        files={},
    ))
    cases.append(case(
        "empty-attempts-indexerror",
        queue={"items": items({"verdicts": [{"job": "j", "verdict": "FIXED", "attempts": []}]})},
        files={},
    ))
    cases.append(case(
        "missing-rung-keyerror",
        queue={"items": items({"verdicts": [{"job": "j", "verdict": "FIXED", "attempts": [{}]}]})},
        files={},
    ))
    cases.append(case(
        "judge-string-attributeerror",
        queue={"items": items({"verdicts": [{"job": "j", "verdict": "STALE", "judge": "s"}]})},
        files={},
    ))
    cases.append(case(
        "verdict-string-typeerror",
        queue={"items": items({"verdicts": "s"})},
        files={},
    ))
    cases.append(case(
        "repair-runs-list-attributeerror",
        queue={"items": [{"id": "i", "kind": "open", "state": "pending", "repair_runs": [1]}]},
        files={},
    ))
    return _family("repair-digest", cases, "repair_tick.digest over a real temp state tree")


# ----------------------------------------------------------------- triage


def triage_row(status: str = "needs-human", *, canonical: str = "c", finding_id: str = "i",
               title: str = "Needs", severity: str = "minor", path: str = "a.py",
               target: str = "tip", **extra: Any) -> Dict[str, Any]:
    row = {"status": status, "target": target, "canonical_id": canonical,
           "finding": {"id": finding_id, "title": title, "severity": severity, "path": path}}
    row.update(extra)
    return row


def triage_family() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []

    def case(name: str, rows: Dict[str, Any]) -> Dict[str, Any]:
        tmp = _state_tree()
        try:
            root = Path(tmp.name)
            triage = root / "state/backfill/findings/triage"
            triage.mkdir(parents=True)
            for file_name, row in rows.items():
                if isinstance(row, str):
                    (triage / file_name).write_text(row)
                else:
                    (triage / file_name).write_text(json.dumps(row))

            def run() -> Dict[str, Any]:
                return backfill_report.finding_triage(
                    root / "state/backfill/findings", strict=False, limit=32
                )

            result = _call("backfill_report.finding_triage", {"rows": rows}, run, bytes_key="bytes")
            result["name"] = name
            return result
        finally:
            tmp.cleanup()

    cases.append(case("empty-dir", {}))
    cases.append(case("typed-classes-and-context", {
        "a.json": triage_row(failure_class="owner-decision", previous_event_id="pe1",
                             mapped_path="m.py", target_current="tc"),
        "b.json": triage_row(status="delivered", canonical="d", finding_id="j", title="Fine",
                             severity="major", context_error={"code": 5}),
        "c.json": triage_row(canonical="e", finding_id="k", title="Op", failure_class="exhausted"),
        "d.json": triage_row(canonical="f", finding_id="l", title="Un", failure_class=7),
    }))
    cases.append(case("missing-class-is-unknown", {
        "a.json": triage_row(),
    }))
    cases.append(case("empty-mapped-falls-back", {
        "a.json": triage_row(mapped_path="", target_current=""),
    }))
    cases.append(case("corrupt-rows", {
        "invalid.json": "broken",
        "list.json": "[]",
        "missing.json": "{}",
        "status.json": '{"status": []}',
        "floaty.json": '{"status": "needs-human", "target": "t", "canonical_id": "c", '
                       '"finding": {"id": "i", "title": "x", "severity": "s"}, "v": 1.5}',
    }))
    cases.append(case("bound-at-32-and-omitted", {
        **{f"{n:02}.json": triage_row(canonical=str(n), finding_id=str(n))
           for n in range(35)},
        "broken.json": "broken",
        "empty.json": "{}",
    }))
    return _family("triage", cases, "backfill_report.finding_triage(strict=False, limit=32) over real rows")


# ------------------------------------------------------------ publish-full


def publish_full_family() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []

    def publish_case(name: str, *, queue: Dict[str, Any], config: Dict[str, Any],
                     schedule: Dict[str, Any], previous: Optional[str],
                     systemd_output: Optional[str], gh: Optional[Callable[[str], str]],
                     events: str = "", triage_rows: Optional[Dict[str, Any]] = None,
                     inbox: Optional[Dict[str, str]] = None,
                     result_files: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        tmp = _state_tree()
        try:
            root = Path(tmp.name)
            (root / "state").mkdir()
            (root / "state/events.jsonl").write_text(events)
            if triage_rows:
                triage = root / "state/backfill/findings/triage"
                triage.mkdir(parents=True)
                for file_name, row in triage_rows.items():
                    (triage / file_name).write_text(
                        row if isinstance(row, str) else json.dumps(row)
                    )
            for stem, mtime in (inbox or {}).items():
                path = root / "state/repair/inbox" / f"{stem}.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(inbox and inbox.get(stem) or "{}")
                os.utime(path, (mtime, mtime))
            for relative, text in (result_files or {}).items():
                _write(root, relative, text)
            xdg = root / "xdg"
            (xdg / "crq").mkdir(parents=True)
            if previous is not None:
                (xdg / "crq/summary.json").write_text(previous)
            if systemd_output is not None:
                systemd_output = systemd_output.replace("%MONO%", "")

            def run() -> Dict[str, Any]:
                env = {"XDG_STATE_HOME": str(xdg)}
                with unittest.mock.patch.dict(os.environ, env):
                    if systemd_output is None:
                        probe = unittest.mock.patch.object(
                            status_summary, "command",
                            side_effect=_gh_or_fail(gh),
                        )
                    else:
                        probe = unittest.mock.patch.object(
                            status_summary, "command",
                            side_effect=_gh_or_fail(gh),
                        )
                    with probe:
                        return status_summary.publish(
                            root, queue, config, schedule, home=root, now=FIXED_NOW
                        )

            result = _call(
                "status_summary.publish",
                {"queue": queue, "config": config, "schedule": schedule,
                 "previous": previous, "systemd": "patched-empty" if systemd_output is None else systemd_output},
                run,
                bytes_key="bytes",
            )
            result["name"] = name
            return result
        finally:
            tmp.cleanup()

    def _gh_or_fail(gh: Optional[Callable[[str], str]]):
        def command(argv: List[str], timeout: int) -> str:
            if argv[:1] == ["systemctl"]:
                raise RuntimeError("systemctl unavailable")
            if argv[:1] == ["gh"]:
                if gh is None:
                    raise OSError("no gh")
                return gh(argv[2])
            raise AssertionError(f"unmocked probe: {argv}")

        return command

    base_queue = {
        "last_tick": "2026-11-09T11:55:00Z",
        "items": [
            {"id": "open", "kind": "open", "state": "pending", "repo": "owner/repo",
             "pr": 7, "order": 1},
            {"id": "nocache", "kind": "open", "state": "pending", "repo": "owner/repo",
             "pr": 9, "order": 2},
            {"id": "badpr", "kind": "open", "state": "pending", "repo": "owner/repo",
             "pr": -1, "order": 3},
        ],
        "starts": ["2026-11-09T11:00:00Z", "2026-11-09T11:10:00Z"],
    }
    base_config = {"repo": "owner/repo", "max_starts_per_hour": 8, "schedule_id": "tick"}
    triage = {
        "a.json": triage_row(failure_class="owner-decision"),
        "b.json": triage_row(status="delivered", canonical="d", finding_id="j",
                             title="Fine", severity="major", context_error={"code": 5}),
    }

    cases.append(publish_case(
        "full-publish-no-cache-no-gh",
        queue=base_queue, config=base_config, schedule={"status": "unknown"},
        previous=None, systemd_output=None, gh=None, triage_rows=triage,
    ))
    cases.append(publish_case(
        "title-cache-and-gh-lookup",
        queue=base_queue, config=base_config, schedule={"status": "active"},
        previous=json.dumps({"pending_items": [
            {"repo": "owner/repo", "pr": 7, "title": "cached title"},
            {"repo": "owner/repo", "pr": 9, "title": None},
        ]}),
        systemd_output=None,
        gh=lambda repo: "  Fresh Title  \n" if repo.endswith("/9") else "",
        triage_rows=triage,
    ))
    cases.append(publish_case(
        "corrupt-previous-summary-voids-cache",
        queue=base_queue, config=base_config, schedule={"status": "active"},
        previous="{broken",
        systemd_output=None, gh=None, triage_rows=triage,
    ))
    cases.append(publish_case(
        "previous-row-missing-repo-voids-cache",
        queue=base_queue, config=base_config, schedule={"status": "active"},
        previous=json.dumps({"pending_items": [
            {"repo": "owner/repo", "pr": 7, "title": "first"},
            {"title": "missing both"},
        ]}),
        systemd_output=None, gh=None, triage_rows=triage,
    ))
    cases.append(publish_case(
        "empty-triage-and-empty-queue",
        queue={"last_tick": "2026-11-09T11:55:00Z", "items": [], "starts": []},
        config={"repo": "owner/repo", "max_starts_per_hour": 8},
        schedule={}, previous=None, systemd_output=None, gh=None,
    ))
    cases.append(publish_case(
        "no-completed-tick-refused",
        queue={"last_tick": None, "items": [], "starts": []},
        config=base_config, schedule={}, previous=None, systemd_output=None, gh=None,
    ))
    return _family("publish-full", cases, "status_summary.publish over a real temp state tree")


def documents() -> Dict[str, Any]:
    return {
        "systemd": systemd_family(),
        "repair-digest": repair_digest_family(),
        "triage": triage_family(),
        "publish-full": publish_full_family(),
    }


def _encode(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=True) + "\n"


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate fixtures")
    group.add_argument("--check", action="store_true", help="fail when stale")
    group.add_argument("--stdout", action="store_true", help="print every document")
    args = parser.parse_args(argv)
    docs = documents()
    status = 0
    for family, document in docs.items():
        text = _encode(document)
        path = HERE / f"{family}.json"
        if args.stdout:
            sys.stdout.write(text)
        elif args.write:
            path.write_text(text)
        elif not path.exists() or path.read_text() != text:
            print(f"stale fixture: {path}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
