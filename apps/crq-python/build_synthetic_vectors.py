#!/usr/bin/env python3
"""Deterministic offline oracle for ``crq.build_synthetic`` (``crq.py:1102``).

Test tooling only. Each scenario builds a throwaway work repository plus a
local bare origin in a temp directory (fixed identities and dates, so every
commit id is reproducible), runs the PRODUCTION ``crq.build_synthetic`` with
``crq.CLONE`` pointed at the work repository, and records what Python did: the
returned ``(base, head, count)`` or the exception class and message that
escaped, every ``refs/crq`` ref afterwards, the commit text and file list of the
returned subject, and whether the item record was left unchanged. Nothing
touches a real clone, queue, network, provider or host service; ``gh`` is not
reached.

The TypeScript test (``test/adapters/crq/buildSynthetic.test.ts``) replays the
same history ops into its own temp repositories and compares all of that,
including the exact object ids.

Regenerate with ``python3.14 build_synthetic_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["GIT_CONFIG_GLOBAL"] = "/dev/null"
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
import crq  # noqa: E402
import review_ledger as ledger  # noqa: E402

SCHEMA = "crq-build-synthetic-oracle/1"
FIXTURE = HERE / "fixtures" / "crq-build-synthetic" / "cases.json"
IDENT = {"GIT_AUTHOR_NAME": "fx", "GIT_AUTHOR_EMAIL": "fx@localhost", "GIT_COMMITTER_NAME": "fx",
         "GIT_COMMITTER_EMAIL": "fx@localhost", "GIT_AUTHOR_DATE": "2026-11-01T00:00:00Z",
         "GIT_COMMITTER_DATE": "2026-11-01T00:00:00Z"}


def write(path: str, text: str) -> dict:
    return {"op": "write", "path": path, "text": text}


def commit(msg: str) -> dict:
    return {"op": "commit", "msg": msg}


def git(*args: str) -> dict:
    return {"op": "git", "args": list(args)}


def rm(path: str) -> dict:
    return {"op": "rm", "path": path}


BASE = [write("a.txt", "one\ntwo\n"), write("b.txt", "bee\n"), write("dir/c.txt", "see\n"),
        write("docs/readme.md", "# r\n"), commit("base")]
PR = [git("checkout", "-q", "-b", "feat"), write("a.txt", "one\ntwo\nthree\n"), write("new.txt", "n\n"),
      write("dir/c.txt", "see\nmore\n"), commit("pr work"), git("checkout", "-q", "main"),
      git("merge", "-q", "--no-ff", "feat", "-m", "merge pr"), git("tag", "m1")]
PUSH = [git("push", "-q", "origin", "main"), git("fetch", "-q", "origin")]
AFTER = [write("b.txt", "bee\nlater\n"), commit("later")]

HISTORIES = {
    # A merged PR (a.txt, new.txt, dir/c.txt) and one later commit on main.
    "merged": BASE + PR + AFTER + PUSH,
    # new.txt is deleted after the merge, so it is in synth_paths but not live.
    "deleted": BASE + PR + [rm("new.txt"), commit("drop new")] + PUSH,
    # a.txt is renamed after the merge: rename_map adds the new name.
    "renamed": BASE + PR + [git("mv", "a.txt", "a2.txt"), commit("rename")] + PUSH,
    # Non-ASCII name: git quotes it in name-status output (core.quotepath).
    "unicode": BASE + [git("checkout", "-q", "-b", "feat"), write("é.txt", "e\n"), write("a.txt", "x\n"),
                       commit("pr work"), git("checkout", "-q", "main"),
                       git("merge", "-q", "--no-ff", "feat", "-m", "merge pr"), git("tag", "m1")] + PUSH,
    # A path whose name is not valid UTF-8 (bytes 0xff) is live at the target.
    "nonutf8": BASE + [git("checkout", "-q", "-b", "feat"), {"op": "writeb", "path_hex": "ff2e747874", "text": "z\n"},
                       write("a.txt", "x\n"), commit("pr work"), git("checkout", "-q", "main"),
                       git("merge", "-q", "--no-ff", "feat", "-m", "merge pr"), git("tag", "m1")] + PUSH,
    # A symlink and an executable are live; projection removes by path only.
    "modes": BASE + [git("checkout", "-q", "-b", "feat"), write("run.sh", "#!/bin/sh\n"),
                     {"op": "chmod", "path": "run.sh"}, {"op": "symlink", "path": "ln", "to": "a.txt"},
                     commit("pr work"), git("checkout", "-q", "main"),
                     git("merge", "-q", "--no-ff", "feat", "-m", "merge pr"), git("tag", "m1")] + PUSH,
    # Merge-less history: m1 is a plain commit (no second parent).
    "linear": BASE + [write("a.txt", "x\n"), commit("plain"), git("tag", "m1")] + PUSH,
}

T = {"$rev": "origin/main"}
M1 = {"$rev": "m1"}


def item(**extra: Any) -> dict:
    out = {"id": "pr-1", "kind": "merged", "pr": 1, "merge_commit": M1}
    out.update(extra)
    return out


_DEFAULT = object()


def scenario(name: str, history: str = "merged", target: Any = T, it: Any = _DEFAULT, identity_paths: Any = None,
             preseed: Any = None, runs: int = 1) -> dict:
    return {"name": name, "history": history, "target": target, "item": item() if it is _DEFAULT else it,
            "identity_paths": identity_paths, "preseed": preseed, "runs": runs}


def sans(key: str, **extra: Any) -> dict:
    out = item(**extra)
    del out[key]
    return out


SCENARIOS = [
    scenario("derives-paths-from-synth-paths"),
    scenario("derives-paths-with-measure-key-null", it=item(measure=None)),
    scenario("measure-without-synthetic-paths", it=item(measure={"files": []})),
    scenario("measure-empty-synthetic-paths-falls-back", it=item(measure={"synthetic_paths": []})),
    scenario("measure-empty-string-falls-back", it=item(measure={"synthetic_paths": ""})),
    scenario("measure-zero-falls-back", it=item(measure={"synthetic_paths": 0})),
    scenario("supplied-paths-filtered-by-live", it=item(measure={"synthetic_paths": ["new.txt", "gone.txt", "a.txt"]})),
    scenario("supplied-paths-sorted-by-code-point", it=item(measure={"synthetic_paths": ["dir/c.txt", "a.txt", "B"]})),
    scenario("supplied-duplicates-are-retained", it=item(measure={"synthetic_paths": ["a.txt", "a.txt", "b.txt"]})),
    scenario("supplied-no-live-path", it=item(measure={"synthetic_paths": ["nope"]})),
    scenario("supplied-string-iterates-characters", it=item(measure={"synthetic_paths": "ab"})),
    scenario("supplied-dict-iterates-keys", it=item(measure={"synthetic_paths": {"a.txt": 1, "zz": 2}})),
    scenario("supplied-non-string-hashables-are-skipped", it=item(measure={"synthetic_paths": [1, None, True, 1.5, "a.txt"]})),
    scenario("supplied-unhashable-element-is-type-error", it=item(measure={"synthetic_paths": ["a.txt", ["a.txt"]]})),
    scenario("supplied-unhashable-dict-element-is-type-error", it=item(measure={"synthetic_paths": [{"p": 1}]})),
    scenario("supplied-int-is-type-error", it=item(measure={"synthetic_paths": 5})),
    scenario("supplied-true-is-type-error", it=item(measure={"synthetic_paths": True})),
    scenario("measure-string-is-attribute-error", it=item(measure="x")),
    scenario("measure-list-is-attribute-error", it=item(measure=[1])),
    scenario("measure-empty-list-is-falsy", it=item(measure=[])),
    scenario("measure-zero-is-falsy", it=item(measure=0)),
    scenario("missing-merge-commit-is-key-error", it=sans("merge_commit")),
    scenario("missing-id-after-projection", it=sans("id")),
    scenario("missing-id-with-supplied-paths", it=sans("id", measure={"synthetic_paths": ["a.txt"]})),
    scenario("item-not-a-dict", it=["x"]),
    scenario("item-none", it=None),
    scenario("unknown-merge-commit", it=item(merge_commit="f" * 40)),
    scenario("non-string-merge-commit", it=item(merge_commit=7)),
    scenario("empty-merge-commit", it=item(merge_commit="")),
    scenario("target-is-a-ref-name-not-an-oid", target="origin/main"),
    scenario("target-short-oid", target={"$rev": "origin/main", "slice": 12}),
    scenario("target-uppercase-oid", target={"$rev": "origin/main", "upper": True}),
    scenario("target-unknown-oid", target="e" * 40),
    scenario("generation-explicit", it=item(generation=3)),
    scenario("generation-zero", it=item(generation=0)),
    scenario("generation-negative", it=item(generation=-1)),
    scenario("generation-string", it=item(generation="1")),
    scenario("generation-float", it=item(generation=1.0)),
    scenario("generation-null", it=item(generation=None)),
    scenario("id-float-is-integrity-error", it=item(id=1.5)),
    scenario("id-list", it=item(id=["a", 1])),
    scenario("id-null", it=item(id=None)),
    scenario("id-non-ascii", it=item(id="pr-é中")),
    scenario("id-huge-int-in-domain", it=item(id=2**63)),
    scenario("id-int-out-of-domain", it=item(id=2**64)),
    scenario("rerun-is-idempotent", runs=2),
    scenario("rerun-with-explicit-paths", it=item(measure={"synthetic_paths": ["a.txt"]}), runs=2),
    scenario("pin-conflict-on-base", it=item(measure={"synthetic_paths": ["a.txt"]}), identity_paths=["a.txt"],
             preseed=[{"label": "base", "rev": "origin/main"}]),
    scenario("pin-conflict-on-target", it=item(measure={"synthetic_paths": ["a.txt"]}), identity_paths=["a.txt"],
             preseed=[{"label": "target", "rev": "m1"}]),
    scenario("pin-preexisting-equal-is-kept", it=item(measure={"synthetic_paths": ["a.txt"]}), identity_paths=["a.txt"],
             preseed=[{"label": "target", "rev": "origin/main"}]),
    scenario("deleted-path-is-not-live", history="deleted"),
    scenario("renamed-path-adds-new-name", history="renamed"),
    scenario("unicode-name-is-quoted-by-git", history="unicode"),
    scenario("unicode-name-supplied", history="unicode", it=item(measure={"synthetic_paths": ["é.txt", "a.txt"]})),
    scenario("non-utf8-path-derived", history="nonutf8"),
    scenario("non-utf8-path-supplied", history="nonutf8", it=item(measure={"synthetic_paths": ["a.txt"]})),
    scenario("modes-derived", history="modes"),
    scenario("modes-supplied", history="modes", it=item(measure={"synthetic_paths": ["ln", "run.sh", "a.txt"]})),
    scenario("linear-merge-has-no-second-parent", history="linear"),
    scenario("linear-supplied-paths", history="linear", it=item(measure={"synthetic_paths": ["a.txt"]})),
    scenario("merge-commit-is-the-target", it=item(merge_commit=T)),
]


# ------------------------------------------------------------------ harness


def sh(work: Path, *args: str, check: bool = True) -> str:
    done = subprocess.run(["git", "-C", str(work), *args], capture_output=True, env=dict(os.environ, **IDENT))
    if check and done.returncode != 0:
        raise AssertionError(f"git {args}: {done.stderr!r}")
    return done.stdout.decode("utf-8", "surrogateescape").strip()


def play(work: Path, ops: list) -> None:
    for op in ops:
        kind = op["op"]
        if kind == "write":
            target = work / op["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(op["text"], encoding="utf-8")
        elif kind == "writeb":
            Path(os.fsdecode(os.fsencode(work) + b"/" + bytes.fromhex(op["path_hex"]))).write_text(op["text"])
        elif kind == "rm":
            (work / op["path"]).unlink()
        elif kind == "chmod":
            (work / op["path"]).chmod(0o755)
        elif kind == "symlink":
            os.symlink(op["to"], work / op["path"])
        elif kind == "commit":
            sh(work, "add", "-A")
            sh(work, "commit", "-q", "-m", op["msg"])
        elif kind == "git":
            sh(work, *op["args"])
        else:
            raise AssertionError(kind)


def init(root: Path) -> Path:
    origin, work = root / "origin.git", root / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    sh(work, "remote", "add", "origin", str(origin))
    return work


def resolve(work: Path, value: Any) -> Any:
    """Replace ``{"$rev": ref}`` placeholders by the object id they name here."""
    if isinstance(value, dict) and "$rev" in value:
        sha = sh(work, "rev-parse", value["$rev"] + "^{commit}")
        if "slice" in value:
            return sha[: value["slice"]]
        return sha.upper() if value.get("upper") else sha
    if isinstance(value, dict):
        return {k: resolve(work, v) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(work, v) for v in value]
    return value


def failure(error: BaseException) -> dict:
    return {"raises": type(error).__name__, "message": str(error)[:300] if not isinstance(error, subprocess.CalledProcessError)
            else "git exit " + str(error.returncode)}


def snapshot(work: Path, outcome: dict) -> dict:
    refs = sh(work, "for-each-ref", "--format=%(refname) %(objectname)", "refs/crq").splitlines()
    out = {"refs": refs}
    if "ok" in outcome:
        subject = {}
        for label in ("base", "head"):
            sha = outcome["ok"][label]
            subject[label] = {"commit": sh(work, "cat-file", "-p", sha),
                              "files": sh(work, "ls-tree", "-r", "--format=%(objectmode) %(objectname) %(path)", sha,
                                          "--", ".").splitlines()}
        out["subject"] = subject
    return out


def run_scenario(spec: dict) -> dict:
    with tempfile.TemporaryDirectory() as td:
        work = init(Path(td))
        play(work, HISTORIES[spec["history"]])
        target = resolve(work, spec["target"])
        it = resolve(work, copy.deepcopy(spec["item"]))
        before = copy.deepcopy(it)
        preseed = []
        if spec["preseed"]:
            identity = ledger.digest({"item": it["id"], "target": target, "paths": spec["identity_paths"]})
            for row in spec["preseed"]:
                ref = f"refs/crq/backfill/{identity}/{it.get('generation', 0)}/0/{row['label']}"
                sha = sh(work, "rev-parse", row["rev"] + "^{commit}")
                sh(work, "update-ref", ref, sha)
                preseed.append(ref + " " + sha)
        results = []
        for _ in range(spec["runs"]):
            with mock.patch.object(crq, "CLONE", work):
                try:
                    base, head, count = crq.build_synthetic(it, target)
                    outcome = {"ok": {"base": base, "head": head, "paths": count}}
                except BaseException as error:  # noqa: BLE001 - the oracle records every escape
                    if isinstance(error, (KeyboardInterrupt, SystemExit)):
                        raise
                    outcome = failure(error)
            results.append({"outcome": outcome, **snapshot(work, outcome), "item_unchanged": it == before})
        return {"name": spec["name"], "spec": spec, "target": target, "preseed": preseed, "results": results}


def build() -> dict:
    return {"schema": SCHEMA, "source": "apps/crq-python/crq.py:1102", "histories": HISTORIES,
            "cases": [run_scenario(spec) for spec in SCENARIOS]}


def tagged(value: Any) -> Any:
    """Keep what JSON would lose: floats stay floats and big ints stay exact."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, float):
        return {"$float": repr(value)}
    if isinstance(value, int):
        return {"$int": str(value)} if abs(value) > 2**53 else value
    if isinstance(value, list):
        return [tagged(v) for v in value]
    return {k: tagged(v) for k, v in value.items()}


def render(document: dict) -> str:
    return json.dumps(tagged(document), ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq build_synthetic oracle fixture")
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
        print("build-synthetic fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
