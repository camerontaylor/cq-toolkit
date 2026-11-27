#!/usr/bin/env python3
"""Deterministic offline oracle for the patch-header parsing of the review scan.

Test tooling only. It runs the PRODUCTION ``crq.secret_scan_diff`` (``crq.py:596``) over
hand-built patch text, so header shapes real git only emits under repository config the
hardened TS git runner pins away (``core.quotePath=false``: a literal U+2028 or U+0085 in a
filename) are exercised too. Per case it records the exception class that escaped and the
exact report bytes. gitleaks is hidden from ``shutil.which`` so every scan is ``not-run``.
The denylist is the committed ``policy/denylist/patterns.yml``; the exemption file is parsed
by the production ``load_scan_exemptions`` over a stubbed ``git``.

Regenerate with ``python3.14 review_scan_vectors.py --write``; verify with ``--check``.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crq  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-review-scan" / "cases.json"
SCHEMA = "cq.crq-review-scan-vector/v1"
CORPUS = (HERE.parents[1] / "policy/denylist/patterns.yml").read_text(encoding="utf-8")
RULE = "class:inline-secret-assignments"
# Secret shapes are spelled in pieces so this file itself stays clean.
SECRET = "DEPLOY_" + "TOKEN=" + "abababababababab"

CASES: list[dict] = []


def exempt(glob: str) -> str:
    return '[[exempt]]\npath = %s\nrule = "%s"\nreason = "fixture"\n' % (json.dumps(glob), RULE)


def add(name: str, lines: list[str], *, exemptions: str | None = None, end: str = "\n") -> None:
    CASES.append({"name": name, "diff": "\n".join(lines) + end, "exemptions": exemptions})


def file_diff(label_a: str, label_b: str, *, head: str | None = None, new: bool = False,
              deleted: bool = False, hunk: list[str] | None = None) -> list[str]:
    a = "/dev/null" if new else label_a
    b = "/dev/null" if deleted else label_b
    return [head if head is not None else f"diff --git {label_a} {label_b}",
            f"--- {a}", f"+++ {b}", "@@ -0,0 +1 @@", *(hunk or ["+" + SECRET])]


def build_cases() -> None:
    CASES.clear()
    add("a plain file", file_diff("a/x.txt", "b/x.txt"))
    add("a clean hunk", file_diff("a/x.txt", "b/x.txt", hunk=["+hello"]))
    add("no trailing newline", file_diff("a/x.txt", "b/x.txt"), end="")
    add("a tab after a spaced label", file_diff("a/a b.txt", "b/a b.txt\t", head="diff --git a/a b.txt b/a b.txt"))
    add("a tab after both spaced labels", ["diff --git a/a b.txt b/a b.txt", "--- a/a b.txt\t", "+++ b/a b.txt\t",
                                           "@@ -1 +1 @@", "+" + SECRET])
    add("an exact exemption misses the tabbed path", ["diff --git a/a b.txt b/a b.txt", "--- /dev/null",
                                                       "+++ b/a b.txt\t", "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("a b.txt"))
    add("a wildcard exemption covers the tabbed path", ["diff --git a/a b.txt b/a b.txt", "--- /dev/null",
                                                         "+++ b/a b.txt\t", "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("a b.txt*"))
    add("two terminal tabs", ["diff --git a/a b.txt b/a b.txt", "--- /dev/null", "+++ b/a b.txt\t\t",
                              "@@ -0,0 +1 @@", "+" + SECRET])
    add("a tab-only label tail", ["diff --git a/x b/x", "--- /dev/null", "+++ b/x\t", "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("x"))
    add("a deleted file label keeps its tab", ["diff --git a/a b.txt b/a b.txt", "--- a/a b.txt\t", "+++ /dev/null",
                                               "@@ -1 +0,0 @@", "-" + SECRET])
    add("a /dev/null label with a tab is a path", ["diff --git a/x b/x", "--- /dev/null\t", "+++ /dev/null\t",
                                                    "@@ -1 +0,0 @@", "-" + SECRET])
    add("a quoted label keeps its quotes", ['diff --git "a/q\\tx.txt" "b/q\\tx.txt"', '--- "a/q\\tx.txt"',
                                            '+++ "b/q\\tx.txt"', "@@ -1 +1 @@", "+" + SECRET])
    add("a quoted label with a space and a tab", ['diff --git "a/q x\\ty.txt" "b/q x\\ty.txt"', '--- /dev/null',
                                                  '+++ "b/q x\\ty.txt"\t', "@@ -0,0 +1 @@", "+" + SECRET])
    add("a quoted unicode label", ['diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"', "--- /dev/null",
                                   '+++ "b/caf\\303\\251.txt"', "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("caf*"))
    add("a quoted pure rename has no path", ['diff --git "a/q\\tx.txt" "b/q\\ty.txt"', "similarity index 100%",
                                              'rename from "q\\tx.txt"', 'rename to "q\\ty.txt"',
                                              "@@ -1 +1 @@", "+" + SECRET])
    add("a quoted diff line then plain labels", ['diff --git "a/q\\tx" "b/q\\tx"', "--- a/z.txt", "+++ b/z.txt",
                                                  "@@ -1 +1 @@", "+" + SECRET])
    add("a rename with a plain b side", ["diff --git a/o.txt b/n.txt", "similarity index 90%", "rename from o.txt",
                                         "rename to n.txt", "@@ -1 +1 @@", "+" + SECRET])
    add("a rename into an allowlisted path", ["diff --git a/o.txt b/node_modules/n.txt", "@@ -1 +1 @@", "+" + SECRET])
    add("a header with ' b/' inside the name", file_diff("a/x b/y", "b/x b/y",
                                                         head="diff --git a/x b/y b/x b/y"))
    add("a b side that is not a b/ path", ["diff --git a/x c/x", "--- a/x", "+++ c/x", "@@ -1 +1 @@", "+" + SECRET])
    add("a label with no prefix", ["diff --git a/x b/x", "--- x", "+++ y/z.txt", "@@ -1 +1 @@", "+" + SECRET])
    add("a label of just a prefix", ["diff --git a/x b/x", "--- a/", "+++ b/", "@@ -1 +1 @@", "+" + SECRET])
    add("an empty label", ["diff --git a/x b/x", "--- ", "+++ ", "@@ -1 +1 @@", "+" + SECRET])
    add("a label short of its marker", ["diff --git a/x b/x", "---", "+++", "@@ -1 +1 @@", "+" + SECRET])
    add("a diff --git line with no b side", ["diff --git a/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+" + SECRET])
    add("an unparsable diff --git line then no labels", ["diff --git nonsense", "@@ -1 +1 @@", "+" + SECRET])
    add("a diff --gitX line is still a header opener", ["diff --gitX a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                        "+" + SECRET])
    add("a leading space before diff --git is content", [" diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                         "+" + SECRET])
    add("an @@ closes the header", ["diff --git a/x b/x", "--- a/x", "@@ -1 +1 @@", "+++ b/evil", "+" + SECRET])
    add("a hunk line that looks like a header", ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                 "-" + SECRET, "--- a/evil", "+++ b/evil", "+" + SECRET])
    add("an index line stays inside the header", ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x",
                                                  "@@ -1 +1 @@", "+" + SECRET])
    add("a new-file mode line before the labels", ["diff --git a/x b/x", "new file mode 100644", "index 0..1",
                                                   "--- /dev/null", "+++ b/x", "@@ -0,0 +1 @@", "+" + SECRET])
    add("two files", file_diff("a/x", "b/x") + file_diff("a/y z", "b/y z\t", head="diff --git a/y z b/y z"))
    add("a path after /dev/null on both sides", ["diff --git a/x b/x", "--- /dev/null", "+++ /dev/null", "@@ -1 +0,0 @@",
                                                 "+" + SECRET])
    add("an allowlisted tabbed path", ["diff --git a/node_modules/a b.js b/node_modules/a b.js", "--- /dev/null",
                                       "+++ b/node_modules/a b.js\t", "@@ -0,0 +1 @@", "+" + SECRET])
    add("a path that matches the allowlist only without the tab", ["diff --git a/dist b/dist", "--- /dev/null",
                                                                    "+++ b/policy/denylist/patterns.yml\t",
                                                                    "@@ -0,0 +1 @@", "+" + SECRET])
    add("the exempt wildcard covers a literal U+2028 name",
        ["diff --git a/a b.txt b/a b.txt", "--- /dev/null", "+++ b/a b.txt", "@@ -0,0 +1 @@",
         "+" + SECRET], exemptions=exempt("a*"))
    add("a literal U+2028 in the diff --git line is name content", ["diff --git a/a b.txt b/a b.txt", "--- /dev/null",
                                                        "+++ b/a b.txt", "@@ -0,0 +1 @@", "+" + SECRET])
    add("a literal U+2028 in a rename header", ["diff --git a/o.txt b/a b.txt", "similarity index 90%",
                                                "@@ -1 +1 @@", "+" + SECRET])
    add("a literal U+0085 in a name", ["diff --git a/a\u0085b.txt b/a\u0085b.txt", "--- /dev/null",
                                       "+++ b/a\u0085b.txt", "@@ -0,0 +1 @@", "+" + SECRET])
    add("a literal U+2029 in a name", ["diff --git a/a b.txt b/a b.txt", "--- /dev/null",
                                       "+++ b/a b.txt", "@@ -0,0 +1 @@", "+" + SECRET])
    add("a literal form feed, vertical tab and FS in names",
        ["diff --git a/a\x0cb a/b\x0bc", "--- /dev/null", "+++ b/a\x1cb.txt", "@@ -0,0 +1 @@", "+" + SECRET])
    add("a bare CR stays inside a header line", ["diff --git a/x\rb b/x\rb", "--- /dev/null", "+++ b/x\rb", "@@ -0,0 +1 @@",
                                      "+" + SECRET])
    add("CRLF line endings", ["diff --git a/x b/x\r", "--- /dev/null\r", "+++ b/x\r", "@@ -0,0 +1 @@\r", "+" + SECRET + "\r"])
    add("CRLF with a spaced tabbed label", ["diff --git a/a b b/a b\r", "--- /dev/null\r", "+++ b/a b\t\r",
                                           "@@ -0,0 +1 @@\r", "+" + SECRET + "\r"])
    add("a trailing U+2028 stays inside its line", ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                           "+one ", "+" + SECRET])
    add("a U+2028 inside a hunk line is content, one line", ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                         "+one\u2028two", "+" + SECRET])
    add("a U+0085 inside a hunk line is content, one line",
        ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+one\u0085two", "+" + SECRET])
    add("a U+2028 in a hunk line cannot open a hunk", ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                       "+one @@ -1 +1 @@", "+" + SECRET])
    add("a hunk line with a label-like tail", ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@",
                                                     "-x +++ b/evil", "+" + SECRET])
    add("U+0085 and FS inside hunk content stay on one line", ["diff --git a/x b/x", "--- a/x", "+++ b/x",
                                                                  "@@ -1 +1 @@", "+a\u0085b\x1cc", "+" + SECRET])
    add("a U+2028 mid-label stays inside the header line", ["diff --git a/x b/x", "--- a/x +++ b/evil", "+++ b/x",
                                                           "@@ -1 +1 @@", "+" + SECRET])
    add("a NUL byte in the name", ["diff --git a/a\x00b b/a\x00b", "--- /dev/null", "+++ b/a\x00b", "@@ -0,0 +1 @@",
                                   "+" + SECRET])
    add("an astral character in a literal name", ["diff --git a/\U0001f600.txt b/\U0001f600.txt", "--- /dev/null",
                                                  "+++ b/\U0001f600.txt", "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("*.txt"))
    add("an astral and a lone surrogate-free emoji path rule", ["diff --git a/\U0001f600 b/\U0001f600", "--- /dev/null",
                                                                "+++ b/\U0001f600", "@@ -0,0 +1 @@", "+" + SECRET],
        exemptions=exempt("**"))
    add("an empty diff", [], end="")
    add("only a newline", [""], end="")
    add("no header at all", ["+" + SECRET, "-" + SECRET])


def run_case(case: dict) -> dict:
    blob = case["exemptions"]

    def fake_git(*args, check=True, cwd=None, env=None):
        if args[0] == "show":
            return CORPUS.strip()
        if args[:2] == ("cat-file", "-s"):
            return "" if blob is None else str(len(blob.encode()))
        if args[:2] == ("cat-file", "blob"):
            return blob
        raise AssertionError(args)

    out: dict = {}
    with tempfile.TemporaryDirectory(prefix="review-scan-") as tmp:
        artifact = Path(tmp) / "secret-scan.json"
        try:
            with mock.patch.object(crq, "git", fake_git), mock.patch.object(crq.shutil, "which", lambda _n: None):
                exemptions, error = crq.load_scan_exemptions("base" if blob is not None else None, None)
                ok, scan = crq.secret_scan_diff(case["diff"], artifact, base="base", head="head",
                                                exemptions=exemptions, exemption_error=error)
            out["ok"] = ok
            out["artifact"] = artifact.read_text(encoding="utf-8")
            out["error"] = None
        except BaseException as exc:  # noqa: BLE001 - the class is the datum
            out["error"] = type(exc).__name__
    return out


def build() -> dict:
    build_cases()
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names)), "duplicate case names"
    return {"schema": SCHEMA, "cases": [{**c, "expected": run_case(c)} for c in CASES]}


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
        print("review-scan fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
