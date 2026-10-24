# crq archive-push — install runbook (session-log preservation, item 2.6)

**Owner executes this.** The code ships in this branch; nothing here is
installed by a PR, and no unit is created on any host by an agent (hard
limit, 2026-10-24). Runs as the locked `crq` account on the queue host
with a write-only credential to the dedicated archive bucket
(`session-log-archive` on the SeaweedFS S3 — endpoint and credential are
in the deploy `.env` under the telemetry SeaweedFS deploy directory,
never committed; bucket creation is also owner-side, see the Phase 4.1
runbook in the agents repo `docs/session-archive-runbook.md`).

## What is pushed

- `state/runs/` (every review's `meta.json`, `review.ndjson`, `stderr.log`,
  `runner.log`, `exit.json`, `secret-scan.json`)
- `state/events.jsonl`
- `state/work.jsonl` (the task log this branch introduces)
- `state/repair/` (when repair is enabled: `driver.log`, `session.json`,
  `agent.json`, `judge-result.json` per job)
- `state/ledger/run-ledger.jsonl` (the signer's ledger)

Append-only: `rclone copy` (never `sync`/`--delete`), under `nice`/`ionice`.

## Prerequisites (owner)

1. The dedicated bucket exists and the credential may write but NOT read
   back or delete (SeaweedFS IAM is coarse; if write-only is not
   expressible, a dedicated key whose scope is this bucket is the
   acceptable floor).
2. `rclone` on the queue host with a remote named `session-archive`
   pointing at the SeaweedFS S3 endpoint (deploy `.env`, never committed)
   and the crq-scoped key in the rclone config readable ONLY by the `crq`
   account.

## Unit (owner installs; content ships here for review)

`~crq/.config/systemd/user/crq-archive-push.service` + `.timer`:

```ini
# crq-archive-push.service
[Unit]
Description=crq session-log archive push (append-only)
After=network-online.target

[Service]
Type=oneshot
# Light on I/O: reviews land minutes apart; a full pass is tiny.
ExecStart=/usr/bin/env nice -n 10 ionice -c2 -n7 \
  rclone copy /home/crq/crq/state session-archive:session-log-archive/crq \
  --transfers 2 --checkers 2 --low-level-retries 4 --no-update-modtime
```

```ini
# crq-archive-push.timer
[Unit]
Description=Nightly crq archive push

[Timer]
OnCalendar=*-*-* 04:20:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

Enable (owner, on the queue host, as an admin with sudo to `crq`):

```sh
sudo -u crq systemctl --user daemon-reload
sudo -u crq systemctl --user enable --now crq-archive-push.timer
sudo -u crq systemctl --user list-timers crq-archive-push.timer
```

Lingering for the `crq` user must already be on (the existing crq units
depend on it; do not change it here).

## Verification

```sh
sudo -u crq rclone lsl session-archive:session-log-archive/crq/runs | head
```

First push is O(runs on disk); every later push moves only new files.
The telemetry-ingest `crq-run` adapter reads the ARCHIVE copy once the
Phase 4 `archive` source is pointed at it.
