"""Conservative, idempotent history accounting with retained source bytes.

Source collectors pass authenticated transport envelopes, not prose judgements.
All three classes get an import result even when artifacts establish no scope.
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

CLASSES = ("crq-counted-cycle", "merged-current-receipt", "github-app-review",
           "github-agent-review")
# Collection stopped with the promotion retirement, but catalogs saved before
# that change must still import: keep their rows as explicit unverified results.
RETIRED_CLASSES = ("promotion-range",)


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


def finding_intervals(value):
    """Normalize explicit or CodeRabbit line anchors; invalid anchors stay unverified."""
    lines = set()
    try:
        vendor_intervals = value.get("intervals")
        if "intervals" not in value:
            start, end = value.get("startLine"), value.get("endLine")
            for key in ("startLine", "endLine"):
                if key in value and (type(value[key]) is not int or not 1 <= value[key] <= 1_000_000):
                    raise ValueError("invalid vendor endpoint")
            start, end = start or end, end or start
            vendor_intervals = [[min(start, end), max(start, end)]] if start and end else []
        for start, end in vendor_intervals or []:
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= 1_000_000:
                raise ValueError("invalid vendor interval")
            lines.update(range(start, end + 1))
            if len(lines) > 1_000_000:
                raise ValueError("vendor interval bound")
        intervals = ranges(lines)
    except (TypeError, ValueError):
        intervals = []
    return intervals


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
    if source_class not in CLASSES and source_class not in RETIRED_CLASSES:
        raise ledger.IntegrityError("unsupported history source class")
    source_digest = hashlib.sha256(raw).hexdigest()
    reference = store.put(raw)
    proof = store.put(ledger.canonical(envelope))
    if source_class == "github-agent-review":
        # Human/agent GitHub reviews collect through the S3b record path: the
        # fetched review normalizes to an uncredited report record (never a
        # vendor run), so the import carries the report artifact reference. A
        # review whose bytes cannot normalize stays an explicit unverified gap.
        import review_record
        result_key = "import:" + source_class + ":" + source_id + ":" + source_digest
        previous = next((v for v in existing if v["source_key"] == result_key), None)
        if previous:
            return [], previous
        review = None
        retained = None
        reason = "github review collected as uncredited report"
        try:
            submitted = review_record.normalize_github_review(
                envelope["review"], owner_repo=envelope.get("owner_repo") or ledger.REPO,
                pr=envelope.get("pr"), at=at)
            submitted["report_bytes"] = raw
            review, _ = review_record.normalize_record(submitted, at)
            # An interrupted import may have spooled the review but not its
            # disposition; the retained outbox passed as `existing` still
            # holds the review under its source_key. Reuse it unchanged (no
            # rehash, no artifact replacement) so a retry at a later
            # timestamp cannot mint a colliding second review.
            retained = next((v for v in existing
                             if v["event_type"] == "review" and v["source_key"] == review["source_key"]), None)
            if retained:
                review = None
                reason = "github review already recorded as uncredited report"
            else:
                # The placeholder reference (imported-report:<digest>) has no
                # durable backing; the collector's store reference is the retained
                # artifact the outbox can verify, so it replaces the placeholder.
                review["payload"]["artifacts"] = [dict(reference, kind="report")]
                review["id"] = ledger.digest({k: v for k, v in review.items() if k != "id"})
                ledger.validate(review)
        except (review_record.RecordRefused, ledger.IntegrityError) as exc:
            reason = "github review normalization refused: " + str(exc)
        disposition = ledger.event("import-result", result_key, at, {
            "source": {"repo": ledger.REPO, "producer": "github-agent-review",
                       "type": "manual", "id": source_id,
                       "authenticated": False},
            "source_digest": source_digest,
            "result": "unverified", "reason": reason,
            "review_id": review["id"] if review else (retained["id"] if retained else None),
            "duplicate_id": None,
            "artifacts": [reference, proof]})
        return ([review] if review else []) + [disposition], disposition
    producer = "coderabbitai[bot]" if source_class == "github-app-review" else "crq-runner-app"
    source = {"repo": ledger.REPO, "producer": producer,
              "type": "github-review" if source_class == "github-app-review" else "crq-run",
              "id": source_id, "authenticated": bool(envelope.get("authenticated"))}
    result_key = "import:" + source_class + ":" + source_id + ":" + source_digest
    previous = next((v for v in existing if v["source_key"] == result_key), None)
    if previous:
        return [], previous
    if source_class in RETIRED_CLASSES:
        disposition = ledger.event("import-result", result_key, at, {
            "source": source, "source_digest": source_digest, "result": "unverified",
            "reason": "retired promotion source retained for catalog compatibility",
            "review_id": None, "duplicate_id": None, "artifacts": [reference, proof]})
        return [disposition], disposition
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
        row = report.setdefault(source["class"], {"sources": 0, "results": {}}); row["sources"] += 1
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
        if item.get("kind") == "promotion":
            continue  # Retired promotions remain on disk but are not review evidence.
        for index, cycle in enumerate(item.get("cycles", []) + item.get("author_cycles", [])):
            run = str(cycle.get("run_id") or f"{item['id']}:cycle:{index}")
            raw = json.dumps({"item": item["id"], "kind": item["kind"], "cycle": cycle}, sort_keys=True).encode()
            envelope = {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app",
                        "author_cycle": item.get("kind") == "author", "exit_code": None,
                        "completed_at": cycle.get("completed_at"), "source_metadata": store.put(raw)}
            rdir = state / "runs" / run
            if rdir.resolve().parent == (state / "runs").resolve() and (rdir / "review.ndjson").is_file():
                raw = (rdir / "review.ndjson").read_bytes()
                for name in ("meta.json", "exit.json", "secret-scan.json"):
                    if (rdir / name).is_file():
                        data = (rdir / name).read_bytes()
                        envelope[name] = store.put(data)
                        if name == "exit.json":
                            code = ledger.loads(data).get("exit")
                            if type(code) is int:
                                envelope["exit_code"] = code
                # Modern retained event manifests can be validated directly.
                if (rdir / "review-event.json").is_file():
                    value = ledger.loads((rdir / "review-event.json").read_bytes())
                    ledger.validate(value)
                    envelope["review_payload"] = value["payload"]
            retain("crq-counted-cycle", run, raw, envelope)
    for filename in sorted((state / "receipts").glob("*.json")):
        raw = filename.read_bytes()
        if hashlib.sha256(raw).hexdigest() != filename.stem:
            retain("merged-current-receipt", filename.stem, raw, {"authenticated": False, "reason": "receipt digest mismatch"})
            continue
        document = ledger.loads(raw)
        envelope = {"authenticated": True, "repo": ledger.REPO, "producer": "crq-runner-app", "exit_code": 0,
                    "completed_at": document.get("started_at"), "receipt_digest": filename.stem}
        retain("merged-current-receipt", str(document.get("run_id") or filename.stem), raw, envelope)
        # The historical adapter projects the receipt for unified-summary and
        # catalog consumers with its original digest; coverage is never claimed
        # as full branch coverage and the evidence is never relabeled.
        import review_record
        envelope["historical_view"] = review_record.historical_view({
            "event_type": "review", "id": filename.stem,
            "payload": {"source": {"producer": "crq-runner-app", "type": "crq-run"},
                        "head": document.get("head") or "0" * 40,
                        "base": document.get("base") or "0" * 40,
                        "outcome": "unverified",
                        "completion": {"scope_verified": False},
                        "provenance": None}})
    acquisition = {"local_queue": store.put(json.dumps(queue, sort_keys=True).encode()),
                   "github": "not-acquired" if github is None else "acquired-paginated", "source_classes": list(CLASSES)}
    if github is not None:
        for source in github():
            raw, metadata = source["raw"], source["metadata"]
            api = ledger.loads(raw)
            if source.get("class") == "github-agent-review":
                # S3b human/agent review: collected through the record path,
                # never a vendor credit. The envelope carries the
                # fetchReviewState-shaped projection of the same read.
                retain("github-agent-review", metadata["review"]["id"], raw, metadata)
                continue
            retain("github-app-review", str(api["id"]), raw,
                   {"authenticated": True, "repo": ledger.REPO, "producer": "coderabbitai[bot]", "exit_code": 0,
                    "completed_at": api.get("submitted_at"), "transport": metadata})
    return {"sources": catalog, "acquisition": acquisition}


def github_sources(store):
    """Paginate merged PRs and reviews; retain every fetched response page.

    Bot reviews (coderabbitai[bot]) collect as vendor evidence under the
    github-app-review class; human/agent reviews collect through the S3b
    github-agent-review class, normalizing to uncredited report records.
    """
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
            login = (review.get("user") or {}).get("login")
            raw = json.dumps(review, sort_keys=True).encode()
            metadata = {"pr": pr["number"], "pr_pages": pr_pages, "review_pages": review_pages}
            if login == "coderabbitai[bot]":
                yield {"raw": raw, "metadata": metadata}
            elif login:
                # fetchReviewState-shaped: the collector input vocabulary. The
                # raw bytes stay the report artifact; no poller, one read.
                yield {"raw": raw, "class": "github-agent-review",
                       "metadata": {**metadata, "review": {
                           "id": str(review.get("node_id") or review.get("id")),
                           "authorLogin": login,
                           "authorType": (review.get("user") or {}).get("type"),
                           "body": review.get("body") or "",
                           "state": review.get("state"),
                           "commitOid": review.get("commit_id"),
                           "submittedAt": review.get("submitted_at")},
                           "owner_repo": ledger.REPO, "pr": pr["number"]}}
