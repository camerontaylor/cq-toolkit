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


class SummaryTest(unittest.TestCase):
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
