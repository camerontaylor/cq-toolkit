# Test-suite performance notes (2026-09-20)

Question: is the suite getting slow enough to need an impacted-only
protocol and/or slow-test marking?

## Verdict

Yes. Full `npx vitest run` did not finish in 600s. The
`policy/templates/affected-tests.md` premise ("the suite is
seconds-sized, so selection buys nothing yet") is stale. Recommend:

1. Instantiate the affected-tests advisory (non-required per-PR
   `vitest related --run`; merge-queue full suite stays required).
2. Gate or lane the slowest real-process tests
   (`test/e2e/sweep`, `test/scripts/tooling-commands`).
3. Give real-git/subprocess tests explicit timeouts instead of the
   5s default.

## Evidence (per-dir `vitest run`, serial per config)

| Area                                  | Time                       | Notes                                                               |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Full suite                            | >600s, unfinished          | `fileParallelism: false` makes this additive                        |
| `test/e2e/sweep`                      | >60s, unfinished           | 6 tests at 120–180s timeouts, no `skipIf`; worst case ~12 min alone |
| `test/scripts/tooling-commands`       | >120s, hung                | each test `spawnSync`s real `lint-fast` + `ratchet-typecheck`       |
| `test/plans`                          | ~95s                       | `review-loop` + `sweep` dominate                                    |
| `test/ops/sweep/worktreeFor`          | ~94s                       | one real `git init → worktree add → clean → prune` ~41s             |
| `test/ops/ratchet/monotonicGuard`     | ~91s                       | real-`git diff` fixtures ~20s each                                  |
| `test/workflows`                      | ~50s                       |                                                                     |
| `test/scripts` (knip+oxlint+demo)     | ~46s                       | real tool spawns                                                    |
| `test/kernel`                         | ~34s                       | `governor` is the anchor                                            |
| `test/ops/gates`                      | ~30s                       |                                                                     |
| `test/driver`                         | slow + 5s-timeout failures | grace-ladder/sidecar tests hit default timeout under load           |
| `test/ops/analyze`, `merge/pr/ledger` | 4–9s                       | not the problem                                                     |
| `test/cli`                            | 1–2s                       | not the problem                                                     |
| `test/e2e/analyze`                    | ~7s                        | fine                                                                |

Scale: 98 test files / ~58k test lines; 20 files spawn real
subprocesses, 48 use real fs/git/tsc.

## Structural drivers

- `vitest.config.ts`: `fileParallelism: false` (deliberate — process-backed
  suites with termination deadlines). Total time = sum of files.
- Slowness concentrates in real-process tests (git, tsc, oxlint,
  subprocess), not unit tests.
- Several 5s-default-timeout failures (`driver`, `review/registry`
  rev-parse) are load-flaky, not real regressions — they need explicit
  timeouts.

## Caveats

- Timings taken with other Paseo worktrees running vitest concurrently;
  absolute numbers are inflated. Ordering (which areas dominate) is the
  signal. Re-measure on quiet CI runners before setting thresholds.
- `static-conformance` failed at 31s then passed at 12s on retry —
  flaky under load, same caveat.

## Constraints on the fix

- Workflow changes go through `policy/templates/` — never edit
  `.github/workflows/` directly.
- Keep any affected-tests job advisory (I4 interplay in the template);
  the merge-queue full suite is the completeness gate.
- Do not parallelize files without evidence the process-backed suites
  tolerate it.
