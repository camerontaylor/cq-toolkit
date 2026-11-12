#!/usr/bin/env python3
"""Harmless Python fixture for the isolated unit-switch proof vehicle.

Invoked by a systemd oneshot unit installed under ``crq-tick.service`` in a
disposable guest. It performs no CRQ work: it appends one runtime-bound
completion record under an exclusive lock and exits. The controller's proof
adapter consumes those records as fake (fixture-only) completion evidence.
"""
import argparse
import datetime
import fcntl
import json
import os
import pathlib
import re
import sys
import time

RUNTIME = re.compile(r"python|node:[0-9a-f]{40}\Z")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--unit", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--completions", required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    if args.runtime != "python":
        raise SystemExit("python fixture requires the python runtime marker")
    if not RUNTIME.fullmatch(args.runtime):
        raise SystemExit("invalid runtime marker")
    invocation = os.environ.get("INVOCATION_ID", "")
    if not re.fullmatch(r"[0-9a-f]{32}", invocation):
        raise SystemExit("systemd did not provide an invocation id")
    completions = args.completions
    completions.parent.mkdir(parents=True, exist_ok=True)
    lock_path = completions.with_name(completions.name + ".lock")
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            records = []
            if completions.exists():
                for line in completions.read_text().splitlines():
                    if line.strip():
                        records.append(json.loads(line))
            sequence = max((item.get("sequence", 0) for item in records), default=0) + 1
            record = {
                "unit": args.unit,
                "runtime": args.runtime,
                "success": True,
                "sequence": sequence,
                "invocation": invocation,
                "at": datetime.datetime.now(datetime.timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"),
                "boot_id": pathlib.Path(
                    "/proc/sys/kernel/random/boot_id").read_text().strip(),
            }
            with completions.open("a") as out:
                out.write(json.dumps(record, sort_keys=True) + "\n")
                out.flush()
                os.fsync(out.fileno())
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    time.sleep(0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
