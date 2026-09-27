// Per-lane budget classification (W2.3, ADR-0003 §2.4 / A12c): the table is
// DATA, the default is ADVISORY, and a HARD row without evidence is table
// corruption — HARD is demonstrated, never declared.
import { describe, expect, test } from 'vitest';
import {
  classifyDispatch,
  LANE_CLASSIFICATION,
  type LaneClassificationRow,
} from '../../src/kernel/lanes.js';

describe('classifyDispatch (ADR-0003 §2.4 lane classification)', () => {
  test('v1.1 ships NO hard rows: every key — and the lane-less default — is advisory', () => {
    expect(LANE_CLASSIFICATION).toEqual([]);
    expect(classifyDispatch()).toBe('advisory');
    expect(
      classifyDispatch({ lane: 'subprocess', provider: 'anthropic', model: 'claude-haiku-4-5' }),
    ).toBe('advisory');
  });

  test('a matching hard row wins over the advisory default; more-specific rows beat broader ones', () => {
    const table: LaneClassificationRow[] = [
      { lane: 'subprocess', class: 'hard', evidence: 'proxy-leg-2026-10' },
      {
        lane: 'subprocess',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        class: 'hard',
        evidence: 'proxy-leg-2026-10',
      },
      { lane: 'subprocess', provider: 'other', class: 'advisory' },
    ];
    expect(
      classifyDispatch(
        { lane: 'subprocess', provider: 'anthropic', model: 'claude-haiku-4-5' },
        table,
      ),
    ).toBe('hard');
    // The model row (specificity 3) beats the lane row (specificity 1).
    const demoted: LaneClassificationRow[] = [
      { lane: 'subprocess', class: 'hard', evidence: 'proxy-leg-2026-10' },
      { lane: 'subprocess', provider: 'anthropic', model: 'claude-haiku-4-5', class: 'advisory' },
    ];
    expect(
      classifyDispatch(
        { lane: 'subprocess', provider: 'anthropic', model: 'claude-haiku-4-5' },
        demoted,
      ),
    ).toBe('advisory');
    expect(classifyDispatch({ lane: 'subprocess', provider: 'other' }, table)).toBe('advisory');
    // An unlisted lane stays advisory.
    expect(classifyDispatch({ lane: 'ai-sdk', provider: 'anthropic' }, table)).toBe('advisory');
  });

  test('a hard row without evidence is table corruption — HARD is demonstrated, never declared', () => {
    const corrupt: LaneClassificationRow[] = [{ lane: 'subprocess', class: 'hard' }];
    expect(() => classifyDispatch({ lane: 'subprocess' }, corrupt)).toThrow(
      /corrupt classification table/,
    );
  });
});
