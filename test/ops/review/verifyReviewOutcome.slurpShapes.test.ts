// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Split provenance: THE SLURP-SHAPE DEFENSIVENESS case moved verbatim from
// test/ops/review/verifyReviewOutcome.test.ts; the shared fixtures live in
// `verifyReviewOutcome.helpers.ts`.
//
// Pinned here:
//   6. THE SLURP-SHAPE DEFENSIVENESS: a `[[page1],[page2]]` payload and an
//      already-flat `[...]` payload yield the SAME id sets (real gh
//      variants differ — neither shape may fail).
import { describe, expect, test } from 'vitest';
import { snapshotPrState } from '../../../src/adapters/forge-github/snapshotPrState.js';
import { snapshotOpts } from './verifyReviewOutcome.helpers.js';

// ---------------------------------------------------------------------------
// 6. THE SLURP-SHAPE DEFENSIVENESS
// ---------------------------------------------------------------------------

describe('REST slurp shape-defensiveness', () => {
  test('an array-of-pages payload and an already-flat payload yield the SAME id sets', async () => {
    const reviewComments = [{ id: 9001 }, { id: 9002 }, { id: 9003 }];
    const issueComments = [{ id: 5001 }, { id: 5002 }];
    const threads = [{ id: 'PRRT_1', isResolved: true }];
    // Shape A: --slurp (gh >= 2.51) — ONE outer array of page arrays.
    const paginated = await snapshotPrState(
      snapshotOpts({
        headSha: 'abc123',
        pullsComments: [[reviewComments[0]], [reviewComments[1], reviewComments[2]]],
        issuesComments: [[issueComments[0]], [issueComments[1]]],
        threads,
      }),
    );
    // Shape B: pages merged FLAT (an older gh / no-slurp merge).
    const flat = await snapshotPrState(
      snapshotOpts({
        headSha: 'abc123',
        pullsComments: reviewComments,
        issuesComments: issueComments,
        threads,
      }),
    );
    // Neither shape fails, and both read as the same snapshot.
    expect(paginated.reviewComments.map((entry) => entry.id)).toEqual([9001, 9002, 9003]);
    expect(paginated.issueComments.map((entry) => entry.id)).toEqual([5001, 5002]);
    expect(flat).toEqual(paginated);
    // An EMPTY payload reads as an empty collection under either reading.
    const empty = await snapshotPrState(
      snapshotOpts({ headSha: 'abc123', pullsComments: [], issuesComments: [], threads }),
    );
    expect(empty.reviewComments).toEqual([]);
    expect(empty.issueComments).toEqual([]);
  });
});
