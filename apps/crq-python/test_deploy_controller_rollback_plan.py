"""Q7 deployment controller characterization: rollback plan execution.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import fcntl
import json
from pathlib import Path
import subprocess
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc, host


class RollbackPlanTests(ControllerFixture):
    def setUp(self):
        super().setUp()
        self.write_state("queue.json", {"items": [], "starts": []})
        self.rendered()
        self.prior = {"schema_version": dc.JOURNAL_SCHEMA, "operation": "deploy",
                      "at": "2026-10-27T00:00:00Z",
                      "prior_head": self.before, "prior_tag": "crq-runner/20261027-9",
                      "tag": self.tag, "target": self.target,
                      "rollback_compatibility": {"checked": True,
                                                 "schema_observations": [],
                                                 "schema_marker_present": False,
                                                 "queue_schema": None}}
        self.command("tag", "-a", "crq-runner/20261027-9", self.before,
                     "-m", "prior fixture approval")

    def fake_switch(self):
        def run(argv):
            if argv[0] == "systemctl":
                return self.stopped(argv)
            return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
        return mock.patch.object(host, "run", side_effect=run)

    def at_target(self):
        with self.fake_switch():
            host.switch(self.root, self.overlay, self.raw, self.target, self.tag)

    def test_active_runner_refuses_before_drain_or_switch(self):
        self.at_target()
        with mock.patch.object(host, "inactive", side_effect=ValueError("active tick")), \
             mock.patch.object(dc, "drain_check") as drain, \
             mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "stopped before checking drain"):
                dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        drain.assert_not_called()
        switch.assert_not_called()

    def test_old_deploy_journal_refuses_after_a_second_completed_deployment(self):
        # Construct C before exercising the actual A -> B -> C controller path.
        self.command("restore", "--", host.CONFIG)
        self.command("checkout", "-q", "--detach", self.target)
        (self.root / "third-release").write_text("third release\n")
        self.command("add", "third-release")
        self.command("commit", "-qm", "third release")
        third = self.command("rev-parse", "HEAD").strip()
        third_tag = "crq-runner/20261028-2"
        self.command("tag", "-a", third_tag, "-m", "third fixture approval")
        self.command("update-ref", "refs/remotes/origin/main", third)
        self.command("checkout", "-q", "--detach", self.before)
        self.rendered()
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
            old_path = next(self.record_dir.glob("controller-*.json"))
            old_journal = json.loads(old_path.read_text())
            dc.deploy_plan(self.effects, host, third, third_tag, self.overlay_path)
        self.assertEqual(old_journal["prior_head"], self.before)
        self.assertEqual(old_journal["target"], self.target)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), third)
        before = dc.captured_state(self.effects)
        records = {p.name: p.read_bytes() for p in self.record_dir.iterdir()}
        with mock.patch.object(dc, "compatibility_record") as compatibility:
            with mock.patch.object(dc, "drain_check") as drain:
                with mock.patch.object(host, "switch") as switch:
                    with mock.patch.object(self.effects, "journal_append") as append:
                        with self.assertRaisesRegex(dc.Refused, "does not describe the current deployment"):
                            dc.rollback_plan(self.effects, host, old_journal, self.overlay_path)
                        compatibility.assert_not_called()
                        drain.assert_not_called()
                        switch.assert_not_called()
                        append.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)
        self.assertEqual({p.name: p.read_bytes() for p in self.record_dir.iterdir()}, records)

    def test_missing_or_malformed_deployed_target_cannot_authorize_rollback(self):
        missing = dict(self.prior)
        missing.pop("target")
        for prior in [missing, *[{**self.prior, "target": value} for value in
                                [None, False, [], {}, "", "a" * 39, "A" * 40,
                                 self.target + "\n", "a" * 41]]]:
            with self.subTest(prior=prior):
                with self.assertRaisesRegex(dc.Refused, "valid deployed target SHA"):
                    dc.rollback_target(prior)

    def test_matching_deployed_target_is_checked_under_controller_lock(self):
        self.at_target()
        actual_git = self.effects.git
        observed = []

        def git(*args):
            if args == ("rev-parse", "HEAD"):
                with (self.effects.state_dir() / dc.LOCK_NAME).open("a") as competing:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(competing, fcntl.LOCK_EX | fcntl.LOCK_NB)
                observed.append(actual_git(*args))
                return observed[-1]
            return actual_git(*args)

        with self.fake_switch(), mock.patch.object(self.effects, "git", side_effect=git):
            result = dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        self.assertTrue(observed)
        self.assertEqual(observed[0], self.prior["target"])
        self.assertEqual(result["rolled_back_to"], self.before)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)

    def test_rollback_bad_record_mode_refuses_before_helper(self):
        self.at_target()
        self.record_dir.chmod(0o755)
        before = dc.captured_state(self.effects)
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "mode 0700"):
                dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
            switch.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)

    def test_rollback_final_write_failure_retains_intent_and_requires_recovery(self):
        self.at_target()
        replace = dc.os.replace

        def fail_final(source, target):
            entry = json.loads(Path(source).read_text())
            if entry.get("outcome") in {"completed", "recovery_required"}:
                raise OSError("rollback record write failed")
            return replace(source, target)

        with self.fake_switch(), mock.patch.object(dc.os, "replace", side_effect=fail_final):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        recovery = raised.exception.recovery
        self.assertEqual(recovery["intended_operation"], "rollback")
        self.assertEqual(recovery["prior_head"], self.target)
        self.assertEqual(recovery["observed_head"], self.before)
        self.assertEqual(recovery["target"], self.before)
        self.assertFalse(recovery["automatic_rollback_permitted"])
        self.assertFalse(recovery["record_persisted"])
        pending = json.loads(Path(recovery["record_path"]).read_text())
        self.assertEqual(pending["operation"], "rollback_pending")
        with self.assertRaises(dc.Refused):
            dc.rollback_target(pending)

    def test_rollback_partial_config_failure_never_claims_no_change(self):
        self.at_target()

        def partial(*_args):
            self.effects.config_path.write_bytes(b"partial rollback config\n")
            raise OSError("rollback helper failed before checkout")

        with mock.patch.object(host, "switch", side_effect=partial):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        recovery = raised.exception.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["failed_phase"], "helper")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertEqual(recovery["prior_head"], self.target)
        self.assertEqual(recovery["target"], self.before)
        self.assertTrue(recovery["record_persisted"])
        self.assertEqual(self.effects.config_path.read_bytes(), b"partial rollback config\n")

    def test_pending_recovery_and_unknown_outcomes_are_not_rollback_inputs(self):
        for outcome in ["pending", "recovery_required", "refused_no_change",
                        "unknown", None, False]:
            with self.subTest(outcome=outcome):
                with self.assertRaisesRegex(dc.Refused, "completed deploy journal"):
                    dc.rollback_target({**self.prior, "outcome": outcome})

    def test_compatible_rollback_returns_to_recorded_prior_target(self):
        self.at_target()
        with self.fake_switch():
            result = dc.rollback_plan(self.effects, host, self.prior,
                                      self.overlay_path, helper_sha256="cd" * 32)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(result["rolled_back_to"], self.before)
        self.assertEqual(result["helper_sha256"], "cd" * 32)
        journals = [json.loads(p.read_text())
                    for p in self.record_dir.glob("controller-*.json")]
        self.assertEqual([j["operation"] for j in journals], ["rollback"])
        self.assertEqual(journals[0]["helper_sha256"], "cd" * 32)

    def test_post_journal_author_requests_refuse_after_drain_before_switch(self):
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        journal_paths = list(self.record_dir.glob("controller-*.json"))
        prior = json.loads(journal_paths[0].read_text())
        self.assertTrue(dc.rollback_compatible(prior["rollback_compatibility"]))
        self.write_state("queue.json", {"items": [], "starts": [],
                                       "author_requests": {"new-request": {}}})
        queue_bytes = (self.runner / "state/queue.json").read_bytes()
        with mock.patch.object(dc, "drain_check",
                               return_value={"drained": True, "blocked": []}) as drain:
            with mock.patch.object(host, "switch") as helper_switch:
                with self.assertRaisesRegex(dc.Refused, "current queue state"):
                    dc.rollback_plan(self.effects, host, prior, self.overlay_path)
                drain.assert_called_once()
                helper_switch.assert_not_called()
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)
        self.assertEqual((self.runner / "state/queue.json").read_bytes(), queue_bytes)
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), journal_paths)

    def test_post_journal_compatible_state_rechecked_under_lock_and_rolls_back(self):
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        prior = json.loads(next(self.record_dir.glob("controller-*.json")).read_text())
        self.write_state("queue.json", {"items": [], "starts": [123],
                                       "last_tick": "2026-10-28T01:00:00Z"})
        queue_bytes = (self.runner / "state/queue.json").read_bytes()
        real_compatibility = dc.compatibility_record

        def check_locked(effects, target):
            self.assertEqual(target, self.before)
            with (effects.state_dir() / dc.LOCK_NAME).open("a") as competing:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(competing, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return real_compatibility(effects, target)

        with mock.patch.object(dc, "compatibility_record", side_effect=check_locked) as check:
            with self.fake_switch():
                result = dc.rollback_plan(self.effects, host, prior, self.overlay_path)
            check.assert_called_once_with(self.effects, self.before)
        self.assertEqual(result["rolled_back_to"], self.before)
        self.assertEqual(result["tag"], prior["prior_tag"])
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual((self.runner / "state/queue.json").read_bytes(), queue_bytes)
        journals = [json.loads(p.read_text())
                    for p in self.record_dir.glob("controller-*.json")]
        self.assertEqual(sorted(j["operation"] for j in journals), ["deploy", "rollback"])

    def test_schema_incompatible_prior_target_disables_automatic_rollback(self):
        self.at_target()
        incompatible = {**self.prior,
                        "rollback_compatibility": {"checked": True,
                                                   "schema_observations": [],
                                                   "schema_marker_present": True,
                                                   "queue_schema": 2}}
        with mock.patch.object(host, "switch") as helper_switch:
            with self.assertRaisesRegex(dc.Refused, "rollback disabled"):
                dc.rollback_plan(self.effects, host, incompatible,
                                 self.overlay_path)
            helper_switch.assert_not_called()
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)

    def test_unknown_or_foreign_prior_record_is_refused(self):
        self.at_target()
        for prior in [{}, None, {"operation": "deploy", "prior_head": self.before},
                      {"schema_version": 99, "operation": "deploy",
                       "prior_head": self.before, "tag": self.tag,
                       "rollback_compatibility": self.prior["rollback_compatibility"]},
                      {"schema_version": 1, "operation": "rollback",
                       "prior_head": self.before, "tag": self.tag,
                       "rollback_compatibility": self.prior["rollback_compatibility"]},
                      {"schema_version": 1, "operation": "deploy",
                       "prior_head": self.before, "tag": "lightweight-not",
                       "rollback_compatibility": self.prior["rollback_compatibility"]},
                      {"schema_version": 1, "operation": "deploy",
                       "prior_head": self.before, "tag": self.tag,
                       "rollback_compatibility": self.prior["rollback_compatibility"]}]:
            with self.subTest(prior=prior):
                with mock.patch.object(host, "switch") as helper_switch:
                    with self.assertRaisesRegex(dc.Refused, "prior record"):
                        dc.rollback_plan(self.effects, host, prior,
                                         self.overlay_path)
                    helper_switch.assert_not_called()
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)

    def test_missing_prior_sha_refuses_blind_rollback(self):
        self.at_target()
        with self.assertRaisesRegex(dc.Refused, "no recorded prior target"):
            dc.rollback_plan(self.effects, host,
                             {"schema_version": 1, "operation": "deploy",
                              "prior_tag": "crq-runner/20261027-9",
                              "rollback_compatibility": self.prior["rollback_compatibility"]},
                             self.overlay_path)

    def test_rollback_refuses_with_live_reviews(self):
        self.at_target()
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": {"run_id": "e" * 32}}]})
        with self.assertRaisesRegex(dc.Refused, "live/ambiguous"):
            dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)

    def test_corrupt_run_metadata_blocks_rollback(self):
        self.at_target()
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": "damaged-record"}]})
        with self.assertRaisesRegex(dc.Refused, "live/ambiguous"):
            dc.rollback_plan(self.effects, host, self.prior, self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)

    def test_deploy_journal_roundtrip_drives_rollback(self):
        """The rollback input is EXACTLY the file deploy_plan wrote: generate a
        real journal, feed it back through the same path the CLI uses, and
        assert the prior identity survives the roundtrip."""
        self.at_target()
        plan = {"preflight": {"state": {"prior_head": self.before,
                                        "prior_config_sha256": "0" * 64},
                              "target": self.target, "tag": self.tag},
                "steps": [],
                "rollback_compatibility_after": {"checked": True,
                                                 "schema_observations": [],
                                                 "schema_marker_present": False,
                                                 "queue_schema": None},
                "automatic_rollback_permitted": True}
        journal = dc.deploy_journal(
            plan["preflight"]["state"], self.target, self.tag, plan,
            prior_tag="crq-runner/20261027-9")
        # Serialize/deserialize like the CLI's --prior-record path does.
        path = self.base / "journal.json"
        path.write_bytes((json.dumps(journal, indent=2, sort_keys=True) + "\n").encode())
        with self.fake_switch():
            result = dc.rollback_plan(self.effects, host, json.loads(path.read_text()),
                                      self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(result["rolled_back_to"], self.before)
        self.assertEqual(result["tag"], "crq-runner/20261027-9")
