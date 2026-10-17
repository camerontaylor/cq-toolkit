"""Version-1 worker admission transport; never starts a reviewer or uses the spool.

The operator binds this endpoint to a separate SSH forced-command key. P3 must
be installed before admission is enabled. All request operations delegate under
the runner's existing tick.lock; a lost response is never fallback permission.
"""
import contextlib
import io
import json
import os
import signal
import sys

from author_quota import AuthorRefused, binding_of, normalize_binding

MAX_BYTES = 8192


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AuthorRefused("duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise AuthorRefused("request exceeds transport bound")
    try:
        req = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
    except (ValueError, UnicodeError) as exc:
        raise AuthorRefused("invalid JSON request") from exc
    if not isinstance(req, dict) or set(req) != {"v", "op", "binding"}:
        raise AuthorRefused("unknown request fields")
    if type(req["v"]) is not int or req["v"] != 1:
        raise AuthorRefused("unsupported transport version")
    if req["op"] not in ("enroll", "status", "fallback"):
        raise AuthorRefused("unsupported operation")
    b = req["binding"]
    if not isinstance(b, dict) or set(b) != {"request_id", "base", "head", "target", "cycle"}:
        raise AuthorRefused("invalid binding fields")
    if any(isinstance(v, str) and any(ord(c) <= 32 for c in v) for v in b.values()):
        raise AuthorRefused("binding contains whitespace or controls")
    return {**req, "binding": normalize_binding(**b)}


def handle(raw, runner, *, policy_path, reviewer):
    request = decode(raw)
    # No silent downgrade to an unleased legacy enrollment on pre-P3 runners.
    if not callable(getattr(runner, "author_lease_command", None)):
        raise AuthorRefused("P3 lease support is required")
    if not policy_path or not reviewer:
        raise AuthorRefused("operator review policy and fallback reviewer required")
    binding = request["binding"]

    def locked():
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
    try:
        signal.alarm(30)
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        import crq  # Only after the forced-command guard; never imports signer.
        result = handle(raw, crq, policy_path=os.environ.get("CRQ_AUTHOR_REVIEW_POLICY"),
                        reviewer=os.environ.get("CRQ_AUTHOR_FALLBACK_REVIEWER"))
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
