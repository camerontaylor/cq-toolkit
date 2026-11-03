// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { baseState, itemsOf, thread } from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// config.responderIs is real (exhaustive switch in the table)
// ---------------------------------------------------------------------------

describe('config.responderIs', () => {
  test("'pr-author' (the only value) selects state.authorLogin as the responder", () => {
    expect(
      itemsOf(baseState({ threads: [thread({ id: 'TRI1', authorLogin: 'pr-author' })] })),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TRI1',
        verdict: 'skip',
        path: 'src/a.ts',
        reason: 'responder_authored',
      },
    ]);
  });
});
