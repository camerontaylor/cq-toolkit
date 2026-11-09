"""Durable triage and delivery for CLI findings, including threadless findings."""
import copy
import json
import hashlib
import re
from pathlib import Path

import review_ledger as ledger
import backfill_history as history
from backfill_accounting import ranges, line_bytes


_UNSET = object()

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

    def context_error(self, fid, expected_previous_event_id, error):
        """Update a diagnostic only if this snapshot still owns the row."""
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes())
            if row["previous_event_id"] != expected_previous_event_id:
                return False
            if error is None:
                if "context_error" not in row:
                    return True
                row.pop("context_error")
            else:
                row["context_error"] = error
            ledger.atomic(filename, ledger.canonical(row))
            return True

    def recovered_anchor(self, row, repo, reviews):
        """Recover only a unique exact occurrence in its verified retained raw run.

        The original finding (and therefore its content-derived ID) stays immutable.
        This accessor does not write local state or disposition events.
        """
        if row.get("recovered_anchor"):
            return copy.deepcopy(row["recovered_anchor"])
        finding = row["finding"]
        matches = {v["id"]: v for v in reviews
                   if v["event_type"] == "review" and v["id"] == row["review_id"]}
        if not matches:
            return None
        review = matches[row["review_id"]]
        ledger.validate(review)
        payload = review["payload"]
        if (payload["target"] != row["target"] or finding not in payload["findings"]
                or payload["source"]["producer"] != "crq-runner-app" or not payload.get("artifacts")):
            return None
        reference = payload["artifacts"][0]  # completion_event retains raw terminal bytes first.
        try:
            self.publication.artifacts.verify(reference)
            raw = Path(reference["location"]).read_bytes()
            # Verify the bytes actually parsed, including a concurrent replacement.
            if hashlib.sha256(raw).hexdigest() != reference["sha256"]:
                return None
            candidates = [v for v in history.vendor_events(raw) if v.get("type") == "finding"
                          and (v.get("fileName") or v.get("path")) == finding["path"]
                          and (v.get("title") or "Unverified vendor finding anchor") == finding["title"]
                          and (v.get("comment") or v.get("body") or json.dumps(v)) == finding["body"]]
            if len(candidates) != 1:
                return None
            intervals = history.finding_intervals(candidates[0])
            entry = repo.entries(row["target"]).get(finding["path"])
            if not intervals or not entry or entry["blob"] != finding["blob"]:
                return None
            maximum = len(line_bytes(repo.git("cat-file", "blob", entry["blob"])))
            if any(end > maximum for _, end in intervals):
                return None
            return {"path": finding["path"], "blob": entry["blob"], "intervals": intervals,
                    "anchor_recovered_from": reference["sha256"]}
        except (OSError, ValueError, TypeError, KeyError, ledger.IntegrityError):
            return None

    def triage(self, fid, repo, promoted, action, actor, reason, at, *, fixing_commit=None, canonical_id=None, reviews=(), current_path=None, current_lines=None, quoted_text=None, expected_previous_event_id=_UNSET):
        """Mapping confirms the anchor only; actor must confirm substantive validity."""
        retained = self.publication.retained()
        self.recover(retained)
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes()); finding = row["finding"]
            if expected_previous_event_id is not _UNSET and row["previous_event_id"] != expected_previous_event_id:
                return None  # A newer disposition supersedes this snapshot plan.
            repo.resolve(promoted)
            recovered = self.recovered_anchor(row, repo, [*retained, *reviews]) if finding["anchor_status"] != "verified" else None
            anchor = recovered or finding
            name, lines = repo.carry(row["target"], promoted, anchor["path"], ledger.intervals(anchor["intervals"])) if recovered or finding["anchor_status"] == "verified" else (None, set())
            if action == "confirmed" and current_path is not None:
                entries = repo.entries(promoted)
                try:
                    selected = ledger.intervals(current_lines)
                    text = repo.git("cat-file", "blob", entries[current_path]["blob"]).decode().splitlines()
                    quote = "\n".join(text[i - 1] for i in sorted(selected) if 1 <= i <= len(text))
                    if (not selected or min(selected) < 1 or max(selected) > len(text)
                            or not isinstance(quoted_text, str) or not quoted_text.strip() or quote != quoted_text):
                        raise ValueError("quote mismatch")
                    name, lines = current_path, selected
                except (KeyError, TypeError, ValueError, UnicodeError, ledger.IntegrityError):
                    name, lines = None, set()
            evidence = {"target": promoted, "reason": reason, "anchor_verified": bool(name and lines and (current_path is not None or len(lines) == len(ledger.intervals(anchor["intervals"])))) }
            evidence.update(mapped_path=name, mapped_intervals=ranges(lines))
            if current_path is not None and evidence["anchor_verified"]:
                evidence["quoted_text"] = quoted_text
            if recovered:
                evidence.update(recovered_anchor=recovered, anchor_recovered_from=recovered["anchor_recovered_from"])
            if not actor or not reason:
                raise ledger.IntegrityError("triage requires actor and reason")
            if action == "confirmed" and not evidence["anchor_verified"]:
                action = "needs-human"
            if action in ("fixed", "already-fixed"):
                if not fixing_commit:
                    raise ledger.IntegrityError("fixing commit required")
                repo.resolve(fixing_commit)
                evidence.update(fixing_commit=fixing_commit, verification=reason)
            if action == "superseded" and fixing_commit:
                evidence["fixing_commit"] = repo.resolve(fixing_commit)
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
            row.pop("context_error", None)
            if recovered:
                row["recovered_anchor"] = recovered
            ledger.atomic(filename, ledger.canonical(row))
            return value

    def handoff(self, fid, previous_task, job, at):
        """Assign a validated prepared retry through the existing delivery chain."""
        if job.get("canonical_finding_id") != fid or job.get("origin_job") != previous_task:
            raise ledger.IntegrityError("prepared retry source identity mismatch")
        self.recover(self.publication.retained())
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes())
            current = row.get("receipt", {}).get("repair_task")
            if current == job["job"]:
                return
            if current != previous_task:
                raise ledger.IntegrityError("prepared retry no longer owns canonical finding")
            receipt = {"acknowledgement": ledger.digest(job), "repair_task": job["job"]}
            value = ledger.event("finding-event", "prepared-delivery:" + fid + ":" + job["job"], at,
                                 {"finding_id": fid, "review_id": row["review_id"],
                                  "previous_event_id": row["previous_event_id"], "action": "delivered",
                                  "evidence": receipt, "actor": "crq-repair-preparation"})
            self.publication.spool(value)
            row.update(status="delivered", previous_event_id=value["id"], receipt=receipt)
            ledger.atomic(filename, ledger.canonical(row))

    def current_fixed_event(self, job, fixing_commit):
        """Read the existing authoritative fixed disposition for this receipt."""
        fid = job.get("canonical_finding_id")
        if not isinstance(fid, str) or not re.fullmatch(r"[0-9a-f]{64}", fid):
            return None
        self.recover(self.publication.retained())
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            if not filename.exists():
                return None
            row = ledger.loads(filename.read_bytes())
            if row.get("status") != "fixed":
                return None
            if (row.get("canonical_id") != fid or row.get("finding", {}).get("id") != fid
                    or row.get("review_id") != job.get("review_id")
                    or row.get("receipt", {}).get("repair_task") != job.get("job")):
                raise ledger.IntegrityError("current fixed finding identity does not match repair")
            retained = self.publication.retained()
            # A writer may have spooled a successor after recovery but before
            # this lock. Never project the cached predecessor in that window.
            if any(v.get("event_type") == "finding-event"
                   and v["payload"].get("finding_id") == fid
                   and v["payload"].get("previous_event_id") == row.get("previous_event_id")
                   for v in retained):
                raise ledger.IntegrityError("current fixed finding has a retained successor")
            events = [v for v in retained if v.get("id") == row.get("previous_event_id")]
            if len(events) != 1:
                raise ledger.IntegrityError("current fixed finding event is unavailable")
            value = events[0]
            ledger.validate(value)
            p = value["payload"]
            evidence = p.get("evidence", {})
            verification = evidence.get("verification")
            if (value["event_type"] != "finding-event" or p.get("action") != "fixed"
                    or p.get("finding_id") != fid or p.get("review_id") != job.get("review_id")
                    or evidence.get("fixing_commit") != fixing_commit
                    or not isinstance(verification, str) or not verification.strip()):
                raise ledger.IntegrityError("current fixed finding evidence does not match merged repair")
            return value["id"]

    def repair_outcome(self, fid, job, action, reason, at, *, fixing_commit=None, fix_pr=None):
        """Idempotently publish a repair result through the existing event chain."""
        self.recover(self.publication.retained())
        with ledger.locked(self.root / "findings.lock"):
            filename = self.root / "triage" / (fid + ".json")
            row = ledger.loads(filename.read_bytes())
            current = row.get("receipt", {}).get("repair_task")
            if current and (current != job or row.get("status") != "delivered"):
                return  # Preserve newer generations and operator dispositions.
            evidence = {"repair_task": job, "reason": reason, "fix_pr": fix_pr}
            if fixing_commit:
                evidence.update(fixing_commit=fixing_commit, verification=reason)
            token = ledger.digest({"job": job, "action": action, "evidence": evidence})
            # Retained outbox records survive acknowledgment and caller crashes.
            if any(v["event_type"] == "finding-event" and
                   v["source_key"] == "repair-outcome:" + token
                   for v in self.publication.retained()):
                return
            value = ledger.event("finding-event", "repair-outcome:" + token, at,
                                 {"finding_id": fid, "review_id": row["review_id"],
                                  "previous_event_id": row["previous_event_id"], "action": action,
                                  "evidence": evidence, "actor": "crq-repair"})
            self.publication.spool(value)
            row.update(status=action, previous_event_id=value["id"])
            ledger.atomic(filename, ledger.canonical(row))

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
            delivery_key = row["canonical_id"]
            if row.get("receipt"):
                delivery_key = ledger.digest({"canonical": delivery_key, "confirmation": row["previous_event_id"]})
            request_file = self.root / "delivery" / (delivery_key + ".json")
            if request_file.exists():
                saved = ledger.loads(request_file.read_bytes())
                if saved != request:
                    # A prior transport may have accepted a task before its receipt
                    # was saved. Preserve that request; re-confirmation gets a new task.
                    delivery_key = ledger.digest({"canonical": row["canonical_id"], "confirmation": row["previous_event_id"]})
                    request_file = self.root / "delivery" / (delivery_key + ".json")
                    if request_file.exists() and ledger.loads(request_file.read_bytes()) != request:
                        raise ledger.IntegrityError("repair generation request changed; reconcile")
                    ledger.atomic(request_file, ledger.canonical(request))
            else:
                ledger.atomic(request_file, ledger.canonical(request))
            receipt_file = self.root / "receipts" / (delivery_key + ".json")
            receipt = ledger.loads(receipt_file.read_bytes()) if receipt_file.exists() else transport(delivery_key, request)
            if not receipt.get("acknowledgement") or not receipt.get("repair_task"):
                raise ledger.IntegrityError("repair transport did not acknowledge durable task")
            ledger.atomic(receipt_file, ledger.canonical(receipt))
            value = ledger.event("finding-event", "delivery:" + fid + ":" + delivery_key, at, {"finding_id": fid, "review_id": row["review_id"],
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
        row.pop("context_error", None)
        if p["evidence"].get("recovered_anchor"):
            row["recovered_anchor"] = p["evidence"]["recovered_anchor"]
        if p["action"] == "delivered":
            row["receipt"] = p["evidence"]
        elif "target" in p["evidence"]:
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
               "canonical_finding_id": request["canonical_id"]}
        if filename.exists() and ledger.loads(filename.read_bytes()) != job:
            raise ledger.IntegrityError("repair inbox idempotency conflict")
        ledger.atomic(filename, ledger.canonical(job))
        item = next((i for i in queue["items"] if i["id"] == item_id), None)
        if item is None:
            queue["items"].append({"id": item_id, "kind": "merged", "pr": 0, "state": "repairing", "cycles": [],
                                   "repair_runs": {run: {"jobs": [job_id], "pin": request["target"], "base": request["target"],
                                                         "branch": None, "open_pr": False, "round": 1, "state": "queued"}}})
        for old_item in queue["items"]:
            for old_run in old_item.get("repair_runs", {}).values():
                if old_run.get("state") not in ("queued", "ready", "publish_failed") or old_run.get("fix_pr") or old_run.get("fix_merged"):
                    continue  # Only a recorded fix PR retains its publication lifecycle.
                for old_id in old_run.get("jobs", []):
                    if old_id == job_id:
                        continue
                    old_path = root / "state/repair/inbox" / (old_id + ".json")
                    if old_path.exists() and ledger.loads(old_path.read_bytes()).get("canonical_finding_id") == request["canonical_id"]:
                        old_run.update(state="stale", error="superseded by repair generation " + job_id)
                        old_item["state"] = "done"
        save_queue(queue)
        return {"acknowledgement": ledger.digest(job), "repair_task": job_id}
    return accept
