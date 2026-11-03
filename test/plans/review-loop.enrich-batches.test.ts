// enrichBatches unit coverage (CodeRabbit cycle 1): abandonment inside a
// shared batch when an item vanishes between planning and enrichment.
import { describe, expect, test } from 'vitest';
import type { ClassifiedItem } from '../../src/ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../../src/adapters/forge-github/fetchReviewState.js';
import type { PlannedBatch } from '../../src/ops/review/planReviewBatch.js';
import type { ReviewThread } from '../../src/ops/review/threads.js';
import { enrichBatches } from '../../src/plans/review-loop.js';
import { iso, ROOT_AGE } from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// CodeRabbit cycle 1 — enrichment abandonment inside a shared batch
// ---------------------------------------------------------------------------

/** A minimal fetched thread for the enrichment unit fixtures. */
const enrichThread = (id: string, rootDatabaseId: number): ReviewThread => ({
  id,
  rootDatabaseId,
  path: 'src/a.ts',
  line: 3,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'reviewer',
  createdAt: iso(ROOT_AGE),
  body: `Fix src/a.ts (${id}).`,
  replies: [],
});

/** A clean fetched state over the given threads. */
const enrichmentState = (threads: ReviewThread[]): FetchedReviewState => ({
  repo: { owner: 'octo', name: 'widget' },
  pr: 7,
  authorLogin: 'prauthor',
  headRefName: 'pr-7-fix',
  headRefOid: 'sha',
  threads,
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
});

const plannedThread = (id: string): ClassifiedItem => ({
  kind: 'thread',
  id,
  verdict: 'actionable',
  path: 'src/a.ts',
  reason: 'thread_needs_response',
});

describe('enrichBatches batch abandonment (CodeRabbit cycle 1)', () => {
  test('a vanished item keeps its row, unprocessed siblings are batch-abandoned, correlated siblings keep their jobs', () => {
    const state = enrichmentState([enrichThread('T-sib', 101), enrichThread('T-tail', 103)]);
    // Shared batch: the correlated sibling first, then a GHOST (the race —
    // its id no longer correlates), then an unprocessed tail item.
    const batch: PlannedBatch = {
      mode: 'shared',
      worktreeHint: 'shared-pr-worktree',
      items: [plannedThread('T-sib'), plannedThread('T-ghost'), plannedThread('T-tail')],
    };
    const { items, skipped } = enrichBatches([batch], state);
    expect(skipped).toEqual([
      { id: 'T-ghost', reason: 'item-vanished' },
      { id: 'T-tail', reason: 'batch-abandoned-item-vanished' },
    ]);
    // Only the already-correlated sibling gets a fix job.
    expect(items.map((entry) => entry.source.itemId)).toEqual(['T-sib']);
    expect(items[0]?.source.threadRootRestId).toBe(101);
    expect(items[0]?.item.body).toBe('Fix src/a.ts (T-sib).');
  });

  test('isolated mode is a no-op: a vanished 1:1 batch yields exactly the item-vanished row and no jobs', () => {
    const state = enrichmentState([]);
    const batch: PlannedBatch = {
      mode: 'isolated',
      worktreeHint: null,
      items: [plannedThread('T-ghost')],
    };
    const { items, skipped } = enrichBatches([batch], state);
    expect(skipped).toEqual([{ id: 'T-ghost', reason: 'item-vanished' }]);
    expect(items).toEqual([]);
  });
});
