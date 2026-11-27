"""Differential oracle for `review_ledger.GitLedger.fetch` (and the `read` it
drives) against throwaway local repositories.

Test tooling only. Usage: python3.14 -I ledgerGitFetchOracle.py <apps/crq-python dir>
Reads one case on stdin: {"clone": dir, "advance": [sha, ...]}. Before each
checkpoint compare-and-swap (`update-ref refs/crq/review-ledger-validated`),
the next sha of `advance` is pushed to the remote branch and written to the
checkpoint, simulating a concurrent validator that moves ahead mid-fetch.
Writes {"result": {"ok": {"head": sha, "records": n}} | {"error": cls,
"message": str}, "checkpoint": sha, "log": [[...]]}. The log holds the
fetch, rev-list, cat-file and checkpoint update-ref calls with the stdin line
count, so the TS adapter's plumbing sequence can be compared call for call.
"""
import json
import re
import subprocess
import sys

sys.path.insert(0, sys.argv[1])
import review_ledger  # noqa: E402

CHECKPOINT = "refs/crq/review-ledger-validated"
FETCH_REF = re.compile(r"refs/crq/ledger-fetch/[0-9a-f]+")


def main():
    case = json.load(sys.stdin)
    clone = case["clone"]
    advance = list(case["advance"])
    log = []
    original = review_ledger.GitLedger.git

    def spy(self, *args, **kwargs):
        args = tuple(args)
        if args[:2] == ("update-ref", CHECKPOINT) and advance:
            sha = advance.pop(0)
            subprocess.run(["git", "push", "-q", "origin", sha + ":refs/heads/cq/review-ledger"],
                           cwd=clone, check=True, capture_output=True)
            subprocess.run(["git", "update-ref", CHECKPOINT, sha], cwd=clone, check=True)
        if args[0] in ("fetch", "rev-list", "cat-file") or args[:2] == ("update-ref", CHECKPOINT):
            data = kwargs.get("input")
            lines = None if data is None else data.count(b"\n")
            log.append([FETCH_REF.sub("<ref>", " ".join(args)), lines])
        return original(self, *args, **kwargs)

    review_ledger.GitLedger.git = spy
    ledger = review_ledger.GitLedger(clone)
    try:
        head, values = ledger.fetch()
        result = {"ok": {"head": head, "records": len(values)}}
    except Exception as exc:  # the class name and message are the contract
        result = {"error": type(exc).__name__, "message": str(exc)}
    checkpoint = subprocess.run(["git", "rev-parse", "--verify", "--quiet", CHECKPOINT],
                                cwd=clone, capture_output=True, text=True).stdout.strip()
    json.dump({"result": result, "checkpoint": checkpoint, "log": log}, sys.stdout)


main()
