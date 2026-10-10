#!/usr/bin/python3
"""Model-free CRQ heartbeat watchdog; shared XDG state, once per outage alert."""
import datetime as dt
import json
import os
import subprocess
from pathlib import Path

HOME = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "crq"
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
    sched = " systemd crq-tick.timer."
    text = (f"crq STALLED: no completed tick for {gap:.0f}m (last {last}, alarm at {limit}m).{sched} "
            "Inspect heartbeat and systemctl --user status crq-tick.timer; do not run tests or model probes.")
    host = hb.get("alert_agent_host")
    sent = sh(["paseo", "send", "--no-wait", *(["--host", host] if host else []), hb["alert_agent_id"], text], timeout=90)
    # Only a delivered alert closes this outage; a failed send retries on the next timer run.
    key = "alerted_for" if sent.returncode == 0 else "failed_attempt_for"
    ST.write_text(json.dumps({key: last, "attempted_at": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                              "gap_min": round(gap), "paseo_send": sent.returncode,
                              "paseo_err": sent.stderr.strip()[:200]}) + "\n")
    print(f"{utcnow():%FT%TZ} {'ALERTED' if sent.returncode == 0 else 'ALERT FAILED'} stale {gap:.0f}m "
          f"(paseo send exit {sent.returncode})")


if __name__ == "__main__":
    main()
