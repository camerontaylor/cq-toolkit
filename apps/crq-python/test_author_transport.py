"""Offline wire/lock tests. Never touches live state or starts any reviewer."""
import copy
import fcntl
import json
import os
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


    def test_deadline_kills_the_runner_scan_and_releases_the_lock(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            marker = root / "late-marker"
            scanner = root / "scan"
            scanner.write_text(f'#!/bin/sh\nsleep 2\ntouch "{marker}"\n')
            scanner.chmod(0o700)
            result = subprocess.run(
                [sys.executable, "-B", "-c",
                 "from test_author_transport import deadline_fixture_main; deadline_fixture_main()",
                 str(root), str(scanner)],
                cwd=Path(__file__).resolve().parent, input=request(), capture_output=True, timeout=20)
            self.assertEqual((result.returncode, result.stdout), (2, b""))
            time.sleep(2.5)
            self.assertFalse(marker.exists())
            with (root / "tick.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

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
    """Production entry point whose locked work runs a scan that outlives the deadline."""
    state, scanner = Path(sys.argv[1]), sys.argv[2]
    backend = Backend()
    backend.with_lock = lambda fn: crq.with_lock(lambda: crq.run([scanner], check=False) and fn())
    sys.modules["crq"] = backend
    transport.DEADLINE_S = 1
    os.environ.update(SSH_ORIGINAL_COMMAND="author-v1",
                      CRQ_AUTHOR_REVIEW_POLICY="operator-policy.json",
                      CRQ_AUTHOR_FALLBACK_REVIEWER="agent:configured",
                      CRQ_AUTHOR_TARGET=BINDING["target"])
    sys.argv = [transport.__file__]
    with mock.patch.multiple(crq, STATE=state, LOCK=state / "tick.lock"):
        raise SystemExit(transport.main())
