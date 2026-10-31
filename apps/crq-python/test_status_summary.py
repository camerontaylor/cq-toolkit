"""Window boundaries and failure visibility for the crq producer summary."""
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader("crq_adapter", str(ROOT / "status_summary.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
adapter = importlib.util.module_from_spec(spec)
loader.exec_module(adapter)


def setUpModule():
    # Every producer probe is faked explicitly; no real process is needed.
    patch = mock.patch.object(adapter.subprocess, "Popen",
        side_effect=AssertionError("unmocked producer probe in offline fixture"))
    patch.start()
    unittest.addModuleCleanup(patch.stop)


class SummaryTest(unittest.TestCase):
    def test_account_limit_overrides_fallback_cap(self):
        for usage, expected in [({"limit": 8}, 8), ({"limit": 12}, 12),
                                (None, 5), ({"remaining": 2}, 5),
                                ({"limit": 0}, 5), ({"limit": True}, 5),
                                ({"limit": "8"}, 5)]:
            with self.subTest(usage=usage):
                data = adapter.summarize({"generated_at": "2026-10-31T00:00:00Z"},
                    {"items": [], "usage": usage}, {}, {"max_starts_per_hour": 5}, [], 0)
                self.assertEqual(data["starts_cap"], expected)

    def test_optional_open_cycles_are_not_pending_review_debt(self):
        queue = {"items": [
            {"kind": "open", "state": "pending", "cycles": [{}]},
            {"kind": "open", "state": "pending", "prior_cycles": 1, "prior_base": "a" * 40},
            {"kind": "open", "state": "pending", "cycles": []},
        ]}
        data = adapter.summarize({"generated_at": "2026-10-28T00:00:00Z"}, queue, {},
                                 {"max_starts_per_hour": 5}, [], 0)
        self.assertEqual(data["backlog"]["open"], 2)

    def test_gate_stall_visible_after_ack_until_promotion_completes(self):
        at = "2026-10-19T00:00:00Z"
        item = {"id": "promo-stalled", "kind": "promotion", "state": "promoting", "gate_stalled_at": at}
        alert = {"at": at, "item": item["id"], "sha": "a" * 40, "base": "b" * 40,
                 "text": "private diagnostic", "acked": None}
        queue = {"items": [item], "promotion": {"gate_alerts": [alert]}}

        def summary():
            return adapter.summarize({"generated_at": at}, queue, {},
                {"promotion": {"enabled": True}, "max_starts_per_hour": 5}, [], adapter.timestamp(at))

        data = summary()["promotion"]
        self.assertEqual(data["state"], "needs-human")
        self.assertEqual(data["gate_alerts"], [{k: alert[k] for k in ("at", "item", "sha", "base")}])
        self.assertNotIn("private diagnostic", json.dumps(data))
        alert["acked"] = "owner investigating"
        self.assertEqual(summary()["promotion"]["gate_alerts"], [])
        self.assertEqual(summary()["promotion"]["state"], "needs-human")
        item["state"] = "done"
        self.assertEqual(summary()["promotion"]["state"], "idle")

    def test_publish_is_atomic_private_and_omits_queue_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            events = root / "state/events.jsonl"
            events.write_text('{"event":"review_finished","at":"2026-10-08T02:30:00Z","outcome":"completed","secret":"never publish"}\n')
            queue = {"last_tick": "2026-10-08T02:24:00Z", "items": [], "starts": []}
            config = {"max_starts_per_hour": 5, "schedule_id": "tick", "clone": "/private/clone"}
            xdg = root / "xdg-state"
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", return_value="12\n"):
                data = adapter.publish(root, queue, config, {"status": "active"}, home=root,
                                       now=adapter.timestamp("2026-10-08T03:00:00Z"),
                                       promotion_mode="signer")
            target = xdg / "crq/summary.json"
            self.assertEqual(json.loads(target.read_text()), data)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("never publish", target.read_text())
            self.assertNotIn("/private/clone", target.read_text())
            self.assertEqual(data["outcomes_24h"]["completed"], 1)
            self.assertEqual(data["promotion"]["merges_waiting"], 12)
            self.assertEqual(data["schema_version"], 2)
            self.assertEqual(data["promotion"]["mode"], "signer")
            self.assertEqual(set(data["systemd_timers"]),
                             {"crq-tick.timer", "crq-watchdog.timer", "crq-records.timer"})
            self.assertEqual(set(data["systemd_services"]), {"crq-records.service"})
            for entry in list(data["systemd_timers"].values()) + list(data["systemd_services"].values()):
                self.assertIsNone(entry["active"])
                self.assertEqual(entry["error"], "systemd unit observation unavailable")
            # Complete malformed events preserve the last good file.
            old = target.read_bytes()
            events.write_text('broken complete line\n')
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    self.assertRaises(json.JSONDecodeError):
                adapter.publish(root, queue, config, {}, home=root)
            self.assertEqual(target.read_bytes(), old)

    def test_failed_optional_probes_stay_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            # Ignore only a concurrently appended incomplete final record.
            (root / "state/events.jsonl").write_text('{"event":')
            xdg = root / "xdg-state"
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", side_effect=RuntimeError("unavailable")):
                data = adapter.publish(root, {"last_tick": "2026-10-08T02:24:00Z", "items": []},
                                       {"max_starts_per_hour": 5, "clone": "absent"}, {}, home=root)
            self.assertEqual(data["schedule"]["state"], "systemd")
            self.assertIsNone(data["systemd_timers"]["crq-tick.timer"]["active"])
            self.assertEqual(data["systemd_timers"]["crq-tick.timer"]["error"],
                             "systemctl user show unavailable")
            self.assertIsNone(data["systemd_services"]["crq-records.service"]["active"])
            self.assertEqual(data["systemd_services"]["crq-records.service"]["error"],
                             "systemctl user show unavailable")
            self.assertIsNone(data["promotion"]["merges_waiting"])
            self.assertEqual(data["promotion"]["merges_error"], "cached merge refs unavailable")
            with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(xdg)}), \
                    mock.patch.object(adapter, "command", side_effect=RuntimeError("unavailable")):
                unknown = adapter.publish(root, {"last_tick": "2026-10-08T02:24:00Z", "items": []},
                                          {"max_starts_per_hour": 5, "clone": "absent"},
                                          {"status": "unknown"}, home=root)
            self.assertEqual(unknown["schedule"]["state"], "unknown")
            self.assertEqual(unknown["schedule"]["error"], "schedule probe unavailable")

    def test_windows_failures_blockers_and_signer_inflight(self):
        now = adapter.timestamp("2026-10-08T03:00:00Z")
        queue = {"starts": ["2026-10-08T02:00:00Z", "2026-10-08T01:59:59Z", "2026-10-08T03:00:01Z"],
                 "last_tick": "2026-10-08T02:00:00Z", "paused": True,
                 "items": [
                     {"kind": "open", "state": "pending"},
                     {"kind": "delta", "state": "reviewing"},
                     {"kind": "promotion", "state": "signer_running", "id": "promo-new"},
                     {"kind": "promotion", "state": "findings", "id": "promo-blocked", "blocking": [
                         {"severity": "major", "resolution": None},
                         {"severity": "critical", "resolution": "fixed"}]}]}
        events = [
            {"at": "2026-10-07T03:00:00Z", "event": "review_finished", "outcome": "interrupted"},
            {"at": "2026-10-07T02:59:59Z", "event": "review_finished", "outcome": "completed"},
            {"at": "2026-10-08T03:00:01Z", "event": "review_finished", "outcome": "completed"},
            {"at": "2026-10-08T02:00:00Z", "event": "review_finished", "outcome": "error"},
            {"at": "2026-10-08T02:00:00Z", "event": "review_finished", "outcome": "rate_limited"}]
        data = adapter.summarize({"generated_at": "2026-10-08T03:00:00Z"}, queue,
                                 {"last_tick": "2026-10-08T02:24:00Z"},
                                 {"max_starts_per_hour": 5, "promotion": {"enabled": True}}, events, now)
        self.assertEqual(data["starts_60m"], 1)
        self.assertEqual(data["in_flight"], 2)
        self.assertEqual(data["outcomes_24h"], {"completed": 0, "interrupted": 1, "error": 1})
        self.assertEqual(data["other_outcomes_24h"], 1)
        self.assertEqual(data["backlog"], {"open": 1, "delta": 0, "merged": 0, "promotion": 0,
                                            "coverage": 0})
        self.assertEqual(data["promotion"]["blockers"], [{"item": "promo-blocked", "counts": {"major": 1}}])
        self.assertEqual(data["last_tick"], "2026-10-08T02:24:00Z")


if __name__ == "__main__":
    unittest.main()


class MergedCurrentSummaryTest(unittest.TestCase):
    def test_discovery_and_legacy_done_do_not_count_as_current_review(self):
        q = {"items": [{"kind": "merged", "state": "done"},
                       {"kind": "merged-current", "state": "done"},
                       {"kind": "merged-current", "state": "pending"}],
             "merged_reconcile": {"complete": True, "represented": 125,
                                  "source": "private", "secret": "not exported"}}
        summary = adapter.merged_current(q)
        self.assertEqual(summary["receipts"]["unverified"], 1)
        self.assertEqual(summary["receipts"]["pending"], 1)
        self.assertEqual(summary["receipts"]["proven_terminal"], 0)
        self.assertEqual(summary["coverage_at_today_target"], "unverified")
        self.assertNotIn("private", json.dumps(summary))

    def test_only_bound_verified_receipts_count_at_retained_target_with_exclusions(self):
        rr = adapter.review_receipt
        paths = [{"path": "gone.py", "disposition": "deleted"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": rr.digest(paths), "policy": rr.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = rr.current_equivalence(capture)
        subject = {"repo": "owner/repo", "pr": 1}
        document = {"version": 1, "source": subject, "capture": capture, "outcome": "no-current-code",
                    "counted": False, "classification": None}
        with tempfile.TemporaryDirectory() as td:
            receipt_id = rr.write_receipt(td, document)
            item = {"kind": "merged-current", "state": "no-current-code", "subject": subject,
                    "capture": capture, "receipt_id": receipt_id}
            summary = adapter.merged_current({"items": [item]}, td)
            self.assertEqual(summary["receipts"]["no_current_code"], 1)
            self.assertEqual(summary["receipts"]["proven_terminal"], 0)
            self.assertEqual(summary["captured_targets"], ["a" * 40])
            self.assertEqual(summary["path_exclusions"], {"deleted": 1})
            document.update(outcome="partial-scope", counted=True,
                            classification={"counted": True, "outcome": "completed"})
            item.update(state="done", receipt_id=rr.write_receipt(td, document))
            self.assertEqual(adapter.merged_current({"items": [item]}, td)["receipts"]["partial_scope"], 1)
            document["outcome"] = "terminal-with-findings"
            item["receipt_id"] = rr.write_receipt(td, document)
            self.assertEqual(adapter.merged_current({"items": [item]}, td)["receipts"]["proven_terminal"], 1)
            (Path(td) / (item["receipt_id"] + ".json")).write_text("{}")
            summary = adapter.merged_current({"items": [item]}, td)
            self.assertEqual(summary["receipts"]["unverified"], 1)
            self.assertEqual(summary["receipts"]["proven_terminal"], 0)



    def test_reused_receipt_requires_retained_lineage_and_equivalent_scope(self):
        rr = adapter.review_receipt
        paths = [{"path": "gone.py", "disposition": "deleted"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": rr.digest(paths), "policy": rr.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = rr.current_equivalence(capture)
        document = {"version": 1, "source": {"repo": "owner/repo", "pr": 1},
                    "capture": capture, "outcome": "terminal-with-findings", "counted": True,
                    "classification": {"counted": True, "outcome": "completed"}}
        with tempfile.TemporaryDirectory() as td:
            receipt = rr.write_receipt(td, document)
            original = {"id": "original", "kind": "merged-current", "state": "done",
                        "receipt_id": receipt, "subject": document["source"], "capture": capture}
            reused = {**original, "id": "reused", "subject": {"repo": "owner/repo", "pr": 2},
                      "capture": {**capture, "captured_at": "later", "base": "c" * 40},
                      "reused_from": "original"}
            queue = {"items": [original, reused]}
            summary = adapter.merged_current(queue, td)
            self.assertEqual(summary["receipts"]["proven_terminal"], 2)
            self.assertEqual(summary["path_exclusions"], {"deleted": 2})
            for bad in ({"reused_from": "missing"}, {"reused_from": "reused"},
                        {"capture": {**reused["capture"], "target": "d" * 40}},
                        {"receipt_id": "e" * 64}, {"state": "unsupported"}):
                with self.subTest(bad=bad):
                    result = adapter.merged_current({"items": [original, {**reused, **bad}]}, td)
                    self.assertEqual(result["receipts"]["unverified"], 1)
                    self.assertEqual(result["receipts"]["proven_terminal"], 1)
