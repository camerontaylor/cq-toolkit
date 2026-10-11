# Supported author enrollment and shared quota (held, not used)

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

## Harvest: real evidence, no side effects

A completed author review keeps genuine cycle evidence (run id, base, head,
completion time, findings and severity counts) under `author_cycles`. It is
deliberately NOT stored under `cycles`, which `repair_tick.backfill` scans, so a
supported author review never creates repair debt. It also earns no promoted
coverage path credit: author paths are branch-only and are not written to the
coverage ledger.

## Crash recovery (fail closed)

Before harvesting, a detached author run is probed by runner pid, CLI pid AND the
recorded process group, which covers the spawn-before-PID-persist window (a live
CLI whose `cli_pid` has not yet been written). Then:

- terminal exit evidence present → harvest normally;
- a matching runner/CLI process or the recorded process group is live → retain,
  the item stays `reviewing`;
- no pidfile and nothing verifiable → AMBIGUOUS: retain capacity and require
  owner disposition. There is no TTL that can release a live or unverifiable run;
- provably gone with no exit evidence → a DISTINCT terminal (`author_failed`);
  the start stays consumed, there is NO automatic retry.

A failed spawn (Popen/OSError) is likewise a consumed, distinct terminal
(`author_failed`, `spawn_failed` event) with no automatic retry; the start was
persisted before the child, so nothing is silently re-spent. Non-author kinds
keep their previous behaviour.

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
silent replay. The review command remains
`coderabbit review --agent --base-commit <base>`. This source approval is not a
deployment, an enrollment, or a model dispatch; no author command is run by this
change.
