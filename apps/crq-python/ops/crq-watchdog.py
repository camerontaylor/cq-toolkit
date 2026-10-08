#!/usr/bin/python3
"""crq outage watchdog: agent-free, run by launchd every 10 min.

Paseo schedule runs can report 'succeeded' while every tick failed
(2026-10-07: 101 OAuth failures, then a cleanup wedge, ~25 h down). So
liveness is judged only from the heartbeat each completed tick writes. This
script lives under ~/Library/Application Support/crq/ and reads only files
there: macOS TCC denies launchd-started python access to the external volume
the crq repo is on. Alerts once per outage (Paseo message to the chancellor
plus a best-effort macOS notification). Installed by hand from the crq repo's
ops/ directory; see README "Watchdog". Python 3.9, stdlib only."""
import datetime as dt
import json
import subprocess
from pathlib import Path

HOME = Path.home() / "Library" / "Application Support" / "crq"
HB, ST = HOME / "heartbeat.json", HOME / "watchdog-state.json"


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def parse(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def sh(cmd, timeout=60):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - a watchdog must not crash
        return subprocess.CompletedProcess(cmd, 99, "", str(exc))


def main():
    hb = json.loads(HB.read_text())
    st = json.loads(ST.read_text()) if ST.exists() else {}
    last, limit = hb["last_tick"], hb.get("stale_alarm_min", 36)
    gap = (utcnow() - parse(last)).total_seconds() / 60
    if gap <= limit:
        if st.get("alerted_for"):
            ST.write_text(json.dumps({"recovered_seen_at": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                                      "last_outage": st["alerted_for"]}) + "\n")
        print(f"{utcnow():%FT%TZ} ok: last tick {last} ({gap:.0f}m ago)")
        return
    if st.get("alerted_for") == last:
        print(f"{utcnow():%FT%TZ} stale {gap:.0f}m; already alerted")
        return
    sched = ""
    p = sh(["paseo", "schedule", "inspect", hb["schedule_id"], "--json"])
    if p.returncode == 0:
        d = json.loads(p.stdout)
        r = (d.get("runs") or [{}])[-1]
        sched = (f" Schedule {hb['schedule_id']} is {d.get('status')}; last run {r.get('scheduledFor')} "
                 f"{r.get('status')}: {str(r.get('output') or r.get('error') or '')[:200]!r}.")
    text = (f"crq STALLED: no completed tick for {gap:.0f}m (last {last}, alarm at {limit}m).{sched} "
            f"Diagnose: cd {hb['root']} && python3 crq.py tick --dry-run")
    sent = sh(["paseo", "send", "--no-wait", hb["alert_agent_id"], text], timeout=90)
    sh(["osascript", "-e", f"display notification {json.dumps(text[:220])} with title \"crq STALLED\" sound name \"Basso\""])
    ST.write_text(json.dumps({"alerted_for": last, "alerted_at": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                              "gap_min": round(gap), "paseo_send": sent.returncode,
                              "paseo_err": sent.stderr.strip()[:200]}) + "\n")
    print(f"{utcnow():%FT%TZ} ALERTED stale {gap:.0f}m (paseo send exit {sent.returncode})")


if __name__ == "__main__":
    main()
