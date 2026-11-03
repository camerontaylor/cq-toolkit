# Measurement archive transport — install (M8b)

**Docs only.** This page records the owner-only install; nothing here is
installed or enabled by a PR, and no agent creates a unit on any host.
Install on **triton first**, then on each producing host.

## Transport contract

`scripts/archive-measurement-wrapper.mjs` exports `runMeasurementArchive`.
It is a transport: it never reads or writes a verdict and never changes the
M8a bundle.

1. Validate the local bundle and read `manifest.json` (`bundleVersion: 1`, a
   safe `runId`). A missing or invalid bundle returns `state: "failed"` and no
   remote command runs.
2. Check the **existing session archive** first with
   `rclone lsf <target> --max-depth 1`. An unreachable archive is reported
   `unavailable`; it is never treated as empty or "skipped".
3. `rclone copy <bundleDir> <target>/<host>/measurement/<runId>` with
   `--immutable`, `--no-update-modtime`, two transfers and two checkers.
   `sync` and every `--delete*` flag are absent by construction.

`<target>` is the same configured target the crq session archive uses
(`session-archive:session-log-archive/crq` in the queue-host runbook).
`<host>` defaults to `os.hostname()`, so hosts never collide. Result layout:

```text
<target>/<host>/measurement/<runId>/manifest.json
<target>/<host>/measurement/<runId>/files/...
```

`--immutable` keeps the archive append-only: a re-run that would change an
already archived file fails loudly instead of rewriting it.

## Explicit local fallback

If the archive check or copy fails, the wrapper returns `state: "local"`,
names the untouched M8a bundle in `localBundle`, and carries a sanitized
`reason`. The evidence stays durable at
`~/.local/state/cq/measurement-bundles/<runId>`; nothing is copied, moved or
deleted. A missing bundle is `state: "failed"` — unknown, never zero.

## No deletion, no manifest mutation

The wrapper imports no delete primitive and never writes into the bundle or
the session manifest; it only opens `manifest.json` read-only with
`O_NOFOLLOW`. The remote leg is `rclone copy --immutable`.

## Owner-only ExecStart

One oneshot invocation per completed bundle (the measurement scheduler
supplies `RUN_ID`); this is the shape to install, not a unit committed here:

```ini
[Unit]
Description=cq measurement evidence archive push (append-only)

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env nice -n 10 ionice -c2 -n7 \
  node %h/repos/cq-toolkit/scripts/archive-measurement-wrapper.mjs \
  --bundle %h/.local/state/cq/measurement-bundles/RUN_ID \
  --target session-archive:session-log-archive/crq
```

The owner enables it (per host) with `systemctl --user daemon-reload` and
`systemctl --user enable --now <unit>`, then verifies one pass:

```sh
systemctl --user start <unit>
journalctl --user -u <unit> -n 20
rclone lsl session-archive:session-log-archive/cq/triton/measurement | head
```

The remote named `session-archive` and its credentials are owner-managed and
never committed. Do not install units or push data from a code task.
