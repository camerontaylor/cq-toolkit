# Per-fix verification in cq-toolkit

The root `cq.json` verifies each review.address fix with typecheck, format,
typed Oxlint and bounded related tests. The lint gate mirrors check:static's
Oxlint config and options, including type-aware rules and unused-disable
errors. Its related command scopes to code files; non-code fixes use the full
configured lint scope. An unrecognized or incomplete lint report is indeterminate.

The test gate uses `scripts/check-related-tests.mjs`, which maps each explicit
changed file to existing `test/<source-stem>*.test.ts` siblings, includes touched
test files, and unions the existing reviewed `NON_IMPORT_MAP`. This deliberately
bounded mapping does not claim the complete import closure or full-suite coverage;
the final dev.check and CI still cover broader impact. No mapping is a passing
advisory stored in the FailureSet; more than the wrapper's ten-file cap is a
refusal, never a truncated selection.

All execution goes through `pnpm test:narrow`: the host lock, nice priority,
class gates, cap and refusal rules remain authoritative. The launcher requests
an opt-in machine report with `CQ_TEST_NARROW_REPORT=1`. The adapter accepts only
a matching report and terminal wrapper pass/fail result. Refused, interrupted,
error, missing and contradictory evidence are indeterminate. Individual Vitest
failure identities survive baseline comparison; a pre-existing failed test is
not attributed to the candidate.

review.address edits one finding file per fix. It expands that file into the
test gate's relatedArgs at baseline and both candidate checkpoints, including
the broader-check phase. The configured test command without explicit files
refuses rather than guessing from a clean detached checkout's empty diff. Other
callers must supply explicit changed files via the configured relatedArgs.

The format, typed-lint and bounded-test adapters are verification-only: fix.run
excludes them as sources. They do not implement fix.run's static clustering or
its related-test discovery contract; they still gate review.address candidates.
