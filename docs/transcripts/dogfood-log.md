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

## S7 dogfood attempt A — dev.cycle on fix/s7-dogfood-address-469

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
exit=0 files=7 projects="pure,process" tests="180/180" failed=0` (the seven
files are `dev.check`, `dev.cycle`, both registry suites, `review-loop`,
`review.address` and `pr-open`), `pnpm lint` 0 errors,
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
(`docs/ops/*` → `test/scripts/*`; `scripts/lib/test-narrow.mjs` →
`test/scripts/*` + `test/workflows/*` + policyDiff; `src/ops/**` →
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
fan-out rows: `docs/ops/*` → `test/scripts/*`; `scripts/lib/test-narrow.mjs`
→ `test/scripts/*` + `test/workflows/*` + policyDiff; `src/ops/**` →
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
`test:narrow result="pass" exit=0 files=10 projects="pure,process,integration"
tests="231/231" failed=0` — the named selection IS the gate input, so the
row's own numbers follow from the ten files above and reconcile with the
record: all ten are selected (`planRun` puts a gated file in the run because
`includeIntegration` covers its class, so the e2e file is not filtered out),
`files` counts that run, `projects` names every project it uses
(`integration` for test/e2e/review/review-address.e2e.test.ts), and a pass
means every selected file executed at least one test — `runVerdict` fails a
selected file that runs none, so nine files, an unrun file or an all-skipped
file can never carry a green row. lint 0, format clean, knip clean.

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

## S7 dogfood attempts D–J: dev.cycle on fix/s7-dogfood-address-469 (paused)

Attempt D ran attached and was killed by the lane shell-tool timeout; every run from its rerun
onward (D take 3–J) was detached on triton, from `dist` at the named head, with the same flags as
attempt C (`--push --target=merge-queue --includeIntegration=true` plus 10 named
`--testFiles`). Run state lives under `~/.local/state/cq-toolkit/dogfood/s7-devcycle-2026102{5,6}-{d..j}/`.
Every run exited **3** at `review.run` or `review.address`, and **none opened a PR**.
Every run except D surfaced a defect, and each of those was fixed in-branch — except J's,
which is left unfixed while the lane is paused:

| Attempt  | Head       | Stopped at                                    | Cause                                                                                                                                                                                     | Fix                                                                                               |
| -------- | ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D        | `e1b63507` | process killed silently after the secret scan | lane shell-tool timeout (runs are now detached)                                                                                                                                           | —                                                                                                 |
| D take 3 | `e1b63507` | review.run                                    | CodeRabbit no-fresh notice on an already-reviewed head (#485); DeepSeek reviewer emits DSML tool-call markup (#483)                                                                       | `0b6c3276` reviewer → `zai`/`glm-5.3-flash` (owner)                                               |
| E        | `0b6c3276` | review.run, partition 4                       | ai-sdk per-request step timeout hard-coded at 120 s                                                                                                                                       | `01127c00` step bound from `budgets.step.wallMs`                                                  |
| F        | `01127c00` | review.run, partition 20/28                   | undici default headersTimeout of 300 s on the non-streaming repair call; error detail dropped (#484)                                                                                      | `15d9b8df` (#484), `56b7bdd4` (undici timeouts follow the step bound)                             |
| G        | `56b7bdd4` | review.run, partition 11/32                   | `output-invalid`: GLM added an unknown key `rule_id_hint` to a finding                                                                                                                    | `35daf528` strip and count unknown finding keys                                                   |
| H        | `35daf528` | review.address, budget                        | review.run TERMINAL on both reviewers (agent: 64 findings). Address made **8 verified fix commits** but nothing was published, and the legs didn't share the run wall (5 h 48 m)          | `fa9b1948` budget stop publishes a draft; one run budget across legs. #490 (rows stay `open`)     |
| I        | `fa9b1948` | review.run, partition 9/34                    | one GLM request ran the full 20-min step bound                                                                                                                                            | `fc59ec3d` step bound 1 h (owner), `0ff7c961` one retry per partition on transient/output-invalid |
| J        | `0ff7c961` | review.run                                    | GLM degenerate loop: 458 676 chars of hallucinated `BASH:` calls and echoed schema, until the model's output limit. `finishReason: 'length'` maps to `budget-exhausted` (`index.ts:1781`) | — (paused)                                                                                        |

**Measured:** attempt H `fixesPerRun` = **8** (`c013-35daf528#f3`, `#f4`, `#f5`, `#f15`,
`#f34`–`#f37`; ~6.9M tokens, ~4 h address wall). This is the first live review-side run with
multiple verified fixes. The chancellor pushed them as `00fb37ba` after the run.

**Paused (owner, 2026-10-26):** the agent reviewer's remaining failures share #483's root
cause, a tool-less turn told to "use the tools", and #483's redesign replaces that reviewer.
The S7 acceptance run (dev.cycle opens a PR with a readiness record) is rerun on top of #483.

## S7 dogfood attempt K: dev.cycle on the #483 session reviewer (fix/s7-dogfood-address-469-v2)

The branch was rebuilt from `origin/main` `e4732cc3`, which carries #483 A–D. Ported onto it:
#469 + P2s, includeIntegration/testFiles, the D1/D2 budget-stop publication and shared run
budget, cq.json (reviewer `zai`/`glm-5.3-flash`, `budgets.step.wallMs` 3 600 000), and three
minimal deltas main still lacked: the `budgets.step.wallMs` → `stepTimeoutMs` wiring, the undici
step-fetch transport, and the finding-item key strip. Main's own versions replaced the #484
detail and the partition retry. Same invocation as attempts E–J, detached on triton from `dist`
at `0663e37a`. Run state: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261027-k/`.

Started 2026-10-26T22:55:53Z (06:55 SGT); exited **3** at 2026-10-27T02:24:45Z (3 h 29 m).

- **dev.check:** green.
- **review.run:** TERMINAL on both reviewers, the first clean pass on the session reviewer.
  CodeRabbit had 1 finding. The agent reviewer had **37 findings**, coverage v2 `partitioned`
  (1 637 changed lines / 33 files exceed the medium tier, advisory recorded), **35/35 sessions
  complete, 33/33 pieces completed**, no limitations, 361 324 tokens. None of attempts E–J's
  review.run failure modes recurred: no step timeout, no undici cut, no extra-key rejection.
  Attempt H's publish-loss failure mode is the one recurrence — as in H, the verified fixes
  went unpublished (see the address bullets below and #509).
- **review.address:** **7 verified fix commits** (`8fd86528`, `0699aca3`, `0e8dd36e`,
  `0b9fad2c`, `398c2a97`, `5c09971c`, `afdb134a`; `fixesPerRun` 7) in 1 h 57 m, using 6 513 080
  tokens (modeled cost $0.41). It stopped on its re-review: both reviewers lost the network in
  a **host DNS outage on triton**. The agent got `getaddrinfo EAI_AGAIN api.z.ai` after 2
  attempts; CodeRabbit got `con_err: webSocket connection failed` at 02:24:15Z. The
  re-review sessions `ses-mvq2be0e-9b6e90d7` and `ses-mvq2bjbf-20da26da` hold only the
  prompt. **The exit was caused by the environment, not by the product.**
- **No push, no PR:** a blocked re-review isn't a `round-cap`/`budget` stop, so dev.cycle
  propagated it verbatim and the 7 commits stayed local. Filed **#509**: verified fixes stay
  unpublished when the re-review blocks (needs a decision against the earlier P1 control).
  Also filed **#510**: `rounds[]` gets one entry per batch, each repeating the full record (20
  entries here). #490 reproduced without a budget stop (all 38 rows `open`) and was commented.

S7 acceptance (dev.cycle opens a PR with a readiness record) is still not met. Rerun once the
host network is stable; #509 decides whether the next blocked re-review still loses the fixes.

## S7 dogfood attempt L: dev.cycle on merge-queue + D1/D2 (fix/s7-dogfood-address-469-v3)

The branch was built fresh from `origin/merge-queue` `3f1e61da`, which carries #504, #511 (step bound wiring, undici transport, finding-key strip), #513 (re-review retry + `rereview-blocked` draft), #515 (oxfmt-check gate) and #516 (`rounds[]` per round). On top of that: #469 + P2s, includeIntegration/testFiles, D1/D2 (with `stop` = round-cap | budget | rereview-blocked), the A–K log, and cq.json (reviewer `zai`/`glm-5.3-flash`, `budgets.step.wallMs` 3 600 000). Same invocation as E–K, detached on triton from `dist` at `07397c69`. Run state: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261027-l/`.

Started 2026-10-27T10:03:00Z (18:03 SGT, after the GLM blackout); exited **3** at 13:53:01Z (3 h 50 m). The start was 2 min late because the launcher's "wait for a running CodeRabbit review" guard matched its own launching shell (run.sh text in its command line); that shell was stopped by exact PID.

- **dev.check:** green.
- **review.run:** TERMINAL on both reviewers. CodeRabbit had 1 finding. The agent had **26 findings**, coverage v2 `partitioned` (1 329 changed lines / 20 files), **28/28 sessions complete, 20/20 pieces completed**, 290 004 tokens. No step-timeout, transport or schema failure.
- **review.address:** **25 verified fix commits** (`fixesPerRun` 25; the address checks now include the oxfmt-check gate), one round, 14 batch runs, 88 attempts (4 failed), 12 077 247 ms, 9 966 983 tokens (modeled $0.78).
- **Stop:** the re-review's agent reviewer ran out of the address leg's wall budget (4 h − 10-min reserve ends at 13:53). The block reached `finish()` with no structured stop. D1's `budget` marker is set only when the leg's own `stop()` observes exhaustion, and on this path nothing called it. So dev.cycle propagated the block verbatim: **no push, no PR**, reserve unused. Filed **#532** (root cause and fix direction). CodeRabbit's re-review completed (2 findings).
- **#490** reproduced again (all 27 rows `open` despite 25 fixes).
- The 25 unreviewed fix commits are parked at `fix/s7-dogfood-address-469-v3-l-fixes` (`50ea6393`); v3 itself stays at the reviewed head.

S7 acceptance (dev.cycle opens a PR) is still not met. This is the first run where no reviewer or transport failure occurred and the address leg ran to its budget. Fixing #532 would have published a draft with 25 fixes.

## S7I source integration (2026-10-28)

Fresh queue base: `1eea0b5b323de8b23a9388a72da4e97f8e631450` (#534).
Source: v3 `2f2a1dcfd7efe185d6f07b5e010a44b4f3467c35`;
parked L: `50ea63939e4d54555e8329ffeeaee158e28bf26a`.
This is source integration, not a new live acceptance attempt.

Re-read on triton: L's start.txt names runtime head `07397c69` and
2026-10-27T10:03:00Z; exit.txt records EXIT=3 at 13:53:01Z.
stdout.log points to address report
`<worktrees>/.cq-address-runs/e106122c-7d6a-4fac-88b0-349873779cd0/review-address-report.json`.
That report has fixesPerRun=25, one round, no stop marker and 27 open rows.
No successful publication or O2 acceptance is claimed.

**Route reconciliation (DEC5):** retain queue's cq.json byte-for-byte,
including its production reviewer route and budgets. Do not port v3's experimental
GLM route or one-hour step override. Queue's #534 structured publication,
verified-head checks and newer CLI stream-refusal precedence are preserved.
The old v3 review/run.ts and agentReviewer.ts differences are omitted because
queue has newer fatal-stop/tool-failure handling. dev/review.ts receives the
missing DevCycleInput includeIntegration/testFiles fields plus the explicitly
authorized M wall-attribution/sampling region described below. Q4/Q5 owns
future dev.review behavior and context extraction.

**Parked L applicability inventory:** all 25 changes remain applicable to the
remaining v3 seam, including documentation and stronger fixture assertions.
They are ported selectively onto current queue source, without copying parked
branch history or changing its ref.

| L commit | Finding  | Applied behavior or evidence                                         |
| -------- | -------- | -------------------------------------------------------------------- |
| 69fee213 | c002 f1  | Correct attached versus detached D run history                       |
| 04ae16c8 | c001 f1  | Disclose test scope only when legacy test gate ran                   |
| c4d8a12d | c002 f4  | Reject empty named test selection before gates (also schema-guarded) |
| fadb67cf | c002 f2  | Correct D/J defect and fix history                                   |
| aa19afea | c002 f3  | Limit K non-recurrence claim to review.run                           |
| dbb5f214 | c002 f5  | Reject conflicting range and named selection                         |
| a51f663a | c002 f6  | Document propagation to every check path                             |
| 22de036f | c002 f10 | Reject option-shaped named files at shared input schemas             |
| 80e7d851 | c002 f7  | Skip agentic legs when remaining run budget is exhausted             |
| 1e7e2561 | c002 f8  | Explain shared default driver factory and metering                   |
| b0f303e4 | c002 f12 | Settle withheld rows when no engine publication ran                  |
| cb0b106a | c002 f13 | Preserve published witness after post-push failure                   |
| f4d5af5a | c002 f9  | Meter structurally valid partial usage on driver rejection           |
| 512d371f | c002 f14 | Avoid suggesting exit publication when push is disabled              |
| 257b1326 | c002 f15 | Assert named selections emit neither base nor range flags            |
| e31c10a3 | c002 f16 | Pin conflicting selection refusal and nonempty ledger                |
| 6fd3eb91 | c002 f19 | Assert absent integration opt-in stays undefined                     |
| f69c6b9e | c002 f17 | Cover bare and path-shaped dash-prefixed file rejection              |
| 5df38a19 | c002 f21 | Bound address wall remainder on both sides                           |
| d0949e5d | c002 f18 | Assert both base and range record modes                              |
| f8aaa5ef | c002 f22 | Assert cycle result before wall-budget comparisons                   |
| c9a4f6b5 | c002 f24 | Document persistent scripted push fault                              |
| 8040ba18 | c002 f23 | Pin the exact unmarked budget-like refusal reason                    |
| 7179405f | c002 f25 | Keep unrelated loop reasons from satisfying withhold assertions      |
| 50ea6393 | c002 f26 | Assert opt-in guidance against ordinary refusal text                 |

Already landed and not reimported: v3's shared cycle budget, reserve,
structured budget-stop publication and associated address tests are in #534.
The publication-truth changes here settle existing mixed-worktree reason rows;
they do not implement #490's final disposition/delivery redesign. No further live attempt or provider evaluation is authorized.

Integration fixture adaptations: L f17 now accepts the shared-schema diagnostic for bare options while requiring refusal before gates; L f22 uses a CodeRabbit-configured fixture to match its seeded readiness ledger. The initial named run failed on those two mismatches (324/326); production guards were retained.

### Existing M: bounded fixture reconciliation

M was discovered after it had run; S7I did not launch it. Its retained head is
`485c0734b02114b4a5ce55c4db657bea082d5b32`, on runtime/source
`2f2a1dcfd7efe185d6f07b5e010a44b4f3467c35`. The parked worktree and ref
are preserved. The existing address report
`<worktrees>/.cq-address-runs/9c002450-626f-4383-9c23-6e88fc3d63ea/review-address-report.json`
records 30 verified fixes and stop=budget; final gates were red and nothing
was published. Its lost temporary report cannot establish the original failed
assertion.

A named fixture reproduction on current queue source isolated M f21's faulty
first-row lookup: the second run appends a range record, but the first row
still says base. Reintroducing only that lookup produced
`expected { mode: 'base' } to deeply equal { mode: 'range' }`.
The existing L d0949e5d last-row fix was restored afterward. This is causal
fixture evidence, not recovery of the missing original test artifact.

Exact reproduction result:

```text
test:narrow result="fail" exit=1 files=2 projects="pure,process" tests="38/39" failed=1 skipped=0 wait="0.0s" duration="8.1s" nice=5 load="1.7" uptime="841310s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/dev/check.test.ts"
```

The scoped M review/run fixture delta passed against queue source (63/63).
Its added await on synchronous repo.git was removed to address M's recorded
await-thenable lint failure. No M review/run.ts or agentReviewer.ts source was
imported.

**M applicability inventory (all 30 retained fixes):**

| M commit | Disposition in S7I                                                                             |
| -------- | ---------------------------------------------------------------------------------------------- |
| a6ca4115 | Already covered by L04ae16c8 legacy-only scope disclosure                                      |
| a049ba7d | Apply explicit attempt A log heading                                                           |
| b8e6857c | Omit duplicate comment clarification; current legacy-only comment is accurate                  |
| 6903f833 | Apply guarded publication work-state re-read failure diagnostics                               |
| 1ec084b3 | Already covered by Lc4d8a12d empty selection guard                                             |
| de0b9031 | Already covered by Lf4d5af5a rejected-driver usage metering                                    |
| 531b1735 | Apply wall-only budget attribution under explicit narrow authorization; preserve streamRefusal |
| 11bedcc1 | Apply finite total guard; retain L's strict structural Usage validation                        |
| 5879e99e | Apply single completion-time wall sample for marker and completion                             |
| b1f939b9 | Apply late budget-stop reason recording without changing cancellation guards                   |
| 9701bdd3 | Omit expanded comment; queue verified-head guard retained                                      |
| fb392247 | Omit reviewer-engine delta outside owned source seam; queue implementation retained            |
| 2e7f372e | Omit reviewer-engine budget marker delta outside owned seam                                    |
| d0a5cf5e | Already covered by Lcb0b106a published-witness preservation                                    |
| ef6313ca | Defer reviewer-engine budget/transient classification outside owned seam                       |
| 567e8f68 | Already covered by Lb0f303e4 publication-truth settlement                                      |
| 46965dfa | Omit defective first-row assertion; retain Ld0949e5d last-row assertion                        |
| a9d63cce | Defer reviewer-engine admission attribution outside owned seam                                 |
| 787a7f7a | Already covered by L6fd3eb91 undefined integration opt-in assertion                            |
| e2a5a241 | Apply persistent push-fault helper rename; retain L's accurate persistent-fault comment        |
| 88ade437 | Apply incompatible fixture knob guard and identity-based T3 file                               |
| 576557ef | Apply production reason/structured-stop pairing and distinct draft headings                    |
| b48b3505 | Omit redundant assertion removal; current stronger assertions retained                         |
| b99208d8 | Apply two-check-leg proof for verified-head refusal matrix                                     |
| d966bb3b | Apply push-only transport counter and honest non-push response                                 |
| 255d41d2 | Apply real thrown-driver fixture instead of an injected reviewer throw                         |
| ab31ab70 | Apply unmasked structured-result assertions; remove erroneous synchronous await                |
| 488f5268 | Omit temporary-repo hard reset; existing per-case fixture cleanup retained                     |
| afa9651e | Apply exact propagated refusal reason, strengthening L8040ba18                                 |
| 485c0734 | Already covered by L7179405f accurate loop-only text/title assertions                          |

M f7/f8 do not remove DevCycleInput fields. The earlier removal claim was
corrected after directly comparing v3 and M. The coordinator subsequently
authorized only their exact budgetStopped/completion-sampling region beyond
the fields-only change. The port samples wall remaining once, requires actual
wall exhaustion for budgetStopped, and retains queue's streamRefusal guard and
streamRefusal ?? completion precedence. No transient/refusal handling changes.

Direct named fixtures cover terminal and killed CLI results for parent
cancellation with positive wall remaining, wall exhaustion alone, and both
simultaneously; existing explicit error/action/skipped/no-fresh expiry fixtures
remain. Parent cancellation with wall remaining stays blocked without a budget
marker. When both cancellation and wall expiry are observed, a qualifying
terminal/killed CLI receives the wall marker absent an explicit stream refusal;
this does not prove which event caused the stop. Parent cancellation still
has the address engine's independent publication exclusion. No stronger
causal cancellation guarantee is claimed.

Reviewer-engine omissions remain reported to the coordinator. No
planner/partition/session/driver source or production route configuration
is changed.

## S7 dogfood attempt M: dev.cycle with #532's verified budget publication (v3 @ 2f2a1dcf)

Same branch as L plus the #532 fix: structured budget attribution, `verifiedHead`, and dev.cycle publishing a budget/rereview-blocked DRAFT only for a clean tree at that head, with a pinned-SHA push. The launcher's CodeRabbit guard now uses `[c]oderabbit review`, so it can't match itself. Started 2026-10-27T14:24:55Z (22:25 SGT); exited **1** at 18:16:19Z (3 h 51 m). Run state: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261027-m/`.

- **dev.check:** green.
- **review.run:** TERMINAL on both reviewers. CodeRabbit had 3 findings. The agent had **41 findings**, coverage v2 `partitioned` (1 890 changed lines / 24 files), **35/35 sessions, 24/24 pieces**, 384 112 tokens.
- **review.address:** **30 verified fix commits** (one round, 19 batch runs, 106 attempts / 4 failed), 11 490 439 ms, 14 427 629 tokens (modeled $1.00). It stopped on the run budget with **`stop: 'budget'`** and `verifiedHead` = HEAD `485c0734`. The #532/D1 path engaged: final gates first.
- **Final dev.check RED** (`k002-485c0734`), so nothing was pushed and no PR opened (the gates-first rule held):
  - `check:static`: lint `await-thenable` at `test/ops/review/run.test.ts:1880`, from address fixes c002#f36/#f37;
  - `test:narrow` 376/377: `check.test.ts` "automatic forms record their selection mode honestly", after address fixes to `src/ops/dev/check.ts`.
    Root cause, filed **#535**: the address leg verifies against cq.json `checks` only, which for cq-toolkit are tsc + oxfmt-check (no lint, no tests). "Verified" fixes can therefore break gates the final dev.check runs, and the whole run is discarded together.
- Unrelated to this exit: PR #534 (D1/D2 + #532 to merge-queue) later fixed one more edge (a CodeRabbit refusal followed by a deadline kill). M's head predates it, and M's CodeRabbit runs completed normally, so it didn't apply.
- **#490** reproduced again (all 44 rows `open`).
- The 30 unreviewed fix commits are parked at `fix/s7-dogfood-address-469-v3-m-fixes` (`485c0734`).

S7 acceptance (a PR opens) is still not met. M is the first run where the whole pipeline reached publication: reviewers terminal, 30 fixes, a structured budget stop, and the verified head bound. Its own final gate rightly refused it. Next: #535 (make "verified" match the final gates).

## S7 dogfood attempts N and N2: rate-limited at the first review (v4)

Branch `fix/s7-dogfood-address-469-v4` @ `9d282776`: PR #540's head (lint + related-tests address checks) plus the dogfood-only ports, with cq.json reviewer `zai`/`glm-5.3-flash` and step 3 600 000. Same invocation as E–M.

- **N** (2026-10-27T19:12:01Z → 19:36:40Z, exit **3**): both reviewers were rate-limited in the first review.run. CodeRabbit gave `errorType: rate_limit`, `recoverable: true`, "used all 5 included reviews" (`isProUser: false`, a rolling window shared across every lane on the account), wait 10 min. The agent got `AI_APICallError: Rate limit reached for requests` from Z.ai, with 4 partition sessions errored and 39 findings from the rest (424 107 tokens). No address, no commits, no PR.
- **N2** (20:30:00Z → 20:43:30Z, exit **3**, after a cool-down): the agent was TERMINAL (17 findings, 217 094 tokens), but CodeRabbit was rate-limited again (wait 1 min 47 s). No address, no commits, no PR.
- Product gap: review.run gave up on a recoverable rate limit with a stated wait, with hours of budget left. Filed **#551** and fixed by **PR #576** (merged `8fc58c22`): one abortable CodeRabbit wait+retry within the wall, and one bounded backoff for the agent's `rate-limit` class. Follow-up #578.
- Giles R3/R3b/D1c: N3 runs once, only after #576 merged, holding the CodeRabbit lock exclusively for the whole run (handed over by the queue orchestrator after #266's dispatch). If it hits a rate limit or repeats an N/N2 failure, it stops and goes to Giles; no N4.
- Run state: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261028-n{,2}/` (triton).
- Note: merge-queue now carries the S7 source itself (#539 S7I integrate: #469, includeIntegration/testFiles, the parked L/M repairs), so N3 runs from `fix/s7-dogfood-address-469-v5` = merge-queue `8fc58c22` + cq.json (reviewer, step) + this log.

## S7 dogfood attempt N3: dev.cycle opens PR #620 (v5 @ de5cefb6)

Branch `fix/s7-dogfood-address-469-v5` @ `de5cefb6` = merge-queue `8fc58c22` (with #576's retry) + cq.json (reviewer `zai`/`glm-5.3-flash`, step 3 600 000) + the M/N/N2 log above. Same invocation as E–M. It ran under Giles R3c: exactly one run, with in-run CodeRabbit allowed as an explicit dogfood exception. That superseded R3b's lock handover: R4 gives crq sole ownership of CodeRabbit, so the lane took no lock and preempted nothing. Started 2026-10-27T23:41:04Z; exited **0** at 23:58:16Z (17 m 12 s). Run state: `~/.local/state/cq-toolkit/dogfood/s7-devcycle-20261028-n3/` (triton).

- **dev.check** `k001-de5cefb6`: green (knip skipped).
- **review.run** @ `de5cefb6`: both reviewers TERMINAL. CodeRabbit `c001` gave 1 major finding: cq.json:73-74 should leave the experimental reviewer route and restore step `wallMs` 1 200 000. Agent `c002` found nothing (4 steps, ~35 k tokens, 0 tool failures).
- **review.address:** one round, one fix by the `zai`/`glm-5.3-flash` worker: initial edit 54 s plus feedback 165 s (~219 s of worker time), then reviewer closure 37 s. Commit `86633e93` reverts cq.json to the merge-queue values; disposition `fixed`, `verifiedHead` = `86633e93`, nothing open or failed. 568 868 ms; input 49 750 / output 15 313 / cache-read 53 568 tokens (modeled $0.0115).
- **Final re-review** @ `86633e93`: CodeRabbit `c004` and agent `c005` both TERMINAL with 0 findings. Final dev.check `k002-86633e93` green.
- **Publication:** the feature branch was pushed and PR **#620** opened against merge-queue, **ready**, with the generated `cq:dev-readiness` record (base pin `8fc58c22`, head `86633e93`). Nothing was pushed to merge-queue itself.
- **S7 acceptance is met** for the exercised path: check → review.run → review.address → final gates → push → ready PR with a readiness record.
- Limits: neither reviewer hit a rate limit, so #551/#576's wait+retry was **not exercised**, and N3 is no evidence for rate-limit resilience. The diff was tiny (a cq.json override plus a docs log), so the partitioned/session reviewer and the budget-stop publication path were not exercised either (M covers those up to the red final gate).
- Observation, not a defect: CodeRabbit treated the dogfood-only reviewer/step override as a regression, and the loop reverted it. Its net diff against merge-queue is therefore docs only. A dogfood run that needs a config override should supply it outside the reviewed tree.
- #620 got one independent critic PASS (no findings), as a head-bound review, plus green exact-head CI. The chancellor merged it at 2026-10-28T00:07:02Z (`088b8676`). No N4.
