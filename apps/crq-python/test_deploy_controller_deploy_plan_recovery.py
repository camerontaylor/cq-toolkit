"""Q7 deployment controller characterization: switch recovery and journal.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures). This
module holds the switch/recovery/journal half of ``DeployPlanTests``; the
refusal half is in ``test_deploy_controller_deploy_plan``.

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import json
from pathlib import Path
from unittest import mock

from test_deploy_controller_fixtures import DeployPlanFixture, dc, host


class DeployPlanTests(DeployPlanFixture):
    def test_private_intent_is_durable_before_helper_and_not_a_rollback_input(self):
        actual_switch = host.switch
        actual_fsync = dc.os.fsync
        syncs = []

        def fsync(fd):
            kind = "directory" if dc.os.fstat(fd).st_mode & 0o170000 == 0o040000 else "file"
            actual_fsync(fd)
            syncs.append(kind)

        def switch(*args):
            self.assertEqual(syncs, ["file", "directory"])  # both completed before helper
            path = next(self.record_dir.glob("controller-*.json"))
            pending = json.loads(path.read_text())
            self.assertEqual(pending["operation"], "deploy_pending")
            self.assertEqual(pending["outcome"], "pending")
            self.assertEqual(pending["prior_head"], self.before)
            self.assertEqual(pending["target"], self.target)
            self.assertFalse(pending["automatic_rollback_permitted"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.record_dir.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(dc.Refused):
                dc.rollback_target(pending)
            return actual_switch(*args)

        with self.fake_switch(), mock.patch.object(dc.os, "fsync", side_effect=fsync):
            with mock.patch.object(host, "switch", side_effect=switch):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        completed = json.loads(next(self.record_dir.glob("controller-*.json")).read_text())
        self.assertEqual(completed["outcome"], "completed")
        self.assertEqual(len(completed["transaction_id"]), 32)

    def test_preservation_failure_after_real_switch_requires_recovery(self):
        actual_switch = host.switch

        def switch(*args):
            actual_switch(*args)
            self.write_state("queue.json", {"items": [], "changed": True})

        with self.fake_switch(), mock.patch.object(host, "switch", side_effect=switch):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, record = self.assert_recovery(raised.exception, "preservation")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertTrue(recovery["record_persisted"])
        self.assertEqual(record["outcome"], "recovery_required")
        self.assertTrue(json.loads((self.runner / "state/queue.json").read_text())["changed"])

    def test_post_switch_compatibility_exception_requires_recovery(self):
        real_compatibility = dc.compatibility_record
        calls = []

        def compatibility(*args):
            calls.append(args)
            if len(calls) == 2:
                raise TypeError("post-switch compatibility unavailable")
            return real_compatibility(*args)

        with self.fake_switch(), mock.patch.object(dc, "compatibility_record", side_effect=compatibility):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, _ = self.assert_recovery(raised.exception, "compatibility")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertIn("TypeError", recovery["reason"])

    def test_failed_completion_and_recovery_replace_keep_original_intent(self):
        replace = dc.os.replace

        def fail_final(source, target):
            entry = json.loads(Path(source).read_text())
            if entry.get("outcome") in {"completed", "recovery_required"}:
                raise OSError("record volume became unavailable")
            return replace(source, target)

        with self.fake_switch(), mock.patch.object(dc.os, "replace", side_effect=fail_final):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, pending = self.assert_recovery(raised.exception, "journal")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertFalse(recovery["record_persisted"])
        self.assertIn("record volume", recovery["record_write_error"])
        self.assertEqual(pending["outcome"], "pending")
        self.assertEqual(pending["transaction_id"], recovery["transaction_id"])
        self.assertEqual(len(list(self.record_dir.iterdir())), 1)

    def test_partial_helper_checkout_then_refusal_requires_recovery(self):
        def partial(*_args):
            self.command("restore", "--", host.CONFIG)
            self.command("checkout", "-q", "--detach", self.target)
            raise dc.Refused("helper failed after checkout")

        with mock.patch.object(host, "switch", side_effect=partial):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, _ = self.assert_recovery(raised.exception, "helper")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertIn("Refused", recovery["reason"])

    def test_helper_exception_after_checkout_remains_recovery_required(self):
        def partial(*_args):
            self.command("restore", "--", host.CONFIG)
            self.command("checkout", "-q", "--detach", self.target)
            raise ValueError("post-switch status must contain only rendered config")

        with mock.patch.object(host, "switch", side_effect=partial):
            with self.assertRaises(dc.RecoveryRequired) as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, record = self.assert_recovery(raised.exception, "helper")
        self.assertEqual(recovery["observed_head"], self.target)
        self.assertEqual(record["outcome"], "recovery_required")

    def test_any_changed_or_unobservable_surface_remains_recovery_required(self):
        def unit_changed(*_args):
            (self.units_home / "crq-tick.timer").write_text("[Timer]\nOnCalendar=*:0/5\n")
            raise ValueError("helper failed after unit change")

        def status_changed(*_args):
            (self.root / "stray.txt").write_text("untracked\n")
            raise ValueError("helper failed after writing into the checkout")

        def state_changed(*_args):
            self.write_state("queue.json", {"items": [], "starts": [], "x": 1})
            raise ValueError("helper failed after touching state")

        for side_effect in (unit_changed, status_changed, state_changed):
            with self.subTest(side_effect=side_effect.__name__):
                for path in self.record_dir.glob("controller-*.json"):
                    path.unlink()
                with mock.patch.object(host, "switch", side_effect=side_effect):
                    with self.assertRaises(dc.RecoveryRequired) as raised:
                        dc.deploy_plan(self.effects, host, self.target, self.tag,
                                       self.overlay_path)
                self.assert_recovery(raised.exception, "helper")
                (self.root / "stray.txt").unlink(missing_ok=True)
                (self.units_home / "crq-tick.timer").write_text("[Timer]\n")
                self.write_state("queue.json", {"items": [
                    {"id": "pr1", "kind": "merged", "state": "done"}], "starts": []})
        # Unchanged surfaces that cannot be observed are never absence proof.
        for path in self.record_dir.glob("controller-*.json"):
            path.unlink()
        with mock.patch.object(host, "switch", side_effect=ValueError("early")):
            with mock.patch.object(dc, "no_change_observation",
                                   side_effect=OSError("units unreadable")):
                with self.assertRaises(dc.RecoveryRequired) as raised:
                    dc.deploy_plan(self.effects, host, self.target, self.tag,
                                   self.overlay_path)
        self.assert_recovery(raised.exception, "helper")

    def test_failed_head_observation_preserves_original_mutation_failure(self):
        def partial(*_args):
            self.effects.config_path.write_bytes(b"partial config\n")
            raise OSError("original helper failure")

        actual_git = self.effects.git

        def git(*args):
            if args == ("rev-parse", "HEAD") and self.effects.config_path.read_bytes() == b"partial config\n":
                raise TypeError("HEAD observation unavailable")
            return actual_git(*args)

        with mock.patch.object(host, "switch", side_effect=partial):
            with mock.patch.object(self.effects, "git", side_effect=git):
                with self.assertRaises(dc.RecoveryRequired) as raised:
                    dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        recovery, record = self.assert_recovery(raised.exception, "helper")
        self.assertIn("original helper failure", recovery["reason"])
        self.assertIn("TypeError: HEAD observation unavailable", recovery["head_observation_error"])
        self.assertNotIn("observed_head", recovery)
        self.assertTrue(recovery["record_persisted"])
        self.assertEqual(record["head_observation_error"], recovery["head_observation_error"])

    def test_config_only_partial_helper_failure_cli_reports_recovery_exit_three(self):
        def partial(*_args):
            self.effects.config_path.write_bytes(b"partial config\n")
            raise ValueError("helper failed before checkout")

        with mock.patch.object(host, "switch", side_effect=partial):
            with mock.patch.object(dc, "_load_helper", return_value=(host, "0" * 64)):
                with mock.patch.object(dc, "Effects", return_value=self.effects):
                    with mock.patch("builtins.print") as printed:
                        code = dc.main(["--root", str(self.root), "--overlay", str(self.overlay_path),
                                        "--record-dir", str(self.record_dir), "switch",
                                        "--sha", self.target, "--tag", self.tag])
        self.assertEqual(code, 3)
        result = json.loads(next(c.args[0] for c in printed.call_args_list
                                 if not c.kwargs.get("file")))
        self.assertEqual(result["outcome"], "recovery_required")
        self.assertEqual(result["observed_head"], self.before)  # unchanged HEAD is not absence proof
        self.assertTrue(result["record_persisted"])
        self.assertEqual(self.effects.config_path.read_bytes(), b"partial config\n")
        self.assertTrue(any("recovery required:" in c.args[0] for c in printed.call_args_list))

    def test_successful_switch_records_journal_and_preserves_state(self):
        # The prior target must carry its own annotated tag for the journal to
        # name it; the fixture provides one alongside the target tag.
        self.command("tag", "-a", "crq-runner/20261027-9", self.before,
                     "-m", "prior fixture approval")
        digest = "ab" * 32
        with self.fake_switch():
            plan = dc.deploy_plan(self.effects, host, self.target, self.tag,
                                  self.overlay_path, helper_sha256=digest)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)
        self.assertEqual(plan["helper_sha256"], digest)
        steps = {step["step"]: step for step in plan["steps"]}
        self.assertTrue(steps["drain"]["drained"])
        self.assertTrue(steps["preservation"]["preserved"])
        journals = list(self.record_dir.glob("controller-*.json"))
        self.assertEqual(len(journals), 1)
        entry = json.loads(journals[0].read_text())
        self.assertEqual(entry["operation"], "deploy")
        self.assertEqual(entry["schema_version"], dc.JOURNAL_SCHEMA)
        # P1-1 regression: the journal itself is a valid rollback input.
        self.assertEqual(entry["prior_head"], self.before)
        self.assertEqual(entry["prior_tag"], "crq-runner/20261027-9")
        self.assertEqual(entry["tag"], self.tag)
        self.assertEqual(entry["target"], self.target)
        self.assertEqual(entry["helper_sha256"], digest)  # #549: what ran
        self.assertTrue(entry["rollback_compatibility"])
        self.assertTrue(dc.rollback_target(entry)["prior_head"] == self.before)
        self.assertTrue(plan["automatic_rollback_permitted"])
        self.assertEqual(journals[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.record_dir.stat().st_mode & 0o777, 0o700)
        # state was never copied, restored or rewritten
        self.assertEqual(json.loads((self.runner / "state/queue.json").read_text()),
                         {"items": [{"id": "pr1", "kind": "merged", "state": "done"}],
                          "starts": []})

    def test_generated_journal_roundtrips_through_rollback_after_a_switch(self):
        """End-to-end offline roundtrip: deploy through the controller, then
        roll back by feeding the journal the deploy wrote to the CLI's exact
        rollback path. The prior target must carry its own annotated tag."""
        self.command("tag", "-a", "crq-runner/20261027-9", self.before,
                     "-m", "prior fixture approval")
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        journals = sorted(self.record_dir.glob("controller-*.json"))
        self.assertEqual(len(journals), 1)
        entry = json.loads(journals[0].read_text())
        self.assertEqual(entry["prior_head"], self.before)
        self.assertEqual(entry["prior_tag"], "crq-runner/20261027-9")
        self.assertTrue(entry["automatic_rollback_permitted"])
        with self.fake_switch():
            result = dc.rollback_plan(self.effects, host, entry, self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(result["rolled_back_to"], self.before)
        self.assertEqual(result["tag"], "crq-runner/20261027-9")

    def test_journal_without_prior_tag_records_none_and_rollback_refuses(self):
        """No annotated tag names the prior target: the journal records
        prior_tag null and the rollback fails stopped (owner supplies the
        approval artifact), never a guessed tag."""
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        entry = json.loads(next(iter(self.record_dir.glob("controller-*.json"))).read_text())
        self.assertIsNone(entry["prior_tag"])
        with self.fake_switch():
            with self.assertRaisesRegex(dc.Refused, "prior_tag"):
                dc.rollback_plan(self.effects, host, entry, self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)

    def test_controller_restart_after_completed_switch_is_safe(self):
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        # A restarted controller observes the checkout already at target and the
        # preserved surfaces unchanged: a fresh preflight passes, drain is quiet.
        pre = dc.preflight(self.effects, self.target, self.tag)
        self.assertEqual(pre["state"]["prior_head"], self.target)
        drain = dc.drain_check(self.effects, dc._refusing_liveness)
        self.assertTrue(drain["drained"])
