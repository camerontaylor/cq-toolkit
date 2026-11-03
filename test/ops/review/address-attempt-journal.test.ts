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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
