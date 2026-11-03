// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.selection.test.ts,
// addressManyPlan.admissionStop.test.ts, addressManyPlan.coverage.test.ts,
// addressManyPlan.attribution.test.ts and addressManyPlan.outcomes.test.ts.
import { describe, expect, test } from 'vitest';
import {
  admitAddressMany,
  initialAddressManyBudget,
  settleAddressMany,
} from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  expectCleanBound,
  held,
  request,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// admission
// ---------------------------------------------------------------------------

describe('admission allocation bound', () => {
  test('admits exactly to the cap and refuses one token over without mutating state', () => {
    let state = initialAddressManyBudget({ limitTokens: 1000, observedTokens: 100 });
    const first = admitAddressMany(state, request('a', 400));
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    state = first.state;
    expectCleanBound(state);

    const boundary = admitAddressMany(state, request('b', 500, { number: 8, headOid: HEAD_B }));
    expect(boundary.kind).toBe('admitted');
    if (boundary.kind !== 'admitted') return;
    state = boundary.state;
    expectCleanBound(state);
    expect(held(state).reduce((sum, entry) => sum + entry.tokens, 0)).toBe(900);

    const over = admitAddressMany(state, request('c', 1, { number: 9, headOid: HEAD_C }));
    expect(over.kind).toBe('refused');
    if (over.kind !== 'refused') return;
    expect(over.reason).toBe('over-limit');
    expect(over.state).toBe(state);
  });

  test('refuses invalid reservation facts and keeps the ledger untouched', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const invalid = [
      request('', 10),
      request('a', 0),
      request('a', -5),
      request('a', 1.5),
      request('a', Number.MAX_SAFE_INTEGER + 2),
      request('a', 10, { repo: 'noslash' }),
      request('a', 10, { number: 0 }),
      request('a', 10, { headOid: 'short' }),
    ];
    for (const entry of invalid) {
      const admission = admitAddressMany(state, entry);
      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') continue;
      expect(admission.reason).toBe('invalid');
      expect(admission.state).toBe(state);
    }
  });

  test('refuses a second id for an identity already held, and a re-used id', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const admitted = admitAddressMany(state, request('a', 100));
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    for (const duplicate of [
      request('b', 100),
      request('a', 100, { number: 8, headOid: HEAD_B }),
    ]) {
      const refusal = admitAddressMany(admitted.state, duplicate);
      expect(refusal.kind).toBe('refused');
      if (refusal.kind !== 'refused') continue;
      expect(refusal.reason).toBe('duplicate');
      expect(refusal.state).toBe(admitted.state);
    }

    // A changed head is a distinct identity at the ledger; the aggregate is what
    // refuses to attribute work to a head that is not the admitted one.
    const changedHead = admitAddressMany(admitted.state, request('c', 100, { headOid: HEAD_B }));
    expect(changedHead.kind).toBe('admitted');
  });

  test('settles known usage once and leaves no hold', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const admitted = admitAddressMany(state, request('a', 300));
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    const settlement = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 120 },
    });
    expect(settlement.kind).toBe('settled');
    if (settlement.kind !== 'settled') return;
    expect(settlement.tokens).toBe(120);
    expect(settlement.overrun).toBe(false);
    expect(settlement.state.observedTokens).toBe(120);
    expect(settlement.state.outstanding).toEqual([]);
    expect(settlement.state.settledIds).toEqual(['a']);
    expectCleanBound(settlement.state);

    const again = settleAddressMany(settlement.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 120 },
    });
    expect(again.kind).toBe('refused');
    if (again.kind !== 'refused') return;
    expect(again.reason).toBe('already-settled');
    expect(again.state).toBe(settlement.state);
  });

  test('refuses a settlement at another head or for an unheld id without mutating state', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 100),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    const mismatched = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_B,
      usage: { kind: 'known', tokens: 10 },
    });
    expect(mismatched.kind).toBe('refused');
    if (mismatched.kind !== 'refused') return;
    expect(mismatched.reason).toBe('identity-mismatch');
    expect(mismatched.state).toBe(admitted.state);

    const unknownId = settleAddressMany(admitted.state, {
      id: 'ghost',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(unknownId.kind).toBe('refused');
    if (unknownId.kind !== 'refused') return;
    expect(unknownId.reason).toBe('unknown-reservation');
    expect(unknownId.state).toBe(admitted.state);
  });
});
