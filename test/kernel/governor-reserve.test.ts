// Governor tests (split from test/kernel/governor.test.ts — pure move): W2.3 reserve-then-settle — the capacity gate, settle-side ledger, breach, cap inheritance.

import { describe, expect, test } from 'vitest';
import { BudgetGovernor, createGovernor } from '../../src/kernel/governor.js';

// ---------------------------------------------------------------------------
// W2.3 — reserve-then-settle (ADR-0003 §2.2/§2.3): the capacity gate, the
// settle-side ledger, breach, cap inheritance, and the reservation-aware
// seed (A12b's unresolved-reservation charge + quarantine).
// ---------------------------------------------------------------------------

describe('W2.3 reserve-then-settle', () => {
  test('reserve WAITS FIFO while outstanding exist and shrinks only when nothing is (ADR §2.2 step 3, r1 H1)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    expect(first.outcome).toBe('reserved');
    if (first.outcome !== 'reserved') return;
    expect(first.reservation.usd).toBe(0.25);
    expect(first.reservation.proposedUsd).toBeUndefined();
    expect(governor.outstandingUsd).toBe(0.25);
    // Outstanding 0.25 → capacity 0.75; a 1.0 proposal with O > 0 must WAIT
    // FIFO (ADR §2.2 step 3), not shrink: a bookkeeping shrink to 0.75
    // would undersize `r` against the proposal, and the dispatch's real
    // charge would then breach `charged > r` — aborting healthy in-flight
    // work for a bookkeeping artifact.
    let second: Awaited<ReturnType<BudgetGovernor['reserve']>> | undefined;
    const pending = governor.reserve('j2', 1, 1.0, 'advisory').then((r) => {
      second = r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(second).toBeUndefined();
    expect(governor.tripped).toBe(false);
    // Settling j1 at its full observed charge leaves O = 0: NOW the gate
    // shrinks (no settle can free capacity anymore) and grants the head at
    // `C − S = 0.75`, journalling the ask as proposedUsd. The invariant
    // S + O + r = 0.25 + 0.75 ≤ 1.0 holds, and a real charge of up to 0.75
    // can never breach.
    governor.observeCost('j1', 0.25);
    governor.settle(first.reservation, { basis: 'observed' });
    await pending;
    expect(second?.outcome).toBe('reserved');
    if (second?.outcome !== 'reserved') return;
    expect(second.reservation.usd).toBe(0.75);
    expect(second.reservation.proposedUsd).toBe(1.0);
    expect(governor.usdSpent).toBe(0.25);
    expect(governor.outstandingUsd).toBe(0.75);
  });

  test('a proposal within capacity grants in full; zero capacity with outstanding parks FIFO', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    // Capacity 0.75 covers the proposal: full grant, no shrink, no park.
    const second = await governor.reserve('j2', 1, 0.75, 'advisory');
    expect(second.outcome).toBe('reserved');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    expect(second.reservation.usd).toBe(0.75);
    expect(second.reservation.proposedUsd).toBeUndefined();
    expect(governor.outstandingUsd).toBe(1.0);
    // Capacity zero with an outstanding holder → the next reserve parks
    // FIFO; it does NOT trip and does not grant while capacity is zero.
    let third: Awaited<ReturnType<BudgetGovernor['reserve']>> | undefined;
    const pending = governor.reserve('j3', 1, 0.25, 'advisory').then((r) => {
      third = r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(third).toBeUndefined();
    expect(governor.tripped).toBe(false);
    // Folding 0.3 of observed evidence against the second reservation, then
    // settling it, frees capacity → the FIFO head is woken and reserves what
    // is left (its 0.25 proposal fits under the freed 0.3). The fold moves
    // the ledger; the settle's remainder is 0.
    governor.observeCost('j2', 0.3);
    governor.settle(second.reservation, { basis: 'observed' });
    await pending;
    expect(third?.outcome).toBe('reserved');
    expect(governor.usdSpent).toBe(0.3);
    expect(governor.outstandingUsd).toBe(0.5);
    // Settling the first reservation with its own observed evidence.
    governor.observeCost('j1', 0.1);
    governor.settle(first.reservation, { basis: 'observed' });
    expect(governor.usdSpent).toBeCloseTo(0.4);
    expect(governor.outstandingUsd).toBeCloseTo(0.25);
  });

  test('a second grant for a job that already holds an open reservation throws (r1 L2)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    // Unreachable from the runner (one dispatch per job per run; settle or
    // abandon deletes the openByJob entry before the job can be admitted
    // again) — if it ever fires, the state machine is corrupt and the throw
    // keeps the first reservation's fold attribution from being orphaned.
    await expect(governor.reserve('j1', 2, 0.1, 'advisory')).rejects.toThrow(
      /already holds an open reservation/,
    );
    // The first reservation is untouched by the refused overwrite.
    expect(governor.outstandingUsd).toBe(0.25);
  });

  test('settle carries the PRICE-PRESENCE fact: an observed costUSD — zero included — prices the dispatch (r1 H2)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    // No cost evidence ever observed on the channel: priced false — the
    // journal will fold this settle as unpriced if it settles zero with
    // usage.
    let settled = governor.settle(first.reservation, { basis: 'observed' });
    expect(settled.priced).toBe(false);
    expect(settled.charged).toBe(0);
    // A legitimate ZERO price is still price evidence: the folded 0 rides
    // observeCost, the settle journals `priced: true`, and the resume fold's
    // DD-9 check (`charged === 0 && usage > 0 && !priced`) leaves it alone.
    const second = await governor.reserve('j2', 1, 0.25, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j2', 0);
    settled = governor.settle(second.reservation, { basis: 'observed' });
    expect(settled.charged).toBe(0);
    expect(settled.priced).toBe(true);
    // The governor's own observation stream carries the same fact.
    const events = governor.events.filter((event) => event.kind === 'reservation-settled');
    expect(
      events.map((event) => (event.kind === 'reservation-settled' ? event.priced : null)),
    ).toEqual([false, true]);
  });

  test('a full-charge settle frees nothing and the FIFO head then trips exhausted — no waiter hangs', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const spent = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (spent.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j1', 0.5);
    governor.settle(spent.reservation, { basis: 'observed' });
    expect(governor.usdSpent).toBe(0.5);
    // 0.5 left: take it as an outstanding reservation.
    const held = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (held.outcome !== 'reserved') throw new Error('expected reservation');
    // Capacity 0 with an outstanding holder → a third dispatch parks.
    const parked = governor.reserve('j3', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Releasing the outstanding at FULL charge frees nothing (r − charged =
    // 0): the parked head must still be woken, re-evaluate, and — capacity
    // gone with nothing left outstanding — trip exhausted instead of
    // hanging forever.
    const settled = governor.settle(held.reservation, { basis: 'full' });
    expect(settled.charged).toBe(0.5);
    await expect(parked).resolves.toEqual({ outcome: 'tripped' });
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('FIFO holds: the head is granted first, a later waiter waits for a settle, and a newcomer never jumps the queue', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // Two outstanding reservations consume the cap; two dispatches park.
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const w1 = governor.reserve('w1', 1, 0.25, 'advisory');
    const w2 = governor.reserve('w2', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Settle j1 at FULL charge: frees nothing, so the head (w1) is never
    // even woken — grant-from-head means a waiter is woken only WITH its
    // grant or with a trip (the cycle-1 "wake and re-park" design is
    // gone).
    governor.settle(first.reservation, { basis: 'full' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.tripped).toBe(false);

    // Settle j2 UNDER its r: capacity frees. The head w1 is granted first
    // (0.25 fits the freed 0.3). w2 now faces capacity 0.05 with a 0.25
    // proposal and an outstanding holder — it WAITS FIFO for a settle (ADR
    // §2.2 step 3); it never shrinks below its proposal while O > 0.
    governor.observeCost('j2', 0.2);
    governor.settle(second.reservation, { basis: 'observed' });
    const w1r = await w1;
    if (w1r.outcome !== 'reserved') throw new Error('expected w1 reservation');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.events.filter((event) => event.kind === 'reserved').length).toBe(3); // w2 still parked
    // Settling w1 under its own r frees the rest of the cap → w2 is
    // granted, still in FIFO order.
    governor.observeCost('w1', 0.05);
    governor.settle(w1r.reservation, { basis: 'observed' });
    const w2r = await w2;
    if (w2r.outcome !== 'reserved') throw new Error('expected w2 reservation');
    const order = governor.events
      .filter((event) => event.kind === 'reserved')
      .map((event) => (event.kind === 'reserved' ? event.jobKey : ''));
    expect(order).toEqual(['j1', 'j2', 'w1', 'w2']);
  });

  test('a newcomer parks behind parked waiters and waits for a settle when capacity cannot cover its proposal (no queue jumping)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const w1 = governor.reserve('w1', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // j2 settles UNDER r: capacity frees and w1 (the head) is granted —
    // its continuation is now queued as a microtask. A NEWCOMER arriving
    // in this window must never take the room ahead of w1 (it cannot:
    // drainWaiters granted the head synchronously) and — its 0.1 proposal
    // exceeding the 0.05 left with O > 0 — must WAIT FIFO for a settle
    // rather than shrink (ADR §2.2 step 3).
    governor.observeCost('j2', 0.2);
    governor.settle(second.reservation, { basis: 'observed' });
    const w1r = await w1;
    if (w1r.outcome !== 'reserved') throw new Error('expected w1 reservation');
    const newcomer = governor.reserve('newcomer', 1, 0.1, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.events.filter((event) => event.kind === 'reserved').length).toBe(3); // the newcomer is still parked — no shrink-while-outstanding
    // Settling w1 under its r frees room; the newcomer is admitted IN
    // ORDER, behind the head that was granted first.
    governor.observeCost('w1', 0.05);
    governor.settle(w1r.reservation, { basis: 'observed' });
    await newcomer;
    const order = governor.events
      .filter((event) => event.kind === 'reserved')
      .map((event) => (event.kind === 'reserved' ? event.jobKey : ''));
    expect(order).toEqual(['j1', 'j2', 'w1', 'newcomer']);
  });

  test('abandonReservation releases the hold with no charge and no settle — capacity returns to waiters', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const parked = governor.reserve('w1', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The write-ahead journal write failed: abandon the grant, no charge.
    // The returned capacity is granted to the FIFO head SYNCHRONOUSLY
    // inside the abandon (grant-from-head — no microtask window).
    governor.abandonReservation(second.reservation);
    expect(governor.usdSpent).toBe(0);
    expect(governor.outstandingUsd).toBe(0.75); // j1 0.5 + w1's fresh 0.25 grant
    // The parked waiter got the returned capacity.
    await parked;
    const last = governor.events.at(-1);
    expect(last).toMatchObject({ kind: 'reserved', jobKey: 'w1', usd: 0.25 });
    // Abandoning an unknown/settled reservation is a no-op.
    expect(() => governor.abandonReservation(second.reservation)).not.toThrow();
  });

  test('a zero cap admits nothing: the first reserve trips exhausted before any dispatch', async () => {
    const governor = createGovernor({ maxUsd: 0 });
    await expect(governor.reserve('j1', 1, 0, 'advisory')).resolves.toEqual({ outcome: 'tripped' });
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('charged over the reservation trips breach; the charge still lands in the ledger', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const open = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (open.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j1', 0.6);
    const settledRes = governor.settle(open.reservation, { basis: 'observed' });
    expect(settledRes.charged).toBe(0.6);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('breach');
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.events.at(-2)).toMatchObject({
      kind: 'reservation-settled',
      charged: 0.6,
      basis: 'observed',
    });
  });

  test('settle for an unknown reservation throws; a full-basis settle charges max(r, folded)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const fake = {
      id: 'j1:1:99',
      jobKey: 'j1',
      attempt: 1,
      usd: 0.5,
      class: 'advisory' as const,
    };
    expect(() => governor.settle(fake, { basis: 'observed' })).toThrow(/unknown reservation/);
    const open = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (open.outcome !== 'reserved') throw new Error('expected reservation');
    // The dispatch overshot its reservation before being killed: the full
    // basis charges the overshoot, not just r.
    governor.observeCost('j1', 0.4);
    const settled = governor.settle(open.reservation, { basis: 'full' });
    expect(settled.charged).toBe(0.4);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('breach');
    // Unknown status with NO evidence charges the full reservation r.
    const governor2 = createGovernor({ maxUsd: 1.0 });
    const open2 = await governor2.reserve('j9', 1, 0.5, 'advisory');
    if (open2.outcome !== 'reserved') throw new Error('expected reservation');
    const settled2 = governor2.settle(open2.reservation, { basis: 'full' });
    expect(settled2.charged).toBe(0.5);
    expect(governor2.usdSpent).toBe(0.5);
    expect(governor2.tripped).toBe(false);
  });

  test('reserve requires a cap — an uncapped run is reservation-less', async () => {
    const governor = createGovernor({});
    await expect(governor.reserve('j1', 1, 0.5, 'advisory')).rejects.toThrow(/requires a USD cap/);
  });

  test('a tripped governor refuses reserve immediately (no new reservations on a trip)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.trip('token-cap', 'test trip');
    await expect(governor.reserve('j1', 1, 0.5, 'advisory')).resolves.toEqual({
      outcome: 'tripped',
    });
  });

  test('inheritCapUsd gives a capless governor the predecessor cap and never overrides an explicit one', () => {
    const capless = createGovernor({});
    expect(capless.capUsd).toBeUndefined();
    expect(capless.inheritCapUsd(5)).toBe(true);
    expect(capless.capUsd).toBe(5);
    expect(capless.events.some((event) => event.kind === 'cap-inherited')).toBe(true);
    // The inherited cap binds reserve.
    expect(capless.outstandingUsd).toBe(0);
    // An explicit config cap is never overridden.
    const capped = createGovernor({ maxUsd: 2 });
    expect(capped.inheritCapUsd(5)).toBe(false);
    expect(capped.capUsd).toBe(2);
    // A re-inheritance of the same cap is idempotent.
    expect(capless.inheritCapUsd(5)).toBe(true);
  });

  test('the inherited cap binds the seeded-overrun trip: a capless resume over spend past C_prev trips', () => {
    const dir35 = null; // no journal needed — the seed API takes events
    void dir35;
    const governor = createGovernor({});
    governor.inheritCapUsd(1.0);
    governor.seedFromJournal([
      {
        type: 'run-started',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:00.000Z',
        planId: 'p',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 1.0, attended: false },
      },
      {
        type: 'job-started',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'op',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 1.5,
      },
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.usdSpent).toBe(1.5);
  });
});
