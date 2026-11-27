#!/usr/bin/env python3
"""Deterministic offline oracle for the file-backed ``harvest_review`` effects.

Test tooling only. It runs the PRODUCTION ``crq.findings_md`` (``crq.py:816``) with
the ``write_text`` that ``harvest_review`` wraps it in (``crq.py:2713``),
``crq.current_document`` (``crq.py:1288``) feeding
``review_receipt.write_receipt`` (``crq.py:2744``), and ``crq._request_pr_review``
(``crq.py:2486``) over a throwaway run directory, and records, per scenario, the
value, the exception class that escaped, and the bytes left on disk.

Run-directory artifacts are given as hex so non-UTF-8 and lone-surrogate input
is exact. Paths start with ``/T``; the oracle substitutes its temporary directory
and substitutes it back in every recorded value, so the fixture is host independent.
Nothing outside the temporary directory is read or written.

Regenerate with ``python3.14 harvest_review_effects_vectors.py --write`` and
verify with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
from pathlib import Path

# The literal artifact name beside its hex trips gitleaks' generic-api-key rule; scenarios use an alias.
ALIASES = {"@scan": "secret-scan.json"}

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crq  # noqa: E402
import review_receipt  # noqa: E402

FIXTURE = HERE / "fixtures" / "crq-harvest-review-effects" / "cases.json"
SCHEMA = "cq.crq-harvest-review-effects-vector/v1"

META = {"run_id": "r-1", "item_id": "it-1", "label": "open PR 7", "base": "b" * 40, "head": "h" * 40,
        "started_at": "2026-11-27T00:00:00Z", "worktree": "/T/wt", "wt_branch": "crq/r-1"}
CLS = {"outcome": "completed", "findings": 2, "severity_counts": {"major": 1, "minor": 1}, "counted": True}
ITEM = {"id": "it-1", "request_id": "req-1", "pr": 7, "subject": {"kind": "open", "pr": 7},
        "capture": {"head": "h" * 40}}


def chunked(hex_text: str) -> str:
    """Hex in 24-digit groups: a long contiguous run is decoded by gitleaks, which then reads the
    receipt's artifact name beside its digest as a key assignment. Readers drop the spaces."""
    return " ".join(hex_text[i:i + 24] for i in range(0, len(hex_text), 24))


def hexs(text: str) -> str:
    return text.encode("utf-8", "surrogatepass").hex()


def finding(**over) -> str:
    base = {"type": "finding", "severity": "major", "fileName": "a.ts", "comment": "fix it"}
    base.update(over)
    return json.dumps(base)


def stream(*lines: str) -> str:
    return hexs("\n".join(lines) + "\n")


SCENARIOS: list[dict] = []


def scenario(name, op, *, item=None, meta=None, cls=None, files=None, dirs=None, outcome="completed",
             pre=None):
    SCENARIOS.append({"name": name, "op": op, "item": copy.deepcopy(ITEM if item is None else item),
                      "meta": copy.deepcopy(META if meta is None else meta),
                      "cls": copy.deepcopy(CLS if cls is None else cls), "files": files or {},
                      "dirs": dirs or [], "outcome": outcome, "pre": pre})


def build_scenarios() -> None:
    two = {"review.ndjson": stream(finding(), finding(severity="minor", fileName="b.ts", comment="  pad  "))}
    for op in ("findings", "document", "request"):
        scenario(f"{op}: two findings", op, files=two)
    # --- findings.md ---------------------------------------------------------------------
    scenario("findings: no stream file", "findings")
    scenario("findings: empty stream", "findings", files={"review.ndjson": ""})
    scenario("findings: non-finding and non-object lines are skipped", "findings", files={
        "review.ndjson": stream("[]", "7", "null", '"str"', "{not json", json.dumps({"type": "other"}),
                                json.dumps({"type": "finding"}), finding(comment="kept"))})
    scenario("findings: codegenInstructions wins, falls back to comment, then empty", "findings", files={
        "review.ndjson": stream(finding(codegenInstructions="gen"), finding(codegenInstructions=""),
                                finding(codegenInstructions=None, comment=None), finding(comment=0),
                                finding(comment=["a", 1]), finding(comment={"k": 1.50}))})
    scenario("findings: text is stripped and cut at 4000 code points", "findings", files={
        "review.ndjson": stream(finding(comment="\n  " + "x" * 4100 + "  \n"),
                                finding(comment="é" * 4001), finding(comment="\U0001f600" * 4001))})
    scenario("findings: absent severity and fileName print None", "findings", files={
        "review.ndjson": stream(json.dumps({"type": "finding", "comment": "c"}),
                                json.dumps({"type": "finding", "severity": 3, "fileName": 1.0, "comment": "d"}))})
    scenario("findings: splitlines separators and universal newlines", "findings", files={
        "review.ndjson": hexs(finding(comment="one") + "\r\n" + finding(comment="two") + "\r" +
                              finding(comment="three") + "\x0b" + finding(comment="four") + "\x0c" +
                              finding(comment="five") + "\x1c" + finding(comment="six") + "\x85" +
                              finding(comment="seven") + " " + finding(comment="eight") + " " +
                              finding(comment="nine"))})
    scenario("findings: a raw separator inside a string splits the record", "findings", files={
        "review.ndjson": hexs('{"type":"finding","comment":"a b"}\n')})
    scenario("findings: non-UTF-8 bytes are replaced", "findings", files={
        "review.ndjson": hexs('{"type":"finding","comment":"x').__add__("ff") + hexs('y"}\n')})
    scenario("findings: truncated and surrogate-encoded UTF-8", "findings", files={
        "review.ndjson": hexs('{"type":"finding","comment":"') + "f09f" + "eda080" + "c0af" + "e282" +
                         hexs('"}\n')})
    scenario("findings: a lone-surrogate escape cannot be written", "findings", files={
        "review.ndjson": stream(finding(comment="\ud800"))})
    scenario("findings: duplicate keys keep the last", "findings", files={
        "review.ndjson": hexs('{"type":"finding","comment":"first","comment":"last"}\n')})
    scenario("findings: NaN and big numbers in a comment", "findings", files={
        "review.ndjson": hexs('{"type":"finding","comment":[NaN,Infinity,-Infinity,1e400,12345678901234567890]}\n')})
    scenario("findings: a directory where the stream should be", "findings", dirs=["review.ndjson"])
    scenario("findings: a directory where findings.md should be", "findings", files=two, dirs=["findings.md"])
    scenario("findings: severity_counts print as json.dumps", "findings",
             cls={**CLS, "severity_counts": {"b": 1, "a": {"x": [1, 2.5, None, True]}, "é": "é"}})
    scenario("findings: counted prints as Python", "findings", cls={**CLS, "counted": False})
    scenario("findings: counted non-bool prints repr-free str", "findings", cls={**CLS, "counted": None})
    for key in ("item_id", "label", "run_id", "base", "head"):
        scenario(f"findings: meta without {key} is a KeyError", "findings",
                 meta={k: v for k, v in META.items() if k != key})
    for key in ("outcome", "severity_counts", "counted"):
        scenario(f"findings: cls without {key} is a KeyError", "findings",
                 cls={k: v for k, v in CLS.items() if k != key})
    scenario("findings: numeric meta values print as str", "findings",
             meta={**META, "item_id": 5, "label": 1.0, "base": None, "head": True})
    # --- current_document + write_receipt ------------------------------------------------
    full = {"meta.json": hexs(json.dumps(META)), "exit.json": hexs('{"exit": 0}'),
            "@scan": hexs("{}"), **two}
    scenario("document: every artifact present is hashed", "document", files=full)
    scenario("document: no artifacts", "document")
    scenario("document: stream only, order independent of file creation", "document", files=two)
    scenario("document: a missing request_id is None", "document", files=two,
             item={k: v for k, v in ITEM.items() if k != "request_id"})
    scenario("document: a null request_id stays None", "document", files=two, item={**ITEM, "request_id": None})
    scenario("document: a non-string request_id is kept", "document", files=two, item={**ITEM, "request_id": 12})
    for key in ("id", "subject", "capture"):
        scenario(f"document: item without {key} is a KeyError", "document", files=two,
                 item={k: v for k, v in ITEM.items() if k != key})
    scenario("document: a missing capture is checked after the stream is read", "document",
             dirs=["exit.json"], item={k: v for k, v in ITEM.items() if k != "capture"})
    scenario("document: a directory artifact is an IsADirectoryError", "document", dirs=["exit.json"])
    scenario("document: cls without counted is a KeyError", "document", files=two,
             cls={k: v for k, v in CLS.items() if k != "counted"})
    scenario("document: empty cls is falsy, counted False", "document", files=two, cls={})
    scenario("document: counted truthiness (0.0, empty list, nonzero string)", "document", files=two,
             cls={**CLS, "counted": 0.0})
    scenario("document: counted a non-empty string is True", "document", files=two, cls={**CLS, "counted": "no"})
    scenario("document: meta without run_id or started_at is None", "document", files=two,
             meta={"item_id": "it-1"})
    scenario("document: another outcome string", "document", files=two, outcome="failed-transient")
    scenario("document: findings keep every field, NaN and big ints", "document", files={
        "review.ndjson": hexs('{"type":"finding","a":NaN,"b":[1.0,-0.0,1e22,12345678901234567890],"c":"\\u00e9\\ud83d\\ude00"}\n')})
    scenario("document: duplicate keys and key order", "document", files={
        "review.ndjson": hexs('{"z":1,"type":"finding","a":1,"z":2}\n')})
    scenario("document: a lone-surrogate escape canonicalises as an escape", "document", files={
        "review.ndjson": stream(finding(comment="\ud800"))})
    scenario("document: non-UTF-8 stream bytes become U+FFFD in findings", "document", files={
        "review.ndjson": hexs('{"type":"finding","comment":"x') + "ff" + hexs('"}\n')})
    scenario("document: splitlines separators between findings", "document", files={
        "review.ndjson": hexs(finding(comment="a") + " " + finding(comment="b") + "\x85" + finding(comment="c"))})
    scenario("document: non-ASCII subject is escaped in the canonical bytes", "document", files=two,
             item={**ITEM, "subject": {"kind": "open", "note": "é\U0001f600"}})
    bom = "efbbbf"
    scenario("document: a BOM keeps the first line from parsing", "document", files={
        "review.ndjson": bom + stream(finding(comment="a"), finding(comment="b"))})
    scenario("document: a BOM then a newline leaves the next line", "document", files={
        "review.ndjson": bom + stream("", finding(comment="b"))})
    scenario("findings: a BOM keeps the first line from parsing", "findings", files={
        "review.ndjson": bom + stream(finding(comment="a"), finding(comment="b"))})
    for label, value in (("a string", "x"), ("a number", 5), ("a list", [1])):
        scenario(f"document: a truthy non-dict meta ({label}) is an AttributeError", "document", files=two, meta=value)
    for label, value in (("empty string", ""), ("zero", 0), ("empty list", [])):
        scenario(f"document: a falsy non-dict meta ({label}) reads as empty", "document", files=two, meta=value)
    scenario("document: receipt written twice is idempotent", "document", files=two, pre="receipt")
    scenario("document: a tampered receipt of the same id is refused", "document", files=two, pre="tamper")
    # --- _request_pr_review --------------------------------------------------------------
    scenario("request: a fresh item", "request", files=two)
    scenario("request: supersedes older debt", "request", files=two, item={
        **ITEM, "pr_review_request": {"run_id": "old"}, "pr_review_pending": False, "pr_review_attempts": 3,
        "issue_pending": True, "pr_review": {"x": 1}, "pr_review_error": "e", "tail": 1})
    scenario("request: falsy issue_pending is left as is", "request", files=two,
             item={**ITEM, "issue_pending": 0})
    scenario("request: truthy non-bool issue_pending becomes False", "request", files=two,
             item={**ITEM, "issue_pending": "yes"})
    scenario("request: key order of an existing key is kept", "request", files=two,
             item={"pr_review_pending": 1, "id": "it-1", "pr_review_request": 5, "pr": 7})
    scenario("request: item without pr is a KeyError and mutates nothing", "request", files=two,
             item={"id": "it-1", "issue_pending": True})
    scenario("request: meta without base is a KeyError and mutates nothing", "request", files=two,
             meta={k: v for k, v in META.items() if k != "base"}, item={**ITEM, "issue_pending": True})
    scenario("request: meta without head is a KeyError", "request", files=two,
             meta={k: v for k, v in META.items() if k != "head"})
    scenario("request: cls without severity_counts is a KeyError", "request", files=two,
             cls={k: v for k, v in CLS.items() if k != "severity_counts"})
    scenario("request: numeric pr and nested counts are kept as given", "request", files=two,
             item={**ITEM, "pr": 7.0}, cls={**CLS, "severity_counts": {"a": 1.0, "b": [None]}})
    scenario("request: head and base need not be strings", "request", files=two,
             meta={**META, "base": None, "head": 5})


def _sub(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "/T")
    if isinstance(value, list):
        return [_sub(v, tmp) for v in value]
    if isinstance(value, dict):
        return {_sub(k, tmp): _sub(v, tmp) for k, v in value.items()}
    return value


def _bytes_of(path: Path):
    if not path.exists():
        return None
    return "<dir>" if path.is_dir() else path.read_bytes().hex()


def _run(spec: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="harvest-effects-") as tmp:
        root = Path(tmp)
        rdir = root / "runs" / "r-1"
        rdir.mkdir(parents=True)
        for name, data in spec["files"].items():
            name = ALIASES.get(name, name)
            (rdir / name).write_bytes(bytes.fromhex(data))
        for name in spec["dirs"]:
            (rdir / name).mkdir()
        receipts = root / "receipts"
        item, meta, cls = (copy.deepcopy(spec[k]) for k in ("item", "meta", "cls"))
        out: dict = {}
        try:
            if spec["op"] == "findings":
                (rdir / "findings.md").write_text(crq.findings_md(rdir / "review.ndjson", meta, cls))
            elif spec["op"] == "document":
                doc = crq.current_document(item, spec["outcome"], meta=meta, cls=cls, rdir=rdir)
                out["canonical"] = chunked(review_receipt.canonical(doc).hex())
                if spec["pre"] == "tamper":
                    receipts.mkdir()
                    (receipts / (review_receipt.digest(doc) + ".json")).write_bytes(b"tampered")
                receipt_id = review_receipt.write_receipt(receipts, doc)
                if spec["pre"] == "receipt":
                    receipt_id = review_receipt.write_receipt(receipts, doc)
                out["receipt_id"] = receipt_id
            else:
                crq._request_pr_review(item, "r-1", meta, rdir, cls)
            out["error"] = None
        except BaseException as exc:  # noqa: BLE001 - the class is the datum
            out["error"] = type(exc).__name__
            if isinstance(exc, KeyError):
                out["key"] = exc.args[0]
        if spec["op"] == "findings":
            out["findings_md"] = _bytes_of(rdir / "findings.md")
        if spec["op"] == "document":
            out["receipts"] = sorted(p.name + ":" + chunked(_bytes_of(p)) for p in receipts.iterdir()) if receipts.exists() else []
        if spec["op"] == "request":
            out["item"] = item
            out["item_keys"] = list(item)
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
        print("harvest-review-effects fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
