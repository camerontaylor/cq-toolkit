"""Differential oracle for review-v1: run apps/crq-python's `review_transport`.

Test tooling only. Usage: python3 -I reviewTransportOracle.py <apps/crq-python dir>
Reads {"config", "policy", "principal", "queue", "frames": [str], "clone"} on stdin and
writes {"responses": [{"ok": true, "b64": ...} | {"ok": false, "error": ...}], "queue":
<final queue>}. It mirrors `review_transport.main`: a frame that fails to decode is the
`invalid-input` document and every other frame goes through `safe_handle`. The runner is
in-memory with a fixed clock; the clone is only read (no fetch, no network).
"""
import base64
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import review_transport  # noqa: E402


def main():
    case = json.load(sys.stdin)
    state = {"queue": case["queue"]}
    config = case["config"]

    class Runner:
        REPO = config["repo"]
        CLONE = case["clone"]
        REPOS = config.get("repos", [])
        CONFIG = config
        UNIVERSAL_SCAN_CLASSES = set()
        STATE = None

        def load_queue(self):
            return state["queue"]

        def save_queue(self, queue):
            state["queue"] = queue

        def iso(self):
            return "2026-11-13T00:00:00Z"

        def fetch(self, **_kwargs):
            raise RuntimeError("the differential corpus never fetches")

    responses = []
    with tempfile.TemporaryDirectory() as root:
        runner = Runner()
        runner.STATE = Path(root)
        for frame in case["frames"]:
            raw = frame.encode()
            try:
                try:
                    review_transport.decode(raw)
                except ValueError as exc:
                    out = review_transport.error("invalid-input", str(exc))
                else:
                    out = review_transport.safe_handle(
                        raw, runner, principal=case["principal"], policy=case["policy"])
                responses.append({"ok": True, "b64": base64.b64encode(out).decode()})
            except Exception as exc:  # anything safe_handle does not type is a refusal
                responses.append({"ok": False, "error": type(exc).__name__})
    print(json.dumps({"responses": responses, "queue": state["queue"]}))


main()
