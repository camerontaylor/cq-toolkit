// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the failure-boundary case moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
//   - failure boundary:  spawn failure and cancellation each finish exactly
//     once, with the cause on the payload (a DispatchError class is the stable
//     error code) and the outcome unchanged.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { DispatchError } from '../../../src/driver/errors.js';
import { attemptEvents, headerWriter, noRescue } from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 failure boundary', async () => {
    // Spawn failure: the driver rejects before any result. The dispatch still
    // finishes exactly once, and the pre-dispatch DispatchError class is the
    // stable error code (never the prose message).
    const spawn = await headerWriter();
    const spawnFixture = await fixture(
      async () => {
        throw new DispatchError('auth', 'ECONNREFUSED 127.0.0.1:8080');
      },
      '',
      { observationWriter: spawn.writer, runPrefix: 'cq-address/test', configure: noRescue },
    );
    try {
      const fix = await spawnFixture.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(spawn.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no spawn event');
      expect(event.attempt).toBe(1);
      expect(event.unitId).toBe('fixture/address');
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopCode).toBe('unclassified');
      expect(event.payload.stopReason).toContain('ECONNREFUSED');
      expect(event.payload.error).toEqual({
        type: 'DispatchError',
        code: 'auth',
        providerFinishReason: null,
        source: 'driver',
        certainty: 'unknown',
      });
      expect(event.payload.tokens).toBeNull();
      expect(event.payload.requests).toBeNull();
    } finally {
      await spawnFixture.cleanup();
      await rm(spawn.root, { recursive: true, force: true });
    }

    // Cancellation: the parent aborts while the driver runs. The completed
    // result is observed (usage is real spend), but the attempt is the cancel
    // stop, not a completion.
    const cancel = await headerWriter();
    const controller = new AbortController();
    const cancelFixture = await fixture(
      async () => {
        controller.abort();
        return { disposition: 'deferred', reason: 'cancelled', evidence: [] };
      },
      '',
      {
        observationWriter: cancel.writer,
        parentSignal: controller.signal,
        runPrefix: 'cq-address/test',
      },
    );
    try {
      const fix = await cancelFixture.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(cancel.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no cancel event');
      expect(event.attempt).toBe(1);
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopCode).toBe('unclassified');
      expect(event.payload.stopReason).toBe('enclosing job cancelled');
      // The result was paid for and observed before the cancel was classified.
      expect(event.payload.tokens).toBe(3);
    } finally {
      await cancelFixture.cleanup();
      await rm(cancel.root, { recursive: true, force: true });
    }
  });
});
