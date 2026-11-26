"""A corrupt retained .json is skipped; a later valid record is still returned."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import ledger_vector_emit_b1 as base
import review_ledger as ledger
import review_transport


class RetainedRecordsCorruptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.pending = self.state / "backfill/publication/pending"
        self.pending.mkdir(parents=True)
        self.runner = SimpleNamespace(STATE=self.state)
        self.valid = base._review()

    def write_valid(self, name="9-valid.json"):
        (self.pending / name).write_bytes(ledger.canonical(self.valid))

    def test_truncated_json_is_skipped_and_the_later_valid_record_returned(self):
        (self.pending / "0-broken.json").write_bytes(b'{"event_type": "review", "id"')
        self.write_valid()
        self.assertEqual([r["id"] for r in review_transport._retained_records(self.runner)],
                         [self.valid["id"]])

    def test_invalid_utf8_is_skipped_and_the_later_valid_record_returned(self):
        (self.pending / "0-bytes.json").write_bytes(b'{"a": "\xff\xfe"}')
        self.write_valid()
        self.assertEqual([r["id"] for r in review_transport._retained_records(self.runner)],
                         [self.valid["id"]])

    def test_only_corrupt_files_yield_no_records_instead_of_raising(self):
        (self.pending / "0-broken.json").write_bytes(b"{broken")
        self.assertEqual(review_transport._retained_records(self.runner), [])


if __name__ == "__main__":
    unittest.main()
