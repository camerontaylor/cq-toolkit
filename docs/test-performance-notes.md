# Test-suite performance notes (U4 driver transport inventory)

## Before / after

The baseline was measured on the loaded host recorded in the viability plan:
the full suite took **1,344s**, `test/e2e/sweep` took **918s**, and
`test/driver/acp.test.ts` took **105s with one failure**. Those figures are
ordering evidence, not a quiet-run SLA: other Paseo worktrees were active and
the measured load was about 4.5.

The pre-rebase U4 driver run was measured at historical HEAD **`83b0a39`**
with the transport fakes enabled for the shared conformance suite and with
the real contracts retained. The serial `test/driver/` run completed in
**85.5s wall**; its per-file measured portions were 44.2s ACP, 20.1s
subprocess, and under 0.6s for each remaining file. The fake-backed
conformance cases are now in-process; the real fixture contracts remain in
the driver-specific tests. These are pre-rebase measurements, not the final
stacked measurement.

Final-tree framing: the loaded-host baseline was **1,344s / 2,612 tests**;
the three consecutive final-tree runs are consistently **695–704s / 2,888
tests**. The suite grew through upstream sweep/review feature tests merged
from merge-queue, so the like-for-like reduction is larger than the totals
suggest. The dominant residual is load-sensitive
`test/e2e/sweep/sweep.e2e.test.ts` at roughly **190–480s**; its deviation
from the ≤60s/file goal is documented alongside the rescue/assembly-policy
rationale. The ≤180s full-suite goal was not met on this chronically loaded
host; the per-file table is the actionable breakdown. All timing rows remain
advisory rather than a new timeout or ratchet.

| Area                                                      |                 Baseline |                                                                                      U4 current measurement | Interpretation                                                                                                         |
| --------------------------------------------------------- | -----------------------: | ----------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Full suite                                                |                   1,344s |                                                                                not re-measured in this unit | The U4 change is scoped to the driver transport boundary; the full-suite target belongs to the stacked PR measurement. |
| **Final full run 1 (final tree)**                         |                        — |                                                  703.98s wall; exit 0; load 3.74/3.92/3.90 → 4.56/4.18/4.03 | Per-file breakdown was not included in the supplied run record; advisory only.                                         |
| **Final full run 2 (final tree)**                         |                        — | 693.81s wall; 2,880 passed / 7 skipped / 1 todo (2,888 total); exit 0; load 2.97/3.39/3.67 → 4.40/3.50/3.34 | Green; per-file breakdown is recorded in the final gate evidence.                                                      |
| **Final full run 3 (final tree)**                         |                        — | 695.41s wall; 2,880 passed / 7 skipped / 1 todo (2,888 total); exit 0; load 4.40/3.50/3.34 → 4.02/3.84/3.52 | Green; per-file breakdown is recorded in the final gate evidence.                                                      |
| `test/e2e/sweep`                                          |                     918s |                                                                                           not changed by U4 | PR-2's process-count work owns this area.                                                                              |
| **Dominant residual: `test/e2e/sweep/sweep.e2e.test.ts`** |                        — |                                                                                      approximately 190–480s | Load-sensitive; rescue/assembly policy explains the deviation from the ≤60s/file goal.                                 |
| `test/driver/acp.test.ts`                                 |          105s, 1 failure |                                                                                                       44.2s | Conformance protocol decisions use the in-process ACP adapter; retained real OS/wire contracts remain.                 |
| `test/driver/subprocess.test.ts`                          | not separately baselined |                                                                                                       20.1s | Conformance stream-json decisions use the in-process managed-child adapter.                                            |
| `test/driver/ai-sdk.test.ts`                              | not separately baselined |                                                                                                       0.39s | No U4 transport change.                                                                                                |
| `test/driver/claude-agent.test.ts`                        | not separately baselined |                                                                                                       0.51s | No U4 transport change.                                                                                                |
| `test/driver/process-inventory.test.ts`                   |                      new |                                                                                                       0.08s | Cheap guard over the committed process-entry list.                                                                     |

Per-file durations are advisory measurements only. Host load, filesystem
caches, and other worktrees can dominate them; do not turn this table into a
new timeout or ratchet.

### Plan 003 measurements (advisory)

Single-file runs on the same loaded host, wall time including the global
build; test time in brackets. None ran in a quiet (<3.0 load) window.

| File                                                           | Before                                                                                                                                             | After                                             | Load (start → end)                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `test/e2e/sweep/sweep.e2e.test.ts` (5 contracts)               | 513s (5 contracts, rescue on; load 5.7 → 7.4 with 4 other vitest runs); a later profile at load ≈6 had the interrupt contract hit its 180s timeout | 145.9s [134.8s], 157.3s [145.2s], 156.8s [146.1s] | 3.64 → 4.81, 5.31 → 4.33, 5.37 → 4.60 |
| `test/driver/acp.test.ts` (conformance + 51 in-process)        | 44.2s (all driver-specific cases real)                                                                                                             | 4.5s test time                                    | ≈5.4                                  |
| `test/driver/acp.real.test.ts` (7)                             | —                                                                                                                                                  | 1.3s test time                                    | ≈5.4                                  |
| `test/driver/subprocess.test.ts` (conformance + 22 in-process) | 20.1s                                                                                                                                              | 0.2s test time                                    | ≈5.4                                  |
| `test/driver/subprocess.real.test.ts` (12)                     | —                                                                                                                                                  | 5.1s test time                                    | ≈5.4                                  |

The sweep e2e misses the ≤120s goal on this host by about 25s of test
time; its five contracts are each one real fleet over real git, and the
remaining cost is per-exec git latency under load.

## Real-contract inventory

The shared conformance suite now drives the production driver seams with the
two thin adapters in `test/helpers/transport-fakes.ts`. The JSON-line engine
is shared; only the `ChildProcess` and `ManagedChild` adapters differ. Every
external boundary still has at least one real fixture-process contract:

| Boundary                                         | Shim                                                                                                             | Real contract retained                                                                                                                                 | What the real test proves                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP JSON-RPC handshake and session establishment | `fakeAcpSpawn` in `test/helpers/transport-fakes.ts`; conformance factory in `test/driver/acp.test.ts`            | `test/driver/acp.real.test.ts` — `resume sidecar` (the initialize → session/new → session/load path)                                                   | Real child stdio, JSON-RPC frames, ACP session id, and the sidecar on disk.                                                                    |
| ACP stdout framing                               | Same ACP adapter                                                                                                 | `test/driver/acp.real.test.ts` — `stdout frame straddle`                                                                                               | A real child flushes one large frame across pipe writes; the wire buffer preserves both halves.                                                |
| ACP broken pipe / process death                  | Same ACP adapter                                                                                                 | `test/driver/acp.real.test.ts` — `a foreign-session ask whose REJECTION write fails`                                                                   | A real closed stdin produces the EPIPE/error-channel behavior observed by the driver.                                                          |
| ACP SIGTERM → SIGKILL cancellation ladder        | Same ACP adapter; the cancellation tests remain real                                                             | `test/driver/acp.real.test.ts` — the three governed cancel tests (`cancel maps to aborted`, `IGNORES session/cancel`, and `a cancel write stalled...`) | Real child process signals, grace windows, and kill escalation. These three tests are deliberately not shimmed.                                |
| Subprocess stream-json parsing and usage         | `fakeManagedSpawn` in `test/helpers/transport-fakes.ts`; conformance factory in `test/driver/subprocess.test.ts` | `test/driver/subprocess.real.test.ts` — `structured output`, `usage mapping`, and `costUSD via the pricing override`                                   | The retained real cases prove that a real CLI stream, result event, usage shape, and schema boundary agree with the adapter's scripted frames. |
| Subprocess argv and sidecar                      | Same managed-child adapter                                                                                       | `test/driver/subprocess.real.test.ts` — `resume: the second run passes --resume`                                                                       | Real child argv, a real sidecar file, and the persisted resume id.                                                                             |
| Subprocess signal ladder                         | Same managed-child adapter                                                                                       | `test/driver/subprocess.real.test.ts` — `grace ladder: a SIGTERM-ignoring child escalates to SIGKILL`                                                  | Real OS signals, both ladder rungs, and one real spawn.                                                                                        |
| Subprocess process-group kill                    | Same managed-child adapter                                                                                       | `test/driver/subprocess.real.test.ts` — `abort kills the whole process GROUP`                                                                          | A real grandchild is killed with its process group.                                                                                            |
| ACP answer-write failure                         | Same ACP adapter                                                                                                 | `test/driver/acp.real.test.ts` — `answer-write failure fails the run loudly`                                                                           | A real closed fd 0 fails the permission answer write while the vendor stays alive; the transport fake's stdin cannot fail yet.                 |
| Subprocess default-disposition SIGTERM           | Same managed-child adapter                                                                                       | `test/driver/subprocess.real.test.ts` — `graceful abort: a default-disposition child dies on SIGTERM`                                                  | The only real proof that the SIGTERM rung's group kill ends a cooperative child in one rung.                                                   |
| Subprocess stdout tail cap                       | None (the fake replaces `spawnManaged`, the code under test)                                                     | `test/driver/subprocess.real.test.ts` — the four bounded-tail tests                                                                                    | `spawnManaged`'s retention cap over real pipe chunks: `droppedBytes`, the unterminated line, flush, astral trim.                               |
| Subprocess child environment (#183)              | None (the fake ignores the env allowlist)                                                                        | `test/driver/subprocess.real.test.ts` — `a REAL spawned worker cannot see a marker secret`                                                             | The production spawn path's actual child environment.                                                                                          |
| ACP/subprocess transport shape                   | Shared JSON-line engine plus one adapter per seam                                                                | `test/driver/process-inventory.test.ts`                                                                                                                | The known process-backed test-file inventory remains explicit and reviewable.                                                                  |

The inventory guard scans every discovered test file for direct
`node:child_process` imports and the known real-effect entry points
(`spawnAcpProcess`, `spawnManaged`, the `makeSubprocess*Effects/Deps`
factories, `makeGhRunner`, `makeCheckRunner`, `realMergeEffects`, the
harness `buildTools` and the in-process `ClaudeAgentDriver`/`AiSdkDriver`
whose `run` tool executes through the shell, `generateScratchRepo`,
`createGitTemplate`, and `runSweepPlan`). It
deliberately guards **known entry points only**: a new or transitive spawn
helper can evade this scan, so adding one requires conscious inventory review
rather than pretending the regex is complete. The inventory also defines the
test lanes (below), so a missed entry point puts a process-backed file in
`test:unit`.

## Classification

| Area                                                                                                                                                                                                                 | Classification                         | Reason                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared ACP/subprocess conformance decisions: structured output, budget, abort verdict, denial shape, usage, serialized seam, isolation, resume record, cost, error verdict, tool policy, path escape, observed model | **Moved to transport fakes**           | These are our parsing, folding, policy, and verdict logic over wire shapes; the real twin cases below preserve the external boundary. |
| ACP frame straddle, ACP resume/sidecar, ACP EPIPE, and the three ACP cancel/kill cases                                                                                                                               | **Kept real**                          | These prove OS process, stdio, signal, and sidecar contracts rather than only our decision logic.                                     |
| Subprocess resume/argv/sidecar, SIGTERM→SIGKILL, and process-group grandchild kill                                                                                                                                   | **Kept real**                          | These prove process startup, argv, filesystem sidecars, signals, and descendant cleanup.                                              |
| Every other driver-specific ACP/subprocess case                                                                                                                                                                      | **Classified per test** (next section) | Each test is either process-free, moved onto the fixture persona in-process, or kept real for a named OS-level boundary.              |

The three governed ACP cancel tests remain real exactly as required; PR-1 is
present in this base, and its `midPromptDeadline` helper must preserve their
mid-prompt semantics. U4 does not rewrite or remove those tests.

## Driver-specific classification (plan 003 F2)

The fixtures' protocol logic lives in transport-free personas
(`test/fixtures/fake-acp-persona.mjs`, `test/fixtures/fake-agent-persona.mjs`).
The real fixture processes (`fake-acp-server.mjs`, `fake-agent-cli.mjs`) are
thin stdio hosts over them, and `test/helpers/persona-spawn.ts` hosts the
same personas in-process over `fakeAcpSpawn` / `fakeManagedSpawn`. A moved
test therefore sees the same wire as before — including the real reject
path (a `tool_call` card, then a failed `tool_call_update` `rejected
(<optionId>)`) — rather than a second hand-written model of it. The
conformance suite's own scripts (`fakeAcpScript`, `fakeManagedScript`) are
unchanged.

Verdicts: **process-free** (never spawned), **persona** (moved in-process),
**real** (kept on the real fixture for the named boundary).

### ACP (58 driver-specific tests: 11 process-free, 40 persona, 7 real)

| Test                                                                                                                                                                   | Verdict      | Why                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| win32 shim: `.cmd/.bat` through cmd.exe; everything else verbatim (2)                                                                                                  | process-free | Pure argv mapping.                                                                                        |
| absent binary; unknown endpoint + absent endpoint binary; unknown sessionRef; missing envNames var (4)                                                                 | process-free | Pre-dispatch throws; each asserts zero spawns.                                                            |
| `mapWireUsage`: invalid token counts                                                                                                                                   | process-free | Pure function.                                                                                            |
| binary resolution: `./bin` path-carrying; bare name walks PATH; `carriesPathSeparator`; relative PATH entry (4)                                                        | process-free | Injected probe or pure function.                                                                          |
| answer table: allow → `allow_once`; `allow_always` fallback; reject → `reject_once`; deny with no reject option; allow with no allow option (5)                        | persona      | Answer-table selection and narration over the vendor's options.                                           |
| answer table: selection failure pins error past a tolerant `end_turn`                                                                                                  | persona      | Verdict pinning; the persona's SIGTERM-ignore rides the fake's `ignoresSignal`.                           |
| never-asks tripwire; denied-execution tripwire (#45); latched bypass evidence; placeholder permission card (4)                                                         | persona      | Card folding and tripwire verdicts; the `echo > file` run tool is modelled in-process.                    |
| served model via modelEnv; usage mapping; no served model → cost absent; malformed usage → error (4)                                                                   | persona      | Model observation, usage fold, cost gating.                                                               |
| foreign-session ask rejected, ungated card fails the run                                                                                                               | persona      | Scope gate plus never-asks, over the persona's real reject/error path.                                    |
| oversized frame fails the connection; oversized frame after a settled turn; complete frame over the bound (3)                                                          | persona      | Our line-bound logic; raw writes model the unterminated and one-flush shapes.                             |
| resume gate rungs 2 and 3; `session/load` replay suppression; line-gated replay window (4)                                                                             | persona      | Resume gate and replay folding; the one-flush response + tail is a single raw write.                      |
| string JSON-RPC request ids                                                                                                                                            | persona      | Id correlation.                                                                                           |
| attach-time abort recheck                                                                                                                                              | persona      | Our abort recheck; the child is terminated before any handshake write.                                    |
| mode pin observable; pin must be confirmed; pin from the notification; stale pre-pin report; post-pin downgrade; unshapeable pin answer; protocol-version mismatch (7) | persona      | Handshake verdicts.                                                                                       |
| deny-tool; content-block success output; content-block failure reason; structured rawOutput (4)                                                                        | persona      | Tool-result folding.                                                                                      |
| non-JSON reply dropped; spawn seam argv; structured-output round-trip; path escape; fresh runs share nothing (5)                                                       | persona      | Structured-output rule, spawn-seam inputs, containment denial, per-spawn isolation (unique persona pids). |
| resume sidecar                                                                                                                                                         | real         | Real handshake plus the sidecar on disk.                                                                  |
| stdout frame straddle                                                                                                                                                  | real         | A real child's split flushes.                                                                             |
| foreign-session ask whose REJECTION write fails                                                                                                                        | real         | A real closed fd 0 (EPIPE).                                                                               |
| answer-write failure                                                                                                                                                   | real         | A real closed fd 0; the fake stdin never errors.                                                          |
| cancel → aborted; vendor ignores `session/cancel`; cancel write stalled behind a wedged prompt (3)                                                                     | real         | Real signals, grace windows, kill escalation, pipe backpressure.                                          |

### Subprocess (34 driver-specific tests: 10 process-free, 12 persona, 12 real)

| Test                                                                                                                                                                                                                              | Verdict      | Why                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `routeFor` prototype keys; `buildArgs` argv; token fields fold to 0; empty binary template; synchronous spawn failure; grace validation; bounded secret-free error cause; two `buildChildEnv` tests; envAllowlist validation (10) | process-free | Pure functions, construction-time validation, or a throwing spawn override.   |
| remap: unknown model throws before spawn, then served-model observation                                                                                                                                                           | persona      | Pre-dispatch refusal plus served-model fold.                                  |
| junk lines are narration                                                                                                                                                                                                          | persona      | Tolerant parsing; the persona's non-JSON lines are raw writes.                |
| deny-tool; result-event error path; result cause precedence (3)                                                                                                                                                                   | persona      | Denial mapping and error-cause text.                                          |
| schema-violating structured output dropped                                                                                                                                                                                        | persona      | The driver's own validation at settle.                                        |
| budget: maxTokens trips                                                                                                                                                                                                           | persona      | Budget verdict on folded usage.                                               |
| unknown-model: nonzero exit, no result                                                                                                                                                                                            | persona      | Error cause from exit code and stderr.                                        |
| signal death names the signal                                                                                                                                                                                                     | persona      | The persona's self-kill closes the fake child with the signal.                |
| echo-workspace read in the resumed workspace                                                                                                                                                                                      | persona      | Workspace reuse and read folding; the real `--resume` argv stays in `resume`. |
| served-model pricing + mismatch marker                                                                                                                                                                                            | persona      | Pricing key and mismatch marker.                                              |
| sandbox-level-unenforced marker                                                                                                                                                                                                   | persona      | Marker logic.                                                                 |
| grace ladder SIGTERM → SIGKILL; default-disposition child dies on SIGTERM; process-group kill (3)                                                                                                                                 | real         | Real signals and a real grandchild.                                           |
| resume: `--resume` + sidecar in the store                                                                                                                                                                                         | real         | Real argv and sidecar file.                                                   |
| structured output checked by the CLI's `--json-schema`; usage mapping; costUSD via pricing override (3)                                                                                                                           | real         | A real CLI stream agrees with the adapter's scripted frames.                  |
| bounded stdout tail: droppedBytes; unterminated ~3x line; final line once; astral trim (4)                                                                                                                                        | real         | `spawnManaged` is the code under test.                                        |
| real worker cannot see a marker secret (#183)                                                                                                                                                                                     | real         | The real child environment.                                                   |

Personas the in-process host refuses loudly (they need the real process):
closing fd 0, pausing stdin reads, and the grandchild spawn. Remaining
transport-fake gaps: stdin that errors after the child closes its input,
and write backpressure; both are covered by the real tests above.

## Process-entry inventory

The committed list is this section: `scripts/lib/test-lanes.mjs` parses it
to derive the test lanes, and `test/driver/process-inventory.test.ts` checks
it against the known entry-point scan. The current list is:

- `test/cli/i1.test.ts`
- `test/cli/plans.smoke.test.ts`
- `test/driver/acp.real.test.ts`
- `test/driver/ai-sdk.test.ts`
- `test/driver/claude-agent.sdk-presence.test.ts`
- `test/driver/claude-agent.test.ts`
- `test/driver/subprocess.real.test.ts`
- `test/e2e/analyze/analyze.e2e.test.ts`
- `test/e2e/merge/live.test.ts`
- `test/e2e/review/live.test.ts`
- `test/e2e/sweep/sweep.e2e.test.ts`
- `test/harness/tools.test.ts`
- `test/helpers/git-template.test.ts`
- `test/ops/analyze/registry.test.ts`
- `test/ops/gates/adapters.test.ts`
- `test/ops/merge/executeMerges.test.ts`
- `test/ops/pr/ensureTrackerBranch.test.ts`
- `test/ops/pr/registry.test.ts`
- `test/ops/pr/runReport.test.ts`
- `test/ops/ratchet/captureBaseline.test.ts`
- `test/ops/ratchet/effects.test.ts`
- `test/ops/ratchet/monotonicGuard.test.ts`
- `test/ops/review/gh.test.ts`
- `test/ops/review/registry.test.ts`
- `test/ops/review/traps.test.ts`
- `test/ops/sweep/cleanup.test.ts`
- `test/ops/sweep/ledger-suppression.test.ts`
- `test/ops/sweep/planSweep.test.ts`
- `test/ops/sweep/salvage.test.ts`
- `test/ops/sweep/unit-registry.test.ts`
- `test/ops/sweep/worktreeFor.test.ts`
- `test/scripts/demo-eval-axes.test.ts`
- `test/scripts/knip.test.ts`
- `test/scripts/oxlint-boundaries.test.ts`
- `test/scripts/ratchet-baseline.test.ts`
- `test/scripts/static-conformance.test.ts`
- `test/scripts/tooling-commands.test.ts`
- `test/workflows/merge-queue-gate.test.ts`

## Lane-partition record (no CI changes)

Plan 003 F3 made the existing lane names honest without touching CI:

- `npm run test:unit` and `npm run test:e2e` run `scripts/test-lane.mjs`,
  which derives membership from the inventory list above
  (`scripts/lib/test-lanes.mjs`): **`test:e2e` is exactly the inventory**
  and **`test:unit` is every other discovered test file**. `npm run test`
  still runs everything.
- `test/scripts/test-lanes.test.ts` proves the lanes are disjoint, that
  their union is every file vitest discovers (including `lint/rules/`), that
  each lane's CLI arguments select exactly its members under vitest's
  exclude-glob and filter-substring semantics, and that the discovery model
  matches `vitest.config.ts`.
- Widening the inventory guard to the src spawn-effect factories
  (`makeSubprocess*Effects/Deps`, `makeGhRunner`, `makeCheckRunner`,
  `realMergeEffects`) moved eight files that launch shims or fixture
  processes into the process lane; a spawn trace of `test:unit` found them.
- A later trace of suspicious unit files found three more reaching a real
  shell through the harness `run` tool: `harness/tools.test.ts` directly,
  `claude-agent.test.ts` and `ai-sdk.test.ts` through the shared driver
  conformance suite. The `buildTools` and in-process driver patterns list
  them; `claude-agent.sdk-presence.test.ts` matches without spawning (its
  run is refused pre-dispatch). `test/ops/analyze/registry.test.ts` spawns
  (an `ast-grep` shim and a `node` verifier through the analyze registry's
  real runner) with no entry point in the test itself, so the guard lists
  it explicitly as a TRACED file: the documented inventory is the pattern
  scan plus that reasoned list.
- Correction (plan 003 F2): the earlier "57 of 58 driver-specific ACP tests
  spawn" was wrong — 11 never spawned (7 construct no driver, 4 assert zero
  pre-dispatch spawns), so **47 of 58** did. After F2, `acp.test.ts` and
  `subprocess.test.ts` spawn nothing; the real contracts live in
  `acp.real.test.ts` (7) and `subprocess.real.test.ts` (12).
- `plans.smoke.test.ts` no longer builds: global setup owns the build, and
  the smoke refuses a missing or stale `dist/` instead of rebuilding.

Recorded proposals, for a later policy/template decision:

1. Rename the lanes to `test:fast` and `test:process`. The names are wired
   into `.github/workflows/ci.yml`, which is not template-regenerable under
   `policy/templates/README.md`, so a rename needs a separate policy
   decision.
2. Introduce a `test/process/` tree for process-backed tests.

### Transport-fake follow-ups

- `fakeManagedSpawn` does not model the production `maxRetainedBytes` /
  `droppedBytes` tail cap. The cap contract is already directly covered by
  real `spawnManaged` tests in `test/driver/subprocess.real.test.ts`; a
  future fake-cap test is only needed if a moved script begins exercising
  output retention.
- The fake currently represents subprocess input as a synthetic JSON frame
  rather than literal prompt bytes plus EOF. The moved conformance scripts
  do not inspect prompt data or wait for `endStdin()`, so current assertions
  do not depend on that fidelity. A future wait-for-EOF conformance case is
  the candidate if byte/EOF behavior becomes part of the fake contract.

This list is a guard, not a claim that every transitive process launch is
found. The limitation is stated above so a future helper cannot make the
inventory look stronger than it is.
