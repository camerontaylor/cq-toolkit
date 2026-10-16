"""Offline lease arbitration, persistence and two-process lock races."""
import copy
import datetime as dt
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import author_lease
import author_quota
import test_author_quota as legacy

crq = legacy.crq
AT = "2026-10-16T06:00:00Z"
BEFORE = "2026-10-16T06:24:59Z"
DEADLINE = "2026-10-16T06:25:00Z"
LATER = "2026-10-16T07:00:00Z"
POLICY = {"review": {"reviewerTimeoutMin": 25}}
REVIEWER = "configured-reviewer"


def queue():
    q = legacy.empty_queue()
    item = author_quota.enroll(q, **legacy.binding(), at=AT)["item"]
    item["author_lease"] = author_lease.new_lease(POLICY, REVIEWER, at=AT)
    return q, item


class LeasePolicyTest(unittest.TestCase):
    def test_deadline_reads_exact_policy_key(self):
        q, item = queue()
        self.assertEqual(item["author_lease"]["deadline_at"], DEADLINE)
        changed = author_lease.new_lease({"review": {"reviewerTimeoutMin": 2}}, REVIEWER, at=AT)
        self.assertEqual(changed["deadline_at"], "2026-10-16T06:02:00Z")
        self.assertEqual(q["starts"], [])
        for policy in ({}, {"review_timeout_min": 25}, {"review": None},
                       *({"review": {"reviewerTimeoutMin": n}} for n in (True, 0, -1, "25", 1.5, 10**20))):
            with self.subTest(policy=policy), self.assertRaises(author_quota.AuthorRefused):
                author_lease.new_lease(policy, REVIEWER, at=AT)

    def test_queue_before_deadline_permanently_prevents_fallback(self):
        q, item = queue()
        author_lease.grant_queue(item, at=BEFORE)
        result = author_lease.fallback(q, legacy.REQ, at=LATER)
        self.assertEqual(result["issuer"], "queue")
        self.assertFalse(result["dispatch"])
        with self.assertRaises(author_quota.AuthorRefused):
            author_lease.grant_queue(item, at=BEFORE)

    def test_exact_deadline_queue_refuses_and_fallback_wins_once(self):
        q, item = queue()
        with self.assertRaises(author_quota.AuthorRefused):
            author_lease.grant_queue(item, at=DEADLINE)
        result = author_lease.fallback(q, legacy.REQ, at=DEADLINE)
        self.assertEqual((result["issuer"], result["reviewer"], result["dispatch"]),
                         ("agent", REVIEWER, True))
        self.assertEqual(item["state"], "skipped")
        self.assertFalse(author_lease.fallback(q, legacy.REQ, at=LATER)["dispatch"])
        # Even a manual requeue or a rolled-back clock cannot restore eligibility.
        item["state"] = "pending"
        for at in (BEFORE, DEADLINE, LATER):
            with self.subTest(at=at), self.assertRaises(author_quota.AuthorRefused):
                author_lease.grant_queue(item, at=at)
        self.assertEqual(q["starts"], [])

    def test_early_fallback_and_clock_rollback_refuse_without_mutation(self):
        q, item = queue()
        before = copy.deepcopy(q)
        with self.assertRaises(author_quota.AuthorRefused):
            author_lease.fallback(q, legacy.REQ, at=BEFORE)
        with self.assertRaises(author_quota.AuthorRefused):
            author_lease.grant_queue(item, at="2026-10-15T06:00:00Z")
        self.assertEqual(q, before)

    def test_legacy_unknown_and_corrupt_state_never_allow_fallback(self):
        for change in (None, {"v": 2}, {"v": True}, {"state": "unknown"},
                       {"deadline_at": LATER}, {"state": "queue"}, {"reviewer": ""}):
            q, item = queue()
            if change is None:
                item["author_lease"] = None
            else:
                item["author_lease"].update(change)
            before = copy.deepcopy(q)
            with self.subTest(change=change):
                with self.assertRaises(author_quota.AuthorRefused):
                    author_lease.fallback(q, legacy.REQ, at=LATER)
                self.assertEqual(q, before)
                with self.assertRaises(author_quota.AuthorRefused):
                    author_lease.grant_queue(item, at=BEFORE)
        q, item = queue()
        del item["author_lease"]
        with self.assertRaisesRegex(author_quota.AuthorRefused, "legacy"):
            author_lease.fallback(q, legacy.REQ, at=LATER)

    def test_started_or_blocked_items_cannot_fall_back(self):
        for change in ({"state": "blocked"}, {"run": {"launch_pending": True}},
                       {"attempts": [{"outcome": "error"}]}):
            q, item = queue()
            item.update(change)
            with self.subTest(change=change), self.assertRaises(author_quota.AuthorRefused):
                author_lease.fallback(q, legacy.REQ, at=LATER)

    def test_unknown_fields_survive_and_binding_mismatch_refuses(self):
        q, item = queue()
        item["author_lease"]["future"] = {"keep": [None, False]}
        author_lease.fallback(q, legacy.REQ, at=DEADLINE)
        self.assertEqual(item["author_lease"]["future"], {"keep": [None, False]})
        q["author_requests"][legacy.REQ]["head"] = "f" * 40
        with self.assertRaises(author_quota.AuthorRefused):
            author_lease.fallback(q, legacy.REQ, at=LATER)


class LeaseLaunchTest(unittest.TestCase):
    def setUp(self):
        legacy.LaunchTest.setUp(self)

    def launch(self, q, item):
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", return_value=SimpleNamespace(pid=4242)) as spawn:
            crq.launch(q, item, author_quota.plan(item))
        return spawn

    def test_grant_and_quota_are_durable_before_spawn(self):
        q, item = queue()
        saved = []
        crq.save_queue.side_effect = lambda value: saved.append(copy.deepcopy(value))
        def spawn(*a, **kw):
            self.assertEqual(saved[-1]["items"][0]["author_lease"]["state"], "queue")
            self.assertEqual(saved[-1]["items"][0]["run"]["launch_pending"], True)
            self.assertEqual(len(saved[-1]["starts"]), 1)
            return SimpleNamespace(pid=4242)
        with mock.patch.object(crq, "iso", return_value=BEFORE), \
             mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", side_effect=spawn):
            crq.launch(q, item, author_quota.plan(item))
        self.assertEqual(item["state"], "reviewing")
        self.assertFalse(author_lease.fallback(q, legacy.REQ, at=LATER)["dispatch"])

    def test_preparation_crossing_deadline_does_not_spawn_or_reserve(self):
        q, item = queue()
        with mock.patch.object(crq, "iso", side_effect=[BEFORE, BEFORE, DEADLINE]), \
             mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.subprocess, "Popen") as spawn:
            with self.assertRaises(author_quota.AuthorRefused):
                crq.launch(q, item, author_quota.plan(item))
        remove.assert_called_once()
        spawn.assert_not_called()
        crq.save_queue.assert_not_called()
        self.assertEqual(q["starts"], [])
        self.assertTrue(author_lease.fallback(q, legacy.REQ, at=DEADLINE)["dispatch"])

    def test_crash_after_queue_reservation_cannot_fall_back(self):
        q, item = queue()
        def crash(value):
            crq.repair_tick.atomic(self.state / "queue.json", value)
            raise OSError("crash after durable reservation")
        crq.save_queue.side_effect = crash
        with mock.patch.object(crq, "iso", return_value=BEFORE), \
             mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen") as spawn:
            with self.assertRaises(OSError):
                crq.launch(q, item, author_quota.plan(item))
        spawn.assert_not_called()
        restored = json.loads((self.state / "queue.json").read_text())
        self.assertFalse(author_lease.fallback(restored, legacy.REQ, at=LATER)["dispatch"])
        self.assertEqual(len(restored["starts"]), 1)


class LeaseCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "queue.json"
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps(POLICY))
        for name, value in (("QUEUE", self.path), ("STATE", self.root),
                            ("LOCK", self.root / "tick.lock"), ("write_status", mock.Mock()),
                            ("event", mock.Mock()), ("iso", lambda: AT)):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)
        crq.repair_tick.atomic(self.path, legacy.empty_queue())

    def enroll(self, **over):
        args = legacy.binding()
        args.update(review_policy=str(self.policy), fallback_reviewer=REVIEWER)
        args.update(over)
        with redirect_stdout(io.StringIO()):
            crq.enroll_author(**args)

    def test_retry_does_not_reset_deadline_or_change_policy(self):
        self.enroll()
        before = self.path.read_bytes()
        with mock.patch.object(crq, "iso", return_value=LATER):
            self.enroll()
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(SystemExit):
            self.enroll(fallback_reviewer="different-reviewer")
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_enrollment_does_not_write(self):
        for kwargs in ({"review_policy": None}, {"fallback_reviewer": None}):
            before = self.path.read_bytes()
            with self.assertRaises(SystemExit):
                self.enroll(**kwargs)
            self.assertEqual(self.path.read_bytes(), before)

    def test_response_is_after_persistence_and_restart_cannot_redispatch(self):
        self.enroll()
        with mock.patch.object(crq, "iso", return_value=DEADLINE):
            result = crq.with_lock(crq.author_lease_command, legacy.REQ, True)
            self.assertTrue(result["dispatch"])
            restored = json.loads(self.path.read_text())
            self.assertEqual(restored["items"][0]["author_lease"]["state"], "agent")
            self.assertFalse(crq.with_lock(crq.author_lease_command, legacy.REQ, True)["dispatch"])
            self.assertFalse(crq.with_lock(crq.author_lease_command, legacy.REQ, False)["dispatch"])

    def test_failed_persistence_returns_no_permission(self):
        self.enroll()
        before = self.path.read_bytes()
        with mock.patch.object(crq, "iso", return_value=DEADLINE), \
             mock.patch.object(crq, "save_queue", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                crq.with_lock(crq.author_lease_command, legacy.REQ, True)
        self.assertEqual(self.path.read_bytes(), before)

    def test_two_processes_cannot_grant_both_issuers(self):
        self.enroll()
        # Both contenders use the actual same flock/atomic store. Queue's frozen
        # clock is just before the deadline; fallback's is at the deadline. Either
        # order is valid; at most one can record a dispatch permission.
        script = '''
import json, sys
from pathlib import Path
import crq, author_lease, author_quota
root, action, at, req = sys.argv[1:]
crq.STATE=Path(root); crq.LOCK=crq.STATE/'tick.lock'; crq.QUEUE=crq.STATE/'queue.json'
def decide():
    q=crq.load_queue()
    if action=='queue':
        item=author_lease.find(q,req)
        author_lease.grant_queue(item,at=at)
        result=author_lease.decision(item,dispatch=True)
    else:
        result=author_lease.fallback(q,req,at=at)
    crq.save_queue(q)
    return result
try:
    print(json.dumps(crq.with_lock(decide)))
except author_quota.AuthorRefused:
    print('refused')
'''
        commands = [("queue", BEFORE), ("agent", DEADLINE)]
        children = [subprocess.Popen([sys.executable, "-c", script, str(self.root), action, at, legacy.REQ],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for action, at in commands]
        outputs = []
        for child in children:
            out, err = child.communicate(timeout=20)
            self.assertEqual(child.returncode, 0, err)
            outputs.extend(out.splitlines())
        grants = [json.loads(line) for line in outputs if line.startswith("{")]
        self.assertEqual(sum(g["dispatch"] for g in grants), 1, outputs)
        restored = json.loads(self.path.read_text())
        self.assertIn(restored["items"][0]["author_lease"]["state"], ("queue", "agent"))


if __name__ == "__main__":
    unittest.main()
