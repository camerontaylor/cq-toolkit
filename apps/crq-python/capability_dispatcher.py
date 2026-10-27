"""Source-only forced-command router; installation/activation is a D1C operation.

Operator-controlled environment identifies caller and policy. SSH request text
selects only an exact allowlisted capability, never a command or filesystem path.
"""
import json
import os
from pathlib import Path
import signal
import sys


def dispatch(command, author, queue):
    if command == "author-v1":
        return author()
    if command == "queue-v1":
        return queue()
    raise ValueError("unsupported forced command")


def queue_main():
    import queue_transport
    # Reuse existing process-group deadline/lock supervision; author protocol unchanged.
    from author_transport import supervised

    def expired(signum, frame):
        raise ValueError("queue deadline")

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.alarm(30)
        raw = sys.stdin.buffer.read(queue_transport.MAX_BYTES + 1)
        queue_transport.decode(raw)
        policy = json.loads(Path(os.environ["CRQ_QUEUE_POLICY"]).read_text())
        principal = os.environ["CRQ_QUEUE_PRINCIPAL"]
        if not policy.get("enabled", False):
            sys.stdout.buffer.write(queue_transport.handle(raw, None, principal=principal,
                policy=policy, verify_source=None, receipt_root=None))
            return 0
        import crq
        if not hasattr(crq, "enqueue_merged") or crq.REPO != policy.get("repo"):
            sys.stdout.buffer.write(queue_transport.handle(raw, None, principal=principal,
                policy={**policy, "enabled": False}, verify_source=None, receipt_root=None))
            return 0

        def verify(repo, pr):
            source = crq.gh_json(["api", f"repos/{repo}/pulls/{pr}"])
            return {"repo": source["base"]["repo"]["full_name"], "pr": source["number"],
                    "producer": source["user"]["login"], "head": source["head"]["sha"],
                    "target": source["base"]["ref"], "mergeSha": source.get("merge_commit_sha"),
                    "state": "MERGED" if source.get("merged") else source["state"].upper()}

        result = supervised(lambda runner: queue_transport.handle(
            raw, runner, principal=principal, policy=policy, verify_source=verify,
            receipt_root=crq.STATE / "receipts"), crq)
        if not isinstance(result, bytes):
            raise ValueError("queue lock busy")
        sys.stdout.buffer.write(result)
        return 0
    finally:
        signal.alarm(0)


def main():
    if len(sys.argv) != 1:
        return 2
    try:
        def author():
            from author_transport import main as author_main
            return author_main()
        return dispatch(os.environ.get("SSH_ORIGINAL_COMMAND"), author, queue_main)
    except (Exception, SystemExit):
        print("queue capability refused; no permission", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
