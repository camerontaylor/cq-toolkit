# Measurement archive transport — install (M8b)

**Docs only.** This page records the owner-only install; nothing here is
installed or enabled by a PR, and no agent creates a unit on any host.
Install on **triton first**, then on each producing host.

## Transport contract

`scripts/archive-measurement-wrapper.mjs` exports `runMeasurementArchive`.
It is a transport: it never reads or writes a verdict and never changes the
M8a bundle. Each rclone call runs with a five-minute timeout.

1. Validate the target (a named remote plus a non-empty relative path, e.g.
   `session-archive:session-log-archive/crq`), the host name, and the local
   bundle: `manifest.json` must be a regular file (`bundleVersion: 1`, a safe
   `runId`), read with `O_NOFOLLOW` after an `lstat` and a device/inode
   comparison. A target without a remote (`rel/dir`), a connection string, a
   bare `remote:`, an absolute remote path (`remote:/abs`), or a missing or
   invalid bundle returns `state: "failed"` and no remote command runs; an
   absolute sftp or local root is used through an rclone alias remote
   (`type = alias`) instead. Before any remote command, the whole bundle tree
   is walked with `lstat`, links never followed (M8a's rule): every entry
   must be a regular file or directory, so a symlink — or a FIFO or device
   node — anywhere in the bundle, including under `files/`, returns
   `state: "failed"` with zero remote calls.
2. Check the **existing session archive** first with
   `rclone lsf <target> --max-depth 1`. An unreachable archive (including a
   call that times out) is reported `unavailable`; a spawn failure (no rclone
   on `PATH`) is `unknown`. Neither is ever treated as empty or "skipped".
3. `rclone copy <bundleDir> <target>/<host>/measurement/<runId>` with
   `--immutable`, `--no-update-modtime`, `--exclude /manifest.json`, two
   transfers and two checkers. `sync` and every `--delete*` flag are absent by
   construction.
4. `rclone check <bundleDir> <dest> --one-way --exclude /manifest.json
--copy-links` verifies the payload while the remote still has no manifest:
   rclone can skip a file with a NOTICE and still exit 0, so a mismatch here
   returns `state: "local"` with the reason "remote copy incomplete" and the
   commit marker is never written. `--copy-links` makes `check` follow a
   local symlink instead of skipping it on both sides, so one the walk missed
   is still caught.
5. `rclone copy <bundleDir> <dest> --immutable --include /manifest.json` writes
   the commit marker with the payload copy's flag set (`--transfers 2`,
   `--checkers 2`, `--low-level-retries 4`, `--no-update-modtime`): the
   manifest appears on the remote only after the payload has been verified, so
   an interrupted push never looks like a whole bundle. The copy is
   directory-scoped because single-file `copyto` skips `--immutable`
   (rclone issue #4921).
6. `rclone check <bundleDir> <dest> --one-way --include /manifest.json
--copy-links` confirms the marker itself (`check` cannot compare single
   files, so the tree comparison is filtered to the manifest path); a failure
   returns `state: "local"` with the reason "the archived commit marker could
   not be verified".

Exit codes follow invariant I1: 0 when the bundle is archived, 2 for a CLI
argument error (a missing or invalid `--bundle`, `--target` or `--host`, where
the result also carries `usage: true`; an invalid `--bundle` includes a path
that does not name a directory), and 1 for every other failure, so an
operator can tell a misconfigured invocation from an archive or transport
failure.

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

If the archive check, copy, payload verification, commit or marker check
fails, the wrapper returns `state: "local"`, names the untouched M8a bundle in
`localBundle`, and carries a sanitized `reason`. A copy or commit failure also
says the remote may hold partial content; the commit marker bounds that state,
because `manifest.json` is written only after the payload has been verified —
a bundle without it was never committed. The evidence stays durable at
`~/.local/state/cq/measurement-bundles/<runId>`; nothing is copied, moved or
deleted. A missing bundle is `state: "failed"` — unknown, never zero.

## No deletion, no manifest mutation

The wrapper imports no delete primitive and never writes into the bundle or
the session manifest; it only opens `manifest.json` read-only after an
`lstat` and with `O_NOFOLLOW`. The remote leg is `rclone copy --immutable`.

## Owner-only install

The unit is a **template**, one instance per completed bundle, installed as
`~/.config/systemd/user/cq-measurement-archive@.service`. The measurement
scheduler passes the run id as the instance name, which systemd substitutes
for `%i`; `%h` expands to the user's home. `ExecStart` runs the
wrapper from a **pinned deploy checkout**: `%h/deploy/cq-toolkit` must be a
pinned release tag, never the moving dev worktree.

```ini
[Unit]
Description=cq measurement evidence archive push for %i (append-only)

[Service]
Type=oneshot
TimeoutStartSec=30min
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env nice -n 10 ionice -c2 -n7 \
  node %h/deploy/cq-toolkit/scripts/archive-measurement-wrapper.mjs \
  --bundle %h/.local/state/cq/measurement-bundles/%i \
  --target session-archive:session-log-archive/crq
```

The owner installs it per host (`systemctl --user daemon-reload`) and starts
one instance per run. There is no `[Install]` section and nothing is enabled:

```sh
systemctl --user daemon-reload
systemctl --user start cq-measurement-archive@<runId>
journalctl --user -u cq-measurement-archive@<runId> -n 20
rclone lsl session-archive:session-log-archive/crq/triton/measurement | head
```

The remote named `session-archive` and its credentials are owner-managed and
never committed. Do not install units or push data from a code task.
