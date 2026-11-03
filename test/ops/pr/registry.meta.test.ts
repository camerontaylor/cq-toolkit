// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the pr-view metadata folds (metaOf, mergeStateStatusOf, readinessSnapshotOf,
// bodyOf).
import { describe, expect, test } from 'vitest';
import {
  bodyOf,
  mergeStateStatusOf,
  metaOf,
  readinessSnapshotOf,
} from '../../../src/adapters/forge-github/ghEffects.js';

// ---------------------------------------------------------------------------
// The real gh adapter's pure parsers — captured-shape fixtures
// ---------------------------------------------------------------------------

describe('metaOf (gh pr view --json isDraft,state,mergeable,mergeStateStatus)', () => {
  test('the literal words map onto the seam vocabulary', () => {
    expect(
      metaOf({
        isDraft: true,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    ).toEqual({
      isDraft: true,
      state: 'open',
      mergeable: 'mergeable',
      mergeStateStatus: 'clean',
    });
    expect(
      metaOf({
        isDraft: false,
        state: 'MERGED',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'BEHIND',
      }),
    ).toEqual({
      isDraft: false,
      state: 'merged',
      mergeable: 'conflicting',
      mergeStateStatus: 'behind',
    });
  });

  test('FAILS CLOSED on an unreadable isDraft (r2#3): a corrupt draft flag must never read as not-a-draft', () => {
    expect(() => metaOf({ isDraft: undefined, state: 'OPEN' })).toThrow(/unreadable isDraft/);
    expect(() => metaOf({ isDraft: 'maybe', state: 'OPEN' })).toThrow(/unreadable isDraft/);
    expect(() => metaOf({ state: 'OPEN' })).toThrow(/unreadable isDraft/);
  });

  test('an unrecognized lifecycle or mergeability word maps to unknown (r3 jMJpD)', () => {
    expect(metaOf({ isDraft: false, state: 'WHAT', mergeable: 'HUH' })).toEqual({
      isDraft: false,
      state: 'unknown',
      mergeable: 'unknown',
      mergeStateStatus: 'unknown',
    });
    expect(metaOf({ isDraft: false })).toEqual({
      isDraft: false,
      state: 'unknown',
      mergeable: 'unknown',
      mergeStateStatus: 'unknown',
    });
  });

  test('mergeStateStatus: DIRTY folds to blocked; UNSTABLE/DRAFT/UNKNOWN stay unknown-tolerant (final jNTyP)', () => {
    expect(metaOf({ isDraft: false, mergeStateStatus: 'DIRTY' }).mergeStateStatus).toBe('blocked');
    expect(metaOf({ isDraft: false, mergeStateStatus: 'BLOCKED' }).mergeStateStatus).toBe(
      'blocked',
    );
    expect(metaOf({ isDraft: false, mergeStateStatus: 'UNSTABLE' }).mergeStateStatus).toBe(
      'unknown',
    );
    expect(metaOf({ isDraft: false, mergeStateStatus: 'DRAFT' }).mergeStateStatus).toBe('unknown');
    expect(metaOf({ isDraft: false, mergeStateStatus: 'UNKNOWN' }).mergeStateStatus).toBe(
      'unknown',
    );
  });
});

describe('mergeStateStatusOf (final jNTyP — the conservative merge-state mapping)', () => {
  test('CLEAN/BLOCKED/BEHIND map to their states; DIRTY is a conflicts verdict (blocked)', () => {
    expect(mergeStateStatusOf('CLEAN')).toBe('clean');
    expect(mergeStateStatusOf('BLOCKED')).toBe('blocked');
    expect(mergeStateStatusOf('BEHIND')).toBe('behind');
    expect(mergeStateStatusOf('DIRTY')).toBe('blocked');
  });

  test('everything the other halves already cover, plus the unreadable, stays unknown-tolerant', () => {
    expect(mergeStateStatusOf('UNSTABLE')).toBe('unknown');
    expect(mergeStateStatusOf('DRAFT')).toBe('unknown');
    expect(mergeStateStatusOf('UNKNOWN')).toBe('unknown');
    expect(mergeStateStatusOf('HAS_HOOKS')).toBe('unknown');
    expect(mergeStateStatusOf(undefined)).toBe('unknown');
    expect(mergeStateStatusOf('SURE')).toBe('unknown');
  });
});

describe('readinessSnapshotOf (the ONE consolidated gh pr view document, final jNTyS)', () => {
  test('one payload folds into the coherent three-half snapshot', () => {
    const payload = {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      reviewDecision: 'APPROVED',
      isDraft: false,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    };
    expect(readinessSnapshotOf(payload)).toEqual({
      checks: { state: 'pass' },
      review: { state: 'approved' },
      meta: {
        isDraft: false,
        state: 'open',
        mergeable: 'mergeable',
        mergeStateStatus: 'clean',
      },
    });
  });

  test('an unreadable isDraft faults the WHOLE snapshot (fail-closed, no half-stale evidence)', () => {
    expect(() =>
      readinessSnapshotOf({
        statusCheckRollup: [],
        reviewDecision: 'APPROVED',
        state: 'OPEN',
      }),
    ).toThrow(/unreadable isDraft/);
  });
});

describe('bodyOf (gh pr view --json body)', () => {
  test('a string body passes; a null or missing body is the empty string', () => {
    expect(bodyOf({ body: 'hello' })).toBe('hello');
    expect(bodyOf({ body: null })).toBe('');
    expect(bodyOf({})).toBe('');
  });

  test('a non-string non-null body is untrustworthy (thrown)', () => {
    expect(() => bodyOf({ body: 42 })).toThrow(/non-string body/);
  });
});
