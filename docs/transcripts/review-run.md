# `cq review.run` fixture transcript

This is captured output from a fresh temporary git repository on `feature/x`,
with a local bare `origin/merge-queue`, a v2 `cq.json`, and one tracked source
change. The production CLI dispatcher and `makeReviewRun` ran against real git,
ledger, log, and findings persistence effects. A temporary registry injected a
scripted read-only agent driver and a clean scanner; the fixture's `coderabbit`
command stub returned exit 1 with `not authenticated`. No provider, network, or
credential was used.

Command input was `review.run --repoRoot=<temporary repo> --json`. Captured
stdout:

```json
{
  "status": "ok",
  "value": {
    "schemaVersion": 1,
    "branch": "feature/x",
    "head": "1f37721da6811c6cc90b5875cc09ba1b411279d0",
    "sources": [
      {
        "kind": "coderabbit",
        "status": "blocked",
        "reason": "dev.review: review cycle c001-1f37721d was BLOCKED (reviewer CLI exited 1 (non-zero — no review completed)) — the cycle is recorded with 0 finding(s); log: /home/ctaylor/.tmp/cq-dev-review/feature_x-217d2bf51f16e9dc-1792806161058.log"
      },
      {
        "kind": "agent",
        "status": "terminal",
        "cycleId": "c002-1f37721d"
      }
    ],
    "findings": [
      {
        "id": "c002-1f37721d#f1",
        "source": "agent",
        "file": "src/a.ts",
        "line": 1,
        "rule": "fixture",
        "severity": "major",
        "text": "Seeded fixture finding",
        "status": "open"
      }
    ]
  }
}
```

Observed CLI exit code: `0`. The harness then read the persisted file
`.cq/review/feature%2Fx/1.json`; it contained one finding and source statuses
`coderabbit:blocked, agent:terminal`.
