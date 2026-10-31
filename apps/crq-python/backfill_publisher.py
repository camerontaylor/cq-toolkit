"""Durable off-lock ledger publication; queue reconciliation is local and brief."""
from types import SimpleNamespace
import subprocess
import uuid

import backfill_runtime as runtime
import finding_delivery
import review_ledger as ledger


def worker_services(c, config):
    # This clone is owned by the publication worker, never by scheduler fetches.
    root = c.STATE / "backfill/publisher.git"
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "--bare", "--quiet", str(root)], check=True, capture_output=True)
    remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=c.CLONE,
                            check=True, capture_output=True).stdout.decode().strip()
    subprocess.run(["git", "config", "remote.origin.url", remote], cwd=root,
                   check=True, capture_output=True)
    proxy = SimpleNamespace(STATE=c.STATE, CLONE=root, Spool=c.Spool)
    return runtime.services(proxy, config)


def run(c):
    config = runtime.settings(c.STATE)
    if not config:
        return {"publication": "disabled"}
    request = c.STATE / "backfill/publish-request.json"
    failure = c.STATE / "backfill/publication-failure.json"
    # Independent of tick.lock. Every worker/manual invocation shares this lock.
    with ledger.locked(c.STATE / "backfill/publisher.lock"):
        _, _, outbox, publisher = worker_services(c, config)
        requested = request.read_bytes() if request.exists() else None
        if requested is None and not outbox.pending() and not failure.exists():
            return {"publication": "idle"}
        if requested is None:
            # Persist reconciliation intent even when only the periodic pending
            # scan woke us: remote acknowledgements can precede a process crash.
            requested = ledger.canonical({"request": uuid.uuid4().hex})
            ledger.atomic(request, requested)
        try:
            publisher.publish(outbox)
            head, events = publisher.fetch()
            ids = ledger.validate_sequence(events)
            inbox = finding_delivery.Inbox(c.STATE / "backfill/findings", outbox)
            for value in events:
                if value["event_type"] == "review":
                    inbox.ingest(value)
            inbox.recover(events)

            def merge():
                if runtime.settings(c.STATE) != config:
                    raise ledger.IntegrityError("publication configuration changed; retry reconciliation")
                queue = c.load_queue()
                runtime.reconcile_publication(c, queue, head, ids)
                if failure.exists():
                    failure.unlink()
                    ledger.fsync_dir(failure.parent)
                # A concurrent tick request must survive. Pending records are also
                # scanned by every timer invocation, including post-merge events.
                if requested is not None and request.exists() and request.read_bytes() == requested:
                    request.unlink()
                    ledger.fsync_dir(request.parent)
                return True
            if c.with_lock(merge, lock_wait=30) is not True:
                raise ledger.IntegrityError("publication queue lock busy; reconciliation pending")
            return {"ledger_head": head, "publication": "reconciled"}
        except Exception as exc:
            # These are independent persistence paths. A marker failure must not
            # skip the queue halt or replace the original publication exception.
            try:
                ledger.atomic(failure, ledger.canonical({"error": str(exc)[:300]}))
            except Exception as marker_error:
                exc.add_note("publication failure marker could not be persisted: " + str(marker_error)[:300])
            def record_failure():
                queue = c.load_queue()
                queue["backfill_publication_error"] = str(exc)[:300]
                if not queue.get("backfill_halted") or queue.get("backfill_halt_operation") == "publication":
                    queue["backfill_halted"] = str(exc)[:300]
                    queue["backfill_halt_operation"] = "publication"
                c.save_queue(queue)
                return True
            try:
                if c.with_lock(record_failure, lock_wait=30) is not True:
                    exc.add_note("publication queue halt remains pending: queue lock unavailable")
            except Exception as queue_error:
                exc.add_note("publication queue halt could not be persisted: " + str(queue_error)[:300])
            raise


if __name__ == "__main__":
    import crq
    run(crq)
