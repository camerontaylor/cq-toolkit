"""UTC parsing is independent of the host timezone and never raises on bad data."""
import datetime as dt
import unittest

from queue_time import parse_utc


class QueueTimeTests(unittest.TestCase):
    def test_formats_represent_the_same_utc_instant(self):
        expected = dt.datetime(2026, 11, 8, 0, 0, 0, 500000, tzinfo=dt.timezone.utc)
        for value in ("2026-11-08T00:00:00.500Z", "2026-11-08T10:00:00.500+10:00",
                      "2026-11-08T00:00:00.500", "20261108T000000.500Z"):
            with self.subTest(value=value):
                self.assertEqual(parse_utc(value), expected)
                self.assertIs(parse_utc(value).tzinfo, dt.timezone.utc)

    def test_invalid_values_are_unknown(self):
        for value in (None, 123, [], {}, "", "garbage", "2026-13-08T00:00:00Z",
                      "0001-01-01T00:00:00+10:00"):
            with self.subTest(value=value):
                self.assertIsNone(parse_utc(value))
