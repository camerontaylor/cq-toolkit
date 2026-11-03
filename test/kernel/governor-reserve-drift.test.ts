// Governor tests (split from test/kernel/governor.test.ts — pure move): W2.3 reserve-then-settle — the USD float drift section (USD_EPSILON verdicts).

import { describe, expect, test } from 'vitest';
import { BudgetGovernor, createGovernor } from '../../src/kernel/governor.js';

// ---------------------------------------------------------------------------
// W2.3 — reserve-then-settle (ADR-0003 §2.2/§2.3): the capacity gate, the
// settle-side ledger, breach, cap inheritance, and the reservation-aware
// seed (A12b's unresolved-reservation charge + quarantine).
// ---------------------------------------------------------------------------

describe('W2.3 reserve-then-settle', () => {
  // --- USD float drift (CodeRabbit Major, review 5337184110): every money
  // verdict in the reservation gate compares through USD_EPSILON, because
  // IEEE-754 accumulation drift must never buy an extra dispatch from
  // ~1e-16 of phantom capacity, park a dispatch on a dust shortfall, or
  // trip a spurious breach/cap verdict on dust. ---

  test('drift cannot buy an 11th dispatch: ten 0.1 reserve-fold-settle cycles against a 1.0 cap refuse the next reserve as exhausted', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    for (let i = 1; i <= 10; i++) {
      const r = await governor.reserve(`j${i}`, 1, 0.1, 'advisory');
      if (r.outcome !== 'reserved') throw new Error(`cycle ${i} refused: ${r.outcome}`);
      governor.observeCost(`j${i}`, 0.1);
      governor.settle(r.reservation, { basis: 'observed' });
    }
    // Ten 0.1 folds accumulate to 0.9999999999999999, NOT 1.0 — the cap is
    // spent to within ~1.1e-16. Under a raw `capacity <= 0` gate that dust
    // admitted an 11th dispatch with r ≈ 1.1e-16 (whose real charge would
    // then breach).
    expect(governor.usdSpent).toBe(0.9999999999999999);
    expect(governor.tripped).toBe(false);
    const eleventh = await governor.reserve('j11', 1, 0.1, 'advisory');
    expect(eleventh.outcome).toBe('tripped');
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.tripReason).toMatch(/reservation capacity exhausted/);
  });

  test('drift cannot buy a PARKED waiter either: drainWaiters refuses dust capacity and trips exhausted', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 1.0, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    let second: Awaited<ReturnType<BudgetGovernor['reserve']>> | undefined;
    const pending = governor.reserve('j2', 1, 0.5, 'advisory').then((r) => {
      second = r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(second).toBeUndefined(); // parked FIFO at exactly-zero capacity
    // Ten 0.1 folds into the open reservation drift to 0.9999999999999999;
    // the settle charges them (under r — no breach) and drainWaiters
    // recomputes capacity as 1.0 − 0.9999999999999999 ≈ 1.1e-16. That is
    // dust, not a grant: the head waiter is refused exhausted with the
    // nothing-outstanding trip, never woken with an r ≈ 1.1e-16 reservation.
    for (let i = 0; i < 10; i++) governor.observeCost('j1', 0.1);
    governor.settle(first.reservation, { basis: 'observed' });
    await pending;
    expect(second?.outcome).toBe('tripped');
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.tripReason).toMatch(/reservation capacity exhausted/);
  });

  test('a settle charging its exact reservation never breaches on fold dust', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const reserved = await governor.reserve('j1', 1, 0.3, 'advisory');
    if (reserved.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j1', 0.1);
    governor.observeCost('j1', 0.2); // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754
    const settled = governor.settle(reserved.reservation, { basis: 'observed' });
    expect(settled.charged).toBe(0.30000000000000004); // dust over the 0.3 reservation
    // A raw `charged > r` read that 4e-17 of drift as a real overshoot and
    // tripped breach — aborting a dispatch that charged exactly its ask.
    expect(governor.tripped).toBe(false);
    expect(governor.tripKind).toBeUndefined();
  });

  test('the inclusive cap holds at exact 1.0: fold dust does not trip the rollup, and admission still closes behind it', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // The folds' exact decimal values sum to 1.0; the accumulator lands at
    // 1.0000000000000002 (0.2 + 0.4 + 0.3 + 0.1 in this order). A raw
    // `spent > cap` tripped exhausted MID-FLIGHT on that dust — aborting a
    // run that never exceeded an inclusive cap.
    governor.observeCost('a', 0.2);
    governor.observeCost('b', 0.4);
    governor.observeCost('c', 0.3);
    governor.observeCost('d', 0.1);
    expect(governor.usdSpent).toBe(1.0000000000000002);
    expect(governor.tripped).toBe(false);
    // Admission still closes: the remaining −2.2e-16 is through the epsilon
    // a spent cap — the next reserve refuses exhausted instead of granting
    // phantom room.
    const next = await governor.reserve('next', 1, 0.1, 'advisory');
    expect(next.outcome).toBe('tripped');
    expect(governor.tripKind).toBe('exhausted');
  });

  test('a proposal within dust of capacity grants instead of parking, and its real charge does not breach', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.observeCost('a', 0.1);
    governor.observeCost('b', 0.2); // accumulated spent: 0.30000000000000004
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    // capacity = 1.0 − 0.30000000000000004 − 0.25 = 0.44999999999999996 —
    // dust UNDER the 0.45 proposal. A raw `proposedUsd > capacity` parked
    // the dispatch behind a settle that had no new room to bring; through
    // the epsilon it grants.
    const pending = governor.reserve('j2', 1, 0.45, 'advisory').then((r) => {
      if (r.outcome !== 'reserved') throw new Error('dust shortfall must not park');
      return r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
    ]);
    if (second?.outcome !== 'reserved') {
      throw new Error('expected j2 reservation — dust shortfall must not park');
    }
    expect(second.reservation.usd).toBe(0.44999999999999996); // shrunk by dust only
    // The dispatch's real 0.45 charge exceeds its dust-shrunk r by 4e-17 —
    // overshoot inside the epsilon is not a breach.
    governor.observeCost('j2', 0.45);
    governor.settle(second.reservation, { basis: 'observed' });
    expect(governor.tripped).toBe(false);
    expect(governor.tripKind).toBeUndefined();
    await pending;
  });
});
