"""S3b collection: normalize external review observations into the shared ledger.

Import identity is ``(producer, source id, artifact digest)``. Repeated
ingestion of the same artifact is idempotent; a correction supersedes the
original record while retaining it; one malformed import is quarantined with a
readable reason and the original artifact reference and never blocks queue
scheduling. Manual/agent records are historical reports: incomplete scope
metadata stays unknown, full-branch coverage is never claimed, no findings are
synthesized, and no independent-acceptance verdict is issued. The wire op spools
through the publication worker's durable outbox (or the legacy local one when
no rollout is configured); there is no competing ledger and no new poller.
GitHub review comments arrive through the existing ``fetchReviewState`` reads
and reach the ledger through ``import_catalog`` (class ``github-agent-review``
for human/agent reviews, routed to ``record_submission`` below); historical
``author-cli``/``merged-current`` receipts project through ``historical_view``
with their original digests.
"""
import hashlib
import json
import re

import review_ledger as ledger

PROVENANCE_FORGE_EVIDENCE = "github-review-comment"
MAX_REPORT_BYTES = 256 * 1024
VERDICT_OUTCOMES = {"APPROVED": "completed", "CHANGES_REQUESTED": "completed",
                     "COMMENTED": "completed"}


class RecordRefused(ValueError):
    """A malformed import: quarantine this record only, with a readable reason."""


def _artifact(report_bytes, digest_hex):
    return {"sha256": digest_hex, "location": "imported-report:" + digest_hex,
            "kind": "report"}


def _scope_confidence(claimed_scope, report_bytes):
    """Scope confidence reflects the report's own metadata honestly.

    ``claimed`` only when the report carries claimed path/line anchors; a
    prose report with no scope metadata stays ``unknown`` (spec §12 keeps
    incomplete-scope coverage unknown). Bytes alone never claim scope.
    """
    if claimed_scope:
        return "claimed"
    return "unknown"


def _completion_evidence(submitted):
    verdict = submitted.get("verdict")
    if verdict is None:
        return None
    return json.dumps({"kind": "claimed-verdict", "verdict": verdict}, sort_keys=True)


def scope_verified(submitted):
    """True only when the submitter pinned a complete verified claimed scope.

    A report with claimed path/line anchors is still claimed, never vendor
    verified: this stays False for every import in this slice.
    """
    return False


def normalize_record(submitted, at):
    """Normalize one submitted manual/agent report into a ledger review event.

    ``submitted`` carries producer (``manual``/``agent``), source ``id``,
    raw ``report_bytes``, reviewer identity, optional head/base/subject
    metadata, an optional claimed scope, a verdict, the authenticated
    submitter and independence-relevant observations. Every field the report
    does not carry stays honestly unknown: empty scope rows, outcome
    ``unverified``, null completion evidence, and zero commit/tree/target
    placeholders that no consumer may read as a real subject. The record is
    never creditable and never claims vendor completion.
    """
    producer = submitted.get("producer")
    if producer not in ledger.REPORT_PRODUCERS:
        raise RecordRefused("record producer must be manual or agent")
    source_id = submitted.get("id")
    if not isinstance(source_id, str) or not source_id or len(source_id) > 200:
        raise RecordRefused("record source id is missing or oversized")
    report_bytes = submitted.get("report_bytes")
    if not isinstance(report_bytes, bytes) or not report_bytes:
        raise RecordRefused("record report bytes are missing")
    if len(report_bytes) > MAX_REPORT_BYTES:
        raise RecordRefused("report exceeds 256 KiB import bound")
    digest_hex = hashlib.sha256(report_bytes).hexdigest()
    submitter = submitted.get("authenticated_submitter")
    if not isinstance(submitter, str) or not submitter:
        raise RecordRefused("record requires the authenticated submitter")
    repo = submitted.get("repo") or ledger.REPO
    head = submitted.get("head")
    for key in ("head", "base"):
        value = submitted.get(key)
        if value is not None and (not isinstance(value, str)
                                  or re.fullmatch(r"[0-9a-f]{40,64}", value) is None):
            raise RecordRefused("record " + key + " identity is not a commit hash")
    claimed_scope = submitted.get("claimed_scope")
    if claimed_scope is not None and not isinstance(claimed_scope, list):
        raise RecordRefused("claimed scope must be a list of scope rows or absent")
    for row in claimed_scope or ():
        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
            raise RecordRefused("claimed scope rows need a path")
    outcome = VERDICT_OUTCOMES.get(submitted.get("verdict"), "unverified")
    completion = _completion_evidence(submitted)
    if outcome == "completed" and completion is None:
        raise RecordRefused("completed record requires completion evidence or unknown outcome")
    # A claimed verdict completes the report but never verifies scope; keep
    # outcome unverified unless scope was actually verified. This is the A-20
    # honest representation: an agent PASS is visible, not vendor completion,
    # and never a full-coverage claim.
    if outcome == "completed" and not scope_verified(submitted):
        outcome = "unverified"
    # The ledger payload has no free-text target field (target is a commit
    # hash); a branch-name target rides subject_id: <branch>@<source id>.
    scope_rows = claimed_scope or []
    target_name = submitted.get("target")
    branch_label = target_name if (isinstance(target_name, str)
                                   and re.fullmatch(r"[0-9a-f]{40,64}", target_name) is None) else None
    subject_id = ((branch_label + "@") if branch_label else "") + (submitted.get("subject_id") or source_id)
    target_commit = None if branch_label else target_name
    # The ledger identity rule requires source_key == repo:producer:id with
    # producer = source.producer. Import identity is (producer kind, source
    # id, report digest): the digest suffix inside source.id separates two
    # versions of one source in validate_sequence while identical bytes stay
    # one event, and the key uses the producer KIND (not the claimed
    # reviewer) so a changed reviewer is still the same import.
    versioned_id = source_id + ":" + digest_hex[:16]
    payload = {
        "repo": repo,
        "subject_id": subject_id,
        "job_id": "record:" + producer + ":" + source_id,
        "attempt_id": "record:" + digest_hex[:16],
        "source": {"repo": repo, "producer": producer,
                   "type": producer, "id": versioned_id, "authenticated": False},
        "provenance": {
            "authenticated_submitter": submitter,
            "claimed_reviewer": submitted.get("reviewer") or "unknown",
            "forge_evidence": submitted.get("forge_evidence") or "off-forge-import",
            "completion_evidence": completion,
            "scope_confidence": _scope_confidence(claimed_scope, report_bytes),
            "independence": submitted.get("independence") or None,
        },
        "base": submitted.get("base") or "0" * 40,
        "head": head or "0" * 40,
        "head_tree": submitted.get("head_tree") or "0" * 40,
        "target": target_commit or "0" * 40,
        "target_tree": submitted.get("target_tree") or "0" * 40,
        "policy_digest": ledger.digest({"unknown-policy": True}),
        "scope_digest": ledger.digest(scope_rows),
        "paths": [],
        "requested_scope": scope_rows,
        "input_scope": scope_rows,
        "reviewed_scope": [],
        "completion": {"terminal": outcome == "completed", "skipped": False,
                       "scope_verified": False,
                       "exit_code": 0 if outcome == "completed" else -1,
                       "errors": [] if outcome == "completed" else ["no verifiable completion evidence"]},
        "outcome": outcome,
        "artifacts": [_artifact(report_bytes, digest_hex)],
        "findings": [],
    }
    if submitted.get("supersedes") is not None:
        payload["supersedes"] = submitted["supersedes"]
    source_key = f"{repo}:{producer}:{versioned_id}"
    value = ledger.event("review", source_key, at, payload)
    return value, digest_hex


def import_record(submitted, at, existing):
    """Idempotent ingestion against retained ledger events.

    Returns ``(events, action)`` where action is ``duplicate:<id>`` when this
    exact artifact was already imported under the same producer/source id,
    ``record:<id>`` for a new evidence record, ``quarantined:<reason>`` for a
    malformed import, or ``refused:<reason>`` when the refusal itself cannot be
    represented. Corrections set ``supersedes`` to the original record id; the
    original report is retained unchanged.
    """
    try:
        value, digest_hex = normalize_record(submitted, at)
    except (RecordRefused, ledger.IntegrityError) as exc:
        # Wire-valid reports with semantically malformed content (reversed
        # scope intervals, schema-variant mismatches) fail in ledger.event
        # validation; they quarantine individually like any other malformed
        # import instead of surfacing as invalid-input errors.
        reason = str(exc)
        # The quarantine source vocabulary is the ledger's producer enum; an
        # unknown claimed producer is preserved in the reason, and the typed
        # source falls back to manual (never authenticated).
        claimed = submitted.get("producer")
        typed = claimed if claimed in ledger.REPORT_PRODUCERS else "manual"
        source = {"repo": ledger.REPO,
                  "producer": submitted.get("producer") or "unknown",
                  "type": typed,
                  "id": submitted.get("id") or "unknown", "authenticated": False}
        raw = submitted.get("report_bytes")
        digest_hex = hashlib.sha256(raw).hexdigest() if isinstance(raw, bytes) else "0" * 64
        payload = {"source": {**source, "id": source["id"] + ":" + digest_hex[:16]},
                   "source_digest": digest_hex, "result": "unverified",
                   "reason": reason, "review_id": None, "duplicate_id": None,
                   "artifacts": [_artifact(raw if isinstance(raw, bytes) else b"", digest_hex)]}
        try:
            # One quarantine event per (report digest, reason): a repeated
            # identical malformed import stays idempotent in the sequence,
            # while a different refusal of the same bytes is a distinct,
            # individually-retained disposition.
            quarantine_value = ledger.event(
                "import-result",
                "record:" + digest_hex[:16] + ":quarantine:" + ledger.digest(reason)[:16],
                at, payload)
        except ledger.IntegrityError:
            quarantine_value = None
        if quarantine_value is None:
            # Unrepresentable input: report the refusal without a ledger event.
            return [], "refused:" + reason
        return [quarantine_value], "quarantined:" + reason
    previous = next((v for v in existing if v.get("source_key") == value["source_key"]
                     and v.get("event_type") == "review"
                     and any(a["sha256"] == digest_hex for a in v["payload"]["artifacts"])), None)
    if previous is not None:
        return [], "duplicate:" + previous["id"]
    events = [value]
    if value["payload"].get("supersedes"):
        original = next((v for v in existing if v.get("id") == value["payload"]["supersedes"]), None)
        if original is None:
            return [], "refused:superseded record is unknown"
        if original.get("event_type") != "review":
            return [], "refused:superseded record is not a review"
    return events, "record:" + value["id"]


def normalize_github_review(review, *, owner_repo, pr, at):
    """Normalize one fetched GitHub review observation into a report submission.

    ``review`` is a ``ReviewSummary``-shaped document from the existing
    ``fetchReviewState`` reads. The GitHub login is forge evidence, never proof
    of the agent behind it: the authenticated submitter is the login, the
    claimed reviewer is the login, and independence records the account/shared
    caveat for existing policy consumers. The report artifact is the review
    body bytes; the source id is the GitHub review node id, so repeated fetches
    of one review are the same import.
    """
    body = review.get("body")
    if not isinstance(body, str) or not body.strip():
        raise RecordRefused("github review body is missing")
    login = review.get("authorLogin")
    if not isinstance(login, str) or not login:
        raise RecordRefused("github review has no author login")
    review_id = review.get("id")
    if not isinstance(review_id, str) or not review_id:
        raise RecordRefused("github review has no node id")
    head = review.get("commitOid")
    submitted = {
        "producer": "agent" if review.get("authorType") == "Bot" else "manual",
        "id": f"github:{owner_repo}#{pr}:{review_id}",
        "report_bytes": body.encode("utf-8"),
        "reviewer": login,
        "authenticated_submitter": login,
        "forge_evidence": PROVENANCE_FORGE_EVIDENCE,
        "head": head if isinstance(head, str) and len(head) == 40 else None,
        # GitHub verdicts are claimed completions without retained scope: the
        # outcome stays unverified rather than borrowing vendor credit.
        "verdict": None,
        "independence": ("github-account:" + login
                         + ":shared forge account does not identify the agent or prove independence"),
    }
    return submitted


def historical_view(record):
    """Adapter view of a historical ``author-cli``/``merged-current`` receipt.

    The original record keeps its original digest and producer; the adapter
    never claims full-branch coverage and never relabels the evidence. Returns
    a summary document for history projections (unified summary and catalog
    consumers), not a new ledger event.
    """
    if not isinstance(record, dict) or record.get("event_type") != "review":
        raise RecordRefused("historical adapter reads retained review events only")
    source = record["payload"]["source"]
    if source["type"] not in ("author-cli", "author-queue", "crq-run"):
        raise RecordRefused("historical adapter is for author-cli/merged-current records")
    p = record["payload"]
    return {
        "id": record["id"],
        "producer": source["producer"],
        "type": source["type"],
        "head": p["head"],
        "base": p["base"],
        "outcome": p["outcome"],
        "scope_verified": p["completion"]["scope_verified"],
        "full_branch_coverage": False,
        "digest": record["id"],
        "provenance": p.get("provenance"),
    }
