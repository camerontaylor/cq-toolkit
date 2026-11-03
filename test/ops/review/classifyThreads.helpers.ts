// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; the shared fixtures and
// helpers live here.
import { classifyThreads } from '../../../src/ops/review/classifyThreads.js';
import type { ClassifiedItem } from '../../../src/ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import type { RestComment, ReviewSummary, ReviewThread } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** The injected clock: 2026-06-01T00:00:00Z. */
export const NOW = Date.parse('2026-06-01T00:00:00Z');
const T0 = '2026-01-01T00:00:00Z';
export const T1 = '2026-02-01T00:00:00Z';
export const T2 = '2026-03-01T00:00:00Z';
export const T3 = '2026-04-01T00:00:00Z';

/** A minimal FetchedReviewState: responder is 'pr-author', all else empty. */
export const baseState = (extra?: Partial<FetchedReviewState>): FetchedReviewState => ({
  repo: { owner: 'octo', name: 'repo' },
  pr: 7,
  authorLogin: 'pr-author',
  headRefName: 'feature',
  headRefOid: 'abc123',
  threads: [],
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
  ...extra,
});

/** An unresolved, fresh, external-reviewer thread, overridable per field. */
export const thread = (extra?: Partial<ReviewThread>): ReviewThread => ({
  id: 'PRRT_1',
  rootDatabaseId: 100,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'reviewer',
  createdAt: T0,
  body: 'Please fix this',
  replies: [],
  ...extra,
});

/** A standalone review summary, overridable per field. */
export const review = (extra?: Partial<ReviewSummary>): ReviewSummary => ({
  id: 'PRR_1',
  authorLogin: 'reviewer',
  state: 'COMMENTED',
  body: 'Please adjust the approach',
  submittedAt: T1,
  ...extra,
});

/** A REST comment (review or issue collection), overridable per field. */
export const restComment = (extra?: Partial<RestComment>): RestComment => ({
  id: 500,
  nodeId: 'PRRC_500',
  authorLogin: 'maintainer',
  body: 'A conversation comment',
  createdAt: T1,
  inReplyToId: null,
  ...extra,
});

/** The replies array literal type threads carry. */
export const said = (author: string | null, at: string | null, body = 'a reply') => ({
  authorLogin: author,
  body,
  createdAt: at,
});

/** Items-only view of the classify result — the assertion workhorse. The
 * truncation flag is asserted separately (see the truncation describe). */
export const itemsOf = (
  state: FetchedReviewState,
  nowMs: number = NOW,
  config?: ClassifyConfigOf,
): ClassifiedItem[] => classifyThreads(state, nowMs, config).items;

/** Keep the config type import-free at the call sites. */
type ClassifyConfigOf = Parameters<typeof classifyThreads>[2];
