"""Window boundaries and failure visibility for the crq producer summary."""
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from unittest import mock

ROOT = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader("crq_adapter", str(ROOT / "status_summary.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
adapter = importlib.util.module_from_spec(spec)
loader.exec_module(adapter)


class SummaryTest(unittest.TestCase):
    def test_publish_is_atomic_private_and_omits_queue_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            events = root / "state/events.jsonl"
            events.write_text('{"event":"review_finished","at":"2026-10-08T02:30:00Z","outcome":"completed","secret":"never publish"}\n')
            queue = {"last_tick": "2026-10-08T02:24:00Z", "items": [], "starts": []}
            config = {"max_starts_per_hour": 5, "schedule_id": "tick", "clone": "/private/clone"}
            with mock.patch.object(adapter, "command", return_value="12\n"):
                data = adapter.publish(root, queue, config, {"status": "active"}, home=root,
                                       now=adapter.timestamp("2026-10-08T03:00:00Z"))
            target = root / "Library/Application Support/crq/summary.json"
            self.assertEqual(json.loads(target.read_text()), data)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("never publish", target.read_text())
            self.assertNotIn("/private/clone", target.read_text())
            self.assertEqual(data["outcomes_24h"]["completed"], 1)
            self.assertEqual(data["promotion"]["merges_waiting"], 12)
            # Complete malformed events preserve the last good file.
            old = target.read_bytes()
            events.write_text('broken complete line\n')
            with self.assertRaises(json.JSONDecodeError):
                adapter.publish(root, queue, config, {}, home=root)
            self.assertEqual(target.read_bytes(), old)

    def test_failed_optional_probes_stay_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            # Ignore only a concurrently appended incomplete final record.
            (root / "state/events.jsonl").write_text('{"event":')
            with mock.patch.object(adapter, "command", side_effect=RuntimeError("unavailable")):
                data = adapter.publish(root, {"last_tick": "2026-10-08T02:24:00Z", "items": []},
                                       {"max_starts_per_hour": 5, "clone": "absent"}, {}, home=root)
            self.assertEqual(data["schedule"]["state"], "unknown")
            self.assertIsNone(data["promotion"]["merges_waiting"])

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
        self.assertEqual(data["backlog"], {"open": 1, "delta": 0, "merged": 0, "promotion": 0})
        self.assertEqual(data["promotion"]["blockers"], [{"item": "promo-blocked", "counts": {"major": 1}}])
        self.assertEqual(data["last_tick"], "2026-10-08T02:24:00Z")


if __name__ == "__main__":
    unittest.main()
