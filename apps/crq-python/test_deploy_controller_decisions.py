"""Q7 deployment controller characterization: rollback and helper decisions.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import hashlib
from pathlib import Path
import tempfile
import unittest

from test_deploy_controller_fixtures import ControllerFixture, dc


class RollbackDecisionTests(unittest.TestCase):
    def test_absent_marker_with_clean_state_permits_rollback(self):
        self.assertTrue(dc.rollback_compatible(
            {"checked": True, "schema_observations": [],
             "schema_marker_present": False, "queue_schema": None}))

    def test_every_unprovable_shape_disables_automatic_rollback(self):
        absent = {"checked": True, "schema_observations": [],
                  "schema_marker_present": False, "queue_schema": None}
        for record in [
                # explicit marker of ANY value, including the old sentinel string
                {**absent, "schema_marker_present": True, "queue_schema": 2},
                {**absent, "schema_marker_present": True, "queue_schema": 1},
                {**absent, "schema_marker_present": True,
                 "queue_schema": "unmarked"},
                {**absent, "schema_marker_present": True,
                 "queue_schema": "unreadable: boom"},
                {**absent, "schema_marker_present": True, "queue_schema": None},
                {"checked": True, "schema_observations": [],
                 "schema_marker_present": True, "queue_schema": "unmarked"},
                # author_* state keys
                {**absent, "schema_observations": ["author_requests"]},
                {**absent, "schema_observations": ["author_observations"]},
                # missing/unchecked/malformed records fail closed
                {"checked": False, "schema_observations": [],
                 "schema_marker_present": False},
                {},
                None,
                # malformed presence values: only literal False proves absence
                {**absent, "schema_marker_present": None},
                {**absent, "schema_marker_present": 0},
                {**absent, "schema_marker_present": "False"},
                {**absent, "schema_marker_present": 1}]:
            with self.subTest(record=record):
                self.assertFalse(dc.rollback_compatible(record))

    def test_record_without_presence_field_fails_closed(self):
        # An old-shape journal that predates schema_marker_present must not
        # be accepted: absence must be PROVEN by an explicit boolean.
        self.assertFalse(dc.rollback_compatible(
            {"checked": True, "schema_observations": [],
             "queue_schema": "unmarked"}))


class CompatibilityRecordTests(ControllerFixture):
    def test_untagged_shape_records_absence_and_permits_rollback(self):
        self.write_state("queue.json", {"items": [], "starts": []})
        record = dc.compatibility_record(self.effects, self.target)
        self.assertIs(record["schema_marker_present"], False)
        self.assertIsNone(record["queue_schema"])
        self.assertEqual(record["schema_observations"], [])
        self.assertTrue(dc.rollback_compatible(record))

    def test_author_state_keys_are_observed_and_disable_rollback(self):
        self.write_state("queue.json",
                         {"items": [], "author_requests": {"r1": {}},
                          "author_observations": []})
        record = dc.compatibility_record(self.effects, self.target)
        self.assertEqual(sorted(record["schema_observations"]),
                         ["author_observations", "author_requests"])
        self.assertFalse(dc.rollback_compatible(record))

    def test_explicit_schema_marker_is_recorded_with_presence(self):
        for marker in [2, 1, "unmarked", "legacy-v0", None, True]:
            with self.subTest(marker=marker):
                self.write_state("queue.json",
                                 {"items": [], "schema_version": marker})
                record = dc.compatibility_record(self.effects, self.target)
                self.assertIs(record["schema_marker_present"], True)
                self.assertEqual(record["queue_schema"], marker)
                # ANY explicit marker value disables rollback, even "unmarked".
                self.assertFalse(dc.rollback_compatible(record))

    def test_missing_queue_is_unreadable_never_empty_and_fails_closed(self):
        (self.runner / "state").mkdir(exist_ok=True)
        record = dc.compatibility_record(self.effects, self.target)
        self.assertIn("unreadable", record["queue_schema"])
        self.assertIs(record["schema_marker_present"], True)
        self.assertFalse(dc.rollback_compatible(record))
        # Same evidence, same verdict: the drain refuses it too.
        with self.assertRaisesRegex(dc.Refused, "queue unreadable"):
            dc.drain_check(self.effects, lambda *a: "harvest")

    def test_non_object_queue_root_is_recorded_unreadable_not_raised(self):
        for root in (None, [1], "str", 7):
            with self.subTest(root=root):
                self.write_state("queue.json", root)
                record = dc.compatibility_record(self.effects, self.target)
                self.assertIn("not a JSON object", record["queue_schema"])
                self.assertIs(record["schema_marker_present"], True)
                self.assertFalse(dc.rollback_compatible(record))

    def test_unreadable_queue_is_recorded_not_crashed_and_fails_closed(self):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text("[[[")
        record = dc.compatibility_record(self.effects, self.target)
        self.assertIn("unreadable", record["queue_schema"])
        self.assertIs(record["schema_marker_present"], True)
        self.assertFalse(dc.rollback_compatible(record))


class HelperIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-helper-")
        self.addCleanup(self.temp.cleanup)
        self.sentinel = Path(self.temp.name) / "imported"
        self.helper = Path(self.temp.name) / "prepare-host.py"
        self.helper.write_text("from pathlib import Path\n"
                               "Path(%r).write_text('ran')\nVALUE = 7\n"
                               % str(self.sentinel))
        self.digest = hashlib.sha256(self.helper.read_bytes()).hexdigest()

    def test_digest_is_computed_and_returned_with_the_module(self):
        module, digest = dc._load_helper(self.helper)
        self.assertEqual(digest, self.digest)
        self.assertEqual(module.VALUE, 7)

    def test_matching_pin_loads_exactly_the_hashed_bytes(self):
        module, digest = dc._load_helper(self.helper, self.digest)
        self.assertEqual((module.VALUE, digest), (7, self.digest))
        self.assertTrue(self.sentinel.exists())

    def test_mismatch_or_malformed_pin_refuses_without_executing(self):
        for expected in ("0" * 64, self.digest.upper(), self.digest[:-1], ""):
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(dc.Refused, "helper"):
                    dc._load_helper(self.helper, expected)
                self.assertFalse(self.sentinel.exists())

    def test_unreadable_helper_refuses(self):
        with self.assertRaisesRegex(dc.Refused, "helper unreadable"):
            dc._load_helper(Path(self.temp.name) / "absent.py")
