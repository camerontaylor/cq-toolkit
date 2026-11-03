// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Split provenance: the unknown-evidence case moved verbatim from
// test/ops/review/address-attempt-journal.test.ts; the shared fixtures live in
// `address-attempt-journal.helpers.ts`.
//   - unknown evidence:  a refused append and a payload that fails
//     finishAttempt's strict schema are observation failures only; the fix
//     (and its commit) is identical with and without a failing observation.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openObservationWriter } from '../../../src/kernel/observation.js';
import {
  attemptEvents,
  headerWriter,
  slowHandler,
  verdictOf,
} from './address-attempt-journal.helpers.js';
import { fixture, finding } from './addressWorker.helpers.js';

describe('T14 address attempt journal', () => {
  test('T14 unknown evidence', async () => {
    // (a) A writer that refuses appends (closed before the fix). Its own
    // `failure` is null, so the worker carries each refusal as observation
    // evidence. The fix commits exactly as it does with no writer at all.
    const control = await fixture(slowHandler, '');
    const controlFix = await control.engine.fix(finding(), 1);
    const closed = await headerWriter();
    await closed.writer.close();
    const refused = await fixture(slowHandler, '', { observationWriter: closed.writer });
    try {
      const fix = await refused.engine.fix(finding(), 1);
      expect(verdictOf(fix)).toEqual(verdictOf(controlFix));
      expect(fix.finding.status).toBe('fixed');
      expect(attemptEvents(closed.writer)).toHaveLength(0);
      const failures = refused.engine.observationFailures?.() ?? [];
      expect(failures).toHaveLength(2);
      for (const failure of failures) expect(failure).toContain('attempt observation failed');
      // Nothing reached the writer, so it never recorded its own failure.
      expect(closed.writer.failure).toBeNull();
    } finally {
      await refused.cleanup();
      await control.cleanup();
      await rm(closed.root, { recursive: true, force: true });
    }

    // (b) A negative usage channel fails finishAttempt's strict schema before
    // the writer sees anything. Still evidence only: the same fix, the same
    // commit, no event, and the writer's failure surface stays clean.
    const built = await headerWriter();
    const invalid = await fixture(slowHandler, '', {
      observationWriter: built.writer,
      usage: { input: -2, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    try {
      const fix = await invalid.engine.fix(finding(), 1);
      expect(verdictOf(fix)).toEqual(verdictOf(controlFix));
      expect(fix.finding.status).toBe('fixed');
      expect(attemptEvents(built.writer)).toHaveLength(0);
      const failures = invalid.engine.observationFailures?.() ?? [];
      expect(failures).toHaveLength(2);
      for (const failure of failures) expect(failure).toContain('attempt observation failed');
      expect(built.writer.failure).toBeNull();
    } finally {
      await invalid.cleanup();
      await rm(built.root, { recursive: true, force: true });
    }

    // (c) A writer whose composition-started header never landed refuses the
    // attempt event (a stream must open with its header). The refusal is
    // evidence, never a verdict, and the worker never manufactures a headerless
    // stream of its own.
    const headerlessRoot = await mkdtemp(join(tmpdir(), 'cq-address-headerless-'));
    const unowned = await openObservationWriter({
      journalDir: headerlessRoot,
      workId: randomUUID(),
      compositionRunId: `comp-headerless-${Date.now()}`,
    });
    const noHeader = await fixture(slowHandler, '', { observationWriter: unowned });
    try {
      const fix = await noHeader.engine.fix(finding(), 1);
      expect(verdictOf(fix)).toEqual(verdictOf(controlFix));
      expect(attemptEvents(unowned)).toHaveLength(0);
      const failures = noHeader.engine.observationFailures?.() ?? [];
      expect(failures).toHaveLength(2);
      for (const failure of failures) expect(failure).toContain('attempt observation failed');
      expect(unowned.failure).toBeNull();
    } finally {
      await noHeader.cleanup();
      await unowned.close();
      await rm(headerlessRoot, { recursive: true, force: true });
    }
  });
});
