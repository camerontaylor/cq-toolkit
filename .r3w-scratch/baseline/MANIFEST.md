# Pre-R3W production baseline manifest (R9 unchanged-production arm, audit A3)

Captured: 2026-10-27T19:55Z - 19:56Z (uranus, read-only `git show`; no build, no test,
no live run).

## Pinned production head

origin/merge-queue = e34586c0fc1d5467fe9e2cfa1d839a1197f775c9
("Merge pull request #540 from camerontaylor/fix/535-verify-lint-related-tests",
2026-10-28 06:18:35 +1100). Untouched: captured from the immutable queue ref object,
before any R3W integration commit exists.

## Provenance of this branch

R3W branch feat/r3w-evidence-preparation-20261028 starts at R3S
b5100a0621660aaac07213690d4e8a807ca0f4a9 ("style(review): format R3S anchor files",
feature parent, reviewed PR lane R3S). R3S merge-base with the queue pin is
1eea0b5b323de8b23a9388a72da4e97f8e631450. R3S adds only
src/ops/review/findings.ts evidenceV1 fields, new src/ops/review/internal/findingAnchors.ts
and tests; at the queue pin none of these symbols are reachable from registry/CLI entry
points (findingAnchors is imported by tests only), so production reviewer behavior at
e34586c0 is exactly what this manifest captured and R3W integration does not change it
until its writer handoff lands.

## Captured artifacts (SHA256 over captured file, sha256sum MANIFEST.sha256)

- reviewPlan.ts        - reviewer planner: session prompt builder, tiers, partition
  fallback trigger, ANCHOR_INSTRUCTION + FINDINGS_INSTRUCTION emission (the production
  reviewer prompt), PlannedReviewSession shape
- reviewSession.ts     - session producer: OutputSchema "review.agent/v3" (the production
  agent payload contract: file, line, rule, severity, text), tool policy
  (allowlist read/grep/glob vs none), maxTools 3, transient retry, scan hooks
- lineAnchors.ts       - head line anchor extraction (ANCHOR_INSTRUCTION text lives here
  at the pin)
- reviewPartitions.ts  - partitioned fallback rendering
- reviewCoverageV2.ts  - coverage v2 schema
- agentReviewer.ts     - engine: budget/wall/concurrency, outcome folding
- run.ts               - review.run op: reviewer wiring, severity map use, exits
- registry.ts          - review family registry (input schemas, CLI surface)
- findings.ts          - findings record v1 (no evidenceV1 at the queue pin)
- defaultFixPrompt.ts, fix.default.md - fixer prompt assets (unchanged by R3W prep)
- cq.json              - production routes: roles.reviewer = opencode-go /
  deepseek-v4.1-flash; review.reviewers = [coderabbit, agent]; budgets.run
  maxTokens 25000000 wallMs 14400000; budgets.step.wallMs 1200000
- cqConfigDefaults.ts  - REVIEW_SESSION_DEFAULTS maxInputChars 60000 maxSteps 15
  concurrency 4; REVIEW_SIZE_DEFAULTS; agentSeverityMap default high->major,
  medium->minor; review.searchTools default true
- dev-review.ts, dev-agentReview.ts - session/dev.review consumers of the same seams
- package.json + pnpm-lock-head.txt + deps-summary.json - toolchain and dependency pins
- oxfmtrc.json         - formatter config pin

## Integrity

Every artifact above was written by `git show <pin>:<path>` from the shared repo object
store; the pin ref itself was verified against the fetched merge-queue head before
capture. SHA256 of every captured file is recorded in MANIFEST.sha256 alongside the pin.
No file in the worktree or any production ref was modified to produce this manifest.

## R9 consumption note

This is the unchanged-production arm input for R9 (reviewer prompt/schema/tools/routes
comparison). R3W must not treat it as an integration input: it is evidence, frozen at
the pre-R3W production head. Integration awaits the explicit planner-writer handoff.
