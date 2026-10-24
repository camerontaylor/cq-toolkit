# `cq review.run` fixture transcript

This is the captured result for a fresh temporary git repository on
`feature/x`, with a local bare `origin/merge-queue`, a v2 `cq.json`, and one
tracked source change. The production CLI dispatcher and `makeReviewRun` ran
against real git, ledger, log, and findings persistence effects. A temporary
registry injected a scripted read-only agent driver and a clean scanner; the
fixture's `coderabbit` command stub returned exit 1 with `not authenticated`.
No provider, network, or credential was used.

Command input was `review.run --repoRoot=<temporary repo> --json`. Captured
stdout after enforcing the configured-source completion rule:

```json
{
  "status": "needs-human",
  "reason": "review.run: not every configured reviewer completed a terminal cycle; the findings record, including partial findings, was persisted"
}
```

The CLI exit code for this result is `3` (`needs-human`). The harness then
read `.cq/review/feature%2Fx/1.json`. It retained the CodeRabbit blocked
cycle `c001-1f37721d`, the agent terminal cycle `c002-1f37721d`, and the
seeded major finding `c002-1f37721d#f1` (`src/a.ts:1`, rule `fixture`). The
partial findings remain available while the incomplete configured reviewer
set remains a human stop.
