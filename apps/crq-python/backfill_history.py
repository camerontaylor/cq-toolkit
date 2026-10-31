"""Conservative, idempotent history accounting with retained source bytes.

Source collectors pass authenticated transport envelopes, not prose judgements.
All four classes get an import result even when artifacts establish no scope.
No provider review is launched to fill historical evidence gaps.
"""
import copy
import hashlib
import json
import math
import subprocess

import review_ledger as ledger
from backfill_accounting import ranges

REVIEWER_FORMATS = {"0.8.2": "coderabbit-agent-0.8.2", "0.9.2": "coderabbit-agent-0.9.2"}

CLASSES = ("crq-counted-cycle", "merged-current-receipt", "promotion-range", "github-app-review")


def vendor_events(raw):
    """Parse vendor envelopes while keeping credit fields subject to ledger validation."""
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ledger.IntegrityError("duplicate vendor JSON key")
            result[key] = value
        return result
    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ledger.IntegrityError("non-finite vendor number")
        return parsed
    def refuse(value):
        raise ledger.IntegrityError("non-finite vendor number")
    result = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        value = json.loads(line, object_pairs_hook=pairs, parse_float=number, parse_constant=refuse)
        if not isinstance(value, dict):
            raise ledger.IntegrityError("vendor event must be an object")
        result.append(value)
    return result


def terminal_scope(raw, expected_head):
    """Only explicit, terminal path/blob/interval evidence is scoped completion."""
    events = vendor_events(raw)
    if not events or any(e.get("type") in ("error", "action_required") for e in events):
        raise ledger.IntegrityError("error or missing terminal evidence")
    complete = events[-1]
    if complete.get("type") != "complete" or complete.get("status") != "review_completed":
        raise ledger.IntegrityError("terminal non-skipped completion absent")
    if complete.get("head") != expected_head:
        raise ledger.IntegrityError("terminal evidence binds wrong/unknown reviewed head")
    files = complete.get("reviewedFiles")
    if not isinstance(files, list) or not files:
        raise ledger.IntegrityError("reviewed scope absent")
    rows = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "blob", "intervals"}:
            raise ledger.IntegrityError("path-only receipts cannot infer full-file scope")
        rows.append(item)
    ledger.canonical(rows)  # Credit-bearing fields remain in the strict ledger domain.
    ledger.scope(rows)
    return rows


def submitted_scope(repo, base, head):
    """Describe only head-side hunks in the immutable submitted diff."""
    entries = repo.entries(head)
    return [{"path": name, "blob": entries[name]["blob"], "intervals": ranges(lines)}
            for name, lines in sorted(repo.changed_intervals(base, head).items()) if lines and name in entries]


def adapted_terminal_scope(repo, raw, item, meta, proof):
    """Known CLI formats: vendor-confirmed hunks, never requested whole files."""
    version = proof.get("cli_version")
    if not isinstance(version, str) or version not in REVIEWER_FORMATS or proof.get("format") != REVIEWER_FORMATS[version]:
        raise ledger.IntegrityError("unknown reviewer version/output format")
    for key, expected in (("run_id", meta["run_id"]), ("head", item["head"]), ("base", item["base"]),
                          ("attempt_id", item["attempt_id"])):
        if proof.get(key) != expected:
            raise ledger.IntegrityError("submission identity mismatch")
    if meta.get("head") != item["head"] or meta.get("base") != item["base"]:
        raise ledger.IntegrityError("run metadata subject mismatch")
    submitted = submitted_scope(repo, item["base"], item["head"])
    if proof.get("submitted_scope") != submitted:
        raise ledger.IntegrityError("submitted diff scope mismatch")
    events = vendor_events(raw)
    if not events or any(e.get("type") in ("error", "action_required") for e in events):
        raise ledger.IntegrityError("vendor error or missing terminal")
    terminal = events[-1]
    if terminal.get("type") != "complete" or terminal.get("status") != "review_completed" or terminal.get("outcome") != "completed":
        raise ledger.IntegrityError("unknown or incomplete vendor output")
    contexts = [e for e in events if e.get("type") == "review_context"]
    if len(contexts) != 1 or contexts[0].get("baseCommit") != item["base"]:
        raise ledger.IntegrityError("vendor context does not bind submitted base")
    names = terminal.get("reviewedFiles")
    if not isinstance(names, list) or not names or any(not isinstance(n, str) for n in names) or len(names) != len(set(names)):
        raise ledger.IntegrityError("unknown reviewedFiles format")
    submitted_paths = {name.decode("utf-8") for name in repo.git("diff", "--name-only", "--no-renames", "-z", item["base"], item["head"]).split(b"\0") if name}
    if set(names) - submitted_paths:
        raise ledger.IntegrityError("vendor listed unsubmitted path")
    return [row for row in submitted if row["path"] in names]


def import_source(repo, store, source_class, source_id, raw, envelope, at, existing):
    if source_class not in CLASSES:
        raise ledger.IntegrityError("unsupported history source class")
    source_digest = hashlib.sha256(raw).hexdigest()
    reference = store.put(raw)
    proof = store.put(ledger.canonical(envelope))
    producer = "coderabbitai[bot]" if source_class == "github-app-review" else "crq-runner-app"
    source = {"repo": ledger.REPO, "producer": producer,
              "type": "github-review" if source_class == "github-app-review" else "crq-run",
              "id": source_id, "authenticated": bool(envelope.get("authenticated"))}
    result_key = "import:" + source_class + ":" + source_id + ":" + source_digest
    previous = next((v for v in existing if v["source_key"] == result_key), None)
    if previous:
        return [], previous
    review, outcome, reason, duplicate = None, "unverified", "explicit reviewed scope unavailable", None
    try:
        if envelope.get("author_cycle") or envelope.get("source_type") == "author-cli":
            outcome = "rejected"
            raise ledger.IntegrityError("author CLI cycles never earn coverage")
        if not envelope.get("authenticated") or envelope.get("repo") != ledger.REPO or envelope.get("producer") != producer:
            outcome = "rejected"
            raise ledger.IntegrityError("producer/repository authentication absent or wrong")
        if envelope.get("exit_code") != 0:
            raise ledger.IntegrityError("successful terminal process exit not evidenced")
        p = copy.deepcopy(envelope.get("review_payload"))
        if not isinstance(p, dict):
            raise ledger.IntegrityError("retained source has no reconstructable scope manifest")
        if p.get("source", {}).get("type") == "author-cli":
            outcome = "rejected"
            raise ledger.IntegrityError("author CLI cycles never earn coverage")
        if source_class == "github-app-review":
            api = ledger.loads(raw)
            if (str(api.get("id")) != source_id or api.get("commit_id") != p["head"]
                    or (api.get("user") or {}).get("login") != producer
                    or (api.get("user") or {}).get("type") != "Bot"):
                outcome = "rejected"
                raise ledger.IntegrityError("GitHub review identity/head/producer mismatch")
            scope_proof = envelope.get("scope_artifact")
            if not scope_proof:
                raise ledger.IntegrityError("walkthrough text/review object alone cannot establish scope")
            store.verify(scope_proof)
            from pathlib import Path
            scopes = terminal_scope(Path(scope_proof["location"]).read_bytes(), p["head"])
            p["artifacts"].append(scope_proof)
        else:
            scopes = terminal_scope(raw, p["head"])
        if scopes != p["input_scope"]:
            raise ledger.IntegrityError("terminal scope differs from reconstructed input scope")
        p.update(source=source, outcome="completed")
        p["artifacts"] = [*p.get("artifacts", []), reference, proof]
        review = ledger.event("review", f"{ledger.REPO}:{producer}:{source_id}", envelope["completed_at"], p)
        repo.verify_review(review)
        other = next((v for v in existing if v["event_type"] == "review" and v["source_key"] == review["source_key"]), None)
        if other:
            # Receipt aliases may add import provenance, never a second review.
            a, b = copy.deepcopy(other["payload"]), copy.deepcopy(review["payload"])
            a.pop("artifacts"); b.pop("artifacts")
            if a != b:
                outcome = "rejected"
                raise ledger.IntegrityError("existing vendor source has conflicting evidence; reconcile")
            duplicate, review, outcome, reason = other["id"], None, "duplicate", "same stable vendor run already recorded"
        else:
            outcome, reason = "credited", "authenticated terminal completion with verified explicit intervals"
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        reason, review = str(exc), None
    disposition = ledger.event("import-result", result_key, at, {"source": source, "source_digest": source_digest,
                               "result": outcome, "reason": reason, "review_id": review["id"] if review else None,
                               "duplicate_id": duplicate, "artifacts": [reference, proof]})
    return ([review] if review else []) + [disposition], disposition


def import_catalog(repo, store, catalog, at, existing):
    """Catalog completion is per source class, with gaps explicitly retained."""
    events, report = list(existing), {kind: {"sources": 0, "results": {}} for kind in CLASSES}
    generated = []
    for source in sorted(catalog, key=lambda s: (s["class"], s["id"])):
        raw = source["raw"]
        new, result = import_source(repo, store, source["class"], source["id"], raw, source["envelope"], at, events)
        events.extend(new); generated.extend(new)
        row = report[source["class"]]; row["sources"] += 1
        outcome = result["payload"]["result"]
        row["results"][outcome] = row["results"].get(outcome, 0) + 1
    return generated, report


def collect_sources(queue, state, store, *, github=None):
    """Inventory all available source classes; absent acquisition stays explicit.

    github is a read-only paginated acquisition adapter returning authenticated
    API records. Local legacy path receipts are preserved as gaps until retained
    input artifacts can establish intervals. No commit-range credit is inferred.
    """
    from pathlib import Path
    import json
    state = Path(state)
    catalog = []
    def retain(kind, ident, raw, envelope):
        catalog.append({"class": kind, "id": ident, "raw_artifact": store.put(raw), "envelope": envelope})
    for item in sorted(queue.get("items", []), key=lambda i: i["id"]):
        for index, cycle in enumerate(item.get("cycles", []) + item.get("author_cycles", [])):
            run = str(cycle.get("run_id") or f"{item['id']}:cycle:{index}")
            kind = "promotion-range" if item.get("kind") == "promotion" else "crq-counted-cycle"
            raw = json.dumps({"item": item["id"], "kind": item["kind"], "cycle": cycle}, sort_keys=True).encode()
            envelope = {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app",
                        "author_cycle": item.get("kind") == "author", "exit_code": 0,
                        "completed_at": cycle.get("completed_at"), "source_metadata": store.put(raw)}
            rdir = state / "runs" / run
            if rdir.resolve().parent == (state / "runs").resolve() and (rdir / "review.ndjson").is_file():
                raw = (rdir / "review.ndjson").read_bytes()
                for name in ("meta.json", "exit.json", "secret-scan.json"):
                    if (rdir / name).is_file():
                        envelope[name] = store.put((rdir / name).read_bytes())
                # Modern retained event manifests can be validated directly.
                if (rdir / "review-event.json").is_file():
                    value = ledger.loads((rdir / "review-event.json").read_bytes())
                    ledger.validate(value)
                    envelope["review_payload"] = value["payload"]
            retain(kind, run, raw, envelope)
    for filename in sorted((state / "receipts").glob("*.json")):
        raw = filename.read_bytes()
        if hashlib.sha256(raw).hexdigest() != filename.stem:
            retain("merged-current-receipt", filename.stem, raw, {"authenticated": False, "reason": "receipt digest mismatch"})
            continue
        document = ledger.loads(raw)
        retain("merged-current-receipt", str(document.get("run_id") or filename.stem), raw,
               {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app", "exit_code": 0,
                "completed_at": document.get("started_at"), "receipt_digest": filename.stem})
    for record in (queue.get("promotion_audit") or {}).get("records", []):
        raw = json.dumps(record, sort_keys=True).encode()
        retain("promotion-range", "audit:" + hashlib.sha256(raw).hexdigest(), raw,
               {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app", "exit_code": 0,
                "completed_at": record.get("at"), "reason": "promotion membership is not reviewed scope"})
    acquisition = {"local_queue": store.put(json.dumps(queue, sort_keys=True).encode()),
                   "github": "not-acquired" if github is None else "acquired-paginated", "source_classes": list(CLASSES)}
    if github is not None:
        for source in github():
            raw, metadata = source["raw"], source["metadata"]
            api = ledger.loads(raw)
            retain("github-app-review", str(api["id"]), raw,
                   {"authenticated": True, "repo": ledger.REPO, "producer": "coderabbitai[bot]", "exit_code": 0,
                    "completed_at": api.get("submitted_at"), "transport": metadata})
    return {"sources": catalog, "acquisition": acquisition}


def github_sources(store):
    """Paginate merged PRs and app reviews; retain every fetched response page."""
    import json
    def fetch(endpoint):
        raw = subprocess.run(["gh", "api", "--paginate", "--slurp", endpoint], capture_output=True, check=True, timeout=300).stdout
        reference = store.put(raw)
        pages = json.loads(raw)
        if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
            raise ledger.IntegrityError("incomplete paginated GitHub source response")
        return [row for page in pages for row in page], reference
    prs, pr_pages = fetch(f"repos/{ledger.REPO}/pulls?state=closed&per_page=100")
    for pr in sorted((p for p in prs if p.get("merged_at")), key=lambda p: p["number"]):
        reviews, review_pages = fetch(f"repos/{ledger.REPO}/pulls/{pr['number']}/reviews?per_page=100")
        for review in reviews:
            if (review.get("user") or {}).get("login") == "coderabbitai[bot]":
                yield {"raw": json.dumps(review, sort_keys=True).encode(),
                       "metadata": {"pr": pr["number"], "pr_pages": pr_pages, "review_pages": review_pages}}
