#!/usr/bin/env python3
"""Deterministic offline oracle for ``review_transport.provision``.

Test tooling only. It runs the PRODUCTION ``review_transport.provision``
(``review_transport.py:90``), which reaches ``repo_registry.same_repo`` /
``by_repo`` / ``manual_clone`` and ``review_transport.clone_url`` (``:75``), and
records, per scenario, the returned value, the exception class that escaped and
what is left under the runner state.

``provision`` is not part of ``crq.launch``: its only caller is the review-v1
``submit`` path (``review_transport.py:434``). It needs no live service. Every
scenario runs against throwaway local repositories: remotes are plain
directories under ``/T/remotes/<slug>`` (one empty commit whose subject is the
slug), the primary clone is a bare ``git init`` whose ``origin`` URL points at
one of them, and ``HOME`` is a throwaway directory so no user Git config leaks
in (an ``insteadOf`` rewrite there stands in for the runner's URL rewrites).
No network, no gh, no credential. Paths start with ``/T``; the oracle
substitutes its temporary directory both ways.

Regenerate with ``python3.14 provision_vectors.py --write``; verify with ``--check``.
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
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import review_transport  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-provision" / "cases.json"
SCHEMA = "cq.crq-provision-vector/v1"
PRIMARY = "org/primary"
LOCAL_ORIGIN = "/T/remotes/org/primary"

SCENARIOS: list[dict] = []


def add(name, repo, **kw):
    SCENARIOS.append({"name": name, "repo": repo, "remotes": ["org/primary", "other/repo"],
                      "repos": [], "origin": LOCAL_ORIGIN, "origin_prefix_hex": "", "rewrite": False,
                      "pre": [], **copy.deepcopy(kw)})


def build_scenarios() -> None:
    # --- repositories that need no clone ------------------------------------------------
    for repo in ("org/primary", "ORG/Primary", "Org/PRIMARY"):
        add(f"primary: {repo!r} needs no clone", repo)
    configured = [{"repo": "Org/Conf", "clone": "/T/conf"}]
    for repo in ("org/conf", "Org/CONF", "ORG/conf"):
        add(f"configured: {repo!r} needs no clone", repo, repos=configured)
    # --- malformed slugs are unavailable and touch nothing -------------------------------
    for repo in ("bad", "", "a/b/c", "-x/y", "org/primary ", " org/primary", "../x", "a/..", "ünï/cöde",
                 "a/b\n", "a" * 101 + "/b", "a/" + "b" * 101, "a/.b", "org/é"):
        add(f"malformed: {repo!r}", repo)
    # --- a successful on-demand clone ----------------------------------------------------
    add("clone: an unconfigured repository is cloned once", "other/repo")
    add("clone: another spelling is a different remote path on a case-sensitive filesystem", "Other/Repo")
    add("clone: another spelling reuses the identity-keyed clone", "Other/Repo",
        pre=[["state/review-repos/other/repo/.git", "dir"]])
    add("clone: the spelling in the URL is the requested one", "Other/Repo", remotes=["org/primary", "Other/Repo"])
    add("clone: a repository sharing a prefix with a configured one", "org/conf-two",
        remotes=["org/primary", "org/conf-two"], repos=configured)
    add("clone: the clone is reused when it already has a .git dir", "other/repo",
        pre=[["state/review-repos/other/repo/.git", "dir"], ["state/review-repos/other/repo/marker", "file"]])
    add("clone: a .git FILE is not a clone, the replace then fails on the non-empty dir", "other/repo",
        pre=[["state/review-repos/other/repo/.git", "file"]])
    add("clone: an empty directory at the clone path is replaced", "other/repo",
        pre=[["state/review-repos/other/repo", "dir"]])
    add("clone: a non-empty directory without .git cannot be replaced", "other/repo",
        pre=[["state/review-repos/other/repo/keep", "file"]])
    add("clone: a file at the clone path cannot be replaced", "other/repo",
        pre=[["state/review-repos/other/repo", "file"]])
    add("clone: a file at the owner directory fails the parent mkdir", "other/repo",
        pre=[["state/review-repos/other", "file"]])
    add("clone: an existing .tmp scratch root with leftovers is reused", "other/repo",
        pre=[["state/review-repos/.tmp/clone-old/clone/x", "file"]])
    # --- failures that return False and leave nothing behind -----------------------------
    add("fail: the remote does not exist", "missing/repo")
    add("fail: a .git suffixed slug is just another name", "a/b.git")
    add("fail: a sibling clone survives a failed one", "missing/repo",
        pre=[["state/review-repos/missing/repo.partial/.git", "dir"]])
    add("fail: no origin remote on the primary clone", "other/repo", origin=None)
    add("fail: an empty origin url", "other/repo", origin="", rewrite=True)
    add("fail: the swapped url is not a repository", "other/repo", remotes=["org/primary"])
    # --- the origin URL: where the primary slug sits ------------------------------------
    add("origin: no primary slug in the url falls back to the forge url, rewritten locally", "other/repo",
        origin="/T/elsewhere", rewrite=True,
        remotes=["org/primary", "other/repo.git"])
    add("origin: the url is matched case-insensitively", "other/repo", origin="/T/remotes/ORG/PRIMARY",
        remotes=["org/primary", "other/repo"])
    add("origin: the LAST occurrence of the primary slug is swapped", "other/repo",
        origin="/T/remotes/org/primary/org/primary", remotes=["org/primary", "other/repo", "org/primary/other/repo"])
    add("origin: an astral character before the slug (code points, not UTF-16 units)", "other/repo",
        origin="/T/remotes/\U0001f600/org/primary", remotes=["org/primary", "\U0001f600/other/repo"])
    add("origin: surrounding whitespace in the url is stripped", "other/repo",
        origin="/T/remotes/org/primary  ")
    add("origin: a url that is not UTF-8 escapes as UnicodeDecodeError", "other/repo", origin_prefix_hex="ff")
    add("origin: casefold changes the length before the slug (sharp s)", "other/repo",
        origin="/T/remotes/ß/org/primary", remotes=["org/primary", "ß/other/repo"])
    add("origin: casefold of the dotted capital I before the slug", "other/repo",
        origin="/T/remotes/İ/org/primary", remotes=["org/primary", "İ/other/repo"])
    # --- state errors that escape ---------------------------------------------------------
    add("escape: review-repos is a file", "other/repo", pre=[["state/review-repos", "file"]])
    add("escape: the .tmp scratch root is a file", "other/repo", pre=[["state/review-repos/.tmp", "file"]])
    add("escape: the state root is a file", "other/repo", pre=[["state", "file"]])


def _sub(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "/T")
    if isinstance(value, list):
        return [_sub(v, tmp) for v in value]
    if isinstance(value, dict):
        return {_sub(k, tmp): _sub(v, tmp) for k, v in value.items()}
    return value


def _git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
           "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
    done = subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)
    return done.stdout.decode("utf-8", "replace").strip()


def _remote(root: Path, slug: str) -> None:
    path = root / "remotes" / slug
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "commit", "-q", "--allow-empty", "-m", slug)


def _pre(root: Path, entries: list) -> None:
    for rel, kind in entries:
        path = root / rel
        if kind == "dir":
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x", encoding="utf-8")


def _listing(state: Path) -> list:
    """Every path under the state root; Git internals collapse into their repository."""
    if not state.exists() or not state.is_dir():
        return [str(state.name) + (":file" if state.exists() else ":absent")]
    out = []
    for path in sorted(state.rglob("*")):
        rel = path.relative_to(state)
        if ".git" in rel.parts[:-1]:
            continue
        out.append(rel.as_posix() + ("/" if path.is_dir() and not path.is_symlink() else ""))
    return out


def _clone_facts(state: Path, repo: str) -> dict:
    facts = {}
    owner, _, name = repo.casefold().partition("/")
    path = state / "review-repos" / owner / name
    if (path / ".git").is_dir() and (path / ".git" / "HEAD").exists():
        facts["subject"] = _git(path, "log", "-1", "--format=%s", "origin/main")
        facts["remote"] = _git(path, "config", "--get", "remote.origin.url")
    return facts


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="provision-") as tmp:
        root = Path(tmp)
        out: dict = {}
        try:
            for slug in spec["remotes"]:
                _remote(root, slug)
            home = root / "home"
            home.mkdir()
            if spec["rewrite"]:
                (home / ".gitconfig").write_text(
                    f'[url "{root}/remotes/"]\n\tinsteadOf = https://github.com/\n', encoding="utf-8")
            primary = root / "primary"
            primary.mkdir()
            _git(primary, "init", "-q", "-b", "main")
            if spec["origin"] is not None:
                url = bytes.fromhex(spec["origin_prefix_hex"]) + spec["origin"].replace("/T", tmp).encode()
                with (primary / ".git" / "config").open("ab") as handle:
                    handle.write(b'[remote "origin"]\n\turl = ' + url + b"\n")
            _pre(root, spec["pre"])
            runner = SimpleNamespace(REPO=PRIMARY, CLONE=primary, STATE=root / "state",
                                     REPOS=[{"repo": r["repo"], "clone": r["clone"].replace("/T", tmp)}
                                            for r in spec["repos"]])
            env = {"HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1"}
            with mock.patch.dict(os.environ, env):
                os.environ.pop("XDG_CONFIG_HOME", None)
                out["value"] = review_transport.provision(runner, spec["repo"])
            out["error"] = None
        except BaseException as exc:  # noqa: BLE001 - the class is the datum
            out["error"] = type(exc).__name__
        state = root / "state"
        out["tree"] = _listing(state)
        if out["error"] is None and out["value"] and spec["repo"] != PRIMARY:
            out["clone"] = _clone_facts(state, spec["repo"])
        return _sub(out, tmp)


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    return {"schema": SCHEMA, "cases": [{"name": s["name"], "scenario": s, "expected": _run(copy.deepcopy(s))}
                                        for s in SCENARIOS]}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(c, ensure_ascii=True, separators=(",", ":")) for c in document["cases"]]
    return json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("provision fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
