"""Q7 deployment controller characterization: deploy refusals and evidence.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures). This
module holds the refusal/no-change half of ``DeployPlanTests``; the switch,
recovery and journal half is in ``test_deploy_controller_deploy_plan_recovery``.

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import fcntl
import json
from pathlib import Path
from unittest import mock

from test_deploy_controller_fixtures import DeployPlanFixture, dc, host


class DeployPlanTests(DeployPlanFixture):
    def test_active_runner_refuses_before_drain_or_switch(self):
        with mock.patch.object(host, "inactive", side_effect=ValueError("active tick")), \
             mock.patch.object(dc, "drain_check") as drain, \
             mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "stopped before checking drain"):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        drain.assert_not_called()
        switch.assert_not_called()

    def test_missing_record_ancestors_refuse_before_intent_or_helper_without_creation(self):
        self.effects.record_dir = self.base / "not-provisioned" / "private" / "records"
        before = dc.captured_state(self.effects)
        with mock.patch.object(self.effects, "journal_append") as append:
            with mock.patch.object(host, "switch") as switch:
                with self.assertRaisesRegex(dc.Refused, "must already exist as a directory"):
                    dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
                append.assert_not_called()
                switch.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)
        self.assertFalse((self.base / "not-provisioned").exists())

    def test_record_directory_mode_refuses_before_helper_without_deploy_changes(self):
        self.record_dir.chmod(0o755)
        before = dc.captured_state(self.effects)
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "mode 0700"):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
            switch.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)
        self.assertEqual(list(self.record_dir.iterdir()), [])

    def test_record_directory_file_refuses_before_helper_without_deploy_changes(self):
        self.record_dir.rmdir()
        self.record_dir.write_text("not a directory")
        before = dc.captured_state(self.effects)
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "must already exist as a directory"):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
            switch.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)

    def test_ambiguous_prior_tag_refuses_before_helper_without_deploy_changes(self):
        for tag in ["crq-runner/20261027-8", "crq-runner/20261027-9"]:
            self.command("tag", "-a", tag, self.before, "-m", "ambiguous approval")
        before = dc.captured_state(self.effects)
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "multiple annotated runner tags"):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
            switch.assert_not_called()
        self.assertEqual(dc.captured_state(self.effects), before)
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), [])

    def test_bad_tag_is_a_plain_refusal_before_intent_or_helper(self):
        # The 20261103-1b case on the deploy host: an annotated tag the controller's
        # prefix check once accepted and the helper's full match rejects.
        bad = "crq-runner/20261103-1b"
        self.command("tag", "-a", bad, self.target, "-m", "non-numeric suffix")
        status = self.command("status", "--porcelain", "--untracked-files=all")
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "--tag must be"):
                dc.deploy_plan(self.effects, host, self.target, bad, self.overlay_path)
        switch.assert_not_called()
        self.assertEqual(self.records(), [])
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(self.command("status", "--porcelain", "--untracked-files=all"), status)

    def test_helper_input_validation_refuses_before_intent(self):
        # The helper's own validators run before the durable intent: a
        # rejection there (here, its tag check) is a no-change refusal.
        real_verify = host.verify_target

        def verify(root, target, tag):
            raise ValueError("runner annotated tag required")

        for patch in (mock.patch.object(host, "verify_target", side_effect=verify),
                      mock.patch.object(host, "root_check",
                                        side_effect=ValueError("not the overlay deployment checkout"))):
            with self.subTest(patch=patch.attribute):
                with patch, mock.patch.object(host, "switch") as switch:
                    with self.assertRaisesRegex(dc.Refused, "helper input validation refused"):
                        dc.deploy_plan(self.effects, host, self.target, self.tag,
                                       self.overlay_path)
                switch.assert_not_called()
                self.assertEqual(self.records(), [])
        self.assertIs(host.verify_target, real_verify)
        # A target the helper cannot verify through git is refused the same way.
        self.command("update-ref", "refs/remotes/origin/main", self.before)
        with mock.patch.object(host, "switch") as switch:
            with self.assertRaisesRegex(dc.Refused, "git check failed"):
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        switch.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_helper_exception_before_mutation_records_refused_no_change(self):
        def refuse(*_args):
            raise ValueError("refusing active or unknown unit: crq-tick.service")

        with mock.patch.object(host, "switch", side_effect=refuse):
            with self.assertRaisesRegex(dc.Refused, "observed unchanged") as raised:
                dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        self.assertIn("refused_no_change", str(raised.exception))
        [record] = self.records()
        self.assertEqual(record["outcome"], "refused_no_change")
        self.assertEqual(record["operation"], "deploy_refused")
        self.assertIn("refusing active or unknown unit", record["reason"])
        observed = record["observations"]
        self.assertEqual(observed["head"], self.before)
        self.assertEqual(observed["config_sha256"], record["prior_config_sha256"])
        self.assertEqual(observed["units"], record["prior_state"]["units"])
        self.assertIn("timers.target.wants/crq-tick.timer", observed["units"])
        with self.assertRaises(dc.Refused):
            dc.rollback_target(record)
        # Re-runnable: the refusal leaves nothing to clear before a retry.
        with self.fake_switch():
            plan = dc.deploy_plan(self.effects, host, self.target, self.tag, self.overlay_path)
        self.assertTrue(plan["steps"])
        self.assertEqual(sorted(r["outcome"] for r in self.records()),
                         ["completed", "refused_no_change"])

    def test_helper_exception_cli_exits_two_when_unchanged(self):
        with mock.patch.object(host, "switch", side_effect=ValueError("busy unit")):
            with mock.patch.object(dc, "_load_helper", return_value=(host, "0" * 64)):
                with mock.patch.object(dc, "Effects", return_value=self.effects):
                    with mock.patch("builtins.print") as printed:
                        code = dc.main(["--root", str(self.root), "--overlay",
                                        str(self.overlay_path), "--record-dir",
                                        str(self.record_dir), "switch",
                                        "--sha", self.target, "--tag", self.tag])
        self.assertEqual(code, 2)
        self.assertTrue(any("refused:" in c.args[0] for c in printed.call_args_list))
        self.assertEqual([r["outcome"] for r in self.records()], ["refused_no_change"])
        artifact = json.loads(next(c.args[0] for c in printed.call_args_list
                                   if not c.kwargs.get("file")))
        self.assertEqual(artifact["outcome"], "refused_no_change")
        self.assertTrue(artifact["record_persisted"])
        self.assertEqual(artifact["observations"]["head"], self.before)

    def test_refused_no_change_evidence_survives_a_failed_journal_write(self):
        replace = dc.os.replace

        def fail_refused(source, target):
            if json.loads(Path(source).read_text()).get("outcome") == "refused_no_change":
                raise OSError("record volume became unavailable")
            return replace(source, target)

        with mock.patch.object(host, "switch", side_effect=ValueError("busy unit")):
            with mock.patch.object(dc.os, "replace", side_effect=fail_refused):
                with self.assertRaises(dc.NoChangeRefused) as raised:
                    dc.deploy_plan(self.effects, host, self.target, self.tag,
                                   self.overlay_path)
        record = raised.exception.record
        self.assertFalse(record["record_persisted"])
        self.assertIn("record volume", record["record_write_error"])
        self.assertEqual(record["observations"]["head"], self.before)
        self.assertEqual([r["outcome"] for r in self.records()], ["pending"])

    def test_alive_review_refuses_before_helper_runs(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": {"run_id": "a" * 32}}]})
        with mock.patch.object(host, "switch") as helper_switch:
            with self.assertRaisesRegex(dc.Refused, "alive/ambiguous"):
                dc.deploy_plan(self.effects, host, self.target, self.tag,
                               self.overlay_path)
            helper_switch.assert_not_called()
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), [])

    def test_target_sha_mismatch_refuses_before_drain_or_helper(self):
        with mock.patch.object(host, "switch") as helper_switch:
            with self.assertRaisesRegex(dc.Refused, "peels to"):
                dc.deploy_plan(self.effects, host, self.before, self.tag,
                               self.overlay_path)
            helper_switch.assert_not_called()

    def test_lock_collision_refuses_second_controller(self):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        with (state / dc.LOCK_NAME).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(dc.Refused, "controller lock busy"):
                dc.deploy_plan(self.effects, host, self.target, self.tag,
                               self.overlay_path)
