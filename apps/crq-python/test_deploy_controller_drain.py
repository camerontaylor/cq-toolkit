"""Q7 deployment controller characterization: drain admission checks.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc


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
