#!/usr/bin/env python3
"""Composition factory for one per-unit switch transaction.

This module is the only place that binds the merged production pieces
together for a single unit switch:

* ``prepare-host.render_service`` as the source-bound target renderer;
* ``unit-adapter.ProductionUnitAdapter`` as the controller seam;
* ``unit-completion.SystemdJournalCompletionPort`` as the runtime-bound
  completion provider, built from the same selected render;
* ``DeclaredCapabilities`` fed from the verified artifact's declared live
  commands.

It is deliberately not a CLI and not an enablement path. It constructs no live
``SystemdPort`` and no live ``JournalSource``; both remain injected, so this
module cannot reach a host by itself. The controller CLI reaches it through
``unit-live-binding.production_adapter`` for ``switch --unit --runtime``.

The selected identity is rendered once, read-only, before the adapter exists.
The completion provider therefore binds the exact service digest, source
commit, template blob and, for Node, the verified whole-artifact identity that
the adapter later renders and installs. It is not a completion store, schema,
ledger, approval packet or new lock, and it grants no queue work credit.

Known limits, unchanged by this composition:

* every host observation and command is injected; the real systemd and journal
  behavior remains unproven until a parent-owned host binding and VM evidence
  exist;
* the completion provider compares digests read at observation time. Equal
  digests prove observed consistency, not the bytes systemd loaded at
  invocation start;
* the controller captures the switch baseline after its drain/mask, while the
  adapter preflight also reads a baseline with the prior unit installed. Both
  observations are monotonic-clock facts; a masked unit yields baseline zero;
* root, record-directory and shared-lock coverage are wiring preconditions
  owned by the coordinator, not fields in this factory;
* a Node target is accepted only when the verified artifact's declaration
  names the selected command. ``watchdog`` is currently the only declared live
  command; ``tick``, ``slot``, ``publisher``, ``backfill`` and ``repair`` still
  refuse. The selected artifact must already be installed and inventory
  verified; this factory does not stage it.
"""
from __future__ import annotations

import hashlib
import importlib.util
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

OPS = Path(__file__).resolve().parent
HEX40_RE = re.compile(r"[0-9a-f]{40}")
RUNTIME_RE = re.compile(r"node:[0-9a-f]{40}")


def _load(name, path):
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


host = _load("crq_unit_switch_factory_host", OPS / "prepare-host.py")
adapter_module = _load("crq_unit_switch_factory_adapter",
                       OPS / "unit-adapter.py")
completion_module = _load("crq_unit_switch_factory_completion",
                          OPS / "unit-completion.py")


class FactoryRefused(RuntimeError):
    """The factory cannot compose a coherent selected identity."""


@dataclass(frozen=True)
class Selection:
    """One rendered target identity, before any adapter exists."""

    root: Path
    source_sha: str
    unit: str
    runtime: str
    artifact_root: Path | None
    render: Mapping[str, Any]
    identity: Any


def _valid_runtime(runtime):
    return runtime == "python" or (
        isinstance(runtime, str) and RUNTIME_RE.fullmatch(runtime) is not None)


def _verify_selection(selection):
    if not isinstance(selection, Selection):
        raise FactoryRefused("selection is not a factory Selection")
    render = selection.render
    if not isinstance(render, Mapping):
        raise FactoryRefused("selected render is not an object")
    if render.get("unit") != selection.unit \
            or render.get("runtime") != selection.runtime:
        raise FactoryRefused("selected render names another unit or runtime")
    if render.get("source_sha") != selection.source_sha:
        raise FactoryRefused("selected render names another source commit")
    data = render.get("bytes")
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise FactoryRefused("selected render has no bytes")
    if render.get("sha256") != hashlib.sha256(bytes(data)).hexdigest():
        raise FactoryRefused("selected render digest does not match its bytes")
    for key in ("sha256", "source_sha", "template_blob_oid"):
        if not isinstance(render.get(key), str):
            raise FactoryRefused("selected render lacks " + key)
    if HEX40_RE.fullmatch(render["template_blob_oid"]) is None:
        raise FactoryRefused("selected render lacks a template blob")
    identity = selection.identity
    expected = (
        ("unit", selection.unit),
        ("runtime", selection.runtime),
        ("service_sha256", render["sha256"]),
        ("source_sha", render["source_sha"]),
        ("template_blob_oid", render["template_blob_oid"]),
    )
    for field, value in expected:
        if getattr(identity, field, None) != value:
            raise FactoryRefused(
                "selected identity does not bind the render: " + field)


def select(*, root, unit, runtime, source_sha, artifact_root=None) -> Selection:
    """Render and bind the selected target identity. Read-only.

    This is the only render the factory performs. The adapter is pinned to
    this render: it re-renders the same unit at preflight and install, refuses
    if a fresh value differs from the selected render, and refuses if its
    preflight and install values differ.
    """
    root = Path(root)
    if not root.is_absolute() or not root.is_dir():
        raise FactoryRefused("deployment root must be an absolute directory")
    if not isinstance(source_sha, str) or HEX40_RE.fullmatch(source_sha) is None:
        raise FactoryRefused("source commit must be a full 40-hex SHA")
    if not _valid_runtime(runtime):
        raise FactoryRefused("runtime must be python or node:<40-hex>")
    if unit not in host.UNIT_COMMANDS:
        raise FactoryRefused(
            "unit is not in the declared runtime inventory: " + str(unit))
    artifact = Path(artifact_root) if artifact_root is not None else None
    try:
        render = host.render_service(
            root, unit, runtime, sha=source_sha,
            artifact_root=(str(artifact) if artifact is not None else None))
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise FactoryRefused(
            "production render refused: " + str(exc)[:300]) from exc
    if render.get("source_sha") != source_sha:
        raise FactoryRefused("render source does not match the pinned commit")
    if runtime != "python":
        artifact_identity = render.get("artifact")
        if not isinstance(artifact_identity, Mapping) \
                or artifact_identity.get("source_sha") != runtime[5:]:
            raise FactoryRefused(
                "node artifact source does not match the pointer")
    try:
        identity = completion_module.ExpectedIdentity.from_render(
            unit=unit, runtime=runtime, render=render)
    except completion_module.CompletionError as exc:
        raise FactoryRefused(
            "selected identity refused: " + str(exc)[:300]) from exc
    selection = Selection(root=root, source_sha=source_sha, unit=unit,
                          runtime=runtime, artifact_root=artifact,
                          render=render, identity=identity)
    _verify_selection(selection)
    return selection


def build(
    selection,
    *,
    unit_dir,
    systemd,
    identity,
    journal_source,
    queue_drain,
    error_type=RuntimeError,
    require_journal_witness=False,
    drain_timeout=30.0,
    completion_timeout=None,
    max_completion_window=None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
):
    """Compose the real adapter and completion port for one selection.

    The injected ports are the only host boundary. ``systemd`` and
    ``journal_source`` must observe the same host and unit directory; the
    factory cannot prove that for opaque ports. For a queue-issuing unit,
    ``queue_drain`` must be the caller's existing queue-ownership observation;
    this factory never invents a second one and never signals a process. The
    non-issuing watchdog does not consume that observation and may be composed
    without it.
    """
    _verify_selection(selection)
    if systemd is None or identity is None or journal_source is None:
        raise FactoryRefused(
            "systemd, identity and journal source ports are required")
    if queue_drain is None and adapter_module.unit_issues_queue_work(
            selection.unit):
        raise FactoryRefused("queue drain observation is required")
    if not isinstance(require_journal_witness, bool):
        raise FactoryRefused("journal witness policy must be a boolean")
    completion = completion_module.SystemdJournalCompletionPort(
        unit_dir=Path(unit_dir),
        source=journal_source,
        expected=selection.identity,
        require_journal_witness=require_journal_witness,
    )
    artifact = (selection.render.get("artifact")
                if selection.runtime != "python" else None)
    if artifact is not None and not isinstance(artifact, Mapping):
        raise FactoryRefused("selected artifact identity is not an object")
    node_commands = (artifact.get("capabilities", [])
                     if artifact is not None else [])
    try:
        capability = adapter_module.DeclaredCapabilities(
            node_commands=node_commands)
    except TypeError as exc:
        raise FactoryRefused(
            "adapter composition refused: " + str(exc)[:300]) from exc
    options = {
        "root": selection.root,
        "source_sha": selection.source_sha,
        "unit_dir": Path(unit_dir),
        "artifact_root": selection.artifact_root,
        "systemd": systemd,
        "identity": identity,
        "capability": capability,
        "completion": completion,
        "queue_drain": queue_drain,
        "error_type": error_type,
        "drain_timeout": drain_timeout,
        "expected_render": {
            "sha256": selection.render["sha256"],
            "source_sha": selection.render["source_sha"],
            "template_blob_oid": selection.render["template_blob_oid"],
        },
        "clock": clock,
        "sleep": sleep,
    }
    if completion_timeout is not None:
        options["completion_timeout"] = completion_timeout
    if max_completion_window is not None:
        options["max_completion_window"] = max_completion_window
    try:
        return adapter_module.ProductionUnitAdapter(**options)
    except TypeError as exc:
        raise FactoryRefused(
            "adapter composition refused: " + str(exc)[:300]) from exc


def compose(
    *,
    root,
    unit,
    runtime,
    source_sha,
    unit_dir,
    systemd,
    identity,
    journal_source,
    queue_drain,
    artifact_root=None,
    **options,
):
    """Select, render and compose one switch adapter. No host is touched."""
    selection = select(root=root, unit=unit, runtime=runtime,
                       source_sha=source_sha, artifact_root=artifact_root)
    adapter = build(selection, unit_dir=unit_dir, systemd=systemd,
                    identity=identity, journal_source=journal_source,
                    queue_drain=queue_drain, **options)
    return adapter, selection
