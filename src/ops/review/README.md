# Review addressing

`review.address` fixes or records a disposition for local findings or PR
threads, then re-runs review until clean or the configured round cap. Run
`review.run` first for a local findings record, or provide `--record`.

```sh
cq review.address --repoRoot=. --source=local --maxTokens=25000000 --wallMs=14400000
cq review.address --repoRoot=. --source=pr:123 --maxTokens=25000000 --wallMs=14400000 --push
```

`cq.json` supplies checks, worker/rescue/reviewer roles, review rounds,
blocking severities, address concurrency (default two), escalation and
budgets. The run token budget has no default. `--base` accepts an immutable
commit SHA for repositories without a fetched target branch. Publication is
opt-in; without `--push`, local commits remain available and PR mutations
are withheld. Explicit parent cancellation stops publication; a local
budget stop can still publish earlier verified commits.

Findings records carry `reviewed: { base, scope }`: the immutable comparison
commit and `full` or `uncommitted` review scope. Local clean acceptance requires
a full review against the addressing run's pinned base, in addition to exact
branch/head, terminal sources and a clean index/worktree. Older records remain
readable but lack that proof; run `review.run` again before accepting them as
clean. An uncommitted-only review cannot certify the full target diff. The
producer attaches reusable proof only when it started clean and its exact
branch/head/dirty identity remained unchanged through review. Reviews of dirty
content still retain findings, but cannot certify a subsequently restored HEAD.

Workers share one checkout but edit only their assigned literal file.
Missing scope and overlapping files are refused or serialized. Workers
cannot stage, commit or run commands. The engine serializes each candidate
over the latest verified parent in a detached checkout. Related checks,
mandatory read-only feedback, broader regression checks, protected-path and
tamper checks, commit-message checks and reviewer closure all inspect that
candidate. The final commit must match its gated tree and parent. A
sibling's uncommitted bytes cannot supply check or closure evidence.
Fresh PR candidates may reuse the caller checkout's installed dependencies
when package manifests and lockfiles match. Reuse inspects installed dependency
links, including transitive links, and refuses links into caller, worker or other
checkout source. Ordinary installed package stores remain reusable. Inspection
checks cancellation and the unit budget, and refuses trees above 20,000 entries;
otherwise install isolated dependencies in the PR worktree before retrying. Dependency provisioning never runs an
install command on a worker's behalf. Canonical repository aliases retain
the same file identity; outside symlinks remain refused.
Rejected/deferred code citations are verified at the worker's observed
execution head, even when admission waits across a sibling commit. The engine
returns that identity to the loop, which verifies its ancestry before validating
citations or stamping replies. Git operations use literal pathspecs and path lists
use NUL delimiters, retaining pathspec-like names, Unicode, whitespace, newlines
and quotes as literal filenames. Parent cancellation reaches baseline, related and broader check
subprocesses; the engine awaits child termination before candidate cleanup,
restoration or releasing its serial validation boundary.

The engine uses the shared escalation allocator: configured worker
attempts, then bounded rescue, then human. An affirmative broader
regression routes directly to rescue. Human escalation preserves successful
sibling commits. Failed attempts are retained as ordinary single-parent commits on
local `cq-address/<run-id>/failed/review/<package>/<finding>/a<n>` branches.
Capture copies only the assigned file into an isolated candidate based on the
latest verified parent; a sibling's dirty bytes and index entries are excluded.
The immutable parent and the earlier per-dispatch execution head are reported
separately. Create-only references preserve occupied ordinals; worker and rescue
history continues the sequence, with bounded collision retries and SHA-256 support.
After capture the engine restores only the assigned file. Cleanup remains serial
and cancellation-independent. It never stages the entire shared checkout or uses
stash refs. Failed branches stay local, including when `--push` publishes successful
verified commits; review.address has no failed-branch publication option.
Unknown edits and unexpected index or HEAD changes fail closed. Retry and
shared-tree stops use engine-owned refusal, cancellation and budget evidence;
model-written reason prose cannot stop a sibling or bypass rescue.

Every provider request is scanned before sending, including decoded tool
output and read-path provenance. Gitleaks defaults always apply; an
explicit `review.denylistPatternsFile` adds repository rules. Missing or
failed scanners refuse uploads. Before rescue, the owned file must be clean.
The prior immutable parent-to-attempt patch, both file contents, commit metadata
and report provenance are scanned before both the edit and feedback requests.
Immutable file contents retain leading whitespace and trailing newlines so
path-scoped repository rules see the original text.
Moved branch tips, unexpected parentage, unowned paths, oversized or binary
feedback refuse rescue.

Dispositions use `dev.disposition`. Deferred blocking findings remain open,
including when later reviewers omit them. A fresh open finding cannot be
silenced by an earlier fixed disposition. Exit 0 requires complete review
sources and no open blocking findings; round, budget, environment and
human stops return exit 3 with a report. Invalid CLI input returns the I1
input error. The full report is written to the journal directory on every
op exit, with usage, attempts, model identities, reasons, gates, evidence,
open findings and distinct verified commit count (`fixesPerRun`). Unknown
USD prices remain absent. `failed[]` lists retained branch/SHA pointers, finding,
unit, tier/model, ordinal, outcome, gate, reason, parent and execution head. Each
editing attempt and fix retains its failure history; unresolved findings carry
an evidence pointer. Cancelled exits still write retained pointers to the report.

PR replies and thread resolution use the current authenticated identity,
fresh head/round proof and verified publication. Successful dispatch receipts
live under the repository's Git common directory at
`cq-review-address/<namespace>/dispatch.jsonl`, independently of the run-specific
report directory. The namespace binds repository, PR, target/base, head
repository/branch and authenticated actor. A default rerun can recover a landed
reply whose resolution failed without invoking the editing worker or reposting
the reply. Fresh terminal reviewer validation remains required and its usage is
accounted. A stored receipt without
the fetched authenticated reply cannot authorize a carry-forward resolve.
Unchanged rejections can post evidence but never resolve a thread. Once
clean, resolved human thread authors are re-requested once. Bot authors are
excluded from the human reviewer API and recorded as an advisory skipped
re-request; the report never claims a bot re-request succeeded. Forge
failures retain the report and return needs-human. Current thread replies
are included in both worker and candidate closure review inputs. The shared
dispatcher's optional `signal` stops each new push, reply or resolution after
cancellation, including while waiting for its dispatch-log lock. In-flight
successful responses still receive durable receipts for safe replay; callers
without a signal retain existing behavior.

Addressing owns a canonical Git common-directory lock from admission through
worker edits, cleanup and publication. A second invocation refuses immediately
and writes its own needs-human report without entering the worker tree. Linked
worktrees share this conservative exclusion domain; disjoint workers within one
invocation retain configured parallelism. Index mutations use a separate stable
canonical checkout lock and the existing in-process FIFO. Execution-head
admission joins that FIFO, so a sibling commit cannot be observed before its
parent/tree verification and registration complete. The optional Git mutex
`failFast` setting changes ownership admission only; default waiter, stale-lock
recovery, heartbeat, cancellation and release behavior remain intact.

Adopted repositories need no `.cq/` ignore rule for verified publication.
Addressing registers exact ledger and findings-record paths only after validated
admission/engine writes, fingerprints their bytes, and exempts only unchanged
ordinary untracked bookkeeping files. Tracked changes, other untracked files
(including other `.cq/` paths), replaced bookkeeping and changed index entries
still withhold publication and replies. The optional runtime
`publicationTreeClean` review-loop hook and worker `isBookkeepingPath` predicate
apply the same hygiene boundary; neither broadens the frozen result schema.

Existing bookkeeping fingerprints are checked before admission, disposition and
reviewer ledger writes. A composition-owned FIFO spans each check, engine write
and fingerprint refresh, including the worker's complete untracked Git snapshot
and per-path fingerprint classification. A Git subprocess cannot capture a ledger's
transient publish file and classify that stale path after rename. Names resembling
ledger temporary files receive no exemption; caller files still refuse. Disjoint
editing workers still run concurrently. Any mismatch remains a sticky refusal, retains
changed bytes and verified local commits, and withholds publication, disposition
proof and further reviewer dispatch.

A fresh PR invocation restores prior bookkeeping only through a private exact-byte
receipt in Git's existing PR/target/actor namespace. The receipt binds the canonical
checkout, branch, HEAD and each allowed ledger/history path and SHA-256. Every entry
must be an ordinary file with matching bytes, valid branch schema and ancestral
record heads; all entries validate before any ownership is registered. Filename or
schema alone cannot admit PR history. Missing, partial, stale or corrupt receipts
leave existing metadata untrusted; older worktrees without receipts fail closed.
Caller files and changed metadata are preserved for manual recovery.

The optional worker `prepareBookkeeping` hook restores this ownership inside
initialization's mutation/checkout lock before untracked inspection. Receipt refresh
settles at the end of the existing successful bookkeeping FIFO transaction, after
all engine-written fingerprints refresh. Its create-only temporary file is closed
and cleaned independently of cancellation; caller changes to the receipt refuse
replacement. No-job publication uses the same initialization fence. Initial PR
admission refusal stops before ledger loading or re-review; normal edit failures
retain their existing re-review behavior. These private author-tier receipts do
not establish current clean/rejection proof or alter public report schemas.

PR findings capture and ledger admission use the worker's optional runtime
`withVerifiedHead` callback under the same mutation FIFO and checkout lock as
commit verification. Initialization completes before admission; callbacks do not
acquire the mutation FIFO again. Lock order stays mutation, checkout, bookkeeping.
External HEAD movement and cancellation refuse admission, while existing injected
workers without the callback retain their previous behavior. Editing and model
execution remain parallel outside this short admission section.

Closure uploads scan the exact candidate patch, immutable parent leaf and candidate
tree leaf with their repository-relative file path before invoking the reviewer.
The same raw source bytes accompany every actual request scan, including retries;
leading whitespace and final newlines are preserved. A clean current-round
rejection is retained only when refreshed authenticated discussion/head proof
still matches its ledger disposition. New reviewer feedback reopens the finding.

## Bounded agent review

`review.run` and `dev.review` use the configured reviewer role for sequential
partitions of every captured diff component. No content is truncated. Each
partition carries immutable head/base/scope identity, original path and patch
line attribution, a hash-bound receipt, and an exact non-overlapping UTF-16
coverage range. Up to 2,000 preceding characters and the current hunk marker
are repeated as explicitly separate context; surrogate pairs remain intact.
The coverage manifest records the SHA-256 of each original component, completed
ranges and actual request sizes. A missing, replayed or invalid receipt blocks
completion. Identical findings repeated by overlapping context are deduplicated.

The unchanged harness limit is 20,000 **system-prompt characters**. Partition
instructions, provenance and context count toward that limit; the driver fits
its own preamble into the remaining room. This is not a 20,000-character limit
on the entire invocation or serialized wire request: the supported driver also
includes the task as a user message. The complete serialized request and decoded
leaves are scanned before every send and measured separately in the manifest.
Original unsplit components retain their paths for the mandatory defaults and
configured scans, including patterns that span a partition boundary.

All partitions share one wall deadline, cancellation signal and remaining token
allowance. Driver-reported input, output, cache and additive reasoning usage
consume that allowance; the existing token cap is a post-request bound, not a
new hard wire reservation. Failures preserve prior validated findings and partial
coverage in blocked evidence. All configured review sources must still finish,
and repository drift withholds reusable clean proof.

Complete coverage means every captured character was submitted in a validated
partition. It does not guarantee semantic completeness: partitions have bounded
local context, and no reducer or global cross-file analysis is performed.
