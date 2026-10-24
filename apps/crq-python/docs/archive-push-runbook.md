# crq archive-push — install runbook (session-log preservation, item 2.6)

**Owner executes this.** The code ships in this branch; nothing here is
installed by a PR, and no unit is created on any host by an agent (hard
limit, 2026-10-24). This page records the unit **as installed on the queue
host on 2026-10-25**; keep it in step with that install.

crq on the queue host runs as the **deploy user** (not a dedicated `crq`
account) from the deploy checkout at `%h/repos/crq-deploy`, so crq's state
directory is `%h/repos/crq-deploy/apps/crq-python/state`. The push is a
deploy-user `systemd --user` unit that copies that directory to the
dedicated archive bucket (`session-log-archive` on the SeaweedFS S3; the
endpoint lives in the deploy `.env` under the telemetry SeaweedFS deploy
directory and is never committed; bucket creation is owner-side, see the
Phase 4.1 runbook in the agents repo `docs/session-archive-runbook.md`).

## What is pushed

Everything under crq's `state/`:

- `state/runs/` (every review's `meta.json`, `review.ndjson`, `stderr.log`,
  `runner.log`, `exit.json`, `secret-scan.json`)
- `state/events.jsonl`
- `state/work.jsonl` (the task log this branch introduces)
- `state/repair/` (when repair is enabled: `driver.log`, `session.json`,
  `agent.json`, `judge-result.json` per job, plus the cq runner's
  `sessions/` store under each job dir once the SDK half ships)

**Not pushed:** the signer's run ledger (`run-ledger.jsonl`). The signer
writes it in its own private state directory (`signer/crq-signer.py`
`RUN_LEDGER`, under the signer account's `~/.local/state/crq-signer/`),
outside crq's `state/`, so this unit does not reach it. Archiving it needs
its own owner-authorized step; tracked as a follow-up issue.

Append-only: `rclone copy` (never `sync`/`--delete`), under `nice`/`ionice`.

## Prerequisites (owner)

1. The dedicated bucket exists.
2. `rclone` is installed for the deploy user (it lives in `~/.local/bin` on
   the queue host, hence the unit's `PATH`), with a remote named
   `session-archive` pointing at the SeaweedFS S3 endpoint (deploy `.env`,
   never committed). The rclone config is readable only by the deploy user.
3. **Credential (current):** the SeaweedFS stack's existing S3 key. No
   per-bucket IAM identity exists yet, so the key is not scoped to this
   bucket and can read and delete. A write-only (or at least
   bucket-scoped) key is a follow-up; when it lands, swap it into the
   `session-archive` remote and nothing else changes.

## Unit (as installed)

`~/.config/systemd/user/crq-archive-push.service` + `.timer` of the deploy
user:

```ini
# crq-archive-push.service
[Unit]
Description=crq session-log archive push (append-only)
After=network-online.target

[Service]
Type=oneshot
# rclone lives in ~/.local/bin on the queue host.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# Light on I/O: reviews land minutes apart; a full pass is tiny.
ExecStart=/usr/bin/env nice -n 10 ionice -c2 -n7 \
  rclone copy %h/repos/crq-deploy/apps/crq-python/state session-archive:session-log-archive/crq \
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

Enable (owner, on the queue host, as the deploy user):

```sh
systemctl --user daemon-reload
systemctl --user enable --now crq-archive-push.timer
systemctl --user list-timers crq-archive-push.timer
```

Lingering for the deploy user must already be on (the existing crq user
units depend on it; do not change it here).

## Verification

```sh
systemctl --user start crq-archive-push.service   # one manual pass
journalctl --user -u crq-archive-push.service -n 20
rclone lsl session-archive:session-log-archive/crq/runs | head
```

First push is O(runs on disk); every later push moves only new files.
The telemetry-ingest `crq-run` adapter reads the ARCHIVE copy once the
Phase 4 `archive` source is pointed at it.
