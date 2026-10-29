# review.address fixture transcript

Captured on triton from fresh fixture repositories. The spawned production
CLI uses a scripted provider factory, real git, a hermetic executable
gitleaks through production scanner composition, the dev ledger and the
production `review.run` re-review. No provider credentials or network are
used. The fixture omits `review.denylistPatternsFile`, exercising portable
default scanning. Each invocation starts a fresh repository.

```sh
pnpm test:narrow --include-integration test/e2e/review/review-address.e2e.test.ts test/cli/registry.test.ts
```

Each fixture executes this command with temporary paths and its configured
worker model/token budget:

```sh
node test/fixtures/address-cli/entry.mjs review.address --repoRoot=<fixture>/repo --source=local --base=<seed-sha> --record=<fixture>/findings.json --journalDir=<fixture>/journal
```

Observed results from the fresh fixture run:

| Worker   | Budget | CLI exit | fixesPerRun | Open blocking | Token usage       |
| -------- | -----: | -------: | ----------: | ------------: | ----------------- |
| scripted |   1000 |        0 |           1 |             0 | input 8, output 4 |
| defer    |   1000 |        3 |           0 |             1 | input 4, output 2 |
| scripted |      1 |        3 |           0 |             1 | input 2, output 1 |

Success produces one commit touching only `src/a.ts`, with the seeded
commit as its parent, after edit, feedback and reviewer closure. Actual
re-review returns no findings. The deferred finding stays open at the
round cap. The one-token budget case reports the settled call's three
tokens honestly, restores the partial edit and starts no further provider
call. Cost is absent for the unpriced scripted models. All three stdout
artifacts retain their full report and exactly match
`<journalDir>/review-address-report.json`.

Separate SDK tests exercise the PR cycle with a fake forge, in-memory git
and scripted driver: engine-owned candidate gates, verified publication
before reply/resolve, a human sibling retaining its open finding while
the successful sibling publishes, and publication opt-out. Real-git causal
tests hold a sibling edit uncommitted while related checks and reviewer
closure run; neither gate can borrow that content. Legacy review-loop tests
pin both execution orders for unchanged evidence and refuse journal-only
resolve carry when the authenticated reply is absent.
The follow-up checkpoint also spawns the successful local CLI through a
symlink alias to the repository root, and tests canonical task identity,
outside-symlink refusal, fresh-checkout dependency reuse, nested governor
accounting, follow-up discussion, and same-file/fileless human settlement
without blocking a verified sibling's publication. Benign feedback/closure
prose mentioning an index, budget, cancel or upload reaches rescue and leaves
sibling work eligible; actual driver stops, parent cancellation and candidate
mutation still refuse and retain evidence.

Live dogfood is recorded separately in `dogfood-log.md`. `dev.cycle` is
sequenced after S6 and is unavailable for this slice's initial exercise.

The follow-up causal controls use real Git records and worktrees: a terminal,
head-only clean record refuses staged, unstaged or untracked source content;
a stale branch/head or incomplete source never becomes clean. A saved PR
rejection survives a fresh invocation only with its current-head disposition
and a fetched reply from the authenticated responder binding the same head
and discussion round. Missing replies, forged authors, legacy headers, stale
rounds/heads and positive resolve intent do not establish rejection carry.

CodeRabbit re-review uses the remaining composition wall budget and parent
cancellation signal through host-lock admission and the subprocess. Waiting
aborts cancel the retry timer; cancellation between acquisition and callback
releases the lock without dispatch. An aborted child settles after termination,
and blocked cycle logs and partial findings remain available. Evidence and
restore cleanup do not inherit work-admission guards. A reviewer that returns
terminal output after the deadline cannot produce an exit-0 clean result.
These controls are hermetic checks, not additional live dogfood runs.

The required #445–#447 repair checkpoint adds actual `review.run` → local
`review.address` controls. A clean, full record against the same immutable
base exits 0; uncommitted-only, missing-proof and different-base records
refuse. A matching explicit narrow base is accepted only when addressing
requests that same base. Moving the target ref during a scripted fix does
not change the re-review comparison.

Real check children signal readiness before parent cancellation. Baseline,
related and broader cases must settle before the configured check timeout;
the child PID must already be gone when the operation returns, candidate
worktrees must be removed, owned edits restored and later dispatch withheld.
Path controls commit exact Unicode, space, newline, quote and trailing-newline
filenames alongside a parallel sibling, checking each commit's NUL-delimited
path list and the clean final index/worktree.

The named regression set was also run against the original five source
files: 19/168 failed, including each of the three defects (the space-name
control passed). Restoring the repair produces the passing focused
checkpoint below. The spawned CLI again observed success exit 0 and honest
defer/budget exits 3; these remain hermetic fixture evidence, with no new
production dogfood or CodeRabbit invocation.

```text
test:narrow result="pass" exit=0 files=7 projects="pure,process" tests="179/179" failed=0 skipped=0 wait="0.0s" duration="34.4s" nice=5 load="1.6" uptime="536466s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/gates/adapters.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/findings.test.ts,test/ops/review/run.test.ts"
test:narrow result="pass" exit=0 files=7 projects="pure,process,integration" tests="198/198" failed=0 skipped=0 wait="0.0s" duration="15.2s" nice=5 load="2.3" uptime="536506s" source="explicit" ran="test/cli/registry-props.test.ts,test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/registry.test.ts"
```

### Late producer identity and publication recovery repairs (#448, #449)

A full review of an uncommitted repair cannot prove the restored original HEAD
clean. The hermetic actual `review.run` → restore → `review.address` fixture
covers staged and unstaged repairs, deleted untracked additions, and mutations
during review; all withhold clean reuse. Clean matching-base controls remain
accepted. No provider or forge network is used.

A separate fake-forge fixture lets the verified fix push and reply succeed,
then fails thread resolution. Two invocations omit `journalDir` and receive
different report paths. The second invocation uses the stable Git-common-dir
publication receipts: its only forge mutation is the pending resolution, it
performs no editing/feedback/closure worker call, and it still requests one
fresh terminal reviewer validation. This is not a claim of zero reviewer
provider use. Missing receipts, a forged reply author, stale head, changed
actor, and changed target cannot borrow that resolution authorization.

Against the original source at `4c0a55d7`, these new causal cases failed:
`26/31` passed, with four producer-identity refusals and pending-resolution
recovery failing. The repaired focused checkpoint passed `67/67`.

Final checkpoint:

```text
test:narrow result="pass" exit=0 files=10 projects="pure,process,integration" tests="292/292" failed=0 skipped=0 wait="0.0s" duration="43.8s" nice=5 load="1.9" uptime="538133s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/replyAndResolve.test.ts,test/ops/review/run.test.ts,test/plans/review-loop.test.ts"
```

Static, formatting and Knip checks exited 0. Op docs regenerated with no drift.
Live dogfood acceptance remains unmet; these are hermetic tests.

The required #450/#451 controls hold a real editing worker open while a second
invocation with a distinct default UUID journal targets the same checkout,
a symlink alias, or a linked worktree. The peer returns needs-human before any
editing dispatch or commit; the original provider tree remains intact. After
release the original fix commits and a later clean invocation succeeds. The
repository-wide exclusion conservatively serializes linked worktree runs;
within-run disjoint worker concurrency remains covered by the candidate tests.

The real PR adapter fixture now omits `.cq` ignore rules. Its scripted edit
passes related, feedback, broader, staged-tree closure and commit gates; a real
Git push to the fixture's bare origin precedes the fake-forge reply and resolve,
then actual terminal re-review and the human reviewer re-request complete.
Untracked caller bytes at `private.txt` or `.cq/private.txt` withhold push and
all replies/resolution while retaining the verified local commit and original
bytes. A file-only Git protocol guard prevents fixture network access; its fake
forge URL maps explicitly to the temporary bare repository. This is hermetic
acceptance evidence, not positive live dogfood.

The same no-ignore fixture also refuses an index entry whose working-tree bytes
were restored, and changed ledger bytes remain intact while publication and
further reviewer dispatch stop. Legitimate reviewer ledger revisions support a
second verified fix round. Historical numbered findings records qualify only
with a strict schema, matching branch and real ancestor commit; malformed,
wrong-branch and unknown-head neighbors withhold clean acceptance.

Causal old-source check (only address/addressWorker restored temporarily, then
all working changes restored):

```text
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="23/29" failed=6 skipped=0 wait="0.0s" duration="17.9s" nice=5 load="0.8" uptime="539532s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts"
```

Final required checkpoint:

```text
test:narrow result="pass" exit=0 files=10 projects="pure,process,integration" tests="294/294" failed=0 skipped=0 wait="1.8s" duration="55.5s" nice=5 load="1.8" uptime="540111s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressWorker.test.ts,test/ops/sweep/gitMutex.test.ts,test/plans/review-loop.test.ts"
```

No new live run or CodeRabbit invocation was made. Positive live measured-fix
acceptance and settled failed-branch API reconciliation remain outstanding.

An earlier timing regression appends a newline to the real PR ledger from the
candidate closure callback, before returning `closed: true`. On eca769cc this
laundered the changed bytes through disposition and advanced the fixture's bare
origin; the test failed its unchanged-remote assertion:

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="16/17" failed=1 skipped=0 wait="0.0s" duration="10.3s" nice=5 load="0.5" uptime="540557s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts"
```

Admission, disposition and reviewer ledger writes now check all existing owned
fingerprints first. A composition FIFO serializes check/write/hash refresh and
worker bookkeeping reads. The real two-file PR control holds both editing calls
until both have entered (maximum concurrency 2), then verifies both commits,
both durable dispositions, checked publication, both replies/resolutions and
terminal review. The closure-tamper control retains the verified local commit
and changed ledger bytes, with no push, reply, resolution, false disposition or
new reviewer dispatch. This delta adds no shared API or kernel/schema change.

Final prewrite checkpoint:

```text
test:narrow result="pass" exit=0 files=10 projects="pure,process,integration" tests="296/296" failed=0 skipped=0 wait="1.8s" duration="60.2s" nice=5 load="1.5" uptime="540935s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressWorker.test.ts,test/ops/sweep/gitMutex.test.ts,test/plans/review-loop.test.ts"
```

The fixture rendezvous cancellation uses the driver runtime options signal.
After that test-harness typing correction, the affected file passed again:

```text
test:narrow result="pass" exit=0 files=2 projects="pure,process" tests="18/18" failed=0 skipped=0 wait="0.0s" duration="11.4s" nice=5 load="1.3" uptime="541038s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts"
```

The macOS `eca769cc` CI rejection (`addressWorker.ts:110`, checkout index
identity unavailable) came from eager asynchronous lock setup. An unused worker
or an unanchored/unsafe finding could finish before setup rejected, allowing
checkout cleanup to race its Git command. The new injected-identity-failure
controls reproduce this on Linux before the worker repair: three lifetime
assertions fail and Vitest reports four unhandled rejections.

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="57/60" failed=3 skipped=0 wait="0.0s" duration="18.9s" nice=5 load="0.3" uptime="541693s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/addressWorker.test.ts"
```

Lock identity now initializes lazily within the awaited mutation FIFO. It remains
canonical and fail-closed: unavailable identity defers both concurrent findings,
dispatches no driver, changes no index/file/HEAD, and makes one identity request.
Unused and early-refused workers perform no identity lookup. The combined final
checkpoint includes the early closure-tamper and parallel PR publication controls:

```text
test:narrow result="pass" exit=0 files=10 projects="pure,process,integration" tests="300/300" failed=0 skipped=0 wait="0.0s" duration="78.9s" nice=5 load="0.9" uptime="541738s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressWorker.test.ts,test/ops/sweep/gitMutex.test.ts,test/plans/review-loop.test.ts"
```

Static (zero errors against baseline zero), formatting and Knip exited 0 on
triton. These are hermetic source/CLI checks; macOS confirmation and full-suite
numeric evidence remain CI's responsibility. No new live or CodeRabbit run was
made. Positive live measured-fix acceptance, #438 and settled #440 failed-branch
API reconciliation remain outstanding; this repair does not claim whole-PR
acceptance or authorize merging.

2026-10-24 settled #440 adaptation and late #453/#454 controls

Merged #440's settled helper/API from queue merge f83d18f3 in clean merge
commit dd63a9fd. S6 reuses commitFailedAttempt only in a detached candidate
based on a verified parent, with its own index and only the assigned file.
It does not reuse the unit caller's whole-tree staging/restoration. Ordinary
local failed branches replace legacy stash evidence refs. Actual single-parent
commits carry the settled trailers; create-only collision retries stop at 32,
worker/rescue ordinals continue, and SHA-256 repositories are exercised. The
per-dispatch execution head remains distinct from the current verified parent.

Real-Git rendezvous controls hold sibling dirty bytes while failure capture
runs: only the owned path differs in the retained commit, the sibling stays
dirty, and its own later attempt retains a separate branch. Another control
lets a sibling commit before failure capture and asserts the later verified
parent alongside the earlier execution head. Rescue starts with a clean owned
file and receives the immutable prior patch. Both edit and mandatory feedback
scan its patch, parent/failed contents, commit metadata and report provenance;
positive/missing/fault scans, moved refs, unexpected parentage/unowned paths,
binary/invalid text and size caps refuse upload. A refused pre-dispatch scan
does not overwrite the earlier editing attempt's pointer. Reports, attempt
rows and finding evidence retain branch/SHA history on failed/cancelled exits.
A successful --push run publishes verified commits while its failed branches
remain absent from the fixture's bare origin. Cancellation/budget cleanup
stays in the FIFO and checkout lock without cancellation admission.

#453 serializes execution-head admission with commit verification/registration.
The causal test holds the new commit between HEAD movement and registration;
a sibling waits then dispatches successfully. #454 adds optional signal to
ReplyAndResolveOpts and passes it through review-loop. Each new push/forge
mutation checks cancellation, including after dispatch-log waits. In-flight
landed responses still record durable receipts; replay skips those receipts.
No-signal behavior is unchanged. Held initial push/reply/resolve/log-lock and
composed-loop controls prove no hidden subsequent resolution after cancellation.

Causal before control: temporarily removed only the admission synchronization
and per-mutation cancellation checks, preserving the evidence adaptation; then
restored the exact guarded source bytes. Six expected controls failed (one
admission, four dispatcher timings, one composed held reply):

```text
test:narrow result="fail" exit=1 files=4 projects="pure,process" tests="231/237" failed=6 skipped=0 wait="0.0s" duration="29.1s" nice=5 load="0.0" uptime="543401s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/replyAndResolve.test.ts,test/plans/review-loop.test.ts"
```

Guarded focused checkpoint (includes local report/cancellation and rescue
controls in addition to the three causal files):

```text
test:narrow result="pass" exit=0 files=5 projects="pure,process" tests="254/254" failed=0 skipped=0 wait="0.0s" duration="57.5s" nice=5 load="0.2" uptime="543451s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-local.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/replyAndResolve.test.ts,test/plans/review-loop.test.ts"
```

The PR orchestration fake also needed immutable execution-head file reads for
its human citation; the original fake silently fell into provider-failure
cleanup. It now serves that Git boundary and requires the actual human reason.
The real-Git fixtures, CLI and immutable-feedback guard tests are separate.

No CodeRabbit or live run was repeated. The earlier 223d macOS CI completed
successfully, as reported by the chancellor. This adaptation needs independent
exact-head review and fresh required CI; hermetic checks do not satisfy positive
live measured-fix acceptance. #438 remains separate and no whole-PR PASS or
merge is claimed.

Remaining PR adapter/CLI/registry/feedback-guard checkpoint after the
phase-one fixture correction:

```text
test:narrow result="pass" exit=0 files=8 projects="pure,process,integration" tests="119/119" failed=0 skipped=0 wait="0.0s" duration="56.1s" nice=5 load="1.2" uptime="543692s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressEvidence.test.ts,test/ops/sweep/gitMutex.test.ts"
```

The two final batches cover 371 distinct tests (the two process-inventory
controls appear in both). Static exited 0 with zero type errors against baseline
zero; formatting and Knip exited 0; generated-doc verification exited 0 with
54 op docs current. No baseline or policy changes.

## Immutable rescue leaf whitespace correction (#455)

Independent source review of `282f48b6` identified loss of leading/trailing
whitespace in the production Git wrapper before immutable failed-attempt leaves
reached the upload scanner. The real repository scanner with path
`^src/a\.ts$` and regex `^ PRIVATE` missed ` PRIVATE\n` after trimming;
the rescue driver ran and incorrectly returned fixed. A clean control observed
`BAD`/`PUBLIC` instead of the original `BAD\n`/` PUBLIC\n`. The fixture
policy is committed before admission so the unknown-file guard does not mask
this boundary. Both controls fail on unchanged source:

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="72/74" failed=2 skipped=0 wait="0.0s" duration="41.0s" nice=5 load="3.3" uptime="544210s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/addressWorker.test.ts"
```

The Git wrapper now retains raw `show` and diff output, including leading
whitespace and trailing newlines; object IDs, sizes and command receipts remain
normalized. Existing immutable-feedback expectations now require newlines. The
clean production-worker control asserts both exact leaf texts at all four
rescue edit/feedback invocation/provider scans; the positive policy control
refuses before any rescue driver call. Existing binary, cap, provenance,
parentage and path refusal controls remain:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="81/81" failed=0 skipped=0 wait="0.0s" duration="49.1s" nice=5 load="4.1" uptime="544272s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/addressEvidence.test.ts,test/ops/review/addressWorker.test.ts"
```

Static exited 0 (zero type errors, baseline zero), formatting exited 0, and
Knip exited 0. No baseline, shared API or policy change. This source correction
requires independent exact-head review and CI; live-positive acceptance and
#438 remain separate. No CodeRabbit or live run was repeated.

PR adapter/local report regression checkpoint:

```text
test:narrow result="pass" exit=0 files=5 projects="pure,process" tests="84/84" failed=0 skipped=0 wait="0.0s" duration="37.1s" nice=5 load="4.1" uptime="544345s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts"
```

## Late execution identity, literal path and dependency isolation repairs (#456–458)

The three late threads on independently reviewed `de1e45e2` exposed distinct
boundaries that earlier controls did not cover. Before changing source, the
new real-Git controls failed exactly four cases: a rejection admitted after a
verified sibling commit lost its current-head citation/reply; caller and worker
workspace dependency links incorrectly supplied check evidence; and failure of
an owned `:(exclude)never.ts` restored a sibling's active edit. The complete
unchanged-source checkpoint was:

```text
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="90/94" failed=4 skipped=0 wait="0.0s" duration="89.2s" nice=5 load="5.9" uptime="545731s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/addressWorker.test.ts"
```

The PR adapter now returns the engine's actual `observedHead` for successful and
rejected results. The loop consumes this optional metadata only with its
engine-owned concurrency adapter, checks the early-to-actual-to-current ancestry,
and uses the actual head for citation validation and reply stamps. Malformed or
unrelated identities refuse before forge mutation. This is an additive
`FixReviewItemResult` interface change; the vendor output schema remains strict
and does not accept that field. Existing non-engine defaults remain covered.

Every owned-file Git operation now passes the shared `GIT_HARDEN` prefix,
including `--literal-pathspecs`. Concurrent failure retains only the magic-named
owned leaf in its ordinary failed-attempt branch, restores only that leaf, and
preserves the held sibling edit. A successful magic-filename case also verifies
single-file commit content and a clean shared index.

Candidate dependency reuse now inspects the physical installed tree and its
transitive links. Links into known caller/worker source or another checkout's
source refuse before any baseline/related check starts, even with matching
manifests. This includes a linked installed root. Ordinary package stores and
cycles remain supported. The traversal checks cancellation/unit budget and
refuses more than 20,000 entries; large or inaccessible trees therefore require
isolated installed dependencies. It does not install packages or rebind source
links. Existing execution/mutation parallelism and cancellation-independent
cleanup remain in place.

One broader checkpoint initially failed 17 PR orchestration fixtures because
their Git fake rejected the new global hardening prefix before worker execution.
The fake now recognizes the exact shared prefix; the real-Git controls remain
separate. The initial test typing error was also corrected without baseline
changes. These intermediate failures are not counted as passing evidence.

Final repaired checkpoint:

```text
test:narrow result="pass" exit=0 files=7 projects="pure,process" tests="264/264" failed=0 skipped=0 wait="12.9s" duration="159.6s" nice=5 load="10.9" uptime="546226s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/addressDependencies.test.ts,test/ops/review/addressWorker.test.ts,test/plans/review-loop.test.ts"

```

The separate local report and SDK adapter cases also passed in the broader
checkpoint. Static exited 0 with zero errors against baseline zero; formatting,
Knip and generated-doc verification exited 0 (54 op docs current). No baseline,
frozen schema or policy changes. The complete feedback sweep found 23 threads,
including only these three applicable unresolved threads before fixed-SHA replies;
all nested thread pages were complete, with REST inline/review/top-level channels
cross-checked. Fresh independent exact-head review and CI remain required.
Positive live measured-fix acceptance remains unmet, #438 is being implemented
in a separate lane, and no third live or CodeRabbit run was performed. No
whole-PR acceptance marker or merge is claimed.

## Combined bounded-review integration (#438)

Reviewed address head `1c5092e306aeba3c75c100c8ade6e729fad85f1a` receives a normal
cherry-pick of independently reviewed `1b9878f95fb94421b77362cbe7c5131de39ba169`
(parent `de1e45e2`), producing `9a5bf24332a39c52839e25ecfe1220065d61d66b`.
The stable patch ID is identical (`25e87f3c0dcac37af1a3442a0d90dd3af31efde7`).
All twelve non-README lane files match the reviewed lane bytes; all eleven
non-README address files match reviewed address bytes. README contains both
sections, with the address text preserved and the lane section appended.
There were no conflicts or production resolution edits.

Shared interface changes from the integrated lane: optional source coverage
manifests and reviewer output schema `review.agent/v2`, including an exact
partition receipt. Complete original components are scanned before lossless
partitioning; every serialized request and decoded leaf still passes the
production gate. Partitions share cancellation, wall and token budgets.
Partial coverage persists and cannot establish complete review.

Combined reviewer/registry checkpoint:

```text
test:narrow result="pass" exit=0 files=9 projects="pure,process" tests="217/217" failed=0 skipped=0 wait="0.0s" duration="65.6s" nice=5 load="2.8" uptime="547179s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/dev/registry.test.ts,test/ops/dev/review.test.ts,test/ops/review/agentReviewer-partitions.test.ts,test/ops/review/agentReviewer.test.ts,test/ops/review/findings.test.ts,test/ops/review/registry.test.ts,test/ops/review/run.test.ts"
```

The first lifecycle checkpoint failed 23/290 cases because scripted reviewers
still returned v1 output without receipts. Updating only fixtures exposed six
remaining stale assumptions (single reviewer call, fixed total usage, and an
old source-drift result). The second checkpoint was 284/290. Neither failure
is passing evidence. Real local/PR/CLI fixtures now return exact v2 receipts;
usage is accounted for every dispatch, rounds count distinct reviewed heads,
and clean-record consumer tests require no further provider dispatch. The
mutation control reads the actual persisted blocked source, restores the file,
and confirms it still cannot authorize clean acceptance. Non-tampered real-PR
cases require at least one actual reviewer dispatch. Production gates were not
relaxed to satisfy fixture expectations.

A separate read-only inspection of the complete base `f83d18f3` to integration
`9a5bf243` comparison measured 59 components, 526691 characters / 526939 UTF-8
bytes and 71 partitions. All 71 actual AiSdkDriver requests were intercepted
and unconditionally stopped before send; an inert provider recorded zero sends.
Original-path, partition, serialized-request and decoded-leaf production scans
reported zero hits. Maximum composed system prompt was 20000 characters;
maximum serialized request was 42147 characters. Aggregate serialized text was
1347827 characters. This proves prompt-cap fit at that snapshot, not token
feasibility or reviewer completeness. The unchanged 60000-token/20-minute/one-round
live limits require a separately approved feasible target; no third live run,
provider dispatch or additional author CodeRabbit cycle occurred.

Final repaired fixture checkpoint (the unchanged worker, evidence, plan and PR
orchestration files passed in the preceding 284/290 checkpoint):

```text
test:narrow result="pass" exit=0 files=4 projects="pure,process,integration" tests="40/40" failed=0 skipped=0 wait="0.0s" duration="96.0s" nice=5 load="8.2" uptime="547773s" source="explicit" ran="test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts"
```

Static, formatting and Knip exit 0 after fixture updates, with zero TypeScript
errors against baseline zero. Generated-doc verification exits 0 (54 current).
The complete final feedback sweep found 23 resolved threads, no outer or nested
remaining pages, and all 51 REST inline comments represented in the thread set;
39 review summaries and six top-level comments were checked. No new applicable
finding was outstanding at that snapshot. These focused checks do not establish
whole-PR acceptance. Combined exact-head independent review, fresh required CI
and positive measured live acceptance remain separate gates. No merge is claimed.

## Ledger publish versus worker snapshot (#459)

Independent combined review at `6820a145` observed 39/40 lifecycle cases: the
concurrent sibling publication case returned one verified fix, with fix-2
refused for unknown/out-of-scope edits. The isolated named rerun passed 19/19.
Neither output captured an offending path, so the original incident's precise
path remains unknown. Original captured stdout/provenance was recovered under
`~/…`; wrapper report JSON paths are
intentionally ephemeral (`scripts/test-narrow.mjs` removes its report directory).

Static investigation found that the worker snapshots Git untracked paths before
joining the bookkeeping FIFO for per-path classification. A sibling ledger
writer can create a temporary ordinary file during atomic publish. Real Git may
capture that path, then classification waits until rename removes it and falsely
refuses the stale unknown path.

A deterministic real-PR control holds the real disposition operation, starts the
worker snapshot, and observes the real ledger publisher at rename. A real Git
command then captures the actual temporary path. On unchanged production source
it observes `.cq/dev/.cq-review-pr-7-656b93f647df80e2.json.<pid>.0.tmp` and returns
the same unknown/out-of-scope refusal with one rather than two verified fixes.
The relative path diagnostic and exact stdout are durably retained locally in
`~/….log`. This proves a causal
failure mechanism; it does not invent an unrecorded path for the earlier critic
incident. The first harness attempt timed out because it counted the initial
snapshot before the fixture knew its worker root; that harness-only scheduling
mistake was corrected before the causal reproduction and is not repair evidence.

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="19/20" failed=1 skipped=0 wait="0.0s" duration="19.5s" nice=5 load="3.5" uptime="548527s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts"
```

The repair adds optional engine-owned `AddressWorkerDeps.inspectUntracked(read)`.
The composition runs the complete snapshot and exact per-path fingerprint checks
inside its existing bookkeeping FIFO, returning both all paths and unknown
paths. The standalone worker retains its old/default per-path behavior. There
is no filename allowlist or retry-until-green behavior. Mutation FIFO, literal
paths, caller bytes, fingerprints and sticky tamper refusals remain intact.
Lock order remains worker mutation → checkout mutex → bookkeeping FIFO; no
bookkeeping action acquires worker mutation, and classification calls the direct
fingerprint check rather than recursively joining the FIFO. Execution remains
parallel; only the existing shared metadata observation boundary is serialized.

The repaired worker/PR/registry checkpoint:

```text
test:narrow result="pass" exit=0 files=6 projects="pure,process" tests="174/174" failed=0 skipped=0 wait="0.0s" duration="106.2s" nice=5 load="5.1" uptime="548577s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/registry.test.ts"
```

The stronger final control pins disposition-before-snapshot ordering, asserts
that the real rename completed before the fenced Git read, and requires no stale
temporary path to be captured. A caller-created ledger-like `.tmp` file still
blocks publication and retains its bytes. The final local/PR/CLI/plan checkpoint:

```text
test:narrow result="pass" exit=0 files=6 projects="pure,process,integration" tests="192/192" failed=0 skipped=0 wait="0.0s" duration="199.5s" nice=5 load="4.3" uptime="548703s" source="explicit" ran="test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address.test.ts,test/plans/review-loop.test.ts"
```

Static reports zero errors against baseline zero; formatting, Knip and generated
doc verification exit 0 (54 current). No provider, live, CR, coverage, baseline or
policy change. Independent delta review and fresh CI remain required. The complete
current-PR aggregate 60000-token feasibility blocker remains separate; prompt-cap
fit and focused source checks do not establish operational or whole-PR acceptance.

### Late closure provenance, admission, and refreshed rejection repairs (#460–462)

Parent baseline: `996d8e6bf000aecd1d1cf2ebd75917ab149394c4`.
The production closure verifier now scans the exact candidate patch and immutable
parent/candidate leaf bytes under the assigned repository-relative path. The same
sources accompany both invocation admission and every actual provider-send gate.
A real configured path policy (`^src/a\.ts$`) with whitespace-anchored rules
causally refused parent, candidate, and patch-only positives before closure
invocation; a clean control requires exact trailing newlines at both gates.

The new optional engine-owned `AddressWorker.withVerifiedHead(action)` captures
HEAD and admits the record inside the existing mutation FIFO and checkout mutex.
Injected workers without the method retain their previous behavior. Initialization
uses the same guards as before. Lock order is mutation FIFO → checkout mutex →
bookkeeping FIFO; bookkeeping does not acquire mutation. Worker execution remains
parallel. Cancellation is checked before entry and after awaited admission;
unregistered external HEAD movement before/during admission still refuses.

A deterministic real-Git rendezvous made the old adapter capture HEAD before a
sibling committed and return that captured value only after the sibling's verified
commit. The old admission rejected a legitimate transition; fenced admission
accepts it. Refreshed rejection classification now always requires the existing
current-head, authenticated author, and complete discussion proof, including for
current-round fixes. A fresh reviewer follow-up reopens the finding; the unchanged
positive and persisted carry controls retain strict proof requirements.

Causal before checkpoints (the second run retained the original address.ts seams,
while the unrelated closure repair was being applied):

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="77/82" failed=5 skipped=0 wait="283.9s" duration="181.3s" nice=5 load="7.8" uptime="549566s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/addressWorker.test.ts"
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="21/23" failed=2 skipped=0 wait="0.0s" duration="166.1s" nice=5 load="7.4" uptime="549759s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts"
```

The first checkpoint contains four new provenance failures and one separate
existing fixture step-budget failure. The second contains the admission race and
fresh-follow-up false rejection. Durable captured stdout is retained under
`~/…/{admission-accepted,admission-rejection}-before.log`.
The wrapper intentionally removes its temporary JSON report; these are stdout
artifacts, not reconstructed JSON.

Fixture-only stability changes preserve the configured engine/step budgets.
The cancellation fixture registers its watcher before starting the worker, reads
an atomically published readiness PID, races readiness against actual worker
completion, and closes the watcher in finally. It retains the two-second post-abort
child-close/PID-gone/no-later-dispatch checks. A missing-readiness control fails on
the actual completed worker result. The earlier missing PID does not establish
that the child started or that host load caused the failure.

The active-sibling fixture releases B's driver at A's actual candidate worktree-add
inside acceptance FIFO, allowing B to queue acceptance while its owned bytes remain
active. This avoids spending B's five-second driver budget waiting for A's entire
validation. It still requires A's refusal/no borrowed commit and B's exact owned
commit. Cleanup releases and awaits the sibling on failure.

The first after checkpoint was 180/185: four assertions incorrectly assumed Git
uses a/b diff prefixes (this checkout emits c/i), and the fake forge omitted REST
root comments, so authenticated reply chains were correctly unattached. The fixture
now includes real roots and stable timestamps, and accepts the actual raw diff
prefix without weakening exact leaf-byte assertions or policy rules.

```text
test:narrow result="fail" exit=1 files=6 projects="pure,process" tests="180/185" failed=5 skipped=0 wait="0.0s" duration="176.7s" nice=5 load="5.9" uptime="550009s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/registry.test.ts"
```

Final focused worker/real-PR checkpoint after the fixture corrections:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="107/107" failed=0 skipped=0 wait="0.0s" duration="207.9s" nice=5 load="2.8" uptime="550336s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/addressWorker.test.ts"
```

All 84 worker and 21 real-PR cases pass, including unchanged rejection, refreshed
follow-up, persisted proof controls, external HEAD movement, cancellation, actual
child termination, sibling ownership, and literal paths. The registry/CLI/PR-double
consumers passed in the earlier 180/185 checkpoint; its failures were confined to
the corrected worker and real-PR assertions.

Combined downstream lifecycle/actual-driver partition/proof checkpoint:

```text
test:narrow result="pass" exit=0 files=7 projects="pure,process,integration" tests="232/232" failed=0 skipped=0 wait="53.9s" duration="121.3s" nice=5 load="17.5" uptime="550548s" source="explicit" ran="test/driver/process-inventory.test.ts,test/e2e/review/review-address.e2e.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address.test.ts,test/ops/review/agentReviewer-partitions.test.ts,test/ops/review/run.test.ts,test/plans/review-loop.test.ts"
```

Commands were explicit named `pnpm test:narrow` batches; the second explicitly
included integration. Static reports zero errors against baseline zero; Knip,
formatting and generated-op-doc verification pass (54 current). Complete paginated
feedback sweep: 26 threads, three applicable unresolved threads (#460–462), all
outer and nested cursors exhausted, plus 54 inline comments, 40 reviews and nine
issue comments. No new applicable feedback appeared in that sweep.

The additive runtime worker callback is the only shared API change; frozen kernel
and schemas are unchanged. No provider, live, CR, coverage, budget, baseline or
policy change. Independent exact-delta review and fresh CI are still required.
The complete current-PR aggregate 60000-token blocker and positive live acceptance
remain unmet; focused source tests do not certify whole-PR acceptance.

## Reused PR worktree bookkeeping (#463)

The real no-ignore PR adapter now exercises a first publish, persisted ledger and
findings, then a fresh default invocation on the same checkout with a new
reviewer thread and GOOD→BETTER fix. The corrected regression on unchanged
`fe814dd2ededf9df7552f47841eadbcdbd2f3788` refused the second job at worker
initialization: `review.address requires no unknown worker files`, zero second
fixes, plus dirty-worktree. No offending source path was inferred.

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="23/24" failed=1 skipped=0 wait="0.0s" duration="64.2s" nice=5 load="5.6" uptime="552015s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts"
```

The sole additive runtime API is optional `AddressWorkerDeps.prepareBookkeeping`.
The composition restores private Git-namespace receipts inside initialization's
mutation→checkout→bookkeeping lock order, before unknown-file inspection. Exact
canonical checkout, PR/target/actor identity, branch, HEAD, allowed paths, ordinary
file identity and SHA-256 must match; ledger/findings schemas and historical heads
must validate. All entries validate before registration. Current clean/rejection
proof remains separate. PR history is never adopted by filename/schema alone.
Legacy worktrees without receipts fail closed, retaining metadata for manual
recovery. No public report, frozen schema, kernel or CLI contract changed.

Receipt refresh occurs only after successful bookkeeping FIFO transactions finish
all engine writes and fingerprint updates. The receipt's previous bytes are
checked before processing and immediately before atomic replacement. Create-only
temporary ownership, close and cleanup settle independently of cancellation.
Initial admission refusal returns after the settled loop before ledger loading or
re-review; ordinary worker-edit failures retain their normal re-review behavior.
Verified sibling commits and report evidence remain retained.

The new controls cover valid reuse and canonical aliases; valid-JSON whitespace
changes to ledger/history; caller files and unregistered valid history; malformed
metadata; missing, corrupt or partial receipts; wrong root/branch/PR-actor identity;
and stale HEAD. Refusals assert no further driver/forge call, zero new fixes and
unchanged protected bytes. Private receipt tests also cover invalid schemas,
non-ancestral heads, symlinks, duplicate/escaping paths, exact trailing bytes,
SHA-256 repositories, and caller receipt changes during replacement with no owned
temporary residue. A held initialization callback proves cancellation after its
await prevents admission/provider dispatch without changing HEAD/index.

The corrected positive initially passed 24/24. Expanded lifecycle/receipt/registry
controls passed 85/85 before the final atomic-replacement rendezvous was added:

```text
test:narrow result="pass" exit=0 files=4 projects="pure,process" tests="85/85" failed=0 skipped=0 wait="0.0s" duration="178.5s" nice=5 load="5.0" uptime="552569s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/addressBookkeeping.test.ts"
```

Worker/shared-consumer checkpoint, including preparation cancellation and existing
literal-path, owned-capture, closure provenance, concurrent admission, child
termination and rejection controls:

```text
test:narrow result="pass" exit=0 files=6 projects="pure,process" tests="190/190" failed=0 skipped=0 wait="0.0s" duration="109.1s" nice=5 load="5.3" uptime="552759s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/review/address-local.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/ops/review/addressWorker.test.ts,test/ops/review/registry.test.ts"
```

Retained intermediate evidence matters: the first reuse fixture accidentally
inherited the prior thread's resolved flag, so its original 23/24 failure proved
only no-job dirty publication, not job initialization. Corrected IDs/root comments
and resolution state produced the causal worker failure quoted above. The first
receipt prototype was 13/24 because it tried to persist inside a findings callback
before the same transaction refreshed the ledger fingerprint. Expanded controls
then ran 71/85: all 14 reuse variants stopped at one fixture assertion that guessed
the raw branch filename; it now uses the actual `devLedgerPath`. None of those
checkpoints establishes the later negative controls. Typed static checking also
required explicit fixture JSON types; no runtime assertions or policy weakened.

An op-doc check launched during stale-dist rebuilding failed to import the built
registry. Its verification must run after the wrapper's build settles. No host-load
cause is asserted for any functional failure. Durable logs are under
`~/….log` on triton.

Independent exact-delta review and exact-head CI remain separate gates. The
complete current-PR aggregate 60000-token feasibility blocker and positive live
acceptance remain unmet. No provider/live/CR run, budget/baseline/policy change,
whole-PR marker or merge is authorized by these source checks.

The final four-file checkpoint passed all 35 real-PR and 25 private-receipt cases,
including the atomic replacement rendezvous, but was **85/86**: the unchanged
`test/cli/registry.test.ts:586` root-barrel dynamic import exceeded its 5000 ms
limit (5083 ms observed). All other 23 registry cases and inventory passed.
The preceding 85/85 checkpoint had passed this same root-barrel assertion; the
only later production change was a function-body receipt recheck, with no import
graph/top-level evaluation change. This does not establish the timeout's cause.

```text
test:narrow result="fail" exit=1 files=4 projects="pure,process" tests="85/86" failed=1 skipped=0 wait="0.0s" duration="118.7s" nice=5 load="1.8" uptime="552893s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts,test/ops/review/address-pr-git.test.ts,test/ops/review/addressBookkeeping.test.ts"
```

One bounded diagnostic of the failing named file, with unchanged source, fixture
and timeout, passed all 24 registry cases plus inventory. Its pass does not erase
the failed batch or prove a host-load cause. No broader retry was run.

```text
test:narrow result="pass" exit=0 files=2 projects="pure" tests="26/26" failed=0 skipped=0 wait="0.0s" duration="8.4s" nice=5 load="1.0" uptime="553099s" source="explicit" ran="test/cli/registry.test.ts,test/driver/process-inventory.test.ts"
```

Final static checking passes with zero errors against baseline zero; typed lint,
Knip, formatting and generated operation docs (54) pass. The red batch remains an
explicit local verification limitation for independent delta review and CI.

## Round report format (#510)

`review-address-report.json` and the SDK report expose one `rounds[]` entry
per round that has a settled batch or completed re-review. Each entry is
`{ round, record, runs }`: `record` is the latest findings record for that
round (replaced by a successful re-review), and `runs` contains every settled
batch `RunReport` in dispatch order, including PR-thread and local-agent
batches. A round without dispatched work has `runs: []`. A stop before
re-review retains the dispatched record and all settled batch runs. PR runs
are retained immediately when the governed run settles, before post-fix Git
verification, publication or snapshots can throw. A refused sibling cannot
erase earlier admitted work; an initial refusal before any admitted work
still records zero rounds. The settled-run callback aggregates each run once.
`rounds.length` therefore counts recorded rounds, rather than dispatch batches.

This intentionally changes the persisted greenfield report format:
consumers of the former optional `rounds[].run` must iterate `rounds[].runs`.
`dev.cycle` renders its attempt log from the run-wide `attempts` array and
does not consume per-round runs.
