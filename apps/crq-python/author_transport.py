"""Version-1 worker admission transport; never starts a reviewer or uses the spool.

The operator binds this endpoint to a separate SSH forced-command key. P3 must
be installed before admission is enabled. All request operations delegate under
the runner's existing tick.lock; a lost response is never fallback permission.
"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import signal
import sys

import author_lease
from author_quota import AuthorRefused, binding_of, enroll, normalize_binding

MAX_BYTES = 8192
MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024
DEADLINE_S = 30


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AuthorRefused("duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_SNAPSHOT_BYTES:
        raise AuthorRefused("request exceeds transport bound")
    try:
        req = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
    except (ValueError, UnicodeError) as exc:
        raise AuthorRefused("invalid JSON request") from exc
    if not isinstance(req, dict):
        raise AuthorRefused("invalid request")
    version = req.get("v")
    fields = {"v", "op", "binding", "snapshot"} if type(version) is int and version == 2 else {"v", "op", "binding"}
    if set(req) != fields:
        raise AuthorRefused("unknown request fields")
    if type(req["v"]) is not int or req["v"] not in (1, 2):
        raise AuthorRefused("unsupported transport version")
    if req["op"] not in ("enroll", "status", "fallback"):
        raise AuthorRefused("unsupported operation")
    if req["v"] == 1 and len(raw) > MAX_BYTES:
        raise AuthorRefused("request exceeds v1 bound")
    if req["v"] == 2 and req["op"] != "enroll":
        raise AuthorRefused("snapshots are enrollment only")
    b = req["binding"]
    if not isinstance(b, dict) or set(b) != {"request_id", "base", "head", "target", "cycle"}:
        raise AuthorRefused("invalid binding fields")
    if any(isinstance(v, str) and any(ord(c) <= 32 for c in v) for v in b.values()):
        raise AuthorRefused("binding contains whitespace or controls")
    return {**req, "binding": normalize_binding(**b)}


def handle(raw, runner, *, policy_path, reviewer, approved_target):
    request = decode(raw)
    # No silent downgrade to an unleased legacy enrollment on pre-P3 runners.
    if not callable(getattr(runner, "author_lease_command", None)):
        raise AuthorRefused("P3 lease support is required")
    if not policy_path or not reviewer:
        raise AuthorRefused("operator review policy and fallback reviewer required")
    binding = request["binding"]
    if not isinstance(approved_target, str) or binding["target"] != approved_target:
        raise AuthorRefused("operator-approved author target required")

    def locked():
        # Refuse a conflicting delivery before any object/ref/state mutation.
        if request["v"] == 2:
            q = runner.load_queue()
            entry = q.get("author_requests", {}).get(binding["request_id"])
            if entry is not None and binding_of(entry) != binding_of(binding):
                raise AuthorRefused("conflicting snapshot request binding")
            # Preview P3 admission without persisting or installing objects.
            # The real enrollment still follows the durable pin, under this lock.
            lease = author_lease.new_lease(json.loads(Path(policy_path).read_text()),
                                           reviewer, at=runner.iso())
            preview = enroll(copy.deepcopy(q), **binding, at=runner.iso())
            if not preview["created"]:
                old = author_lease.read(preview["item"])
                if old is None or any(old[k] != lease[k] for k in ("reviewerTimeoutMin", "reviewer")):
                    raise AuthorRefused("cannot replace an existing request's lease policy")
            from author_snapshot import install
            install(request["snapshot"], binding, runner)
        # Check the binding before status/fallback, not just request_id.
        if request["op"] == "enroll":
            runner.enroll_author(**binding, review_policy=policy_path,
                                 fallback_reviewer=reviewer)
        q = runner.load_queue()
        entry = q.get("author_requests", {}).get(binding["request_id"])
        if not isinstance(entry, dict) or binding_of(entry) != binding_of(binding):
            raise AuthorRefused("unknown or mismatched request binding")
        return runner.author_lease_command(binding["request_id"], request["op"] == "fallback")

    # crq.with_lock emits human diagnostics on stdout on contention; never mix
    # those with wire JSON. None means no permission was produced.
    with contextlib.redirect_stdout(io.StringIO()):
        result = runner.with_lock(locked)
    if not isinstance(result, dict):
        raise AuthorRefused("queue lock busy; no permission")
    return (json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n").encode()


def main():
    if len(sys.argv) != 1 or os.environ.get("SSH_ORIGINAL_COMMAND") != "author-v1":
        print("author-transport: operation refused", file=sys.stderr)
        return 2
    def expired(signum, frame):
        # Unwind instead of dying on SIGALRM: subprocess.run and the snapshot Git helper
        # kill their children on the way out, and with_lock releases tick.lock.
        raise AuthorRefused("author transport deadline")

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.alarm(DEADLINE_S)
        raw = sys.stdin.buffer.read(MAX_SNAPSHOT_BYTES + 1)
        import crq  # Only after the forced-command guard; never imports signer.
        result = handle(raw, crq, policy_path=os.environ.get("CRQ_AUTHOR_REVIEW_POLICY"),
                        reviewer=os.environ.get("CRQ_AUTHOR_FALLBACK_REVIEWER"),
                        approved_target=os.environ.get("CRQ_AUTHOR_TARGET"))
        sys.stdout.buffer.write(result)
        return 0
    except (AuthorRefused, OSError, ValueError, SystemExit):
        # Avoid reflecting host paths or exception/config contents to workers.
        print("author-transport: request refused; no permission", file=sys.stderr)
        return 2
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
