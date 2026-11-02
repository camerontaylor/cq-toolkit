"""Synthetic-only reproducible benchmark; pass a scratch directory and mode.

Run generate, before, compact, after in separate processes for isolated peak RSS.
"""
import json
from pathlib import Path
import resource
import sys
import time

import admission_history
from crq_repair import atomic


def main():
    directory, mode = Path(sys.argv[1]), sys.argv[2]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "queue.json"
    started = time.monotonic()
    if mode == "generate":
        holds = {f"attempt-{i}": {"item": f"job-{i}", "at": "2026-11-02T00:00:00Z",
                 "quota_state": "released", "vendor_run_id": f"run-{i}"} for i in range(3000)}
        row = json.dumps({"at": "2026-11-02T00:00:00Z", "item": "job", "ordinary_eligible": False,
                          "observation": {"successful": True, "remaining": 1, "observed_at": "2026-11-02T00:00:00Z",
                                          "reflected_reservations": list(holds)},
                          "reservations": holds, "effective_remaining": 1, "decision": "one-slot-reserve"})
        # 150 MiB of ordinary queue payload; history brings total to ~750 MiB.
        item = json.dumps({"id": "ordinary", "kind": "open", "state": "done", "notes": ["x" * 15000]})
        with path.open("w") as out:
            out.write('{"items":[')
            for i in range(10400):
                out.write(("," if i else "") + item)
            out.write('],"backfill_reservations":' + json.dumps(holds) + ',"backfill_admissions":[')
            for i in range((600 * 1024 * 1024) // len(row)):
                out.write(("," if i else "") + row)
            out.write("]}")
    elif mode == "compact":
        before = path.stat().st_size
        q, changed = admission_history.load(path)
        loaded = time.monotonic()
        if changed:
            atomic(path, q)
        print(f"before_bytes={before} after_bytes={path.stat().st_size} parse_s={loaded-started:.3f}")
    else:
        q = (admission_history.load(path)[0] if mode == "after"
             else json.loads(path.read_text()))
        loaded = time.monotonic()
        atomic(directory / (mode + "-save.json"), q)
        print(f"load_s={loaded-started:.3f} save_s={time.monotonic()-loaded:.3f}")
    print(f"mode={mode} total_s={time.monotonic()-started:.3f} peak_rss_kib={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss} bytes={path.stat().st_size}")


if __name__ == "__main__":
    main()
