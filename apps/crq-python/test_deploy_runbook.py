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
MARKER_RELPATH = rb.MARKER_RELPATH


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
        # The live runtime: the overlay points repair.cq_bin here, so the
        # live-dist assertion has a real tree to hash. It starts as a copy
        # of the candidate dist and node_modules (the deployed artifact),
        # exactly as a completed deploy leaves it; the live-deps assertion
        # added with the finding-4 fix hashes the runtime's node_modules
        # against candidate_deps_sha256.
        shutil.copytree(self.candidate / "dist", self.base / "runtime/dist")
        # ``symlinks=True`` keeps the fixture's dependency symlinks as links:
        # following them would materialise extra files inside the target and
        # change the deps digest away from candidate_deps_sha256.
        shutil.copytree(self.candidate / "node_modules",
                        self.base / "runtime/node_modules", symlinks=True)
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
        # A clean state queue: the D7 preflight gate reads it on the live
        # tree, so every fixture starts from the shape the controller grants
        # automatic rollback for. Tests that need a different queue rewrite
        # it in their own setUp.
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        (self.runner / "state" / "queue.json").write_text(
            json.dumps({"items": [], "starts": []}) + "\n")
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
            "operator_go": False,
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
        assertions still apply to the fake journal that lands. The fake
        switch performs the REAL git checkout to the target (the production
        controller's switch does), so post-switch assertions like the
        pointer render and the live-dist digest see the deployed state."""
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
        original_fake = run.run_controller_switch

        def switching_fake(record_dir):
            # The production helper restores tracked config and detaches at
            # the target; emulate that here (the live render is recorded by
            # live_render before the switch and rewritten after it).
            subprocess.run(["git", "-C", str(self.args_root(args)),
                            "checkout", "-q", "--",
                            "apps/crq-python/config.json"], check=True,
                           capture_output=True)
            subprocess.run(["git", "-C", str(self.args_root(args)),
                            "checkout", "-q", "--detach",
                            args.target_sha], check=True,
                           capture_output=True)
            original_fake(record_dir)

        run.run_controller_switch = switching_fake
        return run

    def args_root(self, args):
        return args.root

    def fake_journal(self):
        # D7 in the controller's own shape: a clean pre-switch queue is what
        # rollback_compatible() grants, so the permission is True, and both
        # records the controller's decision consumes are present (the
        # pre-switch record under plan.preflight). The controller-derived
        # shape is covered by test_journal_is_controller_shaped.
        clean = {"checked": True, "schema_marker_present": False,
                 "schema_observations": []}
        return {
            "operation": "deploy", "outcome": "completed",
            "prior_head": self.prior_sha, "target": self.target,
            "tag": self.target_tag, "helper_sha256": self.helper_sha,
            "automatic_rollback_permitted": True,
            "rollback_compatibility": dict(clean),
            "prior_tag": self.prior_tag,
            "prior_config_sha256": sha256_file(self.runner / "config.json"),
            "schema_version": 1, "transaction_id": "f" * 32,
            "plan": {"preflight": {"rollback_compatibility": dict(clean)}},
        }

    def capture(self, callable, stderr=False):
        """Run a CLI callable with redirected std streams.

        Returns (result, stdout[, stderr]); an exception raised by the
        callable propagates after the streams are restored."""
        import io
        from contextlib import redirect_stderr, redirect_stdout
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            result = callable()
        if stderr:
            return result, out.getvalue(), err.getvalue()
        return result, out.getvalue()

    def grant_rollback(self, run):
        """The D7 evidence assert_journal records, for tests that drive
        restore()/write_release() directly without running a journal."""
        run.rollback = {"automatic_rollback_permitted": True,
                        "statement": "test: automatic rollback remains "
                                     "available"}
        return run

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

    def test_unknown_range_note_key_refuses(self):
        problem = self.validate(
            lambda doc: doc["range_note"].update({"typo_unknown": True}))
        self.assertIsNotNone(problem)
        self.assertIn("range_note", problem)

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
        # A correct pin must carry execution past every digest check into
        # the candidate imports. The sentinel failure proves the pins
        # passed: a digest refusal, or any entry-point crash before the
        # sentinel, fails this test, so it cannot accept a broken entry
        # point (the old broad-except version swallowed exactly that).
        with mock.patch.object(rb, "load_module",
                               side_effect=RuntimeError(
                                   "counterfactual: pins passed")):
            with self.assertRaisesRegex(RuntimeError,
                                        "counterfactual: pins passed"):
                rb.execute(args)

    def test_module_digest_mismatch_refuses_before_import(self):
        # An import is arbitrary code execution: a stale/substituted
        # candidate module must be refused by digest BEFORE load_module
        # runs it. The sentinel records any import attempt.
        document = rb.load_json(Path(self.args().manifest))
        document["identity"]["helper_sha256"] = "2" * 64
        document["identity"]["controller_file_sha256"] = "2" * 64
        manifest_path = self.write_manifest(document)
        args = self.args(manifest_path=manifest_path)
        imported = []
        real_load = rb.load_module

        def recording_load(name, path):
            imported.append(name)
            return real_load(name, path)

        with mock.patch.object(rb, "load_module", side_effect=recording_load):
            with self.assertRaisesRegex(rb.Refused, "digest mismatch"):
                rb.execute(args)
        self.assertEqual(imported, [],
                         "modules imported before their digest pins passed")


class PreflightSplitTests(RunbookFixture):
    """Hold, then observe, then split; and the conditional stop rule."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.manifest_path = self.write_manifest()

    def run_to_preflight(self, units, expect_inventory_ok=True):
        args = self.args()
        run = self.run_runbook(args, units)
        # The hold is claimed before observation: every in-run read happens
        # under this run's own marker.
        run.acquire()
        inventory = run.observe_inventory()
        if expect_inventory_ok:
            run.assert_inventory(inventory)
        return run

    def test_existing_marker_refuses_at_acquire_with_nothing_observed(self):
        foreign = b"someone else's hold\n"
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(foreign)
        # The hold is claimed first, so the loser refuses before reading a
        # single unit state and stops nothing.
        run = self.run_runbook(self.args(), units)

        def forbidden(*unused, **kwargs):
            raise AssertionError("a unit was read or mutated")

        units.inventory = forbidden
        with self.assertRaisesRegex(rb.Refused, "foreign hold"):
            run.run()
        self.assertEqual(units.stopped, [])
        self.assertEqual(units.started, [])
        self.assertEqual(self.marker_path.read_bytes(), foreign)

    def test_foreign_marker_is_never_removed(self):
        foreign = b"a foreign actor's hold; must survive the run\n"
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(foreign)
        run = self.run_runbook(self.args(), units)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "inactive" for unit in TRIGGERS}
        run.split_map = dict(run.original)
        run.stopped_pre = {}
        run.acquired = False
        with self.assertRaisesRegex(rb.Refused, "not ours"):
            run.release_marker()
        self.assertEqual(self.marker_path.read_bytes(), foreign)
        self.assertFalse(run.released)

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

    def test_preflight_failure_restores_only_its_own_intent_and_releases(self):
        # A preflight refusal happens under the hold: run() restarts exactly
        # the units this run's own recorded intent stopped, verifies them,
        # and removes only this run's own marker.
        states = {unit: "active" for unit in TRIGGERS}
        states["crq-repair.timer"] = "inactive"
        units = FakeUnits(self.marker_path, states)
        run = self.run_runbook(self.args(), units)
        with mock.patch.object(run, "preflight",
                               side_effect=rb.Refused("preflight boom")):
            with self.assertRaisesRegex(rb.Refused, "preflight boom"):
                run.run()
        self.assertTrue(run.pre_hold_restored)
        self.assertIsNone(run.pre_hold_restore_error)
        self.assertEqual(sorted(run.stopped_pre),
                         ["crq-backfill.timer", "crq-repair.path"])
        self.assertEqual(sorted(units.started),
                         ["crq-backfill.timer", "crq-repair.path"],
                         "only this run's own recorded intent is started")
        self.assertNotIn("crq-repair.timer", units.started)
        self.assertFalse(self.marker_path.exists())
        phase = rb.load_json(run.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "refused_released")
        self.assertTrue(phase["released"])
        self.assertTrue(phase["pre_hold_restored"])

    def test_refusal_restore_failure_keeps_the_hold(self):
        # If the restore itself fails, the marker stays: recovery_required,
        # never a claim that the host is back.
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        with mock.patch.object(run, "preflight",
                               side_effect=rb.Refused("preflight boom")), \
                mock.patch.object(units, "start",
                                  side_effect=RuntimeError("start failed")):
            with self.assertRaisesRegex(rb.Refused, "preflight boom"):
                run.run()
        self.assertFalse(run.pre_hold_restored)
        self.assertIn("start failed", run.pre_hold_restore_error)
        self.assertTrue(self.marker_path.exists(), "hold retained")
        phase = rb.load_json(run.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "recovery_required")
        self.assertFalse(phase["pre_hold_restored"])
        self.assertIn("start failed", phase["restore_error"])

    def test_observation_and_split_happen_under_this_runs_hold(self):
        # Ordering: the marker is claimed before the first inventory read, so
        # no second run can find the host unheld while this one observes and
        # splits it. The proof is the hold being owned at every read.
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        held_at_read = []
        real_inventory = units.inventory

        def inventory():
            held_at_read.append(run.owns_marker())
            return real_inventory()

        units.inventory = inventory
        real_state = units.state
        states_under_hold = []

        def state(unit):
            states_under_hold.append(run.owns_marker())
            return real_state(unit)

        units.state = state
        self.assertEqual(run.run()["outcome"], "completed")
        self.assertEqual(held_at_read, [True],
                         "the inventory read must happen under the hold")
        self.assertTrue(states_under_hold)
        self.assertTrue(all(states_under_hold),
                        "every state read must happen under the hold")

    def test_restore_starts_exactly_the_original_active_set(self):
        states = {unit: "active" for unit in TRIGGERS}
        states["crq-repair.timer"] = "inactive"
        units = FakeUnits(self.marker_path, states)
        run = self.run_to_preflight(units)
        # Pre-split capture (crq finding F1): the F4 proof needs the states
        # from BEFORE the split; the post-split map reads the long triggers
        # inactive and would accept leaving them stopped.
        pre_split = {unit: units.state(unit) for unit in run.triggers}
        run.split_long_triggers()
        self.assertEqual(run.original, pre_split)
        # Simulate the end-of-run state: all stopped, marker owned.
        for unit in run.triggers:
            units.states[unit] = "inactive"
        run.output_dir.mkdir(parents=True, exist_ok=True)
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
        self.grant_rollback(run)
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

    def test_final_triggers_verified_and_durable_before_unlink(self):
        # The final map is observed twice; both reads must equal original
        # before the marker is removed, and the verified map plus the
        # original must be durable in phase.json BEFORE the unlink.
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "active" for unit in TRIGGERS}
        run.split_map = {**run.original,
                         **{unit: "inactive" for unit in LONG}}
        run.output_dir.mkdir(parents=True, exist_ok=True)
        durable_write_marker_record(run)
        run.acquire()
        real_state = units.state
        mode = {"name": "normal"}
        calls = {"n": 0}

        def observed(unit):
            calls["n"] += 1
            value = real_state(unit)
            n = len(TRIGGERS)
            first = calls["n"] <= n
            if mode["name"] == "first_read_bad" and first \
                    and unit == LONG[0]:
                return "inactive"
            if mode["name"] == "second_read_bad" and not first \
                    and unit == LONG[0]:
                return "inactive"
            return value

        # Attempt 1: the first full observation disagrees with original.
        # Refusal BEFORE the second read; the hold is retained.
        mode["name"] = "first_read_bad"
        calls["n"] = 0
        with mock.patch.object(units, "state", side_effect=observed):
            with self.assertRaisesRegex(rb.Refused, "trigger restore mismatch"):
                run.restore()
        self.assertTrue(self.marker_path.exists(),
                        "failed restore must retain the hold")
        # Attempt 2: the first observation passes but the verification read
        # disagrees; release refuses before the marker is removed.
        mode["name"] = "second_read_bad"
        calls["n"] = 0
        with mock.patch.object(units, "state", side_effect=observed):
            with self.assertRaisesRegex(
                    rb.Refused, "trigger restore verification mismatch"):
                run.restore()
        self.assertTrue(self.marker_path.exists())
        # Attempt 3: both reads agree; the phase record with the verified
        # final map lands before the unlink, marker gone at the end.
        mode["name"] = "normal"
        calls["n"] = 0
        run.restore()
        self.assertFalse(self.marker_path.exists())
        phase = rb.load_json(run.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "final_triggers")
        self.assertEqual(phase["final_triggers"], run.original)
        self.assertEqual(phase["original"], run.original)


class ReleasedFlagGateTests(RunbookFixture):
    """status --require-released: independent re-read and its refusals."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.status_args = argparse_namespace(
            output_dir=self.output_dir, require_released=True)
        self.digest = sha256_file(OPS / "deploy-runbook.py")

    def write_pair(self, release=None, phase=None, marker_record=True,
                   phase_triggers=True, rehearsal=False):
        rb.durable_write(self.output_dir / "release.json", release or {
            "released_at": "2026-11-13T12:00:00Z",
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "rehearsal": rehearsal,
            "runbook_sha256": self.digest})
        document = {
            "phase": "completed", "released": True,
            "rehearsal": rehearsal,
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": self.digest}
        if phase_triggers:
            document["triggers"] = {unit: "active" for unit in TRIGGERS}
        rb.durable_write(self.output_dir / "phase.json",
                         phase or document)
        if marker_record:
            rb.durable_write(self.output_dir / "marker.path",
                             {"path": str(self.marker_path)})

    def status(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.base)}):
            return rb.cmd_status(self.status_args,
                                 units=FakeUnits(
                                     self.marker_path,
                                     {unit: "active" for unit in TRIGGERS}))

    def test_passes_after_release_and_prints_the_map(self):
        self.write_pair()
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 0)
        artifact = json.loads(stdout.getvalue())
        self.assertTrue(artifact["released"])
        self.assertEqual(artifact["released_at"], "2026-11-13T12:00:00Z")
        self.assertEqual(artifact["final_triggers"],
                         {unit: "active" for unit in TRIGGERS})
        # Requirement 2: the live observed state is printed beside the
        # release record.
        self.assertEqual(artifact["live_triggers"],
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
            "rehearsal": True,
            "runbook_sha256": "2" * 64})
        rb.durable_write(self.output_dir / "phase.json", {
            "phase": "completed", "released": True,
            "rehearsal": True,
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": "2" * 64,
            "triggers": {unit: "active" for unit in TRIGGERS}})
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = self.status()
        self.assertEqual(code, 1)
        artifact = json.loads(stdout.getvalue())
        self.assertFalse(artifact["released"])
        self.assertIn("stale copy", artifact["refusal"])
        # Requirement 1: the refusal names both digests.
        self.assertIn("2" * 64, artifact["refusal"])
        self.assertIn(self.digest, artifact["refusal"])

    def test_missing_release_artifact_refuses(self):
        rb.durable_write(self.output_dir / "phase.json", {
            "phase": "completed", "released": True,
            "rehearsal": True,
            "final_triggers": None, "runbook_sha256": self.digest,
            "triggers": {unit: "active" for unit in TRIGGERS}})
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

    def test_require_released_reaches_status_when_given(self):
        # Parser-level default (finding 1): status keeps an explicit flag.
        self.write_pair()
        argv = ["status", "--output-dir", str(self.output_dir),
                "--require-released"]
        stdout = io_string()
        units = FakeUnits(self.marker_path,
                          {unit: "active" for unit in TRIGGERS})
        with mock.patch.object(sys, "stdout", stdout):
            code = rb.main(argv, status_units=units)
        self.assertEqual(code, 0)
        artifact = json.loads(stdout.getvalue())
        self.assertTrue(artifact["released"])


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
        self.grant_rollback(run)
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
        clean = {"checked": True, "schema_marker_present": False,
                 "schema_observations": []}
        return {
            "operation": "deploy", "outcome": "completed",
            "prior_head": self.prior_sha, "target": self.target,
            "tag": self.target_tag, "helper_sha256": self.helper_sha,
            "automatic_rollback_permitted": True,
            "rollback_compatibility": dict(clean),
            "prior_tag": self.prior_tag,
            "prior_config_sha256": sha256_file(self.runner / "config.json"),
            "schema_version": 1, "transaction_id": "abc123",
            "plan": {"preflight": {"rollback_compatibility": dict(clean)}},
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
                         ("automatic_rollback_permitted", False),
                         ("automatic_rollback_permitted", None),
                         ("rollback_compatibility", {"checked": False}),
                         ("rollback_compatibility", None),
                         ("plan", None),
                         ("prior_tag", "crq-runner/19990101-2"),
                         ("schema_version", 2), ("transaction_id", None)):
            with self.subTest(key=key, bad=bad):
                message = self.assert_journal_field(key, bad)
                self.assertTrue(message)

    def test_journal_is_controller_shaped(self):
        # The D7 blocker: a test that only passes against a fabricated
        # journal proves nothing. This journal is BUILT BY THE CONTROLLER:
        # compatibility_record reads the fixture queue through the real
        # Effects seam, and deploy_journal shapes the document exactly as
        # deploy_plan writes it, including the rollback_compatible()
        # decision over that record. The assert set must accept the one
        # shape production can produce.
        self.write_queue([{"id": "done", "run": None}])
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args)
        effects = dc.Effects(self.root,
                             Path(args.output_dir) / "controller-records")
        compatibility = dc.compatibility_record(effects, args.target_sha)
        prior_state = {"prior_head": self.prior_sha,
                       "prior_config_sha256":
                           sha256_file(self.runner / "config.json")}
        plan = {"helper_sha256": self.helper_sha,
                "preflight": {"rollback_compatibility": compatibility},
                "rollback_compatibility_after": compatibility,
                "automatic_rollback_permitted":
                    dc.rollback_compatible(compatibility)}
        journal = dc.deploy_journal(prior_state, args.target_sha,
                                    args.target_tag, plan,
                                    prior_tag=self.prior_tag)
        journal["outcome"] = "completed"
        journal["transaction_id"] = "controller-shaped"
        self.assertIs(journal["automatic_rollback_permitted"], True)
        self.assertFalse(journal["rollback_compatibility"]
                         ["schema_marker_present"])
        # The full assertion set accepts the controller-shaped journal, and
        # it records the granted permission for the release.
        run.assert_journal(journal)
        self.assertTrue(run.rollback["automatic_rollback_permitted"])
        self.assertIn("automatic rollback remains available",
                      run.rollback["statement"])

    def test_impossible_pair_refuses(self):
        # The fabricating pair the old rehearsal wrote: permission False
        # beside a clean marker-free record. rollback_compatible() grants
        # True for exactly that record, so this journal is not one the
        # controller can emit, and the assertion set must refuse it.
        message = self.assert_journal_field("automatic_rollback_permitted",
                                            False)
        self.assertIn("automatic_rollback_permitted", message)

    def test_granted_permission_requires_clean_evidence(self):
        # A marker present or an author_* observation with permission True
        # is the fail-closed shape; the evidence assertion refuses it.
        bad = self.base_journal()
        bad["rollback_compatibility"] = {"checked": True,
                                         "schema_marker_present": True,
                                         "schema_observations": []}
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args)
        with self.assertRaisesRegex(rb.Refused, "clean shape"):
            run.assert_journal(bad)
        bad2 = self.base_journal()
        bad2["rollback_compatibility"] = {"checked": True,
                                          "schema_marker_present": False,
                                          "schema_observations":
                                              ["author_requests"]}
        with self.assertRaisesRegex(rb.Refused, "clean shape"):
            run.assert_journal(bad2)

    def test_pre_switch_record_must_be_clean(self):
        # The pre-switch record is the evidence the prior target could read
        # the queue this deploy started from; a marker or author_* key there
        # means the permission True was never granted from evidence.
        for dirty in ({"checked": True, "schema_marker_present": True,
                       "schema_observations": []},
                      {"checked": True, "schema_marker_present": False,
                       "schema_observations": ["author_quota"]},
                      {"checked": False, "schema_marker_present": False,
                       "schema_observations": []}):
            with self.subTest(dirty=dirty):
                bad = self.base_journal()
                bad["plan"] = {"preflight":
                               {"rollback_compatibility": dirty}}
                document = self.manifest()
                args = self.args(
                    manifest_path=self.write_manifest(document))
                run = self.run_runbook(args)
                with self.assertRaisesRegex(rb.Refused,
                                            "pre-switch queue"):
                    run.assert_journal(bad)

    def test_release_records_the_granted_permission(self):
        # The operator must know the controller's automatic rollback stays
        # available after a deploy this runbook never rolls back.
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        self.assertEqual(run.run()["outcome"], "completed")
        release = rb.load_json(self.output_dir / "release.json")
        self.assertIs(release["rollback"]
                      ["automatic_rollback_permitted"], True)
        self.assertIn("never invokes rollback",
                      release["rollback"]["statement"])


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
        result = run.run()
        self.assertEqual(result["outcome"], "completed")
        self.assertTrue(result["released"])
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
        # The refusal is a pre-switch one: this run restores its own split
        # and releases its own hold, so the host is back to its original
        # states rather than left recovery-required.
        self.assertEqual(phase["phase"], "refused_released")
        self.assertFalse(self.marker_path.exists())
        for unit in TRIGGERS:
            self.assertEqual(self.units.state(unit), "active")

    def test_must_not_mode_refuses_before_the_switch(self):
        # The helper's verify_target requires the target on origin/main, so
        # a must_not manifest cannot complete a real deploy: refuse before
        # the switch; the refusal restores the split and releases the hold.
        document = self.manifest()
        document["ancestry"]["target_on_origin_main"] = "must_not"
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "must_not is not deployable"):
            run.run()
        for unit in self.units.states:
            self.assertEqual(self.units.state(unit), "active",
                             "split must be restored after the refusal")
        self.assertFalse(self.marker_path.exists())

    def test_must_not_mode_refuses_even_when_main_moved_past_target(self):
        self.move_main_under_target()
        document = self.manifest()
        document["ancestry"]["target_on_origin_main"] = "must_not"
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "must_not is not deployable"):
            run.run()
        for unit in self.units.states:
            self.assertEqual(self.units.state(unit), "active")

    def test_rehearsal_pins_the_script_revision(self):
        # The rehearsal pins the same digest the operator names: a different
        # --runbook-sha256 refuses before anything runs.
        document = self.manifest()
        args = self.args(manifest_path=self.write_manifest(document),
                         runbook_sha256="4" * 64)
        with self.assertRaisesRegex(rb.Refused, "runbook digest mismatch"):
            rb.execute(args)


class CLITests(RunbookFixture):
    """The CLI entry point itself: argv in, effects via the injectable
    factory, assertion on the factory's argument. Codex findings 1-5 are
    regression-tested here, at the layer that let them through."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.units = FakeUnits(self.marker_path)
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text(
            json.dumps({"items": [{"id": "done", "run": None}],
                        "starts": []}) + "\n")

    def cli_argv(self, **overrides):
        args = self.args(**overrides)
        argv = ["--target-sha", str(args.target_sha),
                "--target-tag", args.target_tag,
                "--candidate-root", str(args.candidate_root),
                "--prior-root", str(args.prior_root),
                "--prior-sha", args.prior_sha,
                "--prior-tag", args.prior_tag,
                "--root", str(args.root),
                "--overlay", str(args.overlay),
                "--baseline-journal", str(args.baseline_journal),
                "--manifest", str(args.manifest),
                "--manifest-sha256", args.manifest_sha256,
                "--runbook-sha256", args.runbook_sha256,
                "--output-dir", str(args.output_dir)]
        if args.controller is not None:
            argv += ["--controller", str(args.controller)]
        if args.rehearsal:
            argv += ["--rehearsal"]
        return argv

    def factory_recorder(self, units=None):
        """An effects factory that records its construction argument: the
        assertion target for 'no real effects were constructed'."""
        calls = []
        chosen = units or self.units

        def factory(marker_path, effects_builder):
            calls.append(marker_path)
            return rb.RunEffects(chosen, effects_builder())

        return factory, calls

    def with_fake_switch(self, factory=None):
        """Patch ``Run.run`` so the CLI-path Run writes the fake controller
        journal instead of spawning the real controller subprocess; the
        journal assertions still apply to what lands. Pass a factory through
        to hand it to ``main`` with the patch in place."""
        original = rb.Run.run

        def patched_run(run_self):
            self.install_fake_controller_journal(run_self)
            return original(run_self)

        rb.Run.run = patched_run
        self.addCleanup(setattr, rb.Run, "run", original)
        return factory

    def test_hostname_argument_is_enforced(self):
        # The operator's --hostname restricts the deploy to one host: the
        # wrong host refuses before any unit mutation, the right host runs.
        args = self.args(hostname="some-other-host")
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "wrong host"):
            run.run()
        self.assertEqual(self.units.stopped, [])
        self.assertFalse(self.marker_path.exists())
        # A second run needs its own durable map: the refused first attempt
        # already wrote phase.json in the shared output dir.
        self.output_dir = self.base / "out-right-host"
        run2 = self.run_runbook(self.args(hostname=self.observed_hostname()),
                                self.units)
        self.assertEqual(run2.run()["outcome"], "completed")

    def test_active_triggers_refuse_production_without_authorization(self):
        # A production invocation (operator_go False) with active triggers
        # refuses before any effect construction: no provider, no journal,
        # no import. The systemctl probe is mocked to report active units
        # so the test never depends on this host's bus.
        args = self.args(rehearsal=False, operator_go=False)

        def refusing_factory(marker_path, effects_builder):
            raise AssertionError("effects constructed before the active-unit "
                                 "guard")

        listing = "active active running crq-tick.timer\n"
        with mock.patch.object(rb, "load_module") as load, \
                mock.patch.object(rb.subprocess, "run",
                                  return_value=mock.Mock(returncode=0,
                                                         stdout=listing)):
            with self.assertRaisesRegex(rb.Refused,
                                        "live crq trigger units are active"):
                rb.execute(args, effects_factory=refusing_factory)
            load.assert_not_called()

    def test_operator_go_probe_is_skipped(self):
        # Authorized invocations never run the authorization probe: no
        # list-units subprocess at all. The run is patched at preflight so
        # only execute()'s probe behavior is under test.
        args = self.args(rehearsal=False, operator_go=True)
        run = self.run_runbook(args, self.units)
        with mock.patch.object(rb.subprocess, "run") as probe, \
                mock.patch.object(run, "preflight",
                                  side_effect=rb.Refused("stop here")):
            with self.assertRaises(rb.Refused):
                run.run()
        for call in probe.call_args_list:
            self.assertNotIn("list-units", call.args[0])

    def test_operator_go_authorizes_production_with_active_triggers(self):
        # --operator-go is the explicit production authorization: the run
        # proceeds with active triggers, observes them as original, splits
        # the long ones and restores the ORIGINAL map, so no trigger is
        # left stopped and the release completes.
        args = self.args(rehearsal=False, operator_go=True)
        run = self.run_runbook(args, self.units)
        self.assertEqual(run.run()["outcome"], "completed")
        phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "completed")
        self.assertTrue(phase["released"])
        self.assertFalse(phase["rehearsal"])
        release = rb.load_json(self.output_dir / "release.json")
        self.assertEqual(release["final_triggers"], phase["original"])
        for unit, state in phase["original"].items():
            self.assertEqual(self.units.state(unit), state,
                             "restore must return to the original state")

    def test_every_phase_record_carries_original_and_stop_intent(self):
        # CodeRabbit major: original and stopped_pre survive every phase
        # transition, including recovery_required records.
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(self.args(), units)
        with mock.patch.object(run, "preflight",
                               side_effect=rb.Refused("preflight boom")):
            with self.assertRaises(rb.Refused):
                run.run()
        with (self.output_dir / "phase.json").open() as handle:
            phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "refused_released")
        self.assertTrue(phase["original"])
        self.assertIsNotNone(phase["stopped_pre"])
        run2 = self.run_runbook(self.args(), FakeUnits(self.marker_path))
        run2.output_dir.mkdir(parents=True, exist_ok=True)
        run2.phase("held")
        held = rb.load_json(run2.output_dir / "phase.json")
        self.assertIsNone(held["original"])
        self.assertIsNone(held["stopped_pre"])

    @staticmethod
    def observed_hostname():
        return subprocess.check_output(["hostname"], text=True).strip()

    def test_deploy_invocation_reaches_execute_with_default_flag(self):
        # Finding 1: a normal deploy invocation must not raise AttributeError
        # on a status-only argparse attribute.
        factory, calls = self.factory_recorder()
        code = rb.main(self.cli_argv(),
                       effects_factory=self.with_fake_switch(factory))
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)

    def test_rehearsal_constructs_no_real_effects(self):
        # Finding 3: --rehearsal binds the in-memory provider; RealUnits is
        # never constructed and the real controller subprocess never spawns
        # (the rehearsal journal is the controller module's own switch CLI
        # against the throwaway clone, not a systemd-touching path).
        with mock.patch.object(rb, "RealUnits") as real_units:
            code = rb.main(self.cli_argv())
        self.assertEqual(code, 0)
        real_units.assert_not_called()
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertTrue(phase["rehearsal"])
        self.assertEqual(phase["phase"], "completed")
        release = json.loads((self.output_dir / "release.json").read_text())
        self.assertTrue(release["rehearsal"])

    def test_rehearsal_without_injected_effects_is_refused(self):
        # The CLI rehearsal path must refuse rather than reach systemd if the
        # in-memory binding cannot be built; a direct execute() call with the
        # flag and no factory is the same refusal.
        args = self.args()
        with self.assertRaisesRegex(rb.Refused, "rehearsal requires injected"):
            rb.execute(args, effects_factory=None)

    def test_run_controller_switch_resolves_the_default_controller(self):
        # Finding 4: with --controller omitted, the subprocess argv names the
        # resolved candidate controller, never None. A fresh Run is built
        # here (its run_controller_switch is not yet overridden).
        args = self.args(controller=None)
        host_mod = _load("cli_ctrl_host_" + str(id(args)),
                         self.candidate / "apps/crq-python/ops/prepare-host.py")
        controller_mod = _load(
            "cli_ctrl_controller_" + str(id(args)),
            self.candidate / "apps/crq-python/ops/deploy-controller.py")
        effects = controller_mod.Effects(
            Path(args.root), Path(args.output_dir) / "controller-records")
        run = rb.Run(args, FakeUnits(self.marker_path), host_mod,
                     controller_mod, effects, json.loads(
                         Path(args.manifest).read_text()))
        captured = {}

        def fake_run(cmd, *unused, **kwargs):
            captured["argv"] = cmd
            return argparse_namespace(returncode=0)

        record_dir = self.output_dir / "controller-records"
        record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        with mock.patch.object(rb.subprocess, "run", fake_run):
            run.run_controller_switch(record_dir)
        resolved = str(self.candidate
                       / "apps/crq-python/ops/deploy-controller.py")
        self.assertIn(resolved, captured["argv"])
        self.assertNotIn("None", [str(part) for part in captured["argv"]])

    def test_default_controller_path_completes_the_cli_run(self):
        # Finding 4 end to end: --controller omitted previously executed
        # None after the hold and left recovery-required; the run must
        # complete through main().
        argv = self.cli_argv(controller=None)
        code = rb.main(argv, effects_factory=self.with_fake_switch())
        self.assertEqual(code, 0)
        records = sorted((self.output_dir / "controller-records")
                         .glob("controller-*.json"))
        self.assertEqual(len(records), 1)

    def test_target_sha_mismatch_with_manifest_refuses(self):
        # Finding 5: the CLI target is bound to the manifest identity before
        # any host observation or mutation. The refusal must construct no
        # real effects (RealUnits is the live constructor; the probe proves
        # it is never called) and mutate no unit.
        other = "f" * 40
        document = self.manifest()
        argv = self.cli_argv(target_sha=other,
                             manifest_path=self.write_manifest(document))
        constructed = []
        with mock.patch.object(rb, "RealUnits",
                               side_effect=lambda *a: constructed.append(a)):
            with self.assertRaisesRegex(
                    rb.Refused, "must equal the manifest identity target"):
                rb.main(argv, effects_factory=self.factory_recorder()[0])
        self.assertEqual(constructed, [], "no real effects constructed")
        self.assertEqual(self.units.stopped, [], "no unit mutation")
        # The factory was never called either: the refusal precedes effect
        # construction entirely.
        factory_calls = []

        def refusing_factory(marker_path, effects_builder):
            factory_calls.append(marker_path)
            raise rb.Refused("factory must not be reached")

        with self.assertRaisesRegex(rb.Refused,
                                    "must equal the manifest identity target"):
            rb.execute(self.args(
                target_sha=other,
                manifest_path=self.write_manifest(document)),
                effects_factory=refusing_factory)
        self.assertEqual(factory_calls, [])

    def test_valid_manifest_with_schema_problem_none_does_not_crash(self):
        # Finding 2 at the CLI: a valid manifest previously raised TypeError
        # from an eagerly concatenated error message.
        factory, calls = self.factory_recorder()
        code = rb.main(self.cli_argv(),
                       effects_factory=self.with_fake_switch(factory))
        self.assertEqual(code, 0)

    def test_deploy_prints_one_stdout_document(self):
        # Review finding: the mutating deploy path printed nothing to
        # stdout. Exactly one machine-readable result document lands on
        # stdout for a completed run, and the exit status stays 0.
        code, stdout = self.capture(
            lambda: rb.main(self.cli_argv(),
                            effects_factory=self.with_fake_switch()))
        self.assertEqual(code, 0)
        document = json.loads(stdout)
        self.assertEqual(document["operation"], "deploy")
        self.assertEqual(document["outcome"], "completed")
        self.assertTrue(document["released"])
        self.assertTrue(document["rehearsal"])
        self.assertEqual(document["output_dir"], str(self.output_dir))
        self.assertEqual(document["final_triggers"],
                         {unit: "active" for unit in TRIGGERS})
        self.assertEqual(sorted(document),
                         ["final_triggers", "journal", "marker_path",
                          "operation", "outcome", "output_dir", "prior_sha",
                          "rehearsal", "released", "runbook_sha256",
                          "target", "target_tag"])

    def test_deploy_refusal_prints_stdout_document(self):
        # A terminal refusal lands one machine-readable result document on
        # stdout (outcome refused with the reason) and then propagates, so
        # the process-level error envelope and exit status stay in __main__.
        argv = self.cli_argv()
        argv[argv.index("--target-sha") + 1] = "a" * 40  # unknown target

        def refused():
            with self.assertRaisesRegex(
                    rb.Refused, "must equal the manifest identity target"):
                rb.main(argv, effects_factory=self.with_fake_switch())

        _result, stdout = self.capture(refused)
        document = json.loads(stdout)
        self.assertEqual(document["operation"], "deploy")
        self.assertEqual(document["outcome"], "refused")
        self.assertFalse(document["released"])
        self.assertIn("must equal the manifest identity target",
                      document["reason"])

    def test_argparse_error_prints_envelope_and_exits_2(self):
        # Argument errors used to bypass the JSON envelope entirely (usage
        # text on stderr, empty stdout). argparse's exit raises SystemExit;
        # the envelope lands on stdout with exit status 2.
        argv = []  # no deploy arguments at all

        def failing():
            with self.assertRaises(SystemExit) as caught:
                rb.main(argv)
            self.assertEqual(caught.exception.code, 2)

        _result, stdout = self.capture(failing)
        envelope = json.loads(stdout)
        self.assertEqual(envelope["error"]["kind"], "argument_error")
        self.assertIn("required for a deploy run",
                      envelope["error"]["message"])


class CLIStatusGateTests(RunbookFixture):
    """The status gate through the CLI: digest self-verification (requirement
    1) and the live comparison (requirement 2)."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.digest = sha256_file(OPS / "deploy-runbook.py")
        self.units = FakeUnits(self.marker_path,
                               {unit: "active" for unit in TRIGGERS})

    def write_released(self, runbook_sha256=None, rehearsal=False):
        rb.durable_write(self.output_dir / "release.json", {
            "released_at": "2026-11-13T12:00:00Z",
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "rehearsal": rehearsal,
            "runbook_sha256": runbook_sha256 or self.digest})
        rb.durable_write(self.output_dir / "phase.json", {
            "phase": "completed", "released": True,
            "rehearsal": rehearsal,
            "final_triggers": {unit: "active" for unit in TRIGGERS},
            "runbook_sha256": runbook_sha256 or self.digest,
            "triggers": {unit: "active" for unit in TRIGGERS}})
        rb.durable_write(self.output_dir / "marker.path",
                         {"path": str(self.marker_path)})

    def status_argv(self):
        return ["status", "--output-dir", str(self.output_dir),
                "--require-released"]

    def run_status(self, units=None):
        stdout = io_string()
        with mock.patch.object(sys, "stdout", stdout):
            code = rb.main(self.status_argv(), status_units=units)
        return code, json.loads(stdout.getvalue())

    def test_digest_mismatch_between_file_and_record_refuses(self):
        # Requirement 1: digest of the running file must equal the release
        # record; refusal names both digests.
        self.write_released(runbook_sha256="3" * 64)
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 1)
        self.assertFalse(artifact["released"])
        self.assertIn("runbook digest mismatch", artifact["refusal"])
        self.assertIn("3" * 64, artifact["refusal"])
        self.assertIn(self.digest, artifact["refusal"])

    def test_status_stdout_document_and_empty_stderr(self):
        # Machine mode: the status gate prints its document on stdout and
        # narrates nothing, so a consumer parses one document.
        self.write_released()
        units = FakeUnits(self.marker_path)
        code, stdout, stderr = self.capture(
            lambda: rb.main(self.status_argv(), status_units=units),
            stderr=True)
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["operation"], "status")

    def test_live_trigger_drift_refuses(self):
        # Requirement 2: one trigger not in final_triggers state refuses the
        # gate, and the refusal names the unit, its live and released states.
        self.write_released()
        self.units.states["crq-slot.timer"] = "inactive"
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 1)
        self.assertFalse(artifact["released"])
        self.assertIn("crq-slot.timer", artifact["refusal"])
        self.assertIn("inactive", artifact["refusal"])
        self.assertIn("active", artifact["refusal"])
        self.assertIn("crq-slot.timer", artifact["live_triggers"])

    def test_live_drift_test_fails_without_the_comparison(self):
        # The requirement: this test must fail if the live comparison is
        # removed, so it is not satisfiable by printing alone. Patch the
        # comparator away: the gate must then pass, which contradicts the
        # assertion above.
        self.write_released()
        self.units.states["crq-slot.timer"] = "inactive"
        with mock.patch.object(rb, "read_observed_triggers",
                               return_value={unit: "active"
                                             for unit in TRIGGERS}):
            code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 0)
        self.assertTrue(artifact["released"])

    def test_rehearsal_record_is_refused_by_the_gate(self):
        # Non-negotiable: a rehearsal record must never authorize a
        # production start. The gate marks the result rehearsal-only and
        # refuses under --require-released.
        self.write_released(rehearsal=True)
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 1)
        self.assertFalse(artifact["released"])
        self.assertIn("rehearsal", artifact["refusal"])

    def test_missing_trigger_inventory_refuses(self):
        # A completed record without a trigger inventory must refuse, not
        # pass vacuously on an empty expected list.
        self.write_released()
        phase = json.loads(
            (self.output_dir / "phase.json").read_text())
        phase.pop("triggers")
        rb.durable_write(self.output_dir / "phase.json", phase)
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 1)
        self.assertFalse(artifact["released"])
        self.assertIn("trigger inventory", artifact["refusal"])

    def test_inventory_mismatching_final_triggers_refuses(self):
        # An inventory that does not match final_triggers is an unverified
        # expectation: refuse instead of comparing the wrong unit set.
        self.write_released()
        phase = json.loads(
            (self.output_dir / "phase.json").read_text())
        phase["triggers"] = {unit: "active" for unit in TRIGGERS
                             if unit != "crq-tick.timer"}
        rb.durable_write(self.output_dir / "phase.json", phase)
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 1)
        self.assertIn("trigger inventory", artifact["refusal"])

    def test_passing_gate_prints_live_and_released_maps(self):
        self.write_released()
        code, artifact = self.run_status(units=self.units)
        self.assertEqual(code, 0)
        self.assertTrue(artifact["released"])
        self.assertEqual(artifact["released_at"], "2026-11-13T12:00:00Z")
        self.assertEqual(artifact["final_triggers"],
                         {unit: "active" for unit in TRIGGERS})
        self.assertEqual(artifact["live_triggers"],
                         {unit: "active" for unit in TRIGGERS})


class RunbookMarkerUniquenessTests(RunbookFixture):
    """crq F4 hardening: run-unique marker bytes and restore-order
    guarantees survive the CLI-path fixes."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def test_marker_bytes_are_run_unique_and_exact_byte_verified(self):
        run_a = self.run_runbook(self.args(), FakeUnits(self.marker_path))
        run_b = self.run_runbook(self.args(), FakeUnits(self.marker_path))
        self.assertNotEqual(run_a.marker_bytes(), run_b.marker_bytes())
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(run_a.marker_bytes())
        self.assertTrue(run_a.owns_marker())
        self.assertFalse(run_b.owns_marker())

    def test_phase_records_original_and_stop_intent_before_the_stop(self):
        units = FakeUnits(self.marker_path)
        args = self.args()
        run = self.run_runbook(args, units)
        run.acquire()
        observed = run.observe_inventory()
        run.assert_inventory(observed)
        run.split_long_triggers()
        record = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(record["phase"], "split_intent")
        self.assertEqual(record["original"], run.original)
        self.assertEqual(sorted(record["stopped_pre"]),
                         sorted(run.stopped_pre))
        self.assertEqual(record["triggers"], run.split_map)


class TargetRenderDigestTests(RunbookFixture):
    """Finding 6: the rendered target config is checked against the pinned
    target_state digest unconditionally."""

    def setUp(self):
        super().setUp()
        self.build_repo()

    def test_wrong_target_state_digest_refuses_before_preflight_pass(self):
        document = self.manifest()
        document["config"]["target_state_config_sha256"] = "4" * 64
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused,
                                    "target rendered config digest mismatch"):
            run.run()

    def _overlay(self):
        overlay, _raw = host.load_overlay(self.overlay_path)
        return overlay

    def test_matching_target_state_digest_passes_with_delta(self):
        # head_invariance False with a real config delta: the target render
        # hashes to the recorded target-state digest and preflight passes.
        # The candidate artifact must carry the target's committed config so
        # the candidate/committed/candidate-config relations stay equal, and
        # the runner's state/queue.json must exist for the drain probe.
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text(
            json.dumps({"items": [{"id": "done", "run": None}],
                        "starts": []}) + "\n")
        host_mod = _load("delta_render_host",
                         self.candidate / "apps/crq-python/ops/prepare-host.py")
        overlay, _raw = host_mod.load_overlay(self.overlay_path)
        target_bytes = host_mod.render(self.root, overlay, self.target)
        self.runner.joinpath("config.json").write_bytes(target_bytes)
        self.command("commit", "-qam", "target config delta")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.target_tag = "crq-runner/20261113-10"
        self.command("tag", "-a", self.target_tag, "-m",
                     "fixture delta target", self.target)
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        shutil.copy(self.runner / "config.json",
                    self.candidate / "apps/crq-python/config.json")
        # The delta must survive the overlay: a committed leaf the overlay
        # also supplies would be overwritten by apply() and vanish. The
        # schema_version leaf is committed policy the overlay does not
        # carry, so bumping it in the target commit is a real render delta
        # (head_invariance False) while render(prior) with the CURRENT
        # overlay still reproduces the live bytes after the checkout below.
        committed = json.loads((self.runner / "config.json").read_text())
        committed["schema_version"] = committed.get("schema_version", 1) + 1
        delta_bytes = (json.dumps(committed, indent=2, sort_keys=True)
                       + "\n").encode()
        self.runner.joinpath("config.json").write_bytes(delta_bytes)
        self.command("commit", "-qam", "target config delta: schema_version")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.target_tag = "crq-runner/20261113-11"
        self.command("tag", "-a", self.target_tag, "-m",
                     "fixture delta target 2", self.target)
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        shutil.copy(self.runner / "config.json",
                    self.candidate / "apps/crq-python/config.json")
        # The deployment checkout returns to the pre-run state: detached at
        # the prior target with the CURRENT overlay's render of PRIOR as the
        # dirty file (the drift-free baseline is always PRIOR + live overlay).
        self.command("checkout", "-q", "--detach", self.prior_sha)
        (self.runner / "config.json").write_bytes(
            host_mod.render(self.root, self._overlay(), self.prior_sha))
        document = self.manifest()
        # The pins describing the new target's config state are computed
        # exactly as the runbook verifies them: the committed digest from
        # git show of the new target (the delta), the target-state digest
        # from render(target) with the live overlay.
        committed_bytes = subprocess.run(
            ["git", "-C", str(self.root), "show",
             self.target + ":apps/crq-python/config.json"],
            check=True, capture_output=True).stdout
        document["config"]["target_state_config_sha256"] = \
            hashlib.sha256(host_mod.render(
                self.root, self._overlay(), self.target)).hexdigest()
        document["config"]["head_invariance"] = False
        document["config"]["committed_config_sha256"] = \
            hashlib.sha256(committed_bytes).hexdigest()
        args = self.args(manifest_path=self.write_manifest(document),
                         target_sha=self.target,
                         target_tag=self.target_tag)
        run = self.run_runbook(args, self.units)
        run.run()
        phase = json.loads((self.output_dir / "phase.json").read_text())
        self.assertEqual(phase["phase"], "completed")

    def test_real_delta_target_state_config_refuses_when_unpinned(self):
        # Finding 6's scenario: the target state differs from the running
        # config, so the OLD code (which checked only on equality) skipped
        # the target render digest entirely. The manifest must still pin it:
        # a wrong pinned digest refuses even when target != running.
        host_mod = _load("delta_render_host2",
                         self.candidate / "apps/crq-python/ops/prepare-host.py")
        overlay, _raw = host_mod.load_overlay(self.overlay_path)
        target_bytes = host_mod.render(self.root, overlay, self.target)
        document = self.manifest()
        document["config"]["target_state_config_sha256"] = "9" * 64
        document["config"]["head_invariance"] = False
        args = self.args(manifest_path=self.write_manifest(document))
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused,
                                    "target rendered config digest mismatch"):
            run.run()


class MarkerPathTests(RunbookFixture):
    """The hold must be the file the repair tick polls, and only that file.

    crq.py refuses to do work while ``<repo>/apps/crq-python/state/
    runner-disabled`` exists. A runbook marker anywhere else is not a hold,
    and a manifest that names a different path must be refused rather than
    kept as a second source of truth."""

    def test_marker_is_the_ticks_own_file(self):
        self.build_repo()
        self.assertEqual(rb.marker_path(self.root),
                         self.runner / "state" / "runner-disabled")
        self.assertEqual(MARKER_RELPATH, "state/runner-disabled")
        # The claim is that this is the file the tick polls, so read the
        # tick's source: it derives STATE from the module root and tests
        # STATE / "runner-disabled". Both halves must be true of the path
        # this module computes.
        tick = (ROOT / "crq.py").read_text()
        self.assertIn('STATE = ROOT / "state"', tick)
        self.assertIn('STATE / "runner-disabled"', tick)
        self.assertEqual(MARKER_RELPATH, "state/runner-disabled")

    def test_manifest_marker_path_must_equal_the_tick_path(self):
        self.build_repo()
        document = self.manifest()
        document["marker"]["path"] = "state/somewhere-else"
        args = self.args(manifest_path=self.write_manifest(document))
        built = []

        def factory(marker, effects_builder):
            built.append(marker)
            return FakeUnits(marker)

        # Through execute(), where the manifest is validated: the refusal
        # lands before any effect is constructed, so the wrong path can
        # never become a second hold.
        with self.assertRaisesRegex(rb.Refused,
                                    "marker.path must be exactly"):
            rb.execute(args, effects_factory=factory)
        self.assertEqual(built, [])
        self.assertFalse((self.runner / "state" / "somewhere-else").exists())
        self.assertFalse(self.marker_path.exists())

    def test_execute_hands_the_provider_the_tick_path(self):
        # The value execute() derives is --root's tick file, not the manifest
        # string: the marker the run creates is the one the tick polls. The
        # two acceptance tests above pin that path to crq.py's own test; this
        # pins that execute() passes exactly what marker_path() computes.
        self.build_repo()
        args = self.args()
        seen = []

        def factory(marker, effects_builder):
            seen.append(Path(marker))
            raise rb.Refused("stop after the provider is built")

        with self.assertRaisesRegex(rb.Refused, "stop after the provider"):
            rb.execute(args, effects_factory=factory)
        self.assertEqual(seen, [self.runner / "state" / "runner-disabled"])
        self.assertFalse(self.marker_path.exists())


class ReviewRoundTests(RunbookFixture):
    """The withdrawn-PASS blocker and the four companion findings.

    Blocker (D7): the journal assertion set accepts exactly the journal
    shape deploy_plan() produces, the permission True is backed by a live
    preflight refusal, and the fabricated pair the old rehearsal wrote is
    refused. Findings: a reused --output-dir never overwrites recovery
    evidence; a losing run refuses at the hold so it never restores beneath
    another run's marker; a rehearsal completes an approved
    head_invariance-false delta through the real checkout; and the live
    runtime's node_modules is verified against candidate_deps_sha256 before
    anything restarts."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text(
            json.dumps({"items": [{"id": "done", "run": None}],
                        "starts": []}) + "\n")

    # -- blocker: D7 against controller-shaped input ----------------------
    def test_full_run_accepts_the_controller_derived_journal(self):
        # The whole run at the pinned revision, with the fake switch
        # writing a journal BUILT by the controller's deploy_journal +
        # compatibility_record (not hand-written): the runbook must
        # complete against the one shape production can produce.
        args = self.args()

        def controller_built_switch(record_dir):
            record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            subprocess.run(["git", "-C", str(args.root), "checkout", "-q",
                            "--", "apps/crq-python/config.json"],
                           check=True, capture_output=True)
            subprocess.run(["git", "-C", str(args.root), "checkout", "-q",
                            "--detach", args.target_sha],
                           check=True, capture_output=True)
            effects = dc.Effects(args.root, record_dir)
            compatibility = dc.compatibility_record(effects,
                                                    args.target_sha)
            self.assertTrue(dc.rollback_compatible(compatibility))
            prior_state = {"prior_head": self.prior_sha,
                           "prior_config_sha256": sha256_file(
                               self.runner / "config.json")}
            plan = {"helper_sha256": self.helper_sha,
                    "preflight": {"rollback_compatibility": compatibility},
                    "rollback_compatibility_after": compatibility,
                    "automatic_rollback_permitted":
                        dc.rollback_compatible(compatibility)}
            journal = dc.deploy_journal(prior_state, args.target_sha,
                                        args.target_tag, plan,
                                        prior_tag=self.prior_tag)
            journal["outcome"] = "completed"
            journal["transaction_id"] = "controller-built"
            (record_dir / "controller-built.json").write_text(
                json.dumps(journal, indent=2, sort_keys=True) + "\n")

        run = self.run_runbook(args, self.units)
        run.run_controller_switch = controller_built_switch
        self.assertEqual(run.run()["outcome"], "completed")
        phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "completed")
        journal = rb.load_json(Path(phase["journal"]["path"]))
        self.assertIs(journal["automatic_rollback_permitted"], True)
        self.assertEqual(sorted(journal["rollback_compatibility"]),
                         ["checked", "queue_schema", "schema_marker_present",
                          "schema_observations", "target_sha"])
        release = rb.load_json(self.output_dir / "release.json")
        self.assertTrue(release["rollback"]["automatic_rollback_permitted"])

    def test_rehearsal_journal_is_controller_shaped(self):
        # The CLI rehearsal's journal comes from the controller's own
        # deploy_journal + compatibility_record, so its permission flag is
        # the granted True beside clean evidence: the pair the controller
        # actually emits. The rehearsal at the pinned revision completes.
        argv = self.cli_argv()
        with mock.patch.object(rb, "RealUnits") as real_units:
            code, _stdout = self.capture(lambda: rb.main(argv))
        self.assertEqual(code, 0)
        real_units.assert_not_called()
        phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "completed")
        journal = rb.load_json(Path(phase["journal"]["path"]))
        self.assertTrue(journal["automatic_rollback_permitted"])
        self.assertFalse(
            journal["rollback_compatibility"]["schema_marker_present"])
        self.assertEqual(sorted(journal["rollback_compatibility"]),
                         ["checked", "queue_schema", "schema_marker_present",
                          "schema_observations", "target_sha"])
        # The rehearsal journal carries the same pre-switch record the
        # controller writes, so the assertion set exercised both halves.
        self.assertTrue(journal["plan"]["preflight"]
                        ["rollback_compatibility"]["checked"])

    def cli_argv(self, **overrides):
        """The deploy invocation for a rehearsal through main()."""
        args = self.args(**overrides)
        argv = ["--target-sha", str(args.target_sha),
                "--target-tag", args.target_tag,
                "--candidate-root", str(args.candidate_root),
                "--prior-root", str(args.prior_root),
                "--prior-sha", args.prior_sha,
                "--prior-tag", args.prior_tag,
                "--root", str(args.root),
                "--overlay", str(args.overlay),
                "--baseline-journal", str(args.baseline_journal),
                "--manifest", str(args.manifest),
                "--manifest-sha256", args.manifest_sha256,
                "--runbook-sha256", args.runbook_sha256,
                "--output-dir", str(args.output_dir)]
        if args.controller is not None:
            argv += ["--controller", str(args.controller)]
        if args.rehearsal:
            argv += ["--rehearsal"]
        return argv

    def test_host_queue_that_denies_rollback_refuses_before_the_switch(self):
        # D7 from host truth: the permission the journal must carry is only
        # safe because preflight runs the controller's own compatibility
        # computation on the LIVE queue and refuses when it denies rollback.
        # A schema marker and an author_* key are both refusals, named.
        for queue, pattern in (
                ({"schema_version": "unmarked",
                  "items": [{"id": "done", "run": None}]},
                 "explicit schema marker"),
                ({"author_quota": {}, "items": []},
                 "author_quota")):
            with self.subTest(pattern=pattern):
                self.output_dir = self.base / ("out-" + pattern[:4])
                (self.runner / "state" / "queue.json").write_text(
                    json.dumps(queue) + "\n")
                run = self.run_runbook(self.args(), self.units)
                with self.assertRaisesRegex(rb.Refused, pattern):
                    run.run()
                phase = rb.load_json(self.output_dir / "phase.json")
                self.assertEqual(phase["phase"], "refused_released")
                self.assertFalse(self.marker_path.exists(),
                                 "this run's own hold is released")
                for unit in TRIGGERS:
                    self.assertEqual(self.units.state(unit), "active",
                                     "the split this run made is restored")
                self.units = FakeUnits(self.marker_path)

    # -- finding 1: reused output dir --------------------------------------
    def test_reused_output_dir_never_overwrites_recovery_evidence(self):
        # A first run retains its recovery record; a retry into the same
        # --output-dir refuses BEFORE writing anything, and the original
        # phase.json evidence is byte-identical afterwards.
        units = FakeUnits(self.marker_path)
        args = self.args()
        run = self.run_runbook(args, units)
        with mock.patch.object(run, "preflight",
                               side_effect=rb.Refused("first failure")):
            with self.assertRaisesRegex(rb.Refused, "first failure"):
                run.run()
        first = (self.output_dir / "phase.json").read_bytes()
        self.assertIn(b"refused_released", first)
        retry = self.run_runbook(self.args(), FakeUnits(self.marker_path))
        with self.assertRaisesRegex(rb.Refused, "fresh --output-dir"):
            retry.run()
        self.assertEqual((self.output_dir / "phase.json").read_bytes(), first)
        self.assertFalse(self.marker_path.exists())

    # -- finding 2: a loser never acts beneath another run's hold ----------
    def test_acquire_refuses_a_foreign_hold_before_any_observation(self):
        # The race: another run takes the marker before this run can. The
        # loser refuses at acquire, having read and stopped nothing, and the
        # winner's bytes are untouched.
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        foreign = b"another run's hold; not ours\n"
        self.marker_path.write_bytes(foreign)
        run = self.run_runbook(self.args(), units)

        def forbidden(*unused, **kwargs):
            raise AssertionError("loser read a unit")

        units.inventory = forbidden
        with self.assertRaisesRegex(rb.Refused, "foreign hold"):
            run.run()
        self.assertEqual(units.stopped, [])
        self.assertEqual(units.started, [])
        self.assertEqual(self.marker_path.read_bytes(), foreign)
        self.assertFalse(run.acquired)
        self.assertFalse(run.released)

    def test_losing_run_does_not_restore_under_a_foreign_hold(self):
        # The risk the ordering removed: a run whose split had already
        # stopped units must not restart them beneath another run's hold.
        # The hold-first sequence means a loser never stops anything, and a
        # refusal that did stop units restores only its own recorded intent
        # before releasing its own marker (covered in PreflightSplitTests).
        # Here the marker is foreign from the start and no stop ever happens.
        units = FakeUnits(self.marker_path)
        self.marker_path.parent.mkdir(parents=True, exist_ok=True)
        self.marker_path.write_bytes(b"another run's hold\n")
        run = self.run_runbook(self.args(), units)
        with self.assertRaisesRegex(rb.Refused, "foreign hold"):
            run.run()
        self.assertEqual(units.stopped, [],
                         "a loser never stops a unit")
        self.assertEqual(units.started, [],
                         "no trigger may start beneath a foreign hold")
        self.assertFalse(run.pre_hold_restored)
        self.assertIsNone(run.pre_hold_restore_error,
                          "nothing was ours to restore or report")

    # -- finding 3: rehearsal completes an approved delta -------------------
    def test_rehearsal_completes_approved_delta_through_real_checkout(self):
        # The exact case the rehearsal exists for: head_invariance false
        # with a real committed config delta. The rehearsal switch now
        # performs the real checkout, so the post-switch live render the
        # target-state digest pins is the one the rehearsal itself wrote.
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / "queue.json").write_text(
            json.dumps({"items": [{"id": "done", "run": None}],
                        "starts": []}) + "\n")
        host_mod = _load("rehearsal_delta_host",
                         self.candidate / "apps/crq-python/ops/prepare-host.py")
        overlay, _raw = host_mod.load_overlay(self.overlay_path)
        committed = json.loads((self.runner / "config.json").read_text())
        committed["schema_version"] = committed.get("schema_version", 1) + 1
        delta_bytes = (json.dumps(committed, indent=2, sort_keys=True)
                       + "\n").encode()
        self.runner.joinpath("config.json").write_bytes(delta_bytes)
        self.command("commit", "-qam", "target config delta: schema_version")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.target_tag = "crq-runner/20261113-12"
        self.command("tag", "-a", self.target_tag, "-m",
                     "fixture rehearsal delta", self.target)
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        shutil.copy(self.runner / "config.json",
                    self.candidate / "apps/crq-python/config.json")
        self.command("checkout", "-q", "--detach", self.prior_sha)
        (self.runner / "config.json").write_bytes(
            host_mod.render(self.root, overlay, self.prior_sha))
        document = self.manifest()
        committed_bytes = subprocess.run(
            ["git", "-C", str(self.root), "show",
             self.target + ":apps/crq-python/config.json"],
            check=True, capture_output=True).stdout
        document["config"]["target_state_config_sha256"] = \
            hashlib.sha256(host_mod.render(
                self.root, overlay, self.target)).hexdigest()
        document["config"]["head_invariance"] = False
        document["config"]["committed_config_sha256"] = \
            hashlib.sha256(committed_bytes).hexdigest()
        args = self.args(manifest_path=self.write_manifest(document),
                         target_sha=self.target,
                         target_tag=self.target_tag)
        self.assertEqual(args.target_sha, self.target)
        # Through --rehearsal (main -> make_rehearsal_effects_factory ->
        # install_rehearsal_journal), not the test fake: the rehearsal path
        # itself must complete an approved delta.
        code, _stdout = self.capture(lambda: rb.main(self.cli_argv(
            manifest_path=self.write_manifest(document),
            target_sha=self.target, target_tag=self.target_tag)))
        self.assertEqual(code, 0)
        phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "completed")
        self.assertTrue(phase["rehearsal"])
        # The rehearsal's checkout actually moved HEAD to the delta target.
        head = subprocess.run(
            ["git", "-C", str(self.root), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(head, self.target)
        self.assertNotEqual(
            sha256_file(self.runner / "config.json"),
            sha256_file(self.prior / "apps/crq-python/config.json"),
            "the delta must actually be rendered live after the switch")

    # -- finding 4: live node_modules verified ------------------------------
    def test_stale_live_node_modules_refuses_before_restore(self):
        # The finding: an approved dist copied over stale deps passes a
        # dist-only check. With the runtime's node_modules diverging from
        # candidate_deps_sha256, the release refuses at the journal
        # boundary; the hold is retained and NOTHING is restarted.
        shutil.rmtree(self.base / "runtime/node_modules")
        (self.base / "runtime/node_modules").mkdir()
        (self.base / "runtime/node_modules" / "pkg-stale").mkdir()
        (self.base / "runtime/node_modules" / "pkg-stale" / "index.js") \
            .write_text("stale\n")
        args = self.args()
        run = self.run_runbook(args, self.units)
        with self.assertRaisesRegex(rb.Refused, "live deps digest mismatch"):
            run.run()
        phase = rb.load_json(self.output_dir / "phase.json")
        self.assertEqual(phase["phase"], "recovery_required")
        self.assertTrue(self.marker_path.exists(), "hold retained")
        self.assertEqual(self.units.started, [], "nothing restarted")
        self.assertEqual(self.units.states,
                         {unit: "inactive" for unit in TRIGGERS})


class TreeDigestRefusalTests(RunbookFixture):
    """Finding 8: a dist-tree entry of any other kind refuses."""

    def digest_of(self, tree):
        return dg.tree_digest(tree)

    def test_directory_symlink_refuses(self):
        tree = self.base / "t1"
        (tree / "sub").mkdir(parents=True)
        (tree / "sub" / "f.js").write_text("x")
        (tree / "outside").mkdir()
        (tree / "outside" / "evil.sh").write_text("#!/bin/sh\n")
        (tree / "sub2").symlink_to(tree / "outside")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.digest_of(tree)

    def test_dangling_symlink_refuses(self):
        tree = self.base / "t2"
        tree.mkdir()
        (tree / "gone").symlink_to(tree / "nowhere")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.digest_of(tree)

    def test_special_file_refuses(self):
        tree = self.base / "t3"
        tree.mkdir()
        os.mkfifo(tree / "pipe")
        with self.assertRaisesRegex(ValueError, "special"):
            self.digest_of(tree)

    def test_dist_digest_covers_everything_present(self):
        tree = self.base / "t4"
        (tree / "sub").mkdir(parents=True)
        (tree / "sub" / "a.js").write_text("a")
        baseline = self.digest_of(tree)
        # An added directory symlink is not silently skipped: it refuses, so
        # the digest can never stay unchanged while content leaves the tree.
        (tree / "link").symlink_to(tree / "sub")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.digest_of(tree)
        (tree / "link").unlink()
        self.assertEqual(self.digest_of(tree), baseline)


def io_string():
    import io
    return io.StringIO()


class CqBinPointerTests(RunbookFixture):
    """The pointer policy compares RENDERED cq_bin values: an ordinary host
    overlay resolving @HOST_CQ_BIN@ identically in prior and target is not
    a move and must not require authorization."""

    def setUp(self):
        super().setUp()
        self.build_repo()
        self.host_mod = _load(
            "cqbin_host_" + str(id(self)),
            self.candidate / "apps/crq-python/ops/prepare-host.py")

    def pointer_run(self, pointer_may_move):
        overlay, _raw = self.host_mod.load_overlay(self.overlay_path)
        document = self.manifest()
        document["config"]["cq_bin_pointer_may_move"] = pointer_may_move
        args = self.args(manifest_path=self.write_manifest(document))
        units = FakeUnits(self.marker_path)
        run = self.run_runbook(args, units)
        run.triggers = list(TRIGGERS)
        run.original = {unit: "active" for unit in run.triggers}
        run.split_map = dict(run.original)
        run.output_dir.mkdir(parents=True, exist_ok=True)
        return run

    def test_placeholder_candidate_with_unchanged_render_passes(self):
        # The candidate config carries the committed placeholder form; the
        # rendered prior and target pointers are equal, so no authorization
        # is required and the policy check passes.
        run = self.pointer_run(False)
        run.assert_cq_bin_policy(self.candidate)

    def test_rendered_move_requires_authorization(self):
        # A real rendered pointer move (the live pointer resolved to a
        # different host path than the approved target render) refuses at
        # release: the written-bytes digest check fires first, and the
        # pointer comparison remains the authorization boundary for the
        # authorized case (which also verifies the digest, so a moved
        # pointer only passes with cq_bin_pointer_may_move AND a manifest
        # pinning the moved target state).
        moved_render = lambda run: mock.patch.object(
            run.host, "live_render",
            side_effect=lambda root, ov, raw: (
                Path(root) / "apps/crq-python/config.json").write_bytes(
                    self.host_mod.encode(self._moved_config(root))))
        run = self.pointer_run(False)
        with moved_render(run):
            # The whole-bytes digest gate fires first: moved bytes are not
            # the pinned target state, whatever the authorization flag says.
            with self.assertRaisesRegex(
                    rb.Refused,
                    "released config digest mismatch"):
                run.point()
        # The pointer comparison remains the authorization boundary: with
        # cq_bin_pointer_may_move and a manifest pinned to the moved state
        # (this fixture's config.json now IS the moved render), the
        # authorized run releases the moved pointer.
        run3 = self.pointer_run(True)
        with moved_render(run3):
            run3.point()
        live = json.loads((Path(run3.args.root)
                           / "apps/crq-python/config.json").read_text())
        self.assertEqual(live["repair"]["cq_bin"], "/opt/cq/bin.other")

    def _moved_config(self, root):
        """The approved target render, with the pointer resolved elsewhere:
        what a stray writer would leave in the live bytes."""
        overlay, _raw = self.host_mod.load_overlay(self.overlay_path)
        config = json.loads(self.host_mod.render(
            Path(root), overlay,
            self.manifest()["identity"]["target_sha"]))
        config["repair"]["cq_bin"] = "/opt/cq/bin.other"
        return config

    def test_point_releases_only_the_approved_pointer(self):
        # After live_render, the released live pointer must equal the
        # rendered target's approved pointer; a divergence refuses.
        run = self.pointer_run(False)
        run.point()
        overlay, _raw = self.host_mod.load_overlay(self.overlay_path)
        approved = json.loads(self.host_mod.render(
            Path(run.args.root), overlay,
            run.manifest["identity"]["target_sha"]))
        live = json.loads(
            (Path(run.args.root) / "apps/crq-python/config.json").read_text())
        self.assertEqual(live.get("repair", {}).get("cq_bin"),
                         approved.get("repair", {}).get("cq_bin"))


def durable_write_marker_record(run):
    """The marker.path record the run writes at start (Run._run_body does
    this; direct-step tests call this helper instead). Absolute, matching
    the run: the status gate reads it from any working directory."""
    rb.durable_write(Path(run.output_dir) / "marker.path",
                     {"path": str(Path(run.marker).resolve())})


if __name__ == "__main__":
    unittest.main()
