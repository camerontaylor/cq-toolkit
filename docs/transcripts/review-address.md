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
