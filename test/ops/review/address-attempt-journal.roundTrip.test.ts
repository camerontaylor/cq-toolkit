// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the round-trip case moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
//   - round-trip:  a fixed finding emits completed invocations with distinct
//     per-unit ordinals (the escalation job retry ordinal stays on the
//     AddressAttempt row), usage channels, a measured wall, budget accounting
//     and the `<package>/address` unit identity; the on-disk stream folds.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { readObservations } from '../../../src/kernel/observation.js';
import { attemptEvents, headerWriter, slowHandler } from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 round-trip', async () => {
    const journal = await headerWriter();
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      runPrefix: 'cq-address/test',
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('fixed');
      expect(fix.commit).toBeDefined();
      // Edit, feedback and closure reviewer dispatches; only the two FIXER
      // dispatches are attempt boundaries.
      expect(f.calls()).toBe(3);
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(2);
      // Distinct per-unit ordinals, 1-based. The escalation job retry ordinal
      // stays on the AddressAttempt row (1 for every row of this round), never
      // reused as the observation attempt.
      expect(events.map((event) => event.attempt)).toEqual([1, 2]);
      expect(f.attempts.map((row) => row.attempt)).toEqual([1, 1, 1]);
      for (const event of events) {
        expect(event.runId).toBe(journal.writer.compositionRunId);
        expect(event.taskId).toBe('src/a.ts');
        // Production identity order is `<package>/<fixer>`; the review lane's
        // fixer slot is `address`.
        expect(event.unitId).toBe('fixture/address');
        // Not a governed dispatch here: no fabricated kernel jobId.
        expect(event.jobId).toBeNull();
        expect(event.payload.tier).toBe('worker');
        expect(event.payload.class).toBe('terminal');
        expect(event.payload.stopCode).toBe('completed');
        expect(event.payload.invocation).toBe(
          event.attempt === 1
            ? 'cq-address/test:src/a.ts:1:edit'
            : 'cq-address/test:src/a.ts:2:feedback',
        );
        expect(event.payload.model).toEqual({ provider: 'mock', model: 'worker' });
        expect(event.payload.provider).toBe('mock');
        expect(event.payload.requestedModel).toBe('worker');
        // The fake lane reports no served model: null, never a guess.
        expect(event.payload.servedModel).toBeNull();
        expect(event.payload.usageChannels).toEqual({
          input: 2,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: null,
        });
        expect(event.payload.tokens).toBe(3);
        expect(event.payload.requests).toBe(1);
        // Measured, not an invented zero.
        expect(event.payload.wallMs ?? -1).toBeGreaterThan(0);
        expect(event.payload.error).toBeNull();
        expect(event.payload.timeout).toBeNull();
        // Observed caps and spend, never invented: the edit dispatch starts
        // with the full run token budget, the feedback dispatch with 3 spent.
        expect(event.payload.budget.spent.tokens).toBe(3);
        expect(event.payload.budget.allowed.tokens).toBe(event.attempt === 1 ? 10000 : 9997);
      }
      // The persisted stream folds: one composition, header first, then the
      // two attempt events in append order.
      const streams = await readObservations(journal.root);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      expect(streams[0]?.events[0]?.type).toBe('composition-started');
      expect(streams[0]?.events.filter((event) => event.type === 'attempt-finished')).toHaveLength(
        2,
      );
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });
});
