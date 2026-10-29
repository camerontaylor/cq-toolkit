"""Every-green-tip promotion regressions; no GitHub, scan or model calls."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_promotion_retry import crq

BASE = "b" * 40
TIP = "a" * 40


class PromotionPolicyTest(unittest.TestCase):
    def test_committed_policy_has_immediate_triggers(self):
        policy = json.loads(Path(__file__).with_name("config.json").read_text())["promotion"]
        self.assertEqual(policy["merges_trigger"], 1)
        self.assertEqual(policy["dispatch_after_min"], 0)

    def test_single_unpromoted_green_merge_cuts_without_age_or_demand(self):
        q = {"items": [], "promotion": {"last_promoted_at": crq.iso()}}
        with mock.patch.object(crq, "promotion_gate_live", return_value=True), \
             mock.patch.object(crq, "promotion_mode", return_value="user"), \
             mock.patch.object(crq, "main_sha", return_value=BASE), \
             mock.patch.object(crq, "git", return_value="1"), \
             mock.patch.object(crq, "newest_green_tip", return_value=TIP), \
             mock.patch.object(crq, "is_ancestor", return_value=False), \
             mock.patch.object(crq, "cut_promotion") as cut:
            crq.promotion_tick(q, False)
        cut.assert_called_once()
        self.assertEqual(cut.call_args.args[3:5], (BASE, TIP))
        self.assertEqual(cut.call_args.args[5], "1 merges since last promotion")

    def scan_fixture(self, tips, green=None):
        def rev_list(*args):
            self.assertEqual(args[:2], ("rev-list", "--first-parent"))
            self.assertEqual(args[2], "--max-count")
            base, resume = args[-1].split("..")
            self.assertEqual(base, BASE)
            start = 0 if resume == "origin/merge-queue" else tips.index(resume)
            return "\n".join(tips[start:start + int(args[3])])
        return (mock.patch.object(crq, "git", side_effect=rev_list),
                mock.patch.object(crq, "is_ancestor", return_value=True),
                mock.patch.object(crq, "checks_verdict", side_effect=lambda sha: "pass" if sha == green else "pending"))

    def test_green_tip_behind_sixteen_non_green_tips_is_found_after_restart(self):
        tips = [f"{n:040x}" for n in range(22, 0, -1)]
        green = tips[16]
        state = {}
        patches = self.scan_fixture(tips, green)
        with patches[0], patches[1], patches[2] as checks:
            for tick in range(4):
                before = checks.call_count
                found = crq.newest_green_tip(BASE, [], state)
                self.assertLessEqual(checks.call_count - before, crq.PROMOTION_TIP_CHECKS_PER_TICK)
                state = json.loads(json.dumps(state))  # persisted queue across restart
                if tick < 3:
                    self.assertIsNone(found)
                else:
                    self.assertEqual(found, green)
            self.assertEqual([c.args[0] for c in checks.call_args_list], tips[:17])
            self.assertNotIn("tip_scan", state)

    def test_no_green_sweep_is_bounded_and_restarts_after_exhaustion(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips)
        with patches[0], patches[1], patches[2] as checks:
            for _ in range(3):
                crq.newest_green_tip(BASE, [], state)
            self.assertEqual(checks.call_count, len(tips))
            self.assertNotIn("tip_scan", state)
            crq.newest_green_tip(BASE, [], state)
            self.assertEqual(checks.call_args_list[len(tips)].args[0], tips[0])

    def test_new_commits_do_not_starve_an_existing_scan(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips, tips[7])
        with patches[0], patches[1], patches[2]:
            self.assertIsNone(crq.newest_green_tip(BASE, [], state))
            tips.insert(0, "f" * 40)
            self.assertEqual(crq.newest_green_tip(BASE, [], state), tips[8])

    def test_stale_base_or_schema_and_rewound_queue_restart_at_newest(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        patches = self.scan_fixture(tips, tips[0])
        with patches[0], patches[1], patches[2] as checks:
            for cursor in [{"schema_version": 2, "base": BASE, "next": tips[8]},
                           {"schema_version": 1, "base": "c" * 40, "next": tips[8]}]:
                self.assertEqual(crq.newest_green_tip(BASE, [], {"tip_scan": cursor}), tips[0])
            with mock.patch.object(crq, "is_ancestor", return_value=False):
                self.assertEqual(crq.newest_green_tip(BASE, [], {"tip_scan": {
                    "schema_version": 1, "base": BASE, "next": tips[8]}}), tips[0])
            self.assertEqual([c.args[0] for c in checks.call_args_list], [tips[0]] * 3)

    def test_remote_error_retries_only_the_unfinished_candidate(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips)
        with patches[0], patches[1], patches[2] as checks:
            checks.side_effect = ["pending", RuntimeError("offline")]
            with self.assertRaises(RuntimeError):
                crq.newest_green_tip(BASE, [], state)
            self.assertEqual(state["tip_scan"]["next"], tips[1])
            checks.side_effect = lambda sha: "pass"
            self.assertEqual(crq.newest_green_tip(BASE, [], state), tips[1])


class PromotionAuditAckTest(unittest.TestCase):
    """Exact procedural disposition, with actual atomic queue persistence and mocked effects."""

    AT = "2026-10-29T00:00:00Z"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.queue = self.root / "queue.json"
        self.q = {"items": [], "promotion_audit": {
            "last_main": TIP,
            "records": [{"from": BASE, "to": TIP, "at": self.AT,
                         "verdict": "UNVERIFIED", "reasons": ["no trusted bot"]}],
            "alerts": [{"from": BASE, "to": TIP, "at": self.AT,
                        "reasons": ["no trusted bot"], "acked": None}]},
            "promotion": {"gate_alerts": [{"sha": TIP, "acked": None}],
                          "signer_alerts": [{"sha": TIP, "acked": None}],
                          "escalations": [{"sha": TIP, "acked": None}]}}
        self.persist(self.q)
        for name, value in {"QUEUE": self.queue, "LEDGER": self.root / "ledger"}.items():
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.status_renderer = crq.write_status
        self.effects = {}
        for name in ("event", "write_status", "notify_owner", "run"):
            patch = mock.patch.object(crq, name)
            self.effects[name] = patch.start()
            self.addCleanup(patch.stop)

    def persist(self, q):
        self.queue.write_text(json.dumps(q))

    def load(self):
        return json.loads(self.queue.read_text())

    def ack(self, sha=TIP, why="O3 disposition", **kwargs):
        crq.admin("promotion-ack", None, f"{sha} {why}",
                  **({"audit_from": BASE, "audit_at": self.AT} | kwargs))

    def test_exact_ack_persists_before_event_and_preserves_verdict_and_other_alerts(self):
        def observed_event(kind, **receipt):
            saved = self.load()
            self.assertEqual(kind, "admin_promotion_audit_ack")
            self.assertEqual(saved["promotion_audit"]["alerts"][0]["acknowledgement"], receipt)
        self.effects["event"].side_effect = observed_event
        self.ack()
        q = self.load()
        audit = q["promotion_audit"]
        self.assertEqual(audit["records"][0]["verdict"], "UNVERIFIED")
        self.assertEqual(audit["records"][0]["reasons"], ["no trusted bot"])
        self.assertEqual(audit["records"][0]["acknowledgement"], audit["alerts"][0]["acknowledgement"])
        self.assertEqual(q["promotion"], self.q["promotion"])
        self.assertEqual(audit["last_main"], TIP)
        self.effects["run"].assert_not_called()
        self.effects["notify_owner"].assert_not_called()

    def test_identical_retry_after_restart_does_not_save_or_emit_another_event(self):
        self.ack()
        before = self.queue.read_bytes()
        self.effects["event"].reset_mock()
        with mock.patch.object(crq, "save_queue") as save:
            self.ack()
        save.assert_not_called()
        self.effects["event"].assert_not_called()
        self.assertEqual(self.queue.read_bytes(), before)

    def test_changed_or_legacy_disposition_refuses_without_writing(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.persist(self.q)
                if legacy:
                    q = self.load()
                    q["promotion_audit"]["alerts"][0]["acked"] = "legacy acknowledgement"
                    self.persist(q)
                else:
                    self.ack()
                before = self.queue.read_bytes()
                with self.assertRaises(SystemExit):
                    self.ack(why="changed disposition")
                self.assertEqual(self.queue.read_bytes(), before)

    def test_invalid_or_partial_identity_refuses_without_effects(self):
        cases = [{"sha": "all"}, {"sha": TIP[:10]}, {"audit_from": BASE[:10]},
                 {"audit_from": None}, {"audit_at": None}, {"audit_at": ""},
                 {"audit_at": "not-a-time"}, {"audit_at": "2999-01-01T00:00:00Z"},
                 {"audit_at": self.AT + "junk"}, {"audit_from": "c" * 40},
                 {"sha": "c" * 40}, {"why": " "}]
        before = self.queue.read_bytes()
        for args in cases:
            with self.subTest(args=args), self.assertRaises(SystemExit):
                self.ack(**args)
            self.assertEqual(self.queue.read_bytes(), before)
        for effect in self.effects.values():
            effect.assert_not_called()

    def test_missing_ambiguous_or_non_unverified_record_refuses(self):
        for member in ("records", "alerts"):
            for duplicate in (False, True):
                q = json.loads(json.dumps(self.q))
                q["promotion_audit"][member] = q["promotion_audit"][member] * (2 if duplicate else 0)
                self.persist(q)
                before = self.queue.read_bytes()
                with self.subTest(member=member, duplicate=duplicate), self.assertRaises(SystemExit):
                    self.ack()
                self.assertEqual(self.queue.read_bytes(), before)
        q = json.loads(json.dumps(self.q))
        q["promotion_audit"]["records"][0]["verdict"] = "verified"
        self.persist(q)
        with self.assertRaises(SystemExit):
            self.ack()

    def test_old_ack_cannot_consume_repeated_range_at_another_observation(self):
        self.ack()
        q = self.load()
        new_at = "2026-10-29T00:01:00Z"
        for member in ("records", "alerts"):
            entry = dict(self.q["promotion_audit"][member][0], at=new_at)
            q["promotion_audit"][member].append(entry)
        self.persist(q)
        self.ack()  # Old identity remains an idempotent no-op.
        self.assertIsNone(self.load()["promotion_audit"]["alerts"][1]["acked"])
        self.ack(audit_at=new_at)
        self.assertEqual(self.load()["promotion_audit"]["alerts"][1]["acknowledgement"]["audit_at"], new_at)

    def test_save_failure_reports_no_success_and_does_not_emit_event(self):
        before = self.queue.read_bytes()
        with mock.patch.object(crq, "save_queue", side_effect=OSError("disk full")), \
             mock.patch("builtins.print") as output, self.assertRaises(OSError):
            self.ack()
        output.assert_not_called()
        self.effects["event"].assert_not_called()
        self.effects["write_status"].assert_not_called()
        self.assertEqual(self.queue.read_bytes(), before)

    def test_event_or_status_failure_keeps_ack_durable_and_retry_idempotent(self):
        for name in ("event", "write_status"):
            with self.subTest(effect=name):
                self.persist(self.q)
                effect = self.effects[name]
                effect.side_effect = OSError("effect failed")
                with self.assertRaises(OSError):
                    self.ack()
                self.assertTrue(self.load()["promotion_audit"]["alerts"][0]["acked"])
                effect.side_effect = None
                self.effects["event"].reset_mock()
                self.ack()
                self.effects["event"].assert_not_called()

    def test_new_unverified_alert_carries_exact_identity_without_reclassifying(self):
        q = {"items": [], "promotion_audit": {"last_main": BASE, "records": [], "alerts": []}}
        self.effects["run"].return_value = mock.Mock(returncode=0)
        self.effects["notify_owner"].return_value = {}
        with mock.patch.object(crq, "main_sha", return_value=TIP), \
             mock.patch.object(crq, "policy_at", return_value=True), \
             mock.patch.object(crq, "promotion_mode_at", return_value="signer"), \
             mock.patch.object(crq, "audit_signer_advance", return_value=(["no trusted bot"], [])):
            crq.promotion_audit(q, False)
        audit = q["promotion_audit"]
        self.assertEqual(audit["records"][0]["verdict"], "UNVERIFIED")
        self.assertEqual(audit["alerts"][0]["from"], BASE)
        self.assertEqual(audit["alerts"][0]["at"], audit["records"][0]["at"])
        self.assertIsNone(audit["alerts"][0]["acked"])
        message = self.effects["notify_owner"].call_args.args[0]
        self.assertIn(f"--audit-from {BASE} --audit-at {audit['records'][0]['at']}", message)

    def test_cli_routes_exact_flags_under_existing_lock(self):
        with mock.patch.object(crq.sys, "argv", ["crq", "promotion-ack", TIP, "O3 disposition",
                                                "--audit-from", BASE, "--audit-at", self.AT]), \
             mock.patch.object(crq, "with_lock") as lock:
            crq.main()
        lock.assert_called_once_with(crq.admin, "promotion-ack", None, f"{TIP} O3 disposition",
                                     audit_from=BASE, audit_at=self.AT)

    def test_status_guidance_uses_exact_identity_and_preserves_historical_commands(self):
        q = json.loads(json.dumps(self.q))
        q["promotion"] = {}
        alerts = q["promotion_audit"]["alerts"]
        alerts.extend([
            {"to": "c" * 40, "at": self.AT, "reasons": ["historical alert"], "acked": None},
            {"from": BASE[:10], "to": "d" * 40, "at": self.AT,
             "reasons": ["historical partial range"], "acked": None},
        ])
        before = json.dumps(q, sort_keys=True)
        with mock.patch.object(crq, "STATE", self.root), \
             mock.patch.object(crq, "EVENTS", self.root / "events.jsonl"), \
             mock.patch.dict(crq.CONFIG, {"schedule_id": None}), \
             mock.patch.object(crq, "promotion_mode", return_value="signer"), \
             mock.patch.object(crq.repair_tick, "digest", return_value={}), \
             mock.patch.object(crq.coverage, "utilization_digest", return_value={}), \
             mock.patch.object(crq.status_summary, "publish"):
            self.status_renderer(q)
        banners = [line for line in (self.root / "status.md").read_text().splitlines()
                   if "ALERT — PROMOTION UNVERIFIED" in line]
        self.assertEqual(len(banners), 3)
        self.assertIn(f'Procedural ack: `crq.py promotion-ack {TIP} "<reason>" '
                      f'--audit-from {BASE} --audit-at {self.AT}`', banners[0])
        self.assertNotIn(f'promotion-ack {TIP[:10]} "', banners[0])
        for banner, alert in zip(banners[1:], alerts[1:]):
            self.assertIn(f'Legacy ack: `crq.py promotion-ack {alert["to"][:10]} "<reason>"`', banner)
            self.assertNotIn("--audit-", banner)
        self.assertEqual(json.dumps(q, sort_keys=True), before)
        self.effects["run"].assert_not_called()
        self.effects["notify_owner"].assert_not_called()
