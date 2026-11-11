"""Offline characterization for the isolated unit-switch proof harness.

No KVM, VM, network, SSH, systemd or production host is touched. The tests pin
the evidence checks, provenance binding and fail-closed report verification.
The real guest run is recorded separately and is not part of the unit suite.
"""
import importlib.util
import base64
import copy
import io
import json
import pathlib
import subprocess
import tempfile
import tarfile
import unittest
import hashlib
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


harness = _load("crq_vm_unit_switch", OPS / "vm-unit-switch.py")
guest = _load("crq_vm_unit_switch_guest", OPS / "vm-unit-switch-guest.py")

NODE = harness.NODE_RUNTIME
PYTHON = harness.PYTHON_RUNTIME
SERVICE = "/home/probe/.config/systemd/user/crq-tick.service"
WANTS = "/home/probe/.config/systemd/user/timers.target.wants/crq-tick.timer"
TIMER = harness.TIMER_PATH
STAGED = harness.STAGED_PATH
COMPLETIONS = harness.COMPLETIONS_PATH
HISTORY_PATH = harness.HISTORY_PATH
STATE = {"queue.json": "c" * 64, "heartbeat.json": "d" * 64}
HISTORY = hashlib.sha256(b"x").hexdigest()
BOOT_BEFORE = "11111111-1111-1111-1111-111111111111"
BOOT_AFTER = "22222222-2222-2222-2222-222222222222"
SOURCE_COMMIT = "c" * 40
GUEST_BYTES = (OPS / "vm-unit-switch-guest.py").read_bytes()
GUEST_SHA = harness.sha256_bytes(GUEST_BYTES)
RUNNER_BYTES = b"runner:source:apps/crq-python"
RUNNER_SHA = harness.sha256_bytes(RUNNER_BYTES)
RECORDS = {}


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _record(name, fields, raw_fields=None):
    raw = json.dumps(raw_fields if raw_fields is not None else fields,
                     sort_keys=True).encode()
    RECORDS[name] = raw
    data = json.dumps(fields, sort_keys=True).encode()
    return {**fields,
            "path": "/home/probe/records/controller-"
                    + hashlib.md5(name.encode()).hexdigest() + ".json",
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def phases():
    RECORDS.clear()
    MATRIX_RECORDS.clear()
    python_sha = _sha(harness.expected_unit(PYTHON))
    node_sha = _sha(harness.expected_unit(NODE))
    preserved = {"state": STATE, "history_sha256": HISTORY}
    prepare = {
        "prepared": {"state": STATE, "history_sha256": HISTORY,
                     "runner_source": {"sha256": RUNNER_SHA,
                                       "crq_sha256": "e" * 64,
                                       "bytes": len(RUNNER_BYTES)}},
        "snapshot": {
            "hostname": "crq-probe", "user": 1000,
            "boot_id": "00000000-0000-0000-0000-000000000000",
            "files": {SERVICE: {"type": "file", "sha256": python_sha},
                      WANTS: {"type": "symlink"}},
            "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                         "ActiveState": "inactive"}},
            "history": {"sha256": HISTORY},
        },
    }
    node_phase = {
        "cli": {"rc": 0},
        "record": _record("switch-node", {
            "outcome": "completed", "phase": "activation_pending",
            "runtime": NODE, "prior_runtime": PYTHON}),
        "completions": {"sequences": [1, 2], "invocations": ["a" * 32, "b" * 32]},
        "installed_runtime": NODE,
        "after": {"files": {SERVICE: {"type": "file", "sha256": node_sha}}},
        "preserved": preserved,
    }
    blocked_alive = [{"item": "drain-alive", "state": "alive",
                      "run": "e" * 32}]
    blocked_ambiguous = [{"item": "drain-ambiguous", "state": "ambiguous",
                          "run": "f" * 32}]
    history_record = {"path": HISTORY_PATH,
                      "sha256": HISTORY, "bytes": 1}

    def file_entry(path, data, mode=0o644):
        return {"path": path, "type": "file", "mode": mode, "uid": 1000,
                "gid": 1000, "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data)}

    def metadata_file(data, mode=0o644):
        return {**file_entry("", data, mode), "xattrs": [],
                "bytes_b64": base64.b64encode(data).decode()}

    def observation(runtime=PYTHON):
        service = harness.expected_unit(runtime).encode()
        timer = b"[Timer]\nOnUnitInactiveSec=1s\n"
        metadata = {
            SERVICE: metadata_file(service),
            TIMER: metadata_file(timer),
            WANTS: {"type": "symlink", "mode": 0o777, "uid": 1000,
                    "gid": 1000, "xattrs": [], "target": "../crq-tick.timer"},
            STAGED: {"type": "missing"},
        }
        metadata[SERVICE].pop("path")
        metadata[TIMER].pop("path")
        units = {
            "crq-tick.service": {
                "LoadState": "loaded", "ActiveState": "inactive",
                "SubState": "dead", "UnitFileState": "static",
                "FragmentPath": SERVICE, "InvocationID": "",
                "Result": "success"},
            "crq-tick.timer": {
                "LoadState": "loaded", "ActiveState": "inactive",
                "SubState": "dead", "UnitFileState": "enabled",
                "FragmentPath": "/home/probe/.config/systemd/user/"
                                "crq-tick.timer",
                "InvocationID": "", "Result": "success"},
        }
        return {
            "state": dict(STATE),
            "units": units,
            "metadata": metadata,
            "jobs": [],
            "records": [history_record],
            "all_records": {root: ([history_record] if root == harness.RECORDS_DIR
                                   else [])
                            for root in harness.RECORD_ROOTS},
            "history": history_record,
            "completions": completion_entries(4),
            "files": {
                SERVICE: file_entry(SERVICE, service),
                TIMER: file_entry(TIMER, timer),
                WANTS: {"path": WANTS, "type": "symlink", "mode": 0o777,
                        "uid": 1000, "gid": 1000,
                        "target": "../crq-tick.timer"},
                STAGED: {"path": STAGED, "type": "missing"},
                COMPLETIONS: {"path": COMPLETIONS, "type": "missing"},
                HISTORY_PATH: file_entry(HISTORY_PATH, b"x", 0o600),
            },
        }

    quiet = observation()
    drain_alive = {
        "kind": "alive", "target_runtime": NODE, "current_runtime": PYTHON,
        "cli": {"rc": 2, "stdout": "{\"refused\": \"queue-owned work\"}",
                "stderr": ""},
        "refused": "queue-owned work is alive or ambiguous; refusing",
        "drain": {"drained": False, "blocked": blocked_alive},
        "observation": {"drained": False, "blocked": blocked_alive},
        "liveness": [{"item": "drain-alive", "run_id": "e" * 32,
                      "has_exit": False, "state": "alive"}],
        "seeded": {"run_id": "e" * 32, "item": {"id": "drain-alive"},
                   "identity": {"exit": False},
                   "process": {"pid": 4001, "alive": True,
                               "starttime": "100"}},
        "queue": {"before_sha256": "1" * 64, "after_sha256": "1" * 64,
                  "baseline_sha256": "0" * 64, "restored_sha256": "0" * 64},
        "records_before": [HISTORY_PATH],
        "records_after": [HISTORY_PATH],
        "completions_before": 4, "completions_after": 4,
        "before": quiet, "after": dict(quiet),
        "processes": {"owned": {"pid": 4001, "alive": True,
                                "starttime": "100"},
                      "unrelated": {"before": {"pid": 4002, "alive": True,
                                               "starttime": "101"},
                                    "after": {"pid": 4002, "alive": True,
                                              "starttime": "101"}}},
        "cleanup": [{"terminated": True, "controller_signalled": False},
                    {"terminated": True, "controller_signalled": False}],
        "baseline_restored": True,
    }
    drain_ambiguous = {
        **drain_alive,
        "kind": "ambiguous", "target_runtime": PYTHON,
        "current_runtime": NODE,
        "refused": "queue-owned work is alive or ambiguous; refusing",
        "drain": {"drained": False, "blocked": blocked_ambiguous},
        "observation": {"drained": False, "blocked": blocked_ambiguous},
        "liveness": [{"item": "drain-ambiguous", "run_id": "f" * 32,
                      "has_exit": False, "state": "ambiguous"}],
        "seeded": {"run_id": "f" * 32, "item": {"id": "drain-ambiguous"},
                   "identity": {"exit": False}, "process": {"pid": None,
                                                            "alive": False}},
        "processes": {"owned": None,
                      "unrelated": {"before": {"pid": 4003, "alive": True,
                                               "starttime": "102"},
                                    "after": {"pid": 4003, "alive": True,
                                              "starttime": "102"}}},
        "queue": {"before_sha256": "2" * 64, "after_sha256": "2" * 64,
                  "baseline_sha256": "0" * 64, "restored_sha256": "0" * 64},
        "before": observation(NODE), "after": observation(NODE),
    }
    harvest_node = _record("harvest-node", {
        "outcome": "completed", "phase": "activation_pending",
        "runtime": NODE, "prior_runtime": PYTHON})
    harvest_python = _record("harvest-python", {
        "outcome": "completed", "phase": "activation_pending",
        "runtime": PYTHON, "prior_runtime": NODE})
    drain_harvest = {
        "observation": {"drained": True, "blocked": []},
        "liveness": [{"item": "drain-harvest", "run_id": "1" * 32,
                      "has_exit": True, "state": "harvest"}],
        "seeded": {"run_id": "1" * 32, "item": {"id": "drain-harvest"},
                   "identity": {"exit": True},
                   "process": {"pid": 3999, "alive": False,
                               "starttime": "99"}},
        "queue": {"seeded_sha256": "3" * 64,
                  "after_node_sha256": "3" * 64,
                  "after_python_sha256": "3" * 64},
        "node": {"cli": {"rc": 0}, "record_path": harvest_node["path"],
                 "record": harvest_node,
                 "completions": {"sequences": [5, 6],
                                 "invocations": ["e" * 32, "f" * 32]}},
        "python": {"cli": {"rc": 0}, "record_path": harvest_python["path"],
                   "record": harvest_python,
                   "completions": {"sequences": [7, 8],
                                   "invocations": ["1" * 32, "2" * 32]}},
        "processes": {"unrelated": {"before": {"pid": 4004, "alive": True,
                                               "starttime": "103"},
                                    "after": {"pid": 4004, "alive": True,
                                              "starttime": "103"}},
                      "completed": {"pid": 3999, "alive": False,
                                    "starttime": "99"}},
        "after": {**quiet, "state": {
            "queue.json": "3" * 64,
            "heartbeat.json": STATE["heartbeat.json"]}},
        "completions_before": 4, "completions_after": 8,
        "preserved": {"state": {"queue.json": "3" * 64,
                                "heartbeat.json": STATE["heartbeat.json"]},
                      "history_sha256": HISTORY, "record_count": 1},
        "cleanup": [{"terminated": True, "controller_signalled": False}],
        "baseline_restored": True,
    }
    python_phase = {
        "cli": {"rc": 0},
        "record": _record("switch-python", {
            "outcome": "completed", "phase": "activation_pending",
            "runtime": PYTHON, "prior_runtime": NODE}),
        "completions": {"sequences": [3, 4], "invocations": ["c" * 32, "d" * 32]},
        "installed_runtime": PYTHON,
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}}},
        "preserved": preserved,
    }
    pending = {"outcome": "pending", "phase": "drained", "runtime": NODE,
               "prior_runtime": PYTHON}
    rolled_back = {"outcome": "rolled_back",
                   "phase": "restore_activation_pending",
                   "runtime": NODE, "prior_runtime": PYTHON}
    pending_record = _record("recover-transaction", pending,
                             raw_fields=rolled_back)
    final_record = _record("recover-transaction", rolled_back)
    interrupt = {
        "cli": {"rc": -9},
        "record_path": pending_record["path"],
        "record": dict(pending_record),
        "after": {"files": {SERVICE: {"type": "symlink", "target": "/dev/null"}},
                  "units": {"crq-tick.timer": {"ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    recover_kill = {
        "cli": {"rc": -9},
        "record_before": dict(pending_record),
        "record_after": dict(pending_record),
    }
    recover_drain = {
        "record_path": pending_record["path"],
        "record_before": dict(pending_record),
        "record_after": dict(pending_record),
        "cli": {"rc": 2, "stdout": "{\"refused\": \"queue-owned work\"}",
                "stderr": ""},
        "refused": "queue-owned work is alive or ambiguous; refusing",
        "drain": {"drained": False, "blocked": blocked_alive},
        "observation": {"drained": False, "blocked": blocked_alive},
        "liveness": [{"item": "drain-alive", "run_id": "e" * 32,
                      "has_exit": False, "state": "alive"}],
        "seeded": {"run_id": "e" * 32, "item": {"id": "drain-alive"},
                   "identity": {"exit": False},
                   "process": {"pid": 4010, "alive": True,
                               "starttime": "200"}},
        "queue": {"before_sha256": "4" * 64, "after_sha256": "4" * 64,
                  "restored_sha256": STATE["queue.json"]},
        "service": {"before": {"LoadState": "masked",
                                "ActiveState": "inactive",
                                "FragmentPath": SERVICE},
                    "after": {"LoadState": "masked",
                              "ActiveState": "inactive",
                              "FragmentPath": SERVICE}},
        "timer": {"before": {"ActiveState": "inactive",
                             "LoadState": "loaded"},
                  "after": {"ActiveState": "inactive",
                            "LoadState": "loaded"}},
        "completions_before": 8, "completions_after": 8,
        "processes": {"owned": {"pid": 4010, "alive": True,
                                "starttime": "200"},
                      "unrelated": {"before": {"pid": 4011, "alive": True,
                                               "starttime": "201"},
                                    "after": {"pid": 4011, "alive": True,
                                              "starttime": "201"}}},
        "cleanup": [{"terminated": True, "controller_signalled": False},
                    {"terminated": True, "controller_signalled": False}],
        "baseline_restored": True,
    }
    recover = {
        "cli": {"rc": 0},
        "record": dict(final_record),
        "record_before": dict(pending_record),
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}},
                  "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                               "ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    repeat = {
        "cli": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
        "record_before": dict(final_record),
        "record_after": dict(final_record),
    }
    rollback_pending = _record("rollback-transaction", pending,
                               raw_fields=rolled_back)
    rollback_completed = _record("rollback-transaction", rolled_back)
    rollback = {
        "cli": {"rc": -9},
        "switch": {"rc": -9},
        "record": dict(rollback_pending),
        "record_after_kill": dict(rollback_pending),
        "service": {"LoadState": "masked", "FragmentPath": SERVICE},
        "direct_start": {"rc": 1,
                         "stderr": "Unit crq-tick.service is masked."},
        "staged": {"type": "file", "runtime": PYTHON, "sha256": python_sha},
        "staged_after_completion": {"type": "missing"},
        "completions_before": 4, "completions_after_kill": 4,
        "recovery": {"rc": 0},
        "record_completed": dict(rollback_completed),
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}},
                  "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                               "ActiveState": "inactive"}}},
        "repeat": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
        "record_after_repeat": dict(rollback_completed),
        "preserved": preserved,
    }
    fence_record = _record("fence", {
        "outcome": "pending", "phase": "activation_pending",
        "runtime": NODE, "prior_runtime": PYTHON})
    fence = {
        "cli": {"rc": -9},
        "record": dict(fence_record),
        "record_after_refusal": dict(fence_record),
        "recovery": {"rc": 3},
        "direct_start": {"rc": 1,
                         "stderr": "Unit crq-tick.service is masked."},
        "staged": {"runtime": NODE},
        "completions_before": 4, "completions_after": 4,
        "after": {
            "files": {SERVICE: {"type": "symlink", "target": "/dev/null"}},
            "units": {"crq-tick.service": {"LoadState": "masked"},
                      "crq-tick.timer": {"ActiveState": "inactive"}},
        },
        "preserved": preserved,
    }
    inspect = {"snapshot": {
        "files": {SERVICE: {"type": "file", "sha256": python_sha},
                  WANTS: {"type": "symlink"}},
        "state": STATE,
        "records": [node_phase["record"], python_phase["record"],
                    harvest_node, harvest_python, final_record,
                    rollback_completed, fence_record],
    }}
    return {"prepare": prepare, "drain-alive": drain_alive,
            "switch-node": node_phase, "drain-ambiguous": drain_ambiguous,
            "switch-python": python_phase, "drain-harvest": drain_harvest,
            "interrupt": interrupt, "recover-drain-alive": recover_drain,
            "recover-kill": recover_kill, "recover": recover,
            "recover-repeat": repeat, "rollback-fence": rollback,
            "inspect": inspect, "fence": fence}


MATRIX_RECORDS = {}


def _matrix_record(case, fields, raw_fields=None, store=False):
    spec = harness.MATRIX_CASES[case]
    directory = spec["record_dir"]
    filename = "controller-" + hashlib.md5(case.encode()).hexdigest() + ".json"
    raw = json.dumps(raw_fields if raw_fields is not None else fields,
                     sort_keys=True).encode()
    if store:
        MATRIX_RECORDS[(directory, filename)] = raw
    data = json.dumps(fields, sort_keys=True).encode()
    return {**fields,
            "path": "/home/probe/" + directory + "/" + filename,
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def completion_entries(count):
    return [{"sequence": number, "invocation": "%032x" % number}
            for number in range(1, count + 1)]


def matrix_evidence():
    phases_value = phases()
    MATRIX_RECORDS.clear()
    preserved = {"state": STATE, "history_sha256": HISTORY}
    restarts = {}
    reboots = {}
    for case in harness.MATRIX_ORDER:
        spec = harness.MATRIX_CASES[case]
        pending_phase = ("activation_pending"
                         if spec["boundary"] == "activation_pending"
                         else "drained")
        pending = {"outcome": "pending", "phase": pending_phase,
                   "runtime": spec["runtime"],
                   "prior_runtime": spec["prior_runtime"]}
        pending_summary = _matrix_record(
            case, pending, store=(pending_phase == "activation_pending"))
        rolled = {"outcome": "rolled_back",
                  "phase": "restore_activation_pending",
                  "runtime": spec["runtime"],
                  "prior_runtime": spec["prior_runtime"]}
        rolled_summary = _matrix_record(
            case, rolled, store=(pending_phase != "activation_pending"))
        if spec["boundary"] == "drained":
            staged = {"type": "missing"}
        elif spec["boundary"] == "restore_staged":
            staged = {"type": "file", "runtime": spec["prior_runtime"]}
        else:
            staged = {"type": "file", "runtime": spec["runtime"]}
        manager_before = {"pid": "1", "invocation_id": "a" * 32}
        manager_after = {"pid": "2", "invocation_id": "b" * 32}
        completions = completion_entries(4)
        boundary_snapshot = {"boot_id": BOOT_BEFORE,
                             "manager": manager_before,
                             "completions": completions}
        observe_snapshot = {
            "boot_id": (BOOT_AFTER if spec["kind"] == "reboot"
                        else BOOT_BEFORE),
            "manager": manager_after, "completions": completions}
        boundary = {
            "case": case, "kind": spec["kind"],
            "boundary": spec["boundary"], "runtime": spec["runtime"],
            "prior_runtime": spec["prior_runtime"],
            "record_dir": "/home/probe/" + spec["record_dir"],
            "record_path": pending_summary["path"],
            "record": pending_summary, "cli": {"rc": -9},
            "recovery_kill": ({"rc": -9}
                              if spec["boundary"] == "restore_staged"
                              else None),
            "before": boundary_snapshot, "snapshot": boundary_snapshot,
            "metadata": {},
            "fence": {"service": {"LoadState": "masked",
                                   "FragmentPath": SERVICE},
                      "direct_start": {"rc": 1,
                                       "stderr": "Unit is masked."},
                      "timer": {"ActiveState": "inactive"}},
            "staged": staged, "owned": {"main_pid": 0, "pids": []},
            "jobs": [], "completions_before": 4,
            "completions_after": 4, "preserved": preserved,
        }
        observe = {
            "case": case, "kind": spec["kind"],
            "boundary": spec["boundary"], "runtime": spec["runtime"],
            "prior_runtime": spec["prior_runtime"],
            "record_dir": "/home/probe/" + spec["record_dir"],
            "record_path": pending_summary["path"],
            "record_before": pending_summary,
            "record_after": pending_summary,
            "snapshot": observe_snapshot, "before": boundary_snapshot,
            "identity": {
                "boot_id_before": BOOT_BEFORE,
                "boot_id_after": (BOOT_AFTER
                                   if spec["kind"] == "reboot"
                                   else BOOT_BEFORE),
                "boot_id_changed": spec["kind"] == "reboot",
                "manager_before": manager_before,
                "manager_after": manager_after,
                "manager_changed": True},
            "metadata": {}, "metadata_match": True,
            "fence": {"service": {"LoadState": "masked",
                                   "FragmentPath": SERVICE},
                      "direct_start": {"rc": 1,
                                       "stderr": "Unit is masked."},
                      "timer": {"ActiveState": "inactive"}},
            "staged": staged, "owned": {"main_pid": 0, "pids": []},
            "jobs": [], "completions_before": 4,
            "completions_after": 4, "preserved": preserved,
        }
        if pending_phase == "activation_pending":
            observe["recovery"] = {
                "cli": {"rc": 3}, "record_before": pending_summary,
                "record_after": pending_summary}
            observe["repeat"] = {
                "cli": {"rc": 3}, "record_before": pending_summary,
                "record_after": pending_summary}
        else:
            observe["recovery"] = {
                "cli": {"rc": 0}, "record": rolled_summary,
                "record_before": pending_summary,
                "record_after": rolled_summary,
                "restored": {"runtime": spec["prior_runtime"],
                             "staged": {"type": "missing"}}}
            observe["repeat"] = {
                "cli": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
                "record_before": rolled_summary,
                "record_after": rolled_summary}
        phases_value[case] = boundary
        phases_value[case + "-observe"] = observe
        if spec["kind"] == "manager":
            restarts[case] = {
                "kind": "user_manager_restart",
                "command": {"argv": ["ssh", "probe@guest",
                                      "sudo -n systemctl restart "
                                      "user@$(id -u).service"], "rc": 0},
                "ready": {"state": "running"},
                "before": boundary_snapshot,
                "after": {"boot_id": BOOT_BEFORE,
                          "manager": manager_after},
                "boot_id_changed": False,
                "manager_invocation_changed": True,
                "qemu_identity_verified": True}
        else:
            reboots[case] = {
                "kind": "guest_reboot",
                "issued": {"argv": ["ssh", "probe@guest",
                                      "sudo -n systemctl reboot"], "rc": -1},
                "boot_id_before": BOOT_BEFORE, "boot_id_after": BOOT_AFTER,
                "ssh_ready": {"attempts": 1},
                "manager_ready": {"state": "running"},
                "before": boundary_snapshot,
                "after": {"boot_id": BOOT_AFTER,
                          "manager": manager_after},
                "boot_id_changed": True,
                "manager_invocation_changed": True,
                "qemu_identity_verified": True}

    switch_record = _record("matrix-switch-node", {
        "outcome": "completed", "phase": "activation_pending",
        "runtime": NODE, "prior_runtime": PYTHON})
    phases_value["matrix-switch-node"] = {"cli": {"rc": 0},
                                          "record": switch_record}
    for reset, after in (("matrix-reset-python",
                          "matrix-restart-ambiguity-observe"),
                         ("matrix-reset-python-final",
                          "matrix-reboot-ambiguity-observe")):
        observe = phases_value[after]
        phases_value[reset] = {
            "after_phase": after, "record_path": observe["record_path"],
            "record_dir": observe["record_dir"],
            "record_before": observe["record_after"],
            "record_after": observe["record_after"],
            "runtime": PYTHON,
            "service": {"LoadState": "loaded", "ActiveState": "inactive"},
            "timer": {"LoadState": "loaded", "ActiveState": "inactive",
                      "UnitFileState": "enabled"},
            "preserved": preserved}
    return phases_value, restarts, reboots


class HarnessCheckTests(unittest.TestCase):
    def test_complete_evidence_passes(self):
        checks, problems = harness.build_checks(phases())
        self.assertEqual(problems, [])
        self.assertTrue(checks)
        self.assertTrue(all(value is True for value in checks.values()))

    def test_missing_phase_fails_closed(self):
        value = phases()
        del value["switch-python"]
        checks, problems = harness.build_checks(value)
        self.assertTrue(problems)
        self.assertFalse(checks.get("switch-python_completed", False))

    def test_missing_prepared_baseline_fails_closed(self):
        value = phases()
        value["prepare"]["prepared"].pop("state")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["prepared_baseline_present"])
        self.assertTrue(problems)

    def test_drain_alive_refusal_must_preserve_queue(self):
        value = phases()
        value["drain-alive"]["queue"]["after_sha256"] = "9" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_alive_refusal_must_not_run_work(self):
        value = phases()
        value["drain-alive"]["completions_after"] = 5
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_alive_refusal_must_keep_owned_and_unrelated_processes(self):
        value = phases()
        value["drain-alive"]["processes"]["owned"]["alive"] = False
        value["drain-alive"]["processes"]["unrelated"]["after"]["alive"] = False
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_ambiguous_must_be_ownership_ambiguous(self):
        value = phases()
        value["drain-ambiguous"]["liveness"][0]["state"] = "alive"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_ambiguous_refused"])
        self.assertTrue(problems)

    def test_drain_harvest_must_accept_only_completed_dead_work(self):
        value = phases()
        value["drain-harvest"]["liveness"][0]["state"] = "ambiguous"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_harvest_proceeds"])
        self.assertTrue(problems)

    def test_drain_harvest_must_complete_both_directions(self):
        value = phases()
        value["drain-harvest"]["python"]["record"]["runtime"] = NODE
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_harvest_proceeds"])
        self.assertTrue(problems)

    def test_drain_harvest_must_stop_the_fixture_timer(self):
        value = phases()
        value["drain-harvest"]["after"]["units"]["crq-tick.timer"][
            "ActiveState"] = "active"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_harvest_proceeds"])
        self.assertTrue(problems)

    def test_drain_refusal_rejects_absent_before_and_after_fields(self):
        for side in ("before", "after"):
            for field in ("state", "units", "metadata", "jobs", "records",
                          "all_records", "history", "completions", "files"):
                with self.subTest(side=side, field=field):
                    value = phases()
                    value["drain-alive"][side].pop(field)
                    checks, problems = harness.build_checks(value)
                    self.assertFalse(checks["drain_alive_refused"])
                    self.assertTrue(problems)

    def test_drain_refusal_rejects_null_and_wrong_typed_observations(self):
        mutations = (
            ("units", lambda phase: phase["before"].__setitem__("units", None)),
            ("jobs", lambda phase: phase["before"].__setitem__("jobs", None)),
            ("records", lambda phase: phase["before"].__setitem__(
                "records", [{}])),
            ("all_records", lambda phase: phase["before"].__setitem__(
                "all_records", [])),
            ("history", lambda phase: phase["before"].__setitem__(
                "history", {"sha256": None})),
            ("completions", lambda phase: phase["after"].__setitem__(
                "completions", [True])),
            ("metadata", lambda phase: phase["after"].__setitem__(
                "metadata", {"crq-tick.service": "unchanged"})),
            ("state", lambda phase: phase["after"]["state"].__setitem__(
                "queue.json", "q" * 64)),
        )
        for label, mutate in mutations:
            with self.subTest(field=label):
                value = phases()
                mutate(value["drain-alive"])
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_alive_refused"])
                self.assertTrue(problems)

    def test_drain_refusal_requires_queue_and_process_identity(self):
        mutations = (
            ("baseline_sha256", lambda phase: phase["queue"].pop(
                "baseline_sha256")),
            ("restored_sha256", lambda phase: phase["queue"].pop(
                "restored_sha256")),
            ("before_sha256", lambda phase: phase["queue"].pop(
                "before_sha256")),
            ("after_sha256", lambda phase: phase["queue"].pop(
                "after_sha256")),
            ("owned_starttime", lambda phase: phase["processes"]["owned"].pop(
                "starttime")),
            ("seeded_starttime", lambda phase: phase["seeded"][
                "process"].pop("starttime")),
            ("unrelated_starttime", lambda phase: phase["processes"][
                "unrelated"]["after"].pop("starttime")),
            ("completions_after", lambda phase: phase.pop(
                "completions_after")),
            ("records_after", lambda phase: phase.pop("records_after")),
        )
        for label, mutate in mutations:
            with self.subTest(field=label):
                value = phases()
                mutate(value["drain-alive"])
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_alive_refused"])
                self.assertTrue(problems)

    def test_harvest_and_recovery_reject_absent_preservation_fields(self):
        for label, mutate in (
                ("record_count", lambda phase: phase["preserved"].pop(
                    "record_count")),
                ("after_records", lambda phase: phase["after"].pop("records")),
                ("seeded_queue", lambda phase: phase["preserved"][
                    "state"].pop("queue.json")),
                ("timer_service", lambda phase: phase["after"]["units"].pop(
                    "crq-tick.service"))):
            with self.subTest(harvest=label):
                value = phases()
                mutate(value["drain-harvest"])
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_harvest_proceeds"])
                self.assertTrue(problems)
        for label, mutate in (
                ("service_active", lambda phase: phase["service"]["after"].pop(
                    "ActiveState")),
                ("timer_load", lambda phase: phase["timer"]["before"].pop(
                    "LoadState")),
                ("restored", lambda phase: phase["queue"].pop(
                    "restored_sha256")),
                ("record_bytes", lambda phase: phase["record_after"].pop(
                    "bytes"))):
            with self.subTest(recovery=label):
                value = phases()
                mutate(value["recover-drain-alive"])
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["recovery_drain_refused"])
                self.assertTrue(problems)

    def test_liveness_and_interrupted_record_require_identity(self):
        for field in ("run_id", "item"):
            with self.subTest(harvest_seeded=field):
                value = phases()
                value["drain-harvest"]["seeded"].pop(field)
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_harvest_proceeds"])
                self.assertTrue(problems)
        for side in ("record_before", "record_after"):
            with self.subTest(interrupted=side):
                value = phases()
                value["recover-kill"][side].pop("sha256")
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["recovery_interruption_preserved_record"])
                self.assertTrue(problems)

    def test_ambiguous_ownership_and_snapshot_shapes_are_required(self):
        value = phases()
        value["drain-ambiguous"]["processes"].pop("owned")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_ambiguous_refused"])
        self.assertTrue(problems)
        for field in ("LoadState", "ActiveState", "SubState", "UnitFileState",
                      "FragmentPath", "Result"):
            with self.subTest(unit_field=field):
                value = phases()
                value["drain-alive"]["before"]["units"][
                    "crq-tick.service"][field] = ""
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_alive_refused"])
                self.assertTrue(problems)

    def test_drain_snapshot_rejects_vacuous_metadata(self):
        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["metadata"] = {
                path: {"type": "missing"} for path in harness.METADATA_TYPES}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["metadata"] = {
                "/unrelated/" + path.rsplit("/", 1)[-1]: state
                for path, state in value["drain-alive"][side][
                    "metadata"].items()}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        for path in (harness.SERVICE_PATH, harness.TIMER_PATH):
            with self.subTest(wrong_type=path):
                value = phases()
                value["drain-alive"]["before"]["metadata"][path][
                    "type"] = "missing"
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_alive_refused"])
                self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["after"]["metadata"][harness.WANTS_PATH][
            "target"] = "/unrelated/crq-tick.timer"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["before"]["metadata"][harness.SERVICE_PATH][
            "sha256"] = _sha("other-unit")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_snapshot_rejects_vacuous_file_and_record_paths(self):
        value = phases()
        value["drain-alive"]["before"]["files"] = {
            "/unrelated/file": {"path": "/unrelated/file", "type": "missing"}}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["records_before"] = [
            "/unrelated/controller-record.json"]
        value["drain-alive"]["records_after"] = [
            "/unrelated/controller-record.json"]
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["before"]["all_records"] = {
            "/unrelated": value["drain-alive"]["before"]["records"]}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["before"]["state"][
            "/unrelated/queue.json"] = "f" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_snapshot_rejects_contradictory_views(self):
        for field in ("mode", "uid", "gid"):
            with self.subTest(field=field):
                value = phases()
                for side in ("before", "after"):
                    value["drain-alive"][side]["files"][
                        harness.SERVICE_PATH][field] += 1
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["drain_alive_refused"])
                self.assertTrue(problems)

        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["files"][
                harness.SERVICE_PATH]["size"] += 1
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["files"][
                harness.TIMER_PATH]["sha256"] = _sha("other-timer")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["files"][
                harness.SERVICE_PATH]["mode"] = True
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        staged = value["drain-alive"]["before"]["metadata"][harness.TIMER_PATH]
        for side in ("before", "after"):
            value["drain-alive"][side]["metadata"][
                harness.STAGED_PATH] = json.loads(json.dumps(staged))
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

        value = phases()
        value["drain-alive"]["after"] = json.loads(json.dumps(
            value["drain-alive"]["after"]))
        value["drain-alive"]["after"]["metadata"][
            harness.SERVICE_PATH]["mode"] += 1
        value["drain-alive"]["after"]["files"][
            harness.SERVICE_PATH]["mode"] += 1
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_snapshot_rejects_malformed_job_rows(self):
        value = phases()
        for side in ("before", "after"):
            value["drain-alive"][side]["jobs"] = ["JOB UNIT TYPE STATE"]
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["drain_alive_refused"])
        self.assertTrue(problems)

    def test_drain_snapshot_allows_consistent_optional_paths(self):
        value = phases()
        for side in ("before", "after"):
            snap = value["drain-alive"][side]
            staged = json.loads(json.dumps(snap["metadata"][harness.TIMER_PATH]))
            snap["metadata"][harness.STAGED_PATH] = staged
            snap["files"][harness.STAGED_PATH] = {
                "path": harness.STAGED_PATH, "type": "file",
                "mode": staged["mode"], "uid": staged["uid"],
                "gid": staged["gid"], "sha256": staged["sha256"],
                "size": staged["size"]}
            snap["files"][harness.COMPLETIONS_PATH] = {
                "path": harness.COMPLETIONS_PATH, "type": "file",
                "mode": 0o644, "uid": 1000, "gid": 1000,
                "sha256": _sha("completions"), "size": 1}
        checks, problems = harness.build_checks(value)
        self.assertTrue(checks["drain_alive_refused"], problems)
        self.assertFalse(problems)

    def test_recovery_record_must_match_its_path_and_size(self):
        for side in ("record_before", "record_after"):
            with self.subTest(path=side):
                value = phases()
                value["recover-drain-alive"][side]["path"] = (
                    "/home/probe/records/other.json")
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["recovery_drain_refused"])
                self.assertTrue(problems)
            with self.subTest(bytes=side):
                value = phases()
                value["recover-drain-alive"][side]["bytes"] += 1
                checks, problems = harness.build_checks(value)
                self.assertFalse(checks["recovery_drain_refused"])
                self.assertTrue(problems)

    def test_recovery_drain_refusal_must_keep_record_bytes(self):
        value = phases()
        value["recover-drain-alive"]["record_after"]["sha256"] = "9" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["recovery_drain_refused"])
        self.assertTrue(problems)

    def test_recovery_drain_refusal_must_keep_service_fenced(self):
        value = phases()
        value["recover-drain-alive"]["service"]["after"]["LoadState"] = "loaded"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["recovery_drain_refused"])
        self.assertTrue(problems)

    def test_runner_source_must_be_recorded(self):
        value = phases()
        value["prepare"]["prepared"].pop("runner_source")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["runner_source_recorded"])
        self.assertTrue(problems)

    def test_wrong_completion_runtime_fails(self):
        value = phases()
        value["switch-node"]["record"]["runtime"] = PYTHON
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["switch-node_completed"])
        self.assertTrue(problems)

    def test_duplicate_completion_invocations_fail(self):
        value = phases()
        value["switch-node"]["completions"]["invocations"] = ["a" * 32, "a" * 32]
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["switch-node_two_advancing_distinct_completions"])
        self.assertTrue(problems)

    def test_interrupted_record_must_be_drained(self):
        value = phases()
        value["interrupt"]["record"]["phase"] = "activation_pending"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["preactivation_interrupt_retained"])
        self.assertTrue(problems)

    def test_repeat_recovery_must_refuse_and_preserve(self):
        value = phases()
        value["recover-repeat"]["record_after"]["sha256"] = "3" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["repeat_recovery_refused"])
        self.assertTrue(problems)

    def test_rollback_fence_must_stage_the_prior_runtime(self):
        value = phases()
        value["rollback-fence"]["staged"]["runtime"] = NODE
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_held"])
        self.assertTrue(problems)

    def test_rollback_fence_must_not_advance_before_release(self):
        value = phases()
        value["rollback-fence"]["record_after_kill"]["sha256"] = "3" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_held"])
        self.assertTrue(problems)

    def test_rollback_fence_must_complete_and_clear_staged_service(self):
        value = phases()
        value["rollback-fence"]["staged_after_completion"] = {
            "type": "file", "runtime": PYTHON}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_recovery_completed"])
        self.assertTrue(problems)

    def test_expected_runtimes_are_distinct(self):
        self.assertNotEqual(harness.expected_unit(PYTHON),
                            harness.expected_unit(NODE))

    def test_guest_cloud_init_provisions_git_and_node(self):
        text = harness.render_user_data("ssh-ed25519 AAAA fixture")
        self.assertIn("hostname: crq-probe", text)
        self.assertIn("packages:", text)
        self.assertIn("- git", text)
        self.assertIn("- nodejs", text)
        self.assertIn("enable-linger", text)


class MatrixHarnessCheckTests(unittest.TestCase):
    def _checks(self):
        phases_value, restarts, reboots = matrix_evidence()
        return phases_value, restarts, reboots, harness.build_checks(
            phases_value, restarts, reboots, "matrix")

    def test_matrix_evidence_passes(self):
        _, _, _, (checks, problems) = self._checks()
        self.assertEqual(problems, [])
        self.assertTrue(checks)
        self.assertTrue(all(value is True for value in checks.values()))

    def test_missing_matrix_phase_fails_closed(self):
        phases_value, restarts, reboots, _ = self._checks()
        del phases_value["matrix-restart-drained-observe"]
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_identity"])
        self.assertTrue(problems)

    def test_manager_restart_must_keep_boot_id(self):
        phases_value, restarts, reboots, _ = self._checks()
        restarts["matrix-restart-drained"]["boot_id_changed"] = True
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_identity"])
        self.assertFalse(checks["matrix_manager_restart_is_not_reload"])
        self.assertTrue(problems)

    def test_reboot_must_change_boot_id(self):
        phases_value, restarts, reboots, _ = self._checks()
        reboots["matrix-reboot-drained"]["boot_id_changed"] = False
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-reboot-drained_identity"])
        self.assertFalse(checks["matrix_guest_reboot_changes_boot_id"])
        self.assertTrue(problems)

    def test_daemon_reload_is_not_a_restart(self):
        phases_value, restarts, reboots, _ = self._checks()
        restarts["matrix-restart-drained"]["command"]["argv"][-1] = (
            "sudo -n systemctl daemon-reload")
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_identity"])
        self.assertFalse(checks["matrix_manager_restart_is_not_reload"])
        self.assertTrue(problems)

    def test_changed_journal_fails(self):
        phases_value, restarts, reboots, _ = self._checks()
        observe = phases_value["matrix-restart-drained-observe"]
        observe["record_after"] = {**observe["record_after"],
                                    "sha256": "3" * 64}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_changed_metadata_fails(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-reboot-drained-observe"]["metadata_match"] = False
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-reboot-drained_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_owned_work_after_restart_fails(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-drained-observe"]["owned"] = {
            "main_pid": 42, "pids": [42]}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_recovery_must_restore_the_prior_runtime(self):
        phases_value, restarts, reboots, _ = self._checks()
        recovery = phases_value["matrix-reboot-drained-observe"]["recovery"]
        recovery["restored"] = {"runtime": PYTHON,
                                "staged": {"type": "missing"}}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-reboot-drained_recovery_outcome"])
        self.assertTrue(problems)

    def test_ambiguity_must_refuse(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-ambiguity-observe"]["recovery"]["cli"] = {
            "rc": 0}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-ambiguity_recovery_outcome"])
        self.assertFalse(checks["matrix_ambiguity_retained"])
        self.assertTrue(problems)

    def test_restore_staged_requires_an_interrupted_recovery(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-restore-staged"]["recovery_kill"] = {
            "rc": 0}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-restore-staged_boundary"])
        self.assertTrue(problems)

    def test_staged_target_must_match_the_boundary(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-restore-staged-observe"]["staged"] = {
            "type": "file", "runtime": NODE}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-restore-staged_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_staged_evidence_must_name_the_runtime(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-restore-staged"]["staged"].pop("runtime")
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-restore-staged_boundary"])
        self.assertTrue(problems)

    def test_pending_boundary_jobs_fail(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-drained"]["jobs"] = [
            "12 crq-tick.service start waiting"]
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_boundary"])
        self.assertFalse(checks["matrix_no_unrecorded_work"])
        self.assertTrue(problems)

    def test_pending_observe_jobs_fail(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-drained-observe"]["jobs"] = [
            "12 crq-tick.service start waiting"]
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-drained_journal_metadata_fence"])
        self.assertFalse(checks["matrix_no_unrecorded_work"])
        self.assertTrue(problems)

    def test_missing_jobs_observation_fails(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-drained"].pop("jobs")
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_boundary"])
        self.assertFalse(checks["matrix_no_unrecorded_work"])
        self.assertTrue(problems)

    def test_identity_flags_must_match_retained_identities(self):
        phases_value, restarts, reboots, _ = self._checks()
        observe = phases_value["matrix-restart-drained-observe"]
        observe["identity"]["manager_after"] = observe["identity"][
            "manager_before"]
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_identity"])
        self.assertTrue(problems)

    def test_boot_id_flag_must_match_retained_boot_ids(self):
        phases_value, restarts, reboots, _ = self._checks()
        observe = phases_value["matrix-reboot-drained-observe"]
        observe["identity"]["boot_id_after"] = observe["identity"][
            "boot_id_before"]
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-reboot-drained_identity"])
        self.assertTrue(problems)

    def test_missing_completion_counts_fail(self):
        phases_value, restarts, reboots, _ = self._checks()
        boundary = phases_value["matrix-restart-drained"]
        boundary["completions_before"] = None
        boundary["completions_after"] = None
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_boundary"])
        self.assertFalse(checks["matrix_no_unrecorded_work"])
        self.assertTrue(problems)

    def test_observe_record_must_name_its_state(self):
        phases_value, restarts, reboots, _ = self._checks()
        observe = phases_value["matrix-restart-drained-observe"]
        observe["record_before"] = dict(observe["record_before"])
        observe["record_after"] = dict(observe["record_after"])
        observe["record_before"].pop("outcome")
        observe["record_after"].pop("outcome")
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-drained_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_observe_timer_must_be_inactive(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-restart-drained-observe"]["fence"]["timer"][
            "ActiveState"] = "active"
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(
            checks["matrix-restart-drained_journal_metadata_fence"])
        self.assertTrue(problems)

    def test_completion_count_must_match_snapshot(self):
        phases_value, restarts, reboots, _ = self._checks()
        boundary = phases_value["matrix-restart-drained"]
        boundary["completions_after"] = 5
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-drained_boundary"])
        self.assertFalse(checks["matrix_no_unrecorded_work"])
        self.assertTrue(problems)

    def test_ambiguity_repeat_must_refuse(self):
        phases_value, restarts, reboots, _ = self._checks()
        observe = phases_value["matrix-restart-ambiguity-observe"]
        observe["repeat"]["cli"] = {"rc": 0}
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix-restart-ambiguity_recovery_outcome"])
        self.assertFalse(checks["matrix_ambiguity_retained"])
        self.assertTrue(problems)

    def test_reset_must_restore_python_fixture(self):
        phases_value, restarts, reboots, _ = self._checks()
        phases_value["matrix-reset-python"]["service"]["ActiveState"] = "active"
        checks, problems = harness.build_checks(phases_value, restarts,
                                                reboots, "matrix")
        self.assertFalse(checks["matrix_ambiguity_reset_preserved"])
        self.assertTrue(problems)


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-proof-verify-")
        self.addCleanup(self.temp.cleanup)
        self.run_dir = pathlib.Path(self.temp.name)
        self.host = self.run_dir / "executed-host-script.py"
        self.feasibility = self.run_dir / "executed-host-vm-feasibility.py"
        self.guest = self.run_dir / "executed-guest-probe.py"
        self.raw = self.run_dir / "raw-guest-evidence.tar.gz"
        self.host.write_bytes(b"host")
        self.feasibility.write_bytes(b"feasibility")
        self.guest.write_bytes(GUEST_BYTES)
        self.upload_data = {name: ("upload:" + name).encode()
                            for name in harness.UPLOADS}
        self.upload_data[harness.RUNNER_ARCHIVE] = RUNNER_BYTES
        self.report = {
            "schema_version": harness.SCHEMA_VERSION,
            "kind": harness.KIND,
            "path": str(self.run_dir),
            "run": "test-run",
            "source_commit": SOURCE_COMMIT,
            "phases": phases(),
            "checks": {},
            "problems": [],
            "provenance": {
                "source_commit": SOURCE_COMMIT,
                "host_script": {"artifact": self.host.name,
                                "sha256": harness.sha256_bytes(b"host")},
                "host_modules": {
                    "vm-unit-switch.py": {
                        "artifact": self.host.name,
                        "sha256": harness.sha256_bytes(b"host")},
                    "vm-feasibility.py": {
                        "artifact": self.feasibility.name,
                        "sha256": harness.sha256_bytes(b"feasibility")},
                },
                "guest_script": {"artifact": self.guest.name,
                                 "sha256": GUEST_SHA},
                "guest_report": self.guest.name,
                "uploads": {
                    **{name: {"sha256": harness.sha256_bytes(data),
                              "remote_sha256": harness.sha256_bytes(data),
                              "bytes": len(data), "verified": True}
                       for name, data in self.upload_data.items()
                       if name != harness.RUNNER_ARCHIVE},
                    "runner_source": {
                        "name": harness.RUNNER_ARCHIVE,
                        "sha256": harness.sha256_bytes(
                            self.upload_data[harness.RUNNER_ARCHIVE]),
                        "remote_sha256": harness.sha256_bytes(
                            self.upload_data[harness.RUNNER_ARCHIVE]),
                        "bytes": len(self.upload_data[harness.RUNNER_ARCHIVE]),
                        "verified": True,
                        "source": "git-archive:HEAD:apps/crq-python"}},
            },
            "raw": {"raw_tar": self.raw.name},
        }
        self._rebuild_raw()
        checks, problems = harness.build_checks(self.report["phases"])
        self.report["checks"] = checks
        self.report["problems"] = problems

    def _add(self, archive, name, data, mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        archive.addfile(info, io.BytesIO(data))

    def _rebuild_raw(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name in harness.GUEST_PHASES:
                data = (json.dumps(self.report["phases"][name], indent=2,
                                   sort_keys=True) + "\n").encode()
                self._add(archive, "fixture/phases/" + name + ".json", data)
            for name, data in RECORDS.items():
                filename = ("controller-"
                            + hashlib.md5(name.encode()).hexdigest() + ".json")
                self._add(archive, "records/" + filename, data, mode=0o600)
            for name, data in self.upload_data.items():
                self._add(archive, "proof-bin/" + name, data)
            mask = tarfile.TarInfo(
                ".config/systemd/user/crq-tick.service")
            mask.type = tarfile.SYMTYPE
            mask.linkname = "/dev/null"
            archive.addfile(mask)
            self._add(archive, ".config/systemd/user/.crq-tick.service.staged",
                      harness.expected_unit(NODE).encode())
        data = buffer.getvalue()
        self.raw.write_bytes(data)
        self.report["raw"]["tar_sha256"] = harness.sha256_bytes(data)
        self.report["raw"]["tar_bytes"] = len(data)

    def _write(self):
        path = self.run_dir / "report.json"
        path.write_text(json.dumps(self.report))
        return path

    def _verify(self):
        report = self._write()
        output = []
        # cmd_verify prints JSON; capture it without changing its logic.
        import contextlib
        import io
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            status = harness.cmd_verify(type("Args", (), {"report": report})())
        output.append(json.loads(stream.getvalue()))
        return status, output[0]

    def test_consistent_report_verifies(self):
        status, payload = self._verify()
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload["problems"], [])

    def test_tampered_artifact_is_rejected(self):
        self.host.write_bytes(b"tampered")
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host_script" in item for item in payload["problems"]))

    def test_stored_check_mismatch_is_rejected(self):
        self.report["checks"]["switch-node_completed"] = False
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("checks" in item for item in payload["problems"]))

    def test_failed_checks_are_rejected_even_when_stored_problems_match(self):
        self.report["phases"]["switch-node"]["installed_runtime"] = PYTHON
        checks, problems = harness.build_checks(self.report["phases"])
        self.report["checks"] = checks
        self.report["problems"] = problems
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("switch-node_completed" in item
                            for item in payload["problems"]))

    def test_missing_raw_evidence_is_rejected(self):
        self.raw.unlink()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw" in item for item in payload["problems"]))

    def test_phase_contradicting_raw_cli_is_rejected(self):
        self.report["phases"]["recover"]["cli"]["rc"] = 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not match retained raw guest evidence" in item
                            for item in payload["problems"]))

    def test_phase_contradicting_retained_journal_is_rejected(self):
        self.report["phases"]["recover"]["record"]["outcome"] = "completed"
        # Keep the phase JSON consistent with the tampered report so only the
        # raw controller journal can expose the contradiction.
        self._rebuild_raw()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("contradicts retained evidence" in item
                            for item in payload["problems"]))

    def test_empty_upload_provenance_is_rejected(self):
        self.report["provenance"]["uploads"] = {}
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance set" in item
                            or "raw upload is missing" in item
                            for item in payload["problems"]))

    def test_partial_upload_provenance_is_rejected(self):
        self.report["provenance"]["uploads"].pop(harness.UPLOADS[0])
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance" in item
                            for item in payload["problems"]))

    def test_extra_upload_provenance_is_rejected(self):
        entry = dict(next(iter(self.report["provenance"]["uploads"].values())))
        self.report["provenance"]["uploads"]["extra.py"] = entry
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance set" in item
                            for item in payload["problems"]))

    def test_empty_upload_digest_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["sha256"] = ""
        entry["remote_sha256"] = ""
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload digest is invalid" in item
                            for item in payload["problems"]))

    def test_unverified_upload_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["verified"] = False
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload is not verified" in item
                            for item in payload["problems"]))

    def test_remote_upload_digest_mismatch_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["remote_sha256"] = "d" * 64
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("local and remote digests differ" in item
                            for item in payload["problems"]))

    def test_upload_size_mismatch_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["bytes"] = 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw upload size does not match" in item
                            for item in payload["problems"]))

    def test_upload_size_must_be_nonnegative(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["bytes"] = -1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload size is invalid" in item
                            for item in payload["problems"]))

    def test_missing_provenance_is_rejected(self):
        del self.report["provenance"]
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("provenance is not an object" in item
                            for item in payload["problems"]))

    def test_source_commit_mismatch_is_rejected(self):
        self.report["provenance"]["source_commit"] = "d" * 40
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not match the report" in item
                            for item in payload["problems"]))

    def test_report_path_mismatch_is_rejected(self):
        self.report["path"] = str(self.run_dir / "elsewhere")
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not name the report directory" in item
                            for item in payload["problems"]))

    def test_raw_size_mismatch_is_rejected(self):
        self.report["raw"]["tar_bytes"] += 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw guest evidence size does not match" in item
                            for item in payload["problems"]))

    def test_missing_host_module_provenance_is_rejected(self):
        del self.report["provenance"]["host_modules"]
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host module provenance" in item
                            for item in payload["problems"]))

    def test_host_module_digest_mismatch_is_rejected(self):
        self.report["provenance"]["host_modules"]["vm-feasibility.py"][
            "sha256"] = "d" * 64
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host module artifact digest does not match" in item
                            for item in payload["problems"]))


class MatrixVerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-proof-verify-")
        self.addCleanup(self.temp.cleanup)
        self.run_dir = pathlib.Path(self.temp.name)
        self.host = self.run_dir / "executed-host-script.py"
        self.feasibility = self.run_dir / "executed-host-vm-feasibility.py"
        self.guest = self.run_dir / "executed-guest-probe.py"
        self.raw = self.run_dir / "raw-guest-evidence.tar.gz"
        self.host.write_bytes(b"host")
        self.feasibility.write_bytes(b"feasibility")
        self.guest.write_bytes(GUEST_BYTES)
        self.upload_data = {name: ("upload:" + name).encode()
                            for name in harness.UPLOADS}
        self.upload_data[harness.RUNNER_ARCHIVE] = RUNNER_BYTES
        self.phases, self.restarts, self.reboots = matrix_evidence()
        self.report = {
            "schema_version": harness.SCHEMA_VERSION,
            "kind": harness.KIND,
            "mode": "matrix",
            "path": str(self.run_dir),
            "run": "test-run",
            "source_commit": SOURCE_COMMIT,
            "phases": self.phases,
            "restarts": self.restarts,
            "reboots": self.reboots,
            "checks": {},
            "problems": [],
            "provenance": {
                "source_commit": SOURCE_COMMIT,
                "host_script": {"artifact": self.host.name,
                                "sha256": harness.sha256_bytes(b"host")},
                "host_modules": {
                    "vm-unit-switch.py": {
                        "artifact": self.host.name,
                        "sha256": harness.sha256_bytes(b"host")},
                    "vm-feasibility.py": {
                        "artifact": self.feasibility.name,
                        "sha256": harness.sha256_bytes(b"feasibility")},
                },
                "guest_script": {"artifact": self.guest.name,
                                 "sha256": GUEST_SHA},
                "guest_report": self.guest.name,
                "uploads": {
                    **{name: {"sha256": harness.sha256_bytes(data),
                              "remote_sha256": harness.sha256_bytes(data),
                              "bytes": len(data), "verified": True}
                       for name, data in self.upload_data.items()
                       if name != harness.RUNNER_ARCHIVE},
                    "runner_source": {
                        "name": harness.RUNNER_ARCHIVE,
                        "sha256": harness.sha256_bytes(
                            self.upload_data[harness.RUNNER_ARCHIVE]),
                        "remote_sha256": harness.sha256_bytes(
                            self.upload_data[harness.RUNNER_ARCHIVE]),
                        "bytes": len(self.upload_data[harness.RUNNER_ARCHIVE]),
                        "verified": True,
                        "source": "git-archive:HEAD:apps/crq-python"}},
            },
            "raw": {"raw_tar": self.raw.name},
        }
        self._rebuild_raw()
        checks, problems = harness.build_checks(
            self.phases, self.restarts, self.reboots, "matrix")
        self.report["checks"] = checks
        self.report["problems"] = problems

    def _add(self, archive, name, data, mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        archive.addfile(info, io.BytesIO(data))

    def _rebuild_raw(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name in harness.phase_names("matrix"):
                data = (json.dumps(self.phases[name], indent=2,
                                   sort_keys=True) + "\n").encode()
                self._add(archive, "fixture/phases/" + name + ".json", data)
            for name, data in RECORDS.items():
                filename = ("controller-"
                            + hashlib.md5(name.encode()).hexdigest() + ".json")
                self._add(archive, "records/" + filename, data, mode=0o600)
            for (directory, filename), data in MATRIX_RECORDS.items():
                self._add(archive, directory + "/" + filename, data, mode=0o600)
            for name, data in self.upload_data.items():
                self._add(archive, "proof-bin/" + name, data)
            mask = tarfile.TarInfo(
                ".config/systemd/user/crq-tick.service")
            mask.type = tarfile.SYMTYPE
            mask.linkname = "/dev/null"
            archive.addfile(mask)
            self._add(archive, ".config/systemd/user/.crq-tick.service.staged",
                      harness.expected_unit(NODE).encode())
        data = buffer.getvalue()
        self.raw.write_bytes(data)
        self.report["raw"]["tar_sha256"] = harness.sha256_bytes(data)
        self.report["raw"]["tar_bytes"] = len(data)

    def _write(self):
        path = self.run_dir / "report.json"
        path.write_text(json.dumps(self.report))
        return path

    def _verify(self):
        report = self._write()
        import contextlib
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            status = harness.cmd_verify(type("Args", (), {"report": report})())
        return status, json.loads(stream.getvalue())

    def test_matrix_report_verifies(self):
        status, payload = self._verify()
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload["problems"], [])
        validator = payload["validator"]
        self.assertEqual(validator["run"], "test-run")
        self.assertEqual(validator["run_source_commit"], SOURCE_COMMIT)
        self.assertTrue(validator["guest_matches_run"])
        self.assertTrue(validator["validator_only"])

    def test_matrix_guest_script_mismatch_is_rejected(self):
        self.report["provenance"]["guest_script"]["sha256"] = "0" * 64
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("fresh matrix run" in item
                            for item in payload["problems"]))

    def test_matrix_reset_record_dir_must_match_case(self):
        self.report["phases"]["matrix-reset-python"]["record_dir"] = "/etc"
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("record directory does not match" in item
                            for item in payload["problems"]))

    def test_matrix_phase_contradicting_raw_is_rejected(self):
        self.report["phases"]["matrix-reboot-drained"]["cli"]["rc"] = 0
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not match retained raw guest evidence" in item
                            for item in payload["problems"]))

    def test_matrix_journal_contradiction_is_rejected(self):
        phase = self.report["phases"]["matrix-reboot-drained-observe"]
        phase["recovery"]["record"]["outcome"] = "completed"
        self._rebuild_raw()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("contradicts retained evidence" in item
                            for item in payload["problems"]))

    def test_matrix_missing_phase_is_rejected(self):
        del self.report["phases"]["matrix-restart-ambiguity-observe"]
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("matrix-restart-ambiguity-observe" in item
                            for item in payload["problems"]))

    def test_matrix_missing_case_record_is_rejected(self):
        for key in list(MATRIX_RECORDS):
            if key[0] == "records/ambiguity-manager-restart":
                del MATRIX_RECORDS[key]
        self._rebuild_raw()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("retained record is missing" in item
                            for item in payload["problems"]))


class ActivatorHarnessTests(unittest.TestCase):
    def test_activators_mode_declares_phases(self):
        self.assertEqual(harness.phase_names("activators"),
                         harness.ACTIVATOR_GUEST_PHASES)
        self.assertEqual([step[1] for step in
                          harness.run_steps("activators")],
                         list(harness.ACTIVATOR_GUEST_PHASES))
        self.assertEqual(len(harness.ACTIVATOR_LIMITATIONS), 9)
        self.assertTrue(any("allowlisted guest topology"
                            in item for item in
                            harness.ACTIVATOR_LIMITATIONS))

    def test_empty_activators_evidence_fails_closed(self):
        checks, problems = harness.build_checks({}, mode="activators")
        self.assertIs(checks["activator_prepared_baseline"], False)
        self.assertTrue(problems)

    def test_repair_snapshot_requires_exact_bytes_and_activation(self):
        expected = harness._repair_expected(PYTHON)

        def file_state(text):
            data = text.encode()
            return {"type": "file", "mode": 0o644, "uid": 1000, "gid": 1000,
                    "bytes_b64": base64.b64encode(data).decode("ascii"),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data), "xattrs": []}

        def link_state(target):
            return {"type": "symlink", "mode": 0o777, "uid": 1000,
                    "gid": 1000, "target": target, "xattrs": []}

        snapshot = {
            "schema_version": 1, "unit": harness.REPAIR_UNIT,
            "runtime": PYTHON,
            "paths": {
                harness.REPAIR_PATHS["service"]: file_state(
                    expected["service"]),
                harness.REPAIR_PATHS["timer"]: file_state(expected["timer"]),
                harness.REPAIR_PATHS["path"]: file_state(expected["path"]),
                harness.REPAIR_PATHS["dropin"]: file_state(expected["dropin"]),
                harness.REPAIR_PATHS["timer_wants"]: link_state(
                    "../" + harness.REPAIR_TIMER),
                harness.REPAIR_PATHS["path_wants"]: link_state(
                    "../" + harness.REPAIR_PATH),
            },
            "activators": {
                "timer_active": "active",
                "timer_unit_file_state": "enabled",
                "service_active": "inactive",
                "path_active": "inactive",
                "path_unit_file_state": "enabled",
            },
        }
        problems = []
        harness._record_snapshot_problems(
            {"snapshot": snapshot}, PYTHON, "test snapshot", problems)
        self.assertEqual(problems, [])
        snapshot["paths"][harness.REPAIR_PATHS["service"]]["bytes_b64"] = (
            base64.b64encode(b"tampered").decode("ascii"))
        problems = []
        harness._record_snapshot_problems(
            {"snapshot": snapshot}, PYTHON, "test snapshot", problems)
        self.assertTrue(problems)
        snapshot["paths"][harness.REPAIR_PATHS["service"]] = file_state(
            expected["service"])
        snapshot["activators"]["path_active"] = "active"
        problems = []
        harness._record_snapshot_problems(
            {"snapshot": snapshot}, PYTHON, "test snapshot", problems)
        self.assertTrue(problems)


class SourceCommitTests(unittest.TestCase):
    def _run(self, status, match=None):
        calls = []

        def fake(argv, **kwargs):
            calls.append(list(argv))
            dirty = match is not None and any(match in arg for arg in argv)
            stdout = SOURCE_COMMIT if "rev-parse" in argv else (status if dirty else "")
            return subprocess.CompletedProcess(argv, 0, stdout, "")

        return calls, mock.patch.object(harness.subprocess, "run", side_effect=fake)

    def test_dirty_host_module_is_rejected(self):
        calls, patcher = self._run(" M apps/crq-python/ops/vm-feasibility.py\n",
                                   match="vm-feasibility.py")
        with patcher:
            with self.assertRaisesRegex(ValueError, "host proof modules"):
                harness.source_commit_check(pathlib.Path("/repo"), SOURCE_COMMIT)
        checked = {word for call in calls for word in call}
        self.assertIn(str(OPS / "vm-unit-switch.py"), checked)
        self.assertIn(str(OPS / "vm-feasibility.py"), checked)

    def test_clean_checkout_is_accepted(self):
        calls, patcher = self._run("")
        with patcher:
            self.assertEqual(
                harness.source_commit_check(pathlib.Path("/repo"), SOURCE_COMMIT),
                SOURCE_COMMIT)
        self.assertEqual(len(calls), 4)
        self.assertTrue(any("apps/crq-python" in call for call in calls))

    def test_dirty_runner_source_is_rejected(self):
        def fake(argv, **kwargs):
            dirty = list(argv[-2:]) == ["--", "apps/crq-python"]
            stdout = SOURCE_COMMIT if "rev-parse" in argv else (
                " M apps/crq-python/crq.py\n" if dirty else "")
            return subprocess.CompletedProcess(argv, 0, stdout, "")

        with mock.patch.object(harness.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "runner source"):
                harness.source_commit_check(pathlib.Path("/repo"), SOURCE_COMMIT)


class RunnerSourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-runner-source-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        patcher = mock.patch.multiple(
            guest, CHECKOUT=self.checkout,
            RUNNER_ROOT=self.checkout / "apps/crq-python")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _archive(self, entries):
        path = self.root / "runner.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data, kind in entries:
                info = tarfile.TarInfo(name)
                if kind == "dir":
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    archive.addfile(info)
                else:
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        return path

    def _valid_entries(self, extra=()):
        return [("apps", b"", "dir"),
                ("apps/crq-python", b"", "dir"),
                ("apps/crq-python/crq.py", b"runner", "file"),
                ("apps/crq-python/author_quota.py", b"quota", "file"),
                *extra]

    def test_accepts_git_archive_parent_directory(self):
        archive = self._archive(self._valid_entries())
        value = guest.extract_runner_source(archive)
        self.assertTrue((self.checkout / "apps/crq-python/crq.py").is_file())
        self.assertEqual(value["crq_sha256"],
                         hashlib.sha256(b"runner").hexdigest())

    def test_rejects_top_level_member(self):
        archive = self._archive(self._valid_entries(
            [("etc/passwd", b"x", "file")]))
        with self.assertRaisesRegex(RuntimeError, "escapes apps"):
            guest.extract_runner_source(archive)

    def test_rejects_parent_escape(self):
        archive = self._archive(self._valid_entries(
            [("apps/../evil", b"x", "file")]))
        with self.assertRaisesRegex(RuntimeError, "unsafe path"):
            guest.extract_runner_source(archive)

    def test_requires_runner_and_quota_sources(self):
        archive = self._archive([("apps", b"", "dir"),
                                 ("apps/crq-python/crq.py", b"runner",
                                  "file")])
        with self.assertRaisesRegex(RuntimeError, "author_quota.py"):
            guest.extract_runner_source(archive)


class ActivatorEvidenceTests(unittest.TestCase):
    def _command(self, rc=0):
        return {"argv": ["systemctl", "--user", "show"], "rc": rc,
                "stdout": "", "stderr": "", "timeout": False}

    def _job_command(self, lines=()):
        text = "\n".join(lines)
        return {"argv": harness.LIST_JOBS_ARGV, "rc": 0,
                "stdout": (text + "\n") if text else "",
                "stderr": "", "timeout": False}

    def _completion(self, sequence, invocation, runtime=PYTHON):
        return {"unit": harness.REPAIR_UNIT, "runtime": runtime,
                "success": True, "sequence": sequence,
                "invocation": invocation}

    def _record(self):
        return {
            "path": harness.REPAIR_RECORDS_DIR
                    + "/controller-" + "a" * 32 + ".json",
            "sha256": "b" * 64, "bytes": 120,
            "transaction_id": "c" * 32, "schema_version": 1,
            "unit": harness.REPAIR_UNIT, "outcome": "pending"}

    def _queue(self):
        job = "52 crq-repair.service        start waiting"
        blocker_job = "32 crq-blocker.service        start running"
        observation = {"command": self._job_command([job, blocker_job]),
                       "lines": [job, blocker_job]}
        return {
            "blocker_command": self._command(),
            "target_command": self._command(),
            "stop": self._command(),
            "blocker_stop": self._command(),
            "job": job, "job_observation": observation,
            "jobs": [job, blocker_job],
            "jobs_after": [blocker_job],
            "jobs_after_observation": {
                "command": self._job_command([blocker_job]),
                "lines": [blocker_job]},
            "blocker": {"ActiveState": "activating", "MainPID": "2063",
                        "InvocationID": "d" * 32},
            "before_count": 0, "after_count": 0}

    def test_positive_queue_requires_settlement_and_exact_job(self):
        problems = []
        self.assertTrue(harness._positive_queue_ok(self._queue(), problems))
        self.assertEqual(problems, [])
        for key in ("jobs_after", "jobs_after_observation"):
            queue = self._queue()
            queue.pop(key)
            self.assertFalse(harness._positive_queue_ok(queue, []))
        queue = self._queue()
        queue["stop"]["rc"] = 1
        self.assertFalse(harness._positive_queue_ok(queue, []))
        queue = self._queue()
        queue["before_count"] = False
        queue["after_count"] = False
        self.assertFalse(harness._positive_queue_ok(queue, []))

    def test_job_observation_requires_exact_raw_stdout_binding(self):
        queue = self._queue()
        self.assertTrue(harness._positive_queue_ok(queue, []))
        mutations = [
            lambda item: item["job_observation"]["command"].update(stdout=""),
            lambda item: item["job_observation"]["command"].update(
                stdout="999 crq-repair.service        start waiting\n"),
            lambda item: item["job_observation"]["command"].update(
                argv=["systemctl", "--user", "list-jobs"]),
            lambda item: item["job_observation"].update(lines=[]),
            lambda item: item["jobs_after_observation"]["command"].update(
                stdout="999 crq-repair.service        start waiting\n"),
            lambda item: item["jobs_after_observation"]["command"].update(
                argv=["systemctl", "--user", "list-jobs"]),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(queue)
            mutate(changed)
            self.assertFalse(harness._positive_queue_ok(changed, []))

    def test_job_rows_are_canonical_and_unique(self):
        valid = ["52 crq-repair.service        start waiting",
                 "32 crq-blocker.service        start running"]
        self.assertTrue(harness._job_lines_ok(valid, "test", []))
        self.assertEqual(harness._job_identity(valid[0]),
                         {"job_id": 52, "unit": "crq-repair.service",
                          "type": "start", "state": "waiting"})
        invalid = [
            ["52 crq-repair.service start waiting",
             "52 crq-repair.service start running"],
            ["52 crq-repair.service start running",
             "52 crq-repair.service start waiting"],
            ["52 crq-repair.service start waiting",
             "52 crq-repair.service start waiting"],
            ["52 crq-repair.service start waiting",
             "52 crq-blocker.service start running"],
            ["52 crq-repair.service start waiting",
             "53 crq-repair.service start running"],
            ["JOB UNIT TYPE STATE"],
            ["52 crq-repair.service start waiting extra"],
            ["0 crq-repair.service start waiting"],
            ["052 crq-repair.service start waiting"],
            ["52 not-a-unit start waiting"],
            ["52 crq-repair.service bogus waiting"],
            ["52 crq-repair.service start bogus"],
            ["52 crq-repair.service start waiting\n"],
            [True], [None], [123], [""],
            "52 crq-repair.service start waiting",
            None,
        ]
        for lines in invalid:
            with self.subTest(lines=lines):
                self.assertFalse(harness._job_lines_ok(lines, "test", []))

    def test_queue_rejects_ambiguous_job_rows(self):
        queue = self._queue()
        target = queue["job"]
        blocker = queue["jobs"][1]

        def with_jobs(lines):
            changed = copy.deepcopy(queue)
            changed["jobs"] = list(lines)
            changed["job_observation"] = {
                "command": self._job_command(lines),
                "lines": list(lines)}
            return changed

        self.assertTrue(harness._positive_queue_ok(
            with_jobs([target, blocker]), []))
        contradictory = target.replace("waiting", "running")
        cases = [
            [target, contradictory],
            [contradictory, target],
            [target, target],
            [target, "52 crq-blocker.service start running"],
            [target, "53 crq-repair.service start running"],
            [target, "JOB UNIT TYPE STATE"],
            [target, target + " extra"],
        ]
        for lines in cases:
            with self.subTest(lines=lines):
                self.assertFalse(harness._positive_queue_ok(
                    with_jobs(lines), []))
        changed = with_jobs([target, blocker])
        changed["jobs_after"] = [blocker, blocker]
        changed["jobs_after_observation"] = {
            "command": self._job_command([blocker, blocker]),
            "lines": [blocker, blocker]}
        self.assertFalse(harness._positive_queue_ok(changed, []))

    def test_fence_rejects_ambiguous_job_rows(self):
        queue = self._queue()
        target = queue["job"]
        blocker = queue["jobs"][1]
        seed = {
            "blocker": queue["blocker"],
            "blocker_command": queue["blocker_command"],
            "target_command": queue["target_command"],
            "job": target, "job_observation": queue["job_observation"],
            "jobs": queue["jobs"]}

        def during_with(lines):
            return {
                "jobs": list(lines),
                "jobs_observation": {
                    "command": self._job_command(lines),
                    "lines": list(lines)},
                "blocker": copy.deepcopy(queue["blocker"])}

        self.assertTrue(harness._fence_job_ok(
            seed, during_with([target, blocker]), []))
        contradictory = target.replace("waiting", "running")
        cases = [
            [target, contradictory],
            [contradictory, target],
            [target, target],
            [target, "52 crq-blocker.service start running"],
            [target, "53 crq-repair.service start running"],
            [target, "JOB UNIT TYPE STATE"],
            [target, target + " extra"],
            [blocker, "999 crq-repair.service start waiting"],
        ]
        for lines in cases:
            with self.subTest(lines=lines):
                self.assertFalse(harness._fence_job_ok(
                    seed, during_with(lines), []))
        changed = copy.deepcopy(seed)
        changed["jobs"] = [target, target]
        changed["job_observation"] = {
            "command": self._job_command([target, target]),
            "lines": [target, target]}
        self.assertFalse(harness._fence_job_ok(
            changed, during_with([target, blocker]), []))

    def test_fence_requires_same_waiting_job_and_blocker(self):
        queue = self._queue()
        queue_seed = {
            "blocker": queue["blocker"],
            "blocker_command": queue["blocker_command"],
            "target_command": queue["target_command"],
            "job": queue["job"], "job_observation": queue["job_observation"],
            "jobs": queue["jobs"]}
        during = {
            "jobs": queue["jobs"],
            "jobs_observation": queue["job_observation"],
            "blocker": queue["blocker"]}
        self.assertTrue(harness._fence_job_ok(queue_seed, during, []))
        changed = json.loads(json.dumps(during))
        changed["jobs"] = ["999 crq-repair.service        start waiting"]
        changed["jobs_observation"]["lines"] = changed["jobs"]
        self.assertFalse(harness._fence_job_ok(queue_seed, changed, []))
        changed = json.loads(json.dumps(during))
        changed["blocker"]["InvocationID"] = "e" * 32
        self.assertFalse(harness._fence_job_ok(queue_seed, changed, []))
        changed = json.loads(json.dumps(during))
        changed["jobs_observation"]["command"]["stdout"] = ""
        self.assertFalse(harness._fence_job_ok(queue_seed, changed, []))
        changed = json.loads(json.dumps(queue_seed))
        changed.pop("job_observation")
        self.assertFalse(harness._fence_job_ok(changed, during, []))

    def _fence(self):
        before = [self._completion(1, "a" * 32),
                  self._completion(2, "b" * 32)]
        after = before + [self._completion(3, "c" * 32, NODE),
                          self._completion(4, "d" * 32, NODE)]
        during = {"completions_before_external": copy.deepcopy(before),
                  "completions": copy.deepcopy(before),
                  "completion_count": 2, "external_completion_delta": 0}
        fence = {"completions_before": before, "completions_after": after}
        record = {"completions": copy.deepcopy(after[2:])}
        return fence, during, record

    def test_fence_completion_delta_is_derived_not_cached(self):
        fence, during, record = self._fence()
        self.assertTrue(harness._fence_completion_ok(fence, during, record, []))
        during["completions"] = during["completions"] + [
            self._completion(5, "e" * 32)]
        self.assertFalse(harness._fence_completion_ok(fence, during, record, []))
        fence, during, record = self._fence()
        during.pop("completions_before_external")
        self.assertFalse(harness._fence_completion_ok(fence, during, record, []))
        fence, during, record = self._fence()
        during["external_completion_delta"] = True
        self.assertFalse(harness._fence_completion_ok(fence, during, record, []))
        fence, during, record = self._fence()
        fence["completions_after"][2]["runtime"] = PYTHON
        self.assertFalse(harness._fence_completion_ok(fence, during, record, []))
        fence, during, record = self._fence()
        fence["completions_after"][3]["sequence"] = 99
        self.assertFalse(harness._fence_completion_ok(fence, during, record, []))

    def test_refusal_requires_present_paired_record_inventories(self):
        record = self._record()
        files = {"service": {"type": "file"}}
        units = {
            harness.REPAIR_UNIT: {
                "LoadState": "loaded", "ActiveState": "inactive",
                "UnitFileState": "static",
                "FragmentPath": harness.REPAIR_PATHS["service"]},
            harness.REPAIR_TIMER: {
                "LoadState": "loaded", "ActiveState": "inactive",
                "UnitFileState": "enabled",
                "FragmentPath": harness.REPAIR_PATHS["timer"]},
            harness.REPAIR_PATH: {
                "LoadState": "loaded", "ActiveState": "inactive",
                "UnitFileState": "enabled",
                "FragmentPath": harness.REPAIR_PATHS["path"]},
        }
        baseline = {"files": files, "records": [record]}
        unknown = {"after": {"records": [record]}, "completions": 0}
        case = {"command": {"rc": 2, "timeout": False,
                            "stdout": "outside the allowlisted socket",
                            "stderr": ""},
                "records_before": [record], "records_after": [record],
                "completions_after": 0, "units_after": units,
                "mutated_files": files}
        self.assertTrue(harness._refusal_case_ok(
            "rogue-unit", case, baseline, unknown, []))
        missing = copy.deepcopy(case)
        missing.pop("records_before")
        self.assertFalse(harness._refusal_case_ok(
            "rogue-unit", missing, baseline, unknown, []))
        malformed = copy.deepcopy(case)
        malformed["records_before"] = [{"path": record["path"],
                                        "sha256": "not-a-digest",
                                        "bytes": 1}]
        self.assertFalse(harness._refusal_case_ok(
            "rogue-unit", malformed, baseline, unknown, []))


if __name__ == "__main__":
    unittest.main()
