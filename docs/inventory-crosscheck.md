# Inventory crosscheck — plan §5 → op name → registry entry → subcommand

Evidence for WS-I scope item 1 / spec DoD 3 ("every op standalone from TS and
via CLI") and T4.2's registry-completeness closure. The source is the
**plan §5 atomic-op inventory** (`plans/toolkit-v1-plan.md` §5) crosschecked
against the shipped registry.

How to reproduce the right-hand columns:

```sh
npm run build
node -e "import('./dist/registry/index.js').then(async (m) => \
  (await m.list()).forEach((e) => console.log(e.name)))" | sort
node dist/cli.js --help
```

Every op is reachable at a subcommand whose name is exactly its registry
entry name (`cq <op-name> …`); `run-plan` is the one non-op subcommand
(governed plan composition). A family's entries live in
`src/ops/<family>/registry.ts` — the central scanner
(`src/registry/index.ts`) discovers each family's exported `registry` array at
runtime and lazily imports the op module only on dispatch.

Legend: **entry** = `src/ops/<family>/registry.ts` → `name`.

## §5 op rows → registry entries

| Plan §5 row                                                                                                                     | Op / module                                                        | Registry entry                                                                                                                                                     | CLI subcommand                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Op contract + plan runner (`runPlan`)                                                                                           | `src/kernel/runner.ts` (+ governor/journal)                        | _kernel, not an op entry_                                                                                                                                          | `run-plan`                                                                                                                                                                |
| Run manifest + NDJSON journal (`runLog.append`, `statusOf`)                                                                     | `src/kernel/journal.ts`                                            | _kernel, not an op entry_                                                                                                                                          | `run-plan --journal-dir=… --resume`                                                                                                                                       |
| Budget governor                                                                                                                 | `src/kernel/governor.ts`                                           | _kernel, not an op entry_                                                                                                                                          | `run-plan --max-usd=… --max-tokens=…`                                                                                                                                     |
| Rescue/escalation policy                                                                                                        | `src/kernel/rescue.ts`                                             | _kernel, not an op entry_                                                                                                                                          | `run-plan` (governed pipeline)                                                                                                                                            |
| Driver seam + 4 drivers + harness + price map                                                                                   | `src/driver/**`, `src/harness/**`                                  | _SDK library, not an op entry_                                                                                                                                     | — (consumed by ops/plans)                                                                                                                                                 |
| `planSweep(spec): Job[]`                                                                                                        | `src/ops/sweep/planSweep.ts`                                       | `sweep` → `sweep.planSweep`                                                                                                                                        | `cq sweep.planSweep`                                                                                                                                                      |
| `worktreeFor(job)` + naming/mutex                                                                                               | `src/ops/sweep/worktreeFor.ts` (`gitMutex.ts` is a library util)   | `sweep` → `sweep.worktreeFor`                                                                                                                                      | `cq sweep.worktreeFor`                                                                                                                                                    |
| Concurrency (p-limit, one knob)                                                                                                 | `src/kernel/runner.ts`                                             | _kernel, not an op entry_                                                                                                                                          | `run-plan --concurrency=…`                                                                                                                                                |
| `salvage(scan): SalvagePlan`                                                                                                    | `src/ops/sweep/salvage.ts`                                         | `sweep` → `sweep.salvage`                                                                                                                                          | `cq sweep.salvage`                                                                                                                                                        |
| PR ops (`assemblePrs`, tracker, run report)                                                                                     | `src/ops/pr/{ensureTrackerBranch,assemblePrs,runReport}.ts`        | `pr` → `pr.ensureTrackerBranch`, `pr.assemblePrs`, `pr.runReport`                                                                                                  | `cq pr.ensureTrackerBranch`, `cq pr.assemblePrs`, `cq pr.runReport`                                                                                                       |
| `baselineProbe(ws, cmd): ProbeResult`                                                                                           | `src/ops/gates/baselineProbe.ts`                                   | `gates` → `gates.baselineProbe`                                                                                                                                    | `cq gates.baselineProbe`                                                                                                                                                  |
| `regressionGate(base, final): Verdict`                                                                                          | `src/ops/gates/regressionGate.ts`                                  | `gates` → `gates.regressionGate`                                                                                                                                   | `cq gates.regressionGate`                                                                                                                                                 |
| `hackDetector(diff): Finding[]`                                                                                                 | `src/ops/gates/hackDetector.ts`                                    | `gates` → `gates.hackDetector`                                                                                                                                     | `cq gates.hackDetector`                                                                                                                                                   |
| Novel-error `ledger`                                                                                                            | `src/ops/ledger/{ledger,store}.ts`                                 | `ledger` → `ledger.record`, `ledger.query`                                                                                                                         | `cq ledger.record`, `cq ledger.query`                                                                                                                                     |
| Check adapters (test/lint/typecheck → failure sets)                                                                             | `src/ops/gates/checkRunner.ts` + `adapters/{vitest,eslint,tsc}.ts` | `gates` → `gates.checkRunner` (adapters are config, not ops)                                                                                                       | `cq gates.checkRunner`                                                                                                                                                    |
| Review ops: `fetchReviewState`, `classifyThreads`, `planReviewBatch`, `fixReviewItem`, `replyAndResolve`, `verifyReviewOutcome` | `src/ops/review/*.ts`                                              | `review` → `review.fetchReviewState`, `review.classifyThreads`, `review.planReviewBatch`, `review.fixItem`, `review.replyAndResolve`, `review.verifyReviewOutcome` | `cq review.fetchReviewState`, `cq review.classifyThreads`, `cq review.planReviewBatch`, `cq review.fixItem`, `cq review.replyAndResolve`, `cq review.verifyReviewOutcome` |
| Merge ops: `classifyPrs`, `planMergeOrder`, `executeMerges`, `resolveConflict`, `diagnoseMergeFailure`                          | `src/ops/merge/*.ts`                                               | `merge` → `merge.classifyPrs`, `merge.planMergeOrder`, `merge.executeMerges`, `merge.resolveConflict`, `merge.diagnoseMergeFailure`                                | same five names as subcommands                                                                                                                                            |
| Analyze ops: `collectFailures`, `clusterErrors`, `renderAnalysisReport`, `applyRemediation`                                     | `src/ops/analyze/*.ts`                                             | `analyze` → `analyze.collectFailures`, `analyze.clusterErrors`, `analyze.renderAnalysisReport`, `analyze.applyRemediation`                                         | same four names as subcommands                                                                                                                                            |
| Ratchet ops: `captureBaseline`, `checkRatchet`, `proposeBaselineUpdate` + metric adapters                                       | `src/ops/ratchet/*.ts` (`metricRegistry.ts` holds the adapters)    | `ratchet` → `ratchet.captureBaseline`, `ratchet.checkRatchet`, `ratchet.proposeBaselineUpdate` (+`ratchet.monotonicGuard`)                                         | same four names as subcommands                                                                                                                                            |
| Merge-queue design + doctrine                                                                                                   | `policy/templates/**`, `policy/DOCTRINE.md`                        | _policy artifacts, not ops_                                                                                                                                        | — (workflows instantiated from templates)                                                                                                                                 |
| Denylist scan                                                                                                                   | `scripts/denylist-scan`, `.github/workflows/denylist.yml`          | _publication tooling, not ops_                                                                                                                                     | — (CI step)                                                                                                                                                               |
| Shipped plans (`sweep`, `test-fix`, `review-loop`, `merge-prs`, `analyze`) + CLI                                                | `src/plans/*.ts` (plan registry) + `src/cli/**`                    | _plan registry (`src/plans/registry.ts`), not op entries_                                                                                                          | `run-plan --plan=<path>` (one subcommand per op, above)                                                                                                                   |

## Registered ops beyond the §5 row set (phase-2/3 extensions)

These shipped during the family workstreams and are registered alongside the
§5 rows; they are not separate §5 entries.

| Op / module                             | Registry entry                                                                           | CLI subcommand                  | Origin                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------- |
| `src/ops/gates/commitGate.ts`           | `gates.commitGate`                                                                       | `cq gates.commitGate`           | C3 commit-message gate (I3 support)                 |
| `src/ops/sweep/unit.ts`                 | `sweep.unit`                                                                             | `cq sweep.unit`                 | sweep work-unit composition (driver + probe + push) |
| `src/ops/sweep/cleanup.ts`              | `sweep.cleanup`                                                                          | `cq sweep.cleanup`              | worktree cleanup                                    |
| `src/ops/merge/runPrs.ts`               | `merge.runPrs`                                                                           | `cq merge.runPrs`               | merge-prs plan composition                          |
| `src/ops/analyze/codemod/astGrep.ts`    | `analyze.astGrepCodemod`                                                                 | `cq analyze.astGrepCodemod`     | G2 codemod engine                                   |
| `src/ops/analyze/agenticRemediation.ts` | `analyze.agenticRemediation`                                                             | `cq analyze.agenticRemediation` | G1/G2 agentic proposal                              |
| `src/ops/analyze/playbooks/registry.ts` | `analyze.playbookRegister`, `analyze.playbookDispatch`, `analyze.playbookQuarantineList` | same three names as subcommands | G3 playbook lane                                    |
| `src/ops/ratchet/monotonicGuard.ts`     | `ratchet.monotonicGuard`                                                                 | `cq ratchet.monotonicGuard`     | H2 only-tightening diff guard (I5)                  |

## Not built (out of scope per plan)

Explicitly out of v1 scope in plan §5 and R2 arm-a §4.3 — no registry entry,
no subcommand, by design:

- Worker spawning/sessioning (drivers), pooling (`p-limit`), worktree
  mechanics (`git`), event transport (NDJSON), PR substrate (`gh`),
  model-choice measurement (fixtures repo) — adopted dependencies/library
  code, not atomic ops.
- UC §1 row 11 (`progress-worktrees`, advancing local feature worktrees) — a
  post-v1 candidate composable from WS-E/WS-F ops.
- Product check-* rules and baseline _data_ stay in consumers; the toolkit
  ships the engine and formats (spec Constraints).

## Registry completeness

`src/registry/index.ts` `listWithDiagnostics().skippedFamilies` is empty: all
eight planned families (`gates`, `ledger`, `review`, `merge`, `ratchet`,
`sweep`, `pr`, `analyze`) export a `registry` array, so every planned family
contributes entries. The family completeness heuristic in
`test/cli/registry.test.ts` fails when an op module is added without a
registration; `test/cli/registry-props.test.ts` walks every entry's
schema-generated input; `test/cli/conformance.test.ts` and
`test/cli/parity.test.ts` pin the stdout/exit-code and TS⇄CLI parity
contracts.
