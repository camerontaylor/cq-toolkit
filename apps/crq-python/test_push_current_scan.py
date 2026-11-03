"""Foreign-diff secret scan: universal vs publish classes and repo extras.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import json
import unittest
from unittest import mock

from test_push_current_fixtures import (FOREIGN, PushTestBase, _FLEET_PROSE, crq,
                                        repo_registry)


class PushTest(PushTestBase, unittest.TestCase):
    def test_publish_classes_do_not_block_foreign_diff(self):
        self.commit(self.foreign_origin, "fleet prose", when=self.ago(2),
                    files={"notes.md": _FLEET_PROSE})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn():
            crq.launch(self.q, item, self.prepare(item))
        self.assertEqual(item["state"], "reviewing")
        wt.assert_called_once()
        scan = self.scan_result(item)
        # Only the four universal secret-shape classes ran: publish vocabulary is
        # primary-only, so this fleet-prose diff is clean.
        self.assertEqual(scan["denylist_rules"], 4)
        self.assertEqual(scan["denylist_hits"], [])

    def test_universal_secret_class_blocks_foreign_diff(self):
        self.commit(self.foreign_origin, "leaked key", when=self.ago(2),
                    files={"deploy.sh": "#!/bin/sh\ncat <<'EOF'\n" + "-----BEGIN " + "OPENSSH PRIVATE KEY-----" + "\nEOF\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree") as wt, \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, self.prepare(item))
        wt.assert_not_called()
        self.assertEqual(self.spawns(child), [])
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        doc = self.document(item)
        self.assertEqual(doc["outcome"], "blocked-secret-scan")
        self.assertEqual(doc["source"]["type"], "push-range")
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:token-ssh-plumbing"])

    def test_unknown_extra_scan_class_fails_closed(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2), files={"code.py": "x = 1\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)),
                                scan_extra_classes=["class:does-not-exist"])
        plan = self.prepare(item)
        with mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaises(RuntimeError) as raised:
                crq.launch(self.q, item, plan)
        self.assertIn("unknown denylist rule", str(raised.exception))
        self.assertEqual(item["state"], "pending")
        self.assertEqual(self.q["starts"], [])

    def test_repo_extra_scan_class_blocks(self):
        self.commit(self.foreign_origin, "extra marker", when=self.ago(2),
                    files={"code.py": "value = 1  # fixture-extra-marker\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)),
                                scan_extra_classes=["class:fixture-extra"])
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree") as wt, \
             self.fake_spawn():
            run_id = crq.launch(self.q, item, self.prepare(item))
        wt.assert_not_called()
        self.assertEqual(item["state"], "blocked")
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual(scan["denylist_rules"], 5)  # four universal classes + the repo extra
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:fixture-extra"])

    def test_registry_scan_extra_classes_validation(self):
        for bad in ([5], "class:x", [None], ["a\nb"]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    repo_registry.parse_entry({"repo": FOREIGN, "clone": "/tmp/x", "scan_extra_classes": bad})
        self.assertEqual(repo_registry.parse_entry({"repo": FOREIGN, "clone": "/tmp/x"})["scan_extra_classes"],
                         [])
        self.assertEqual(repo_registry.parse_entry(
            {"repo": FOREIGN, "clone": "/tmp/x", "scan_extra_classes": ["class:x"]})["scan_extra_classes"],
            ["class:x"])


if __name__ == "__main__":
    unittest.main()
