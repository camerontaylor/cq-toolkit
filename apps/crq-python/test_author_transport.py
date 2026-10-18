"""Offline wire/lock tests. Never touches live state or starts any reviewer."""
import copy
import fcntl
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import author_quota
import author_transport as transport
import crq

BINDING = dict(request_id="worker-1", base="a" * 40, head="b" * 40,
               target="origin/merge-queue", cycle=1)


def request(op="enroll", **changes):
    return json.dumps(dict(v=1, op=op, binding={**BINDING, **changes})).encode()


class Backend:
    """P3 call-contract fixture; admission itself uses the real quota policy."""
    def __init__(self):
        self.q = {"items": [], "starts": []}
        self.locked = False
        self.claims = []

    def with_lock(self, fn):
        self.locked = True
        try:
            return fn()
        finally:
            self.locked = False

    def enroll_author(self, *, review_policy, fallback_reviewer, **binding):
        assert self.locked
        self.claims.append((review_policy, fallback_reviewer))
        author_quota.enroll(self.q, **binding, at="2026-10-17T00:00:00Z")
        print("human enrollment diagnostic")

    def load_queue(self):
        assert self.locked
        return self.q

    def author_lease_command(self, request_id, fallback):
        assert self.locked
        return {"v": 1, "request_id": request_id, "binding": dict(BINDING),
                "issuer": "waiting", "reviewer": None,
                "deadline_at": "2026-10-17T00:25:00Z", "decided_at": None,
                "dispatch": False}


class TransportTest(unittest.TestCase):
    def call(self, raw, backend=None):
        return json.loads(transport.handle(raw, backend or Backend(),
                                          policy_path="operator-policy.json", reviewer="agent:configured",
                                          approved_target=BINDING["target"]))

    def test_v1_response_bytes_remain_exact(self):
        backend = Backend()
        raw = transport.handle(request(), backend, policy_path="operator-policy.json",
                               reviewer="agent:configured", approved_target=BINDING["target"])
        expected = backend.with_lock(lambda: backend.author_lease_command("worker-1", False))
        self.assertEqual(raw, (json.dumps(expected, separators=(",", ":"), sort_keys=True) + "\n").encode())

    def test_enrollment_is_pending_no_start_and_stdout_is_one_json(self):
        backend = Backend()
        reply = self.call(request(), backend)
        self.assertEqual(reply["issuer"], "waiting")
        self.assertFalse(reply["dispatch"])
        self.assertEqual(backend.q["starts"], [])
        self.assertEqual(backend.q["items"][0]["state"], "pending")
        self.assertEqual(backend.claims, [("operator-policy.json", "agent:configured")])

    def test_identical_delivery_is_idempotent_conflict_does_not_mutate(self):
        backend = Backend()
        self.call(request(), backend)
        self.call(request(), backend)
        self.assertEqual(len(backend.q["items"]), 1)
        before = copy.deepcopy(backend.q)
        with self.assertRaises(author_quota.AuthorRefused):
            self.call(request(head="c" * 40), backend)
        self.assertEqual(backend.q, before)

    def test_only_operator_target_is_admitted_before_lock_or_quota_mutation(self):
        backend = Backend()
        before = copy.deepcopy(backend.q)
        for target in (None, "origin/main"):
            with self.subTest(target=target), self.assertRaisesRegex(
                    author_quota.AuthorRefused, "operator-approved"):
                transport.handle(request(), backend, policy_path="policy.json",
                                 reviewer="agent:configured", approved_target=target)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "operator-approved"):
            self.call(request(target="origin/main", request_id="duplicate-target"), backend)
        self.assertEqual(backend.q, before)
        self.assertEqual(backend.claims, [])
        self.assertFalse(backend.locked)

    def test_status_and_fallback_require_full_binding_before_delegate(self):
        backend = Backend()
        self.call(request(), backend)
        with mock.patch.object(backend, "author_lease_command", wraps=backend.author_lease_command) as call:
            for op in ("status", "fallback"):
                with self.assertRaises(author_quota.AuthorRefused):
                    self.call(request(op, head="c" * 40), backend)
            call.assert_not_called()

    def test_unknown_version_fields_types_and_duplicate_json_refused(self):
        malformed = [b'[]', b'{"v":1,"v":1}', request().replace(b'"v": 1', b'"v": true'),
                     request().replace(b'"v": 1', b'"v": 2'), b'\xff', b'x' * 8193,
                     request().replace(b'"op": "enroll"', b'"op": "put"'),
                     request().replace(b'"v": 1', b'"extra": 0, "v": 1')]
        for raw in malformed:
            with self.subTest(raw=raw[:30]), self.assertRaises(author_quota.AuthorRefused):
                self.call(raw)

    def test_lock_contention_never_exposes_a_permission(self):
        backend = Backend()
        backend.with_lock = lambda fn: None
        with self.assertRaisesRegex(author_quota.AuthorRefused, "lock busy"):
            self.call(request(), backend)
        self.assertEqual(backend.q["items"], [])

    def test_no_downgrade_when_p3_or_operator_config_absent(self):
        with self.assertRaisesRegex(author_quota.AuthorRefused, "P3"):
            self.call(request(), object())
        with self.assertRaises(author_quota.AuthorRefused):
            transport.handle(request(), Backend(), policy_path=None, reviewer=None, approved_target=None)

    def test_actual_runner_lock_blocks_worker_and_preserves_queue(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lock = root / "tick.lock"
            with lock.open("w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                backend = Backend()
                backend.with_lock = crq.with_lock
                with mock.patch.multiple(crq, STATE=root, LOCK=lock):
                    with self.assertRaisesRegex(author_quota.AuthorRefused, "lock busy"):
                        self.call(request(), backend)
                self.assertEqual(backend.q["items"], [])

    def test_forced_command_guard_rejects_spool_or_arbitrary_command(self):
        for command in ("put request", "author-v1; whoami", ""):
            result = subprocess.run([sys.executable, "-B", str(Path(transport.__file__))],
                                    input=request(), capture_output=True,
                                    env={**os.environ, "SSH_ORIGINAL_COMMAND": command})
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")

    def test_p3_real_enrollment_and_replayed_fallback_are_single_dispatch(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            policy = root / "policy.json"
            policy.write_text('{"review":{"reviewerTimeoutMin":1}}')
            q = {"items": [], "starts": []}
            with mock.patch.multiple(crq, STATE=root, LOCK=root / "tick.lock"), \
                 mock.patch.object(crq, "load_queue", return_value=q), \
                 mock.patch.object(crq, "save_queue"), mock.patch.object(crq, "event"), \
                 mock.patch.object(crq, "write_status"), mock.patch.object(crq, "iso", return_value="2026-10-17T00:00:00Z"):
                transport.handle(request(), crq, policy_path=str(policy), reviewer="agent:configured", approved_target=BINDING["target"])
                with mock.patch.object(crq, "iso", return_value="2026-10-17T00:01:00Z"):
                    first = json.loads(transport.handle(request("fallback"), crq, policy_path=str(policy), reviewer="agent:configured",
                                          approved_target=BINDING["target"]))
                    replay = json.loads(transport.handle(request("fallback"), crq, policy_path=str(policy), reviewer="agent:configured",
                                          approved_target=BINDING["target"]))
                self.assertTrue(first["dispatch"])
                self.assertFalse(replay["dispatch"])
                self.assertEqual(q["starts"], [])


    def test_runner_errors_are_one_sanitized_refusal(self):
        result = subprocess.run(
            [sys.executable, "-B", "-c", "from test_author_transport import failing_fixture_main; failing_fixture_main()"],
            cwd=Path(__file__).resolve().parent, input=request(), capture_output=True, timeout=20)
        self.assertEqual((result.returncode, result.stdout), (2, b""))
        self.assertEqual(result.stderr, b"author-transport: request refused; no permission\n")

    def test_request_process_group_dies_before_the_lock_is_released(self):
        # (scanner body, expected exit): a direct child and a backgrounded grandchild past the
        # deadline, and a grandchild left behind by a scanner that exits successfully.
        cases = {"direct": ('sleep 2\ntouch "$1"\n', 2),
                 "grandchild": ('(sleep 2; touch "$1") &\nwait\n', 2),
                 "left-behind": ('(sleep 2; touch "$1") >/dev/null 2>&1 &\nexit 0\n', 0)}
        with tempfile.TemporaryDirectory() as d:
            root, runs = Path(d), {}
            (root / "request").write_bytes(request())
            for name, (body, _) in cases.items():
                state = root / name
                state.mkdir()
                (state / "scan").write_text("#!/bin/sh\n" + body)
                (state / "scan").chmod(0o700)
                with (root / "request").open("rb") as source:  # one file offset per process
                    runs[name] = subprocess.Popen(
                        [sys.executable, "-B", "-c",
                         "from test_author_transport import deadline_fixture_main; deadline_fixture_main()",
                         str(state)],
                        cwd=Path(__file__).resolve().parent, stdin=source,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            outputs = {name: run.communicate(timeout=20) for name, run in runs.items()}
            time.sleep(2.5)
            for name, (_, code) in cases.items():
                with self.subTest(name):
                    self.assertEqual(runs[name].returncode, code, outputs[name][1])
                    self.assertEqual(bool(outputs[name][0]), code == 0)
                    self.assertFalse((root / name / "marker").exists())
                    with (root / name / "tick.lock").open("w") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


    def test_supervised_group_is_gone_when_the_lock_is_released(self):
        for name, body, deadline in (("deadline", "sleep 30 & wait", True),
                                     ("left-behind", "sleep 30 >/dev/null 2>&1 &", False)):
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                pgid_file, alive = Path(d) / "pgid", []

                class Runner:
                    def with_lock(self, fn):
                        try:
                            return fn()
                        finally:  # the release point: probe the request's process group
                            try:
                                os.killpg(int(pgid_file.read_text()), 0)
                                alive.append(True)
                            except ProcessLookupError:
                                alive.append(False)

                def work(runner):
                    pgid_file.write_text(str(os.getpgrp()))
                    subprocess.run(["sh", "-c", body], check=False)
                    return b"{}\n"

                def expired(signum, frame):
                    raise author_quota.AuthorRefused("deadline")
                previous = signal.signal(signal.SIGALRM, expired)
                try:
                    if deadline:
                        signal.alarm(1)
                        with self.assertRaises(author_quota.AuthorRefused):
                            transport.supervised(work, Runner())
                    else:
                        self.assertEqual(transport.supervised(work, Runner()), b"{}\n")
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, previous)
                self.assertEqual(alive, [False])

def fixture_main():
    """Production forced-command entry point; only the queue backend is fake."""
    sys.modules["crq"] = Backend()
    os.environ.update(SSH_ORIGINAL_COMMAND="author-v1",
                      CRQ_AUTHOR_REVIEW_POLICY="operator-policy.json",
                      CRQ_AUTHOR_FALLBACK_REVIEWER="agent:configured",
                      CRQ_AUTHOR_TARGET=BINDING["target"])
    sys.argv = [transport.__file__]
    raise SystemExit(transport.main())


def deadline_fixture_main():
    """Production entry point under the real tick.lock; enrollment runs the state dir's scanner."""
    state = Path(sys.argv[1])
    backend = Backend()

    def with_lock(fn):
        backend.locked = True
        try:
            return crq.with_lock(fn)
        finally:
            backend.locked = False

    def enroll_author(**kwargs):
        crq.run([str(state / "scan"), str(state / "marker")], check=False)
        Backend.enroll_author(backend, **kwargs)
    backend.with_lock, backend.enroll_author = with_lock, enroll_author
    sys.modules["crq"] = backend
    transport.DEADLINE_S = 1
    os.environ.update(SSH_ORIGINAL_COMMAND="author-v1",
                      CRQ_AUTHOR_REVIEW_POLICY="operator-policy.json",
                      CRQ_AUTHOR_FALLBACK_REVIEWER="agent:configured",
                      CRQ_AUTHOR_TARGET=BINDING["target"])
    sys.argv = [transport.__file__]
    with mock.patch.multiple(crq, STATE=state, LOCK=state / "tick.lock"):
        raise SystemExit(transport.main())


def failing_fixture_main():
    """Production entry point whose runner fails with a host-path-bearing error."""
    backend = Backend()

    def broken(fn):
        raise RuntimeError("git show … exit 128: fatal: /srv/private/clone missing policy")
    backend.with_lock = broken
    sys.modules["crq"] = backend
    os.environ.update(SSH_ORIGINAL_COMMAND="author-v1",
                      CRQ_AUTHOR_REVIEW_POLICY="operator-policy.json",
                      CRQ_AUTHOR_FALLBACK_REVIEWER="agent:configured",
                      CRQ_AUTHOR_TARGET=BINDING["target"])
    sys.argv = [transport.__file__]
    raise SystemExit(transport.main())
