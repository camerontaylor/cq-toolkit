"""Durable triage and delivery for CLI findings, including threadless findings."""
import copy
from pathlib import Path

import review_ledger as ledger
from backfill_accounting import ranges


def occurrence(producer, run_id, finding):
    vendor = finding.get("source_id")
    identity = {"producer": producer, "run_id": run_id}
    identity.update({"vendor_id": vendor} if vendor else {k: finding[k] for k in ("path", "blob", "intervals", "title", "body")})
    return ledger.digest(identity)


def normalize(producer, run_id, finding):
    value = {k: finding[k] for k in ("severity", "path", "blob", "intervals", "title", "body")}
    value.update(source_id=finding.get("source_id"), status="untriaged",
                 anchor_status="verified" if finding.get("path") and finding.get("blob") and finding.get("intervals") else "unverified")
    value["id"] = occurrence(producer, run_id, value)
    return value


class Inbox:
    def __init__(self, root, publication_outbox):
        self.root, self.publication = Path(root), publication_outbox

    def ingest(self, review):
        ledger.validate(review)
        for finding in review["payload"]["findings"]:
            filename = self.root / "triage" / (finding["id"] + ".json")
            with ledger.locked(self.root / "findings.lock"):
                value = {"review_id": review["id"], "finding": finding,
                         "target": review["payload"]["target"], "canonical_id": finding["id"],
                         "previous_event_id": None, "status": "untriaged"}
                if filename.exists():
                    old = ledger.loads(filename.read_bytes())
                    if old["review_id"] != review["id"] or old["finding"] != finding:
                        raise ledger.IntegrityError("finding occurrence conflict")
                    continue
                ledger.atomic(filename, ledger.canonical(value))

    def triage(self, fid, repo, promoted, action, actor, reason, at, *, fixing_commit=None, canonical_id=None):
        """Mapping confirms the anchor only; actor must confirm substantive validity."""
        self.recover(self.publication.retained())
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes()); finding = row["finding"]
            repo.resolve(promoted)
            name, lines = repo.carry(row["target"], promoted, finding["path"], ledger.intervals(finding["intervals"])) if finding["anchor_status"] == "verified" else (None, set())
            evidence = {"target": promoted, "reason": reason, "anchor_verified": bool(name and lines and len(lines) == len(ledger.intervals(finding["intervals"]))) }
            evidence.update(mapped_path=name, mapped_intervals=ranges(lines))
            if not actor or not reason:
                raise ledger.IntegrityError("triage requires actor and reason")
            if action == "confirmed" and not evidence["anchor_verified"]:
                action = "needs-human"
            if action in ("fixed", "already-fixed"):
                if not fixing_commit:
                    raise ledger.IntegrityError("fixing commit required")
                repo.resolve(fixing_commit)
                evidence.update(fixing_commit=fixing_commit, verification=reason)
            if action == "duplicate":
                if not canonical_id or canonical_id == fid or not (self.root / "triage" / (canonical_id + ".json")).exists():
                    raise ledger.IntegrityError("duplicate link requires existing canonical issue and evidence")
                evidence["canonical_id"] = canonical_id
            value = ledger.event("finding-event", "finding:" + fid + ":" + ledger.digest({"previous": row["previous_event_id"], "action": action, "evidence": evidence}), at,
                                 {"finding_id": fid, "review_id": row["review_id"], "previous_event_id": row["previous_event_id"],
                                  "action": action, "evidence": evidence, "actor": actor})
            self.publication.spool(value)  # Durable event before local transition.
            row.update(status=action, previous_event_id=value["id"], target_current=promoted,
                       mapped_path=name, mapped_intervals=ranges(lines),
                       canonical_id=canonical_id if action == "duplicate" else row["canonical_id"])
            ledger.atomic(filename, ledger.canonical(row))
            return value

    def deliver(self, fid, transport, at):
        """Transport accepts a stable idempotency key and returns the same receipt."""
        self.recover(self.publication.retained())
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes())
            if row["status"] == "delivered":
                return row["receipt"]
            if row["status"] != "confirmed":
                raise ledger.IntegrityError("only confirmed current findings enter repair inbox")
            request = {"canonical_id": row["canonical_id"], "finding_id": fid, "review_id": row["review_id"],
                       "target": row["target_current"], "path": row["mapped_path"], "intervals": row["mapped_intervals"],
                       "finding": row["finding"]}
            request_file = self.root / "delivery" / (row["canonical_id"] + ".json")
            if request_file.exists():
                saved = ledger.loads(request_file.read_bytes())
                if saved != request:
                    raise ledger.IntegrityError("canonical repair request changed; reconcile")
            else:
                ledger.atomic(request_file, ledger.canonical(request))
            receipt_file = self.root / "receipts" / (row["canonical_id"] + ".json")
            receipt = ledger.loads(receipt_file.read_bytes()) if receipt_file.exists() else transport(row["canonical_id"], request)
            if not receipt.get("acknowledgement") or not receipt.get("repair_task"):
                raise ledger.IntegrityError("repair transport did not acknowledge durable task")
            ledger.atomic(receipt_file, ledger.canonical(receipt))
            value = ledger.event("finding-event", "delivery:" + fid, at, {"finding_id": fid, "review_id": row["review_id"],
                                 "previous_event_id": row["previous_event_id"], "action": "delivered", "evidence": receipt, "actor": "crq-repair-adapter"})
            self.publication.spool(value)
            row.update(status="delivered", previous_event_id=value["id"], receipt=receipt)
            ledger.atomic(filename, ledger.canonical(row))
            return receipt

    def recover(self, events):
        """Replay durable events after a crash between spool and local state write."""
        with ledger.locked(self.root / "findings.lock"):
            remaining = [v for v in events if v["event_type"] == "finding-event"]
            # Content IDs have no causal sort order. Repeat until every reachable
            # successor has been applied, including events already acknowledged.
            while remaining:
                advanced = False
                for value in remaining[:]:
                    if self._recover_event(value):
                        remaining.remove(value)
                        advanced = True
                if not advanced:
                    break  # Publication validates missing predecessors/forks.

    def _recover_event(self, value):
        p = value["payload"]; filename = self.root / "triage" / (p["finding_id"] + ".json")
        if not filename.exists():
            return False
        row = ledger.loads(filename.read_bytes())
        if row["previous_event_id"] == value["id"]:
            return True
        if row["previous_event_id"] != p["previous_event_id"]:
            return False
        row.update(status=p["action"], previous_event_id=value["id"])
        if p["action"] == "delivered":
            row["receipt"] = p["evidence"]
        elif p["action"] in ("confirmed", "needs-human", "duplicate", "dismissed", "superseded", "fixed", "already-fixed"):
            row.update(target_current=p["evidence"]["target"], mapped_path=p["evidence"].get("mapped_path"),
                       mapped_intervals=p["evidence"].get("mapped_intervals", []))
            if p["action"] == "duplicate":
                row["canonical_id"] = p["evidence"]["canonical_id"]
        ledger.atomic(filename, ledger.canonical(row))
        return True


def repair_transport(root, queue, save_queue, scan):
    """Adapter to the existing tick-owned repair inbox; never dispatches a fixer."""
    root = Path(root)
    def accept(key, request):
        job_id = "crq-backfill-" + key
        item_id = "backfill-finding-" + key
        filename = root / "state/repair/inbox" / (job_id + ".json")
        run = "backfill-" + key
        finding = {"severity": request["finding"]["severity"], "path": request["path"],
                   "line": request["intervals"][0][0], "body": request["finding"]["title"] + "\n" + request["finding"]["body"]}
        if not scan(request["target"], request["path"]):
            raise ledger.IntegrityError("repair source secret scan rejected")
        job = {"job": job_id, "item": item_id, "kind": "merged", "pr": 0, "run": run, "cycle": None,
               "repair_base": request["target"], "branch": None, "finding": finding, "repair_round": 1,
               "prior": None, "recurrence": False, "review_diff": "", "review_id": request["review_id"],
               "canonical_finding_id": key}
        if filename.exists() and ledger.loads(filename.read_bytes()) != job:
            raise ledger.IntegrityError("repair inbox idempotency conflict")
        ledger.atomic(filename, ledger.canonical(job))
        item = next((i for i in queue["items"] if i["id"] == item_id), None)
        if item is None:
            queue["items"].append({"id": item_id, "kind": "merged", "pr": 0, "state": "repairing", "cycles": [],
                                   "repair_runs": {run: {"jobs": [job_id], "pin": request["target"], "base": request["target"],
                                                         "branch": None, "open_pr": False, "round": 1, "state": "queued"}}})
        save_queue(queue)
        return {"acknowledgement": ledger.digest(job), "repair_task": job_id}
    return accept
