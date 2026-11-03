// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { classifyThreads } from '../../../src/ops/review/classifyThreads.js';
import { baseState, NOW } from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// Truncation propagation (fail closed before dispatching batches)
// ---------------------------------------------------------------------------

describe('truncation flag propagation', () => {
  test('truncated/truncatedBecause are copied VERBATIM (defensively cloned) from the fetched state', () => {
    const state = baseState({ truncated: true, truncatedBecause: ['reviewThreads.lag'] });
    const result = classifyThreads(state, NOW);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBecause).toEqual(['reviewThreads.lag']);
    // Verbatim content, but a defensive CLONE — mutating the copy cannot
    // corrupt the fetched state's own flag.
    expect(result.truncatedBecause).not.toBe(state.truncatedBecause);
    // The items themselves are unaffected — the flag is the consumer's
    // cue that they may be INCOMPLETE (fresh threads missing).
    expect(result.items).toEqual([]);
  });

  test('a clean fetch carries truncated=false and no reasons', () => {
    const result = classifyThreads(baseState(), NOW);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBecause).toEqual([]);
  });
});
