"""Differential oracle for queue-v1: run apps/crq-python's `queue_transport.handle`.

Test tooling only. Usage: python3 -I queueTransportOracle.py <apps/crq-python dir>
Reads {"policy", "principal", "queue", "forge": {"<pr>": metadata}, "frames": [step],
"busy": bool, "runner_repo": str, "reconcile": {"after", "before", "prs", "merge"} | null} on stdin. A step is
a frame string ("$RID" is replaced by the last attached receipt id) or
{"attach_receipt": doc}, which publishes doc (its source taken from the first queue
item) and marks that item done. It writes {"responses": [{"ok": true, "b64": ...} |
{"ok": false, "error": ...}], "queue": <final queue>, "queue_text": <the bytes crq's atomic writer would store>, "receipts": {id: b64},
"wrapper": <reconcile wrapper text> | null, "wrapperKey": ...}. The runner and forge
are in-memory and the clock is fixed; no network, git or child process is used.
`runner_repo` (default: the policy repository) is the repository the runner serves; a
mismatch takes the same activation gate as capability_dispatcher.queue_main.
`busy` makes every lock and read slot unavailable (the typed `busy` answer).
"""
import base64
import copy
import json
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import merged_reconcile  # noqa: E402
import queue_transport  # noqa: E402
import review_receipt  # noqa: E402

NOW_SECONDS = 1_794_528_000
queue_transport.time.time = lambda: NOW_SECONDS


def build_wrapper(spec, state_dir):
    interval = {"after": spec["after"], "before": spec["before"]}
    checkpoint = merged_reconcile.reconcile(None, lambda cursor: {
        "records": [{"number": pr, "mergedAt": "2026-11-12T00:00:00Z",
                     "mergeCommit": {"oid": spec["merge"]}, "headRefOid": "b" * 40}
                    for pr in spec["prs"]],
        "has_next_page": False, "next_cursor": None},
        repo="owner/repo", base=queue_transport.DISCOVERY_SELECTOR, **interval, page_budget=1)
    key = review_receipt.digest(
        {"repo": "owner/repo", "base": queue_transport.DISCOVERY_SELECTOR, **interval})
    source = {"version": 1, "method": "all-number-slots-v1", "repo": "owner/repo",
              "base": queue_transport.DISCOVERY_SELECTOR, "repository_id": "synthetic-repository",
              "ceiling": 512, "window": merged_reconcile.NUMBER_WINDOW}
    wrapper = {"source": source, "checkpoint": checkpoint}
    wrapper["digest"] = review_receipt.digest(wrapper)
    text = json.dumps(wrapper)
    path = Path(state_dir) / "reconcile" / (key + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return key, text, interval


def gated(raw, runner, case, verify, receipts):
    """capability_dispatcher.queue_main's gates, then the transport."""
    policy = case["policy"]
    principal = case["principal"]
    compatible = case.get("runner_repo", policy.get("repo")) == policy.get("repo")
    op = queue_transport.decode(raw)["op"]
    if op == "retry-capability":
        if policy.get("enabled") is True and not compatible:
            policy = {**policy, "enabled": False}
        return queue_transport.handle(raw, None, principal=principal, policy=policy,
                                      verify_source=None, receipt_root=None)
    queue_transport.authorize(queue_transport.decode(raw), principal, policy)
    if policy.get("enabled") is not True or not compatible:
        return queue_transport.handle(raw, None, principal=principal,
                                      policy={**policy, "enabled": False},
                                      verify_source=None, receipt_root=None)
    return queue_transport.handle(raw, runner, principal=principal, policy=policy,
                                  verify_source=verify, receipt_root=receipts)


def main():
    case = json.load(sys.stdin)
    state = {"queue": case["queue"]}
    busy = case.get("busy", False)
    published = {}
    wrapper_out = {"text": None, "key": None}

    class Runner:
        def load_queue(self):
            return copy.deepcopy(state["queue"])

        def save_queue(self, queue):
            state["queue"] = copy.deepcopy(queue)

        def iso(self):
            return "2026-11-13T00:00:00Z"

        def with_lock(self, fn):
            return None if busy else fn()

    def verify(repo, pr):
        return case["forge"][str(pr)]

    @contextmanager
    def read_slot(root):
        yield not busy

    queue_transport._read_slot = read_slot
    responses = []
    last = {"rid": None}
    with tempfile.TemporaryDirectory() as receipts:
        runner = Runner()
        if case.get("reconcile"):
            key, text, interval = build_wrapper(case["reconcile"], receipts)
            wrapper_out.update(text=text, key=key)
            runner.STATE = Path(receipts)
            import crq

            def read_wrapper(path, interval, budget):
                crq.REPO = "owner/repo"
                return crq._read_reconcile_wrapper(path, interval, budget)

            runner._read_reconcile_wrapper = read_wrapper
        for step in case["frames"]:
            if isinstance(step, dict):
                item = state["queue"]["items"][0]
                doc = {**step["attach_receipt"], "source": item["subject"]}
                rid = review_receipt.write_receipt(receipts, doc)
                item.update(state="done", receipt_id=rid)
                published[rid] = base64.b64encode(
                    (Path(receipts) / (rid + ".json")).read_bytes()).decode()
                last["rid"] = rid
                continue
            frame = step.replace("$RID", last["rid"] or "")
            try:
                out = gated(frame.encode(), runner, case, verify, receipts)
                responses.append({"ok": True, "b64": base64.b64encode(out).decode()})
            except Exception as exc:  # the capability maps every raise to one refusal
                responses.append({"ok": False, "error": type(exc).__name__})
    queue_text = json.dumps(state["queue"], indent=2) + "\n"
    print(json.dumps({"responses": responses, "queue": state["queue"], "queue_text": queue_text,
                      "receipts": published,
                      "wrapper": wrapper_out["text"], "wrapperKey": wrapper_out["key"]}))


main()
