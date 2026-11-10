#!/usr/bin/env python3
"""Explicit proof-vehicle CLI for one isolated unit switch and recovery.

The CLI constructs the guest-only fixture adapter and calls the *actual*
``deploy-controller.switch_unit`` / ``recover_unit`` functions. It never
implements the transaction itself, never selects a production adapter, and
requires the explicit ``--proof-fixture`` gate. Without that gate it refuses
without touching the host.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys

OPS = pathlib.Path(__file__).resolve().parent


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = _load("crq_deploy_controller", OPS / "deploy-controller.py")
adapter_mod = _load("crq_unit_switch_adapter", OPS / "unit-switch-adapter.py")


def _summary(record):
    if not isinstance(record, dict):
        return record
    keys = ("schema_version", "transaction_id", "operation", "unit", "runtime",
            "prior_runtime", "outcome", "phase", "reason", "completions",
            "record_path")
    summary = {key: record[key] for key in keys if key in record}
    snapshot = record.get("snapshot")
    if isinstance(snapshot, dict):
        summary["snapshot_paths"] = sorted((snapshot.get("paths") or {}).keys())
        summary["snapshot_runtime"] = snapshot.get("runtime")
    return summary


def _print(value, status=0):
    print(json.dumps(value, indent=2, sort_keys=True))
    return status


def _adapter(args):
    return adapter_mod.GuestFixtureAdapter(
        unit_dir=pathlib.Path.home() / ".config/systemd/user",
        fixture_dir=args.fixture_dir,
        unit=args.unit,
        proof_root=args.proof_root,
        error_type=dc.Refused,
        guest_only=True,
    )


def _prepare_records(path):
    path = pathlib.Path(path)
    if path.is_symlink():
        raise dc.Refused("controller record directory must not be a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def run_switch(args):
    if not args.proof_fixture:
        return _print({"command": "switch",
                       "refused": "the proof adapter requires --proof-fixture; "
                                  "no production unit-switch adapter is available"},
                      2)
    record_dir = _prepare_records(args.record_dir)
    root = args.root.resolve()
    effects = dc.Effects(root, record_dir.resolve())
    adapter = _adapter(args)
    try:
        record = dc.switch_unit(effects, adapter, args.unit, args.runtime)
    except dc.RecoveryRequired as exc:
        return _print({"command": "switch", "refused": str(exc),
                       "recovery_required": _summary(exc.recovery),
                       "commands": adapter.commands}, 3)
    except dc.Refused as exc:
        return _print({"command": "switch", "refused": str(exc),
                       "commands": adapter.commands}, 2)
    except Exception as exc:  # noqa: BLE001 - fail closed with the observed error
        return _print({"command": "switch", "error": type(exc).__name__,
                       "detail": str(exc)[:400],
                       "commands": adapter.commands}, 1)
    return _print({"command": "switch", "record": _summary(record),
                   "commands": adapter.commands}, 0)


def run_recover(args):
    if not args.proof_fixture:
        return _print({"command": "recover",
                       "refused": "the proof adapter requires --proof-fixture; "
                                  "no production unit-switch adapter is available"},
                      2)
    record_dir = _prepare_records(args.record_dir)
    root = args.root.resolve()
    effects = dc.Effects(root, record_dir.resolve())
    adapter = _adapter(args)
    try:
        record = dc.recover_unit(effects, adapter, args.record)
    except dc.RecoveryRequired as exc:
        return _print({"command": "recover", "refused": str(exc),
                       "recovery_required": _summary(exc.recovery),
                       "commands": adapter.commands}, 3)
    except dc.Refused as exc:
        return _print({"command": "recover", "refused": str(exc),
                       "commands": adapter.commands}, 2)
    except Exception as exc:  # noqa: BLE001 - fail closed with the observed error
        return _print({"command": "recover", "error": type(exc).__name__,
                       "detail": str(exc)[:400],
                       "commands": adapter.commands}, 1)
    return _print({"command": "recover", "record": _summary(record),
                   "commands": adapter.commands}, 0)


def build_parser():
    parser = argparse.ArgumentParser(
        description="Isolated unit-switch proof vehicle (not a production adapter)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("switch", "recover"):
        command = sub.add_parser(name)
        command.add_argument("--root", required=True, type=pathlib.Path)
        command.add_argument("--record-dir", required=True, type=pathlib.Path)
        command.add_argument("--unit", default=adapter_mod.UNIT)
        command.add_argument("--fixture-dir", type=pathlib.Path,
                             default=pathlib.Path.home() / "fixture")
        command.add_argument("--proof-root", type=pathlib.Path,
                             default=pathlib.Path.home() / "proof-bin")
        command.add_argument("--proof-fixture", action="store_true",
                             help="required explicit gate for the guest-only "
                                  "fixture adapter")
        if name == "switch":
            command.add_argument("--runtime", required=True)
        else:
            command.add_argument("--record", required=True, type=pathlib.Path)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "switch":
        return run_switch(args)
    return run_recover(args)


if __name__ == "__main__":
    sys.exit(main())
