# Affected current-code reviews (Q1)

This operator seam queues a missed merged PR for the sole natural tick. It reviews
full affected files as they exist at a dispatch-pinned target, with explicit path
dispositions. Source PR/merge history supplies scope provenance. It grants no
repair, independent acceptance, deployment or promotion authority.

## Enqueue and inspect

From the runner checkout, using its existing operator authority:

```sh
python3 apps/crq-python/crq.py enqueue-merged --pr=42 --merge-sha=<full-source-merge-sha> --request-id=outage-pr42
python3 apps/crq-python/crq.py report --request-id=outage-pr42
```

Enrollment verifies the forge PR is merged into `main` with exactly that
merge SHA, binds the stable request ID in the existing queue under `tick.lock`,
and starts nothing. Repeating the same binding, including through another request
ID, returns the same intent. Reusing an ID with a different binding refuses.
The normal tick alone selects work, respecting pause, cooldown, starts/hour,
inflight capacity, dependency gates and the pre-upload scan. Selective `start`
refuses merged-current dispatch. Generic `requeue` refuses: consumed or ambiguous
work requires an explicit ownership/lineage decision through the coordinator.

The default selector is `promoted-main`: the tick fetches, then captures full
`origin/main` commit `T` and tree under its dispatch lock. It waits with
`not-yet-promoted` until the source merge is an ancestor of that target.
The historical `--target-selector=merge-queue` alias now selects the same
main target without reading the retired branch. The captured target never follows later ref movement, including
across restart, failed attempts or receipt reads. Request replay cannot repin a
finished intent; a future fresh-target lineage needs its own explicit contract.

## Current scope and CLI feasibility

All source changed paths, including deletions and rename origins, receive
current dispositions. Current full regular text files are eligible even if no
original blame survives. Later renames require Git rename evidence; duplicated
identical rename candidates remain ambiguous. Deleted paths, empty files,
nonregular entries, binary/non-UTF8 content, paths the scanner cannot safely parse,
and content exceeding 256 KiB/file or 2 MiB total remain explicit dispositions.
No symlink/submodule dereference occurs. All-vanished scope returns
`no-current-code`, with zero starts and no counted vendor review. Unsupported
scope stays unsupported; mixed supported/unsupported results say `partial-scope`.

The projection is `current-affected-files/full-file-addition-projection`:
synthetic base `B` derives from `T` by removing only included current files;
synthetic head `H` restores their exact blobs and has tree exactly `T.tree`.
`B..H` contains only additions of those full current files. Historical removed
text and unrelated files are absent from the comparison. The full additions are
scanned before worktree/reservation/spawn. The runner retains the pair under
`refs/crq/current/<item-id>/`, the full manifest/blob/mode/byte dispositions,
manifest digest, policy, CLI version and equivalence identity.

Local feasibility observation on an authorized worker host: installed CodeRabbit CLI `0.8.2` help
advertises `review --agent --committed --base-commit <commit>`. The runner uses
that documented argv on its clean synthetic worktree. Only version/help were
invoked during implementation. Offline temporary Git fixtures prove the exact
projection, unchanged affected content, rename/deletion and target pinning.
**Real CLI functional acceptance remains pending D1** on the approved installed
runner and an authorized missed PR. No live provider exercise, deployment or
repair activation is claimed by this source change.

## Immutable paged reports

Before a receipt exists, `report` returns bounded pending/reviewing/blocked status
and the request/source binding. After harvest it returns a receipt manifest:

```sh
python3 apps/crq-python/crq.py report --request-id=outage-pr42
python3 apps/crq-python/crq.py report --request-id=outage-pr42 --receipt-id=<sha256> --cursor=<sha256>:0
```

Receipts live under `STATE/receipts/<sha256>.json`, within the existing queue
state. The immutable document is canonical UTF-8 JSON; its exact bytes determine
the receipt ID/SHA256. Publication fsyncs bytes and directory and never overwrites
an existing receipt. Harvest writes it before finishing the queue item; restart
before or after publication re-harvests the retained run idempotently. An unreadable
or tampered receipt refuses reuse/read. A caller disconnect or repeated report
read starts nothing and consumes no quota.

The manifest gives `version`, `receipt_id`, `sha256`, `bytes`, `chunks`, `encoding`
and first `cursor`. Each cursor-bound chunk carries its zero-based `index`,
`chunk_sha256`, base64 `data`, and `next_cursor` (null at the end). Decoded chunks
are at most 3072 bytes, leaving envelope space below the existing 8 KiB wire cap.
Individual findings are never truncated: even a finding over 8 KiB spans chunks.
Consumers verify snapshot identity, chunk order/count/digests and final byte count
and whole digest before treating consumption as complete. Cursors are bindings,
not authorization tokens. Q3 owns authorized transport, consumption and import;
existing strict author admission is unchanged.

The v1 document contains original `request_id`, `item_id`, `source`, `capture`,
`outcome`, `classification`, `counted`, complete `findings`, `run_id`, `started_at`,
artifact byte digests, `remediation=disabled/deferred`,
`independent_acceptance=false`, and `cli_functional_acceptance=pending-D1`.
Aliases bind through the durable request index; a reused receipt retains its
original source/request identity and `reused_from` remains visible in status.
`source` has repository, PR, merge SHA, target selector and scope policy.
`capture` has `target`, `tree`, `paths`, `scope_digest`, `policy`, `projection`,
`reviewer`, `reviewer_version`, `captured_at`, `equivalence` and, when reviewable,
synthetic `base`/`head`. Each path has `source_path`, `path`, `resolution`,
`disposition`, with current `blob`/`mode`/`bytes` and a reason where applicable.

A genuinely terminal stream produces `terminal-clean`, `terminal-with-findings`
or `partial-scope`. No-fresh, malformed/unrecognized events, errors, action
requests, missing/nonzero exit, nonterminal status and trailing events never earn
counted credit. Blocked attempts retain findings and truthful outcomes; scan
failure produces `blocked-secret-scan` without a vendor start. Rate limits retain
the global cooldown; authentication/action-required still pause the queue.

Equivalent captured target/tree/scope/policy/reviewer-version evidence can link
another intent to one verified immutable receipt without another vendor call.
Legacy synthetic records remain available but cannot establish current-only
coverage without that proof. Pending legacy merged items link to current-mode
recovery rather than launch a competing historical comparison; alive/ambiguous
legacy ownership is retained until safely harvested. Findings never enter
`cycles` or repair backfill in this mode and never become independent acceptance.

The pure `review_receipt.current_equivalence(capture)` API recomputes identity
from target/tree, complete paths, scope digest, policy, projection, reviewer and
reviewer version. It excludes capture time and synthetic commit IDs. Incomplete
legacy captures refuse. `reusable_current(document, capture)` additionally
requires a v1 terminal counted classifier and verifies the retained equivalence;
callers first verify immutable bytes through `read_receipt`. An original author
full-diff report, grant or lease alone cannot satisfy this current-content proof.
A partial-scope receipt retains its explicit omissions when referenced.


## Complete interval reconciliation (Q2)

```sh
python3 apps/crq-python/crq.py reconcile-merged --after=2026-10-01T00:00:00Z --before=2026-10-27T00:00:00Z --page-budget=4 --dry-run
```

Remove `--dry-run` to persist and enroll; repeat the same flags to resume.
Manual bounds mean `(after, before]`; `before` must precede scan startup.
Automatic discovery is enabled by the `merged_discovery` key of the host
configuration, installed as `apps/crq-python/config.json` in the runner checkout
(rendered from the committed file; see [HOST-DEPLOY.md](HOST-DEPLOY.md)):
`{"enabled": true, "after": "2026-11-01T00:00:00Z"}`. Set `enabled` to false
to pause. Only the tick runs automatic discovery, and it always passes one
validated, frozen `(after, before]` interval; there is no unbounded mode. The lower bound prevents historical re-flooding. Each completed scan
advances the watermark; the next scan overlaps it by five minutes, bounded by
the floor, and rolls the upper bound to one second before startup. A legacy
configured `before` no longer freezes automatic discovery. Partial scans retain
their frozen bounds and cursor until complete. Resuming identical frozen bounds
does not rewrite them, so a completed interval is never briefly persisted as
`complete: false` (which client health would count as an incomplete tick); a
refusal or transport failure still records `complete: false`. Automatic scans list closed PRs
sorted by most recently updated, at most 100 per request, stopping once updates
are older than the scan's lower bound. Both main and merge-queue merged PRs are
eligible. Recent merges normally fit in one request; an incomplete scan resumes
next tick. Multi-request scans use an `updated_at` keyset rather than trusting
page offsets, because an update moves a PR to the top and a reopen shifts later
rows into already-read offsets. The cursor records the last processed update
time and the PR numbers sharing that second. Each continuation window must
start at or before that anchor; otherwise it backs off towards offset zero. A
pass that needed more than one request is followed by a head pass over PRs
updated since that pass began, until one request covers the head or a head pass
finds nothing new. The tick's existing forge budget and four-page limit apply
to every request. Same-second groups never refuse or need an operator. The
cursor remembers the newest 100 processed PR numbers at the anchor second, and
a forgotten row is reprocessed and deduplicated, never skipped. When more than
100 PRs share a pass's head second, the next head pass reprocesses every row at
that second, so a merge updated into it after the first read is still recorded.
Only strictly newer rows count towards another pass, so the scan still ends.
Cursors stay under 4 KB by the same reprocessing; only PR numbers of more than
about 37 digits would refuse.

Ordering assumption: GitHub must keep the order of closed PRs that share one
`updated_at` second stable between requests. The overlap check relies on it. If GitHub reordered a same-second group
of more than three rows that straddles a request boundary, an unprocessed row
could sit above the next window's start and that merge could be missed; the
five-minute watermark overlap does not cover it. This needs bursts of
same-second updates, so it is unlikely, but a suspected miss should be replayed
with the manual `reconcile-merged` command. A page-number cursor left by an
earlier runner restarts the scan, and already-recorded sources deduplicate. Historical backfill remains the backfill controller's responsibility.

The command prints one JSON discovery summary,
holds the existing tick lock, and never dispatches a provider or repair. An
incomplete result retains its cursor and enrolls nothing. A completed inventory
enrolls supported sources through the Q1 API, deduplicating exact source bindings
even when legacy records were skipped, synthetic or done. Unsupported identities
remain represented with reasons in the checkpoint inventory. Discovery is not
review credit. A completed manual interval never advances the natural watermark.

The manual adapter first freezes an all-state repository number ceiling and repository
node identity, checking that issue plus PR counts agree with the ceiling. It then
queries every numeric slot in windows of 50 using `issueOrPullRequest(number)`.
Changing merge order cannot shift those numeric windows. New higher-numbered PRs
belong to a later interval. Every slot must resolve with matching number/type;
missing, deleted, invisible, errored, truncated, misidentified or count-inconsistent
responses refuse completeness. It relies on forge number immutability and
authoritative merge timestamps; imported or administratively rewritten history
and delayed visibility require operator replay. It cannot certify a hostile or
internally inconsistent forge. Current base-ref metadata supplies the target
filter, so administrative base/history changes also require replay.

Source identity, frozen bounds, page cursor and inventory are atomically persisted
under `state/reconcile/<interval-digest>.json` before the next read. The wrapper
binds source and checkpoint with a corruption-detection digest; this is trusted
local state, not an authorization signature. On complete discovery, enrollment
is atomically saved before advancing the natural watermark. A crash after page completion or
enrollment replays idempotently. Source-head loss stays explicit unsupported debt.

Rolling automatic discovery writes one wrapper per tick (about 120 a day on the
twelve-minute schedule). After a completed scan advances the watermark, the tick
(at most once an hour, recorded as `merged_wrappers_pruned_at` in queue.json; a
timestamp in the future is treated as stale)
deletes completed `closed-updated-v1` wrappers whose upper bound is at or below
the watermark and more than seven days old. Growth is therefore bounded at about
seven days of wrappers. It keeps partial scans, dry runs and manual or inventory
(`all-number-slots-v1`) wrappers. It also keeps the wrapper for the active
`merged_discovery` interval, the one named by `merged_reconcile.checkpoint_key`,
and any file it cannot read or bind to its own interval. Pruning is best effort
and never aborts the tick.

Abandoned scans are kept indefinitely. These are partial wrappers for intervals
discovery moved past, and complete wrappers above the watermark, for example
after the floor is raised. Their number grows only with such events, not with
the schedule. An operator may delete one after checking that it is neither the
active `merged_discovery` interval nor `merged_reconcile.checkpoint_key`.

Discovery and deferred refresh share at most 24 requests / 30 seconds under the
tick lock, with at most ten seconds per request and four discovery pages per tick.
Budget exhaustion retains incomplete cursor/debt and leaves review scheduling
independent. Other existing scheduler operations retain their own limits; this
budget covers recovery reads. Source scans cap at 20,000 repository numbers,
1,000 pages and 5,000 represented identities. Caps refuse rather than truncate;
oversized inventories require smaller time intervals, and repository-universe
cap refusal requires a separately reviewed adapter. This bounds repeated
checkpoint serialization; it is not a new unbounded inventory service.

Status separates complete discovery from pending, reviewing, blocked, unsupported,
unverified, no-current-code, partial-scope and proven terminal receipts. Receipt
bytes, subject and captured scope must verify before earning terminal credit.
Path exclusions and retained capture targets are reported; no receipt asserts
coverage at today's target. Legacy done/skipped/synthetic entries cannot earn
current-code review credit. Existing cycles/findings remain retained. Open work
uses one review per proven equivalent full range; same-head or pure-restack
inferences without versioned scope evidence conservatively require a full review.

Merged-current remediation is stored separately from the immutable review receipt.
The tick binds the exact subject, receipt, capture and every finding to published
repair jobs, then verifies the fix PR head, selected base, merge commit ancestry
and capture ancestry before retaining merge evidence. With `queue.project_fixed: true`, status preserves the receipt outcome and reports
`fixed: true` with a compact
`remediation` reference only for complete receipt-bound evidence. Inventory exposes
`reviewed`, `consumed` and `fixed` facts separately; its `fixed` state applies only
before consumption, so the consumed filter retains consumed repairs. Fact filters
match independently: a consumed repair is returned by both consumed and fixed filters. Partial scope, partial repairs,
unmerged or stale publication heads, and equivalent receipts reused by another
subject receive no fixed credit. Reviewed and consumed remain independent facts;
local `FIXED` verdicts and receipt acknowledgement alone grant no remediation credit.
Evidence reflects the last tick's target observation and is revalidated each tick.

Automatic merged-current repair requires `repair.merged_current.enabled: true`;
the default is false, independently of the existing repair drain enablement.
Receipt-bound repair records are written only when this repair opt-in is on.
Existing bound records can still earn internal evidence after it is turned off;
only `queue.project_fixed` controls whether that evidence is projected externally.
Opt-in enqueue requires a complete receipt containing only critical/major findings;
minor/trivial/info findings, including mixed receipts, are not automatically repaired
and cannot earn partial fixed credit. Review state stays `done` when repair fails;
repair outcomes and errors are recorded separately.

Forge lookups share the tick's existing aggregate ForgeBudget and its 30-second
allowance with recovery/discovery. Busy ticks can defer fix-PR polling until a
later tick; this fails safe without granting fresh fixed credit. Closed-unmerged PRs
and merged PRs whose head differs from the prepared publication are terminal
not-fixed observations, not polled again. This also applies if crq itself pushes
another repair onto the fix branch: the changed head receives no credit for the
original receipt. Successful immutable merge metadata is cached; target ancestry
is refreshed locally. Capture identity is stored as a digest, not a copied manifest.

The producer gate `queue.project_fixed` defaults to false and is absent from
the host configuration (`apps/crq-python/config.json`). With it off, status and acknowledgement always return `fixed:false` and omit
`remediation`. Report wire responses retain the legacy chunk-only envelope;
imported report evidence remains `fixed:false` and never grants remediation
authority. Inventory retains the pre-PR row shape without reviewed/consumed/fixed
fact fields and uses exact-state filtering. Its fixed filter matches nothing.
Receipt-bound remediation evidence is still recorded internally. Receipts always
retain `remediation: "disabled/deferred"` for compatibility with the existing TS
receipt schema; pending/fixed merged evidence is tracked in queue state instead.

Turn `queue.project_fixed` on only after TS consumers run a client from this PR or
later, including `~/repos/cq-toolkit/dist` on triton and every deferred-ledger host.
The default-off gate keeps the producer compatible with old strict clients during
rollout; upgrading the producer does not require a consumer-first deploy sequence.
With projection enabled, `fixed:true` requires bound repair records; those records
are written only while `repair.merged_current.enabled` is on. Previously bound
records may still project after the repair opt-in is turned off, but never while
`queue.project_fixed` is off. This PR retains the widened strict status client and
tests parsing both the compact remediation object and the Python-produced receipt.
A blocked status has `fixed:false` and omits `remediation` entirely.

## Client health advisory

On deploy, add `health_reads` to the queue policy as documented in
[queue-client.md](../../../docs/queue-client.md#advisory-runner-health).
The principal still needs ordinary read/repository/selector permission, with no branch requirement.
No deployment-controller change is needed.

Host configuration (`apps/crq-python/config.json`) key `discovery_incomplete_ticks` defaults to 3 (integer 1–1000000).
Existing `merged_discovery.enabled: true` enables discovery health accounting.
A completed tick stores a single `client_health` record in queue.json: timestamp,
runner checkout HEAD, last discovery result, capped streak, issue number and
settled issue state. Restarts retain the streak; no per-tick history grows.
Skipped discovery (including `--only`) retains the last complete flag and streak;
it does not trigger advisory work or close an existing advisory.

At the threshold, crq finds its stable `crq: merged discovery incomplete` issue
with marker `<!-- crq-discovery-health-v1 -->`, creates or updates it, and
comments/closes on recovery. The issue body refreshes only at multiples of
`discovery_incomplete_ticks` (3, 6, 9 by default), and on open/recovery transitions.
Each attempt uses a separate fixed ForgeBudget of three calls and ten seconds,
so exhausted discovery cannot starve the advisory. Skipped or failed attempts
produce a tick log line. Before create, a durable opening marker is saved; a
definite non-zero create exit clears the marker so later ticks can retry.
Timeouts and other ambiguous outcomes retain it and log `opening marker unresolved`.
The next attempt makes one bounded, non-search-index confirming issue-list call:
if it finds the marker it adopts that issue; otherwise it clears the opening
marker and may create within the remaining budget. If discovery has recovered,
absence clears the marker without creating an issue. Failed confirmation retains
the marker and logs the unresolved state. This remains advisory and never blocks dispatch.
Budget exhaustion and forge failures never fail a tick. Existing gh credentials
are reused. The advisory does not block dispatch or alter review credit.
