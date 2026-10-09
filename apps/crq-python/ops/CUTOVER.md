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
   Use ops/prepare-host.py to render the host config and inert marker; it refuses
   active units. Keep every unit stopped. Verify unit syntax using systemd-analyze verify.
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

Model-free handover prerequisites: final head/config, CodeRabbit/GitHub auth,
both quiet-gate endpoints, locked drained state, fleet reader location update,
and mutually exclusive runner ownership. Signer installation remains its own
identity/custody lane; unavailable signer blocks promotion, never falls back.
Repair activation only: existing spend authorization, ZAI credential, hard-budget
launchers and read-only judge mode. These must not block the model-free handover.

Prepared 2026-10-09: toolkit build 2d58441298f52561167166a88797b72ceb33582b
completed without tests; all user units installed stopped; static unit verify
exit 0; both Paseo queries/auth-status commands succeeded. No queue imported and
queue-host marked inert at preparation. Exact deployment evidence is maintained in
state/implementation-deployment.json after the safe handover.

Fleet-reader compatibility: the actual consumer was not identified by targeted
configuration/source search. The documented old worker-host location is preserved
by ops/fleet-reader.py: every five minutes it reads only queue-host XDG summary over
SSH and atomically mirrors both worker-host legacy and XDG summary locations. It
never ticks or advances last_tick. Install its plist and home-contained script
only after a valid queue-host summary exists. Disable the old worker-host watchdog at
handover; the sole watchdog becomes queue-host. Retain old summary/watchdog artifacts
in the rollback snapshot. A missing remote summary leaves the old snapshot stale.
