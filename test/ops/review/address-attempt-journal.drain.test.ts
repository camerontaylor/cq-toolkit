// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the observation-drain cases moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';
import {
  attemptEvents,
  headerWriter,
  noRescue,
  slowHandler,
  verdictOf,
} from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 settleObservations is a true barrier: no append can follow it', async () => {
    // The open-question witness: an invocation still in flight when the
    // composition wants to close its stream. The drain resolves only after
    // that invocation's attempt event has been handed to the writer.
    const journal = await headerWriter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched!: () => void;
    const seen = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const f = await fixture(
      async (input) => {
        dispatched();
        await gate;
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'candidate fixed' };
        if (input.prompt.includes('initial finding'))
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        return { disposition: 'fixed', reason: 'fixed', evidence: [] };
      },
      '',
      { observationWriter: journal.writer, runPrefix: 'cq-address/test' },
    );
    try {
      const fixing = f.engine.fix(finding(), 1);
      await seen;
      let drained = false;
      const draining = (f.engine.settleObservations?.() ?? Promise.resolve()).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Still in flight: the barrier has not resolved and nothing landed.
      expect(drained).toBe(false);
      expect(attemptEvents(journal.writer)).toHaveLength(0);
      release();
      await fixing;
      await draining;
      expect(drained).toBe(true);
      const events = attemptEvents(journal.writer);
      expect(events).toHaveLength(1);
      expect(f.engine.observationFailures?.()).toContain(
        'attempt observation after close: fixture',
      );
      // Landed BEFORE the drain resolved: a close after the drain cannot
      // refuse them.
      expect(events.every((event) => event.payload.stopCode === 'completed')).toBe(true);
    } finally {
      release();
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });

  test('T14 detached fix during checks refuses feedback after close without changing verdict', async () => {
    const run = async (observe: boolean) => {
      const journal = await headerWriter();
      const marker = join(journal.root, 'checks-entered');
      const release = join(journal.root, 'checks-release');
      const controller = new AbortController();
      const check = `const fs = require('node:fs');
        if (fs.readFileSync('src/a.ts', 'utf8').includes('GOOD')) {
          fs.writeFileSync(${JSON.stringify(marker)}, 'entered');
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
          }, 5);
        }`;
      const f = await fixture(slowHandler, check, {
        parentSignal: controller.signal,
        scanner: async (components) => {
          if (components.some((component) => component.text.includes('related-check feedback')))
            controller.abort();
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
        observationDrainMs: 20,
        ...(observe ? { observationWriter: journal.writer } : {}),
        configure: noRescue,
      });
      let fixing: Promise<AddressFix> | undefined;
      try {
        fixing = f.engine.fix(finding(), 1);
        // Wait for the real check child after the edit event, not a driver gate.
        for (let i = 0; ; i++) {
          try {
            await readFile(marker);
            break;
          } catch {
            if (i > 1000) throw new Error('checks did not start');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        if (observe) expect(attemptEvents(journal.writer)).toHaveLength(1);
        await f.engine.settleObservations?.();
        const failuresAtClose = f.engine.observationFailures?.() ?? [];
        expect(failuresAtClose).toContain('attempt observation still in flight at close: fixture');
        await journal.writer.close();
        const countAtClose = journal.writer.events().length;
        await writeFile(release, 'release');
        const fix = await fixing;
        expect(f.engine.observationFailures?.()).toContain(
          'attempt observation after close: fixture',
        );
        expect(journal.writer.events()).toHaveLength(countAtClose);
        expect(journal.writer.failure).toBeNull();
        expect(f.calls()).toBe(1); // feedback was refused before driver dispatch
        return verdictOf(fix);
      } finally {
        await writeFile(release, 'release');
        await fixing;
        await f.cleanup();
        await rm(journal.root, { recursive: true, force: true });
      }
    };
    expect(await run(true)).toEqual(await run(false));
  });

  test('T14 settleObservations is bounded and names what it could not settle', async () => {
    // A detached invocation cannot be killed in-process. The drain must never
    // hang the report behind it: it returns at its bound and records the
    // outstanding invocation as observation evidence.
    const journal = await headerWriter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched!: () => void;
    const seen = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const f = await fixture(
      async () => {
        dispatched();
        await gate;
        return { disposition: 'deferred', reason: 'held', evidence: [] };
      },
      '',
      { observationWriter: journal.writer, observationDrainMs: 20 },
    );
    try {
      const fixing = f.engine.fix(finding(), 1);
      await seen;
      const before = (f.engine.observationFailures?.() ?? []).length;
      await f.engine.settleObservations?.();
      const failures = f.engine.observationFailures?.() ?? [];
      expect(failures.length).toBe(before + 1);
      expect(failures.at(-1)).toContain('attempt observation still in flight at close');
      expect(attemptEvents(journal.writer)).toHaveLength(0);
      release();
      await fixing;
    } finally {
      release();
      await f.cleanup();
      await rm(journal.root, { recursive: true, force: true });
    }
  });
});
