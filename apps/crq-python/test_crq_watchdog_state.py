"""Offline tests for the atomic write_state in ops/crq-watchdog.py. No paseo, no network."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_watchdog_state", ROOT / "ops/crq-watchdog.py")
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)


class WriteStateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.st = self.dir / "watchdog-state.json"
        patch = mock.patch.object(wd, "ST", self.st)
        patch.start()
        self.addCleanup(patch.stop)

    def test_write_leaves_only_state_file(self):
        wd.write_state({"alerted_for": "x"})
        self.assertEqual(json.loads(self.st.read_text()), {"alerted_for": "x"})
        self.assertEqual([p.name for p in self.dir.iterdir()], [self.st.name])

    def test_replaces_existing_state(self):
        self.st.write_text('{"old": 1}\n')
        wd.write_state({"new": 2})
        self.assertEqual(json.loads(self.st.read_text()), {"new": 2})

    def test_fsync_before_replace(self):
        calls = []
        with mock.patch.object(wd.os, "fsync", side_effect=lambda fd: calls.append("fsync")), \
                mock.patch.object(wd.os, "replace", side_effect=lambda a, b: calls.append("replace")):
            wd.write_state({"a": 1})
        self.assertEqual(calls, ["fsync", "replace"])

    def test_temp_removed_when_replace_fails(self):
        self.st.write_text('{"old": 1}\n')
        with mock.patch.object(wd.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                wd.write_state({"new": 2})
        self.assertEqual(json.loads(self.st.read_text()), {"old": 1})
        self.assertEqual([p.name for p in self.dir.iterdir()], [self.st.name])

    def test_temp_removed_when_write_fails(self):
        with mock.patch.object(wd.json, "dumps", side_effect=ValueError("bad")):
            with self.assertRaises(ValueError):
                wd.write_state({"new": 2})
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_temp_removed_when_fsync_fails(self):
        with mock.patch.object(wd.os, "fsync", side_effect=OSError("io")):
            with self.assertRaises(OSError):
                wd.write_state({"new": 2})
        self.assertEqual(list(self.dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
