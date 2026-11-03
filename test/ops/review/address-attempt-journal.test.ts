// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// The attempt boundary is a FIXER dispatch: edit and feedback invocations each
// finish exactly once in the invocation's finally, through T12's
// finishAttempt classifier and the T29 runtime writer the composition hands
// over only after its composition-started header landed. A reviewer closure
// verifies an attempt already recorded (the payload's tier has no reviewer
// member), so it emits nothing rather than fabricating a 'worker' tier.
//   - round-trip:  a fixed finding emits completed invocations with distinct
//     per-unit ordinals (the escalation job retry ordinal stays on the
//     AddressAttempt row), usage channels, a measured wall, budget accounting
//     and the `<package>/address` unit identity; the on-disk stream folds.
//   - unknown evidence:  a refused append and a payload that fails
//     finishAttempt's strict schema are observation failures only; the fix
//     (and its commit) is identical with and without a failing observation.
//   - failure boundary:  spawn failure and cancellation each finish exactly
//     once, with the cause on the payload (a DispatchError class is the stable
//     error code) and the outcome unchanged.
//   - budget:  a token cap reached by a complete result names the cap; a
//     driver throw past the wallClockMs deadline is the wall cap with timeout
//     evidence; a worker 'budget' stop with no named cap keeps the raw code.
// Local, fake-driver fixtures only: no provider, no network, no credentials.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DispatchError } from '../../../src/driver/errors.js';
import type { OpInvocation } from '../../../src/driver/types.js';
import { openObservationWriter, readObservations } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { AttemptFinishedJournalEvent } from '../../../src/kernel/types.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';
import { fixture, finding } from './addressWorker.helpers.js';

async function headerWriter(): Promise<{ writer: ObservationWriter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cq-address-attempt-journal-'));
  const workId = randomUUID();
  const writer = await openObservationWriter({
    journalDir: root,
    workId,
    compositionRunId: `comp-${Date.now()}`,
  });
  await writer.append({
    type: 'composition-started',
    runId: writer.compositionRunId,
    at: new Date().toISOString(),
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      journalVersion: 3,
      provenance: {
        cqVersion: 'test',
        producerVersion: 'test',
        repoId: null,
        cqJsonHash: `sha256:${'0'.repeat(64)}`,
        baseSha: 'a'.repeat(40),
        runPrefix: 'cq-address/test',
        startedAt: new Date().toISOString(),
        endedAt: null,
        journalLink: 'runs/x.ndjson',
        reportLink: 'reports/x.json',
        witnesses: {
          base: 'a'.repeat(40),
          admitted: null,
          execution: null,
          reviewed: null,
          accepted: null,
        },
      },
      correlation: {
        workId,
        parentWorkId: null,
        branch: 'cq-address/test',
        commitSha: null,
        sessionId: null,
        agentId: null,
      },
    },
  });
  return { writer, root };
}

const attemptEvents = (writer: ObservationWriter): AttemptFinishedJournalEvent[] =>
  writer.events().filter((e): e is AttemptFinishedJournalEvent => e.type === 'attempt-finished');

/** The verdict an observation failure must never move. */
const verdictOf = (fix: AddressFix) => ({
  status: fix.finding.status,
  reason: fix.finding.reason,
  committed: fix.commit !== undefined,
});

/** A slow default handler so wallMs is a measured, non-zero wall. */
const slowHandler = async (input: OpInvocation): Promise<unknown> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (input.outputSchema?.name === 'review.address.closure/v1')
    return { closed: true, reason: 'candidate fixed' };
  if (input.prompt.includes('initial finding'))
    await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
  return { disposition: 'fixed', reason: 'fixed', evidence: [] };
};

/** No rescue lane: a failing worker attempt is the finding's last attempt. */
const noRescue = (config: CqConfig): void => {
  if (config.roles) delete config.roles.rescue;
};

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
