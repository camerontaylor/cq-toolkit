// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Pinned here:
//   1. THE CONTRACT TEST: a hallucinated "done" — before === after (byte-
//      identical snapshots) — is progress FALSE with the exact literal
//      summary 'NO PROGRESS'. Inputs are frozen (the verifier is pure and
//      must not mutate its evidence).
//   2. Each signal fires ALONE and lands its own reason + summary:
//      new-commit, responder-reply (new review id), responder-reply (new
//      issue id), thread-resolved.
//   3. Multiple reasons → all present in order, summary lists every kind.
//   4. The STRICT head sha: snapshots carry a VERIFIED string headSha — a
//      PR payload without a usable head.sha THROWS (a headless snapshot
//      could never see new-commit movement); identical shas → nothing,
//      different shas → new-commit.
//   5. snapshotPrState against a routed fake GhFn: head.sha extracted,
//      both REST collections collected, resolved ids from GraphQL, `at` =
//      injected nowMs; the graphql call passes EXACTLY ONE `-f query=`
//      whose document declares no `$query` variable (the collision rule);
//      REST calls carry --paginate --slurp.
//   6. THE SLURP-SHAPE DEFENSIVENESS: a `[[page1],[page2]]` payload and an
//      already-flat `[...]` payload yield the SAME id sets (real gh
//      variants differ — neither shape may fail).
//   7. Untrustworthy fetches throw loudly (server-side GraphQL errors;
//      missing reviewThreads payload; non-array REST payload; MIXED page
//      payload `[[c1],"junk"]`; missing/non-string head sha; comment
//      entries without a numeric id; RESOLVED thread nodes without a
//      string id) — a throw can never be misread as NO PROGRESS.
//
// The gh seam is INJECTED (a fake GhFn routing on argv) — no spawned
// process, no network, no real clocks.
import { describe, expect, test } from 'vitest';
import { snapshotPrState, verifyPrOutcome } from '../../../src/ops/review/verifyReviewOutcome.js';
import type { PrSnapshot, SnapshotPrStateOpts } from '../../../src/ops/review/verifyReviewOutcome.js';
import type { GhFn, GhResult } from '../../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;
const COORDS = { owner: 'octo', repo: 'widget', pr: 7 } as const;

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** What the routed fake serves per endpoint. */
interface FakeGhFixture {
  /** undefined → a healthy default head; null → headless PR; number → a
   * non-string sha (the strict-payload fixtures). */
  headSha?: string | number | null;
  /** Raw JSON payloads for the two REST collections (either slurp shape). */
  pullsComments?: unknown;
  issuesComments?: unknown;
  /** GraphQL reviewThreads nodes (id/isResolved widened for bad fixtures). */
  threads?: Array<{ id: unknown; isResolved: unknown }>;
}

/** The recorded gh invocations, as compact labels. */
const labelsOf = (calls: string[][]): string[] =>
  calls.map((args) => {
    if (args.includes('graphql')) return 'graphql';
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.includes('/comments')) return path.includes('/issues/') ? 'issue-comments' : 'review-comments';
    return 'pr-object';
  });

/** Build an injected GhFn that routes on argv and records every argv. */
const fakeGh = (fixture: FakeGhFixture, calls?: string[][]): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    calls?.push(args);
    if (args.includes('graphql')) {
      return {
        code: 0,
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: fixture.threads ?? [] } } } },
        }),
        stderr: '',
      };
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.includes('/comments')) {
      const body = path.includes('/issues/') ? fixture.issuesComments : fixture.pullsComments;
      return { code: 0, stdout: JSON.stringify(body ?? []), stderr: '' };
    }
    const prBody =
      fixture.headSha === undefined
        ? { head: { sha: 'abc123' } }
        : fixture.headSha === null
          ? { head: null }
          : { head: { sha: fixture.headSha } };
    return { code: 0, stdout: JSON.stringify(prBody), stderr: '' };
  };

const snapshotOpts = (fixture: FakeGhFixture, calls?: string[][]): SnapshotPrStateOpts => ({
  ...COORDS,
  run: fakeGh(fixture, calls),
  nowMs: NOW,
});

/** A canonical before-snapshot the per-reason tests mutate one field at a time. */
const baseSnapshot = (overrides?: Partial<PrSnapshot>): PrSnapshot => ({
  at: NOW,
  headSha: 'abc123',
  reviewCommentIds: [9001],
  issueCommentIds: [5001],
  resolvedThreadIds: ['PRRT_old'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. THE CONTRACT TEST — hallucinated done
// ---------------------------------------------------------------------------

describe('the anti-hallucination contract', () => {
  test('identical snapshots (a hallucinated "done") → progress false, summary EXACTLY "NO PROGRESS"', () => {
    const before = Object.freeze({
      ...baseSnapshot(),
      reviewCommentIds: Object.freeze([9001]),
      issueCommentIds: Object.freeze([5001]),
      resolvedThreadIds: Object.freeze(['PRRT_old']),
    }) as PrSnapshot;
    const after = Object.freeze({
      ...baseSnapshot(),
      reviewCommentIds: Object.freeze([9001]),
      issueCommentIds: Object.freeze([5001]),
      resolvedThreadIds: Object.freeze(['PRRT_old']),
    }) as PrSnapshot;
    const outcome = verifyPrOutcome(before, after, { responderLogin: 'pr-author' });
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    // The workstream contract literal — greppable, machine-checkable.
    expect(outcome.summary).toBe('NO PROGRESS');
    // Purity: frozen inputs were only read, never mutated.
    expect(before.headSha).toBe('abc123');
    expect(after.headSha).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// 2–4. Each signal alone; multiple reasons; the null-sha rule
// ---------------------------------------------------------------------------

describe('progress signals', () => {
  test('head sha changed alone → new-commit reason, summary "PROGRESS: new-commit"', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot({ headSha: 'def456' }), {
      responderLogin: null,
    });
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toEqual([
      { kind: 'new-commit', detail: 'head sha moved "abc123" → "def456"' },
    ]);
    expect(outcome.summary).toBe('PROGRESS: new-commit');
  });

  test('a NEW review comment id alone → responder-reply reason, summary "PROGRESS: responder-reply"', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot({ reviewCommentIds: [9001, 9002] }), {
      responderLogin: 'pr-author',
    });
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]?.kind).toBe('responder-reply');
    // responderLogin is RECORDED in the detail (never used to filter).
    expect(outcome.reasons[0]?.detail).toContain('responder pr-author');
    expect(outcome.reasons[0]?.detail).toContain('9002');
    expect(outcome.summary).toBe('PROGRESS: responder-reply');
  });

  test('a NEW issue comment id alone → responder-reply reason, summary "PROGRESS: responder-reply"', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot({ issueCommentIds: [5001, 5002] }), {
      responderLogin: null,
    });
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]?.kind).toBe('responder-reply');
    expect(outcome.reasons[0]?.detail).toContain('5002');
    expect(outcome.summary).toBe('PROGRESS: responder-reply');
  });

  test('a NEW resolved thread id alone → thread-resolved reason, summary "PROGRESS: thread-resolved"', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({ resolvedThreadIds: ['PRRT_old', 'PRRT_new'] }),
      { responderLogin: null },
    );
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toEqual([
      { kind: 'thread-resolved', detail: 'newly resolved thread ids [PRRT_new]' },
    ]);
    expect(outcome.summary).toBe('PROGRESS: thread-resolved');
  });

  test('multiple reasons → ALL present in the fixed order, summary lists every kind', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({ headSha: 'def456', reviewCommentIds: [9001, 9002], issueCommentIds: [5001, 5002], resolvedThreadIds: ['PRRT_old', 'PRRT_new'] }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.reasons.map((reason) => reason.kind)).toEqual([
      'new-commit',
      'responder-reply',
      'thread-resolved',
    ]);
    expect(outcome.summary).toBe('PROGRESS: new-commit, responder-reply, thread-resolved');
  });

  test('identical head shas → no new-commit reason (the sha is a VERIFIED string; only a real difference moves)', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot(), { responderLogin: null });
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.summary).toBe('NO PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// 5. snapshotPrState against the routed fake
// ---------------------------------------------------------------------------

describe('snapshotPrState', () => {
  test('head sha, both REST collections, resolved ids, and the injected clock land in the snapshot', async () => {
    const calls: string[][] = [];
    const snapshot = await snapshotPrState(
      snapshotOpts(
        {
          headSha: 'abc123',
          pullsComments: [{ id: 9001 }, { id: 9002 }],
          issuesComments: [{ id: 5001 }],
          threads: [
            { id: 'PRRT_1', isResolved: true },
            { id: 'PRRT_2', isResolved: false },
            { id: 'PRRT_3', isResolved: true },
          ],
        },
        calls,
      ),
    );
    expect(snapshot).toEqual({
      at: NOW,
      headSha: 'abc123',
      reviewCommentIds: [9001, 9002],
      issueCommentIds: [5001],
      resolvedThreadIds: ['PRRT_1', 'PRRT_3'],
    });
    // The invocation plan: PR object → review comments → issue comments → graphql.
    expect(labelsOf(calls)).toEqual(['pr-object', 'review-comments', 'issue-comments', 'graphql']);
    // E1 lesson: both REST fetches ride --paginate --slurp.
    const reviewArgs = calls[1] ?? [];
    const issueArgs = calls[2] ?? [];
    expect(reviewArgs).toContain('--paginate');
    expect(reviewArgs).toContain('--slurp');
    expect(issueArgs).toContain('--paginate');
    expect(issueArgs).toContain('--slurp');
  });

  test('the graphql call passes EXACTLY ONE `-f query=` whose document declares NO `$query` variable (the collision rule)', async () => {
    const calls: string[][] = [];
    await snapshotPrState(snapshotOpts({ threads: [{ id: 'PRRT_1', isResolved: true }] }, calls));
    const graphqlArgs = calls.find((args) => args.includes('graphql')) ?? [];
    const querySlots = graphqlArgs.filter((a) => a.startsWith('query='));
    expect(querySlots).toHaveLength(1);
    const doc = flagValue(graphqlArgs, 'query');
    expect(doc).toContain('reviewThreads');
    expect(doc).toContain('isResolved');
    expect(doc).not.toMatch(/\$query\b/);
    expect(flagValue(graphqlArgs, 'owner')).toBe('octo');
    expect(flagValue(graphqlArgs, 'name')).toBe('widget');
    expect(flagValue(graphqlArgs, 'pr')).toBe('7');
    // Every flag value rides `-f` (pr rides `-F` for the Int! coercion).
    expect(graphqlArgs).toContain('-F');
    const queryIndex = graphqlArgs.indexOf(querySlots[0] ?? '');
    expect(graphqlArgs[queryIndex - 1]).toBe('-f');
  });
});

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
    expect(paginated.reviewCommentIds).toEqual([9001, 9002, 9003]);
    expect(paginated.issueCommentIds).toEqual([5001, 5002]);
    expect(flat).toEqual(paginated);
    // An EMPTY payload reads as an empty collection under either reading.
    const empty = await snapshotPrState(
      snapshotOpts({ headSha: 'abc123', pullsComments: [], issuesComments: [], threads }),
    );
    expect(empty.reviewCommentIds).toEqual([]);
    expect(empty.issueCommentIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Untrustworthy fetches throw (never silently "NO PROGRESS")
// ---------------------------------------------------------------------------

describe('untrustworthy fetches throw loudly', () => {
  test.each([
    [
      'server-side GraphQL errors',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            if (args.includes('graphql')) {
              return { code: 0, stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /GraphQL errors:/,
    ],
    [
      'missing reviewThreads payload',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            if (args.includes('graphql')) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: {} } } }), stderr: '' };
            return run(args);
          },
          nowMs: NOW,
        }),
      /no reviewThreads payload/,
    ],
    [
      'non-array REST payload',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/comments')) return { code: 0, stdout: JSON.stringify({ oops: true }), stderr: '' };
            return run(args);
          },
          nowMs: NOW,
        }),
      /non-array payload/,
    ],
    [
      'MIXED page payload (array pages alongside junk — flat() would silently drop the pages)',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify([[{ id: 9001 }], 'junk']), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /MIXED page payload/,
    ],
    [
      'a PR payload with NO head (a headless snapshot could never see new-commit movement)',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/pulls/') && !path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify({ head: null }), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /no usable head sha/,
    ],
    [
      'a PR payload with a NON-STRING head sha',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/pulls/') && !path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify({ head: { sha: 123 } }), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /no usable head sha/,
    ],
  ])('%s → snapshotPrState rejects', async (_label, runWith, pattern) => {
    const base = fakeGh({ headSha: 'abc123' });
    await expect(runWith(base)).rejects.toThrow(pattern);
  });

  test('a REST comment entry WITHOUT a numeric id throws (filtering would silently shrink the reply evidence)', async () => {
    await expect(
      snapshotPrState(
        snapshotOpts({
          headSha: 'abc123',
          pullsComments: [{ id: 9001 }, { id: 'not-a-number' }],
        }),
      ),
    ).rejects.toThrow(/comment entry without a numeric id/);
  });

  test('a RESOLVED reviewThread node WITHOUT a string id throws (a filtered id would hide a resolved thread)', async () => {
    await expect(
      snapshotPrState(
        snapshotOpts({
          headSha: 'abc123',
          threads: [
            { id: 'PRRT_1', isResolved: true },
            { id: 456, isResolved: true },
          ],
        }),
      ),
    ).rejects.toThrow(/RESOLVED reviewThread node without a string id/);
  });

  test('validation fails loud before any argv is built', async () => {
    const calls: string[][] = [];
    const run = fakeGh({ headSha: 'abc123' }, calls);
    await expect(snapshotPrState({ ...COORDS, owner: '../evil', run, nowMs: NOW })).rejects.toThrow(
      /snapshotPrState:/,
    );
    await expect(snapshotPrState({ ...COORDS, pr: 0, run, nowMs: NOW })).rejects.toThrow(/snapshotPrState:/);
    expect(calls).toEqual([]);
  });
});
