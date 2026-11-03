// Governor tests (split from test/kernel/governor.test.ts — pure move): W2.3 seed fold — reservation-era spend, A12b quarantine.

import { describe, expect, test } from 'vitest';
import { createGovernor } from '../../src/kernel/governor.js';
import type { Usage } from '../../src/driver/types.js';
import type { JournalEvent } from '../../src/kernel/types.js';

describe('W2.3 seed fold — reservation-era spend, A12b quarantine', () => {
  const STARTED = (runId: string, seq: number, capUsd?: number): JournalEvent => ({
    type: 'run-started',
    runId,
    at: '2026-01-01T00:00:00.000Z',
    planId: 'p',
    journalVersion: 2,
    seq,
    governance: { ...(capUsd !== undefined ? { capUsd } : {}), attended: false },
  });
  const JOB_STARTED = (runId: string, jobId: string, attempt: number): JournalEvent => ({
    type: 'job-started',
    runId,
    at: '2026-01-01T00:00:01.000Z',
    jobId,
    op: 'op',
    attempt,
  });
  const OPENED = (
    runId: string,
    jobId: string,
    attempt: number,
    reservationId: string,
    usd: number,
  ): JournalEvent => ({
    type: 'reservation-opened',
    runId,
    at: '2026-01-01T00:00:01.500Z',
    jobId,
    op: 'op',
    attempt,
    reservationId,
    usd,
    class: 'advisory',
  });
  const SETTLED = (
    runId: string,
    jobId: string,
    reservationId: string,
    charged: number,
    opts?: { priced?: boolean; usage?: Usage },
  ): JournalEvent => ({
    type: 'reservation-settled',
    runId,
    at: '2026-01-01T00:00:02.000Z',
    jobId,
    reservationId,
    charged,
    basis: 'observed',
    ...(opts?.priced !== undefined ? { priced: opts.priced } : {}),
    ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
  });

  test('reservation-era spend folds from settles (charges), not finish costUSD — no double-count', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0.3),
      {
        type: 'job-finished',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:03.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.3,
        charged: 0.3,
      },
    ]);
    // 0.3 once — the finish's restated costUSD is ignored for spend.
    expect(governor.usdSpent).toBe(0.3);
    expect(governor.quarantinedJobs.size).toBe(0);
    expect(governor.tripped).toBe(false);
  });

  test('a zero-priced lane (costUSD 0 OBSERVED) never trips the seed DD-9 — a settle without observed price does (r1 H2)', () => {
    const USAGE: Usage = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
    // The zero-priced/subscription lane: the dispatch observed a real
    // `costUSD: 0` (priced: true rides the settle), so `charged: 0` is a
    // LEGITIMATE zero price — the resumed run must dispatch, not hard-stop.
    const pricedFree = createGovernor({ maxUsd: 10 });
    pricedFree.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0, { priced: true, usage: USAGE }),
    ]);
    expect(pricedFree.usdSpent).toBe(0);
    expect(pricedFree.tripped).toBe(false); // W2.2's rule would not have tripped this either
    // The SAME fold with NO observed price (priced absent/falsy) is
    // unpriced spend: the seed trips `exhausted` BEFORE the resumed run
    // admits anything (DD-9, fail loud).
    const unpriced = createGovernor({ maxUsd: 10 });
    unpriced.seedFromJournal([
      STARTED('p--a--2', 1, 10),
      JOB_STARTED('p--a--2', 'j1', 1),
      OPENED('p--a--2', 'j1', 1, 'p--a--2:j1:1:1', 0.5),
      SETTLED('p--a--2', 'j1', 'p--a--2:j1:1:1', 0, { usage: USAGE }),
    ]);
    expect(unpriced.tripped).toBe(true);
    expect(unpriced.tripKind).toBe('exhausted');
  });

  test('A12b: an unresolved reservation charges IN FULL and quarantines the job', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      // The crash window: opened, never settled, no finish.
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.75),
    ]);
    expect(governor.usdSpent).toBe(0.75);
    expect([...governor.quarantinedJobs.keys()]).toEqual(['j1']);
    expect(governor.quarantinedJobs.get('j1')).toEqual({
      reservationId: 'p--a--1:j1:1:1',
      usd: 0.75,
    });
    expect(governor.events.some((event) => event.kind === 'quarantined')).toBe(true);
  });

  test('A12b: the full charge of an unresolved reservation can trip the seeded cap', () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 1.0),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 1.5),
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.usdSpent).toBe(1.5);
  });

  test('a W2.2-era run (no reservations) still seeds from job-finished costUSD', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      {
        type: 'job-finished',
        runId: 'p--a--0',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.4,
      },
    ]);
    expect(governor.usdSpent).toBe(0.4);
    expect(governor.quarantinedJobs.size).toBe(0);
  });

  test('mixed-era history: each run spends by its own era (W2.2 finish + W2.3 settles)', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      // Run 1: W2.2-era governed (costUSD on the finish).
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      {
        type: 'job-finished',
        runId: 'p--a--0',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.4,
      },
      // Run 2: reservation-era (settled charge; the finish restates it).
      STARTED('p--a--1', 2, 10),
      JOB_STARTED('p--a--1', 'j2', 1),
      OPENED('p--a--1', 'j2', 1, 'p--a--1:j2:1:1', 0.5),
      SETTLED('p--a--1', 'j2', 'p--a--1:j2:1:1', 0.2),
      {
        type: 'job-finished',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:05.000Z',
        jobId: 'j2',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 2 },
        costUSD: 0.2,
        charged: 0.2,
      },
    ]);
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.quarantinedJobs.size).toBe(0);
  });

  test('reservation-era corruption throws: a settle without an open, a finish over an unsettled reservation', () => {
    const orphanSettle = createGovernor({ maxUsd: 10 });
    expect(() =>
      orphanSettle.seedFromJournal([
        STARTED('p--a--1', 1, 10),
        SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0.3),
      ]),
    ).toThrow(/no matching reservation-opened/);
    const finishOverOpen = createGovernor({ maxUsd: 10 });
    expect(() =>
      finishOverOpen.seedFromJournal([
        STARTED('p--a--1', 1, 10),
        JOB_STARTED('p--a--1', 'j1', 1),
        OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
        {
          type: 'job-finished',
          runId: 'p--a--1',
          at: '2026-01-01T00:00:03.000Z',
          jobId: 'j1',
          opId: 'op',
          inputsHash: 'h',
          result: { status: 'ok', value: 1 },
        },
      ]),
    ).toThrow(/unsettled/);
  });

  test('a reservation-era settle with usage and zero charge is unpriced spend (DD-9 trips at seed)', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      {
        type: 'reservation-settled',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        reservationId: 'p--a--1:j1:1:1',
        charged: 0,
        basis: 'observed',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('attempt and dispatch seeds fold from job-started in BOTH eras', () => {
    const governor = createGovernor({ maxUsd: 10, runDispatchQuota: 5 });
    governor.seedFromJournal([
      // W2.2-era run: two starts of j1 and one of j2.
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      JOB_STARTED('p--a--0', 'j1', 2),
      JOB_STARTED('p--a--0', 'j2', 1),
      // Reservation-era run: one start of j1 (crashed, quarantined).
      STARTED('p--a--1', 2, 10),
      JOB_STARTED('p--a--1', 'j1', 3),
      OPENED('p--a--1', 'j1', 3, 'p--a--1:j1:3:1', 0.5),
    ]);
    expect(governor.attemptsFor('j1')).toBe(3);
    expect(governor.attemptsFor('j2')).toBe(1);
    expect(governor.dispatchCount).toBe(4);
  });
});
