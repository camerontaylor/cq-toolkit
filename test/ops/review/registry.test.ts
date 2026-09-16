// E4 slice 1b — tests for the review family registry
// (src/ops/review/registry.ts): the SIX review-loop op entries, each with a
// strict registry-time input mirror and a lazy importer.
//
// Pinned here, for EVERY entry:
//   1. Name — the family carries exactly the six loop ops, each entry named
//   `<family>.<module base>` so the central completeness heuristic's
//   family-prefixed rule covers the module.
//   2. Schema accepts a minimal valid input for that op (the same JSON a
//   dispatcher would send).
//   3. Schema rejects an unknown key (strict throughout — a typo'd field
//   fails loudly, never silently stripped).
//   4. The importer resolves to a callable async op WITHOUT env, network,
//   or filesystem contact: the gh-consuming importers construct
//   makeGhRunner(), which is closure-only at construction (gh.ts reads
//   CQ_GH_BIN and spawns only when the returned runner is CALLED), and the
//   replyAndResolve importer constructs fileDispatchLog, which closes over
//   the path and does I/O only on load/record — awaiting the importer is
//   therefore the inertness proof.
//   Plus: the three PURE adapters actually execute over minimal inputs and
//   fold to honest ok values (classify/plan round-trip, verify's exact
//   "NO PROGRESS" literal); the gh-consuming and fixItem adapters are
//   resolved but never CALLED — calling one would spawn the real gh CLI or
//   driver, which unit tests must not do.
//
// Hermetic by construction: no network, no spawned processes, no writes.
import { describe, expect, test } from 'vitest';
import { makeGhRunner } from '../../../src/ops/review/gh.js';
import { registry } from '../../../src/ops/review/registry.js';

/** The op result shape the adapters fold to (loose, for assertions). */
interface LooseResult {
  status: string;
  value?: unknown;
  error?: string;
}

/** The six loop entries, in registry order. */
const ENTRY_NAMES = [
  'review.fixItem',
  'review.fetchReviewState',
  'review.classifyThreads',
  'review.planReviewBatch',
  'review.replyAndResolve',
  'review.verifyReviewOutcome',
];

/** Look up one entry by name, failing the test when absent. */
const entryByName = (name: string) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`missing registry entry '${name}'`);
  }
  return entry;
};

/** Resolve an entry's importer and call the op, loosely typed for asserts. */
const call = async (name: string, input: unknown): Promise<LooseResult> => {
  const op = (await entryByName(name).importer()) as (i: unknown) => Promise<LooseResult>;
  return op(input);
};

// ---------------------------------------------------------------------------
// Minimal valid inputs — one per entry (the JSON a dispatcher would send)
// ---------------------------------------------------------------------------

/** A minimal FetchedReviewState: full shape, empty collections. */
const fetchedState = (): Record<string, unknown> => ({
  repo: { owner: 'octocat', name: 'hello-world' },
  pr: 1,
  authorLogin: null,
  headRefName: null,
  headRefOid: null,
  threads: [],
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
});

/** A minimal PrSnapshot: full shape, empty collections. */
const snapshot = (): Record<string, unknown> => ({
  at: 1,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  reviewComments: [],
  issueComments: [],
  resolvedThreadIds: [],
});

/** One minimal valid input per entry (kept loose — mutation tests widen it). */
const minimalInputs: Record<string, () => Record<string, unknown>> = {
  'review.fixItem': () => ({
    pr: 1,
    item: { id: 'T1', path: null, line: null, body: 'fix me', comments: [] },
    worktree: { path: '/tmp/cq-fix-review/pr-1', branch: 'cq-review/pr-1' },
    driver: { model: 'm', provider: 'p' },
  }),
  'review.fetchReviewState': () => ({ owner: 'octocat', repo: 'hello-world', pr: 1 }),
  'review.classifyThreads': () => ({ state: fetchedState(), nowMs: 0 }),
  'review.planReviewBatch': () => ({
    classification: { items: [], truncated: false, truncatedBecause: [] },
  }),
  'review.replyAndResolve': () => ({
    owner: 'octocat',
    repo: 'hello-world',
    pr: 1,
    actions: [],
    nowMs: 1,
    dispatchLogPath: '/tmp/cq-registry-test/dispatch.jsonl',
  }),
  'review.verifyReviewOutcome': () => ({
    before: snapshot(),
    after: snapshot(),
    responderLogin: null,
  }),
};

/** The minimal input fixture for one entry, failing loud when the name is unknown. */
const minimalInput = (name: string): Record<string, unknown> => {
  const make = minimalInputs[name];
  if (make === undefined) {
    throw new Error(`no minimal input fixture for '${name}'`);
  }
  return make();
};

// ---------------------------------------------------------------------------
// Per-entry contract: name, accept, reject, resolve
// ---------------------------------------------------------------------------

describe('review family registry entries', () => {
  test('the family carries exactly the six loop entries', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([...ENTRY_NAMES].sort());
  });

  test.each(ENTRY_NAMES)('%s: inputSchema accepts a minimal valid input', (name) => {
    const entry = entryByName(name);
    expect(entry.inputSchema.safeParse(minimalInput(name)).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: inputSchema rejects an unknown key', (name) => {
    const entry = entryByName(name);
    const input = { ...minimalInput(name), extra: 1 };
    expect(entry.inputSchema.safeParse(input).success).toBe(false);
  });

  test('the classifyThreads mirror rejects an unknown key INSIDE the state too', () => {
    const entry = entryByName('review.classifyThreads');
    const state = fetchedState();
    state['surprise'] = true;
    const input = { state, nowMs: 0 };
    expect(entry.inputSchema.safeParse(input).success).toBe(false);
  });

  test('review.fixItem: an EMPTY item body is accepted (a deleted root comment fetches as body "")', () => {
    // Round-trip honesty: fetchReviewState maps a thread whose root comment
    // was deleted to body '' — such a real item must stay dispatchable
    // through the JSON boundary.
    const entry = entryByName('review.fixItem');
    const input = minimalInput('review.fixItem');
    (input as { item: { body: string } }).item.body = '';
    expect(entry.inputSchema.safeParse(input).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: importer resolves to a callable async op', async (name) => {
    const op = await entryByName(name).importer();
    expect(typeof op).toBe('function');
    expect((op as unknown as { constructor: { name: string } }).constructor.name).toContain(
      'AsyncFunction',
    );
  });

  test('makeGhRunner construction is inert — a closure only, no spawn/env at build time', () => {
    // gh.ts:72-83 — makeGhRunner returns the seam closure; the binary
    // resolution (CQ_GH_BIN) and the spawn happen when the closure is
    // CALLED, so the gh-consuming importers may construct it at importer
    // time without env or network contact (the import tests above are the
    // behavioral proof; this pins the construction surface directly).
    expect(typeof makeGhRunner()).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// The pure adapters execute (no I/O — safe to call)
// ---------------------------------------------------------------------------

describe('pure review adapters execute over minimal inputs', () => {
  test('review.classifyThreads over an empty state → the identity classification', async () => {
    const result = await call('review.classifyThreads', minimalInput('review.classifyThreads'));
    expect(result.status).toBe('ok');
    expect(result.value).toEqual({ items: [], truncated: false, truncatedBecause: [] });
  });

  test('review.planReviewBatch over an empty classification → no batches', async () => {
    const result = await call('review.planReviewBatch', minimalInput('review.planReviewBatch'));
    expect(result.status).toBe('ok');
    expect(result.value).toEqual([]);
  });

  test('a truncated classification → failed, naming the truncation causes', async () => {
    const input = {
      classification: {
        items: [],
        truncated: true,
        truncatedBecause: ['reviewThreads.lag'],
      },
    };
    const result = await call('review.planReviewBatch', input);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('reviewThreads.lag');
  });

  test('review.verifyReviewOutcome with identical snapshots → the exact NO PROGRESS literal', async () => {
    const result = await call(
      'review.verifyReviewOutcome',
      minimalInput('review.verifyReviewOutcome'),
    );
    expect(result.status).toBe('ok');
    expect(result.value).toEqual({ progress: false, reasons: [], summary: 'NO PROGRESS' });
  });

  test('classifyThreads with a non-compiling skip pattern → failed (config, not a verdict)', async () => {
    const input = {
      state: fetchedState(),
      nowMs: 0,
      config: {
        skipPatterns: [{ pattern: '([unclosed' }],
        responderIs: 'pr-author',
        treatNullCreatedAtAs: 'nowMs',
        blockOnOutdatedThreads: true,
        skipResponderAuthoredThreads: true,
        skipDismissedReviews: true,
        skipApprovalReviews: true,
      },
    };
    const result = await call('review.classifyThreads', input);
    expect(result.status).toBe('failed');
  });
});
