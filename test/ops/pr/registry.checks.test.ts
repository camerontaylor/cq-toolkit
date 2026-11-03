// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the rollup and review-decision folds (checksOfRollup, reviewStateOfDecision).
import { describe, expect, test } from 'vitest';
import {
  checksOfRollup,
  reviewStateOfDecision,
} from '../../../src/adapters/forge-github/ghEffects.js';

// ---------------------------------------------------------------------------
// The real gh adapter's pure parsers — captured-shape fixtures
// ---------------------------------------------------------------------------

describe('checksOfRollup (gh pr view --json statusCheckRollup)', () => {
  test('an empty or absent rollup is `none`, not a fabricated pass', () => {
    expect(checksOfRollup([])).toEqual({ state: 'none' });
    expect(checksOfRollup(undefined)).toEqual({ state: 'none' });
  });

  test('all-green CheckRuns (COMPLETED + SUCCESS) fold to pass', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ]),
    ).toEqual({ state: 'pass' });
  });

  test('a failing CheckRun names every failed check', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      ]),
    ).toEqual({ state: 'fail', failing: ['test', 'lint'] });
  });

  test('a queued/in-progress CheckRun (null conclusion) keeps the PR pending', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toEqual({ state: 'pending' });
  });

  test('StatusContext shapes fold by state; EXPECTED is pending, FAILURE is fail', () => {
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'SUCCESS' }]),
    ).toEqual({ state: 'pass' });
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'FAILURE' }]),
    ).toEqual({ state: 'fail', failing: ['ci/travis'] });
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'EXPECTED' }]),
    ).toEqual({ state: 'pending' });
  });

  test('an unrecognized entry is pending — never a fabricated pass, never a fabricated fail', () => {
    expect(checksOfRollup([{ __typename: 'RequestCheckpoint', name: 'deploy' }])).toEqual({
      state: 'pending',
    });
    expect(checksOfRollup(['garbage'])).toEqual({ state: 'pending' });
  });

  test('fail wins over pending in a mixed rollup', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toEqual({ state: 'fail', failing: ['test'] });
  });
});

describe('reviewStateOfDecision (gh pr view --json reviewDecision)', () => {
  test('the real words and null map onto the seam vocabulary', () => {
    expect(reviewStateOfDecision('APPROVED')).toEqual({ state: 'approved' });
    expect(reviewStateOfDecision('CHANGES_REQUESTED')).toEqual({ state: 'changes-requested' });
    expect(reviewStateOfDecision(null)).toEqual({ state: 'none' });
  });

  test('REVIEW_REQUIRED is `required`, NOT `none` — the r1#1 flip (a demanded-but-absent review is never ready)', () => {
    expect(reviewStateOfDecision('REVIEW_REQUIRED')).toEqual({ state: 'required' });
  });

  test('an unrecognized word is unknown — never a fabricated verdict', () => {
    expect(reviewStateOfDecision('REQUIRED')).toEqual({ state: 'unknown' });
    expect(reviewStateOfDecision(undefined)).toEqual({ state: 'unknown' });
  });
});
