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

`review.run` and `dev.review` send the whole change, bounded commit-message intent,
file list and change-kind instructions to one read-only reviewer session when it
fits `review.session.maxInputChars` (default 60,000 characters). The reviewer can
read numbered file windows and use contained `grep` and `glob` searches. Set
`review.searchTools: false` to retain only `read`. The operation prompt appears
once as the user message; system messages contain the driver preamble only.

The configurable small tier defaults to at most 200 changed lines and five files;
the medium tier to at most 800 lines and 20 files. A session gets a model-step
budget by tier (small 4, medium 6, capped by `review.session.maxSteps`), stated in
the prompt; the last step has no tools. The budget bounds the main loop: if the
final reply is not valid JSON, the driver's single schema-repair call runs on top
of it and is reported as one extra step. Documentation/configuration changes
ask for source-of-truth checks, and exported/schema changes ask for caller and
contract checks even when small. A change above the medium tier, or a prompt
above the session input limit, uses sequential tool-free partitions and emits an
advisory about limited cross-file context. Partition payloads cover every
nonexcluded component without truncation, with bounded preceding context and
surrogate-safe UTF-16 boundaries. There are no area sessions or cross-session
retries. A session that fails (for example a step timeout) does not stop the
remaining independent partitions; the result is still `needs-human` naming the
first failure and the incomplete pieces, but carries every other session's
findings. Two consecutive failed sessions stop the run. Repeated findings are deduplicated.

Coverage v2 retains every original component's path, hash, size and state:
`planned`, `delivered`, `completed` or `excluded`. Only a clean `model-request`
hook containing the exact decoded prompt and planned component ranges records
delivery. Tool-output hooks cannot prove delivery, even if their text mimics a
request. A component completes only after all its nonoverlapping ranges reach
schema-valid complete sessions. Every session must complete, and the coverage
head/base/scope must match the reviewed record. The model returns findings only;
it provides no receipt or file-coverage attestation. Old coverage remains readable
and is labelled legacy, using its original completeness rule on old records.

`review.exclude` defaults to empty. Each explicit glob retains an excluded piece
and may name an `assuredBy` deterministic check. An exclusion without assurance
appears as a limitation. Excluded paths remain in the file list. An all-excluded
review is complete but emits an explicit no-content advisory. Advisories live
outside findings, appear in logs/readiness/PR reports, and never enter fixer
dispatch or blocking-finding counts.

Every request and decoded leaf is scanned before sending, including repairs and
tool outputs with source provenance. Original nonexcluded components are also
scanned under their source paths before dispatch, including secrets spanning a
partition boundary. Session evidence records request sizes, usage, observed
steps, denial count and the actual driver transcript ID for tool-result auditing.
Recoverable denied or truncated lookups remain visible and do not alone make
prompt coverage incomplete.

One wall deadline, cancellation signal and token allowance cover all sessions
and repairs. Driver-reported input, output, cache and additive reasoning usage
consume the allowance. The token guard is checked after settled requests, so it
can overshoot; it is not a hard wire reservation. The default main-loop step cap
is 15; one tool-free JSON repair may add a step. Failed, aborted, undelivered or
budget-exhausted sessions retain findings and incomplete coverage as blocked
evidence. All configured sources must finish, and repository drift withholds
reusable clean proof.

Re-review always covers the whole branch against the pinned base. Prior findings
and dispositions accompany it unless `review.reReview.includePriorFindings` is
false (default true). Fixes-only review needs a separate admission/coverage
design. Complete engine coverage proves delivery and completion, not that the
reviewer found every semantic defect.
