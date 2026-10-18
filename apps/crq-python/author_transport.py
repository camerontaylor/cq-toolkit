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
import time

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


class _LockHeld:
    """The runner as the supervised child sees it: the parent already holds tick.lock."""

    def __init__(self, runner):
        self._runner = runner

    def __getattr__(self, name):
        return getattr(self._runner, name)

    def with_lock(self, fn, *a, **kw):
        return fn(*a, **kw)


def _reap(pid, grace):
    """Let the child exit within `grace` seconds, then SIGKILL whatever remains of its process
    group, reap the child and wait for the group to empty."""
    signal.alarm(0)
    status, end = None, time.monotonic() + grace
    while status is None and time.monotonic() < end:
        done, waited = os.waitpid(pid, os.WNOHANG)
        if done:
            status = waited
        else:
            time.sleep(0.005)
    # An exited child's ID stays reserved while any group member lives, so this cannot miss.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(pid, signal.SIGKILL)
    if status is None:
        _, status = os.waitpid(pid, 0)
    # Orphaned members are reaped by init; a zombie still counts, so the wait is bounded.
    end = time.monotonic() + 2
    while time.monotonic() < end:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    return os.waitstatus_to_exitcode(status)


def supervised(work, runner):
    """Run work(runner) in a child that leads its own process group, under tick.lock held here.

    Every exit (response, error or the deadline raising in this parent) SIGKILLs and reaps the
    whole group before the lock is released, so no scan or Git descendant outlives the lock.
    None means the lock was busy.
    """
    def locked():
        r, w = os.pipe()
        # The deadline must not land between fork and supervision: hold SIGALRM until the
        # parent is inside the try below (a pending alarm then fires there).
        alarm = {signal.SIGALRM}
        signal.pthread_sigmask(signal.SIG_BLOCK, alarm)
        try:
            pid = os.fork()
        except BaseException:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, alarm)
            raise
        if pid == 0:
            # Never unwind into the parent's frames: with_lock's finally would unlock the
            # lock file description shared with the parent.
            code = 2
            try:
                signal.pthread_sigmask(signal.SIG_UNBLOCK, alarm)
                os.close(r)
                os.setpgid(0, 0)
                out = work(_LockHeld(runner))
                with os.fdopen(w, "wb") as pipe:
                    pipe.write(out)
                code = 0
            finally:
                os._exit(code)
        answered = False
        try:
            os.close(w)
            with contextlib.suppress(OSError):
                os.setpgid(pid, pid)  # also set here, so the group kill can never miss
            signal.pthread_sigmask(signal.SIG_UNBLOCK, alarm)
            with os.fdopen(r, "rb") as pipe:
                out = pipe.read(MAX_BYTES + 1)
            answered = len(out) <= MAX_BYTES
        finally:
            # A complete response gets a moment to exit cleanly; a deadline or error kills now.
            code = _reap(pid, 1 if answered else 0)
        if code != 0 or len(out) > MAX_BYTES:
            raise AuthorRefused("request refused; no permission")
        return out

    # crq.with_lock emits human diagnostics on stdout on contention; never mix them with wire JSON.
    with contextlib.redirect_stdout(io.StringIO()):
        return runner.with_lock(locked)


def main():
    if len(sys.argv) != 1 or os.environ.get("SSH_ORIGINAL_COMMAND") != "author-v1":
        print("author-transport: operation refused", file=sys.stderr)
        return 2

    def expired(signum, frame):
        # Unwind instead of dying on SIGALRM, so supervised() kills the request's process
        # group before with_lock releases tick.lock.
        raise AuthorRefused("author transport deadline")

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.alarm(DEADLINE_S)
        raw = sys.stdin.buffer.read(MAX_SNAPSHOT_BYTES + 1)
        import crq  # Only after the forced-command guard; never imports signer.
        result = supervised(
            lambda runner: handle(raw, runner, policy_path=os.environ.get("CRQ_AUTHOR_REVIEW_POLICY"),
                                  reviewer=os.environ.get("CRQ_AUTHOR_FALLBACK_REVIEWER"),
                                  approved_target=os.environ.get("CRQ_AUTHOR_TARGET")), crq)
        if not isinstance(result, bytes):
            raise AuthorRefused("queue lock busy; no permission")
        sys.stdout.buffer.write(result)
        return 0
    except (Exception, SystemExit):
        # Avoid reflecting host paths or exception/config contents to workers:
        # any failure (e.g. a missing scan policy raising RuntimeError) is one refusal.
        print("author-transport: request refused; no permission", file=sys.stderr)
        return 2
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
