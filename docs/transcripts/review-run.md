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
cycle `c001-<head8>`, the agent terminal cycle `c002-<head8>`, and the seeded
major finding `c002-<head8>#f1` (`src/a.ts:1`, rule `fixture`). The fixture
asserts each id against its actual commit prefix. The partial findings remain
available while the incomplete configured reviewer set remains a human stop.

## Large-diff hermetic request seam (#438)

`test/ops/review/agentReviewer-partitions.test.ts` uses the real `AiSdkDriver`
with `ai/test` mock models, real temporary session persistence and the actual
pre-request upload gate. It first submits the original 474,651-character
(527,381 UTF-8-byte) component in one invocation. The unchanged harness refuses
it before any mock provider call. The bounded path then covers the identical
component in 28 validated partition calls, with 140 deliberately scripted
tokens of total usage. Reconstruction from the non-overlapping ranges equals
the original text, including surrogate pairs. No provider, credentials or
network are used; scripted usage is not a live cost estimate.

The largest operation prompt is 19,993 characters, including instructions,
identity, receipt and repeated context. The driver's composed system prompt
fits the unchanged 20,000-character system limit. The largest complete serialized
request is 43,308 characters: the supported driver repeats the task in a user
message, so whole-wire size is a separate measurement, not the system cap unit.
Every actual send scans that full envelope and its decoded leaves.

A boundary control places paired evidence on opposite sides of the first
partition boundary. Only the next partition sees both pieces through its
explicitly repeated context, and its finding retains the original file and
added-line number. Missing/replayed/malformed receipts, scanner hits, incomplete
or duplicate scan verdicts, scanner faults, cancellation, timeout and shared
token exhaustion prevent terminal completion. Completed findings remain in
partial evidence. Forged coverage gaps, overlaps, missing ranges and duplicate
receipts fail validation. Separate operation tests preserve all-configured-source
completion and block a source that changes during review.

This demonstrates bounded, complete content coverage and honest failure behavior.
It does not execute live review, a reducer, global cross-file analysis or the
whole slice acceptance workflow. Partitioning limits the context available to
each reviewer call; complete coverage does not guarantee semantic completeness.
