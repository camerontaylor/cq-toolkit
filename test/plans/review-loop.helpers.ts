// E4 slice 2 — tests for the review-loop plan wiring
// (src/plans/review-loop.ts; ws-e item 8).
//
// Pinned here:
//   1. HAPPY PATH: one actionable thread → the fix driver commits → the
//      worktree push publishes it → the after-snapshot sees the new commit →
//      reply + resolve post → outcome ok (fixReport came from the governed
//      runPlan: counts.done === 1). VERIFY BEFORE ANY POST is asserted from
//      the fake gh's call log: no mutation argv precedes the AFTER-snapshot
//      argv. Every git push argv is exactly the composed worktree form
//      ['-C', <worktree>, 'push', 'origin', 'HEAD:<branch>'] — the prWorktree
//      argv pattern (leading -C, since the runner spawns with the process
//      cwd).
//   2. ENRICHMENT: the fix job's input.item carries the thread's body, path,
//      line, and prior comments reconstructed from the fetched state (REST
//      reply chains included).
//   3. NO PROGRESS: the driver claims a fix but the fake world never moves
//      (identical snapshots) → needs-human naming NO PROGRESS; the resolve
//      is withheld (a claimed fix without observable movement never hides
//      its thread); the reply still posts (the worker's account is reported
//      honestly for the human to judge).
//   4. PARTIAL FAILURE: a malformed worker answer → that fix row failed →
//      needs-human, while the other thread still gets its reply + resolve
//      (stopOnError false).
//   5. EXIT CODE: the needs-human outcome maps to exit 3 through the CLI
//      mapper (the "via the CLI" claim, tested at the mapper seam).
//   6. RE-RUN NO-OP: the actionable thread now carries the responder's reply
//      → classify says responded → zero batches, zero fix jobs, zero gh
//      mutations, outcome ok, and NO 'NO PROGRESS' anywhere (verify never
//      ran — a no-op must not manufacture a verdict).
//   7. REGISTRY: listPlans() discovers 'review-loop'; its importer resolves
//      to the valid empty instance; PlanSchema.parse accepts it.
//
// Hermetic by construction: the gh and git seams are routed fakes recording
// every argv (no network, no spawned processes, no real clocks); the fix
// workers run through the REAL makeFixReviewItem op over a scripted Driver;
// the only filesystem writes are the test's own mkdtemp scratch dirs.
//
// The suite was split into per-subject files (review-loop.<subject>.test.ts)
// so review tooling can see below the 256 KiB single-file cap; this module
// carries the shared fixtures, fakes, runner and settle-gate helpers all of
// them import.
//
// Split provenance: this helper module was itself split by subject into
// review-loop.argv.ts, review-loop.assertions.ts, review-loop.contracts.ts,
// review-loop.fixtures.ts, review-loop.gh-fake.ts, review-loop.git-fake.ts,
// review-loop.runner.ts and review-loop.settle-fixtures.ts. It stays as the
// barrel every test module imports, so the import surface is unchanged.
export * from './review-loop.argv.js';
export * from './review-loop.assertions.js';
export * from './review-loop.contracts.js';
export * from './review-loop.fixtures.js';
export * from './review-loop.gh-fake.js';
export * from './review-loop.git-fake.js';
export * from './review-loop.runner.js';
export * from './review-loop.settle-fixtures.js';
