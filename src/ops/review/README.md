# Review addressing

`review.address` fixes or records a disposition for local findings or PR
threads, then re-runs review until clean or the configured round cap. Run
`review.run` first for a local findings record, or provide `--record`.

```sh
cq review.address --repoRoot=. --source=local --maxTokens=20000 --wallMs=1200000
cq review.address --repoRoot=. --source=pr:123 --maxTokens=20000 --wallMs=1200000 --push
```

`cq.json` supplies checks, worker/rescue/reviewer roles, review rounds,
blocking severities, address concurrency (default two), escalation and
budgets. The run token budget has no default. `--base` accepts an immutable
commit SHA for repositories without a fetched target branch. Publication is
opt-in; without `--push`, local commits remain available and PR mutations
are withheld. Explicit parent cancellation stops publication; a local
budget stop can still publish earlier verified commits.

Workers share one checkout but edit only their assigned literal file.
Missing scope and overlapping files are refused or serialized. Workers
cannot stage, commit or run commands. The engine serializes each candidate
over the latest verified parent in a detached checkout. Related checks,
mandatory read-only feedback, broader regression checks, protected-path and
tamper checks, commit-message checks and reviewer closure all inspect that
candidate. The final commit must match its gated tree and parent. A
sibling's uncommitted bytes cannot supply check or closure evidence.
Rejected/deferred code citations are verified at the worker's observed
execution head, even when a sibling commits later.

The engine uses the shared escalation allocator: configured worker
attempts, then bounded rescue, then human. An affirmative broader
regression routes directly to rescue. Human escalation preserves successful
sibling commits. Failed owned edits are restored after evidence is pinned
under a unique `refs/cq/review-address/` ref; the shared stash ref is unused.
Unknown edits and unexpected index or HEAD changes fail closed.

Every provider request is scanned before sending, including decoded tool
output and read-path provenance. Gitleaks defaults always apply; an
explicit `review.denylistPatternsFile` adds repository rules. Missing or
failed scanners refuse uploads.

Dispositions use `dev.disposition`. Deferred blocking findings remain open,
including when later reviewers omit them. A fresh open finding cannot be
silenced by an earlier fixed disposition. Exit 0 requires complete review
sources and no open blocking findings; round, budget, environment and
human stops return exit 3 with a report. Invalid CLI input returns the I1
input error. The full report is written to the journal directory on every
op exit, with usage, attempts, model identities, reasons, gates, evidence,
open findings and distinct verified commit count (`fixesPerRun`). Unknown
USD prices remain absent.

PR replies and thread resolution use the current authenticated identity,
fresh head/round proof and verified publication. A journal receipt without
the fetched authenticated reply cannot authorize a carry-forward resolve.
Unchanged rejections can post evidence but never resolve a thread. Once
clean, resolved thread authors are re-requested once. Forge failures retain
the report and return needs-human.
