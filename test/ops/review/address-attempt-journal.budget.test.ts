// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the three budget cases moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
//   - budget:  a token cap reached by a complete result names the cap; a
//     driver throw past the wallClockMs deadline is the wall cap with timeout
//     evidence; a worker 'budget' stop with no named cap keeps the raw code.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  attemptEvents,
  headerWriter,
  noRescue,
  slowHandler,
} from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 budget: token cap after a complete result names the cap', async () => {
    const journal = await headerWriter();
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      maxTokens: 3,
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no token-cap event');
      // The worker completed, but the exhausted token landing gate keeps the
      // budget variant and names the tripped cap.
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('token-cap');
      expect(event.payload.stopReason).toContain('token budget exhausted');
      expect(event.payload.budget.allowed.tokens).toBe(3);
      expect(event.payload.budget.spent.tokens).toBe(3);
      expect(event.payload.budget.remaining.tokens).toBe(0);
      expect(event.payload.error).toBeNull();
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 budget: a driver throw past the deadline is the wall cap', async () => {
    const journal = await headerWriter();
    const f = await fixture(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        throw new Error('provider transport reset');
      },
      '',
      {
        observationWriter: journal.writer,
        configure: (config) => {
          noRescue(config);
          // Large enough for the baseline check, small enough that the driver
          // throw lands past the deadline.
          config.budgets!.step!.wallMs = 500;
        },
      },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no wall-cap event');
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('wall-cap');
      expect(event.payload.timeout).toEqual({
        scope: 'attempt',
        boundMs: 500,
        source: 'address fixer wallClockMs deadline',
      });
      expect(event.payload.stopReason).toContain('address fixer wallClockMs deadline expired');
      expect(event.payload.stopReason).toContain('provider transport reset');
      expect(event.payload.tokens).toBeNull();
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 budget: a worker budget stop without a named cap preserves the raw code', async () => {
    const journal = await headerWriter();
    const f = await fixture(undefined, '', {
      observationWriter: journal.writer,
      firstStopReason: 'budget',
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no budget-stop event');
      // The driver named no cap: the class stays infrastructure, the stable raw
      // code is preserved and certainty is unknown. Never a guessed cap.
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopCode).toBe('unclassified');
      expect(event.payload.error?.code).toBe('budget');
      expect(event.payload.error?.certainty).toBe('unknown');
      expect(event.payload.stopReason).toContain('worker stopped: budget');
      expect(event.payload.tokens).toBe(3);
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });
});
