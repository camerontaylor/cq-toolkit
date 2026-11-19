"""Differential oracle for queue-v1: run apps/crq-python's `queue_transport.handle`.

Test tooling only. Usage: python3 -I queueTransportOracle.py <apps/crq-python dir>
Reads {"policy", "principal", "queue", "forge": {"<pr>": metadata}, "frames": [str]}
on stdin and writes {"responses": [{"ok": true, "b64": ...} | {"ok": false,
"error": ...}], "queue": <final queue>}. The runner and forge are in-memory and
the clock is fixed; no network, git or child process is used.
"""
import base64
import copy
import json
import sys
import tempfile

sys.path.insert(0, sys.argv[1])
import queue_transport  # noqa: E402

NOW_SECONDS = 1_794_528_000
queue_transport.time.time = lambda: NOW_SECONDS


def main():
    case = json.load(sys.stdin)
    state = {"queue": case["queue"]}

    class Runner:
        def load_queue(self):
            return copy.deepcopy(state["queue"])

        def save_queue(self, queue):
            state["queue"] = copy.deepcopy(queue)

        def iso(self):
            return "2026-11-13T00:00:00Z"

        def with_lock(self, fn):
            return fn()

    def verify(repo, pr):
        return case["forge"][str(pr)]

    responses = []
    with tempfile.TemporaryDirectory() as receipts:
        for frame in case["frames"]:
            try:
                out = queue_transport.handle(
                    frame.encode(), Runner(), principal=case["principal"],
                    policy=case["policy"], verify_source=verify, receipt_root=receipts)
                responses.append({"ok": True, "b64": base64.b64encode(out).decode()})
            except Exception as exc:  # the capability maps every raise to one refusal
                responses.append({"ok": False, "error": type(exc).__name__})
    print(json.dumps({"responses": responses, "queue": state["queue"]}))


main()
