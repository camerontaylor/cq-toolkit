#!/usr/bin/env python3
"""Deterministic offline oracle for the TS ``exemptionBaseSpec`` port.

Test tooling only. It drives the PRODUCTION ``crq.exemption_base`` with
``crq.git`` replaced by a recorder that echoes its revision argument, and
records, per item, the revision Python resolves (``spec``, null when it never
calls git) or the exception class it raises. The TypeScript test
(``test/queue-runner/scanExemptions.test.ts``) replays every case through
``exemptionBaseSpec``.

Regenerate with ``python3 exemption_base_vectors.py --write``; verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from unittest import mock

import crq

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-exemption-base" / "cases.json"
SCHEMA = "cq.crq-exemption-base-vector/v1"
SOURCE_PATH = "apps/crq-python/crq.py"

PUSH = crq.push_current.KIND
RECEIPT = crq.review_receipt.KIND


def items() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = [
        ("push reads the subject base", {"kind": PUSH, "subject": {"base": "abc", "head": "def"}}),
        ("receipt reads the merge first parent", {"kind": RECEIPT, "subject": {"merge_sha": "m1"}}),
        ("receipt without merge_sha is none", {"kind": RECEIPT, "subject": {"base": "x"}}),
        ("receipt with empty merge_sha is none", {"kind": RECEIPT, "subject": {"merge_sha": ""}}),
        ("push with empty subject is none", {"kind": PUSH, "subject": {}}),
        ("push with a non-string base is none", {"kind": PUSH, "subject": {"base": 7}}),
        ("push with an empty base is none", {"kind": PUSH, "subject": {"base": ""}}),
        ("push without a subject is none", {"kind": PUSH}),
        ("push with a null subject is none", {"kind": PUSH, "subject": None}),
        ("other kinds are none", {"kind": "open", "subject": {"base": "abc"}}),
        ("a truthy non-string merge_sha is a TypeError",
         {"kind": RECEIPT, "subject": {"merge_sha": 5}}),
        ("a list merge_sha is a TypeError", {"kind": RECEIPT, "subject": {"merge_sha": ["m"]}}),
    ]
    for label, subject in (
        ("a non-empty string", "base"),
        ("a non-empty list", ["base"]),
        ("a non-zero number", 3),
        ("true", True),
    ):
        for kind_label, kind in (("push", PUSH), ("receipt", RECEIPT)):
            out.append((f"{kind_label} with {label} subject raises AttributeError",
                        {"kind": kind, "subject": subject}))
    for label, subject in (("an empty string", ""), ("an empty list", []), ("zero", 0), ("false", False)):
        out.append((f"push with {label} subject is none", {"kind": PUSH, "subject": subject}))
    out.append(("a non-dict subject is never read by other kinds",
                {"kind": "open", "subject": "base"}))
    return out


def record(item: dict) -> dict:
    called: list[str] = []

    def fake_git(*args, **kwargs):
        called.append(args[1])
        return args[1]

    with mock.patch.object(crq, "git", fake_git):
        try:
            crq.exemption_base(item)
        except Exception as exc:  # noqa: BLE001 - the class name is the oracle
            return {"raises": type(exc).__name__}
    return {"spec": called[0] if called else None}


def build() -> dict:
    return {
        "schema": SCHEMA,
        "source": SOURCE_PATH,
        "cases": [{"name": name, "item": item, "result": record(item)} for name, item in items()],
    }


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq exemption-base oracle fixture")
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
        print("exemption-base fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
