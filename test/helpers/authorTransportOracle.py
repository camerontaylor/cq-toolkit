"""Differential oracle for author-v1: run apps/crq-python's `author_transport.handle`.

Test tooling only. Usage: python3 -I authorTransportOracle.py <apps/crq-python dir>
Reads {"queue", "policy_path", "reviewer", "approved_target", "frames": [str], "times": [iso]}
on stdin and writes {"responses": [{"ok": true, "b64": ...} | {"ok": false, "error": ...}],
"queue": <final queue>}. The runner mirrors `crq.enroll_author` and `crq.author_lease_command`
over an in-memory queue with a clock that returns times[i] for frame i, so no crq module
(and its config.json) is imported. Snapshot installs are not exercised.
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import author_lease  # noqa: E402
import author_quota  # noqa: E402
import author_transport  # noqa: E402


def main():
    case = json.load(sys.stdin)
    state = {"queue": case["queue"], "at": case["times"][0]}

    class Runner:
        def with_lock(self, fn):
            return fn()

        def load_queue(self):
            return json.loads(json.dumps(state["queue"]))

        def iso(self):
            return state["at"]

        def enroll_author(self, request_id, base, head, target, cycle,
                          review_policy=None, fallback_reviewer=None):
            q = self.load_queue()
            try:
                if bool(review_policy) != bool(fallback_reviewer):
                    raise author_quota.AuthorRefused("both required")
                lease = (author_lease.new_lease(json.loads(Path(review_policy).read_text()),
                                                fallback_reviewer, at=self.iso())
                         if review_policy else None)
                res = author_quota.enroll(q, request_id=request_id, base=base, head=head,
                                          target=target, cycle=cycle, at=self.iso())
                if lease is not None:
                    if res["created"]:
                        res["item"]["author_lease"] = lease
                    else:
                        old = author_lease.read(res["item"])
                        if old is None or any(old[k] != lease[k]
                                              for k in ("reviewerTimeoutMin", "reviewer")):
                            raise author_quota.AuthorRefused(
                                "cannot replace an existing request's lease policy")
            except author_quota.AuthorRefused as exc:
                raise SystemExit(f"author-enroll refused: {exc}")
            state["queue"] = q

        def author_lease_command(self, request_id, claim_fallback):
            q = self.load_queue()
            if claim_fallback:
                result = author_lease.fallback(q, request_id, at=self.iso())
                state["queue"] = q
            else:
                result = author_lease.decision(author_lease.find(q, request_id))
            return result

    responses = []
    runner = Runner()
    for index, frame in enumerate(case["frames"]):
        state["at"] = case["times"][index]
        try:
            out = author_transport.handle(
                frame.encode(), runner, policy_path=case["policy_path"],
                reviewer=case["reviewer"], approved_target=case["approved_target"])
            responses.append({"ok": True, "b64": base64.b64encode(out).decode()})
        except BaseException as exc:  # SystemExit from enroll is a refusal too
            responses.append({"ok": False, "error": type(exc).__name__})
    print(json.dumps({"responses": responses, "queue": state["queue"]}))


main()
