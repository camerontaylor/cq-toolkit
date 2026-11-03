// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the
// injected-clock settle boundary and the postdate-the-last-commit qualifier
// (DOCTRINE §I2).
import { describe, expect, test } from 'vitest';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import {
  BEFORE_COMMIT,
  PENDING_MS,
  SETTLED_MS,
  approved,
  candidate,
  comment,
  settleCandidate,
} from './classifyPrs.helpers.js';

// ---------------------------------------------------------------------------
// The settle boundary (row 8) — injected nowMs decides, never a real clock
// ---------------------------------------------------------------------------

describe('classifyPr — the settle boundary is exact and nowMs-injected', () => {
  test('exactly AT the window is eligible (>=)', () => {
    expect(classifyPr(settleCandidate(), SETTLED_MS).reason).toBe('settle_window_elapsed');
  });

  test('one ms short is awaiting', () => {
    expect(classifyPr(settleCandidate(), PENDING_MS).reason).toBe('settle_window_pending');
  });

  test('same candidate, nowMs across the boundary: the clock alone flips the verdict', () => {
    const c = settleCandidate();
    expect(classifyPr(c, PENDING_MS).verdict).toBe('awaiting');
    expect(classifyPr(c, SETTLED_MS).verdict).toBe('eligible');
  });

  test('pure: same inputs → deep-equal output (no hidden state)', () => {
    const c = settleCandidate();
    expect(classifyPr(c, PENDING_MS)).toEqual(classifyPr(c, PENDING_MS));
  });
});

// ---------------------------------------------------------------------------
// The temporal qualifier (DOCTRINE §I2) — evidence must cover the LAST commit
// ---------------------------------------------------------------------------

describe('classifyPr — an acceptable review must postdate the last commit (DOCTRINE §I2)', () => {
  test('a pre-commit acceptable review does NOT satisfy row 6', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ submittedAt: BEFORE_COMMIT })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('pre-commit review + post-commit comment all-clear → STILL awaiting (no post-commit review evidence)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ submittedAt: BEFORE_COMMIT })],
        issueComments: [comment()],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('pre-commit review + settle fully elapsed → STILL awaiting (settle never cures stale evidence)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ submittedAt: BEFORE_COMMIT })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a review with a null or unparseable submittedAt never qualifies (fail toward awaiting)', () => {
    for (const submittedAt of [null, 'not-a-timestamp'] as Array<string | null>) {
      const result = classifyPr(candidate({ reviews: [approved({ submittedAt })] }), SETTLED_MS);
      expect(result.reason).toBe('no_acceptable_review');
    }
  });

  test('CONTROL: adding a post-commit review flips the same candidate to eligible (settle elapsed)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ submittedAt: BEFORE_COMMIT }), approved({ id: 'PRR_2' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('CONTROL: a post-commit all-clear review flips it to eligible via row 7', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({ submittedAt: BEFORE_COMMIT }),
          approved({ id: 'PRR_2', body: 'LGTM' }),
        ],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('explicit_all_clear');
  });
});
