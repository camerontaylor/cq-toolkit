# Supported author enrollment and shared quota (held, not used)

## Opt-in lease arbitration (P3; no deployment)

Run these commands from `apps/crq-python` in the monorepo. This ports the
accepted standalone lease change `798a5ebc` onto the imported runner; it does
not activate requests, change installed signer bytes, or authorize deployment.

The legacy commands below retain their existing arguments, output and state
when leases are not requested. To opt a **new** author request into leases, add
`--review-policy <JSON-file> --fallback-reviewer <configured-agent-identity>`
to `author-enroll`. Both are required together. The file must contain a positive
integer at `review.reviewerTimeoutMin`; no default is substituted from
`review_timeout_min`. Provider/model choice belongs to the caller's configuration.
The reviewer identity is immutable for that request; no provider/model is chosen
by this code. Only commit subjects are supported in P3.

The new item field is `author_lease`:

```json
{"v":1,"state":"waiting","requested_at":"2026-10-16T06:00:00Z","deadline_at":"2026-10-16T06:25:00Z","reviewerTimeoutMin":25,"reviewer":"<configured-agent-identity>"}
```

Times use the queue owner's UTC clock. Identical re-enrollment keeps the original
deadline; policy/reviewer changes on an existing request refuse. A legacy request
cannot be upgraded in place. Absent lease means legacy; malformed/unknown versions
or states fail closed. Unknown fields are retained.

Under the existing `state/tick.lock`, the natural tick can decide `waiting ->
queue` **strictly before** the deadline, immediately before its existing durable
start reservation. It rechecks after secret scan and worktree preparation. Queue
grant, start reservation and run identity are saved together before spawning;
the new lease adds `decided_at`. A queue grant is permanent even if launch fails,
is ambiguous, or outlasts the waiting timeout. Existing recovery and quota rules
remain authoritative; this is not a TTL release of a running review.

After the deadline, the caller invokes the local operator command:

```sh
python3 crq.py author-fallback --request-id <stable-id>
```

It acquires the same lock, reloads the queue, and can decide `waiting -> agent`
only for an unstarted pending admission. It persists `state:"agent",decided_at`
in the lease and tombstones the item as `skipped` before responding. Late queue
grants are refused, including after a manual requeue or clock rollback. Global
pause/cooldown do not prevent this arbitration, since it starts no CodeRabbit
review and creates no CodeRabbit quota reservation. An item blocked by the secret
scan or with dispatch evidence cannot use this escape hatch.
For opted-in items a failed scan durably adds `secret_scan_blocked:true` inside
`author_lease` v1 before returning. This permanent marker fences both queue and
agent grants even if an operator resets the item's state/error. Correct the
subject and enroll a new immutable request rather than clearing the marker.

Success is one JSON line with exactly the v1 response fields:

```json
{"binding":{"base":"<sha40>","cycle":1,"head":"<sha40>","request_id":"<stable-id>","target":"origin/merge-queue"},"deadline_at":"2026-10-16T06:25:00Z","decided_at":"2026-10-16T06:25:00Z","dispatch":true,"issuer":"agent","request_id":"<stable-id>","reviewer":"<configured-agent-identity>","v":1}
```

`issuer` is `waiting`, `queue`, or `agent`. `reviewer` is null unless assigned
to the agent; `decided_at` is null while waiting. `dispatch:true` is returned
**only by the first successful fallback claim**, never by status or replay.
`python3 crq.py author-lease --request-id <stable-id>` returns status with
`dispatch:false`. Refused/contended new commands exit 3; lock contention retains
the legacy text on stdout. Parse JSON only after exit 0, and require v1 and
`issuer:"agent",dispatch:true` before handing off to the named agent reviewer.

This is the local arbitration boundary for `dev.review`: the caller waits/polls
until the recorded deadline, then asks for fallback. The command does **not**
instantiate an agent or run an arbitrary model command. The caller launches the
configured agent once on the returned immutable binding and records its evidence;
it must secret-scan that exact range before sending it to the agent. A response
lost after durable assignment yields **no retry permission**: escalation is
required rather than an automatic second review. A transport error, waiting
status, or local timeout is never fallback authorization. Worker transport is
P4; tree snapshots are P5. Neither is delivered or activated here.

The legacy queue, observation and promotion spool schemas and request bytes are
unchanged for non-opted-in requests. `author_lease.v:1` and response `v:1` are the
only new schema versions; there is no queue-wide version bump or ledger reset.
Do not roll back to a runner unaware of lease tombstones or use owner admin
actions to bypass a permanent grant. Production input capture, 24-hour shadow
comparison and deployment/custody evidence remain future release gates.

This source adds a supported operator path for an author CLI cycle. It does not
enroll anything during installation, does not start a second scheduler, does not
change limits, does not fabricate a review cycle, and does not touch the live
queue, config, signer, units or keys. `crq.py` remains the single quota owner: an
enrolled author item is dispatched by the SAME locked natural tick, through the
same pre-upload secret scan, isolated worktree, detached `_review` child and
persist-before-child quota reservation as every natural review.

## Enroll one author cycle

After source review and, where required, desk approval, the sole tick owner may run:

```sh
python3 crq.py author-enroll \
  --request-id <stable-id> \
  --base <full-immutable-base-sha> \
  --head <full-immutable-reviewed-head-sha> \
  --target origin/merge-queue \
  --cycle <1|2>
```

The request id immutably binds base/head/target/cycle. Enrollment only creates a
PENDING author item under the existing tick lock; it never dispatches. The tick
launches it only when the ordinary gates allow, so a queued author item waits for
natural eligibility. Identical re-enrollment (same id, same binding) is
idempotent and returns the existing item. A changed binding under the same id
refuses, and a binding may be enrolled once (a second request id for the same
binding refuses) so a review cannot be double-spent. Any refusal happens before
mutation; nothing is saved.

## Priority and shared accounting

Author items are selected after the promotion and ordinary classes (open, delta,
merged) and before the lowest-priority coverage fallback, by the ordinary tick
selection loop. They never bypass the global gates: `paused`, rate-limit
`cooldown`, the rolling-hour start cap and the in-flight cap all apply, and the
secret scan still runs before any upload. Author items have no PR, so the
active-agent PR quiet gate does not apply to them. Author starts share
`queue.starts` and in-flight accounting with every natural review, so a manual
cycle and a natural coverage review cannot jointly exceed the configured
5 starts/hour or 2 in-flight.

Author enrollment is PENDING NATURAL-ONLY. A selective `crq start <author-id>`
(which would skip a pending promotion/ordinary item) is REFUSED; an explicit
`--dry-run` may still show the plan but never launches. All global gates are
still checked first, so a selective start cannot bypass the caps either.

## Harvest: real evidence, no side effects

A completed author review keeps genuine cycle evidence (run id, base, head,
completion time, findings and severity counts) under `author_cycles`. It is
deliberately NOT stored under `cycles`, which `repair_tick.backfill` scans, so a
supported author review never creates repair debt. It also earns no promoted
coverage path credit: author paths are branch-only and are not written to the
coverage ledger.

Every attempted author dispatch is a CONSUMED terminal. A non-completed outcome
(`rate_limited`, `action_required`/`auth`, `error`, `interrupted`, `skipped`,
`too_large`) marks the item `author_failed` with no automatic retry; the global
rate-limit cooldown and the global auth pause are still set, so the QUEUE pauses
or backs off even though the item does not retry. A failed spawn is likewise a
consumed `author_failed` terminal.

## Review deadline wrapper (a wall-clock guard, NOT a hard budget)

The review child runs `timeout --foreground --kill-after=60 <review_timeout_min>m
coderabbit review ...`, and the runner writes `review.pid` BEFORE spawning it
with `run_id`, a valid detached `pid`/`pgid`/`sid` and the `group_owner` protocol
marker (`foreground-v1`). GNU `timeout` semantics, verified against coreutils
9.11: WITHOUT `--foreground`, timeout moves the managed command into a NEW
process group whose pgid is the wrapper's own pid, so `review.pid`'s runner pgid
(written before the child is spawned) does NOT cover the running review; a runner
killed between Popen and the `cli_pid` write leaves the recorded group empty while
the review lives in an unrecorded group (a false "gone"). WITH `--foreground` the
whole review (wrapper + direct child) stays in the runner's own group, so the
pre-recorded pgid always covers a live review. This requires GNU coreutils
`timeout` (already required by `--kill-after`).

Deadline semantics: SIGTERM at `review_timeout_min` (GNU timeout then exits 124);
`--kill-after=60` SIGKILLs the direct child 60s later (which can surface as 137).
The child records `timed_out` for a wrapper exit in (124, 137); a 137 can ALSO be
an external KILL, so the deadline is not independently proved as the cause and no
timeout reason is inferred. `--foreground` signals the DIRECT child only. A
descendant that creates its OWN session/group escapes both the deadline and the
group probe: that is an explicit, UNTRACKED residual, not a retained-capacity
guarantee (proving ownership of an escaped group would need cgroups/units, which
are out of this scope). This is a review wall-clock guard. It is NOT a repair
hard-budget or a spend proof, and no such proof is claimed here.

## Crash recovery (fail closed, shared by author and natural runs)

Before harvesting, a detached review is probed by runner pid, CLI pid and every
process group that can own it, and the decision is consulted even when a terminal
`exit.json` exists. No absence is ever asserted without proof:

- MANAGED identity (`group_owner: foreground-v1`): the runner's own group owns the
  whole review.
- LEGACY identity (a valid pid+pgid with NO marker, i.e. a pre-upgrade launch):
  BOTH the recorded runner group AND the recorded `cli_pid` AS a group are probed
  (GNU timeout's default wrapper group, even after the timeout pid itself dies).
  A legacy pidfile with no `cli_pid` is incomplete ownership evidence.
- a matching runner/CLI process or ANY probed group live → retain; the item stays
  `reviewing`, and a terminal artifact plus a live group WAITS (never released
  over a possibly-live process);
- RETAIN (ambiguous, owner disposition, never a TTL release): a missing/malformed
  identity, ANY missing exit artifact (a crash without terminal evidence never
  asserts absence), or a legacy launch with incomplete ownership evidence. This
  replaces the old 60s "just launched" release window for BOTH kinds;
- HARVEST (the only release): a terminal `exit.json`, a valid run-bound identity,
  COMPLETE ownership evidence (managed, or legacy with both groups known and
  empty) and nothing alive.

A run that is merely unverifiable is retained, never converted to a terminal; the
only author terminal states are the consumed dispatch outcomes above. A `crq tick
--dry-run` performs no harvest mutation and appends no events.


## External observation (mechanism only; exact use needs desk approval)

A historical author invocation that CRQ never admitted can be charged to the
rolling hour only through explicit evidence, never by pretending cycle 1 was
admitted:

```sh
python3 crq.py author-observe <observation-manifest.json>
```

The manifest binds `request_id`/`base`/`head`/`target`/`cycle`, a `started_at`
within the rolling hour, and a non-empty `artifacts` list of `{path, sha256}`.
Every artifact must be a regular file whose bytes hash to the declared digest.
`reserved` must be false or absent. The charge is append-only: it appends the
`started_at` to `queue.starts` and a `reserved=false` record to
`author_observations`, and never creates a counted cycle or rewrites history.
Repeated identical observations are idempotent. Do not run this without desk
approval of the exact artifacts and timestamps.

## Boundary

Enrollment and observation are the only supported author entries; there is no raw
CLI bypass, no `--use-credits`, no limit/cooldown/promotion exception and no
silent replay. The natural review argv is unchanged
(`coderabbit review --agent --base-commit <base>`); an author cycle reviews the
committed base..head on a clean worktree with the supported `--committed`. This
source approval is not a deployment, an enrollment, or a model dispatch; no author
command is run by this change.
