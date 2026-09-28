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

  test('a NON-EMPTY table with no dispatch key throws — a HARD row must never silently not bind (comp 3)', () => {
    // Every row's constraints are vacuously satisfied by an absent key, so
    // the winner is unresolvable: a future HARD row would be permanently
    // inert (dispatches refused as ADVISORY while the table promises HARD
    // enforcement) — that fails loud instead.
    const hardTable: LaneClassificationRow[] = [
      { lane: 'subprocess', class: 'hard', evidence: 'proxy-leg-2026-10' },
    ];
    expect(() => classifyDispatch(undefined, hardTable)).toThrow(/no dispatch key/);
    // Even a fully-unconstrained row cannot rescue the ambiguous state.
    expect(() =>
      classifyDispatch(undefined, [{ class: 'hard', evidence: 'proxy-leg-2026-10' }]),
    ).toThrow(/no dispatch key/);
    // An advisory-only table is just as inert for HARD purposes — same throw.
    expect(() => classifyDispatch(undefined, [{ lane: 'subprocess', class: 'advisory' }])).toThrow(
      /no dispatch key/,
    );
    // The shipped EMPTY table keeps the lane-less ADVISORY default.
    expect(classifyDispatch()).toBe('advisory');
  });
});
