# CodeRabbit queue (crq)

crq is the single consumer of the CodeRabbit CLI quota for cq-toolkit. The
script schedules, reviews, verifies and publishes; models only judge and repair.
PRs merge directly to `main`; crq records post-merge review as visible debt.
Merged discovery accepts `main` and the retiring `merge-queue` branch, retaining
#710's history floor. Automatic discovery is enabled from 2026-11-01, with
a rolling upper bound and resumable recent-PR pages; manual numeric scans
retain frozen intervals.
Historical promotion queue records load unchanged but are ignored by scheduling,
slot reservations and summaries. Legacy private overlay keys remain accepted
while host deployments lag. No promotion status, audit or admin commands run.

## Runtime ownership

`crq-tick.timer` invokes a model-free tick every twelve minutes. The tick owns
`state/queue.json`, harvests detached CodeRabbit runs, enrolls new ranges, honors
server waitTime cooldown and usage-driven slots, and writes repair inbox jobs.
Before admission it runs `coderabbit usage --agent` in the repository clone.
Team included reviews are a count in a rolling 60-minute window (10 slots).
Each tick fills free slots in operator priority → rank order, bounded
by `max_starts_per_tick` and `max_inflight` (both default 10). The legacy
`max_starts_per_hour` (5) applies only when usage is unavailable or has no valid
remaining count. Partial usage with a valid remaining count is usable.
Outstanding local reservations are subtracted from vendor remaining slots.
A detached run's hold clears only after structured vendor progress precedes a
valid usage probe; context/launch alone is insufficient. The local fallback counts recent reservations once.

The oldest unexpired local start plus 60 minutes predicts the next slot. Vendor
`rollingWindowMs` refines the window; `fullCapacityInMs` describes full recovery,
not the first slot. Unknown external starts or vendor admission lag trigger a
short retry. Each wake rechecks usage before spending.

`crq-slot.timer` invokes the small `crq_slot.py` entry every minute with
`AccuracySec=1s`. Its first step reads `state/next-review-at` (UTC); a future
hint exits before runner imports, locking or network calls. A due entry takes
the tick lock non-blocking, collects only terminal detached reviews through the
existing ownership-aware harvest path, then
refreshes usage and fills eligible free slots. Live or unverifiable runs retain
capacity. Uncaptured merged-current items wait for the fetching maintenance
tick; minute admission can reuse an existing capture. If a dated next slot is less than 60 seconds away it sleeps once and
rechecks; undated one-minute retries never sleep under the lock. In-flight runs
cap the timestamp hint at the next minute boundary, including while admission
is paused or cooling down, so completed detached review results are collected
within a minute. Without in-flight runs, idle admission backs off twelve minutes. The twelve-minute
full tick retains enrollment, harvest, status, refreshes the hint, and
waits up to 90 seconds for the lock so a sleeping admission cannot skip maintenance. Harvest
clears the hint; detached completion also requests a full harvest tick. Both
entries serialize queue writes; detached runs own individual worktrees and run
artifacts. No transient wake units are created.

Every review passes `--deep`; review deadlines
are 120 minutes with the existing TERM/KILL grace and ownership-aware harvest.
Ambiguous ownership still retains capacity for operator reconciliation.
Vendor rate-limit waitTime is preserved to the second, without minute padding;
local harvest measures cooldown from the recorded exit time and concurrent
results cannot shorten an existing global cooldown.
Completed reviews count only after terminal success.
Secret scanning happens before upload; credits are never enabled automatically.

`crq-repair.path` and a ten-minute fallback timer activate `crq_repair.py`. With
no arguments it drains the inbox under `service.lock`, items with pending runnable
critical/major work before items with none, oldest first within each class. Within an item,
critical/major findings precede minors. Minor jobs require a lowercase 64-character hexadecimal `canonical_finding_id`
and a matching delivered triage receipt; ordinary minor, trivial, info and none jobs are skipped. It
owns `state/repair/`, gives each finding job its own worktree and serializes
findings within an item. `repair.max_concurrent_items` admits 1–10
process-isolated item workers (default 1 when absent, committed config 1).
The coordinator retains `service.lock` until all admitted children exit; each
child has a private `CQ_*` process environment. Provider cooldown updates reuse
the existing `tick.lock` only during the short read/modify/write. A pause stops
new admission; paid in-flight work finishes naturally. No worker is killed to
make a slot. This is independent of review `max_inflight`. Existing deployment
overlays remain serial until explicitly setting `repair.max_concurrent_items`
to 10 in a subsequent reviewed deployment using the matching updated
`prepare-host.py` helper, which accepts this optional overlay leaf. The frozen
d41/c6 helpers do not accept the leaf and remain unchanged.
It never writes the queue, pushes or calls the GitHub API; each drain
pass starts with `git fetch --prune origin` in the review clone (a failed fetch
skips the pass). A job is drained only while its tick-owned repair run is
`queued`. A job not yet started is skipped as `STALE` (terminal, no model call)
when it is superseded:
- ordinary/backfill job: the finding's file blob on `origin/main` differs from
  the blob at the job pin (or the file is gone);
- open-PR job: the reviewed head is already on `origin/main`, the PR branch is
  gone from origin (closed or deleted; fork branches are never in origin), or
  the branch tip changed the finding's file since the pin.

The ordinary-job rule is deliberately coarse: ANY change to the file on main
marks the finding `STALE`, even an unrelated edit far from the finding, so some
still-valid findings are dropped. It is cheap, needs no model and never spends
on a finding whose code has moved under it; dropped findings return when a later
review reports them again. A closed PR whose branch still exists is not detected;
publication then discards the result. Prepared (`repair-prepare`) jobs keep the
strict one-job selector, so a moved tip makes them `STALE`.
`--job/--source-sha/--finding-sha256` still repairs exactly one prepared job.

For an already merged, published legacy FIXED repair whose source changed after
publication, `crq repair-revalidate-fixed JOB --revalidation FILE` records an
explicit semantic review in the existing publication journal under the tick lock.
It does not dispatch work or publish feedback; a later natural tick reconciles it.
The JSON must include `reviewer`, `reason`, `verdict` (`fixed`), `job`, `item`,
`run`, `finding_sha256` (the canonical JSON digest of the inbox finding), `pr`,
`published_head`, `actual_head`, `merge_commit`, and `source_sha` (the observed
current default-branch tip). `sources` maps the finding path and every non-test
path in the published commits to objects with `published`, `actual`, and `current`
entries: each is `[git mode, blob SHA]`, or null for a deleted path. All bindings
are checked again before feedback; a changed tip or PR requires fresh evidence.
This optional path applies to a single FIXED legacy job and does not replace the
canonical finding disposition workflow.

Repair dispatch tries the configured role, then `repair.fallback_models` in order:
OpenCode Go DeepSeek V4.1 Flash, then direct DeepSeek Flash. Fixers and judges
share durable provider cooldowns in `state/repair/provider-cooldowns.json`.
Quota/rate-limit responses move to the next credentialed provider without consuming
an attempt. Other failures retain normal retry handling. Explicit vendor reset
timestamps are retained for up to seven days (unzoned dates conservatively mean
UTC); otherwise the retry signal or a thirty-minute default applies. A provider's
cooldown is never shortened. The existing global pause applies when all available
providers are cooling down; a healthy fallback can bypass a legacy global pause.
Each dispatch keeps its original wall-clock budget across the fallback chain and
records the actual model and separate provider session artifacts.
Credentials come from dotfiles-secrets' rendered `~/.config/crq/repair.env`:
`ZAI_API_KEY`, `OPENCODE_GO_API_KEY`, `OPENCODE_GO_BASE_URL`, `DEEPSEEK_API_KEY`.
The drain's
`git fetch --prune` runs under the tick's own `state/tick.lock` (flock, as
`crq.with_lock`). If the tick holds it, the drain polls for up to
`repair.tick_lock_wait_s` seconds (default 300) before skipping the pass. The
inbox path unit fires while the enqueuing tick still holds the lock, so an
instant skip dropped every path-triggered pass.
Runtime dispatch requires `repair.enabled`, a recorded
`repair.spend_authorization` string, and `ZAI_API_KEY` in the service environment
(`EnvironmentFile=-%h/.config/crq/repair.env`). Roles use cq-driver GLM by default, with OpenCode Go and direct DeepSeek fallbacks
(fixer `zai/glm-5.3-flash`, escalation `zai/glm-5.3`, judge `zai/glm-5.3-flash`,
critical judge `zai/glm-5.3`). `repair.blackout.enabled` switches the window on
or off (committed `false` since 2026-11-02: GLM quota is plentiful); the host
overlay may set it to `true`/`false` and a `live-config` render applies it. While
enabled, inside `repair.blackout` (14:00-18:00
Asia/Singapore, Mon-Fri) nothing is dispatched: the drain does not start, no new
finding starts, and a running finding defers its next attempt or judge for 30
minutes. The same applies to a dispatch whose `budget.wall_clock_min` would
reach into the window, so nothing started at 13:45 runs into 14:00.

`crq-watchdog.timer` checks completed tick heartbeat age and alerts at 36 minutes.
Heartbeat and summary are atomic under `${XDG_STATE_HOME:-~/.local/state}/crq`.
The schema-2 summary retains queue, backfill, slot and health evidence, omits
promotion fields, and includes `systemd_timers` keyed by `crq-tick.timer`, `crq-watchdog.timer`,
`crq-slot.timer`, `crq-backfill.timer` and `crq-repair.timer`. Each observation has `active` (boolean, or null if unknown),
`active_state`, `load_state`, `last_trigger`, and `next_elapse` (UTC ISO timestamps,
or null when unavailable/never), with `error` when observation fails or the unit
is not loaded. Watchdog monotonic deadlines are converted to UTC at observation.
`systemd_services` is empty: `crq-records.service` served promotion records and
was retired with promotion (2026-11-01); its unit and script are removed. `backlog` counts pending primary-repo
items for `open`, `delta`, `merged`, `coverage`, `merged-current` and `backfill`;
`outcomes_24h` counts each run id once (its last `review_finished` event in the
window), so a re-harvest after a crash or a retained backfill run never inflates it.
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
`crq-<run>-F<n>` inbox jobs; minors from these review runs remain recorded.
Confirmed canonical backfill minors use the separate delivery adapter described above. Clean reviews finish without
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
priority before normal rank; `deprioritize` clears it.
Both append admin events and preserve natural-tick admission, backoff and quota
gates. Optional cycles still wait for rank 0–3 work even when prioritized.
Selective starts for author and merged-current items remain refused. Explicit
author cycle-2 requests also rank last and wait for rank 0–3 demand to clear.

Every job records FIXED, NOT-FIXED or FAILED, a reason, attempts and judge evidence.
A0 uses the fixer. A mechanical failure retries the same model at A1,
then escalation at A2; three fixer attempts and one judge are the ceiling.
Provider rate limits defer without consuming an attempt. Critical findings use
the critical judge. Recurring NOT-FIXED majors and configured
sampling trigger a read-only judge; valid findings receive one A2 refix.

For a terminal failed job, `crq_repair.py --recover-job <job-id>` inspects
the retained worktree without changing it, scans bounded current-source and
patch evidence, and asks the existing critical judge to reassess the finding.
Only a verified current anchor can create a replacement through tick-owned
preparation; the replacement uses a separate worktree. Recovery retains its
invocation artifact under the original job. An unknown judge outcome is not
automatically retried; explicit provider deferrals have at most three attempts.
Owner dispositions and source or evidence changes remain unresolved for
inspection. Every finding job has its own worktree, named
`crq-repair-<item>-<job>`, so a retained worktree belongs to exactly one finding.
The A2 escalation rung checks out the sibling `crq-repair-<item>-<job>-A2`; read
the result's `worktree` field rather than assuming the unsuffixed path, or the
final attempt is easy to miss.
Staged and unstaged patches, untracked files and commits are retained per attempt
before retry or fallback. Legacy shared per-item worktrees predate this layout;
`--recover-job` rejects any tree that is not the job's owned name or its `-A2`
sibling, even after independent attribution, so those jobs need manual handling.

Tests and probes are suspended. No worker or mechanical stage runs them.
Mechanics verify full commit SHAs, strict base ancestry, HEAD membership,
nonempty diffs, finding ID attribution, exact claimed range and clean tree.
The pure `gates.hackDetector` scans the diff text, passed as the `--diff=` flag
value (the cq CLI has no `@file` expansion; diffs over 120 kB fail closed). Its
findings become the attempt's failure reason. The tick independently repeats
verification before publication and scans the final publication range for secrets.

Open PR repairs are replayed onto the current head only if it moved forward;
normal pushes never force. Restacked heads become stale, awaiting a new review.
Merged, post-merge delta, coverage fixes become one
`crq/fix-<run>` PR into main containing the verdict table. The repair path
posts no finding comments, reviews or issues; PR creation is its only GitHub
write. The normal non-author I2 gate still applies to fix PRs.

## Findings on open PRs

A counted `open` or `delta` review with findings in any reviewed repository posts them
on the PR as one pull-request review (`pr_review_findings.py`;
`POST /repos/{repo}/pulls/{pr}/reviews`, event `COMMENT`, `commit_id` = the
reviewed head). Primary-repo repair enqueue still runs independently; other
repos receive no repair enqueue or primary coverage credit. Successful complete
whole-PR clean reviews post an exact-head PASS receipt. Failed, partial and timed-out
scans post no verdict. Successful narrower scans, a current major/critical finding,
or an earlier unresolved major/critical CRQ thread produce ITERATE.

- Each finding whose lines fall inside the added PR diff lines for that commit
  (the compare of the PR base and the reviewed head)
  becomes an inline comment, so it is its own resolvable review thread
  (GraphQL `reviewThreads`, reply, `resolveReviewThread`). A range is clamped
  to the first added line it overlaps. If a finding has no valid intended line, the counted-run publisher uses an actual added
  line in the same file, then the PR's first added line, and explicitly names
  the intended location in the thread body. Every new finding gets a thread;
  the legacy CLI's inline cap does not apply to counted-run receipts. If the PR
  has no commentable added line, or GitHub definitively rejects an anchor with
  HTTP 422, findings stay visible in a body-only review. Any new major in that
  body forces ITERATE and forbids a same-head refresh; it has no thread that can
  be resolved. An ambiguous POST failure stays debt with the selected identity;
  it never triggers that fallback. The independent-review CLI retains its legacy
  50-thread cap; its behavior and parity vectors are unchanged.
- The review is labelled as crq output, not as a CodeRabbit PR review. The
  body starts with `<!-- crq-findings run=<run_id> -->` and the header
  `**Independent review (CodeRabbit CLI via crq): PASS|ITERATE for <full head>**`
  follows the leading run and immutable-binding markers. The existing
  `crq-local-findings` marker remains on the no-summary tick path. The reviewed
  range stays in the body.
  HTML comments are stripped from finding text, and `suggestion` fences become
  plain fences, so no vendor marker or committable suggestion is copied.
  Severity, title and text all get this treatment, and a leftover `<!--`
  is escaped. `@mentions` outside code (line-start fences and inline spans)
  get a zero-width joiner after the `@`, so a posted finding never notifies
  anyone; paths are shown as safe code spans.
- Delivery is debt, not an inline upload: harvest stores `pr_review_request`
  and `pr_review_pending` on the item; the bounded post-harvest pass in
  `tick()` delivers at most two per tick, least recently attempted first.
  Before posting it skips a closed or merged PR and looks for an existing
  review by the authenticated `gh` account whose body starts with the run's
  marker, so a crash after the POST never posts twice. A malformed request
  or invalid identity settles at once. A failure records `pr_review_error` and retries on later ticks, up
  to five attempts (`findings_review_abandoned` event); success stores
  `pr_review` and emits `findings_review_delivered`. A newer run of the same
  item replaces an undelivered older request.
- Clean delivery uses its own `clean_review_request` / `clean_review_pending`
  and bounded delivery entrypoint; it never clears or replaces an undelivered
  findings request. The original newer-findings-request-wins semantics remain.
- Identity: the publisher probes `cq-review-post --capabilities` for the
  `repo-scoped-v1` token interface, then captures its token and expiry privately.
  The agents helper owns the existing `CQ_REVIEW_KEY_DIR` / XDG credential paths;
  the publisher passes the token only through its `gh` child's environment.
  A missing or older helper or failed credential setup selects an explicitly
  unattested host-login review before posting. The existing request checkpoints
  that selected identity before the POST, so a lost response retries with the
  same identity. No ambiguous App POST falls back to a second account. Receipt
  results record the safe identity/reason and attested boolean, never credentials.
- CRQ never resolves threads. The author replies with the fixing commit, or a
  reason for an invalid finding, and resolves the thread. A new run's absence of a finding is not proof of a fix;
  earlier unresolved major threads keep its verdict at ITERATE. Review/thread
  reads paginate and fail closed when incomplete. Current CodeRabbit model
  findings expose no invocable deterministic per-rule re-check subset.
- When a complete whole-PR scan's latest verdict at the current head was ITERATE,
  a later tick can refresh it to PASS after the author resolves all major-or-above
  CRQ threads, provided that scan left no major finding in the body. The refresh cites that saved scan; it runs no scan, creates no
  findings and uses `<!-- crq-verdict-refresh head=<sha> scan-run=<run id> -->`.
  Its per-head marker is separate from original per-run retry dedupe. Neither
  reviewed-range refusal nor run/base/head binding changes. The advisory source
  readout selects the latest exact-head CRQ verdict by submission timestamp;
  other independent reviewer evidence is preserved.
- Legacy body-only findings, including major ones, do not hold the verdict and
  are not claimed covered or resolved. Minor thread counts are not dispositions;
  minors do not hold PASS, while the merge bar still requires their disposition.
- Python is the production PR publisher. The TS policy mirror
  `src/policy/crq/prReviewFindings.ts` deliberately retains its legacy contract;
  existing parity vectors remain unchanged and tested. This change does not
  activate TS publishing or move the deployed `prepared-a221` repair dist pointer.
  Deploy the token-capable agents helper before adopting this Python contract
  through the normal CRQ deploy controller; no live changes follow from a merge.
- On upgrade, pending open/delta issue deliveries become PR-review debt using
  their original run, artifacts and reviewed range. Already delivered issues
  are left alone. Push/post-merge reviews keep issue delivery and its existing
  `findings` setting (docs/multi-repo.md).

## Drivers and deployment prerequisites

The cq fixer passes JSON item/worktree/driver/budget and the shipped git-only
harness, removes CQ_SANDBOX* and CQ_RUN_TOOL, and never uses promptOverride.
Each finding job runs one fresh `review.fixItem` process and session per rung
(A0, A1, A2), and the judge is another; nothing carries over between them
except the mechanical evidence string. The budget is per attempt:
`repair.budget.max_output_tokens` (default 500k) counts output tokens only,
`max_context_tokens` (default 200k) stops an attempt once a request's input
context reaches it, and `wall_clock_min` bounds time. A budget stop's reason
comes from the session's `budget-stop` line. These need a `cq_bin` built with
`Budget.maxOutputTokens`/`maxContextTokens`; an older build rejects the input.
`max_tokens` is read only by the Codex/Paseo launchers.
Codex uses ephemeral structured output with workspace-write for fixing and
read-only for judgement; remote pushurl is overridden to /dev/null in children.
The cq read-only judge bridge uses the toolkit AI SDK driver with tools disabled.
Its dist module layout must exist in the deployed main build. Paseo judges
require a verified queue-host endpoint and read-only mode; absent configuration fails
closed. No dry model dispatch is part of provisioning.

Build cq from origin/main on queue-host without tests. Provision required keys
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
`prioritize`, `deprioritize`, `requeue`, `skip` and `block` manage ordinary work.
The signer executable now serves only `ledger-publish`, preserving the root-owned
CodeRabbit backfill publication capability. See [signer/DEPLOY.md](signer/DEPLOY.md)
for retiring the old daemon during the normal runner switch.

Runtime activation also requires verified hard-budget launchers for Codex and
Paseo. Codex exec exposes no verified hard token cap in the inspected interface;
CRQ refuses paid dispatch rather than substitute a prompt or post-hoc usage cap.
The Codex launcher contract is `launcher --max-tokens N -- codex exec ...`.
The Paseo launcher additionally accepts `--wall-clock-seconds N` and must keep a
remote per-agent token guard alive after background creation until termination.
Set the corresponding `*_budget_launcher_verified` only from concrete existing
operational evidence. No launcher or judge capability was exercised here.
