# Test-suite performance notes (U4 driver transport inventory)

## Before / after

The baseline was measured on the loaded host recorded in the viability plan:
the full suite took **1,344s**, `test/e2e/sweep` took **918s**, and
`test/driver/acp.test.ts` took **105s with one failure**. Those figures are
ordering evidence, not a quiet-run SLA: other Paseo worktrees were active and
the measured load was about 4.5.

The current U4 driver run was measured on this worktree with the transport
fakes enabled for the shared conformance suite and with the real contracts
retained. The serial `test/driver/` run completed in **85.5s wall**; its
per-file measured portions were 44.2s ACP, 20.1s subprocess, and under 0.6s
for each remaining file. The fake-backed conformance cases are now in-process;
the real fixture contracts remain in the driver-specific tests.

| Area                                    |                 Baseline |       U4 current measurement | Interpretation                                                                                                         |
| --------------------------------------- | -----------------------: | ---------------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Full suite                              |                   1,344s | not re-measured in this unit | The U4 change is scoped to the driver transport boundary; the full-suite target belongs to the stacked PR measurement. |
| `test/e2e/sweep`                        |                     918s |            not changed by U4 | PR-2's process-count work owns this area.                                                                              |
| `test/driver/acp.test.ts`               |          105s, 1 failure |                        44.2s | Conformance protocol decisions use the in-process ACP adapter; retained real OS/wire contracts remain.                 |
| `test/driver/subprocess.test.ts`        | not separately baselined |                        20.1s | Conformance stream-json decisions use the in-process managed-child adapter.                                            |
| `test/driver/ai-sdk.test.ts`            | not separately baselined |                        0.39s | No U4 transport change.                                                                                                |
| `test/driver/claude-agent.test.ts`      | not separately baselined |                        0.51s | No U4 transport change.                                                                                                |
| `test/driver/process-inventory.test.ts` |                      new |                        0.08s | Cheap guard over the committed process-entry list.                                                                     |

Per-file durations are advisory measurements only. Host load, filesystem
caches, and other worktrees can dominate them; do not turn this table into a
new timeout or ratchet.

## Real-contract inventory

The shared conformance suite now drives the production driver seams with the
two thin adapters in `test/helpers/transport-fakes.ts`. The JSON-line engine
is shared; only the `ChildProcess` and `ManagedChild` adapters differ. Every
external boundary still has at least one real fixture-process contract:

| Boundary                                         | Shim                                                                                                             | Real contract retained                                                                                                                            | What the real test proves                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP JSON-RPC handshake and session establishment | `fakeAcpSpawn` in `test/helpers/transport-fakes.ts`; conformance factory in `test/driver/acp.test.ts`            | `test/driver/acp.test.ts` — `resume sidecar` (the initialize → session/new → session/load path)                                                   | Real child stdio, JSON-RPC frames, ACP session id, and the sidecar on disk.                                                                    |
| ACP stdout framing                               | Same ACP adapter                                                                                                 | `test/driver/acp.test.ts` — `stdout frame straddle`                                                                                               | A real child flushes one large frame across pipe writes; the wire buffer preserves both halves.                                                |
| ACP broken pipe / process death                  | Same ACP adapter                                                                                                 | `test/driver/acp.test.ts` — `a foreign-session ask whose REJECTION write fails`                                                                   | A real closed stdin produces the EPIPE/error-channel behavior observed by the driver.                                                          |
| ACP SIGTERM → SIGKILL cancellation ladder        | Same ACP adapter; the cancellation tests remain real                                                             | `test/driver/acp.test.ts` — the three governed cancel tests (`cancel maps to aborted`, `IGNORES session/cancel`, and `a cancel write stalled...`) | Real child process signals, grace windows, and kill escalation. These three tests are deliberately not shimmed.                                |
| Subprocess stream-json parsing and usage         | `fakeManagedSpawn` in `test/helpers/transport-fakes.ts`; conformance factory in `test/driver/subprocess.test.ts` | `test/driver/subprocess.test.ts` — `structured output`, `usage mapping`, and `costUSD via the pricing override`                                   | The retained real cases prove that a real CLI stream, result event, usage shape, and schema boundary agree with the adapter's scripted frames. |
| Subprocess argv and sidecar                      | Same managed-child adapter                                                                                       | `test/driver/subprocess.test.ts` — `resume: the second run passes --resume`                                                                       | Real child argv, a real sidecar file, and the persisted resume id.                                                                             |
| Subprocess signal ladder                         | Same managed-child adapter                                                                                       | `test/driver/subprocess.test.ts` — `grace ladder: a SIGTERM-ignoring child escalates to SIGKILL`                                                  | Real OS signals, both ladder rungs, and one real spawn.                                                                                        |
| Subprocess process-group kill                    | Same managed-child adapter                                                                                       | `test/driver/subprocess.test.ts` — `abort kills the whole process GROUP`                                                                          | A real grandchild is killed with its process group.                                                                                            |
| ACP/subprocess transport shape                   | Shared JSON-line engine plus one adapter per seam                                                                | `test/driver/process-inventory.test.ts`                                                                                                           | The known process-backed test-file inventory remains explicit and reviewable.                                                                  |

The inventory guard scans `*.test.ts` files for direct `node:child_process`
imports and the known real-effect entry points (`spawnAcpProcess`,
`spawnManaged`, `makeSubprocessWorktreeEffects`, `generateScratchRepo`,
`createGitTemplate`, and `runSweepPlan`). It deliberately guards **known
entry points only**: a new or transitive spawn helper can evade this scan, so
adding one requires conscious inventory review rather than pretending the
regex is complete.

## Classification

| Area                                                                                                                                                                                                                 | Classification                                            | Reason                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared ACP/subprocess conformance decisions: structured output, budget, abort verdict, denial shape, usage, serialized seam, isolation, resume record, cost, error verdict, tool policy, path escape, observed model | **Moved to transport fakes**                              | These are our parsing, folding, policy, and verdict logic over wire shapes; the real twin cases below preserve the external boundary. |
| ACP frame straddle, ACP resume/sidecar, ACP EPIPE, and the three ACP cancel/kill cases                                                                                                                               | **Kept real**                                             | These prove OS process, stdio, signal, and sidecar contracts rather than only our decision logic.                                     |
| Subprocess resume/argv/sidecar, SIGTERM→SIGKILL, and process-group grandchild kill                                                                                                                                   | **Kept real**                                             | These prove process startup, argv, filesystem sidecars, signals, and descendant cleanup.                                              |
| Other driver-specific ACP/subprocess cases                                                                                                                                                                           | **Retained real until a case-specific boundary is named** | When in doubt, the real fixture is safer than silently replacing a process contract.                                                  |

The three governed ACP cancel tests remain real exactly as required. The
future PR-1 rebase's `midPromptDeadline` helper must preserve their
mid-prompt semantics; U4 does not rewrite or remove those tests.

## Process-entry inventory

The committed list lives in `test/driver/process-inventory.test.ts` and is
checked against the known entry-point scan. The current list is:

- `test/cli/i1.test.ts`
- `test/driver/acp.test.ts`
- `test/driver/subprocess.test.ts`
- `test/e2e/analyze/analyze.e2e.test.ts`
- `test/e2e/merge/live.test.ts`
- `test/e2e/sweep/sweep.e2e.test.ts`
- `test/helpers/git-template.test.ts`
- `test/ops/ratchet/captureBaseline.test.ts`
- `test/ops/ratchet/monotonicGuard.test.ts`
- `test/ops/review/registry.test.ts`
- `test/ops/sweep/cleanup.test.ts`
- `test/ops/sweep/ledger-suppression.test.ts`
- `test/ops/sweep/unit-registry.test.ts`
- `test/ops/sweep/worktreeFor.test.ts`
- `test/scripts/demo-eval-axes.test.ts`
- `test/scripts/knip.test.ts`
- `test/scripts/oxlint-boundaries.test.ts`
- `test/scripts/ratchet-baseline.test.ts`
- `test/scripts/static-conformance.test.ts`
- `test/scripts/tooling-commands.test.ts`
- `test/workflows/merge-queue-gate.test.ts`

This list is a guard, not a claim that every transitive process launch is
found. The limitation is stated above so a future helper cannot make the
inventory look stronger than it is.
