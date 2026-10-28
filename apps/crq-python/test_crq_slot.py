"""Timestamp-first entry and nonblocking admission lock, entirely offline."""
import datetime as dt
import fcntl
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import crq_slot
import usage_slots

AT = dt.datetime(2026, 10, 28, 1, 1, tzinfo=dt.timezone.utc)


class FastEntryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.loader = mock.Mock(return_value=SimpleNamespace(slot=mock.Mock(return_value=[])))

    def test_future_timestamp_exits_before_import_lock_usage_or_directory_write(self):
        usage_slots.write_next(self.root / 'next-review-at', AT + dt.timedelta(minutes=30))
        real_import = __import__
        def guarded_import(name, *args, **kwargs):
            if name in ('crq', 'fcntl', 'usage_slots'):
                self.fail('future hint must not import ' + name)
            return real_import(name, *args, **kwargs)
        with mock.patch('builtins.__import__', side_effect=guarded_import), \
             mock.patch.object(crq_slot.os, 'makedirs') as mkdir:
            self.assertEqual(crq_slot.main(self.root, lambda: AT, self.loader), 0)
        mkdir.assert_not_called()
        self.loader.assert_not_called()
        self.assertFalse((self.root / 'tick.lock').exists())

    def test_lock_held_exits_before_runner_or_usage(self):
        with mock.patch.object(fcntl, 'flock', side_effect=BlockingIOError) as lock:
            self.assertEqual(crq_slot.main(self.root, lambda: AT, self.loader), 0)
        lock.assert_called_once()
        self.loader.assert_not_called()

    def test_due_and_malformed_hints_enter_runner_under_lock(self):
        for text in ('bad timestamp', AT.strftime('%Y-%m-%dT%H:%M:%SZ')):
            (self.root / 'next-review-at').write_text(text)
            with mock.patch.object(fcntl, 'flock') as lock:
                crq_slot.main(self.root, lambda: AT, self.loader)
            lock.assert_called_once()
        self.assertEqual(self.loader.return_value.slot.call_count, 2)

    def test_full_tick_refresh_while_waiting_for_lock_is_rechecked(self):
        with mock.patch.object(crq_slot, 'future', side_effect=[False, True]):
            crq_slot.main(self.root, lambda: AT, self.loader)
        self.loader.assert_not_called()
