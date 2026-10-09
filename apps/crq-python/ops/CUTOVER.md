# queue-host single-runner cutover

Prepare all artifacts before stopping worker-host. The owner authorized handover.
Never display credentials. Keep repair.enabled=false until existing spend
approval has been verified and recorded; installation does not authorize spend.

1. Prepare /home/operator/repos/coderabbit-queue on queue-host at the integrated commit.
   Prepare a dedicated cq-toolkit clone from origin/merge-queue and build its CLI
   without tests. Provision ZAI_API_KEY via ~/.local/secrets privately. Validate
   key presence only, never print values. Keep signer forced-command transport.
2. Render config host paths and both Paseo endpoint addresses. Unknown endpoints
   fail the quiet gate closed. Install ops/systemd units under ~/.config/systemd/user.
   Keep every unit stopped. Verify unit syntax using systemd-analyze verify.
3. Pause worker-host schedule schedule-example. Wait for the exact existing tick/review PIDs
   to finish; inspect queue run IDs against command lines. Never kill unrelated
   processes. Block legacy addressing dispatch. No tests or model probes.
4. Hold the worker-host tick lock while snapshotting state/queue.json, events.jsonl,
   runs and ledger; copy state to queue-host and retain an immutable rollback snapshot.
   PID liveness is host-local: migrate only after active reviews finish.
5. Mark worker-host inert with state/runner-disabled. Delete schedule schedule-example only
   after state and config are ready on queue-host. Enable queue-host tick/watchdog timers.
   Exactly one runner must exist; flock alone cannot coordinate hosts.
6. Inspect systemctl --user status, journal and heartbeat/summary under
   ${XDG_STATE_HOME:-~/.local/state}/crq. Repair units remain gated and disabled.
   Record exact deployed commit and first completed tick time in IMPLEMENTATION.md.
7. Observe 24 hours: >=95% of slots advance last_tick; stall alert at 36 minutes.
   Do not report this criterion as complete before the observation interval.

Rollback: stop queue-host timer and wait for its exact active reviews first; migrate
latest state back while both runners are stopped; remove worker-host inert marker
and recreate schedule only after queue-host is provably stopped. Never run both.

External prerequisites: verified spend authorization; built cq seam, credentials,
Paseo endpoints/read-only judge mode, and fleet reader location update.
