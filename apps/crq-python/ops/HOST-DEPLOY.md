# Host overlay and recorded runner deployment

P2 supplies deployment tooling; it does not authorize a deployment. Nothing here
changes signer custody. Do not render, patch or restart the old runner before the
owner-approved first monorepo deployment. `CUTOVER.md` and `CUTOVER-COMMANDS.md`
are archival records of the completed cross-host handover, not current commands.

## Slot scheduling deployment (owner-directed 2026-10-28)

Keep `crq-tick.timer` at `OnCalendar=*:0/12`. Render and install the new
`crq-slot.service` and `crq-slot.timer` through `prepare-host.py`'s existing
`crq-*` unit rendering path. After the recorded deployment, Giles enables and
starts `crq-slot.timer` alongside the existing tick timer. Its calendar is every
minute with `AccuracySec=1s`; its service runs `crq_slot.py` in the rendered CRQ
root with the same CLI PATH as tick. No transient systemd-run units are needed.

The admission entry first reads `state/next-review-at`; future hints avoid even
the queue lock and runner imports. Due entries take the shared lock non-blocking,
collect dead, ownership-verified detached results, apply signer-published cooldown,
probe repository-scoped usage, and fill free slots after reserving unconfirmed
local starts. They can wait once for a dated slot less than 60 seconds away;
undated retries do not sleep under the lock. While local runs are in flight,
the hint is capped at the next minute boundary for collection even during
pause/cooldown. No enrollment or audits run in the minute entry. Full ticks wait
up to 90 seconds for the lock, retain all maintenance duties, and refresh the hint. Harvest clears it; detached review
completion requests `systemctl --user --no-block start crq-tick.service` for prompt
harvest. No eligible work backs off twelve minutes. Stop both timers for manual
maintenance; the recorded deploy's runner-disabled marker also gates admission.

No overlay keys need changing. Render committed config: `max_inflight=10`,
`max_starts_per_tick=10`, `review_timeout_min=120`. The new ceiling defaults to
10 in code when omitted. The old starts/hour cap remains the conservative
fallback when usage is unavailable; valid vendor remaining slots govern normal
admission. A local slot prediction never authorizes spend without rechecking
usage. Unknown external starts and vendor admission lag retry within a minute.

All reviews use `--deep`; free slots start concurrent isolated reviews in
operator priority → rank order. The promotion signer is retired; follow
[signer deployment](../signer/DEPLOY.md) to stop its old daemon while preserving
the independent root review-ledger publisher. See [README](../README.md).

## Private overlay, schema 1

Keep the JSON file outside the deployment checkout and outside every Git
repository, mode 0600. Keep its private record directory outside Git, mode 0700.
Host values are never committed. There is no policy override mechanism.
`prepare-host.py` defines the closed allowlist in `HOST_KEYS`, `CONFIG_KEYS` and
`PATH_KEYS`; unknown keys at any depth fail. `repair.enabled` is a JSON boolean
host switch: `false` keeps repair off; `true` is refused unless committed policy
records a spend authorization. Spend authorization, provider/model roles, checks, triggers, quotas
and backoffs remain committed policy. No model/provider is selected by this tool.

Example only; replace every host value privately:

```json
{
  "schema_version": 1,
  "deploy_root": "/srv/crq-deploy",
  "record_dir": "/srv/private/crq-deploy-records",
  "fleet_reader": {
    "ssh_host": "queue.example.invalid",
    "source": "/srv/operator-state/crq/summary.json"
  },
  "config": {
    "clone": "/srv/crq-runtime",
    "worktree_root": "/srv/crq-worktrees",
    "timeout_bin": "/usr/bin/timeout",
    "paseo_hosts": ["worker.example.invalid:6767", "127.0.0.1:6767"],
    "promotion": {
      "record_url_template": "http://queue.example.invalid:6778/promotion/{item}",
      "alert_agent_host": "worker.example.invalid:6767",
      "alert_agent_id": "00000000-0000-4000-8000-000000000004",
      "signer": {
        "spool": {
          "ssh_alias": "operator@127.0.0.1",
          "ssh_key": "/srv/private/crq-spool-key"
        }
      }
    },
    "repair": {
      "enabled": false,
      "cq_bin": "/srv/crq-runtime/dist/cli.js",
      "paseo_host": "127.0.0.1:6767"
    }
  }
}
```

`promotion.signer.spool.dir` is an optional host path, and
`promotion.alert_agent_id` optionally overrides the committed alert recipient with
a lowercase Paseo agent UUID; all other config leaves above are required. The spool key may retain its accepted `~/` spelling; other
paths are absolute. The runtime clone and worktree root must be separate from the
deployment clone.
The overlay also supplies the fleet-reader's source host and absolute source path;
`fleet-reader.py --overlay /private/host.json` reads only that summary via SSH.
Render launchd templates with `preview`; install from a retained detached toolkit
checkout on the reader host, so its adjacent `prepare-host.py` remains available.
The reader host has its own private overlay and checkout paths.

## Rendering and evidence

Use a dedicated full cq-toolkit clone, fetched anonymously from
`https://github.com/camerontaylor/cq-toolkit.git`, never the review runtime clone.
Never `git pull` the deployment clone. Fetch, verify the full SHA is reachable
from `origin/main`, and verify its owner-approved annotated
`crq-runner/YYYYMMDD-N` tag peels to that SHA. This tool does not create tags.
Targets must descend from import C (`f748fd43`); earlier rollback needs the
separate, recorded old-runner rollback below. Targets must also provide relocated
unit templates: every service/path template must contain `@CRQ_ROOT@`. Import-era
targets with legacy unit paths are refused before checkout. Keep the checkout detached.

The helper reads `HEAD:apps/crq-python/config.json`, never the generated working
copy. The rendered bytes retain the existing indent-2 JSON plus newline format.
Every successful render writes a private schema-1 audit record with full source
SHA, exact overlay-byte SHA256, rendered-config SHA256, operation and timestamp.
Records describe render intent (not proof that units started) and are atomic
mode-0600 files; installed units also have recorded hashes.
Keep them with the private deployment record in toolkit-research `plans/`,
alongside tag/reachability evidence, pre/post file hashes and runner Git status.
Do not commit the overlay, generated config, unit output or host records publicly.

Offline preparation evidence (temporary, detached clone only):

```sh
python3 apps/crq-python/ops/prepare-host.py --overlay /private/host.json preview --output /private/preview
systemd-analyze --user verify /private/preview/systemd/crq-*
```

The focused test renders a temporary detached monorepo fixture and runs that
verification when systemd is available (Linux CI). macOS skips only the systemd
binary check. `preview` never writes checkout config, markers or installed units.
Templates contain `@CRQ_ROOT@`; never install them without rendering.

## First monorepo deploy: owner-operated root move

1. The chancellor records read-only hashes of the old live config and `.bak`;
   these provisional hashes do not authorize a render or a live edit.
2. Stop tick/watchdog timers and records service; repair units remain disabled.
   Wait for tick inactivity and drain exact owned reviews using author recovery:
   neither `alive` nor `ambiguous` runs may migrate. Hold the OLD tick lock through
   the state snapshot, transfer and old-root inert marker.
3. Use the P2 helper from a retained checkout, with a **legacy** private overlay
   containing the accepted old prepare overrides, to run `legacy-check
   --legacy-root /private/old-runner`. It reads accepted `0e35cd11:config.json`,
   requires the old checkout's HEAD to equal that accepted commit,
   computes its host rendering in memory/temp, permits only `merges_trigger` 5→1,
   and byte-compares old live config. Any other drift refuses. It never writes
   old config, locks or markers. Retain its audit and the `.bak` privately, then
   remove `.bak` from the old checkout as an explicit owner migration step.
4. Snapshot/copy drained `state/` to the new detached deployment root. Keep the
   old checkout at `0e35cd11`, inert, throughout the observation window. Preserve
   state bytes; do not copy host locks. A cross-host flock is not an ownership
   fence. The sanctioned first rollback uses the recorded old live config,
   never a re-render of old committed policy.
5. With the NEW overlay, run `prepare --tag crq-runner/YYYYMMDD-N
   --units-output "$HOME/.config/systemd/user"`. It refuses active units,
   renders relocated units, verifies them, records hashes, writes config and an
   inert marker, then reloads the user manager. It never starts/enables anything.
   The target's `dispatch_after_min` 20→0 is an intended C change, not old-root
   drift. The installed signer and its files/units/keys are untouched.
6. The owner removes the NEW inert marker and starts records/tick/watchdog only
   after approving evidence. Acceptance requires `last_tick` to advance for TWO
   consecutive slots in the new-root heartbeat/summary. Exit 0 alone proves no
   progress. Repair activation is separate, requiring spend authorization and
   provider credentials privately; these are not model-free handover prerequisites.

No spool probes are authorized by this document. Any new probe requires separate
recorded owner authorization. Retain the heartbeat endpoint confirmation from the
old handover as evidence, without inventing new live evidence.

## Controller wrapper (Q7, #395) — proposed, offline-tested only

`ops/deploy-controller.py` wraps (never replaces) the helper's `switch` with
observable, fail-stopped steps. It is not deployed and grants no new
authority: the owner approval, tag and target requirements of this document
are unchanged, and the controller starts nothing.

One JSON artifact on stdout, narration on stderr; exit 0 switched/healthy,
1 health observation failed, 2 refused before helper entry (deployment surfaces
unchanged), 3 `recovery_required` (mutation occurred or cannot be excluded).
Exit 3 emits structured recovery evidence on stdout and narration on stderr; it
never claims the switch was undone. The controller lock
is `state/controller.lock`, distinct from the runner's tick lock.

```sh
# Preflight, drain, helper switch, preservation, journal:
python3 /srv/crq-deploy/apps/crq-python/ops/deploy-controller.py --root /srv/crq-deploy \
  --overlay /private/host.json --record-dir /private/crq-deploy-records \
  switch --sha FULL40SHA --tag crq-runner/YYYYMMDD-N
# After the owner starts units (this document, step 6):
python3 /srv/crq-deploy/apps/crq-python/ops/deploy-controller.py --root /srv/crq-deploy \
  --overlay /private/host.json --record-dir /private/crq-deploy-records \
  health --interval-seconds 1500
```

Ordering and guarantees:

1. **Preflight** — full 40-hex target SHA, annotated `crq-runner/` tag peeling
   to it; prior HEAD/config digests retained; reachability, drift and
   stopped-unit checks are the helper's own (they run inside its `switch`).
   The owner must provision a durable, private mode-0700 record directory before
   invoking the controller. The controller never creates it or missing ancestors;
   absence, wrong type/mode and ambiguous prior annotated tags refuse before
   helper entry. A private mode-0600 recovery intent is atomically written and its
   file and existing record directory synced before any helper call.
2. **Drain** — every queue item with a recorded run is probed with the
   runner's own fail-closed `crq.run_liveness` from the same checkout.
   `alive` or `ambiguous` blocks the controller; it never signals or kills a
   process (exact owned-PID drain means: verified-none, not a sweep). Drain
   live/ambiguous work through the documented author-recovery path first.
3. **Switch** — the helper's `switch` runs unchanged, under its tick lock and
   drift fence.
4. **Preservation** — `state/queue.json` (items, starts, author_requests,
   author_observations) and `state/heartbeat.json` must be byte-identical
   across the switch; any difference after helper entry requires owner recovery
   with the affected file names. State is never restored, migrated or rewritten
   by the controller.
5. **Rollback compatibility** — recorded before and after: automatic
   rollback is permitted only when the queue carries **no explicit
   `schema_version` marker at all** (presence is recorded as the boolean
   `schema_marker_present`; the marker's VALUE is never interpreted, so even
   an explicit `"unmarked"` or unknown string is an explicit marker), no
   `author_*` state keys, and a readable queue — the one shape the recorded
   prior target is known to read. A present marker of any value, `author_*`
   keys, an unreadable queue, a missing/unchecked record, or a malformed
   presence field (only literal boolean `false` proves absence) disables
   automatic rollback — fail stopped with an explicit operator recovery
   action, never an old-snapshot restore or an incompatible binary start.
6. **Health** — `health` requires the runner's completion heartbeat to
   advance for TWO consecutive observations (strictly increasing UTC
   timestamps; one slot seen twice is not two slots). `crq.py` assigns and
   saves `queue.last_tick` before status publication and replaces the
   completion heartbeat (`WATCHDOG_HOME/heartbeat.json`, resolved as
   `$XDG_STATE_HOME/crq` or `~/.local/state/crq`) only afterward, so
   advancing queue saves are intermediate evidence and never count. The
   heartbeat must name this checkout's `apps/crq-python` runner root and a
   strict UTC `YYYY-MM-DDTHH:MM:SSZ` tick; a missing, unreadable,
   malformed or other-checkout heartbeat refuses assessment. Up to ten
   `state/runs/*/meta.json` receipts are sampled for readability. Tick
   advancement, service health and receipt readability are distinct
   checks; advancement alone is not acceptance.

The deploy journal (schema 1) is the only validated rollback input: it
records `prior_head`, the prior target's own annotated approval tag
(`prior_tag`), and the compatibility evidence at the top level. When no
annotated tag names the prior target, `prior_tag` is recorded null and the
rollback refuses (the owner approves and supplies the artifact); rollback
never guesses a tag. A malformed recorded `run` on a queue item blocks the
drain as ambiguous: only a genuinely absent/unstarted run (no `run` key or
the runner's explicit `run: null` marker) is skipped, so no switch proceeds
without an absence proof for every recorded run.

Schema-1 records add `transaction_id` and `outcome` without changing legacy
completed journal inputs. Before entering the helper, a `deploy_pending` or
`rollback_pending` intent retains the prior HEAD/config/preserved-state digests,
prior approval tag and intended target/tag. Once the helper is entered, even a
config-only partial failure with unchanged HEAD requires owner recovery. Any
helper, preservation, compatibility or completion-write exception produces
`recovery_required`/exit 3 with that identity. The controller attempts to replace
the intent with a recovery record; `record_persisted: false` plus
`record_write_error` explicitly reports a failed final update, retaining the
original intent when atomic replacement fails. Keep the stdout receipt privately
if record storage is unavailable. Do not rerun blindly, restore queue snapshots,
or infer automatic rollback permission from a pending/recovery receipt.

A completed journal is written only after the checks and durable completion
write succeed. Pending/recovery/unknown outcomes are not rollback inputs;
verified legacy schema-1 completed deploy journals remain accepted. A journal
entry (mode 0600, private record directory) records every completed deploy or
rollback. Rollback reuses the same helper fence with the
recorded prior target and prior tag; a fresh-target switch to a different
commit is a new deployment, not a rollback.

## Subsequent deploy and rollback

Stop timers/records and wait for tick inactivity before invoking `switch`.
The stopped-unit check includes installed and loaded `crq-*` units, including
obsolete units absent from the selected checkout. Keep a reviewed copy of the
P2 helper outside the checkout; pre-P2 targets with legacy unit paths require
the separate owner-operated old-runner rollback, rather than this switch.

```sh
python3 /retained/prepare-host.py --overlay /private/host.json switch --sha FULL40SHA --tag crq-runner/YYYYMMDD-N
```

The helper verifies tag and `origin/main` ancestry without fetching. Under one
nonblocking tick lock it rechecks stopped units, renders CURRENT SHA + overlay
into a temporary file, and compares every byte with live config. Drift reports
field names only and refuses before restore/checkout. Resolve drift by an approved
overlay/repository change and a recorded render, never by editing live JSON.
It refuses other dirty/untracked files; restores tracked config; requires a clean
Git status; checks out detached; records and atomically re-renders target config;
and requires status to show only ` M apps/crq-python/config.json`.
The same protocol applies to rollback. State is ignored and retained in place.

`--live-config` (alias `live-config`) performs only a recorded, locked config
re-render, with no marker/unit changes. It is not a checkout-switch shortcut and
is never authorized on the old checkout. During a switch, the same render stays
inside the already-held tick lock. If anything fails after checkout, leave units
stopped, preserve the private records and recover with the owner; do not start an
unverified candidate. Reinstall/verify changed unit templates from the target
before owner restart. The owner starts units only after reviewing config and unit
hashes plus Git status; then confirms completed heartbeat slots.

## P2 review deferrals and protection

This replaces the stale W5 lease/test suspension in `coverage.md`, distinguishes
the completed cross-host handover from current deployment, removes its unapproved
spool probes, and makes repair credentials optional for model-free handover.
Under the proposed deployed-system protection narrowing (#328), P2 still touches
protected `ops/prepare-host.py`, `ops/systemd/*` and `config.json`. The renderer
and switch guard stay within the protected helper. No signer byte changes.

## Background ledger publication

Render/install `crq-publisher.service` and `crq-publisher.timer` through the same
immutable-target unit renderer. The timer retries every minute after completion;
activation remains part of the owner-controlled deployment. Stop/drain this worker
with the other `crq-*` units before a checkout switch.

Ticks only write `state/backfill/publish-request.json`. The worker uses its own
`state/backfill/publisher.git` bare clone and `publisher.lock`, but retains the
normal `state/backfill/publication` outbox and durable artifact locations. It
performs network publication and finding recovery outside `tick.lock`, then reloads
the current queue for local acknowledgement bookkeeping. `backfill.py publish`
invokes this same worker and lock. No queue snapshot is restored.

Pending records and reconciliation intent survive failed pushes and crashes after
remote acknowledgement. The timer scans pending records even without a request
marker. `backfill_publication_error` reports a failed attempt; retry clears it only
after verified remote reconciliation. Pending/live jobs retain ownership. The
45-minute worker limit bounds each invocation without deleting pending evidence.
Publication failures also retain `publication-failure.json`, which blocks new
rank-4 admissions even when the queue lock is busy. Only successful validated
queue reconciliation clears it. Operation-tagged inventory/request halts recover
only after that operation succeeds; unrelated or unclassified legacy halts remain
for operator reconciliation. A busy queue lock never reports publication reconciled.
