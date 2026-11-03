// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the dispatch-wall accounting case moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { attemptEvents, headerWriter, slowHandler } from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 the event wall is the dispatch row wall, not the pre-dispatch scan', async () => {
    // The prompt scan runs BEFORE the row exists and is not part of the
    // dispatch budget. A slow scan must not be charged to the event or to
    // budget.remaining.wallMs (which would understate what is left).
    const journal = await headerWriter();
    let scans = 0;
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      runPrefix: 'cq-address/test',
      scanner: async (components) => {
        scans++;
        if (scans === 1) await new Promise((resolve) => setTimeout(resolve, 120));
        return components.map((component) => ({ component: component.component, hits: [] }));
      },
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('fixed');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(2);
      const rows = f.attempts.filter((row) => row.tier !== 'reviewer');
      expect(rows).toHaveLength(2);
      events.forEach((event, index) => {
        const row = rows[index];
        if (row === undefined) throw new Error('missing dispatch row');
        // Same wall as the AddressAttempt row, exactly as T13 records it.
        expect(event.payload.wallMs).toBe(row.wallMs);
        expect(event.payload.budget.spent.wallMs).toBe(row.wallMs);
        expect(event.payload.budget.remaining.wallMs).toBe(
          (event.payload.budget.allowed.wallMs ?? 0) - row.wallMs,
        );
      });
      // The 120 ms prompt scan is excluded: the dispatch itself stays far below.
      expect(events[0]?.payload.wallMs ?? 1000).toBeLessThan(100);
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });
});
