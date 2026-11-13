# Queue client protocol (Q3)

> Owner ruling 2026-11-03: CodeRabbit is advisory; no outage enrollment is required.
> The deferred queue protocol below remains for deployed CRQ compatibility and
> existing deployed debt. New CLI attempts no longer create outage authority.

Stack parent/base: `queue/q1-merged-current` at
`c088ec6eb720d01d4c4739695ba71adc91384ef8` (Q1 documentation correction; preserving the frozen
`f3944022a8cebc622742c397cd7a756d818943cf` helper API). Queue baseline:
`1eea0b5b323de8b23a9388a72da4e97f8e631450`.

`queue-v1` is a separate forced-command capability. Deployment must explicitly
allow it. S2b-ii retired the SDK's `author-v1` client command; the Python
server route remains for deployed compatibility and no installed author SSH
identity exists. No credentials or custody change is part of Q3. Old runners
are unsupported and require a reviewed runner capability deployment. No inline
reviewer starts are provided; bounded observation (`makeQueueOps().drain`) and
explicit transient retry (`review.retry`) are described under Q3R below.

The typed seam in `src/ops/review/internal/queueProtocol.ts` binds a stable
requestId to either merged-current provenance or a deferred-author intent.
Deferred intent carries repository, producer, immutable head, target branch and
target selector before PR publication. `enqueue` durably records `awaiting-pr`;
`bind` verifies forge repository/head/producer/target before attaching a PR
(`awaiting-merge`), and verifies the eventual merge before Q1 enrollment
(`ready-current`). Request replay must match the original binding. Cancellation
remains inspectable and never starts work. Q6 owns known-PR refresh/composition;
Q2 discovery is unnecessary for this lifecycle.

The operator supplies principal/repository/target and separate read/write
allowlists. No authority-bearing fields come from caller JSON. All frames,
including envelopes and newline, are at most 8192 bytes. Q1 immutable receipt
chunks carry at most 3072 raw bytes. The client verifies snapshot, order, count,
per-chunk and whole-document digests before import and consumption acknowledgement.
Queue evidence has its own versioned store; affected-current clean never supplies
full-branch readiness, independent acceptance or remediation completion.

## SDK and generated CLI

Import `makeConfiguredQueueClient` (uses the operator `CQ_QUEUE_SSH_ALIAS`
resolved in the CqEnv snapshot: the caller's snapshot argument, or the
enclosing run's snapshot — the value the entry captured when the process
started, so changing the ambient variable afterwards has no effect on an
existing client) or `makeQueueClient(transport)` from the SDK review family. The client exposes
`enqueue(reference)`, `bind({...reference, pr, mergeSha?})`, `cancel(reference)`,
`status(reference)` and `report(reference, evidenceDir)`. Every call requires
the original immutable `{requestId, binding}`; a failed read creates no ID.
Producer is the forge PR author login; target is its base branch. Q6 owns the
known-PR refresh and unique author/head/base publication recovery. It preserves
server-only principal and delivery/consumption fields.

S2b-ii retired the generated `cq review.enqueue`, `cq review.queueStatus`,
`cq review.drain` and `cq review.report` commands. Use the SDK methods above:
`enqueue(reference)` binds or cancels through its `action`
(`bind --pr=12 [--mergeSha=…]`, `cancel`), `status(reference)` reads state and
`report(reference, evidenceDir)` imports a receipt. No positional arguments or
caller-selected remote paths/commands are supported. A call success is distinct
from review verdict.

Reports verify the entire receipt before create-only durable import and ack.
Interrupted readers restart at the manifest and safely replay bounded chunks;
server delivery progress survives caller restart. Local raw receipt bytes are
stored once as `<receipt SHA256>.json` in the chosen queue-evidence directory.
`readQueueEvidence(directory, receiptId)` validates both whole-document and
scope-manifest digest, returning the separate `cq-queue-evidence` v1 artifact.
It never writes a findings-v1 record. Each supported receipt is at most 64 MiB;
larger receipts refuse explicitly without truncation or acknowledgement.

Status separates enqueued/reviewed/consumed/fixed. `reason` is typed provenance
(`source`, `category`, `code`). Vendor continuation requires the runner's
`classification.failure_provenance` v1 proof with `complete: true` and a nonempty
`causes` list. Every cause must be exactly
`{source: "vendor", category: "vendor-rate-limited", code: "rate_limit"}`;
the runner sources this only from literal `errorType: "rate_limit"` plus
`recoverable: true`. Root and classifier outcomes must both be `rate_limited`,
both counted flags false, exit an integer 0 or 1, and `bad_lines` integer 0.
Missing, incomplete, malformed, mixed or unknown causes remain queue blockers.
Legacy outcome labels, prose, auth and unavailable guesses grant no vendor
continuation; older runners require the reviewed provenance producer update.
All error/action and hard causes must be retained by that producer. The proof
stays in the immutable receipt; status exposes one bounded reason.

Persistent Q6 `forge-identity` reasons project blocked
and prohibit receipt consumption until exact successful forge revalidation clears them. Full capture paths/findings are absent from status.
Receipt request IDs may name the original enqueue; durable alias bindings and
verified equivalence authorize reuse, never the cursor or original ID alone.

## Source capability deployment prerequisite

`apps/crq-python/capability_dispatcher.py` routes exactly `author-v1` to the
unchanged author transport and exactly `queue-v1` to the new capability. All
other commands refuse. It is source code only: Q3 changes no installed key,
credential, SSH configuration, signer or running service.

The operator provides `CRQ_QUEUE_PRINCIPAL` and an operator-owned JSON policy
path `CRQ_QUEUE_POLICY` through the existing trusted forced-command boundary.
Do not accept these environment variables from SSH clients. Example policy
keys: `enabled` (defaults false), `repo`, `read` and `write` principal lists,
`targets` selector list, `branches` forge base-branch list, `max_requests`
(default 10000). Both the dispatcher and transport validate policy types before
runner import or queue access: activation requires JSON boolean `true`; missing
or boolean `false` remains unsupported. Other activation types, non-object
policies, malformed repository/selector/capacity values, and allowlists that are
not arrays of nonempty strings refuse. Read covers status/report; write covers
enqueue/bind/cancel/ack. A consuming `report` caller must be listed in
both: it reads receipt pages under `read` and acknowledges consumption with
`ack` under `write`.
Requests are permanently principal/repository/source/target bound. Forge source
metadata is fetched with fixed API argv before attachment or Q1 enrollment.
The existing tick lock/process-group supervisor bounds each operation, and
queue state saves before a response. No reviewer dispatch occurs here.

D1C must review/activate that exact capability under existing deployment trust,
after compatible Q1 service/state and healthy dispatch. Disabled/old runners
return unsupported or a transport refusal with a deployment prerequisite.
Q3 source/test success alone does not establish activation or live acceptance.

## Operator activation (queue-v1)

Activation is an operator action under existing deployment trust. It changes no
runner code, signer or unit. Install exactly one restricted client identity per
calling principal:

1. Generate a dedicated client key on the calling host. The private key never
   leaves that host.
2. On the queue host, add one `authorized_keys` line for the account that owns
   the queue state. The line uses `restrict` and a fixed forced command, and sets
   the server-only principal and policy inside that command:

   ```text
   restrict,command="/usr/bin/env PATH=<cli-path> CRQ_QUEUE_PRINCIPAL=<principal> CRQ_QUEUE_POLICY=<policy.json> /usr/bin/python3 <runner-root>/apps/crq-python/capability_dispatcher.py" ssh-ed25519 <public-key> <comment>
   ```

   Do not run the dispatcher with `python3 -I`: it imports its sibling transport
   modules. Never accept these variables from the client (`PermitUserEnvironment`
   stays off). Do not add `CRQ_AUTHOR_*` settings to this queue identity.
   `PATH` must resolve `git`, `gh` and `gitleaks`; authenticate `gh` as the queue account.
   review-v1 runs the runner's snapshot secret scan (including gitleaks) inside
   this forced command. A `gitleaks` that is found but exits nonzero (for
   example a mise shim with no global version and no real binary after it on
   `PATH`) refuses every unpublished-commit submission with "snapshot secret
   scanner unavailable". A `gitleaks` that is absent from `PATH` is skipped
   instead, and the snapshot is admitted on the denylist scan alone, so absence
   is not a safe failure mode either. Check it with the forced command's exact
   `PATH` under `env -i`, not from a login shell. The crq systemd units put
   `~/.local/bin` after the mise shims; the forced command needs the same.

3. Create the policy file (mode 0600) disabled, owned by the queue-state account
   that runs the dispatcher. Verify that account can read it before enabling it.
   Turn it on only for an approved window:

   ```json
   {"enabled": false, "repo": "<owner/repo>", "read": ["<principal>"], "write": ["<principal>"], "targets": ["promoted-main"], "branches": ["<base-branch>"], "max_requests": 50}
   ```

4. On the calling host, define the alias named by `CQ_QUEUE_SSH_ALIAS`. The
   transport passes its own non-interactive options but reads the user's SSH
   configuration, so make sure no catch-all `Host *` block adds other identity
   files, agent forwarding or connection sharing to the alias (for example
   `Host * !<alias>`). Check it offline with `ssh -G <alias>`: there must be a
   single `identityfile`, `forwardagent no` and `controlmaster false`.

Rollback: `"enabled": false` is the fast off. Otherwise-valid authorized requests
then return `unsupported` with no restart; malformed or unauthorized requests are
still refused earlier. For full rollback, revoke server authorization first by
commenting out the `authorized_keys` line, keep managed backups, then retire the
client key and alias. Queue requests and receipts are never deleted; deferred
debt stays inspectable and can be cancelled with the client's `cancel` call.

## Reading reconciled inventory

An operator may authorize adoption of one existing merged-current request by adding
an exact grant to the server policy's `reconciled_reads` array:

```json
{"principal":"developer","requestId":"reconcile-<subject-digest>","binding":{"kind":"merged-current","repo":"owner/repo","pr":506,"mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","targetSelector":"promoted-main"}}
```

Grant and use a request ID actually present in `merged_current_requests`, with its
exact immutable source binding. Reconciliation enrolls only `intent` entries.
For `already-enrolled` subjects, the inventory's proposed `reconcile-…` ID may have
no stored mapping: use the existing mapped request ID for that exact subject,
which the operator must identify from queue state. Do not grant the proposed ID
unless it has a stored mapping. The client uses the existing SDK
`status` / `report` methods.
No enqueue alias is needed. The principal must also have ordinary read authority;
acknowledgement still requires write authority. A read validates forge source and
allowed base branch, the exact stored mapping and unique item, and capacity, but
read-only status/report adoption is not persisted; only a successful `ack` saves
the principal-bound client entry. Until that `ack`, another granted principal may
still adopt the same request ID. Adoption neither enrolls debt nor starts a
review. Existing client entries retain their original
principal binding: if another client principal already holds the mapped ID,
adoption by a new principal is refused even with an exact grant. The existing
principal must consume it, or an authorized writer must explicitly enqueue a new
alias using its own ID and exact source binding; this seam does not transfer
ownership or create that alias. Each request ID may appear only once in the grant
array. Removing the grant prevents new adoption; revoke ordinary read
or write access to revoke an already adopted client's corresponding capability.

Deployment requires this transport and compatible receipt storage on the queue
runner, an operator-owned exact grant, and the existing activated queue-v1 boundary.
No deployment is performed by this source change. Live D2 inventory/adoption
acceptance must be recorded separately from quota discharge: pending inventory,
a completed report, consumption acknowledgement and remediation remain distinct;
adoption alone supplies no review, fixed-state or full-quota credit.

## Interval inventory (M3)

The wire-only `inventory` operation requires ordinary read access, an allowed
target, and an exact operator `inventory_reads` grant. It grants no per-ID
status/report/adoption, write or acknowledgement authority:

```json
{"principal":"developer","binding":{"repo":"owner/repo","targetSelector":"promoted-main","after":"2026-10-27T00:00:00Z","before":"2026-10-31T00:00:00Z"}}
```

Place that object in the policy's `inventory_reads` array. Deploy the reviewed
transport and dispatcher with compatible runner reconciliation wrapper storage.
A complete, non-dry-run all-number-slots reconciliation for that exact interval
must already exist. This operation performs no forge/network read, queue save,
adoption, enqueue or review start. It uses the reconciler's existing
**(after, before]** convention, not the live demonstration's [after, before)
calendar window; choose bounds accordingly.

Exact request (all fields required; limit 1–10):

```json
{"v":1,"op":"inventory","requestId":"inventory-1","binding":{"repo":"owner/repo","targetSelector":"promoted-main","after":"2026-10-27T00:00:00Z","before":"2026-10-31T00:00:00Z"},"cursor":null,"limit":10,"states":null}
```

Response echoes `v`, `requestId` and `binding`, with this `result` shape:

```json
{"entries":[{"pr":506,"mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestId":null,"itemId":null,"state":"missing","reason":null}],"terminal":true,"nextCursor":null,"proof":{"checkpoint":"<checkpoint SHA256>","completeThrough":"2026-10-31T00:00:00Z","count":1,"digest":"<view SHA256>","selectedCount":1,"intervalConvention":"(after,before]"}}
```

With `queue.project_fixed` off (the default), inventory omits remediation facts,
uses exact-state filters, and the fixed filter matches nothing. With it on, the
following overlapping states/facts are available.

States are `missing`, `pending`, `reviewed`, `reused`, `no-current-code`,
`partial-scope`, `consumed`, `fixed`, or `blocked` (with bounded typed `reason`).
`fixed` requires complete receipt-bound merged repair evidence. Pending includes
work currently reviewing.
With `queue.project_fixed` on, filters have OR semantics: a row matches its exact `state` or any requested true
`reviewed`, `consumed` or `fixed` fact. In particular, `states:["reviewed"]` also
returns reused, consumed and fixed rows with review credit. `states:["fixed"]`
includes consumed repairs; `states:["consumed"]` includes repairs that are fixed.
Other state names match only the exact row state. These filters overlap; they are
not disjoint lifecycle buckets. The cursor digest and proof use this same selected
set, so these semantics do not change paging or proof verification.
Set `states:["pending","blocked"]` for the outstanding summary; null includes
everything. Known PRs without a visible mapped request remain `missing`.
Requests owned by another principal reveal neither IDs nor status; missing
therefore means no representation visible to this principal, not global absence.
Unowned reconciled mappings may be read through the interval grant without
being adopted, after the same deterministic item ID, unique item, exact mapping,
subject, kind, PR and merge-SHA checks used for per-ID reconciled adoption.
Verified equivalent reused receipts follow the status operation’s equivalence
checks; `reused` and `no-current-code` do not inflate pending/blocked counts.
Unsupported reconciliation identities remain missing rows.

Repeat with `nextCursor` until `terminal:true` and `nextCursor:null`.
The cursor binds the principal, interval, filter, checkpoint and visible state
digest; state changes refuse stale cursors, requiring a restart. The digest is
SHA256 of receipt-canonical JSON containing `principal`, `binding`,
`checkpoint`, `states` and the selected sorted `entries` list (PR then SHA).
Filters are sorted and deduplicated before digesting and paging.
Count covers the unfiltered view; selectedCount covers the filter. Page size
does not change the digest. The proof establishes coverage of the trusted,
validated reconciliation record and visible queue projection, not a live forge
snapshot, review completion for missing/pending rows, historical promotion,
remediation, quota discharge or readiness. Incomplete, corrupt, absent or
dry-run checkpoints refuse rather than claim completeness.

Read-only status, report and inventory bypass the scheduler lock and read the last
atomically saved queue. Each response includes a principal-bound opaque `snapshot`
identity; inventory uses its selected-view digest, including the validated checkpoint. Queue replacement during
a read, or checkpoint replacement during validation, returns typed retryable `busy`.
An active tick does not prevent reads of the saved generation. These reads never
save the queue. Reports store delivery progress in a separate per-principal,
request, binding and receipt journal under `receipts/deliveries`; acknowledgements
retain scheduler locking and require complete delivery. Existing queue delivery
progress remains usable. Reports reuse one delivery lock rather than retaining a
lock per receipt. Writes still return typed `busy` on scheduler contention.

Read admission has two cross-process nonblocking slots under the receipts directory;
when both are occupied, reads return typed `busy` before loading the queue. These
slots are independent of tick.lock. Reconciled source verification is cached for
five minutes in a bounded 128-entry durable cache. Keys bind principal, request,
full binding (including merge SHA) and allowed branches. Every read still checks
current authorization and exact queue identity; cache hits never grant access.
An `ack` may adopt a reconciled request only with read and write permission plus
the exact reconciled-read grant, matching queue identity and complete delivery.

Inventory cursors bind the checkpoint and selected visible projection. Unrelated
queue saves and changes outside the selected rows do not invalidate pagination. An invalid or changed cursor returns
`result:{"error":{"code":"stale-cursor","retryable":false,"restart":true}}`
(with snapshot identity). Discard accumulated pages and restart with `cursor:null`;
do not retry the continuation or combine pages across snapshots. Real authorization
failures retain the nonzero `queue capability refused; no permission` response.
The observed M3 continuation stderr contains no exception detail: the old dispatcher
mapped every exception, including stale-cursor ValueError, to that message, so the
historical cause cannot be established from that stderr alone.

Deployment requires transport and dispatcher together and a writable receipts
journal directory. No scheduler, signer or promotion configuration changes are
required. No deployment was performed.

Inventory indexes subjects/items once and verifies at most 64 MiB of receipt
bytes per request. Rows beyond that budget return blocked with
`{source:"queue",category:"capacity",code:"inventory-receipt-budget"}`,
never an unverified verdict. This keeps wide intervals bounded without writing
a snapshot or trusting cached receipt verdicts. The capacity reason describes
this read's verification limit, not a scheduler/vendor failure.

Merged-current remediation is stored separately from the immutable review receipt.
The tick binds the exact subject, receipt, capture and every finding to published
repair jobs, then verifies the fix PR head, selected base, merge commit ancestry
and capture ancestry before retaining merge evidence. With `queue.project_fixed: true`, status preserves the receipt outcome and reports
`fixed: true` with a compact
`remediation` reference only for complete receipt-bound evidence. Inventory exposes
`reviewed`, `consumed` and `fixed` facts separately. `fixed` is an independent
durable fact about remediation evidence, not a pre-consumption-only state, so it
survives consumption: a consumed repair still reports `fixed: true`, and the
`consumed` filter returns it as consumed without clearing its fixed credit.
Fact filters match independently: a consumed repair is returned by both consumed
and fixed filters. Partial scope, partial repairs,
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

Fix-PR polling runs under its own aggregate ForgeBudget (80 requests, 60-second
window), not the tick's shared one, because it runs last and the shared allowance is
spent by then; a pass that is starved or blocked reports its counts and raises a
`reconcile_incomplete` event instead of appearing quiet. This fails
safe: deferred or unavailable evidence earns no fresh fixed credit. Closed-unmerged PRs
and merged PRs whose head differs from the prepared publication are terminal
not-fixed observations, not polled again. This also applies if crq itself pushes
another repair onto the fix branch: the changed head receives no credit for the
original receipt. Successful immutable merge metadata is cached; target ancestry
is refreshed locally. Capture identity is stored as a digest, not a copied manifest.

The producer gate `queue.project_fixed` defaults to false and is absent from
`config.json`. With it off, status and acknowledgement always return `fixed:false` and omit
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

### Advisory runner health

`review.queueHealth` accepts `{requestId, binding: {repo, targetSelector}}`.
This dedicated health binding cannot enqueue, bind, or read review receipts.
The SDK client exposes `health(reference)`; queue-v1 uses `op: "health"`.
It returns `lastCompletedTick`, `ageSeconds`, `discoveryComplete` (null before
an enabled discovery tick), `incompleteTicks`, `pending`, `blocked`,
`deployedSha` and `snapshot`. SHA is read from the runner checkout at tick
completion, not from the reviewed repository or via a process per read.
Reads use snapshot admission (two concurrent reads), never the tick lock.
A changed snapshot or exhausted read slots return `{error: {code: "busy", retryable: true}}`.
The typed health client preserves that result; `review.queueHealth` returns it
in `status: "ok"` with the error payload as its value, so callers can retry.

Deployment must retain the ordinary `read`, `repo` and `targets`
permissions and explicitly add this queue-policy grant (binding is the exact
client health binding, not a wildcard):

```json
{"health_reads":[{"principal":"CLIENT_PRINCIPAL","binding":{"repo":"camerontaylor/cq-toolkit","targetSelector":"promoted-main"}}]}
```

No enqueue or forge verification is needed. Use a stable requestId such as
`health-client` with that binding. Health is advisory and grants no review credit.

Health has no branch permission requirement. A `health_reads` grant authorizes
only `health`; it grants no status/report or write authority.

### Bounded observation and explicit transient retry (Q3R)

The drain operation (`makeQueueOps().drain`) takes `requests`
(requestId/binding references), `waitMs` (0–3600000)
and optional `pollMs` (1000–60000, default 1000). It only reads status, returns
`{action:"observed",accepted:false,unfinished:[...requestIds]}`, and can resume
with the same references after disconnect. Successful per-ID `observations` are retained alongside per-ID `errors`. Busy and stale reads are revisited
on the next poll; status reads carry no cursor. It never starts a tick.

`review.retry` defaults to inspection (`action:"observed"`, `accepted:false`,
`current` status). An explicit `transient:true` requires `expectedReceiptId`.
A blocked merged-current item requires typed recorded evidence of vendor rate-limit,
recoverable network/transport error, timeout exit 124, or runner termination
(-2/-9/-15/130/137/143), plus an ownership probe proving its owner empty. Unknown exits,
missing exit evidence, malformed output and scan blocks are refused.
Subject, attempts, failure counts and global cooldown remain intact. No credit
is granted. Author dispatch, consumed evidence, scan and permanent failures,
and live or ambiguous owners return `action:"needs-human"`.

The exact additional operator policy grant is
`transient_retries: [{principal, requestId, binding, maxRetries?}]`, with an exact queue-v1
binding. It is required in addition to the existing `write` principal and
repository/target permissions; read permission alone grants no retry authority.
The optional integer `maxRetries` is 1–100 and defaults to 3. Accepted retries
are counted durably per request ID in queue state; every alias needs its own
explicit operator grant (including its own request ID and binding). The budget
is not shared across alias IDs; each failed receipt is consumed
for retry only once, with replay reporting its previous acceptance. A fresh
failed attempt requires its own expected receipt and cannot bypass the grant
budget. Existing cooldowns and scheduling caps remain in force.
No policy is activated by this change.

A successful durable transition returns `action:"accepted",accepted:true`.
Replay of the same expected receipt (including a lost response or a competing
caller) returns `action:"already-accepted",accepted:false`. Retain the same
request ID, binding and expected receipt after an uncertain response.

Retry busy responses return `action:"busy",accepted:false,reason:"not-applied"`.
A supported probe with a denied grant returns
`action:"denied",accepted:false,reason:"no-permission"`. The probe performs no
queue mutation and never takes tick.lock. An unavailable retry capability returns `state:"unsupported"`; no retry
is inferred.

Drain returns `state:"unsupported"` immediately on an unsupported capability.

## Local review scope and target freshness

`cq review.submit --repo=owner/repo --target=main` selects the complete committed
merge-base-to-HEAD diff. A local branch always supplies its own commit, even when
its configured upstream is newer. When the two differ, `value.targetFreshness`
reports `local` and `upstream` commit SHAs plus `ahead` and `behind` commit counts.
This is advisory metadata based on existing local refs: submission does not fetch
or substitute the upstream. It is saved with the request and preserved on retries.
Missing upstream refs do not prevent review.

Use `--base=<commit-or-ref>` to choose a specific base. It must resolve to an
ancestor of HEAD; its resolved commit and trees enter the existing review identity.
A retry with the same request ID keeps that identity, and a supplied base must
resolve to the saved base. Omitting base on retry reuses the saved scope. Server
validation and receipt adequacy still apply; a review with a different base is not
reusable for a later PR merely because the head matches.

Fully qualified refs such as `--target=refs/remotes/origin/main` are supported.
For shorthand targets, local branch/tag/remote names must be unambiguous. If no
such ref exists, a sole `origin/<target>` tracking ref is accepted. Multiple remote
candidates are refused, as is a lone non-origin candidate; name the full ref in
those cases. A local branch remains selected when remote tracking refs also exist.
