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

`notify.hosts` is an optional private overlay list of at most 32 host:port
strings (DNS/IPv4 host up to 253 characters, port 1..65535). It renders over the
committed empty allowlist; no destination is accepted by default. At D-1 set the
approved worker endpoints in the private overlay (triton:6767, uranus:6767 and
pluto:6767 for the current fleet). Null/local-daemon entries are not supported by
the deployment overlay. Missing SDK host labels therefore remain unsupported.

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
    "notify": {"hosts": ["worker.example.invalid:6767"]},
    "alerts": {
      "alert_agent_host": "worker.example.invalid:6767",
      "alert_agent_id": "00000000-0000-4000-8000-000000000004"
    },
    "repair": {
      "enabled": false,
      "cq_bin": "/srv/crq-runtime/dist/cli.js",
      "paseo_host": "127.0.0.1:6767"
    }
  }
}
```

`alerts.alert_agent_id` optionally overrides the committed alert recipient with
a lowercase Paseo agent UUID; `alerts.alert_agent_host` supplies the host
endpoint, and all other config leaves above are required. The runtime clone and
worktree root must be separate from the deployment clone. The renderer maps the
alert leaves back onto a pre-Phase-0.1 target's `promotion` block so a rollback
still delivers alerts.
An overlay written for a pre-Phase-0.1 deployment may keep its
`promotion.record_url_template`, `promotion.alert_agent_*` and
`promotion.signer.spool.*` leaves. They let `switch` reproduce the live source
config byte-for-byte for its drift check; the new config keeps the alert
recipient and ignores the retired template and spool values. Remove them after
the source has switched.
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

One JSON artifact on stdout, narration on stderr; exit 0
switched/healthy/recovered, 1 health observation failed, 2 refused with
deployment surfaces unchanged (before helper entry, or a helper refusal
recorded as `refused_no_change`), 3 `recovery_required` (mutation occurred or
cannot be excluded).
Exit 3 emits structured recovery evidence on stdout and narration on stderr; it
never claims the switch was undone. The controller lock
is `state/controller.lock`, distinct from the runner's tick lock. The
controller creates it mode 0600 and normalises an existing lock it owns to
0600, never trusting the ambient umask; the live binding refuses a group- or
world-writable lock.

Helper identity: the controller reads `--helper` (default
`<root>/apps/crq-python/ops/prepare-host.py`) once, computes its sha256 and
executes exactly those bytes. The digest is `helper_sha256` in the switch and
rollback stdout artifacts and in every intent, recovery, deploy and rollback
journal. The optional global `--expect-helper-sha256 HEX64` pins the reviewed
helper: a mismatch (or a value that is not 64 lowercase hex) refuses with exit 2
before the helper is imported, before the controller lock and before preflight.
Order: identity check, then lock, then preflight.

```sh
# Preflight, drain, helper switch, preservation, journal:
python3 /srv/crq-deploy/apps/crq-python/ops/deploy-controller.py --root /srv/crq-deploy \
  --overlay /private/host.json --record-dir /private/crq-deploy-records \
  --expect-helper-sha256 REVIEWED_HELPER_SHA256 \
  switch --sha FULL40SHA --tag crq-runner/YYYYMMDD-N
# After the owner starts units (this document, step 6):
python3 /srv/crq-deploy/apps/crq-python/ops/deploy-controller.py --root /srv/crq-deploy \
  --overlay /private/host.json --record-dir /private/crq-deploy-records \
  health --interval-seconds 1500
# Recover one retained pre-activation unit intent (see below):
python3 /srv/crq-deploy/apps/crq-python/ops/deploy-controller.py --root /srv/crq-deploy \
  --overlay /private/host.json --record-dir /private/crq-deploy-records \
  --expect-helper-sha256 REVIEWED_HELPER_SHA256 \
  recover --record /private/crq-deploy-records/controller-FULL32HEX.json
```

Ordering and guarantees:

1. **Preflight** — full 40-hex target SHA, annotated `crq-runner/` tag peeling
   to it; prior HEAD/config digests retained; reachability, drift and
   stopped-unit checks are the helper's own (they run inside its `switch`).
   The owner must provision a durable, private mode-0700 record directory before
   invoking the controller. The controller never creates it or missing ancestors;
   absence, wrong type/mode and ambiguous prior annotated tags refuse before
   helper entry. A private mode-0600 recovery intent is atomically written and its
   file and existing record directory synced before any mutating helper call, but
   only after the pure validators in step 3 pass.
2. **Drain** — every queue item with a recorded run is probed with the
   runner's own fail-closed `crq.run_liveness` from the same checkout.
   `alive` or `ambiguous` blocks the controller; it never signals or kills a
   process (exact owned-PID drain means: verified-none, not a sweep). Drain
   live/ambiguous work through the documented author-recovery path first.
3. **Switch** — first the controller calls the helper's own pure validators
   (`root_check`, `verify_target` with its full `crq-runner/YYYYMMDD-N` tag
   match and annotated-tag binding, and the destination `render`); they are
   read-only helper calls. A bad tag or target is a plain exit-2 refusal with
   no record and no change. The controller's own tag check is also a full
   match now. Only then is the durable recovery intent written (the
   `deploy_pending`/`rollback_pending` record described below), and the
   helper's `switch` runs unchanged, under its tick lock and drift fence. An
   interruption during validation therefore leaves no intent to replace or
   clear; one after the write is replaced by its recorded outcome.
4. **Preservation** — `state/queue.json` (items, starts, author_requests,
   author_observations) and the runner's completion heartbeat
   (`WATCHDOG_HOME/heartbeat.json`, resolved as `$XDG_STATE_HOME/crq` or
   `~/.local/state/crq` — the same file the health check reads, never a
   state-directory copy) must be byte-identical across the switch; any
   difference after helper entry requires owner recovery with the affected
   file names. State is never restored, migrated or rewritten by the
   controller.
5. **Rollback compatibility** — recorded before and after: automatic
   rollback is permitted only when the queue carries **no explicit
   `schema_version` marker at all** (presence is recorded as the boolean
   `schema_marker_present`; the marker's VALUE is never interpreted, so even
   an explicit `"unmarked"` or unknown string is an explicit marker), no
   `author_*` state keys, and a readable queue — the one shape the recorded
   prior target is known to read. A present marker of any value, `author_*`
   keys, an unreadable queue (missing `queue.json`, invalid JSON, a non-object
   root such as `null`/`[...]`/a string, or a non-array `items` — the same
   evidence the drain refuses), a missing/unchecked record, or a malformed
   presence field (only literal boolean `false` proves absence) disables
   automatic rollback — fail stopped with an explicit operator recovery
   action, never an old-snapshot restore or an incompatible binary start.
6. **Health** — `health` requires the runner's completion heartbeat to
   advance for TWO consecutive observations (strictly increasing UTC
   timestamps; one slot seen twice is not two slots). The first observation
   polls every five seconds for up to `--first-tick-timeout-seconds` (default
   1500: one 20-minute cadence plus five minutes of slack), so a just-switched
   runner can finish its first tick. Timeout remains unhealthy. Subsequent
   observations sleep the required `--interval-seconds` before sampling; that
   is a fixed delay rather than polling, so choose at least one runner cadence
   plus slack (the runbook uses 1500). `crq.py` assigns and
   saves `queue.last_tick` before status publication and replaces the
   completion heartbeat (`WATCHDOG_HOME/heartbeat.json`, resolved as
   `$XDG_STATE_HOME/crq` or `~/.local/state/crq`) only afterward, so
   advancing queue saves are intermediate evidence and never count. The
   heartbeat must name this checkout's `apps/crq-python` runner root and a
   strict UTC `YYYY-MM-DDTHH:MM:SSZ` tick; a missing, unreadable,
   malformed or other-checkout heartbeat refuses assessment. Each
   observation also carries two independent receipt verdicts that never
   change `healthy` or the exit code (a bad sample is not a tick failure):
   - `receipts_readable` — the ten most recently modified run directories
     under `state/runs` have a `meta.json` that parses as JSON. A directory
     holding only `secret-scan.json` (and `context-secret-scan.json`) is a
     review stopped before launch (blocked secret scan or refused checkout,
     which `crq.py` records before `meta.json`); it is counted as
     `prelaunch`, not as unreadable. Any other missing or corrupt entry is
     listed by run name and reason under `receipts.unreadable`.
     Non-directory entries (for example AppleDouble `._*` copies) are not
     runs: they are counted as `ignored_entries` and never sampled;
   - `receipts_valid` — the ten most recently modified retained
     `state/receipts/<sha256>.json` receipts validate against their own
     family. All families first prove content identity. Merged-current and
     push-range receipts (`crq.current_document`) check the stable v1
     receipt schema (`review_receipt.py`, TS `QueueReceiptSchema`): run
     identity (`item_id`, well-formed `run_id`), captured target (source
     binding, 40-hex `capture.target`/`tree`, matching scope digest) and
     terminal outcome (a counted receipt needs a completed, classified run).
     A merged-current source names a PR, merge SHA and target selector; a
     push-range source names 40-hex `base`/`head` and may carry a split
     part's `paths_filter`/`pin`, and only push captures may contain
     `deferred-split` rows. Policy, version and target selectors come from
     this deployment's own `review_receipt.py`/`runtime_target.py`, parsed
     read-only (never executed); if they are unusable the builtin copy is
     used. `local-review-full-diff` receipts are checked against the
     `receipt` variant of this deployment's
     `policy/review-operation.schema.json` (read as data), plus their
     identity digest and outcome/scope consistency; without that file they
     are reported as unverified, never accepted. Any other `kind` is an
     unsupported family. `receipt_validation.schema_source` and
     `local_review_schema_source` record which sources were used, and why;
     `families` counts the sample by family, and each invalid receipt
     carries its family and reason.
   Each verdict is `true`, `false`, or `null` when nothing was sampled; the
   top-level artifact repeats both, aggregated across observations. Tick
   advancement, receipt readability and receipt validity are distinct
   checks; advancement alone is not acceptance.

### Unit switch and unit recovery

`switch --unit UNIT --runtime RUNTIME` and `recover --record PATH` are the
per-unit entry points. Both compose the same production adapter through
`ops/unit-live-binding.py` under the controller's own lock; tests replace only
the systemd, journal and identity ports. Neither path has run against a live
host, and neither enables production use.

`recover --record` consumes one retained `controller-<32hex>.json` unit record
whose `operation` is `unit_switch`, whose outcome is `pending` or
`recovery_required`, and whose `snapshot.runtime` equals its recorded
`prior_runtime`. The unit and prior runtime come from that record, validated
under the lock: there is no caller-supplied unit or runtime and no second
record read. The controller composes the adapter for the **prior** runtime,
because the abandoned target's artifact may no longer be installed and the
retained snapshot is authoritative for the bytes, modes, ownership and
activation that are restored. A composition failure (unavailable binding,
unverifiable artifact, missing completion witness on this checkout) is an
ordinary refusal before any unit mutation or journal write.

Exit codes for `recover`:

* 0 — recovery completed. The record is now `outcome: rolled_back` at the
  `restore_activation_pending` phase, and stdout is exactly that persisted
  record.
* 2 — refused with no unit or record change: unreadable, malformed,
  unsupported-schema or incoherent record, a record outside `--record-dir`, an
  unfinished checkout or other unit transaction, live/ambiguous queue-owned
  work, or adapter composition failure. stdout is the usual `error` artifact.
* 3 — activation ambiguity. A record at `activation_pending` or
  `restore_activation_pending` is not recovered automatically: the controller
  still stops and drains the unit's owned work, prints the retained record with
  `record_path` and `reason` on stdout, and leaves the record bytes unchanged.
  Inspect runtime evidence before deciding what happened.

`recover` adds no automatic recovery path, boot hook, retry, flag, store or
lock. Unit records are retained: only the pending intent is replaced by its
terminal outcome, and no completed or rolled-back record is rewritten.

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
completed journal inputs. The `deploy_pending`/`rollback_pending` intent IS the
mode-0600 recovery intent from step 1: it is written after the pure validators
and immediately before the mutating helper, never before validation. It retains
the prior HEAD/config/preserved-state digests,
prior approval tag and intended target/tag, plus the checkout status and the
installed CRQ user units (`$XDG_CONFIG_HOME/systemd/user/crq-*` and
`*.wants/crq-*` links). If the helper raises and the controller then observes
HEAD, rendered-config bytes, checkout status, units and preserved state all
equal to that identity, the intent is replaced with `outcome:
"refused_no_change"` (`operation: deploy_refused`/`rollback_refused`) carrying
the `observations`, and the controller exits 2. The same evidence is printed
on stdout (`record_persisted`, plus `record_write_error` if the journal
update failed and the pending intent was retained). Nothing needs clearing before a
corrected rerun, and the record is never a rollback input. Any changed or
unobservable surface (even a config-only partial failure with unchanged HEAD)
still requires owner recovery: any such helper exception, and any
preservation, compatibility or completion-write exception, produces
`recovery_required`/exit 3 with that identity. The controller attempts to replace
the intent with a recovery record; `record_persisted: false` plus
`record_write_error` explicitly reports a failed final update, retaining the
original intent when atomic replacement fails. Keep the stdout receipt privately
if record storage is unavailable. Do not rerun blindly, restore queue snapshots,
or infer automatic rollback permission from a pending/recovery receipt.

Records are never rewritten after their outcome is final (only the pending
intent is replaced by its outcome). A single symmetric preflight classifies
every `controller-*.json` record by its producer-specific operation, outcome and
minimum identity. `deploy_pending`/`rollback_pending` and pending or
recovery-required unit switches block both seams. Completed `deploy`/`rollback`
(including the first producer's outcome-less completed journals),
`deploy_refused`/`rollback_refused`, and completed/rolled-back unit switches are
history and do not block. A `recovery_required` record is not history even when
its retained `prior_state` still matches HEAD, config bytes, checkout status,
installed CRQ user units and preserved state: those digests do not cover unit
metadata, activation or live work, so a recovery record remains unfinished (or
an unsupported legacy record when its producer identity is incomplete).
Classification reads only the record, so a later unrelated transaction cannot
turn accepted history into a blocker. `recover_unit` excludes exactly the record
it is recovering. Every pre-existing record's bytes are unchanged. The guard
still only sees the supplied `--record-dir`; a second directory and older
binaries can bypass it, and the lock is checkout-local. Production
reconciliation of the actual record root and old callers remains parent-owned.

A completed journal is written only after the checks and durable completion
write succeed. Pending/recovery/unknown outcomes are not rollback inputs;
verified legacy schema-1 completed deploy journals remain accepted. A journal
entry (mode 0600, private record directory) records every completed deploy or
rollback. Rollback reuses the same helper fence with the
recorded prior target and prior tag; a fresh-target switch to a different
commit is a new deployment, not a rollback.

## Deploy runbook (crq-efficiency plan slice 4) — tracked, offline-tested

`ops/deploy-runbook.py` is the tracked sequence the audited deploy wrappers
(`deploy-9e18.py`, the F4-fixed `deploy-ac13-f4fix2.py`) implemented by hand
on the deploy host. It imports `deploy-controller.py` and `prepare-host.py`
from the candidate artifact root and owns only the sequence and assertions:
validate before any host read, observe then split the long triggers, hold
(marker `O_EXCL`, run-unique bytes), 180-second service drain then a bounded
controller `drain_check` poll (15 s interval, 900 s deadline, fail safe on
expiry: hold retained, nothing killed), the controller `switch` subprocess,
pointer render, F4 restore (start exactly the triggers `self.original`
recorded active, assert the full pre-run map, verify the map with a second
read, persist `final_triggers` durably, remove the marker last), then
`range-note.json` with digest-pinned annotations. Failures before the hold
acquire restart exactly the triggers the split stopped (no hold, no stopped
triggers left behind; a failed restart is recorded in the recovery phase
record). The candidate helper and controller are digest-checked against the
manifest before either is imported: an import is arbitrary code execution
and must never run ahead of the reviewed pins.

A production GO names one exact file revision: `--runbook-sha256` must equal
the digest of the executing file, refusing before any host read, and the
rehearsal (`--rehearsal`, throwaway clone, fake unit provider and fake
controller journal in tests) pins the same value. The per-deploy invariant
manifest (`ops/deploy-invariants.schema.json`, validated by a stdlib checker;
unknown keys refuse) is reviewed and digest-pinned per deploy
(`--manifest-sha256`); it carries the assertion semantics that differ
between deploys: ancestry direction (`must`/`must_not`/`either`), the three
config relations, the `cq_bin` pointer policy, the trigger inventory, the
quiescence bounds and the range note.

Historical note on the ac13 ancestry refusal: the check itself
(`git merge-base --is-ancestor prior target`, and the
`target_on_origin_main` predicate requiring the target inside
`origin/main` history) was always correct. Only one refusal message string
was worded in the wrong direction ("not an ancestor" on a failure whose
real cause was something else), which misdirected the operator during the
ac13 incident. The runbook keeps the verified predicate and does not port
that message; refusals state the failed relation plainly, and the drift
message is never a substitute for reading the observations.

### Released-flag gate (operator rule)

The marker is the hold; the gate is the flag. `phase.json` is written
atomically before every systemd action with `phase`, `released`,
`final_triggers` and `journal`; `release.json` is written only after the
marker is gone and the original states are verified.

**No `systemctl start` between the hold and the gate passing:**

```sh
python3 -B apps/crq-python/ops/deploy-runbook.py \
  --target-sha FULL40SHA --target-tag crq-runner/YYYYMMDD-N \
  --candidate-root /private/artifacts/candidate \
  --prior-root /private/artifacts/running --prior-sha PRIOR40SHA \
  --prior-tag crq-runner/YYYYMMDD-(N-1) \
  --root /srv/crq-deploy --overlay /private/host.json \
  --baseline-journal /private/crq-deploy-records/controller-LAST.json \
  --manifest /private/manifests/deploy-YYYYMMDD.json \
  --manifest-sha256 REVIEWED_MANIFEST_SHA256 \
  --runbook-sha256 PINNED_RUNBOOK_SHA256 \
  --output-dir /private/crq-deploy-records/run-YYYYMMDD \
  [--annotations /private/notes/annotations.json]
# Then, before any start:
python3 -B apps/crq-python/ops/deploy-runbook.py ... \
  status --output-dir /private/crq-deploy-records/run-YYYYMMDD \
  --root /private/crq-deploy --require-released
```

`status --require-released` re-reads `release.json` and `phase.json` from
disk and refuses when they disagree, when the recorded `runbook_sha256`
differs from the digest of the executing file (a stale copy must not report
on a run it did not perform), when the run recorded no marker path, or when
`state/runner-disabled` is present again. It prints `final_triggers` and
`released_at`, not just pass/fail, so the operator's start decision carries
the nine-state map into the record. Exit 0 is the only permitted basis for
starting units; exit 1 means do not start.

Tests: `pnpm test:narrow apps/crq-python/test_deploy_runbook.py` (host-free;
fake unit provider and fake controller journal). They cover orchestration,
not launch-time re-verification: the operator alone runs the runbook against
production, and it re-reads live state immediately before each launch.

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
and requires status to show only:

```text
 M apps/crq-python/config.json
```
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

Render/install `crq-publisher.service`, `crq-publisher.timer` and
`crq-publisher.path` through the same immutable-target unit renderer. The path unit
starts the worker as soon as a record lands in `state/backfill/publication/pending`;
the timer retries every minute after completion as the fallback. Enable both
(`systemctl --user enable --now crq-publisher.timer crq-publisher.path`) as part of
the owner-controlled deployment. Stop/drain the path unit, timer and worker with the
other `crq-*` units before a checkout switch.

Ticks only write `state/backfill/publish-request.json`. The worker uses its own
`state/backfill/publisher.git` bare clone and `publisher.lock`, but retains the
normal `state/backfill/publication` outbox and durable artifact locations. It
performs network publication and finding recovery outside `tick.lock`, then reloads
the current queue for local acknowledgement bookkeeping. `backfill.py publish`
invokes this same worker and lock. No queue snapshot is restored.

Pending records and reconciliation intent survive failed pushes and crashes after
remote acknowledgement. The timer scans pending records even without a request
marker. A busy queue lock after a successful push is not a failure: the worker exits 0
with `reconciliation-pending`, keeps the request marker and retries on the next
trigger, with no failure marker or halt. `backfill_publication_error` reports a failed attempt; retry clears it only
after verified remote reconciliation. Pending/live jobs retain ownership. The
45-minute worker limit bounds each invocation without deleting pending evidence.

Publication failures also retain `publication-failure.json`, which blocks new
rank-4 admissions even when the queue lock is busy. Only successful validated
queue reconciliation clears it. Operation-tagged inventory/request halts recover
only after that operation succeeds; unrelated or unclassified legacy halts remain
for operator reconciliation. A busy queue lock never reports publication reconciled.

### Backfill coverage snapshots

Rank-4 selection (slot and tick, under `tick.lock`) never computes ledger coverage:
that costs minutes of Git work per target. It reads
`state/backfill/coverage/<target>.json`, which records coverage over a prefix of
the ledger's events. A snapshot stays valid at a later ledger head when the appended
events hold no creditable review, which is true for state and finding events, the
common head moves. A missing or stale snapshot leaves its jobs waiting with
`coverage snapshot pending off-lock refresh` and writes
`state/backfill/coverage-request.json`.

After each publication run, the same `crq-publisher.service` invocation refreshes
snapshots (`backfill_coverage.run`, under `state/backfill/coverage.lock`, not
`tick.lock`) when a request marker exists or publication moved the ledger head. It
folds only the appended events into each pending target's snapshot, retries
earlier gap reviews, recomputes in full only for a new target or a non-extending
sequence, and deletes snapshots that no live job uses. Gap targets are requested
again on every selection pass, so a transient gap retries after the next
selection pass (at most one quota-paced tick, 12 min, when nothing is admissible). The
refresher reads the ledger through the publisher's private clone under
`publisher.lock`. Evidence is verified when a review is folded, not again per
pass. Snapshots are derived state; deleting the directory is safe, and the next
request rebuilds it.

A cold refresh (new inventory target, or no snapshots after a deploy) delays
the next publication run by its duration; measured on the queue host 2026-11-03 (7
targets, 17 creditable reviews, load ~14) at 124 s for all targets, about 1.3 s
when nothing changed. A refresh that can change admission (a snapshot selection
rejected becomes valid, credit grows, or a gap clears) writes `next-review-at` =
now, so the next slot re-evaluates instead of waiting for its quota-paced
deadline; a still-failing gap retry or a state-only head move does not. Refresh
errors are isolated per target, and the worker still journals the publication
result before exiting non-zero. `inventory_mode: "integrated"` still runs
inventory coverage inside the tick and is outside this guarantee (#968); the queue host
uses `timer`. Permanent gaps are retried off-lock once per selection
pass that requests them (restored once per refresh run, not per target), and a
still-failing retry wakes nothing.
