# Per-fix verification in cq-toolkit

The root `cq.json` verifies each review.address fix with typecheck, format,
typed Oxlint and bounded related tests. The lint gate mirrors check:static's
Oxlint config and options, including type-aware rules and unused-disable
errors. Its related command scopes to code files; non-code fixes use the full
configured lint scope. An unrecognized or incomplete lint report is indeterminate.

The test gate uses `scripts/check-related-tests.mjs`, which maps each explicit
changed file to existing `test/<source-stem>*.test.ts` siblings, includes touched
test files, and unions the existing reviewed `NON_IMPORT_MAP`, including the
shared adapter owner suite `test/ops/gates/adapters.test.ts`. This deliberately
bounded mapping does not claim the complete import closure or full-suite coverage;
the final dev.check and CI still cover broader impact. No mapping is a passing
advisory stored in the FailureSet. Named selections have no file-count cap.

All execution goes through `pnpm test:narrow`: the memory preflight, optional systemd scope, nice priority,
class gates and full-suite refusal rules remain authoritative. The launcher requests
an opt-in machine report with `CQ_TEST_NARROW_REPORT=1`. The adapter accepts only
a single terminal wrapper pass/fail result and a matching report whose assertion
statuses and counts agree. The no-map advisory requires the exact zero-file,
no-count, no-failure tuple. Refused, interrupted, error, missing and contradictory
evidence are indeterminate. Lint and Vitest failure identities survive baseline
comparison; pre-existing failures in the finding file are not attributed to the
candidate.

review.address edits one finding file per fix. It expands that file into the
test gate's relatedArgs at baseline and both candidate checkpoints, including
the broader-check phase. The configured test command without explicit files
refuses rather than guessing from a clean detached checkout's empty diff. The
config marks this check `addressOnly: true`: analyze.run and analyze.fix's
before/recheck, dev.check and fix.run exclude it because they cannot supply that
scope. Analysis and dev.check refuse a configuration with no repository checks
remaining. Sweep accepts explicit check commands, not the root config list; a
caller wanting bounded tests must supply explicit files via relatedArgs.

The format, typed-lint and bounded-test adapters are verification-only: fix.run
excludes them as sources. They do not implement fix.run's static clustering or
its related-test discovery contract; they still gate review.address candidates.

Issue #767 was reproduced at PR #681 head `4dc7d5c9` in a fresh local clone
with a detached baseline worktree. The baseline runs
`node scripts/check-related-tests.mjs src/ops/review/address.ts` from that
worktree root, inheriting the check runner environment. At that revision the
related mapping selected 22 files and threw before spawning pnpm:
`related test selection exceeds cap 10: 22 files`. Observed child exit was 2,
signal null, stderr empty, stdout the single terminal refused line. Thus
`INIT_CWD` and `CQ_TEST_NARROW_REPORT` (set only for the pnpm child) played no
part in this refusal. The historical bulk capture is unavailable; this is a
reproduction, not a recovered raw exit. The two-file standalone test bypassed
this selection. Commit `c9e3f364` already removed the cap on main.

Configured baseline check refusals retain `checkDiagnostics` in their typed
preconditions: child exit code, termination signal, and the last 4096 characters
of each output stream. The full streams are secret-scanned before slicing;
positive, incomplete or unavailable scans withhold both tails. Output uses a
synthetic `check-output.txt` path for content scanning;
protected-file path rules do not apply. Labels distinguish secret matches from
scanner failure or unavailability. Only retained baseline diagnostics are scanned,
with a one-second cap shortened by the remaining operation budgets and
cancellation. No environment values are recorded.
