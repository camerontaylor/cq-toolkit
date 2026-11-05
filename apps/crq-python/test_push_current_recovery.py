"""Operator recovery of scan-blocked push captures, using real local Git repos."""
import contextlib
import fcntl
import io
import json
import sys
import unittest
from unittest import mock

from test_push_current_fixtures import FOREIGN, PushTestBase, crq, push_current


class RecoveryTest(PushTestBase, unittest.TestCase):
    def blocked(self, *, big=False):
        files = {"code.py": "original = 1\n", "guide.md": "handshake sample\n"}
        if big:
            files.update({f"f{n}.py": "x" * 256000 + "\n" for n in range(9)})
        self.commit(self.foreign_origin, "range work", when=self.ago(2), files=files)
        item = self.enroll_push()
        self.launch(item, scan_ok=False)
        self.assertEqual(item["state"], "blocked")
        return item

    def recover(self, item, action="recapture", **over):
        args = {"reason": "corrected source example", "verdict": "source-fixed", "operator": "fixture-operator"}
        args.update(over)
        with mock.patch.object(crq, "write_status"):
            return crq.with_lock(push_current.recover, crq, item["id"], action, **args)

    def replacement(self, result):
        self.q = crq.load_queue()
        return next(i for i in self.q["items"] if i["id"] == result["replacement"])

    def test_recapture_preserves_debt_and_evidence_then_advances_after_counted_review(self):
        item = self.blocked()
        old = json.loads(json.dumps(item))
        receipt = (crq.STATE / "receipts" / (item["receipt_id"] + ".json")).read_bytes()
        tip = self.commit(self.foreign_origin, "fix and new work", when=self.ago(1),
                          files={"guide.md": "generated handshake nonce\n", "new.py": "new = 2\n"})
        with mock.patch.object(crq, "launch") as launch:
            result = self.recover(item)
        launch.assert_not_called()
        replacement = self.replacement(result)
        original = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(original["state"], "skipped")
        self.assertEqual(original["capture"], old["capture"])
        self.assertEqual(original["receipt_id"], old["receipt_id"])
        self.assertEqual((crq.STATE / "receipts" / (item["receipt_id"] + ".json")).read_bytes(), receipt)
        self.assertEqual(original["push_recovery"]["operator"], "fixture-operator")
        self.assertEqual(original["push_recovery"]["verdict"], "source-fixed")
        self.assertEqual(replacement["subject"]["base"], self.base)
        self.assertEqual(replacement["subject"]["head"], tip)
        self.assertEqual(replacement["capture"]["target"], tip)
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], self.base)
        patch = self.git(self.foreign, "diff", replacement["capture"]["base"], replacement["capture"]["head"])
        for content in ("original = 1", "generated handshake nonce", "new = 2"):
            self.assertIn(content, patch)
        self.assertNotIn("+handshake sample", patch)
        self.assertEqual(self.q["starts"], [])
        self.launch(replacement)
        self.harvest(replacement)
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], tip)
        next_tip = self.commit(self.foreign_origin, "next push", when=self.ago(1), files={"next.py": "next = 3\n"})
        self.discover()
        following = next(i for i in self.q["items"] if i.get("state") == "pending")
        self.assertEqual((following["subject"]["base"], following["subject"]["head"]), (tip, next_tip))

    def test_unchanged_content_can_be_recaptured_but_still_blocks_before_vendor(self):
        item = self.blocked()
        result = self.recover(item, verdict="false-positive")
        replacement = self.replacement(result)
        self.assertTrue(replacement["id"].endswith("-r1"))
        plan, wt, child, _ = self.launch(replacement, scan_ok=False)
        wt.assert_not_called()
        self.assertEqual(self.spawns(child), [])
        self.assertEqual(replacement["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        self.assertEqual(plan["target"], item["capture"]["target"])

    def test_release_waits_for_changed_tip_and_keeps_original_review_boundary(self):
        item = self.blocked()
        result = self.recover(item, "release", verdict="abandon")
        self.q = crq.load_queue()
        self.assertIsNone(result["replacement"])
        self.assertEqual(self.q["items"][0]["state"], "skipped")
        self.discover()
        self.assertEqual(len(self.q["items"]), 1)
        tip = self.commit(self.foreign_origin, "later push", when=self.ago(1), files={"next.py": "next = 3\n"})
        self.discover()
        following = next(i for i in self.q["items"] if i.get("state") == "pending")
        self.assertEqual((following["subject"]["base"], following["subject"]["head"]), (self.base, tip))
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], self.base)

    def test_recapture_replaces_unstarted_split_parts_without_id_collision(self):
        item = self.blocked(big=True)
        old_part = next(i for i in self.q["items"] if i.get("depends_on") == item["id"])
        result = self.recover(item)
        replacement = self.replacement(result)
        old_part = next(i for i in self.q["items"] if i["id"] == old_part["id"])
        self.assertEqual(old_part["state"], "skipped")
        new_part = next(i for i in self.q["items"] if i.get("depends_on") == replacement["id"])
        self.assertEqual(new_part["id"], replacement["id"] + "-p2")
        self.assertEqual(new_part["subject"]["paths_filter"], old_part["subject"]["paths_filter"])
        self.assertEqual(new_part["subject"]["pin"], replacement["capture"]["target"])

    def test_refuses_missing_metadata_dispatched_items_and_invalid_receipts_without_mutation(self):
        item = self.blocked()
        saved = crq.QUEUE.read_bytes()
        for change, options in (({}, {"reason": " "}), ({}, {"operator": " "}),
                                ({"state": "reviewing"}, {}), ({"run": {"run_id": "active"}}, {}),
                                ({"attempts": [{"counted": False}]}, {}),
                                ({"receipt_id": "0" * 64}, {}),
                                ({"subject": {**item["subject"], "head": "a" * 40}}, {})):
            with self.subTest(change=change, options=options):
                changed = json.loads(json.dumps(item))
                changed.update(change)
                q = crq.load_queue()
                q["items"] = [changed]
                crq.save_queue(q)
                before = crq.QUEUE.read_bytes()
                with self.assertRaises((ValueError, OSError)):
                    self.recover(changed, **options)
                self.assertEqual(crq.QUEUE.read_bytes(), before)
                crq.QUEUE.write_bytes(saved)

    def test_fetch_failure_and_rewritten_history_preserve_queue(self):
        item = self.blocked()
        before = crq.QUEUE.read_bytes()
        with mock.patch.object(crq, "fetch", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                self.recover(item)
        with mock.patch.object(crq, "is_ancestor", return_value=False):
            with self.assertRaisesRegex(ValueError, "rewritten"):
                self.recover(item)
        self.assertEqual(crq.QUEUE.read_bytes(), before)

    def test_receipt_tampering_or_non_scan_outcome_refuses_without_queue_mutation(self):
        item = self.blocked()
        path = crq.STATE / "receipts" / (item["receipt_id"] + ".json")
        document = json.loads(path.read_text())
        path.write_text("{}")
        before = crq.QUEUE.read_bytes()
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.recover(item)
        self.assertEqual(crq.QUEUE.read_bytes(), before)
        document["outcome"] = "terminal-clean"
        item["receipt_id"] = crq.review_receipt.write_receipt(crq.STATE / "receipts", document)
        crq.save_queue(self.q)
        before = crq.QUEUE.read_bytes()
        with self.assertRaisesRegex(ValueError, "matching blocked-secret-scan"):
            self.recover(item)
        self.assertEqual(crq.QUEUE.read_bytes(), before)

    def test_active_split_dispatch_refuses_and_split_release_cannot_drop_debt(self):
        item = self.blocked(big=True)
        part = next(i for i in self.q["items"] if i.get("depends_on") == item["id"])
        part.update(state="reviewing", run={"run_id": "in-flight"})
        crq.save_queue(self.q)
        before = crq.QUEUE.read_bytes()
        with self.assertRaisesRegex(ValueError, "dispatched range parts"):
            self.recover(item)
        self.assertEqual(crq.QUEUE.read_bytes(), before)
        # A parent may already have earned review credit while its overflow
        # remains blocked. Releasing just the overflow would lose that debt.
        part.update(state="blocked", run=None)
        self.prepare(part)
        part["receipt_id"] = crq.review_receipt.write_receipt(crq.STATE / "receipts",
            crq.current_document(part, "blocked-secret-scan"))
        item["state"] = "done"
        self.q["push_discovery"][FOREIGN]["reviewed_tip"] = item["capture"]["target"]
        crq.save_queue(self.q)
        before = crq.QUEUE.read_bytes()
        with self.assertRaisesRegex(ValueError, "recapture split debt"):
            self.recover(part, "release")
        self.assertEqual(crq.QUEUE.read_bytes(), before)
        result = self.recover(part)
        replacement = self.replacement(result)
        self.assertFalse(replacement["subject"].get("paths_filter"))
        self.assertEqual(replacement["subject"]["base"], self.base)
        self.assertTrue(any(r["disposition"] == "deferred-split" for r in replacement["capture"]["paths"]))

    def test_cli_records_operator_and_refuses_lock_contention(self):
        item = self.blocked()
        argv = ["crq", "push-recover", item["id"], "recapture", "--reason", "fix merged",
                "--operator", "fixture-cli", "--verdict", "source-fixed"]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(crq, "write_status"), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(crq.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["operator"], "fixture-cli")
        with crq.LOCK.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(crq.main(), 3)
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(crq.main(), 3)
        self.assertIn("scan-blocked", error.getvalue())


if __name__ == "__main__":
    unittest.main()
