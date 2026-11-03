// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the engine-stop and pre-dispatch refusal cases moved
// verbatim from test/ops/review/address-attempt-journal.test.ts; the shared
// fixtures live in `address-attempt-journal.helpers.ts`.
//
// A reviewer closure verifies an attempt already recorded (the payload's tier
// has no reviewer member), so it emits nothing rather than fabricating a
// 'worker' tier.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { attemptEvents, headerWriter, slowHandler } from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 pre-dispatch refusal: a request scan is the engine stop, not a driver error', async () => {
    // A request scan rejects a secret mid-dispatch (the row exists, the driver
    // has not produced anything). The refusal is engine-sourced: it keeps its
    // own human-deferred class and message — never error.source 'driver' and
    // never a doubled stopReason.
    const journal = await headerWriter();
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      runPrefix: 'cq-address/test',
      providerRequest: true,
      scanner: async (components) =>
        components.map((component) => ({
          component: component.component,
          hits:
            component.component === 'request' && component.text.includes('synthetic request')
              ? [{ ruleId: 'secret', lines: [1] }]
              : [],
        })),
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no refusal event');
      // The dispatch was resolved and its row recorded before the refusal.
      expect(event.payload.model).toEqual({ provider: 'mock', model: 'worker' });
      expect(event.payload.class).toBe('human');
      expect(event.payload.stopCode).toBe('human-deferred');
      expect(event.payload.stopReason).toBe(
        'upload refused: missing, failed or positive denylist scan',
      );
      expect(event.payload.error).toBeNull();
      expect(event.payload.tokens).toBeNull();
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 a cancel observed at admission is the cancel stop, never anonymous', async () => {
    // The parent aborts during the REQUEST scan; the admission gate after the
    // scan is where the cancel is first observable. stop() is asked in its own
    // order, so the stop is the cancel — not a bare 'unclassified' throw that
    // would keep the finally path from ever naming the cancel.
    const journal = await headerWriter();
    const controller = new AbortController();
    let scans = 0;
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      runPrefix: 'cq-address/test',
      parentSignal: controller.signal,
      providerRequest: true,
      scanner: async (components) => {
        scans++;
        if (scans === 2) controller.abort();
        return components.map((component) => ({ component: component.component, hits: [] }));
      },
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no cancel-at-admission event');
      expect(event.payload.stopReason).toBe('enclosing job cancelled');
      expect(event.payload.error?.code).toBe('cancelled');
      expect(event.payload.class).toBe('infrastructure');
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 a cancel that coincides with an exhausted budget is the cancel, not the cap', async () => {
    // The completed result spends the last token, so the ledger is exhausted
    // when the parent cancel lands. stop()'s own order decides first: the
    // cancel is the stop, and the exhausted cap is never mislabelled as it.
    const journal = await headerWriter();
    const controller = new AbortController();
    const f = await fixture(
      async () => {
        controller.abort();
        return { disposition: 'deferred', reason: 'cancelled', evidence: [] };
      },
      '',
      {
        observationWriter: journal.writer,
        parentSignal: controller.signal,
        maxTokens: 3,
      },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no cancel-over-budget event');
      expect(event.payload.stopReason).toBe('enclosing job cancelled');
      expect(event.payload.error?.code).toBe('cancelled');
      expect(event.payload.class).toBe('infrastructure');
      // The spend is still observed; only the label is the cancel.
      expect(event.payload.tokens).toBe(3);
      expect(event.payload.budget.remaining.tokens).toBe(0);
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 a refusal before dispatch finishes once, model null, wall cap', async () => {
    // The unit wall budget expires inside the head read that precedes the
    // dispatch, so invoke()'s own admission gate refuses: exactly one event,
    // no model ever resolved, and the unit wall bound named as the cap.
    const journal = await headerWriter();
    const unitWallMs = 1_200;
    let headReads = 0;
    let firstHeadRead: number | undefined;
    const f = await fixture(slowHandler, '', {
      observationWriter: journal.writer,
      runPrefix: 'cq-address/test',
      unitWallMs,
      gitHook: async (args, run) => {
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          headReads++;
          firstHeadRead ??= Date.now();
          // Read 1 is initialize(), read 2 the baseline head; read 3 is the
          // dispatched head, taken after the outer pre-dispatch guard, so the
          // overrun lands inside invoke()'s own admission gate.
          if (headReads >= 3) {
            const wait = (firstHeadRead ?? Date.now()) + unitWallMs + 150 - Date.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
        return run(args);
      },
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      // No driver call: the refusal is the engine's own gate.
      expect(f.calls()).toBe(0);
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no pre-dispatch event');
      expect(event.payload.model).toBeNull();
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('wall-cap');
      expect(event.payload.stopReason).toBe('unit wall budget exhausted');
      expect(event.payload.tokens).toBeNull();
    } finally {
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });
});
