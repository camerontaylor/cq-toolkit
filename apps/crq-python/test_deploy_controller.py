"""Q7 deployment controller characterization: offline fixtures only.

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config.py`` does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = _load("crq_deploy_controller", OPS / "deploy-controller.py")
host = _load("crq_prepare_host", OPS / "prepare-host.py")


class ControllerFixture(unittest.TestCase):
    """A temporary deployment clone with a real helper, fake systemctl."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-q7-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        self.runner = self.root / "apps/crq-python"
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / "config.json", self.runner / "config.json")
        shutil.copytree(OPS / "systemd", self.runner / "ops/systemd")
        shutil.copy(OPS / "prepare-host.py", self.runner / "ops/prepare-host.py")
        shutil.copy(OPS / "deploy-controller.py", self.runner / "ops/deploy-controller.py")
        (self.root / ".gitignore").write_text("apps/crq-python/state/\n")
        self.command("init", "-q")
        self.command("config", "user.email", "fixture@example.invalid")
        self.command("config", "user.name", "Fixture")
        self.command("add", ".")
        self.command("commit", "-qm", "baseline")
        self.before = self.command("rev-parse", "HEAD").strip()
        config = json.loads((self.runner / "config.json").read_text())
        config["promotion"]["hours_trigger"] = 9
        (self.runner / "config.json").write_bytes(host.encode(config))
        self.command("commit", "-qam", "next policy")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        self.tag = "crq-runner/20261028-1"
        self.command("tag", "-a", self.tag, "-m", "owner fixture approval")
        self.command("checkout", "-q", "--detach", self.before)
        self.overlay = {
            "schema_version": 1, "deploy_root": str(self.root),
            "record_dir": str(self.base / "records"),
            "fleet_reader": {"ssh_host": "queue.example.invalid",
                             "source": "/srv/state/crq/summary.json"},
            "config": {
                "clone": str(self.base / "runtime"),
                "worktree_root": str(self.base / "worktrees"),
                "timeout_bin": "/usr/bin/timeout",
                "paseo_hosts": ["worker.example.invalid:6767", "127.0.0.1:6767"],
                "promotion": {"record_url_template":
                              "http://queue.example.invalid:6778/promotion/{item}",
                              "alert_agent_host": "worker.example.invalid:6767",
                              "signer": {"spool": {
                                  "ssh_alias": "operator@127.0.0.1",
                                  "ssh_key": "/srv/keys/crq-spool"}}},
                "repair": {"enabled": False,
                           "cq_bin": str(self.base / "runtime/dist/cli.js"),
                           "paseo_host": "127.0.0.1:6767"},
            },
        }
        self.raw = host.encode(self.overlay)
        self.overlay_path = self.base / "host.json"
        self.overlay_path.write_bytes(self.raw)
        self.overlay_path.chmod(0o600)
        self.record_dir = self.base / "controller-records"
        self.record_dir.mkdir(mode=0o700)
        self.floor = mock.patch.object(host, "POLICY_FLOOR", self.before)
        self.floor.start()
        self.addCleanup(self.floor.stop)
        self.effects = dc.Effects(self.root, self.record_dir)

    def command(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout

    def stopped(self, argv):
        """Fake systemctl: every CRQ unit reports inactive; git really runs."""
        if argv[0] == "systemctl":
            if argv[2] in {"list-unit-files", "list-units"}:
                return ""
            return "inactive\n"
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout

    def write_state(self, rel, payload):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / rel).write_text(json.dumps(payload) + "\n")

    def rendered(self):
        data = host.render(self.root, self.overlay)
        (self.runner / "config.json").write_bytes(data)
        return data


class PreflightTests(ControllerFixture):
    def test_valid_target_and_tag_pass_and_capture_state(self):
        self.write_state("queue.json", {"items": [], "last_tick": "2026-10-28T00:00:00Z"})
        pre = dc.preflight(self.effects, self.target, self.tag)
        self.assertEqual(pre["target"], self.target)
        self.assertEqual(pre["state"]["prior_head"], self.before)
        self.assertIsNotNone(pre["state"]["prior_config_sha256"])
        self.assertEqual(pre["state"]["preserved/queue.json"],
                         dc._sha256(self.runner / "state/queue.json"))
        self.assertIsNone(pre["state"]["preserved/heartbeat.json"])

    def test_sha_tag_shape_and_annotated_binding_refused_before_any_mutation(self):
        before_status = self.command("status", "--porcelain", "--untracked-files=all")
        for target, tag in [("short", self.tag), ("A" * 40, self.tag),
                            (self.before, "20261028-1"),
                            (self.before, "crq-runner/not-a-date"),
                            (self.before, "refs/tags/" + self.tag)]:
            with self.subTest(target=target, tag=tag):
                with self.assertRaises(dc.Refused):
                    dc.preflight(self.effects, target, tag)
        # lightweight tag refused: annotation is the owner-approval artifact
        self.command("tag", "crq-runner/20261028-2", self.before)
        with self.assertRaisesRegex(dc.Refused, "annotated"):
            dc.preflight(self.effects, self.before, "crq-runner/20261028-2")
        # annotated tag naming a different commit refused
        self.command("tag", "-a", "crq-runner/20261028-3", self.target, "-m", "x")
        with self.assertRaisesRegex(dc.Refused, "peels to"):
            dc.preflight(self.effects, self.before, "crq-runner/20261028-3")
        self.assertEqual(self.command("status", "--porcelain", "--untracked-files=all"),
                         before_status)


class DrainTests(ControllerFixture):
    def test_no_active_runs_reports_drained(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "kind": "merged", "state": "pending"},
            {"id": "pr2", "kind": "delta", "state": "done"},
        ]})
        result = dc.drain_check(self.effects, lambda *a: "harvest")
        self.assertTrue(result["drained"])
        self.assertEqual(result["blocked"], [])

    def test_alive_and_ambiguous_block_with_exact_item_identity(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": {"run_id": "a" * 32, "pid": 4242}},
            {"id": "pr2", "run": {"run_id": "b" * 32}},
            {"id": "pr3", "run": "corrupt"},
            {"id": "pr4", "run": {"run_id": "bad id!"}},
            {"id": "pr5", "run": 17},
        ]})
        calls = []

        def liveness(rdir, item, r, has_exit):
            calls.append((item["id"], r["run_id"], has_exit))
            return {"a" * 32: "alive", "b" * 32: "ambiguous"}[r["run_id"]]

        result = dc.drain_check(self.effects, liveness)
        self.assertFalse(result["drained"])
        blocked = {entry["item"]: entry for entry in result["blocked"]}
        self.assertEqual(blocked["pr1"]["state"], "alive")
        self.assertEqual(blocked["pr2"]["state"], "ambiguous")
        self.assertEqual(blocked["pr3"]["state"], "ambiguous")
        self.assertIn("malformed recorded run", blocked["pr3"]["reason"])
        self.assertEqual(blocked["pr4"]["state"], "ambiguous")
        self.assertEqual(blocked["pr5"]["state"], "ambiguous")
        # the probe is only invoked for well-formed recorded runs
        self.assertEqual(calls, [("pr1", "a" * 32, False), ("pr2", "b" * 32, False)])

    def test_runner_generated_ids_probe_exact_recorded_directory_and_exit(self):
        # crq.launch appends this UTC format to the enrollment/promotion ID.
        # author_quota permits ._ in its up-to-80-character request IDs;
        # cut_promotion adds + to repeated promotion item IDs.
        item_ids = ["pr610", "pr610-merged", "pr610-delta-abcdef0",
                    "promo-abcdef0123-delta++",
                    "author-" + "Request._-" + "a" * 70]
        runs = self.runner / "state/runs"
        for item_id in item_ids:
            with self.subTest(item_id=item_id):
                run_id = item_id + "-20261028T012345Z"
                rdir = runs / run_id
                rdir.mkdir(parents=True)
                (rdir / "exit.json").write_text('{"exit":0}\n')
                item = {"id": item_id, "run": {"run_id": run_id}}
                self.write_state("queue.json", {"items": [item]})
                probe = mock.Mock(return_value="harvest")
                result = dc.drain_check(self.effects, probe)
                self.assertEqual(result, {"drained": True, "blocked": []})
                probe.assert_called_once_with(rdir, item, item["run"], True)

    def test_runner_generated_ids_keep_alive_and_ambiguous_runs_blocked(self):
        for state in ("alive", "ambiguous"):
            with self.subTest(state=state):
                run_id = "pr610-20261028T012345Z"
                item = {"id": "pr610", "run": {"run_id": run_id}}
                self.write_state("queue.json", {"items": [item]})
                probe = mock.Mock(return_value=state)
                result = dc.drain_check(self.effects, probe)
                self.assertFalse(result["drained"])
                self.assertEqual(result["blocked"], [
                    {"item": "pr610", "state": state, "run": run_id}])
                probe.assert_called_once_with(
                    self.runner / "state/runs" / run_id, item, item["run"], False)

    def test_unsafe_or_malformed_run_ids_never_reach_liveness(self):
        valid = "pr610-20261028T012345Z"
        invalid = [None, False, 17, [], {}, "", ".", "..", "../" + valid,
                   "/" + valid, "nested/" + valid, "nested\\" + valid,
                   " " + valid, valid + " ", valid + "\n", valid + "\r",
                   valid + "\t", valid + "\x00", valid + "\x1b", "é" + valid,
                   "pr610", "pr610-20261028t012345z", "pr610-20261028T01234Z",
                   "-" + valid, "a" * 239 + "-20261028T012345Z"]
        for run_id in invalid:
            with self.subTest(run_id=run_id):
                self.write_state("queue.json", {"items": [
                    {"id": "pr610", "run": {"run_id": run_id}}]})
                probe = mock.Mock(side_effect=AssertionError("unsafe path reached probe"))
                result = dc.drain_check(self.effects, probe)
                self.assertFalse(result["drained"])
                self.assertEqual(result["blocked"], [{
                    "item": "pr610", "state": "ambiguous", "reason": "malformed run id"}])
                probe.assert_not_called()

    def test_absent_and_explicit_null_runs_are_the_only_skips(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1"},                      # never started
            {"id": "pr2", "run": None},         # runner's terminal marker
        ]})
        probes = []
        result = dc.drain_check(
            self.effects,
            lambda *a: probes.append(a) or (_ for _ in ()).throw(AssertionError(
                "no probe may run for an absent/unstarted run")))
        self.assertTrue(result["drained"])
        self.assertEqual(probes, [])
        self.assertEqual(result["blocked"], [])

    def test_receipt_exit_artifact_is_observed_not_created(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": {"run_id": "c" * 32}}]})
        runs = self.runner / "state/runs"
        runs.mkdir(parents=True)
        (runs / ("c" * 32)).mkdir()
        (runs / ("c" * 32) / "exit.json").write_text('{"exit":0}\n')
        seen = {}
        dc.drain_check(self.effects,
                       lambda rdir, item, r, has_exit: seen.setdefault("has_exit", has_exit))
        self.assertTrue(seen["has_exit"])

    def test_liveness_probe_failure_is_ambiguous_never_absence(self):
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "run": {"run_id": "d" * 32}}]})

        def broken(*_a):
            raise RuntimeError("ps exploded")

        result = dc.drain_check(self.effects, broken)
        self.assertFalse(result["drained"])
        self.assertEqual(result["blocked"][0]["state"], "ambiguous")
        self.assertIn("ps exploded", result["blocked"][0]["reason"])

    def test_unreadable_queue_refuses_instead_of_claiming_drained(self):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text("{not json")
        with self.assertRaisesRegex(dc.Refused, "queue unreadable"):
            dc.drain_check(self.effects, lambda *a: "harvest")

    def test_missing_queue_entirely_refuses(self):
        with self.assertRaisesRegex(dc.Refused, "queue unreadable"):
            dc.drain_check(self.effects, lambda *a: "harvest")


class RunnerProbeTests(ControllerFixture):
    def write_probe(self, source):
        (self.runner / "crq.py").write_text(source)

    def test_checkout_runner_and_dependency_ignore_ambient_modules_and_pythonpath(self):
        (self.runner / "probe_dependency.py").write_text('STATE = "alive"\n')
        self.write_probe('import probe_dependency\n'
                         'def run_liveness(*args): return probe_dependency.STATE\n')
        poison = self.base / "ambient"
        poison.mkdir()
        (poison / "probe_dependency.py").write_text('STATE = "harvest"\n')
        with mock.patch.dict(sys.modules, {"crq": mock.Mock(),
                                          "probe_dependency": mock.Mock()}):
            with mock.patch.dict(os.environ, {"PYTHONPATH": str(poison)}):
                probe = dc._runner_liveness(self.effects)
                self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "alive")
        self.assertEqual(list(self.runner.rglob("__pycache__")), [])

    def test_missing_or_broken_checkout_import_and_probe_fail_closed(self):
        probe = dc._runner_liveness(self.effects)
        self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "ambiguous")
        for source in ('import missing_checkout_dependency_xyz\n',
                       'def run_liveness(*args): raise RuntimeError("probe failed")\n',
                       'def run_liveness(*args): return "unknown"\n',
                       'def run_liveness(*args): return "harvest"\nprint("noise")\n'):
            with self.subTest(source=source):
                self.write_probe(source)
                self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "ambiguous")

    def test_probe_timeout_and_spawn_failure_are_ambiguous(self):
        for error in (subprocess.TimeoutExpired("probe", 30), OSError("cannot spawn")):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(dc.subprocess, "run", side_effect=error):
                    self.assertEqual(dc._runner_liveness(self.effects)(
                        self.runner / "state/runs/run", {}, {}, True), "ambiguous")


class PreservationTests(ControllerFixture):
    def test_identical_bytes_pass(self):
        self.write_state("queue.json", {"items": []})
        before = {"preserved/queue.json": dc._sha256(self.runner / "state/queue.json"),
                  "preserved/heartbeat.json": None}
        self.assertEqual(dc.preservation_check(self.effects, before)["preserved"], True)

    def test_changed_or_vanished_surface_refuses_with_names(self):
        self.write_state("queue.json", {"items": []})
        before = {"preserved/queue.json": "0" * 64,
                  "preserved/heartbeat.json": "2" * 64}
        with self.assertRaisesRegex(dc.Refused, "queue.json, heartbeat.json"):
            dc.preservation_check(self.effects, before)


class HealthTests(ControllerFixture):
    def observe_fixtures(self):
        runs = self.runner / "state/runs"
        runs.mkdir(parents=True, exist_ok=True)
        (runs / "run-a").mkdir(exist_ok=True)
        (runs / "run-a/meta.json").write_text('{"head": "%s"}\n' % self.before)
        (runs / "run-b").mkdir(exist_ok=True)
        (runs / "run-b/meta.json").write_bytes(b"{broken")

    def test_two_advancing_observations_are_healthy_with_receipt_sample(self):
        self.observe_fixtures()
        ticks = iter(["2026-10-28T00:00:00Z", "2026-10-28T00:05:00Z",
                      "2026-10-28T00:10:00Z"])
        self.write_state("queue.json", {})
        effects = self.effects

        def read_json(rel):
            return {"last_tick": next(ticks)}

        effects.read_json = read_json
        result = dc.two_slot_health(effects, lambda prior:
                                    dc.health_observation(effects, prior))
        self.assertTrue(result["healthy"])
        first, second = result["observations"]
        self.assertEqual(first["observed_tick"], "2026-10-28T00:05:00Z")
        self.assertEqual(second["observed_tick"], "2026-10-28T00:10:00Z")
        self.assertEqual(first["receipts"], {"sampled": 2, "readable": 1})

    def test_same_tick_twice_is_one_slot_not_two(self):
        fixed = "2026-10-28T00:00:00Z"
        self.write_state("queue.json", {"last_tick": fixed})
        result = dc.two_slot_health(self.effects, lambda prior:
                                    dc.health_observation(self.effects, prior))
        self.assertFalse(result["healthy"])
        self.assertIn("first observation", result["reason"])

    def test_second_observation_stalled_is_unhealthy(self):
        ticks = iter(["2026-10-28T00:00:00Z", "2026-10-28T00:05:00Z",
                      "2026-10-28T00:05:00Z"])
        self.write_state("queue.json", {})
        effects = self.effects

        def read_json(rel):
            return {"last_tick": next(ticks)}

        effects.read_json = read_json
        result = dc.two_slot_health(effects, lambda prior:
                                    dc.health_observation(effects, prior))
        self.assertFalse(result["healthy"])
        self.assertIn("second observation", result["reason"])

    def test_no_tick_source_refuses(self):
        with self.assertRaisesRegex(dc.Refused, "no last_tick"):
            dc._tick_value(self.effects)

    def test_heartbeat_fallback_when_queue_has_no_tick(self):
        self.write_state("heartbeat.json", {"last_tick": "2026-10-28T00:00:00Z"})
        self.assertEqual(dc._tick_value(self.effects), "2026-10-28T00:00:00Z")

    def test_malformed_timestamp_is_not_health_evidence(self):
        self.write_state("queue.json", {"last_tick": "yesterday-ish"})
        with self.assertRaises(ValueError):
            dc.health_observation(self.effects, "2026-10-28T00:00:00Z")


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

    def test_unreadable_queue_is_recorded_not_crashed_and_fails_closed(self):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text("[[[")
        record = dc.compatibility_record(self.effects, self.target)
        self.assertIn("unreadable", record["queue_schema"])
        self.assertIs(record["schema_marker_present"], True)
        self.assertFalse(dc.rollback_compatible(record))


class DeployPlanTests(ControllerFixture):
    def setUp(self):
        super().setUp()
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "kind": "merged", "state": "done"}], "starts": []})
        self.rendered()

    def fake_switch(self):
        """The helper's switch, with systemctl faked inactive (no live units)."""
        def run(argv):
            if argv[0] == "systemctl":
                return self.stopped(argv)
            return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
        return mock.patch.object(host, "run", side_effect=run)

    def assert_recovery(self, failure, phase):
        recovery = failure.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["failed_phase"], phase)
        self.assertEqual(recovery["prior_head"], self.before)
        self.assertEqual(recovery["target"], self.target)
        self.assertFalse(recovery["automatic_rollback_permitted"])
        self.assertEqual(recovery["rollback_compatibility"], {})
        self.assertIn("preserved/queue.json", recovery["prior_state"])
        self.assertIsNotNone(recovery["prior_config_sha256"])
        record = json.loads(Path(recovery["record_path"]).read_text())
        with self.assertRaises(dc.Refused):
            dc.rollback_target(record)
        return recovery, record

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
            with mock.patch.object(dc, "_load_helper", return_value=host):
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
        with self.fake_switch():
            plan = dc.deploy_plan(self.effects, host, self.target, self.tag,
                                  self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.target)
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
        for outcome in ["pending", "recovery_required", "unknown", None, False]:
            with self.subTest(outcome=outcome):
                with self.assertRaisesRegex(dc.Refused, "completed deploy journal"):
                    dc.rollback_target({**self.prior, "outcome": outcome})

    def test_compatible_rollback_returns_to_recorded_prior_target(self):
        self.at_target()
        with self.fake_switch():
            result = dc.rollback_plan(self.effects, host, self.prior,
                                      self.overlay_path)
        self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)
        self.assertEqual(result["rolled_back_to"], self.before)
        journals = [json.loads(p.read_text())
                    for p in self.record_dir.glob("controller-*.json")]
        self.assertEqual([j["operation"] for j in journals], ["rollback"])

    def test_post_journal_author_requests_refuse_before_drain_or_switch(self):
        with self.fake_switch():
            dc.deploy_plan(self.effects, host, self.target, self.tag,
                           self.overlay_path)
        journal_paths = list(self.record_dir.glob("controller-*.json"))
        prior = json.loads(journal_paths[0].read_text())
        self.assertTrue(dc.rollback_compatible(prior["rollback_compatibility"]))
        self.write_state("queue.json", {"items": [], "starts": [],
                                       "author_requests": {"new-request": {}}})
        queue_bytes = (self.runner / "state/queue.json").read_bytes()
        with mock.patch.object(dc, "drain_check") as drain:
            with mock.patch.object(host, "switch") as helper_switch:
                with self.assertRaisesRegex(dc.Refused, "current queue state"):
                    dc.rollback_plan(self.effects, host, prior, self.overlay_path)
                drain.assert_not_called()
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


class CliTests(ControllerFixture):
    """End-to-end CLI invocations with faked systemctl; JSON on stdout."""

    def run_cli(self, *args, env=None):
        merged = dict(os.environ)
        merged.pop("PYTHONPATH", None)
        if env:
            merged.update(env)
        # The copied helper is imported from the fixture checkout. Prevent
        # that import from creating untracked bytecode beside reviewed source;
        # the production "only rendered config modified" fence stays strict.
        return subprocess.run(
            ["python3", "-B", str(OPS / "deploy-controller.py"),
             "--root", str(self.root), "--overlay", str(self.overlay_path),
             "--record-dir", str(self.record_dir), *args],
            capture_output=True, text=True, env=merged)

    def test_switch_cli_succeeds_with_fake_systemctl_and_emits_json(self):
        self.switch_cli_fixture()

    def test_switch_cli_drains_real_runner_without_pythonpath(self):
        self.switch_cli_fixture(recorded_run=True)

    def switch_cli_fixture(self, recorded_run=False):
        self.write_state("queue.json", {"items": [], "starts": []})
        if recorded_run:
            # Real probe and dependencies, tracked before the helper clean guard.
            for name in ("crq.py", "status_summary.py", "repair_tick.py", "coverage.py",
                         "author_quota.py", "author_lease.py"):
                shutil.copy(ROOT / name, self.runner / name)
            shutil.copytree(ROOT / "crq_repair", self.runner / "crq_repair",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            child = subprocess.Popen([sys.executable, "-I", "-B", "-c", "pass"],
                                     start_new_session=True)
            self.assertEqual(child.wait(timeout=10), 0)
            run_id = "pr611-20261028T012345Z"
            (self.runner / "state/runs" / run_id).mkdir(parents=True)
            self.write_state("runs/" + run_id + "/exit.json", {"exit": 0})
            self.write_state("runs/" + run_id + "/review.pid", {
                "pid": child.pid, "pgid": child.pid, "sid": child.pid,
                "run_id": run_id, "group_owner": "foreground-v1"})
            self.write_state("queue.json", {"items": [
                {"id": "pr611", "run": {"run_id": run_id, "pid": child.pid}}],
                "starts": []})

        # The subprocess cannot inherit this module's POLICY_FLOOR mock, so the
        # fixture copy of the helper pins the fixture baseline directly. The
        # pin commit must contain UNRENDERED committed config, so the helper's
        # post-switch "only rendered config modified" contract still holds.
        self.command("restore", "--", host.CONFIG)
        helper = self.runner / "ops/prepare-host.py"
        original = helper.read_text()
        helper.write_text(original.replace(
            "POLICY_FLOOR = 'f748fd43e75505f4e89098a4ffe28fa2a179a50c'",
            "POLICY_FLOOR = '" + self.before + "'"))
        # The edited helper bytes must not look like checkout drift: commit the
        # pinned copy into the fixture clone (same content, new commit).
        self.command("add", "apps/crq-python")
        self.command("commit", "-qam", "fixture floor pin")
        pinned = self.command("rev-parse", "HEAD").strip()
        self.command("update-ref", "refs/remotes/origin/main", pinned)
        self.command("tag", "-a", "crq-runner/20261028-2", pinned, "-m", "cli fixture")
        # Render AFTER the pin commit: the rendered config must differ from the
        # committed one for the helper's post-switch status contract to hold.
        self.rendered()
        # No systemd on the test host either: fake systemctl for the subprocess
        # through a PATH shim that reports every CRQ unit inactive.
        shim = self.base / "bin"
        shim.mkdir(exist_ok=True)
        (shim / "systemctl").write_text(
            '#!/bin/sh\n'
            'if [ "$1" = "--user" ] && { [ "$2" = "list-unit-files" ] || [ "$2" = "list-units" ]; }; then\n'
            '  exit 0\n'
            'fi\n'
            'echo inactive\n'
            'exit 0\n')
        (shim / "systemctl").chmod(0o755)
        # Do not let host-global excludes hide generated fixture files.
        self.command("config", "core.excludesFile", os.devnull)
        expected_status = [" M " + host.CONFIG]
        before_cli = self.command("status", "--porcelain", "--untracked-files=all").splitlines()
        self.assertEqual(before_cli, expected_status, before_cli[:10])
        result = self.run_cli("switch", "--sha", pinned, "--tag", "crq-runner/20261028-2",
                              env={"PATH": str(shim) + ":" + os.environ["PATH"],
                                   # Exercise -B even when inherited env does
                                   # not suppress bytecode (as in CI discovery).
                                   "PYTHONDONTWRITEBYTECODE": ""})
        after_cli = self.command("status", "--porcelain", "--untracked-files=all").splitlines()
        self.assertEqual(result.returncode, 0,
                         result.stderr[-1000:] + "\nfixture status: " + repr(after_cli[:10]))
        self.assertEqual(after_cli, expected_status, after_cli[:10])
        artifact = json.loads(result.stdout)
        self.assertEqual(artifact["operation"], "switch")
        self.assertEqual(artifact["target"], pinned)
        self.assertTrue(artifact["automatic_rollback_permitted"])

    def test_health_cli_reports_stale_without_advancement(self):
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:00:00Z"})
        result = self.run_cli("health")
        self.assertEqual(result.returncode, 1)
        artifact = json.loads(result.stdout)
        self.assertFalse(artifact["healthy"])

    def test_refusal_exits_2_with_stderr_reason_and_no_stdout_artifact(self):
        result = self.run_cli("switch", "--sha", "nothex", "--tag", self.tag)
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
