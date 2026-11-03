// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.selection.test.ts,
// addressManyPlan.admission.test.ts, addressManyPlan.coverage.test.ts,
// addressManyPlan.attribution.test.ts and addressManyPlan.outcomes.test.ts.
import { describe, expect, test } from 'vitest';
import {
  admitAddressMany,
  initialAddressManyBudget,
  settleAddressMany,
  type AddressManyBudgetState,
} from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  expectCleanBound,
  request,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// admission
// ---------------------------------------------------------------------------

describe('admission allocation bound', () => {
  test('holds an unknown-usage allocation, stops admission once, and lets siblings settle', () => {
    const first = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 300),
    );
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    const second = admitAddressMany(first.state, request('b', 200, { number: 8, headOid: HEAD_B }));
    expect(second.kind).toBe('admitted');
    if (second.kind !== 'admitted') return;

    const unknown = settleAddressMany(second.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(unknown.kind).toBe('unknown-usage');
    if (unknown.kind !== 'unknown-usage') return;
    // The allocation stays visibly held, at full size, and is never refunded.
    expect(unknown.state.outstanding).toHaveLength(2);
    expect(unknown.state.outstanding.find((entry) => entry.id === 'a')).toMatchObject({
      tokens: 300,
      state: 'unresolved',
    });
    expect(unknown.state.observedTokens).toBe(0);
    expect(unknown.state.stop).toBe('unknown-usage');
    expect(unknown.state.settledIds).toEqual([]);

    const blocked = admitAddressMany(
      unknown.state,
      request('c', 1, { number: 9, headOid: HEAD_C }),
    );
    expect(blocked.kind).toBe('refused');
    if (blocked.kind !== 'refused') return;
    expect(blocked.reason).toBe('stopped');

    const sibling = settleAddressMany(unknown.state, {
      id: 'b',
      repo: REPO,
      number: 8,
      headOid: HEAD_B,
      usage: { kind: 'known', tokens: 100 },
    });
    expect(sibling.kind).toBe('settled');
    if (sibling.kind !== 'settled') return;
    expect(sibling.state.observedTokens).toBe(100);
    expect(sibling.state.outstanding.map((entry) => entry.id)).toEqual(['a']);
    expect(sibling.state.stop).toBe('unknown-usage');

    const repeated = settleAddressMany(sibling.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(repeated.kind).toBe('refused');
    if (repeated.kind !== 'refused') return;
    expect(repeated.reason).toBe('already-settled');
    expect(repeated.state).toBe(sibling.state);
  });

  test('accepts a known zero-usage settlement without stopping admission', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 300),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const settled = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 0 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.state.observedTokens).toBe(0);
    expect(settled.state.stop).toBeNull();
    expectCleanBound(settled.state);
    expect(admitAddressMany(settled.state, request('b', 1000)).kind).toBe('admitted');
  });

  test('stops admission when actual usage exceeds the reservation allocation', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 100),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const settled = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 150 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.overrun).toBe(true);
    expect(settled.state.observedTokens).toBe(150);
    expect(settled.state.stop).toBe('overrun');
    const blocked = admitAddressMany(
      settled.state,
      request('b', 1, { number: 8, headOid: HEAD_B }),
    );
    expect(blocked.kind).toBe('refused');
    if (blocked.kind !== 'refused') return;
    expect(blocked.reason).toBe('stopped');
  });

  test('stops admission when a hand-built ledger overruns the total cap', () => {
    // Arm two of the overrun rule: the caller handed in a state whose observed
    // count is inconsistent with its hold, so the cap check (not the
    // reservation check) is the one that fires.
    const handBuilt: AddressManyBudgetState = {
      limitTokens: 1000,
      observedTokens: 600,
      outstanding: [
        { id: 'a', repo: REPO, number: 7, headOid: HEAD_A, tokens: 500, state: 'reserved' },
      ],
      settledIds: [],
      stop: null,
    };
    const settled = settleAddressMany(handBuilt, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 500 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.overrun).toBe(true);
    expect(settled.state.observedTokens).toBe(1100);
    expect(settled.state.stop).toBe('overrun');
  });

  test('records a factual initial breach as a stop instead of claiming the bound', () => {
    const state = initialAddressManyBudget({ limitTokens: 100, observedTokens: 150 });
    expect(state.stop).toBe('overrun');
    expect(state.observedTokens + 0).toBeGreaterThan(state.limitTokens);
    const admission = admitAddressMany(state, request('a', 1));
    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.reason).toBe('stopped');
    expect(admission.state).toBe(state);
  });

  test('rejects malformed ledger inputs as programmer errors', () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      expect(() => initialAddressManyBudget({ limitTokens: limit })).toThrow(/limitTokens/);
    expect(() => initialAddressManyBudget({ limitTokens: 10, observedTokens: -1 })).toThrow(
      /observedTokens/,
    );
  });
});
