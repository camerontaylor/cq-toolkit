#!/usr/bin/env python3
"""Deterministic offline oracle for the file-backed ``launch`` bindings.

Test tooling only. It runs the PRODUCTION ``author_lease.check_queue`` /
``grant_queue`` (``author_lease.py:55`` / ``:72``), ``review_transport.clone_for``
(``review_transport.py:60``), ``crq.secret_scan`` / ``secret_scan_diff`` /
``load_scan_exemptions`` (``crq.py:587`` / ``:596`` / ``:477``), the backfill
context scan (``crq.py:2111``) and ``crq.save_queue`` (``crq.py:294``), and records,
per scenario, the value, the exception class that escaped and the bytes left on disk.

Scans run against a real throwaway git repository (tags ``base`` and ``head``, the
denylist committed at ``origin/main``); file contents are given as hex so secret
shapes never appear in the fixture and non-UTF-8 input is exact. gitleaks is hidden
from ``shutil.which`` so every scan reports ``not-run`` on both sides. Paths start
with ``/T``; the oracle substitutes its temporary directory both ways.

Regenerate with ``python3.14 launch_bindings_vectors.py --write``; verify with ``--check``.
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
import author_lease  # noqa: E402
import crq  # noqa: E402
import review_transport  # noqa: E402
from author_quota import AuthorRefused  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-launch-bindings" / "cases.json"
SCHEMA = "cq.crq-launch-bindings-vector/v1"
CORPUS = (HERE.parents[1] / "policy/denylist/patterns.yml").read_text(encoding="utf-8")

AT = "2026-11-27T01:00:00Z"
LEASE = {"v": 1, "state": "waiting", "requested_at": "2026-11-27T00:00:00Z",
         "deadline_at": "2026-11-27T00:30:00Z", "reviewerTimeoutMin": 30, "reviewer": "r"}
AUTHOR_ITEM = {"id": "a1", "kind": "author", "state": "pending", "author_lease": LEASE}
UNIVERSAL = ["class:token-ssh-plumbing", "class:route-key-material", "class:key-material-env",
             "class:inline-secret-assignments"]


def hexs(text: str) -> str:
    return text.encode("utf-8", "surrogatepass").hex()


# Secret shapes are spelled in pieces so this file itself stays clean.
SECRET = "DEPLOY_" + "TOKEN=" + "abababababababab"
SECRET2 = "DB_PASS" + "WORD=" + "hunter2hunter2 x"
EXEMPT = '[[exempt]]\npath = "src/**"\nrule = "class:inline-secret-assignments"\nreason = "fixture"\n'

SCENARIOS: list[dict] = []


def custom(extra: str = "", *, second: bool = False) -> str:
    """A patterns file both the lax Python parser and the strict TS parser accept."""
    rule = "  - id: %s\n    description: d\n    regex: %s\n    sample: s\n%s"
    text = "rules:\n" + rule % ("class:custom", "'needle'", extra)
    if second:
        text = "rules:\n" + rule % ("a", "'needle'", "") + rule % ("b", "need.e", "")
    return hexs(text + "clean_probes:\n  - 'clean'\n")


def add(name, op, **kw):
    SCENARIOS.append({"name": name, "op": op, **copy.deepcopy(kw)})


def lease(**over):
    out = {**LEASE, **over}
    return {k: v for k, v in out.items() if v is not ...}


def build_scenarios() -> None:
    # --- author lease -------------------------------------------------------------------
    for fn in ("check", "grant"):
        add(f"author {fn}: no lease is a legacy no-op", fn_op(fn), item={"id": "a", "state": "pending"}, at=AT)
        add(f"author {fn}: a fresh waiting lease", fn_op(fn), item=AUTHOR_ITEM, at="2026-11-27T00:10:00Z")
        add(f"author {fn}: past the deadline is refused", fn_op(fn), item=AUTHOR_ITEM, at=AT)
        add(f"author {fn}: the clock moved backwards", fn_op(fn), item=AUTHOR_ITEM, at="2026-11-26T00:00:00Z")
        add(f"author {fn}: an assigned lease is refused", fn_op(fn),
            item={**AUTHOR_ITEM, "author_lease": lease(state="queue", decided_at="2026-11-27T00:10:00Z")},
            at="2026-11-27T00:15:00Z")
        add(f"author {fn}: a blocked lease is permanent", fn_op(fn),
            item={**AUTHOR_ITEM, "author_lease": lease(secret_scan_blocked=True)}, at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a started item is refused", fn_op(fn), item={**AUTHOR_ITEM, "attempts": 1},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a run makes it started", fn_op(fn), item={**AUTHOR_ITEM, "run": "r-1"},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a non-pending state is refused", fn_op(fn), item={**AUTHOR_ITEM, "state": "running"},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a malformed at is refused", fn_op(fn), item=AUTHOR_ITEM, at="2026-11-27 00:10:00")
        add(f"author {fn}: a non-string at is refused", fn_op(fn), item=AUTHOR_ITEM, at=5)
        add(f"author {fn}: an unknown lease version", fn_op(fn),
            item={**AUTHOR_ITEM, "author_lease": lease(v=2)}, at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a mismatched deadline", fn_op(fn),
            item={**AUTHOR_ITEM, "author_lease": lease(deadline_at="2026-11-27T00:31:00Z")},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a non-dict lease", fn_op(fn), item={**AUTHOR_ITEM, "author_lease": "x"},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a null lease", fn_op(fn), item={**AUTHOR_ITEM, "author_lease": None},
            at="2026-11-27T00:10:00Z")
        add(f"author {fn}: a truthy non-bool marker is refused", fn_op(fn),
            item={**AUTHOR_ITEM, "author_lease": lease(secret_scan_blocked=1)}, at="2026-11-27T00:10:00Z")
        add(f"author {fn}: zero attempts and an empty run stay unstarted", fn_op(fn),
            item={**AUTHOR_ITEM, "attempts": 0, "run": ""}, at="2026-11-27T00:10:00Z")
    # --- clone_for ----------------------------------------------------------------------
    repos = [{"repo": "Org/Conf", "clone": "/T/conf"}]
    for repo in ("org/primary", "ORG/Primary", "org/conf", "Org/CONF", "new/manual", "NEW/Manual",
                 "bad", "", "a/b/c", "-x/y", "org/primary ", "ünï/cöde"):
        add(f"clone: {repo!r}", "clone", repo=repo, repos=repos)
    add("clone: a non-string repo", "clone", repo=None, repos=repos)
    # --- save_queue ---------------------------------------------------------------------
    add("save: a small queue", "save", queue={"version": 1, "items": [{"id": "a", "n": 1.5, "s": "é"}]})
    add("save: key order and nesting are kept", "save",
        queue={"z": 1, "a": {"y": [1, 2, {"k": None}], "x": True}, "items": []})
    add("save: non-ASCII is escaped", "save", queue={"items": [{"id": "x", "t": "é\U0001f600"}]})
    add("save: floats and big ints", "save", queue={"items": [{"a": 1.0, "b": 1e22, "c": 12345678901234567890}]})
    add("save: an empty queue", "save", queue={})
    # --- secret scans -------------------------------------------------------------------
    clean = {"src/a.ts": hexs("export const a = 1;\n")}
    secret = {"src/a.ts": hexs(SECRET + "\n")}
    ctx = lambda tail: hexs("l1\nl2\n" + SECRET + "\nl4\n" + tail + "\nl6\nl7\n")
    add("scan: a secret on an unchanged context line is not a hit (-U0)", "scan",
        base={"src/a.ts": ctx("l5")}, head={"src/a.ts": ctx("l5-edited")})
    add("scan: the patterns are read from origin/main, not from the head", "scan",
        base={}, head={"policy/denylist/patterns.yml": custom(), "src/a.ts": hexs(SECRET + "\n")})
    add("scan: a colour config does not hide a hit", "scan", base=clean, head=secret,
        config=[["color.ui", "always"], ["color.diff", "always"]])
    add("scan: an external diff driver is not used", "scan", base=clean, head=secret,
        config=[["diff.external", "false"]])
    add("scan: a clean range", "scan", base=clean, head={"src/a.ts": hexs("export const a = 2;\n")})
    add("scan: a secret added", "scan", base=clean, head=secret)
    add("scan: a secret removed is still a hit", "scan", base=secret, head=clean)
    add("scan: two secrets on two files", "scan", base={}, head={"a.txt": hexs(SECRET + "\n"), "b.txt": hexs(SECRET2 + "\n")})
    add("scan: an allowlisted path is skipped", "scan", base={}, head={"node_modules/x.js": hexs(SECRET + "\n")})
    add("scan: no change", "scan", base=clean, head=clean)
    add("scan: a binary file", "scan", base={}, head={"b.bin": "00ff00fe" + hexs(SECRET)})
    add("scan: non-UTF-8 content", "scan", base={}, head={"c.txt": hexs("x") + "ff" + hexs(" " + SECRET + "\n")})
    add("scan: a CR in content", "scan", base={}, head={"cr.txt": hexs("a\r" + SECRET + "\n")})
    add("scan: splitlines separators in content", "scan", base={}, head={"u.txt": hexs("a\x0b" + SECRET + "\x0cb\x1c\x85 \n")})
    add("scan: a classes set filters the denylist", "scan", base={}, head=secret, classes=UNIVERSAL)
    add("scan: an unknown class is a RuntimeError", "scan", base={}, head=secret, classes=["class:nope", "class:aaa"])
    add("scan: duplicate and universal classes", "scan", base={}, head=secret, classes=UNIVERSAL + UNIVERSAL)
    def exempt(toml_hex, **over):
        files = {**clean, ".crq/scan-exemptions.toml": toml_hex}
        return {"base": files, "head": {**files, **secret}, **over}

    add("scan: an exemption on the base honours a hit", "scan", **exempt(hexs(EXEMPT)))
    add("scan: a pushed exemption file is not honoured", "scan", base=clean,
        head={**secret, ".crq/scan-exemptions.toml": hexs(EXEMPT)})
    add("scan: a malformed exemption file fails closed", "scan", **exempt(hexs("[[exempt\n")))
    add("scan: a non-exemptible rule fails closed", "scan",
        **exempt(hexs(EXEMPT.replace("class:inline-secret-assignments", "class:client-names"))))
    add("scan: a blank reason fails closed", "scan", **exempt(hexs(EXEMPT.replace("fixture", "  "))))
    add("scan: a non-UTF-8 exemption file fails closed", "scan", **exempt(hexs("# ") + "ff" + hexs("\n" + EXEMPT)))
    add("scan: too many globstars fail closed", "scan",
        **exempt(hexs(EXEMPT.replace("src/**", "/".join(["**"] * 20)))))
    add("scan: an empty exemption file means none", "scan", **exempt(""))
    add("scan: an exemption file of another rule", "scan",
        **exempt(hexs(EXEMPT.replace("class:inline-secret-assignments", "generic-api-key"))))
    add("scan: an exemption entry missing its reason", "scan",
        **exempt(hexs('[[exempt]]\npath = "src/**"\nrule = "generic-api-key"\n')))
    add("scan: an exemption table that is not an array", "scan", **exempt(hexs("exempt = 1\n")))
    add("scan: the exemption path does not cover another file", "scan",
        base={".crq/scan-exemptions.toml": hexs(EXEMPT)},
        head={".crq/scan-exemptions.toml": hexs(EXEMPT), "lib/a.ts": hexs(SECRET + "\n")})
    add("scan: the denylist fails to parse", "scan", base={}, head=secret, patterns=hexs("rules:\n"))
    add("scan: a rule without a regex fails closed", "scan", base={}, head=secret,
        patterns=hexs("rules:\n  - id: x\n"))
    add("scan: a one-rule denylist", "scan", base={}, head={"a.txt": hexs("hello needle\n")},
        patterns=custom())
    add("scan: a rule path filter", "scan", base={},
        head={"a.txt": hexs("needle\n"), "b.md": hexs("needle\n")},
        patterns=custom("    path: '\\.md$'\n"))
    add("scan: a quoted and a plain regex", "scan", base={}, head={"a.txt": hexs("needle\n")},
        patterns=custom(second=True))
    # --- odd path shapes in the patch headers (#2385) -----------------------------------
    # Python keeps every label byte after "+++ "/"--- " (the trailing tab git writes for a
    # spaced name, the C-quoting of an odd name) and only drops the a/ or b/ prefix; the
    # tabbed or quoted text is the path every exemption glob and rule path sees.
    def exempt_path(glob, base, head, **over):
        toml = '[[exempt]]\npath = "%s"\nrule = "class:inline-secret-assignments"\nreason = "fixture"\n' % glob
        files = {".crq/scan-exemptions.toml": hexs(toml)}
        return {"base": {**files, **base}, "head": {**files, **head}, **over}

    body = hexs(SECRET + "\n")
    spaced = {"a b.txt": body}
    add("path: a new spaced file is a hit", "scan", base={}, head=spaced)
    add("path: an exact exemption does not cover the tabbed spaced path", "scan",
        **exempt_path("a b.txt", {}, spaced))
    add("path: a wildcard exemption covers the tabbed spaced path", "scan",
        **exempt_path("a b.txt*", {}, spaced))
    add("path: a spaced file in a directory is a hit", "scan", base={}, head={"d/a b.txt": body})
    add("path: a directory exemption covers a spaced file", "scan",
        **exempt_path("d/**", {}, {"d/a b.txt": body}))
    add("path: a rule path anchored at the end misses the tabbed spaced path", "scan", base={},
        head={"a b.md": hexs("needle\n"), "c.md": hexs("needle\n")}, patterns=custom("    path: '\\.md$'\n"))
    add("path: a modified spaced file", "scan", base={"a b.txt": hexs("old\n")}, head=spaced)
    add("path: a modified spaced file exemption", "scan",
        **exempt_path("a b.txt", {"a b.txt": hexs("old\n")}, spaced))
    add("path: a deleted spaced file", "scan", base=spaced, head={})
    add("path: a deleted spaced file exemption", "scan", **exempt_path("a b.txt", spaced, {}))
    add("path: a spaced file with no trailing newline", "scan", base={}, head={"a b.txt": hexs(SECRET)})
    add("path: an empty new spaced file", "scan", base={}, head={"a b.txt": ""})
    add("path: a binary spaced file", "scan", base={}, head={"a b.bin": "00ff00fe" + hexs(SECRET)})
    add("path: a tab in the name is quoted", "scan", base={}, head={"a\tb.txt": body})
    add("path: a tab in the name exemption", "scan", **exempt_path("a\\tb.txt", {}, {"a\tb.txt": body}))
    add("path: a double quote in the name", "scan", base={}, head={'a"b.txt': body})
    add("path: a double quote in the name exemption", "scan", **exempt_path('a\\"b.txt', {}, {'a"b.txt': body}))
    add("path: a backslash in the name", "scan", base={}, head={"a\\b.txt": body})
    add("path: a backslash in the name exemption", "scan", **exempt_path("a\\\\b.txt", {}, {"a\\b.txt": body}))
    add("path: a quoted spaced and tabbed name", "scan", base={}, head={"a b\tc.txt": body})
    add("path: a unicode name", "scan", base={}, head={"caf\u00e9.txt": body})
    add("path: a unicode name exemption", "scan", **exempt_path("caf\u00e9.txt", {}, {"caf\u00e9.txt": body}))
    add("path: an emoji name", "scan", base={}, head={"\U0001f600.txt": body})
    add("path: a rule path against a unicode name", "scan", base={}, head={"caf\u00e9.md": hexs("needle\n")},
        patterns=custom("    path: 'caf\\\\303\\\\251\\.md\"$'\n"))
    rename = {"r old.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n")}
    add("path: a pure rename of a spaced file", "scan", base=rename,
        head={"r new.txt": rename["r old.txt"]})
    add("path: a rename with a secret added", "scan", base=rename,
        head={"r new.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" + SECRET + "\n")})
    add("path: a rename with a secret added exemption", "scan",
        **exempt_path("r new.txt", rename, {"r new.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" + SECRET + "\n")}))
    add("path: a plain rename with a secret added", "scan", base={"o.txt": rename["r old.txt"]},
        head={"n.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" + SECRET + "\n")})
    add("path: a rename into a directory", "scan", base={"o.txt": rename["r old.txt"]},
        head={"d/n.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" + SECRET + "\n")})
    add("path: a rename into node_modules is allowlisted", "scan", base={"o.txt": rename["r old.txt"]},
        head={"node_modules/n.txt": hexs("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" + SECRET + "\n")})
    add("path: a name that looks like a header", "scan", base={}, head={"b/x b/y.txt": body})
    add("path: a name starting with a/", "scan", base={}, head={"a/x.txt": body, "b/y.txt": body})
    add("path: a name with a trailing space", "scan", base={}, head={"a.txt ": body})
    add("path: a name with a literal newline is quoted", "scan", base={}, head={"a\nb.txt": body})
    add("path: a name with a form feed", "scan", base={}, head={"a\x0cb.txt": body})
    add("path: a name with a vertical tab", "scan", base={}, head={"a\x0bb.txt": body})
    add("path: a name with a line separator", "scan", base={}, head={"a\u2028b.txt": body})
    add("path: a name with a next-line char", "scan", base={}, head={"a\u0085b.txt": body})
    add("path: a name with a carriage return", "scan", base={}, head={"a\rb.txt": body})
    add("path: a pure rename to a quoted name", "scan", base={"o.txt": rename["r old.txt"]},
        head={"n\tq.txt": rename["r old.txt"]})
    add("path: a spaced name with a secret in a removed line", "scan",
        base={"a b.txt": hexs(SECRET + "\nkeep\n")}, head={"a b.txt": hexs("keep\n")})
    # --- backfill context scan ----------------------------------------------------------
    add("context: a clean context", "context", item={"context": {"a": 1}})
    add("context: an absent context is empty", "context", item={})
    add("context: a secret in the context", "context", item={"context": {"note": SECRET}})
    add("context: non-ASCII is escaped", "context", item={"context": {"n": "é\U0001f600"}})
    add("context: a null context is null", "context", item={"context": None})
    add("context: a list context", "context", item={"context": [1, "x", {"b": 2, "a": 1}]})
    add("context: sorted compact keys", "context", item={"context": {"z": 1, "a": 2.5}})
    # --- revParse -----------------------------------------------------------------------
    for spec in ("head", "base", "head~1", "nope", "HEAD", "base^{tree}", "a b", ""):
        add(f"rev-parse: {spec!r}", "revparse", spec=spec)


def fn_op(fn: str) -> str:
    return "author-" + fn


def _sub(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "/T")
    if isinstance(value, list):
        return [_sub(v, tmp) for v in value]
    if isinstance(value, dict):
        return {_sub(k, tmp): _sub(v, tmp) for k, v in value.items()}
    return value


def _git(repo: Path, *args: str) -> None:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
           "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
    subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)


def _commit(repo: Path, files: dict, message: str, previous: dict) -> None:
    for name in previous:
        if name not in files and (repo / name).exists():
            (repo / name).unlink()
    for name, data in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes.fromhex(data))
    _git(repo, "add", "-A", "-f")
    _git(repo, "commit", "-q", "--allow-empty", "-m", message)


def _repo(root: Path, spec: dict) -> Path:
    repo = root / "clone"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    for key, value in spec.get("config", []):
        _git(repo, "config", key, value)
    patterns = bytes.fromhex(spec["patterns"]) if "patterns" in spec else CORPUS.encode()
    (repo / "policy" / "denylist").mkdir(parents=True)
    (repo / "policy" / "denylist" / "patterns.yml").write_bytes(patterns)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "patterns")
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    _commit(repo, spec.get("base", {}), "base", {})
    _git(repo, "tag", "base")
    _commit(repo, spec.get("head", {}), "head", spec.get("base", {}))
    _git(repo, "tag", "head")
    return repo


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="launch-bindings-") as tmp:
        root = Path(tmp)
        out: dict = {}
        op = spec["op"]
        try:
            if op in ("author-check", "author-grant"):
                item = copy.deepcopy(spec["item"])
                (author_lease.check_queue if op == "author-check" else author_lease.grant_queue)(item, at=spec["at"])
                out["item"] = item
            elif op == "clone":
                runner = SimpleNamespace(REPO="org/primary", CLONE=root / "primary", STATE=root / "state",
                                         REPOS=[{"repo": r["repo"], "clone": r["clone"].replace("/T", tmp)}
                                                for r in spec["repos"]])
                out["value"] = str(review_transport.clone_for(runner, spec["repo"]))
            elif op == "save":
                queue = root / "queue.json"
                with mock.patch.object(crq, "QUEUE", queue):
                    crq.save_queue(copy.deepcopy(spec["queue"]))
                out["queue"] = queue.read_bytes().hex()
                out["siblings"] = sorted(p.name for p in root.iterdir())
            elif op == "revparse":
                repo = _repo(root, {})
                with mock.patch.object(crq, "CLONE", repo):
                    out["value"] = crq.git("rev-parse", spec["spec"], check=False, cwd=repo)
            else:
                repo = _repo(root, spec if op == "scan" else {})
                rdir = root / "run"
                rdir.mkdir()
                with mock.patch.object(crq, "CLONE", repo), mock.patch.object(crq.shutil, "which", lambda _n: None):
                    if op == "scan":
                        classes = None if spec.get("classes") is None else frozenset(spec["classes"])
                        ok, scan = crq.secret_scan("base", "head", rdir / "secret-scan.json", classes=classes, clone=repo)
                        artifact = rdir / "secret-scan.json"
                    else:
                        item = copy.deepcopy(spec["item"])
                        context = crq.backfill_runtime.ledger.canonical(item.get("context", {})).decode()
                        patch = ("diff --git a/.crq-review-context.json b/.crq-review-context.json\n--- /dev/null\n"
                                 "+++ b/.crq-review-context.json\n@@ -0,0 +1 @@\n+" + context + "\n")
                        ok, scan = crq.secret_scan_diff(patch, rdir / "context-secret-scan.json", base="base", head="head")
                        artifact = rdir / "context-secret-scan.json"
                out["ok"] = ok
                out["scan"] = scan
                out["artifact"] = artifact.read_bytes().hex()
            out["error"] = None
        except BaseException as exc:  # noqa: BLE001 - the class is the datum
            out["error"] = type(exc).__name__
            out["message"] = str(exc) if isinstance(exc, (AuthorRefused, RuntimeError, ValueError)) else None
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
        print("launch-bindings fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
