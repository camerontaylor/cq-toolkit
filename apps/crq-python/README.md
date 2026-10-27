# CodeRabbit queue (crq)

crq is the single consumer of the CodeRabbit CLI quota for cq-toolkit. The
script schedules, reviews, verifies and publishes; models only judge and repair.
Local ops tooling: changes are committed locally rather than opened as PRs.

The implementation branch is staged for queue-host. worker-host remains the live runner
until the single-runner handover in [ops/CUTOVER.md](ops/CUTOVER.md) is executed.
[ops/IMPLEMENTATION.md](ops/IMPLEMENTATION.md) records leases and deployment state.

## Runtime ownership

`crq-tick.timer` invokes a model-free tick every twelve minutes. The tick owns
`state/queue.json`, harvests detached CodeRabbit runs, enrolls new ranges, honors
server waitTime cooldown and the configured starts/hour and inflight caps, and
writes repair inbox jobs. Completed reviews count only after terminal success.
Secret scanning happens before upload; credits are never enabled automatically.

`crq-repair.path` and a ten-minute fallback timer activate `crq_repair.py`. It
owns `state/repair/`, uses one worktree per item and serial findings within that
item, with up to three items concurrently. It never writes the queue, pushes or
calls GitHub. Runtime dispatch requires BOTH `repair.enabled` and a recorded
`repair.spend_authorization`. Shipped config leaves these disabled/unverified.
Never enable them merely because code or units have been installed.

`crq-watchdog.timer` checks completed tick heartbeat age and alerts at 36 minutes.
Heartbeat and summary are atomic under `${XDG_STATE_HOME:-~/.local/state}/crq`.
The additive schema-2 summary includes `promotion.mode` from the status.md resolver,
and `systemd_timers` keyed by `crq-tick.timer`, `crq-watchdog.timer`, and
`crq-records.timer`. Each observation has `active` (boolean, or null if unknown),
`active_state`, `load_state`, `last_trigger`, and `next_elapse` (UTC ISO timestamps,
or null when unavailable/never), with `error` when observation fails or the unit
is not loaded. Watchdog monotonic deadlines are converted to UTC at observation.
Records runs continuously: its absent timer is reported as `load_state=not-found`,
while `systemd_services["crq-records.service"]` reports its actual activity.
These observations are independent of `schedule.state`, which names the backend.
Fleet readers must use that location after handover. Twenty-four-hour acceptance
requires actual observations and is not implied by installation or static checks.

The tick quiet gate queries both configured Paseo daemon endpoints; missing
configuration or failed queries block open-PR reviews. Review detachment uses a
new session and PID identity checks. `state/runner-disabled` makes a host inert.
Cross-host safety requires stopping the old runner before starting the new one;
a file lock cannot provide that guarantee across hosts.

## Review and repair policy

Review each unreviewed range once. Critical and major findings get deterministic
`crq-<run>-F<n>` inbox jobs; minors remain recorded. Clean reviews finish without
an unconditional second cycle. New head commits enroll a delta. All-owned repair
ranges are suppressed to terminate the loop. Every open PR, including fix PRs,
requires one completed CLI cycle. On load, legacy pending/blocked open items
with at least one recorded completed cycle become done; zero-cycle items remain
pending. Historical `prior_cycles` credits are retained as metadata but cannot
satisfy a review on the PR head.

`crq.py requeue <done-open-item> [reason]` requests an additional optional cycle.
It is never owed or a dependency blocker, ranks below coverage, and runs only
when no item at rank 0–3 is pending. A prior `boost` is ignored and removed on
load. Merged-current catch-up ranks alongside newly merged follow-ups (rank 2).

`crq.py prioritize <pending-item> [reason]` gives any pending item operator
priority after promotion and before normal rank; `deprioritize` clears it.
Both append admin events and preserve natural-tick admission, backoff and quota
gates. Optional cycles still wait for rank 0–3 work even when prioritized.
Selective starts for author and merged-current items remain refused. Explicit
author cycle-2 requests also rank last and wait for rank 0–3 demand to clear.

Every job records FIXED, NOT-FIXED or FAILED, a reason, attempts and judge evidence.
A0 uses the window's fixer. A mechanical failure retries the same model at A1,
then escalation at A2; three fixer attempts and one judge are the ceiling.
Provider rate limits defer without consuming an attempt. The job's window stays
pinned across attempts. Weekday 14:00–18:00 Asia/Singapore uses Luna fixers and
Muse judges; default workers/judges use GLM Flash (D9 configurable). Critical
judgements use Sol in both windows. Recurring NOT-FIXED majors and configured
sampling trigger a read-only judge; valid findings receive one A2 refix.

Tests and probes are suspended. No worker or mechanical stage runs them.
Mechanics verify full commit SHAs, strict base ancestry, HEAD membership,
nonempty diffs, finding ID attribution, exact claimed range and clean tree.
The pure `gates.hackDetector` scans the diff. The tick independently repeats
verification before publication and scans the final publication range for secrets.

Open PR repairs are replayed onto the current head only if it moved forward;
normal pushes never force. Restacked heads become stale, awaiting a new review.
Merged, post-merge delta, coverage and promotion fixes become one
`crq/fix-<run>` PR into merge-queue containing the verdict table. No finding
comments, reviews or issues are posted. PR creation is the only repair GitHub
write. The normal non-author I2 gate still applies to fix PRs.

Promotion NOT-FIXED is advice; it never resolves a blocker. Owner override
remains authoritative. Verified fix PR merges resolve their corresponding
blockers and enter the existing promotion re-review path. Signer transport
remains the dedicated forced-command SSH key with spool-shell verbs; there is
no plain-shell fallback. No signer identity is inferred from a bot name.

## Drivers and deployment prerequisites

The cq fixer passes JSON item/worktree/driver/budget and the shipped git-only
harness, removes CQ_SANDBOX* and CQ_RUN_TOOL, and never uses promptOverride.
Codex uses ephemeral structured output with workspace-write for fixing and
read-only for judgement; remote pushurl is overridden to /dev/null in children.
The cq read-only judge bridge uses the toolkit AI SDK driver with tools disabled.
`crq-records.service` exposes only tick-generated promotion metadata/rationale on
queue-host's private mesh address. User-mode promotion statuses link this record with
`target_url`; signer statuses require the separate signer's matching integration.
`state/status.md` also displays the rationale for owner override decisions.
Its dist module layout must exist in the deployed merge-queue build. Paseo judges
require a verified queue-host endpoint and read-only mode; absent configuration fails
closed. No dry model dispatch is part of provisioning.

Build cq from origin/merge-queue on queue-host without tests. Provision required keys
privately through ~/.local/secrets. Check presence without printing values.
Configure clone/worktree paths and both daemon endpoints. Install the prepared
units from `ops/systemd/` but leave them stopped until handover readiness is
recorded. See the runbook for migration, schedule deletion and rollback order.

Legacy completed runs backfill into deterministic inbox jobs once. Remaining
ledger entries archive only after terminal repair verdicts. Existing legacy
addressing worktrees are retained for explicit reconciliation, never deleted.

## Coverage and digest

When ordinary work has no eligible range, the lowest-priority coverage tier
selects a bounded, least-reviewed region from merged survival/focus measurements.
It respects the same global pacing, secret scanning and inflight limits. Only
explicit terminal reviewed-file evidence earns path credit. Observed idle tick
opportunities and 24-hour nominal utilization are reported with the observation
count; unknown prior history stays unknown. Details: [ops/coverage.md](ops/coverage.md).

`state/status.md` and XDG `summary.json` show verdict counts by rung, inbox age,
rate deferrals, in-flight jobs, fix PR links and utilization. They are the digest.

## Operator commands

Use `python3 crq.py --help` for administration. `status` reads queue status and
refreshes the digest; `summary` refreshes only the fleet summary. `tick` is reserved
for the sole installed runner. `pause`/`resume` control queue starts;
`promotion-resolve` and `promotion-ack` retain the owner override/audit workflow.
If main has not reached a reviewed promotion within 60 minutes, crq raises one
persisted gate escalation through status and the configured owner notification.
Failed notification deliveries retry at most once per 15 minutes until delivered
or acknowledged; these retries never dispatch the promotion gate.
The promotion stays in its slot, visible as `needs-human` in the fleet summary;
crq stops dispatching its gate and continues observing main. Inspect cq-gate for
`refused`/`needs-human` verdicts and resolve the underlying refusal through the
normal owner workflow. `promotion-ack` acknowledges the alert; it does not retry
the gate, authorize promotion, or clear the stalled item. An eventual authorized
promotion closes the item normally. This timeout is an observation of stalled
progress, not proof of a particular gate verdict.
If main advances strictly inside an escalated range, crq retires the old item and
requests a fresh full review of the remaining range from current main. The old
review success and stall latch are not reused for that replacement.
Do not execute dry ticks, model jobs or test-bearing gates during the suspension.

Runtime activation also requires verified hard-budget launchers for Codex and
Paseo. Codex exec exposes no verified hard token cap in the inspected interface;
CRQ refuses paid dispatch rather than substitute a prompt or post-hoc usage cap.
The Codex launcher contract is `launcher --max-tokens N -- codex exec ...`.
The Paseo launcher additionally accepts `--wall-clock-seconds N` and must keep a
remote per-agent token guard alive after background creation until termination.
Set the corresponding `*_budget_launcher_verified` only from concrete existing
operational evidence. No launcher or judge capability was exercised here.
