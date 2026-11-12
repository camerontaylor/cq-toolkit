#!/usr/bin/env python3
"""Deterministic differential oracle for the TS repair request-context builder.

Test tooling only. It imports the PRODUCTION repair service
(`crq_repair.py`) and the PRODUCTION CQ driver
(`crq_repair/drivers/cq.py`) and records the exact request-context values
Python derives for a prepared job:

* the pinned worktree path (``process_item`` builds it, then ``process``
  receives it),
* the rung-0 role (``process`` selects it),
* the ``review.fixItem`` payload's ``repo``/``worktree``/``driver``/``budget``
  (``_dispatch`` gates the driver, then ``cq.invoke`` builds the payload).

Every recorded value comes from running that production code. Only the
process, git, filesystem-root and clock effects are mocked; none contributes
to the recorded bytes. The config's ``worktree_root`` is a fixed string, so no
host path can leak into the fixture.

The TypeScript builder is pure and takes the same ``config_text`` plus the
prepared job's ``item``/``job`` values; the TS test compares its derived
context to ``context_json`` byte for byte and maps each recorded Python
exception to one typed refusal.

Regenerate with ``python3 repair_request_context_vectors.py --write`` and
verify with ``--check``. Output is deterministic (fixed case order,
``ensure_ascii``, no timestamps or host paths).
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from crq_repair.drivers import cq
from repair_request_vectors import JOB_ID, _job

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "repair-request-context" / "cases.json"
SCHEMA = "cq.crq-repair-request-context-vector/v1"

RESPONSE = '{"status":"ok","value":{"changed":false}}'

BASE_CONFIG = {
    "repo": "example/repo",
    "clone": "/clone",
    "worktree_root": "/work",
    "repair": {
        "cq_bin": "/unused/cli.js",
        "budget": {
            "wall_clock_min": 20,
            "max_tokens": 400000,
            "max_output_tokens": 500000,
            "max_context_tokens": 200000,
        },
        "roles": {
            "fixer": {"driver": "cq", "model": "zai/glm-5.3-flash"},
            "fixer_escalation": {"driver": "cq", "model": "zai/glm-5.3"},
            "judge": {"driver": "cq", "model": "zai/glm-5.3-flash"},
            "judge_critical": {"driver": "cq", "model": "zai/glm-5.3"},
        },
    },
}


def _service():
    """Load the production repair service module, not a copy of it."""
    spec = importlib.util.spec_from_file_location(
        "repair_service_context_oracle", HERE / "crq_repair.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()


class _Stop(BaseException):
    """Escape the production call after it handed us the value we record."""


def _config_with(**repair_changes):
    config = copy.deepcopy(BASE_CONFIG)
    config["repair"].update(copy.deepcopy(repair_changes))
    return config


def _config_text(config):
    return json.dumps(config, ensure_ascii=True, indent=2) + "\n"


def _role(config, job, role, base_worktree):
    """Capture the role and wt production ``process`` hands to dispatch."""
    assert role in ("fixer", "fixer_escalation"), "production selects only these literals"
    rung = 0 if role == "fixer" else 2
    captured = {}

    def dispatch(config_, role_, job_, wt, directory, judge=False):
        captured["role"] = copy.deepcopy(role_)
        # The wt production actually dispatches against. process mutates the
        # pinned path for A2, so this is the authoritative value, not the
        # path process_item built before process ran.
        captured["worktree"] = str(wt)
        raise _Stop()

    with tempfile.TemporaryDirectory() as root, \
            mock.patch.object(service, "ROOT", Path(root)), \
            mock.patch.object(service, "dispatch", dispatch), \
            mock.patch.object(service, "retain"), \
            mock.patch.object(service, "git", return_value=""), \
            mock.patch.object(service, "blocked", return_value=False), \
            mock.patch.object(service, "dispatch_paused", return_value=False), \
            mock.patch.object(service, "utc", return_value="2026-11-11T00:00:00Z"), \
            mock.patch.object(service, "atomic"), \
            mock.patch.object(service.random, "random", return_value=1.0):
        if rung == 2:
            # Seed a deferred A2 result so production selects the escalation
            # role through its own `next_rung` read.
            result_path = Path(root) / "state" / "repair" / job["job"] / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(json.dumps({
                "job": job["job"], "attempts": [], "next_rung": 2,
                # A past retry_after keeps process past its "already finished"
                # early return without changing the selected rung.
                "retry_after": "2000-01-01T00:00:00Z",
            }))
        try:
            service.process(config, copy.deepcopy(job), Path(base_worktree))
        except _Stop:
            pass
    assert "role" in captured and "worktree" in captured, "process did not reach dispatch"
    return captured["role"], captured["worktree"]


def _worktree(config, job):
    """Run production ``process_item`` far enough to capture the wt it builds."""
    prepared = copy.deepcopy(job)
    prepared.update(item=job["item"], repair_base="a" * 40)
    captured = {}

    def process(config_, job_, wt):
        captured["worktree"] = str(wt)
        return {"verdict": "NOT-FIXED"}

    with tempfile.TemporaryDirectory() as root, \
            mock.patch.object(service, "ROOT", Path(root)), \
            mock.patch.object(service, "process", process), \
            mock.patch.object(service, "command",
                              return_value=SimpleNamespace(returncode=0, stdout="", stderr="")), \
            mock.patch.object(service, "blocked", return_value=False), \
            mock.patch.object(service, "dispatch_paused", return_value=False), \
            mock.patch.object(service, "require_canonical_delivery", return_value=None):
        service.process_item(config, [prepared])
    return captured["worktree"]


def _payload(config, role, job, wt):
    """Run production ``_dispatch``/``cq.invoke`` with the command mocked."""
    captured = {}

    def command(argv, **_kwargs):
        captured["argv"] = argv
        return SimpleNamespace(returncode=0, stdout=RESPONSE, stderr="")

    with tempfile.TemporaryDirectory() as directory, \
            mock.patch.object(cq, "command", command), \
            mock.patch.object(service, "require_canonical_delivery", return_value=None), \
            mock.patch.object(service, "source_snapshot",
                              lambda config_, job_: copy.deepcopy(job_["source_snapshot"])), \
            mock.patch.object(service, "atomic"):
        service._dispatch(config, copy.deepcopy(role), copy.deepcopy(job), wt, Path(directory))
    flags = {}
    for argument in captured["argv"]:
        if argument.startswith("--") and "=" in argument:
            key, value = argument[2:].split("=", 1)
            flags[key] = json.loads(value)
    return flags


def _context(flags):
    return {
        "repo": flags["repo"],
        "worktree": flags["worktree"],
        "driver": flags["driver"],
        "budget": flags["budget"],
    }


def _error(stage, exc):
    """Record only version-stable exception facts.

    Python's formatted ``TypeError``/``ValueError``/``AttributeError`` text
    changes between interpreter minors, so the fixture never stores it: the
    exception type, a ``KeyError`` key and an ``AttributeError`` name are the
    stable discriminators. Test case names carry the operation.
    """
    record = {"stage": stage, "type": type(exc).__name__}
    if isinstance(exc, KeyError):
        record["key"] = exc.args[0] if exc.args else None
    elif isinstance(exc, AttributeError):
        record["attribute"] = getattr(exc, "name", None)
    return record


def _case(name, config, *, role="fixer", item="pr1-merged", job_id=JOB_ID):
    job = _job()
    job["job"] = job_id
    job["item"] = item
    record = {
        "name": name,
        "config_text": _config_text(config),
        "role": role,
        "pinned": {"item": item, "job": job_id},
        "base_worktree": None,
        "worktree": None,
        "context": None,
        "context_json": None,
        "error": None,
    }
    try:
        record["base_worktree"] = _worktree(config, job)
    except Exception as exc:  # The production exception is the oracle.
        record["error"] = _error("worktree", exc)
        return record
    try:
        selected, dispatched = _role(config, job, role, record["base_worktree"])
    except Exception as exc:
        record["error"] = _error("role", exc)
        return record
    record["worktree"] = dispatched
    try:
        flags = _payload(config, selected, job, Path(dispatched))
    except Exception as exc:
        record["error"] = _error("dispatch", exc)
        return record
    context = _context(flags)
    record["context"] = context
    record["context_json"] = json.dumps(context, ensure_ascii=True, indent=2) + "\n"
    return record


def build():
    cases = [
        _case("canonical-fixer", copy.deepcopy(BASE_CONFIG)),
        _case("escalation-role", copy.deepcopy(BASE_CONFIG), role="fixer_escalation"),
        _case(
            "role-budget-overrides",
            _config_with(
                roles={
                    "fixer": {
                        "driver": "cq",
                        "model": "zai/glm-5.3-flash",
                        "budget": {"max_output_tokens": 12345, "max_context_tokens": 6789},
                    },
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "role-budget-partial",
            _config_with(
                roles={
                    "fixer": {
                        "driver": "cq",
                        "model": "zai/glm-5.3-flash",
                        "budget": {"max_output_tokens": 4321},
                    },
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "base-token-defaults",
            _config_with(budget={"wall_clock_min": 20, "max_tokens": 400000}),
        ),
        _case(
            "fractional-wall-clock",
            _config_with(budget={**BASE_CONFIG["repair"]["budget"], "wall_clock_min": 0.123456789}),
        ),
        _case(
            "fractional-wall-clock-rounding",
            _config_with(budget={**BASE_CONFIG["repair"]["budget"], "wall_clock_min": 1.9999}),
        ),
        _case(
            "model-with-extra-slash",
            _config_with(
                roles={
                    "fixer": {"driver": "cq", "model": "openrouter/nous/hermes-4"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "item-and-job-punctuation",
            copy.deepcopy(BASE_CONFIG),
            item="pr 7 (merged)",
            job_id="crq-backfill-ab/c",
        ),
        _case(
            "worktree-root-trailing-slash",
            {**copy.deepcopy(BASE_CONFIG), "worktree_root": "/work/trees/"},
        ),
        _case(
            "worktree-root-single-slash",
            {**copy.deepcopy(BASE_CONFIG), "worktree_root": "/"},
        ),
        _case(
            "worktree-root-double-slash",
            {**copy.deepcopy(BASE_CONFIG), "worktree_root": "//"},
        ),
        _case(
            "unicode-item-and-job",
            copy.deepcopy(BASE_CONFIG),
            item="pr-雪",
            job_id="crq-😀-F1",
        ),
        _case("missing-repair-block", {"repo": "example/repo", "worktree_root": "/work"}),
        _case("missing-roles", _config_with(roles=None)),
        _case(
            "missing-roles-key",
            {**copy.deepcopy(BASE_CONFIG),
             "repair": {key: value for key, value in BASE_CONFIG["repair"].items()
                        if key != "roles"}},
        ),
        _case(
            "role-not-object",
            _config_with(
                roles={
                    "fixer": 5,
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "unknown-role",
            _config_with(roles={"fixer": copy.deepcopy(BASE_CONFIG["repair"]["roles"]["fixer"])}),
            role="fixer_escalation",
        ),
        _case(
            "role-missing-model",
            _config_with(
                roles={
                    "fixer": {"driver": "cq"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "role-missing-driver",
            _config_with(
                roles={
                    "fixer": {"model": "zai/glm-5.3-flash"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "model-not-string",
            _config_with(
                roles={
                    "fixer": {"driver": "cq", "model": None},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "model-without-separator",
            _config_with(
                roles={
                    "fixer": {"driver": "cq", "model": "glm-5.3-flash"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case(
            "non-cq-fixer-driver",
            _config_with(
                roles={
                    "fixer": {"driver": "paseo", "model": "zai/glm-5.3-flash"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case("missing-repo", {key: value for key, value in copy.deepcopy(BASE_CONFIG).items()
                                 if key != "repo"}),
        _case(
            "missing-budget",
            {**copy.deepcopy(BASE_CONFIG),
             "repair": {**copy.deepcopy(BASE_CONFIG["repair"]), "budget": None}},
        ),
        _case(
            "missing-budget-key",
            {**copy.deepcopy(BASE_CONFIG),
             "repair": {key: value for key, value in BASE_CONFIG["repair"].items()
                        if key != "budget"}},
        ),
        _case(
            "missing-wall-clock",
            _config_with(budget={"max_tokens": 400000}),
        ),
        _case(
            "non-numeric-wall-clock",
            _config_with(budget={**BASE_CONFIG["repair"]["budget"], "wall_clock_min": None}),
        ),
        _case("budget-not-object", _config_with(budget=[])),
        _case(
            "role-budget-not-object",
            _config_with(
                roles={
                    "fixer": {"driver": "cq", "model": "zai/glm-5.3-flash", "budget": "large"},
                    **{name: role for name, role in
                       copy.deepcopy(BASE_CONFIG["repair"]["roles"]).items() if name != "fixer"},
                }
            ),
        ),
        _case("missing-worktree-root", {key: value for key, value in BASE_CONFIG.items()
                                        if key != "worktree_root"}),
        _case("worktree-root-not-string",
              {**copy.deepcopy(BASE_CONFIG), "worktree_root": None}),
        _case("job-id-not-string", copy.deepcopy(BASE_CONFIG), job_id=None),
    ]
    names = [case["name"] for case in cases]
    assert len(names) == len(set(names)), "case names must be unique"
    for case in cases:
        text = case["config_text"]
        assert "/tmp/" not in text and "TemporaryDirectory" not in text
        if case["context_json"] is not None:
            assert "/tmp/" not in case["context_json"]
    return {
        "schema": SCHEMA,
        "source": [
            "apps/crq-python/crq_repair.py:process_item (pinned worktree path)",
            "apps/crq-python/crq_repair.py:process (rung-0 role selection and A2 '-A2' worktree mutation)",
            "apps/crq-python/crq_repair.py:_dispatch (driver gate)",
            "apps/crq-python/crq_repair/drivers/cq.py:invoke (repo/worktree/driver/budget)",
            "apps/crq-python/crq_repair/drivers/cq.py:budget",
        ],
        "context_fields": ["repo", "worktree", "driver", "budget"],
        "cases": cases,
    }


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Emit the repair request-context oracle fixture"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("repair-request-context fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
