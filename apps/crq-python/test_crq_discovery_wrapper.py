"""Discovery wrapper: decode, schema and parser refusal boundaries.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import contextlib
import copy
import json
import re
import tempfile
from pathlib import Path
import unittest
from unittest import mock
import review_receipt
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class DiscoveryFailureFixture:
    def patch(self, obj, name, **kwargs):
        patcher = mock.patch.object(obj, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="q2-discovery-fault-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.patch(crq, "STATE", new=self.root)
        self.patch(crq, "QUEUE", new=self.root / "queue.json")
        self.patch(crq, "now", return_value=crq.parse_iso("2026-10-03T00:00:01Z"))
        self.patch(crq, "CONFIG", new={**crq.CONFIG, "merged_discovery": {
            "enabled": True, "after": self.AFTER, "before": self.BEFORE}})
        self.forge = self.patch(crq, "gh_json", side_effect=self.forge_response)
        self.reset_case()

    def reset_case(self, count=1):
        self.count = count
        self.q = {"created_at": self.AFTER, "items": [], "starts": [],
                  "merged_watermark": self.AFTER,
                  "merged_discovery": {"after": self.AFTER, "before": self.BEFORE, "complete": False}}
        key = review_receipt.digest({"repo": crq.REPO, "base": "main-or-merge-queue",
                                     "after": self.AFTER, "before": self.BEFORE})
        self.path = self.root / "reconcile" / (key + ".json")
        self.path.parent.mkdir(exist_ok=True)
        self.path.unlink(missing_ok=True)
        crq.save_queue(self.q)
        self.forge.reset_mock()

    def forge_response(self, args):
        self.assertEqual(args[:3], ["api", "graphql", "-f"])
        self.assertEqual(len(args), 4)
        self.assertTrue(args[3].startswith("query="))
        repository = {"id": "fixture-repository", "nameWithOwner": crq.REPO}
        if "issues(last:" in args[3]:
            repository.update(issues={"totalCount": 0, "nodes": []},
                              pullRequests={"totalCount": self.count, "nodes": [{"number": self.count}]})
        else:
            numbers = re.findall(r"issueOrPullRequest\(number:(\d+)\)", args[3])
            self.assertTrue(numbers)
            for value in numbers:
                repository["n" + value] = {"__typename": "PullRequest", "number": int(value),
                    "baseRefName": "merge-queue", "mergedAt": "2026-10-02T00:00:00Z",
                    "mergeCommit": {"oid": "a" * 40}, "headRefOid": "b" * 40}
        return {"data": {"repository": repository}}

    def wrapper(self, checkpoint=None):
        value = {"source": {"version": 1, "method": "all-number-slots-v1", "repo": crq.REPO,
            "base": "main-or-merge-queue", "repository_id": "fixture-repository", "ceiling": self.count,
            "window": crq.merged_reconcile.NUMBER_WINDOW}, "checkpoint": checkpoint}
        value["digest"] = review_receipt.digest(value)
        return value

    def put_wrapper(self, value):
        self.path.write_text(json.dumps(value))

    def manual(self, q=None, budget=4):
        return crq.reconcile_merged(self.q if q is None else q, after=self.AFTER,
                                    before=self.BEFORE, page_budget=budget)

    def discover(self, q=None):
        return crq.discover_merged(self.q if q is None else q, crq.ForgeBudget(),
                                   interval={"after": self.AFTER, "before": self.BEFORE})

    @contextlib.contextmanager
    def fault(self, *, stage=None, wrapper_write=None, post=False):
        """Raise before install or after a real isolated atomic replacement."""
        atomic = crq.repair_tick.atomic
        save = crq._save_discovery_queue
        events = []
        current = [None]
        wrapper_count = [0]
        failed = [False]

        def save_stage(q, name):
            current[0] = name
            return save(q, name)

        def write(path, value):
            self.assertFalse(failed[0], "write after uncertain durability")
            if path == self.path:
                wrapper_count[0] += 1
            target = ((path == crq.QUEUE and current[0] == stage and stage is not None) or
                      (path == self.path and wrapper_count[0] == wrapper_write))
            events.append((str(path), current[0], copy.deepcopy(value), target))
            if target:
                if post:
                    atomic(path, value)
                failed[0] = True
                raise OSError("fixture storage fault")
            return atomic(path, value)

        with mock.patch.object(crq, "_save_discovery_queue", side_effect=save_stage), \
                mock.patch.object(crq.repair_tick, "atomic", side_effect=write):
            yield events
        self.assertTrue(failed[0], "intended storage boundary was not reached")
        self.assertTrue(events[-1][3])
        self.assertEqual(sum(event[3] for event in events), 1)

    @contextlib.contextmanager
    def tick_effects(self):
        """Every external continuation seam is counter-only; discovery stays real."""
        with contextlib.ExitStack() as stack:
            discover = crq.discover_merged
            stack.enter_context(mock.patch.object(crq, "discover_merged", side_effect=
                lambda q, budget, *, interval, recent: discover(q, budget,
                    interval={"after": self.AFTER, "before": self.BEFORE})))
            effects = {}
            def counter(obj, name, result=None):
                effects[name] = stack.enter_context(mock.patch.object(obj, name, return_value=result))
            counter(crq, "load_queue", self.q)
            counter(crq, "fetch")
            for name in ("harvest_review", "refresh_slot_deadline",
                         "write_status", "write_heartbeat", "event", "notify_owner"):
                counter(crq, name)
            for name in ("enroll",):
                counter(crq, name, [])
            for name in ("harvest", "backfill", "archive_legacy", "reconcile_fix_prs"):
                counter(crq.repair_tick, name, [])
            counter(crq.deferred_refresh, "refresh_deferred", [])
            counter(crq, "read_slot_usage", (None, []))
            counter(crq, "admit_available", (False, "fixture-control-flow", 0))
            counter(crq.coverage, "record_opportunity", {})
            yield {k: v for k, v in effects.items() if k not in ("load_queue", "fetch")}


class DiscoveryFailureBoundaryTest(DiscoveryFailureFixture, unittest.TestCase):
    """Real discovery/persistence; temporary files and counter-only tick effects."""

    AFTER = "2026-10-01T00:00:00Z"
    BEFORE = "2026-10-03T00:00:00Z"

    def test_wrapper_decode_and_schema_refusal_records_debt_without_forge(self):
        malformed = [b"\xff", b"{", b"null", b"[]"]
        for field in ("source", "checkpoint"):
            value = self.wrapper()
            del value[field]
            malformed.append(json.dumps(value).encode())
        for source in (None, [], "fixture"):
            value = self.wrapper()
            value["source"] = source
            value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
            malformed.append(json.dumps(value).encode())
        for field, bad in (("version", True), ("repo", "other/repository"), ("base", "main"),
                           ("repository_id", ""), ("ceiling", False), ("window", 1)):
            value = self.wrapper()
            value["source"][field] = bad
            value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
            malformed.append(json.dumps(value).encode())
        for checkpoint in ({}, [], False, 0, "", [1], "invalid"):
            malformed.append(json.dumps(self.wrapper(checkpoint)).encode())
        value = self.wrapper()
        value["digest"] = "0" * 64
        malformed.append(json.dumps(value).encode())
        for shape, raw in enumerate(malformed):
            with self.subTest(shape=shape):
                self.reset_case()
                self.q["items"] = [{"id": "prior", "kind": "merged", "state": "done",
                                    "cycles": [{"run_id": "retained"}], "blocking": [{"id": "finding"}]}]
                self.q["merged_current_requests"] = {"retained": {"receiptId": "prior-receipt"}}
                retained = copy.deepcopy(self.q)
                self.path.write_bytes(raw)
                with mock.patch.object(crq.review_receipt, "enroll") as enroll:
                    for _ in range(2):
                        self.assertIn("incomplete", self.discover()[0])
                        self.assertEqual(self.path.read_bytes(), raw)
                        self.assertEqual(self.q["items"], retained["items"])
                        self.assertEqual(self.q["merged_current_requests"], retained["merged_current_requests"])
                        self.assertEqual(self.q["merged_watermark"], self.AFTER)
                        self.assertFalse(self.q["merged_discovery"]["complete"])
                        self.assertTrue(crq.load_queue()["merged_discovery"]["error"])
                    enroll.assert_not_called()
                self.forge.assert_not_called()

    def test_wrapper_parser_failures_preserve_debt_and_storage_boundary(self):
        original_loads = json.loads
        reason = "wrapper-decode: invalid JSON"
        for error in (ValueError, RecursionError):
            for mode in ("manual", "discovery", "tick", "save-before", "save-after"):
                with self.subTest(error=error.__name__, mode=mode):
                    self.reset_case()
                    self.q["items"] = [{"id": "older-review", "kind": "open", "state": "reviewing",
                        "cycles": [{"run_id": "retained"}], "repair_runs": {"older-repair": {}}}]
                    self.q["merged_current_requests"] = {"retained": {"receiptId": "prior-receipt"}}
                    crq.save_queue(self.q)
                    baseline = copy.deepcopy(self.q)
                    retained_digest = review_receipt.digest(baseline)
                    sentinel = json.dumps({"fixture_parser_boundary": str(self.path),
                                           "error": error.__name__, "mode": mode})
                    self.path.write_text(sentinel)
                    encounters = []
                    order = []
                    save = crq._save_discovery_queue

                    def dispatch(*args, **kwargs):
                        text = args[0] if args else kwargs.get("s")
                        if text == sentinel:
                            encounters.append("wrapper-parse")
                            raise error("fixture parser fault")
                        return original_loads(*args, **kwargs)

                    def record(q, stage):
                        result = save(q, stage)
                        order.append(stage)
                        return result

                    rounds = 2 if mode == "discovery" else 1
                    with mock.patch.object(crq.review_receipt, "enroll") as enroll:
                        for attempt in range(rounds):
                            with mock.patch.object(crq.json, "loads", side_effect=dispatch):
                                if mode == "manual":
                                    with self.assertRaisesRegex(crq.merged_reconcile.ReconcileRefused,
                                                               "^" + reason + "$"):
                                        self.manual()
                                elif mode == "discovery":
                                    self.assertEqual(self.discover(), [
                                        "merged discovery incomplete; cursor/debt retained: " + reason])
                                elif mode == "tick":
                                    with self.tick_effects() as effects, mock.patch.object(
                                            crq, "_save_discovery_queue", side_effect=record):
                                        effects["refresh_deferred"].side_effect = (
                                            lambda *a, **k: order.append("refresh") or [])
                                        crq.tick()
                                        # Identical frozen bounds are already durable; no rewrite.
                                        self.assertEqual(order[:2], ["refresh", "refusal-debt-save"])
                                        for name in ("harvest_review", "harvest", "enroll",
                                                      "read_slot_usage", "admit_available",
                                                     "write_status", "write_heartbeat"):
                                            effects[name].assert_called_once()
                                else:
                                    with self.tick_effects() as effects, self.fault(
                                            stage="refusal-debt-save", post=mode == "save-after") as events:
                                        with self.assertRaisesRegex(crq.DiscoveryStorageFailed,
                                                                   "refusal-debt-save"):
                                            crq.tick()
                                        effects["refresh_deferred"].assert_called_once()
                                        for name, effect in effects.items():
                                            if name != "refresh_deferred":
                                                effect.assert_not_called()
                                        self.assertEqual([event[1] for event in events],
                                                         ["refusal-debt-save"])
                            # Shared parser restored before persisted reloads or digest checks.
                            self.assertIs(json.loads, original_loads)
                            self.assertEqual(len(encounters), attempt + 1)
                            disk = crq.load_queue()
                            self.assertEqual(self.path.read_text(), sentinel)
                            for value in (self.q, disk):
                                for field in ("items", "merged_current_requests", "merged_watermark"):
                                    self.assertEqual(value[field], baseline[field])
                                for field in ("after", "before", "complete"):
                                    self.assertEqual(value["merged_discovery"][field],
                                                     baseline["merged_discovery"][field])
                            if mode == "manual" or mode.startswith("save-"):
                                self.assertEqual(self.q, baseline)
                                self.assertEqual(review_receipt.digest(self.q), retained_digest)
                            if mode in ("manual", "save-before"):
                                self.assertEqual(disk, baseline)
                            else:
                                self.assertEqual(disk["merged_discovery"]["error"], reason)
                            if mode.startswith("save-"):
                                self.assertEqual(disk, events[-1][2] if mode == "save-after" else baseline)
                            if mode == "discovery":
                                # Resume only from actual persisted debt, after parser restoration.
                                self.assertEqual(self.q, disk)
                                self.q = disk
                        enroll.assert_not_called()
                    self.forge.assert_not_called()

    def test_valid_complete_wrapper_validates_and_enrolls_once(self):
        first = self.manual()
        self.assertTrue(first["complete"])
        self.assertEqual(first["reviewed"], 0)
        saved = crq.load_queue()
        self.assertEqual(len(saved["items"]), 1)
        self.assertEqual(saved["items"][0]["state"], "pending")
        self.forge.reset_mock()
        self.manual(saved)
        self.assertEqual(crq.load_queue(), saved)
        self.assertEqual(len(saved["items"]), 1)
        self.forge.assert_not_called()
        # A valid digest cannot make the complete fast path skip source validation.
        value = json.loads(self.path.read_text())
        value["source"]["repo"] = "other/repository"
        value["digest"] = review_receipt.digest({k: v for k, v in value.items() if k != "digest"})
        self.put_wrapper(value)
        with self.assertRaises(crq.merged_reconcile.ReconcileRefused):
            self.manual(saved)

    def test_resumed_bounds_drop_a_previous_refusal_error(self):
        self.path.write_bytes(b"{")
        self.assertIn("incomplete", self.discover()[0])
        self.assertIn("error", crq.load_queue()["merged_discovery"])
        self.path.unlink()
        stages = []
        save = crq._save_discovery_queue

        def record(q, stage):
            stages.append((stage, copy.deepcopy(q["merged_discovery"])))
            return save(q, stage)

        with mock.patch.object(crq, "_save_discovery_queue", side_effect=record):
            self.assertIn("complete=True", self.discover()[0])
        self.assertEqual(stages[0], ("bounds-save", {"after": self.AFTER, "before": self.BEFORE,
                                                     "complete": False}))
        self.assertNotIn("error", crq.load_queue()["merged_discovery"])

    def test_wrapper_read_io_aborts_without_mutating_caller(self):
        read = Path.read_text
        for error in (PermissionError, OSError):
            with self.subTest(error=error.__name__):
                baseline = copy.deepcopy(self.q)
                def denied(path, *args, **kwargs):
                    if path == self.path:
                        raise error("fixture read fault")
                    return read(path, *args, **kwargs)
                with mock.patch.object(Path, "read_text", new=denied), \
                        mock.patch.object(crq, "save_queue") as save:
                    with self.assertRaisesRegex(crq.DiscoveryStorageFailed, "wrapper-read"):
                        self.discover()
                    save.assert_not_called()
                self.assertEqual(self.q, baseline)
                self.forge.assert_not_called()
        # Missing wrapper is a first run, not a storage refusal.
        self.assertFalse(self.path.exists())
        self.assertTrue(self.manual()["complete"])
