"""Q7 deployment controller characterization: offline fixtures only.

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as the
``test_host_config_*`` modules do; process liveness is faked; units are never
started; the controller never signals a process.
"""
import fcntl
import hashlib
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

import review_receipt

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = _load("crq_deploy_controller", OPS / "deploy-controller.py")
host = _load("crq_prepare_host", OPS / "prepare-host.py")

# Sentinel distinguishing "no root argument" from an explicit None root.
_MISSING_ROOT = object()


class FirstTickWaitTest(unittest.TestCase):
    def run_wait(self, observations, timeout):
        now = [0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        with mock.patch.object(dc, 'health_observation', side_effect=observations) as observe:
            result = dc.wait_for_first_tick(object(), 'prior', timeout,
                                            sleep=sleep, clock=lambda: now[0])
        return result, sleeps, observe.call_count

    def test_waits_for_first_completed_tick(self):
        result, sleeps, calls = self.run_wait(
            [{'advanced': False}, {'advanced': False}, {'advanced': True}], 12)
        self.assertTrue(result['advanced'])
        self.assertEqual(sleeps, [5, 5])
        self.assertEqual(calls, 3)

    def test_timeout_returns_last_unhealthy_observation(self):
        result, sleeps, calls = self.run_wait([{'advanced': False}] * 3, 7)
        self.assertFalse(result['advanced'])
        self.assertEqual(sleeps, [5, 2])
        self.assertEqual(calls, 3)

    def test_zero_timeout_samples_once(self):
        result, sleeps, calls = self.run_wait([{'advanced': False}], 0)
        self.assertFalse(result['advanced'])
        self.assertEqual(sleeps, [])
        self.assertEqual(calls, 1)


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
        # Installed-unit observation reads an isolated user config, never the
        # real one; the CLI subprocess inherits the same environment.
        self.units_home = self.base / "xdg-config/systemd/user"
        self.units_home.mkdir(parents=True)
        (self.units_home / "crq-tick.timer").write_text("[Timer]\n")
        (self.units_home / "timers.target.wants").mkdir()
        (self.units_home / "timers.target.wants/crq-tick.timer").symlink_to(
            self.units_home / "crq-tick.timer")
        isolated = mock.patch.dict(os.environ,
                                   {"XDG_CONFIG_HOME": str(self.base / "xdg-config")})
        isolated.start()
        self.addCleanup(isolated.stop)

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

    def test_non_object_queue_root_refuses_never_crashes(self):
        for root in (None, [1], "str", 7, {"items": {"pr1": {}}}):
            with self.subTest(root=root):
                self.write_state("queue.json", root)
                with self.assertRaisesRegex(dc.Refused, "queue unreadable"):
                    dc.drain_check(self.effects, lambda *a: "harvest")

    def test_non_object_queue_item_blocks_as_ambiguous(self):
        self.write_state("queue.json", {"items": ["pr1"]})
        result = dc.drain_check(self.effects, lambda *a: "harvest")
        self.assertFalse(result["drained"])
        self.assertEqual(result["blocked"][0]["state"], "ambiguous")


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
    """Causal completion-heartbeat fixtures under an isolated WATCHDOG_HOME.

    crq.py persists queue.last_tick before status publication and replaces
    the completion heartbeat only after it. These fixtures reproduce that
    producer order against the controller's real WATCHDOG_HOME resolution —
    never a mocked read seam, never the actual user's heartbeat.
    """

    def setUp(self):
        super().setUp()
        self.xdg = self.base / "xdg-state"
        self.watchdog = self.xdg / "crq"
        self.watchdog.mkdir(parents=True)
        isolated = mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(self.xdg)})
        isolated.start()
        self.addCleanup(isolated.stop)

    def complete_tick(self, tick, root=_MISSING_ROOT):
        """Atomically replace the completion heartbeat exactly as crq.py
        write_heartbeat() does: producer-shaped JSON, tmp + replace.
        root is written verbatim (None/other values included) so fixtures
        can prove root binding; only _MISSING_ROOT means this checkout."""
        payload = {"last_tick": tick, "stale_alarm_min": 36,
                   "schedule_id": "crq-tick",
                   "root": str(self.runner) if root is _MISSING_ROOT else root,
                   "alert_agent_id": None, "alert_agent_host": None}
        tmp = self.watchdog / ".heartbeat.json.tmp"
        tmp.write_text(json.dumps(payload) + "\n")
        tmp.replace(self.watchdog / "heartbeat.json")

    def write_raw_heartbeat(self, raw):
        (self.watchdog / "heartbeat.json").write_text(raw)

    def observe_after(self, ticks):
        """Complete the given ticks between observations (the real producer
        runs between wall-clock slots; the controller only ever reads)."""
        remaining = iter(ticks)

        def observe(prior):
            self.complete_tick(next(remaining))
            return dc.health_observation(self.effects, prior)

        return observe

    def observe_fixtures(self):
        runs = self.runner / "state/runs"
        runs.mkdir(parents=True, exist_ok=True)
        (runs / "run-a").mkdir(exist_ok=True)
        (runs / "run-a/meta.json").write_text('{"head": "%s"}\n' % self.before)
        (runs / "run-b").mkdir(exist_ok=True)
        (runs / "run-b/meta.json").write_bytes(b"{broken")

    def test_two_completed_replacements_are_healthy_with_receipt_sample(self):
        self.observe_fixtures()
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"]))
        self.assertTrue(result["healthy"])
        first, second = result["observations"]
        self.assertEqual(first["observed_tick"], "2026-10-28T00:05:00Z")
        self.assertEqual(second["observed_tick"], "2026-10-28T00:10:00Z")
        self.assertEqual(first["receipts"], {"sampled": 2, "readable": 1})
        # Readability is its own verdict and never a tick failure (#550).
        self.assertIs(first["receipts_readable"], False)
        self.assertIs(result["receipts_readable"], False)
        self.assertIsNone(first["receipts_valid"])  # no state/receipts sampled
        self.assertIsNone(result["receipts_valid"])

    def receipt_document(self, **overrides):
        """A v1 merged-current receipt shaped exactly like crq.current_document."""
        paths = [{"source_path": "src/a.ts", "path": "src/a.ts",
                  "resolution": "same-path-current", "disposition": "included"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": review_receipt.digest(paths),
                   "policy": review_receipt.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1",
                   "reviewer_version": "0.3.4", "captured_at": "2026-10-28T00:00:00Z"}
        capture["equivalence"] = review_receipt.current_equivalence(capture)
        document = {"version": 1, "item_id": "current-0123", "request_id": "req-1",
                    "source": {"repo": "o/r", "pr": 7, "merge_sha": "c" * 40,
                               "target_selector": "promoted-main",
                               "policy": review_receipt.POLICY},
                    "capture": capture, "outcome": "terminal-clean",
                    "classification": {"counted": True, "outcome": "completed"},
                    "counted": True, "findings": [],
                    "run_id": "current-0123-20261028T000000Z",
                    "started_at": "2026-10-28T00:00:00Z",
                    "artifacts": {"meta.json": "d" * 64},
                    "remediation": "disabled/deferred",
                    "independent_acceptance": False,
                    "cli_functional_acceptance": "pending-D1"}
        document.update(overrides)
        return document

    def write_receipt(self, document):
        return review_receipt.write_receipt(self.runner / "state/receipts", document)

    def write_raw_receipt(self, data):
        root = self.runner / "state/receipts"
        root.mkdir(parents=True, exist_ok=True)
        name = hashlib.sha256(data).hexdigest()
        (root / (name + ".json")).write_bytes(data)
        return name

    def test_receipt_fixtures_valid_wrong_target_terminal_missing_malformed(self):
        valid = self.receipt_document()
        # The fixture is a real reusable v1 receipt under the runner's own API.
        self.assertTrue(review_receipt.reusable_current(valid, valid["capture"]))
        wrong_target = self.receipt_document(
            capture={**valid["capture"], "target": "main"})
        unknown_selector = self.receipt_document(
            source={**valid["source"], "target_selector": "feature/x"})
        missing_outcome = self.receipt_document()
        del missing_outcome["outcome"]
        counted_unfinished = self.receipt_document(
            classification={"counted": False, "outcome": "failed"})
        no_run = self.receipt_document(run_id=None)
        cases = {
            "valid": (valid, None),
            "uncounted": (self.receipt_document(
                outcome="no-current-code", counted=False, classification=None,
                run_id=None, started_at=None, artifacts={}), None),
            "wrong-target": (wrong_target, "target"),
            "unknown-selector": (unknown_selector, "target"),
            "missing-terminal-outcome": (missing_outcome, "terminal outcome"),
            "counted-unfinished": (counted_unfinished, "terminal outcome"),
            "counted-without-run": (no_run, "terminal outcome"),
            "missing-item": (self.receipt_document(item_id=""), "run identity"),
            "scope-digest": (self.receipt_document(
                capture={**valid["capture"], "scope_digest": "e" * 64}), "scope digest"),
        }
        for label, (document, expected) in cases.items():
            with self.subTest(label=label):
                data = review_receipt.canonical(document)
                name = hashlib.sha256(data).hexdigest() + ".json"
                problem = dc.receipt_problem(name, data)
                if expected is None:
                    self.assertIsNone(problem)
                else:
                    self.assertIn(expected, problem)
        for raw, expected in ((b"{broken", "not valid JSON"), (b"[1]", "not a JSON object")):
            with self.subTest(raw=raw):
                name = hashlib.sha256(raw).hexdigest() + ".json"
                self.assertIn(expected, dc.receipt_problem(name, raw))
        data = review_receipt.canonical(valid)
        self.assertIn("content identity", dc.receipt_problem("0" * 64 + ".json", data))

    def test_invalid_receipt_sample_is_a_distinct_verdict_not_a_tick_failure(self):
        good = self.write_receipt(self.receipt_document())
        bad = self.write_receipt(self.receipt_document(
            capture={**self.receipt_document()["capture"], "target": "main"}))
        broken = self.write_raw_receipt(b"{broken")
        missing = self.receipt_document()
        del missing["outcome"]
        terminal = self.write_receipt(missing)
        # In-flight temporaries are not receipts and are never sampled.
        (self.runner / "state/receipts/.receipt-tmp").write_bytes(b"partial")
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"]))
        self.assertTrue(result["healthy"])
        self.assertIs(result["receipts_valid"], False)
        first = result["observations"][0]
        self.assertIs(first["receipts_valid"], False)
        validation = first["receipt_validation"]
        self.assertEqual(validation["sampled"], 4)
        self.assertEqual(validation["valid_count"], 1)
        self.assertEqual(sorted(i["receipt"] for i in validation["invalid"]),
                         sorted([bad, broken, terminal]))
        self.assertNotIn(good, [i["receipt"] for i in validation["invalid"]])

    def age(self, path, seconds_ago):
        stamp = 1_800_000_000 - seconds_ago
        os.utime(path, (stamp, stamp))

    def test_receipt_sample_is_the_newest_by_mtime_not_lowest_hash(self):
        root = self.runner / "state/receipts"
        for index in range(dc.RECEIPT_SAMPLE + 2):
            name = self.write_receipt(self.receipt_document(item_id="current-%d" % index))
            self.age(root / (name + ".json"), 1000 + index)
        bad = self.write_raw_receipt(b"{broken")
        # Newest: written after the switch, so it must be sampled whatever its name.
        self.age(root / (bad + ".json"), 0)
        validation = dc.receipt_validation(self.effects)
        self.assertEqual(validation["sampled"], dc.RECEIPT_SAMPLE)
        self.assertEqual([i["receipt"] for i in validation["invalid"]], [bad])
        # The same bad receipt, oldest of all, falls outside the bounded sample.
        self.age(root / (bad + ".json"), 10**6)
        validation = dc.receipt_validation(self.effects)
        self.assertEqual(validation["sampled"], dc.RECEIPT_SAMPLE)
        self.assertIs(validation["valid"], True)

    def test_run_readability_sample_is_the_newest_by_mtime(self):
        runs = self.runner / "state/runs"
        for index in range(dc.RECEIPT_SAMPLE + 2):
            run = runs / ("aaaa%04d-20261028T000000Z" % index)
            run.mkdir(parents=True)
            (run / "meta.json").write_text("{}\n")
            self.age(run, 1000 + index)
        broken = runs / "zzzz-20261028T000500Z"  # sorts last by name
        broken.mkdir()
        (broken / "meta.json").write_bytes(b"{broken")
        self.age(broken, 0)
        self.complete_tick("2026-10-28T00:05:00Z")
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertEqual(observation["receipts"],
                         {"sampled": dc.RECEIPT_SAMPLE, "readable": dc.RECEIPT_SAMPLE - 1})
        self.assertIs(observation["receipts_readable"], False)
        self.age(broken, 10**6)
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertIs(observation["receipts_readable"], True)

    def install_receipt_sources(self, selectors=None):
        shutil.copy(ROOT / "runtime_target.py", self.runner / "runtime_target.py")
        source = (ROOT / "review_receipt.py").read_text()
        if selectors is not None:
            old = 'SELECTORS = {"promoted-main": DEFAULT_REF, LEGACY_BRANCH: DEFAULT_REF}'
            self.assertIn(old, source)
            source = source.replace(old, selectors)
        (self.runner / "review_receipt.py").write_text(source)

    def test_schema_constants_come_from_the_deployment_tree_read_only(self):
        self.install_receipt_sources(
            'SELECTORS = {"promoted-main": DEFAULT_REF, LEGACY_BRANCH: DEFAULT_REF,'
            ' "release-train": DEFAULT_REF}')
        sentinel = self.base / "executed"
        with (self.runner / "review_receipt.py").open("a") as out:
            out.write("\nopen(%r, 'w').write('ran')\n" % str(sentinel))
        schema = dc.receipt_schema(self.effects)
        self.assertEqual(schema["schema_source"],
                         "deployment:apps/crq-python/review_receipt.py")
        self.assertEqual(schema["targets"], ("promoted-main", "merge-queue", "release-train"))
        self.assertEqual((schema["policy"], schema["version"]),
                         (review_receipt.POLICY, review_receipt.VERSION))
        self.assertFalse(sentinel.exists())  # parsed, never executed
        document = self.receipt_document(
            source={**self.receipt_document()["source"], "target_selector": "release-train"})
        self.write_receipt(document)
        validation = dc.receipt_validation(self.effects)
        self.assertIs(validation["valid"], True, validation["invalid"])
        self.assertEqual(validation["schema_source"], schema["schema_source"])
        # The builtin copy would have reported the new selector as invalid.
        data = review_receipt.canonical(document)
        self.assertIn("target", dc.receipt_problem(
            hashlib.sha256(data).hexdigest() + ".json", data))

    def test_unusable_deployment_sources_fall_back_to_recorded_builtin(self):
        # Fixture checkouts carry no review_receipt.py: missing source.
        schema = dc.receipt_schema(self.effects)
        self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
        self.assertIn("FileNotFoundError", schema["schema_source"])
        self.assertEqual(schema["targets"], dc.RECEIPT_TARGETS)
        for broken in ("def (:\n", 'POLICY = 7\nVERSION = 1\nSELECTORS = {"a": 1}\n',
                       "VERSION = 1\nSELECTORS = {UNKNOWN: 1}\n"):
            with self.subTest(broken=broken):
                self.install_receipt_sources()
                (self.runner / "review_receipt.py").write_text(broken)
                schema = dc.receipt_schema(self.effects)
                self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
                self.assertEqual(schema["policy"], dc.RECEIPT_POLICY)
        self.write_receipt(self.receipt_document())
        validation = dc.receipt_validation(self.effects)
        self.assertIs(validation["valid"], True)
        self.assertTrue(validation["schema_source"].startswith("builtin"))

    def test_later_non_literal_rebinding_makes_a_constant_unresolved(self):
        for rebinding in ('POLICY = "-".join(["x", "y"])\n',
                          'POLICY: str = "affected-current-additions-v1"\n',
                          "POLICY += ''\n", "from os import sep as POLICY\n",
                          "def POLICY():\n    pass\n",
                          "if True:\n    POLICY = 'other'\n",
                          "for POLICY in ():\n    pass\n", "del POLICY\n"):
            with self.subTest(rebinding=rebinding):
                self.install_receipt_sources()
                with (self.runner / "review_receipt.py").open("a") as out:
                    out.write("\n" + rebinding)
                schema = dc.receipt_schema(self.effects)
                self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
                self.assertIn("POLICY", schema["schema_source"])
        # The same for an imported selector key rebound in runtime_target.
        self.install_receipt_sources()
        with (self.runner / "runtime_target.py").open("a") as out:
            out.write("\nLEGACY_BRANCH = DEFAULT_BRANCH.upper()\n")
        schema = dc.receipt_schema(self.effects)
        self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
        self.assertIn("LEGACY_BRANCH", schema["schema_source"])

    def test_only_the_needed_constants_are_resolved(self):
        self.install_receipt_sources()
        with (self.runner / "review_receipt.py").open("a") as out:
            out.write("\nUNRELATED = {UNKNOWN_NAME: 1, f'{POLICY}': 2, (1, 2): 3}\n"
                      "OTHER = compute()\nLATER = {**SELECTORS}\n"
                      "def helper():\n    POLICY = 'local only'\n    return POLICY\n")
        with (self.runner / "runtime_target.py").open("a") as out:
            out.write("\nUNRELATED_TARGETS = {object(): 1}\n")
        schema = dc.receipt_schema(self.effects)
        self.assertEqual(schema["schema_source"],
                         "deployment:apps/crq-python/review_receipt.py")
        self.assertEqual(schema["targets"], ("promoted-main", "merge-queue"))
        self.assertEqual(schema["policy"], review_receipt.POLICY)

    def test_valid_bounded_receipt_sample_and_stalled_tick_stay_independent(self):
        for index in range(dc.RECEIPT_SAMPLE + 2):
            self.write_receipt(self.receipt_document(item_id="current-%d" % index))
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])  # tick stalled
        self.assertIs(result["receipts_valid"], True)  # receipts still valid
        validation = result["observations"][0]["receipt_validation"]
        self.assertEqual((validation["sampled"], validation["valid_count"]),
                         (dc.RECEIPT_SAMPLE, dc.RECEIPT_SAMPLE))

    def test_advancing_queue_saves_cannot_substitute_for_completion(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:00:00Z"})
        queue_ticks = iter(["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"])

        def observe(prior):
            # The queue keeps saving advancing ticks (crq.py persists
            # last_tick before completion) while no tick ever completes.
            self.write_state("queue.json", {"last_tick": next(queue_ticks)})
            return dc.health_observation(self.effects, prior)

        result = dc.two_slot_health(self.effects, observe)
        self.assertFalse(result["healthy"])
        self.assertIn("first observation", result["reason"])
        queue = json.loads((self.runner / "state/queue.json").read_text())
        self.assertEqual(queue["last_tick"], "2026-10-28T00:05:00Z")
        self.assertEqual(result["observations"][0]["observed_tick"],
                         "2026-10-28T00:00:00Z")

    def test_queue_tick_alone_never_satisfies_the_baseline(self):
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:10:00Z"})
        with self.assertRaisesRegex(dc.Refused, "no completion heartbeat"):
            dc._tick_value(self.effects)

    def test_same_completed_tick_seen_twice_is_one_slot_not_two(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("first observation", result["reason"])

    def test_second_observation_stalled_is_unhealthy(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:05:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("second observation", result["reason"])

    def test_regressing_completion_is_not_advancement(self):
        self.complete_tick("2026-10-28T00:05:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:10:00Z", "2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("second observation", result["reason"])

    def test_missing_baseline_heartbeat_refuses(self):
        with self.assertRaisesRegex(dc.Refused, "no completion heartbeat"):
            dc._tick_value(self.effects)

    def test_observation_stage_corruption_refuses(self):
        self.complete_tick("2026-10-28T00:00:00Z")

        def observe(prior):
            self.write_raw_heartbeat("{broken")
            return dc.health_observation(self.effects, prior)

        with self.assertRaisesRegex(dc.Refused, "not valid JSON"):
            dc.two_slot_health(self.effects, observe)

    def test_invalid_json_heartbeat_refuses(self):
        self.write_raw_heartbeat("{broken")
        with self.assertRaisesRegex(dc.Refused, "not valid JSON"):
            dc._tick_value(self.effects)

    def test_non_object_heartbeat_refuses(self):
        for raw in ['["2026-10-28T00:00:00Z"]\n', '"2026-10-28T00:00:00Z"\n',
                    "7\n"]:
            with self.subTest(raw=raw):
                self.write_raw_heartbeat(raw)
                with self.assertRaisesRegex(dc.Refused, "not a JSON object"):
                    dc._tick_value(self.effects)

    def test_heartbeat_not_bound_to_this_checkout_refuses(self):
        other = self.base / "other-deploy/apps/crq-python"
        for root in [None, str(other), 12345]:
            with self.subTest(root=root):
                self.complete_tick("2026-10-28T00:00:00Z", root=root)
                with self.assertRaisesRegex(dc.Refused, "runner directory"):
                    dc._tick_value(self.effects)

    def test_calendar_invalid_timestamp_refuses(self):
        for tick in ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z",
                     "2026-10-28T24:00:00Z", "2026-10-28T00:60:00Z"]:
            with self.subTest(tick=tick):
                self.complete_tick(tick)
                with self.assertRaisesRegex(dc.Refused, "strict UTC"):
                    dc._tick_value(self.effects)

    def test_non_strict_timestamp_shape_refuses(self):
        for tick in ["2026-10-28T00:00:00+00:00", "2026-10-28 00:00:00Z",
                     "2026-1-28T00:00:00Z", "2026-10-28T00:00:00",
                     "2026-10-28T00:00:00.000Z", "yesterday-ish"]:
            with self.subTest(tick=tick):
                self.complete_tick(tick)
                with self.assertRaisesRegex(dc.Refused, "strict UTC"):
                    dc._tick_value(self.effects)

    def test_non_string_last_tick_refuses(self):
        self.complete_tick(20261028)  # the producer only ever writes strings
        with self.assertRaisesRegex(dc.Refused, "strict UTC"):
            dc._tick_value(self.effects)

    def test_unreadable_heartbeat_refuses(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        (self.watchdog / "heartbeat.json").chmod(0o000)
        with self.assertRaisesRegex(dc.Refused, "unreadable"):
            dc._tick_value(self.effects)


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

    def records(self):
        return [json.loads(p.read_text()) for p in self.record_dir.glob("controller-*.json")]

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

    def test_switch_cli_with_matching_pinned_helper_digest_succeeds(self):
        self.switch_cli_fixture(pin_helper=True)

    def test_helper_digest_mismatch_refuses_before_import_lock_or_preflight(self):
        self.write_state("queue.json", {"items": [], "starts": []})
        lock = self.runner / "state" / dc.LOCK_NAME
        for expected in ("0" * 64, "ABC", "0" * 63):
            with self.subTest(expected=expected):
                # A bad --sha would refuse in preflight; the identity check
                # must refuse first, with the helper never imported.
                result = self.run_cli("--expect-helper-sha256", expected,
                                      "switch", "--sha", "nothex", "--tag", self.tag)
                self.assertEqual(result.returncode, 2)
                self.assertIn("refused:", result.stderr)
                self.assertIn("helper", result.stderr)
                self.assertNotIn("--sha", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(lock.exists())
                self.assertEqual(list(self.record_dir.iterdir()), [])
                self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)


    def switch_cli_fixture(self, recorded_run=False, pin_helper=False):
        self.write_state("queue.json", {"items": [], "starts": []})
        if recorded_run:
            # Real probe and dependencies, tracked before the helper clean guard.
            # Copy the checkout's production modules, including dependencies
            # added by a composed target, rather than freezing an old import list.
            for source in sorted(ROOT.glob("*.py")):
                if not source.name.startswith("test_"):
                    shutil.copy(source, self.runner / source.name)
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
        helper_digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        pin = ["--expect-helper-sha256", helper_digest] if pin_helper else []
        result = self.run_cli(*pin, "switch", "--sha", pinned, "--tag", "crq-runner/20261028-2",
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
        self.assertEqual(artifact["helper_sha256"], helper_digest)
        journals = [json.loads(p.read_text())
                    for p in self.record_dir.glob("controller-*.json")]
        self.assertEqual([j["helper_sha256"] for j in journals], [helper_digest])

    def test_health_cli_missing_heartbeat_refuses_with_isolated_env(self):
        # The CLI subprocess resolves WATCHDOG_HOME from its own environment:
        # an isolated XDG_STATE_HOME means the actual user heartbeat is never
        # consulted, and no queue tick can substitute for it.
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:00:00Z"})
        result = self.run_cli("health",
                              env={"XDG_STATE_HOME": str(self.base / "cli-xdg")})
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        self.assertIn("completion heartbeat", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_health_cli_stale_heartbeat_is_unhealthy_with_unchanged_shape(self):
        xdg = self.base / "cli-xdg"
        (xdg / "crq").mkdir(parents=True)
        payload = {"last_tick": "2026-10-28T00:00:00Z", "stale_alarm_min": 36,
                   "schedule_id": None, "root": str(self.runner),
                   "alert_agent_id": None, "alert_agent_host": None}
        (xdg / "crq/heartbeat.json").write_text(json.dumps(payload) + "\n")
        # An advancing queue save must not mask the stale completion slot.
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:20:00Z"})
        result = self.run_cli("health", "--first-tick-timeout-seconds", "0", env={"XDG_STATE_HOME": str(xdg)})
        self.assertEqual(result.returncode, 1)
        artifact = json.loads(result.stdout)
        self.assertEqual(artifact["operation"], "health")
        self.assertFalse(artifact["healthy"])
        self.assertIn("first observation", artifact["reason"])
        first = artifact["observations"][0]
        self.assertEqual(first["observed_tick"], "2026-10-28T00:00:00Z")
        self.assertFalse(first["advanced"])
        self.assertIn("receipts", first)

    def test_refusal_exits_2_with_stderr_reason_and_no_stdout_artifact(self):
        result = self.run_cli("switch", "--sha", "nothex", "--tag", self.tag)
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        self.assertEqual(result.stdout, "")


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


if __name__ == "__main__":
    unittest.main()
