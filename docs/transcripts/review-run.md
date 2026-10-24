# `cq review.run` fixture transcript

Fixture: a fresh throwaway git repository on `feature/x`, based on a local
`origin/merge-queue`, with a v2 `cq.json` declaring both `coderabbit` and
`agent`, a scripted reviewer role, and a run token budget. The agent driver
returns one seeded `major` finding at `src/a.ts:1`; its invocation is
asserted read-only and structured in `test/ops/review/run.test.ts`.

```json
{
  "schemaVersion": 1,
  "branch": "feature/x",
  "head": "<fixture head>",
  "sources": [
    { "kind": "coderabbit", "status": "blocked", "reason": "not authenticated" },
    { "kind": "agent", "status": "terminal", "cycleId": "<recorded cycle>" }
  ],
  "findings": [
    {
      "id": "<recorded cycle>#f1",
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
```

This transcript is driven entirely by scripted effects and a fake driver; it
does not contact providers or invoke an authenticated CodeRabbit session.
