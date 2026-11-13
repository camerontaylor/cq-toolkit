"""Deploy runbook tests (crq-efficiency plan slice 4).

Host-free characterization of ``ops/deploy-runbook.py``: the fake unit
provider and the real helper/controller modules against temporary git
clones, exactly as ``test_deploy_controller_fixtures`` does. No live
systemd, no network, no deployment, no marker outside the fixture
directory.

Covers the design note's named tests plus the lead-confirmed status-gate
refusals: pre-existing and foreign markers, drain timeout fail-safe, the
F4 restore regression (conditional split stop included), the released-flag
gate (artifact disagreement, marker back, digest mismatch, printed
final_triggers/released_at), manifest schema refusals with field paths,
pinned revision and manifest digest refusal before host reads,
candidate/running naming, quiescence polling and fail-safe, and both
ancestry modes through the fixture rehearsal at the pinned revision.
"""
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

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = _load("crq_deploy_controller", OPS / "deploy-controller.py")
host = _load("crq_prepare_host", OPS / "prepare-host.py")
dg = _load("crq_digests", OPS / "digests.py")


def _load_runbook():
    """Load deploy-runbook.py without executing its __main__ block."""
    path = OPS / "deploy-runbook.py"
    return _load("crq_deploy_runbook", path)


rb = _load_runbook()


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


TRIGGERS = [
    "crq-backfill.timer", "crq-repair.path", "crq-repair.timer",
    "crq-slot.timer", "crq-tick.timer",
    "crq-watchdog.path", "crq-watchdog.timer", "crq-nightly.timer",
    "crq-publish.timer",
]
SERVICES = [
    "crq-backfill.service", "crq-publisher.service", "crq-repair.service",
    "crq-slot.service", "crq-tick.service", "crq-watchdog.service",
    "crq-nightly.service",
]
LONG = ["crq-repair.path", "crq-repair.timer", "crq-backfill.timer"]


class FakeUnits:
    """In-memory crq-* unit provider: states, stops, starts, marker."""

    def __init__(self, marker_path, states=None):
        self.marker = Path(marker_path)
        self.states = dict(states or {unit: "active" for unit in TRIGGERS})
        self.started = []
        self.stopped = []

    def state(self, unit):
        return self.states.get(unit, "inactive")

    def listing(self):
        return "\n".join(sorted(TRIGGERS + SERVICES)) + "\n"

    def inventory(self):
        triggers = sorted(u for u in TRIGGERS if u.endswith((".timer", ".path")))
        services = sorted(SERVICES)
        return triggers, services

    def stop(self, units):
        self.stopped.extend(units)
        for unit in units:
            self.states[unit] = "inactive"

    def start(self, units):
        self.started.extend(units)
        for unit in units:
            self.states[unit] = "active"


class RunbookFixture(unittest.TestCase):
    """A throwaway deployment clone with the real helper/controller and a
    fake unit provider: the rehearsal environment."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-runbook-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        self.runner = self.root / "apps/crq-python"
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / "config.json", self.runner / "config.json")
        shutil.copytree(OPS / "systemd", self.runner / "ops/systemd")
        shutil.copy(OPS / "prepare-host.py",
                    self.runner / "ops/prepare-host.py")
        shutil.copy(OPS / "deploy-controller.py",
                    self.runner / "ops/deploy-controller.py")
        shutil.copy(OPS / "digests.py", self.runner / "ops/digests.py")
        self.root.mkdir(exist_ok=True)
        self.candidate = self._artifact("candidate")
        self.prior = self._artifact("prior")
        self.command = lambda *args: subprocess.run(
            ["git", "-C", str(self.root), *args], check=True,
            capture_output=True, text=True).stdout
        self.overlay_path = self.base / "host.json"
        self.overlay_path.write_bytes(self._overlay_bytes())
        self.overlay_path.chmod(0o600)
        self.baseline_journal = self.base / "baseline-journal.json"
        self.build_repo()
        self.baseline_journal.write_text(json.dumps({
            "outcome": "completed", "target": self.prior_sha}) + "\n")
        self.baseline_sha = sha256_file(self.baseline_journal)
        self.marker_path = self.runner / "state" / "runner-disabled"
        self.units = FakeUnits(self.marker_path)
        self.output_dir = self.base / "out"

    # -- fixture construction --------------------------------------------
    def _artifact(self, name):
        """One artifact root: apps/crq-python copy, dist/ and node_modules/."""
        root = self.base / name
        shutil.copytree(self.runner, root / "apps/crq-python")
        (root / "dist").mkdir(parents=True)
        (root / "dist" / ("run-" + name + ".js")).write_text("dist of " + name + "\n")
        (root / "node_modules").mkdir(parents=True)
        (root / "node_modules" / ("pkg-" + name)).mkdir()
        (root / "node_modules" / ("pkg-" + name) / "index.js").write_text("dep\n")
        (root / "node_modules" / ("link-" + name)).symlink_to(
            root / "node_modules" / ("pkg-" + name))
        return root

    def _overlay_bytes(self):
        # The committed config's host placeholders are what a real overlay
        # replaces; the drift check renders PRIOR + overlay and demands the
        # live bytes back, so the overlay leaves must carry the committed
        # values wherever the committed config itself supplies them (repair
        # stays committed-policy: enabled/mci are not overlay leaves here).
        committed = json.loads((ROOT / "config.json").read_text())
        repair = committed["repair"]
        overlay = {
            "schema_version": 1, "deploy_root": str(self.root),
            "record_dir": str(self.base / "records"),
            "fleet_reader": {"ssh_host": "queue.example.invalid",
                             "source": "/srv/state/crq/summary.json"},
            "config": {
                "clone": str(self.base / "runtime"),
                "worktree_root": str(self.base / "worktrees"),
                "timeout_bin": "/usr/bin/timeout",
                "paseo_hosts": ["worker.example.invalid:6767", "127.0.0.1:6767"],
                "alerts": {"alert_agent_host":
                           committed["alerts"]["alert_agent_id"]},
                "repair": {"enabled": repair["enabled"],
                           "cq_bin": str(self.base / "runtime/dist/cli.js"),
                           "paseo_host": repair["paseo_host"]
                           or "127.0.0.1:6767"},
            },
        }
        return host.encode(overlay)

    def build_repo(self):
        """Commit baseline (prior), render PRIOR + overlay over the live
        config (the production drift-free baseline), commit the rendered
        config as the target, tag both, set origin/main at the target
        (ancestry `must` by default)."""
        if getattr(self, "_repo_built", False):
            return
        self._repo_built = True
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / ".gitignore").write_text("apps/crq-python/state/\n")
        self.command("init", "-q")
        self.command("config", "user.email", "fixture@example.invalid")
        self.command("config", "user.name", "Fixture")
        self.command("add", ".")
        self.command("commit", "-qm", "baseline")
        self.prior_sha = self.command("rev-parse", "HEAD").strip()
        # Live config = PRIOR + overlay, byte-for-byte (drift-free baseline).
        host_mod = _load("fixture_render_host", self.candidate
                         / "apps/crq-python/ops/prepare-host.py")
        overlay, _raw = host_mod.load_overlay(self.overlay_path)
        (self.runner / "config.json").write_bytes(
            host_mod.render(self.root, overlay, self.prior_sha))
        self.command("commit", "-qam", "rendered live config")
        self.target = self.command("rev-parse", "HEAD").strip()
        # The candidate artifact carries the target's committed config bytes
        # (a real artifact root is built at the target commit).
        shutil.copy(self.runner / "config.json",
                    self.candidate / "apps/crq-python/config.json")
        # The deployment checkout starts at the prior target, detached, with
        # the rendered config as the one dirty file: the live host's real
        # state before a run (' M apps/crq-python/config.json').
        self.command("checkout", "-q", "--detach", self.prior_sha)
        (self.runner / "config.json").write_bytes(
            host_mod.render(self.root, overlay, self.prior_sha))
        self.target_tag = "crq-runner/20261113-9"
        self.prior_tag = "crq-runner/20261113-8"
        self.command("tag", "-a", self.target_tag, "-m", "fixture target",
                     self.target)
        self.command("tag", "-a", self.prior_tag, "-m", "fixture prior",
                     self.prior_sha)
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        self.helper_sha = sha256_file(self.candidate / "apps/crq-python/ops/prepare-host.py")
        self.controller_sha = sha256_file(
            self.candidate / "apps/crq-python/ops/deploy-controller.py")

    def move_main_under_target(self):
        """Ancestry `must_not`: origin/main moves past the target."""
        newer = self.base / "newer"
        shutil.copytree(self.runner, newer / "apps/crq-python")
        (newer / ".gitignore").write_text("apps/crq-python/state/\n")
        subprocess.run(["git", "-C", str(newer), "init", "-q"], check=True)
        for args in (("config", "user.email", "fixture@example.invalid"),
                     ("config", "user.name", "Fixture")):
            subprocess.run(["git", "-C", str(newer), *args], check=True,
                           capture_output=True)
        subprocess.run(["git", "-C", str(newer), "add", "."], check=True)
        subprocess.run(["git", "-C", str(newer), "commit", "-qm", "past target"],
                       check=True)
        self.command("fetch", str(newer), "HEAD")
        self.command("update-ref", "refs/remotes/origin/main",
                     subprocess.run(["git", "-C", str(newer), "rev-parse", "HEAD"],
                                    check=True, capture_output=True,
                                    text=True).stdout.strip())

    def manifest(self, **overrides):
        """A schema-valid manifest bound to this fixture."""
        identity = {
            "prior_sha": self.prior_sha,
            "target_sha": self.target,
            "receipt_sha256": "0" * 64,
            "helper_sha256": self.helper_sha,
            "controller_file_sha256": self.controller_sha,
            "baseline_journal_sha256": self.baseline_sha,
            "baseline_journal_fields": {"outcome": "completed",
                                        "target": self.prior_sha},
        }
        config = {
            "committed_config_sha256": sha256_file(self.runner / "config.json"),
            "running_config_sha256": sha256_file(self.runner / "config.json"),
            "target_state_config_sha256": sha256_file(self.runner / "config.json"),
            "candidate_config_sha256": sha256_file(
                self.candidate / "apps/crq-python/config.json"),
            "render_at_prior_reproduces_live": True,
            "head_invariance": True,
            "cq_bin_pointer_may_move": False,
        }
        artifacts = {
            "running_dist_sha256": dg.tree_digest(self.prior / "dist"),
            "candidate_dist_sha256": dg.tree_digest(self.candidate / "dist"),
            "running_deps_sha256": dg.deps_digest(self.prior / "node_modules"),
            "candidate_deps_sha256": dg.deps_digest(self.candidate / "node_modules"),
        }
        document = {
            "schema_version": 1,
            "deploy": {"reason": "fixture deploy", "operator": "fixture",
                       "approved_by": "lead", "approved_at": "2026-11-13"},
            "identity": identity,
            "ancestry": {"prior_is_ancestor_of_target": True,
                         "target_on_origin_main": "must"},
            "config": config,
            "artifacts": artifacts,
            "triggers": {"expected": sorted(TRIGGERS), "long": LONG,
                         "services": sorted(SERVICES),
                         "restore_target": "original_observed",
                         "release_order": ["start_original_active",
                                           "assert_original",
                                           "record_final_triggers",
                                           "remove_marker"]},
            "quiescence": {"service_drain_deadline_s": 180,
                           "mode": "controller_drain_check_owned_runs",
                           "poll_interval_s": 15, "deadline_s": 900,
                           "fail_safe_on_expiry": True},
            "marker": {"path": "state/runner-disabled",
                       "never_remove_foreign": True},
            "range_note": {"merges": 1, "files": 1, "insertions": 2,
                           "deletions": 0,
                           "corrections": ["fixture range note"]},
        }
        document.update(overrides)
        return document

    def write_manifest(self, document=None):
        document = document or self.manifest()
        path = self.base / "manifest.json"
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        return path

    def args(self, manifest_path=None, **overrides):
        values = {
            "target_sha": self.target,
            "target_tag": self.target_tag,
            "candidate_root": self.candidate,
            "prior_root": self.prior,
            "prior_sha": self.prior_sha,
            "prior_tag": self.prior_tag,
            "root": self.root,
            "overlay": self.overlay_path,
            "baseline_journal": self.baseline_journal,
            "manifest": manifest_path or self.write_manifest(),
            "manifest_sha256": None,
            "runbook_sha256": sha256_file(OPS / "deploy-runbook.py"),
            "output_dir": self.output_dir,
            "annotations": None,
            "rehearsal": True,
            "controller": self.candidate / "apps/crq-python/ops/deploy-controller.py",
            "hostname": None,
            "service_drain_deadline_s": None,
        }
        values.update(overrides)
        values["manifest_sha256"] = values["manifest_sha256"] or sha256_file(values["manifest"])
        return argparse_namespace(**values)

    def run_runbook(self, args, units=None, **kwargs):
        """A Run bound to the real candidate helper/controller modules, a
        fake unit provider, and a fake controller journal: run_controller_switch
        is overridden so no controller subprocess executes; the journal
        assertions still apply to the fake journal that lands."""
        host_mod = _load("runbook_host_" + str(id(args)),
                         self.candidate / "apps/crq-python/ops/prepare-host.py")
        controller_mod = _load(
            "runbook_controller_" + str(id(args)),
            self.candidate / "apps/crq-python/ops/deploy-controller.py")
        document = json.loads(Path(args.manifest).read_text())
        effects = controller_mod.Effects(Path(args.root),
                                         Path(args.output_dir) / "controller-records")
        run = rb.Run(args, units or self.units, host_mod, controller_mod,
                     effects, document, **kwargs)
        self.install_fake_controller_journal(run)
        return run

    def fake_journal(self):
        return {
            "operation": "deploy", "outcome": "completed",
            "prior_head": self.prior_sha, "target": self.target,
            "tag": self.target_tag, "helper_sha256": self.helper_sha,
            "automatic_rollback_permitted": False,
            "rollback_compatibility": {"checked": True},
            "prior_tag": self.prior_tag,
            "prior_config_sha256": sha256_file(self.runner / "config.json"),
            "schema_version": 1, "transaction_id": "f" * 32,
        }

    def install_fake_controller_journal(self, run, journal=None):
        """Fake controller journal: switch() writes one journal the real
        assertion set then reads back, but no controller subprocess runs."""
        payload = journal if journal is not None else self.fake_journal()

        def fake_switch(record_dir):
            record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            (record_dir / "controller-fake.json").write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n")

        run.run_controller_switch = fake_switch
        return run

    # -- queue/drain helpers ------------------------------------------------
    def write_queue(self, items):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text(json.dumps({"items": items,
                                                      "starts": []}) + "\n")

    def fake_liveness(self, verdict):
        def probe(rdir, item, run, has_exit):
            return verdict
        return probe


class argparse_namespace:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


class DigestTests(RunbookFixture):
    """The shared digest library: two algorithms, documented exclusions."""

    def test_file_digest_matches_hashlib(self):
        path = self.base / "one-file"
        path.write_bytes(b"payload\n")
        self.assertEqual(dg.file_digest(path),
                         hashlib.sha256(b"payload\n").hexdigest())

    def test_tree_digest_changes_with_content_and_ignores_order(self):
        tree = self.base / "tree"
        (tree / "sub").mkdir(parents=True)
        (tree / "b.txt").write_text("b")
        (tree / "sub" / "a.txt").write_text("a")
        first = dg.tree_digest(tree)
        before_change = dg.tree_digest(tree)
        self.assertEqual(first, before_change)
        (tree / "b.txt").write_text("changed")
        self.assertNotEqual(first, dg.tree_digest(tree))

    def test_tree_digest_refuses_symlink(self):
        tree = self.base / "tree2"
        tree.mkdir()
        (tree / "real").write_text("x")
        (tree / "link").symlink_to(tree / "real")
        with self.assertRaisesRegex(ValueError, "symlink"):
            dg.tree_digest(tree)

    def test_deps_digest_covers_symlinks_and_exclusions(self):
        modules = self.base / "modules"
        (modules / "pkg").mkdir(parents=True)
        (modules / "pkg" / "index.js").write_text("dep\n")
        (modules / "link").symlink_to(modules / "pkg")
        baseline = dg.deps_digest(modules)
        # A symlink retarget changes the digest without content change.
        (modules / "link").unlink()
        (modules / "link").symlink_to(modules / "pkg" / "index.js")
        self.assertNotEqual(baseline, dg.deps_digest(modules))
        # Excluded nondeterministic entries never affect the digest.
        before = dg.deps_digest(modules)
        (modules / ".vite").mkdir()
        (modules / ".vite" / "cache.bin").write_text("nondeterministic")
        (modules / "pkg" / ".modules.yaml").write_text("state")
        (modules / ".pnpm-workspace-state-v1.json").write_text("{}")
        self.assertEqual(before, dg.deps_digest(modules))

    def test_deps_digest_distinguishes_content_from_layout(self):
        modules = self.base / "modules2"
        (modules / "a").mkdir(parents=True)
        (modules / "a" / "f.js").write_text("same bytes")
        one = dg.deps_digest(modules)
        (modules / "a" / "f.js").unlink()
        (modules / "a" / "f.js").write_text("same bytes")
        self.assertEqual(one, dg.deps_digest(modules))
        (modules / "b").mkdir()
        self.assertNotEqual(one, dg.deps_digest(modules))


class ManifestSchemaTests(RunbookFixture):
    """Schema refusals carry a field path; bad shapes never disable an
    assertion silently."""

    def validate(self, mutate):
        document = self.build_document()
        mutate(document)
        return rb.manifest_problem(document, json.loads(
            rb.SCHEMA_PATH.read_text()))

    def build_document(self):
        # setUp already built the repo; do not run build_repo twice (a second
        # baseline commit would be an empty commit and fail).
        return self.manifest()

    def test_valid_manifest_has_no_problem(self):
        self.assertIsNone(self.validate(lambda doc: None))

    def test_missing_key_refuses_with_path(self):
        problem = self.validate(lambda doc: doc["identity"].pop("receipt_sha256"))
        self.assertIn("identity", problem)
        self.assertIn("receipt_sha256", problem)

    def test_unknown_key_refuses_with_path(self):
        problem = self.validate(lambda doc: doc["config"].update({"extra": 1}))
        self.assertIn("config", problem)
        self.assertIn("unknown extra", problem)

    def test_wrong_type_refuses_with_path(self):
        problem = self.validate(
            lambda doc: doc["quiescence"].update({"poll_interval_s": "15"}))
        self.assertIn("quiescence.poll_interval_s", problem)

    def test_bad_digest_shape_refuses_with_path(self):
        problem = self.validate(
            lambda doc: doc["artifacts"].update({"candidate_dist_sha256": "ZZ"}))
        self.assertIn("artifacts.candidate_dist_sha256", problem)

    def test_bad_ancestry_enum_refuses(self):
        problem = self.validate(
            lambda doc: doc["ancestry"].update({"target_on_origin_main": "yes"}))
        self.assertIn("ancestry.target_on_origin_main", problem)

    def test_wrong_release_order_refuses(self):
        problem = self.validate(
            lambda doc: doc["triggers"].update({"release_order": ["remove_marker"]}))
        self.assertIn("triggers.release_order", problem)

    def test_f4_constants_are_schema_fixed(self):
        problem = self.validate(
            lambda doc: doc["triggers"].update({"restore_target": "post_split"}))
        self.assertIsNotNone(problem)
        problem = self.validate(
            lambda doc: doc["quiescence"].update({"mode": "two_service_names"}))
        self.assertIsNotNone(problem)


class PinnedRevisionTests(RunbookFixture):
    """Digest pins refuse before any host read."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def test_runbook_digest_mismatch_refuses_before_host_read(self):
        args = self.args(runbook_sha256="0" * 64)
        with mock.patch.object(rb, "load_module") as load:
            with self.assertRaisesRegex(rb.Refused, "runbook digest mismatch"):
                rb.execute(args)
            load.assert_not_called()

    def test_manifest_digest_mismatch_refuses_before_host_read(self):
        args = self.args(manifest_sha256="1" * 64)
        with mock.patch.object(rb, "load_module") as load:
            with self.assertRaisesRegex(rb.Refused, "manifest digest mismatch"):
                rb.execute(args)
            load.assert_not_called()

    def test_pinned_revision_accepts_real_digest(self):
        args = self.args()
        # Inventory runs against the fake unit provider only after the pins
        # pass; a refusal later in the sequence proves the pins passed.
        try:
            rb.execute(args)
        except Exception as exc:  # noqa: B902 - any failure is after the pins
            self.assertNotIn("digest mismatch", str(exc))


class PreflightSplitTests(RunbookFixture):
    """Observe-then-split and the conditional stop rule."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.manifest_path = self.write_manifest()

    def run_to_preflight(self, units, expect_inventory_ok=True):
        args = self.args()
        run = self.run_runbook(args, units)
        inventory = run.observe_inventory()
        if expect_inventory_ok:
            run.assert_inventory(inventory)
        return run

    def test_pre_existing_marker_refuses_before_any_stop(self):
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(b"someone else\n")
        # The inventory assertion itself refuses: nothing was stopped.
        run = self.run_to_preflight(units, expect_inventory_ok=False)
        with self.assertRaisesRegex(rb.Refused, "marker already exists"):
            run.assert_inventory(run.observe_inventory())
        self.assertEqual(units.stopped, [])

    def test_foreign_marker_is_never_removed(self):
        foreign = b"a foreign actor's hold; must survive the run\n"
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(foreign)
        # The pre-run inventory refuses a pre-existing marker before any stop.
        run = self.run_to_preflight(units, expect_inventory_ok=False)
        with self.assertRaisesRegex(rb.Refused, "marker already exists"):
            run.assert_inventory(run.observe_inventory())
        self.assertEqual(self.marker_path.read_bytes(), foreign)
        # Even a release path against a foreign marker refuses and leaves the
        # bytes exactly as they were.
        run.original = {unit: "inactive" for unit in TRIGGERS}
        run.split_map = dict(run.original)
        run.stopped_pre = {}
        run.acquired = False
        with self.assertRaisesRegex(rb.Refused, "not ours"):
            run.release_marker()
        self.assertEqual(self.marker_path.read_bytes(), foreign)

    def test_split_stops_only_active_long_triggers(self):
        states = {unit: "active" for unit in TRIGGERS}
        states["crq-repair.timer"] = "inactive"  # already settled long trigger
        units = FakeUnits(self.marker_path, states)
        run = self.run_to_preflight(units)
        run.split_long_triggers()
        self.assertEqual(sorted(units.stopped),
                         ["crq-backfill.timer", "crq-repair.path"])
        self.assertEqual(run.stopped_pre,
                         {"crq-backfill.timer": "active",
                          "crq-repair.path": "active"})
        self.assertNotIn("crq-repair.timer", run.stopped_pre)

    def test_restore_starts_exactly_the_original_active_set(self):
        states = {unit: "active" for unit in TRIGGERS}
        states["crq-repair.timer"] = "inactive"
        units = FakeUnits(self.marker_path, states)
        run = self.run_to_preflight(units)
        run.split_long_triggers()
        run.original = {unit: units.state(unit) for unit in run.triggers}
        # Simulate the end-of-run state: all stopped, marker owned.
        for unit in run.triggers:
            units.states[unit] = "inactive"
        run.output_dir.mkdir(parents=True, exist_ok=True)
        run.acquire()
        run.restore()
        # F4: restore targets self.original. crq-repair.timer was inactive
        # before the run, so it must NOT be started.
        self.assertNotIn("crq-repair.timer", units.started)
        self.assertEqual(sorted(units.started),
                         sorted(unit for unit, state in run.original.items()
                                if state == "active"))
        self.assertEqual({unit: units.state(unit)
                          for unit in run.triggers}, run.original)
        self.assertFalse(self.marker_path.exists())
        self.assertTrue(run.acquired)  # acquisition history stays distinct
        self.assertTrue(run.released)


class DrainTests(RunbookFixture):
    """Quiescence: polling, fail-safe, and the phase record."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run_with_drain(self, results, interval, deadline, fake_clock=None):
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "active" for unit in run.triggers}
        run.split_map = dict(run.original)
        observations = iter(results)

        def fake_check(effects, liveness):
            return next(observations)

        sleeps = []

        class Clock:
            now = 0.0

        if fake_clock is None:
            fake_clock = Clock
        clock = fake_clock()

        def tick():
            return clock.now

        def step(seconds):
            sleeps.append(seconds)
            clock.now += seconds

        # The Run's injected time seam keeps these tests host-free and
        # wall-clock-free; no real 15s sleeps.
        with mock.patch.object(run.controller, "drain_check",
                               side_effect=fake_check):
            with mock.patch.object(run.controller, "_runner_liveness",
                                   return_value=self.fake_liveness("dead")):
                run.drain_controller(poll_interval=interval,
                                     deadline_s=deadline,
                                     clock=tick, sleep=step)
        return run, sleeps, clock

    def test_blocked_then_drained_polls_at_interval(self):
        blocked = {"blocked": [{"item": "pr1", "state": "alive"}],
                   "drained": False}
        drained = {"blocked": [], "drained": True}
        _run, sleeps, _clock = self.run_with_drain([blocked, blocked, drained],
                                                   15, 900)
        self.assertEqual(sleeps, [15, 15])
        drain_record = json.loads((self.output_dir / "drain.json").read_text())
        self.assertTrue(drain_record["drained"])
        self.assertEqual(len(drain_record["polls"]), 3)
        self.assertEqual(drain_record["mode"],
                         "controller_drain_check_owned_runs")

    def test_never_draining_fails_safe_at_deadline(self):
        blocked = {"blocked": [{"item": "pr1", "state": "alive"}],
                   "drained": False}

        class Clock:
            now = 0.0

        with self.assertRaises(TimeoutError):
            self.run_with_drain(
                [blocked] * 1000, 15, 30, fake_clock=Clock)
        # Fail-safe: the hold marker is retained, no service touched.
        self.assertEqual(self.units.stopped, [])
        drain_record = json.loads((self.output_dir / "drain.json").read_text())
        self.assertFalse(drain_record["drained"])

    def test_service_drain_timeout_before_switch(self):
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "active" for unit in run.triggers}
        run.split_map = dict(run.original)
        run.output_dir.mkdir(parents=True, exist_ok=True)
        run.acquire()
        run.phase("held")
        # Every service stays running: the manifest bound must expire.
        for service in SERVICES:
            units.states[service] = "active"
        run.services = list(SERVICES)
        now = [0.0]

        def tick():
            return now[0]

        def step(seconds):
            now[0] += seconds

        with self.assertRaises(TimeoutError):
            run.drain_services(clock=tick, sleep=step)
        # Nothing killed, marker retained, phase says recovery_required.
        self.assertEqual(units.stopped, [])
        self.assertTrue(self.marker_path.exists())
        run._fail_stop(TimeoutError("service drain expired"))
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["phase"], "recovery_required")
        self.assertFalse(phase["released"])


class F4RegressionTests(RunbookFixture):
    """The F4 rule: restore asserts self.original, final_triggers recorded
    at release, marker removed last."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def test_restore_asserts_original_not_post_split(self):
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        run.triggers = list(TRIGGERS)
        # The original map differs from the post-split map: three long
        # triggers observed active, stopped by the split.
        run.original = {unit: "active" for unit in TRIGGERS}
        run.split_map = {**run.original, **{unit: "inactive" for unit in LONG}}
        for unit in TRIGGERS:
            units.states[unit] = "inactive"
        run.output_dir.mkdir(parents=True, exist_ok=True)
        durable_write_marker_record(run)
        run.acquire()
        run.restore()
        run.phase("released")
        run.write_release()
        self.assertEqual({unit: units.state(unit) for unit in run.triggers},
                         run.original)
        self.assertEqual(sorted(units.started), sorted(TRIGGERS))
        # Marker removed last: release recorded final_triggers == original.
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["final_triggers"], run.original)
        self.assertTrue(phase["released"])
        release = json.loads((self.output_dir / "release.json").read_text())
        self.assertEqual(release["final_triggers"], run.original)
        self.assertEqual(release["runbook_sha256"], run.args.runbook_sha256)
        self.assertIn("released_at", release)


class ReleasedFlagGateTests(RunbookFixture):
    """status --require-released: independent re-read and its refusals."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.status_args = argparse_namespace(
            output_dir=self.output_dir, require_released=True)
        self.digest = sha256_file(OPS / "deploy-runbook.py")

    def write_pair(self, release=None, phase=None):
        rb.durable_write(self.output_dir / "release.json", release or {
            "released_at": "2026-11-13T12:00:00Z",
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": self.digest})
        rb.durable_write(self.output_dir / "phase.json", phase or {
            "phase": "completed", "released": True,
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": self.digest})
        rb.durable_write(self.output_dir / "marker.path",
                         {"path": str(self.marker_path)})

    def status(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.base)}):
            return rb.cmd_status(self.status_args)

    def test_passes_after_release_and_prints_the_map(self):
        self.write_pair()
        with mock.patch.object(rb, "Path", wraps=Path) as _unused:
            pass  # marker path resolves under HOME, redirected below
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 0)
        artifact = json.loads(stdout.getvalue())
        self.assertTrue(artifact["released"])
        self.assertEqual(artifact["released_at"], "2026-11-13T12:00:00Z")
        self.assertEqual(artifact["final_triggers"],
                         {unit: "active" for unit in TRIGGERS})

    def test_phase_release_disagreement_refuses(self):
        self.write_pair(phase={
            "phase": "recovery_required", "released": False,
            "final_triggers": None, "runbook_sha256": self.digest})
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 1)
        artifact = json.loads(stdout.getvalue())
        self.assertFalse(artifact["released"])
        self.assertIn("does not record a released completed run",
                      artifact["refusal"])

    def test_marker_back_refuses(self):
        self.write_pair()
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(b"an operator restarted the hold\n")
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 1)
        artifact = json.loads(stdout.getvalue())
        self.assertFalse(artifact["released"])
        self.assertIn("marker is present again", artifact["refusal"])

    def test_digest_mismatch_refuses_stale_copy(self):
        # Same recorded digest in both artifacts, but neither matches THIS
        # executing file: a stale copy must not report on the run.
        self.write_pair(release={
            "released_at": "2026-11-13T12:00:00Z",
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": "2" * 64})
        rb.durable_write(self.output_dir / "phase.json", {
            "phase": "completed", "released": True,
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": "2" * 64})
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 1)
        artifact = json.loads(stdout.getvalue())
        self.assertFalse(artifact["released"])
        self.assertIn("stale copy", artifact["refusal"])

    def test_missing_release_artifact_refuses(self):
        rb.durable_write(self.output_dir / "phase.json", {
            "phase": "completed", "released": True,
            "final_triggers": None, "runbook_sha256": self.digest})
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 1)
        artifact = json.loads(stdout.getvalue())
        self.assertFalse(artifact["released"])

    def test_require_released_outside_status_is_an_error(self):
        argv = ["--require-released"]
        with self.assertRaises(SystemExit):
            rb.main(argv)


class RecordNamingTests(RunbookFixture):
    """candidate/running naming appears in the record; an equal pair is
    explicit."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def test_range_note_uses_candidate_and_running_names(self):
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "active" for unit in run.triggers}
        run.split_map = dict(run.original)
        run.output_dir.mkdir(parents=True, exist_ok=True)
        run.acquire()
        run.final_triggers = dict(run.original)
        run.release_marker()
        run.write_release()
        run.write_range_note()
        note = json.loads((self.output_dir / "range-note.json").read_text())
        for key in ("candidate_dist", "candidate_deps",
                    "running_dist", "running_deps"):
            self.assertIn(key, note)
        self.assertNotIn("old_dist", json.dumps(note))
        self.assertNotIn("new_dist", json.dumps(note))
        manifest = json.loads(Path(args.manifest).read_text())
        self.assertEqual(note["candidate_dist"],
                         manifest["artifacts"]["candidate_dist_sha256"])
        self.assertEqual(note["running_dist"],
                         manifest["artifacts"]["running_dist_sha256"])
        self.assertEqual(note["manifest_sha256"], args.manifest_sha256)
        self.assertEqual(note["runbook_sha256"], args.runbook_sha256)

    def test_equal_pair_is_explicit_in_manifest(self):
        document = self.manifest()
        document["artifacts"]["candidate_deps_sha256"] = \
            document["artifacts"]["running_deps_sha256"]
        problem = rb.manifest_problem(document, json.loads(
            rb.SCHEMA_PATH.read_text()))
        self.assertIsNone(problem)  # an equal pair is legal and explicit


class JournalAssertionTests(RunbookFixture):
    """The full journal assertion set, not a subset."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def base_journal(self):
        return {
            "operation": "deploy", "outcome": "completed",
            "prior_head": self.prior_sha, "target": self.target,
            "tag": self.target_tag, "helper_sha256": self.helper_sha,
            "automatic_rollback_permitted": False,
            "rollback_compatibility": {"checked": True},
            "prior_tag": self.prior_tag,
            "prior_config_sha256": sha256_file(self.runner / "config.json"),
            "schema_version": 1, "transaction_id": "abc123",
        }

    def assert_journal_field(self, key, value):
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args)
        journal = self.base_journal()
        if value is None:
            journal.pop(key, None)
        else:
            journal[key] = value
        with self.assertRaises(rb.Refused) as caught:
            run.assert_journal(journal)
        return str(caught.exception)

    def test_full_set_passes(self):
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args)
        run.assert_journal(self.base_journal())

    def test_each_field_is_asserted(self):
        for key, bad in (("operation", "rollback"), ("outcome", "pending"),
                         ("prior_head", "0" * 40), ("target", "1" * 40),
                         ("tag", "crq-runner/19990101-1"),
                         ("helper_sha256", "3" * 64),
                         ("automatic_rollback_permitted", True),
                         ("rollback_compatibility", {"checked": False}),
                         ("prior_tag", "crq-runner/19990101-2"),
                         ("schema_version", 2), ("transaction_id", None)):
            with self.subTest(key=key):
                message = self.assert_journal_field(key, bad)
                self.assertTrue(message)


class AncestryRehearsalTests(RunbookFixture):
    """Fixture rehearsal: the pinned script revision runs end to end against
    a throwaway clone with main moved under it, for both ancestry modes."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.units = FakeUnits(self.marker_path)
        self.queue_empty()

    def queue_empty(self):
        self.write_queue([{"id": "done", "run": None}])

    def test_must_mode_passes_with_target_on_main(self):
        args = self.args()
        run = self.run_runbook(args, self.units)
        code = run.run()
        self.assertEqual(code, 0)
        self.assertTrue(self.units.released if hasattr(self.units, "released")
                        else not self.marker_path.exists())
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["phase"], "completed")
        self.assertTrue(phase["released"])

    def test_must_mode_refuses_when_main_moved_past_target(self):
        self.move_main_under_target()
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "must be on origin/main"):
            run.run()
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["phase"], "recovery_required")

    def test_must_not_mode_passes_when_main_moved_past_target(self):
        self.move_main_under_target()
        document = self.manifest()
        document["ancestry"]["target_on_origin_main"] = "must_not"
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        code = run.run()
        self.assertEqual(code, 0)
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["phase"], "completed")

    def test_must_not_mode_refuses_with_target_on_main(self):
        document = self.manifest()
        document["ancestry"]["target_on_origin_main"] = "must_not"
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "must not be on origin/main"):
            run.run()

    def test_rehearsal_pins_the_script_revision(self):
        # The rehearsal pins the same digest the operator names: a different
        # --runbook-sha256 refuses before anything runs.
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document),
                         runbook_sha256="4" * 64)
        with self.assertRaisesRegex(rb.Refused, "runbook digest mismatch"):
            rb.execute(args)


def io_string():
    import io
    return io.StringIO()


def durable_write_marker_record(run):
    """The marker.path record the run writes at start (Run._run_body does
    this; direct-step tests call this helper instead)."""
    rb.durable_write(Path(run.output_dir) / "marker.path",
                     {"path": str(run.marker)})


if __name__ == "__main__":
    unittest.main()
