# Developer-loop dogfood log

These are authorized production exercises, separate from hermetic tests.
`dev.cycle` is sequenced after S6 and was unavailable for this exercise.

## S6 attempt A — PR #435

Run on triton at implementation head
`05a7740e4585ccf06ef9941377c8407016769714`, using the configured `cq.json`
worker/rescue/reviewer roles, real forge/git adapters and production scanners.
Provider credentials were loaded locally; no credential values are recorded.
Machine-specific paths below are redacted; the exact command and artifacts
remain in the local run capture.
The genuine open findings included the independently identified candidate
mutex contention defect and dispatch wiring feedback. No defect was seeded.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:435 --maxTokens=60000 --wallMs=1200000 --rounds=1 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-a --push
```

Observed CLI exit: **3**, `needs-human`. `fixesPerRun`: **0**. Reported usage:
input 0, output 0, cache read 0, cache write 0; USD cost absent. There were no
provider attempts or verified commits. All attempted PR findings stopped at
`findings admission head/branch changed`, before worker dispatch. The final
agent re-review also returned incomplete: its 204445-character full-PR
prompt exceeded the existing 20000-character harness limit, so the driver
refused without upload or truncation. This separate limitation is tracked in
[#438](https://github.com/camerontaylor/cq-toolkit/issues/438). This is a blocked zero-fix run,
not positive acceptance evidence.

Full retained artifact:
`<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-a/review-address-report.json`.
The stdout artifact and local stderr/exit capture are retained under
`/tmp/s6-dogfood-a.*` on triton. The real adapter creates both
`refs/cq-review/pr-435` and `refs/heads/cq-review/pr-435`; Git's `--short`
renders the latter as `heads/cq-review/pr-435`. Comparing that display name
with the adapter's branch label caused the refusal. A real-git, real PR
worktree adapter regression covers admission and fresh re-review identity.

The metric counts distinct verified commit SHAs, not model claims or review
rows. The existing #419 failure-count accounting follow-up remains scoped
separately; this zero result is unambiguous under either interpretation.

## S6 attempt B — PR #435

Same explicit token/wall/round bounds, roles, production scanners and PR source
as attempt A, at implementation head
`13c9a27eb2d20d1cee32eaee02c65e9c1de51e37`. No prompt truncation, policy bypass,
or budget expansion was used.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:435 --maxTokens=60000 --wallMs=1200000 --rounds=1 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-b --push
```

Observed CLI exit: **3**, `needs-human`. `fixesPerRun`: **0**, verified commits:
**0**. Reported usage: input **18861**, output **8110**, cache read **448**,
cache write **0**. The report recorded **USD 0.00689759**, with wall time
**111698 ms** across four provider edit invocations. The remote
feature head remained `13c9a27eb2d20d1cee32eaee02c65e9c1de51e37`.

The model's first mutex response requested further inspection instead of an
edit. The duplicate mutex response declined a concurrency-control change:
it described a proposed shared-mutex file outside the assigned one-file scope
and could not run commands under the worker policy. Those are model refusals,
not proof that the engine rejected a candidate for those reasons. The registry
feedback correctly found that the earlier claimed fix had made no edit and
left the finding open. No verified mutation or passing commit resulted.
Separately, the engine's disposition step failed with `unknown finding` because
it still read an ambiguous short branch name; the regression now requires a
durable disposition on the canonical admission ledger. Final full-PR re-review
remained incomplete, including the existing prompt-size limitation in #438.

Full retained artifact:
`<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-b/review-address-report.json`;
stdout/stderr/exit captures: `/tmp/s6-dogfood-b.*` on triton. Both attempts are
zero-fix runs. Positive measured acceptance remains unmet; no third live attempt
has been authorized. Hermetic fixtures do not substitute for that acceptance.

## Direct repair after attempt B

The candidate mutex contention defect is repaired directly by the implementation
owner, tracked in [#439](https://github.com/camerontaylor/cq-toolkit/issues/439).
Initialization, candidate gates and restoration join one in-process FIFO before
acquiring the existing cross-process git mutex. A healthy sibling's long gate
therefore consumes no cross-process acquisition retries. Admission checks
parent cancellation and remaining unit/run budgets; cleanup still serializes
and retains owned failure evidence. Deterministic regressions explicitly hold
the first validation, exercise a simulated exhausted retry seam without minute
sleeps, and verify queued cancellation/budget cleanup and exact commit scope.
This direct repair is not a positive dogfood fix and does not change either
recorded zero-fix result.

## Owner budget change (2026-10-25)

The owner retired the 60000-token, 20-minute, one-round limits used by attempts A
and B: budgets are runaway guards, not bounds on good-faith work. `cq.json` now
carries `budgets.run.maxTokens=5000000` (raised to 25000000 after attempt D, below) and `budgets.run.wallMs=14400000`; unit
(1 h) and step (20 min) wall budgets are unchanged and rounds stay at the default 3.
The ai-sdk tool loop's step cap rises from 8 to 40 for the same reason.

## S6 attempt C — PR #466

Run on triton from dist at `47d8e987a8613b11c7d19ed1ae2bbe0edabf8b67` against
PR #466, whose nine unresolved Codex/CodeRabbit threads are genuine and unseeded.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:466 --maxTokens=5000000 --wallMs=14400000 --rounds=3 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr466-20261025-c --push
```

Observed CLI exit: **3**, `needs-human`. `fixesPerRun`: **0**. Reported usage:
input **856108**, output **130255**, cache read **1344512**; wall **1137863 ms**;
21 attempts across 12 findings. The PR head was unchanged. The final re-review
refused upload on a positive denylist scan (fail-closed, as designed).

Driver-level probes of the same worker request isolated two transport defects:

- The OpenCode Go gateway answers HTTP 400 (body `{"model":"deepseek-v4.1-flash"}`)
  to any `response_format: json_schema` request, with or without tools; `json_object`
  and plain requests succeed. Every rescue edit therefore ended `worker stopped: error`.
- The Z.ai provider drops the schema with a warning, so GLM answered without tool
  calls and its JSON did not match `review.address.outcome/v1`.

Repair: providers `opencode-go` and `zai` (and the `ai-sdk` alias) now receive the
schema as a trailing user turn; the reply text is parsed and judged by the same
shared validator, including the one bounded repair. Other providers keep the native
structured transport. The worker edit prompt now states that a fix must be applied
with the edit tool. After the repair, the identical probe completed with a real
one-file edit on both roles (DeepSeek 55 s, GLM 171 s). This is not a dogfood fix.

## S6 attempt D — PR #466

Same PR, budgets and roles as attempt C, from dist at the repair head
`d6b8e5b9ef8f143dfa848682ac1fa90398d07450`.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:466 --maxTokens=5000000 --wallMs=14400000 --rounds=3 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr466-20261025-d --push
```

Observed CLI exit: **3**, `needs-human` (token budget exhausted). `fixesPerRun`:
**1**. Verified commit `8f78ca91e82cfe170ccc3be35a04830f8d2cb26b` closes the genuine
Codex finding `PRRT_kwDOUY73E86v3_v3` in `src/driver/factory.ts`: unspecified request
retention now falls back to the configured `sessionLogs.retention`. The engine
committed it after its related and broader checks (this repository configures tsc
only). The inner review loop withheld publication because a sibling row failed. After
the budget stop, `review.address`'s exit publication (`publishOnExit`, exact verified
range) pushed it to PR #466: remote head `8f78ca91`, 12 s after the loop finished. The
thread reply and resolve stayed withheld, and the report's finding row still reads
open; that inconsistency is tracked in #469.

Reported usage: input **686278**, output **159796**, cache read **4179705**; wall
**2367799 ms**; 16 attempts. Cache reads count toward the run token budget and
were most of the 5000000 total, so seven later fix jobs stopped at the budget. The
run budget is therefore raised to **25000000** tokens; it remains a runaway guard.
Two findings were deferred as multi-file work, two were cancelled with the run, and
the open human-decision thread stays open.

This is positive measured live acceptance: fixesPerRun over the S6 dogfood runs
is 1 (A 0, B 0, C 0, D 1).

## S7 dogfood — dev.cycle on fix/s7-dogfood-address-469

First live `dev.cycle` run (the composition's own first run against a real
diff; #470's evidence was fixture-only). Code work landed first as commit
`24aba328e32d0a35eba40bba813e6c27ddb30c33` on `fix/s7-dogfood-address-469`
(from `origin/merge-queue` @ `7cac1ec2`): #469 report truth (loop-side row +
engine-settled `exit-published` / exit-failed / publication-off row states),
verdict P2 #1 (a scripted push fault through the real engine's `finish()`,
pinning the `verified publication failed` rewrite and the `report.stop`
clearing) and P2 #2 (test:narrow's gated-file refusal names the re-run).
Evidence: `test:narrow result="pass" exit=0 files=5 projects="pure,process"
tests="227/227" failed=0 skipped=0 wait="0.0s" duration="21.3s" nice=5
load="3.8" uptime="646004s" source="explicit"
ran="test/driver/process-inventory.test.ts,test/ops/review/address-pr.test.ts,test/ops/review/address.test.ts,test/plans/review-loop.test.ts,test/scripts/test-narrow.test.ts"`,
plus `address-pr-git`/`address-local`/`addressBlockedRereview`/`addressPinBase`/
`addressReceiptRotate`/`addressRerequestPersist`/`addressStaleClean`/`cycle`
narrow runs green (312/312 across the day), `pnpm lint` exit 0, `pnpm
format:check` clean.

```sh
node dist/cli.js dev.cycle --repoRoot=$PWD --push --target=merge-queue \
  --title="fix(review.address): report exact publication state (#469) + verdict P2s"
```

Observed CLI exit: **1**, `failed` after 61 s wall — the FIRST leg
(`dev.check`) went red, so no review/address/open legs ran and no PR was
opened. The deterministic statics passed; the `test:narrow` gate was
REFUSED, not failed:

> test:narrow result="refused" exit=2 … source="base:7cac1ec2…" ran=-
> reason="gated test files cover the change: test/e2e/review/live.test.ts
> (integration), test/e2e/sweep/sweep.e2e.test.ts (integration); pass
> --include-integration to run them (an opt-in gate, not a refusal — re-run
> with --include-integration)"

Root cause (structural, a dev.cycle defect candidate): dev.check invokes the
wrapper as `pnpm test:narrow --base <sha>` with NO include flags (pinned at
test/ops/dev/check.test.ts:269), and the `--base` selector's closure maps
src/plans/review-loop.ts + src/ops/review/address.ts to the e2e files above.
Two independent blocks follow: (a) the refusal — the exact gate this slice's
P2 #2 clarified — cannot be satisfied from inside dev.check; and (b) even
WITH `--include-integration` the run could never execute hermetically:
`test/e2e/review/live.test.ts` is `describe.skipIf(!process.env.LIVE_GH)`
opt-in, and a skipped file fails runVerdict's "no tests executed" rule. So
no change touching the review-loop/address family can pass dev.cycle as
shipped. The red record (`k001-24aba328`) persists in the branch dev-record;
artifacts under `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261025/`.
Per the lane protocol the failure itself is the finding: no `gh pr create`
fallback, no gate-policy improvisation; the branch keeps commit `24aba328`
for review through the normal path.

## S7 dogfood attempt B — dev.cycle with --includeIntegration=true

The chancellor's fix for attempt A landed as `4f8e494c` (dev.check gains an
optional `includeIntegration` input appending `--include-integration` to the
gate's `--base`/`--range` argv, recorded as `includeIntegration: true` in the
check record; dev.cycle forwards it to both check legs; RED-first tests,
statics, knip and regenerated op docs). Evidence: `test:narrow result="pass"
exit=0 files=7 projects="pure,process" tests="180/180" failed=0` (check,
cycle, both registries, review, pr-open), `pnpm lint` 0 errors,
`format:check` clean, `knip` clean.

```sh
node dist/cli.js dev.cycle --repoRoot=$PWD --push --target=merge-queue \
  --includeIntegration=true \
  --title="fix(review.address): report exact publication state (#469) + verdict P2s; dev.cycle includeIntegration"
```

Observed CLI exit: **1**, `failed` after 45 s — again the first leg
(`dev.check`), no review/address/open legs, no PR. The opt-in WORKED (record
`k002-4f8e494c` carries `includeIntegration: true`; the integration gate
refusal is gone), but the gate then refused on the FILE CAP:

> test:narrow result="refused" exit=2 files=78 …
> reason="78 test files selected, the cap is 10; name the files that cover
> your change explicitly"

Root cause (second structural defect, a dev.cycle defect candidate):
dev.check selects with `--base`, and the full closure for any
dev/registry-touching branch is far over the wrapper's owner-set 10-file
cap. Reproduced and decomposed on triton: the vitest import-graph query
returns **51** related test files for the branch's 8 src/scripts changes
(`src/ops/dev/registry.ts` reaches the central registry barrel, so CLI
conformance, smoke, driver, plans and e2e suites all import it), and the
reviewed NON_IMPORT_MAP adds **27** more from four fan-out rows
(`docs/ops/*` → test/scripts/_; `scripts/lib/test-narrow.mjs` →
test/scripts/_ + test/workflows/* + policyDiff; `src/ops/**` →
cli/registry+conformance+served-model-sites; any `src/**/*.ts` →
protectedPaths). 51 ∪ 27 = 78. Named-file selection (the wrapper's designed
escape) is unavailable inside dev.check's automated `--base` call.

The focused-checks contract reserves exactly this refusal as an ESCALATION
TRIGGER (docs/focused-checks-contract.md §2 step 4: "the selection exceeds
its file cap. That refusal is the escalation trigger … Do not launch another
owner's gate"), so no local widening was improvised. The branch keeps both
commits (`24aba328`, `4f8e494c`) plus this entry at `HEAD`; artifacts under
`~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261025-b/`; both red
records (`k001-24aba328`, `k002-4f8e494c`) persist in the branch dev-record.
Per the lane protocol: no `gh pr create` fallback; the failure is reported
for an owner/coordinator decision on the cap-vs-closure policy.

## S7 dogfood attempt C — dev.cycle with testFiles (named selection)

Attempt B exposed the second blocker: the `--base` closure for any
dev/registry-touching branch exceeds the owner's 10-file cap (decomposition:
the vitest import-graph query returns **51** related test files for this
branch's 8 src/scripts changes — `src/ops/dev/registry.ts` reaches the
central registry barrel, dragging CLI conformance, smoke, driver, plans and
e2e suites in — and the reviewed NON_IMPORT_MAP adds **27** more from four
fan-out rows: `docs/ops/*` → test/scripts/*; `scripts/lib/test-narrow.mjs` →
test/scripts/* + test/workflows/* + policyDiff; `src/ops/**` →
cli/registry + conformance + served-model-sites; any `src/**/*.ts` →
protectedPaths. 51 ∪ 27 = 78). Per the chancellor's ruling the cap stays;
the policy's own escape ("name a narrower set of files") is now exposed
through the ops as `0b72de61`: dev.check gains `testFiles: string[]`
(replaces the `--base`/`--range` selection, flags-first argv, dash-leading
segments refused before any gate), the record discloses the narrowing as
`testSelection: { mode: 'named', files }` vs `{ mode: 'base' | 'range' }`,
and dev.cycle forwards it to every check leg. `ae669f3d` fixed the follow-on
ledger-evolution defect attempt C-1 exposed (a REQUIRED new schema field
made pre-existing records unloadable — all gates green, record unpersisted);
`testSelection` is optional on read, always written. Evidence:
`test:narrow result="pass" exit=0 files=9 projects="pure,process"
tests="231/231" failed=0`, lint 0, format clean, knip clean.

Named files for this branch (10, at the cap): test/plans/review-loop.test.ts,
test/ops/review/address-pr.test.ts, test/ops/review/address.test.ts,
test/e2e/review/review-address.e2e.test.ts, test/ops/dev/check.test.ts,
test/ops/dev/cycle.test.ts, test/ops/dev/registry.test.ts,
test/cli/registry.test.ts, test/scripts/test-narrow.test.ts,
test/driver/process-inventory.test.ts.

```sh
node dist/cli.js dev.cycle --repoRoot=$PWD --push --target=merge-queue \
  --includeIntegration=true --testFiles='[...the 10 files above...]' \
  --title="fix(review.address): report exact publication state (#469) + verdict P2s; dev.cycle includeIntegration"
```

Observed CLI exit: **3**, `needs-human` after 275 s — PAST dev.check this
time: the named-selection gate ran GREEN and persisted
(`k003-6e3baf9f`, `testSelection.mode: 'named'`, all 10 files recorded,
`includeIntegration: true`), then failed at leg 2 (`review.run`):

> dev.cycle (review.run): review.run: not every configured reviewer
> completed a terminal cycle; the findings record, including partial
> findings, was persisted

The ledger shows CodeRabbit TERMINAL (3 findings, coverage receipt logged)
and the agent reviewer BLOCKED: `agent review did not complete (error)`,
usage 0, first partition failed after 2 serialized requests — the OpenCode
Go wire (`roles.reviewer`: `opencode-go`/`deepseek-v4.1-flash`) erroring at
dispatch, consistent with the 5-hour quota 429 the lane was pre-warned
about. Per protocol cq.json was NOT touched. Failure time: 2026-10-25
~23:17:20 +1100. No push, no PR (remote head still `35de807d`; the branch
carries `24aba328`, `4f8e494c`, `0b72de61`, `ae669f3d`, `6e3baf9f` + this
entry). Artifacts: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261025-c/`,
agent log `~/.jcode/scratch/cq-dev-review/fix_s7-dogfood-address-469-…-agent-…log`.
Defect candidate from C-1 (fixed in-branch): required-field ledger evolution.
Remaining: rerun when the Go key's quota window resets.
