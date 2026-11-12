// ADR-0008 T13: `attempt-finished` emission at sweep fix inner attempt
// boundaries. runTaskLoopInner emits through the T30 runtime observation
// writer in each invocation's finally:
//   - round-trip:  a fixed task emits completed invocations with distinct
//     inner ordinals, usage channels (including reasoning tokens), a measured
//     wall, budget accounting and correct completed discriminants;
//   - observation failure:  a writer that refuses appends, or a payload that
//     fails finishAttempt's strict schema before reaching the writer, is never
//     allowed to change the run verdict. The unit stays clean and publishes;
//     the failure lives on the observation evidence (the writer's own
//     `failure`, or the report's `observationFailures`) for the composition
//     to fold into observation.status;
//   - failure boundary:  spawn failure and cancellation routes still finish
//     exactly once, through finishAttempt's classifier, with the cause
//     surviving on the payload (a dispatch class arrives as error.code;
//     cancel → infrastructure with the cancellation code);
//   - budget boundaries:  a token cap reached after a complete result stays
//     the budget variant and names the cap; a driver throw past the
//     wallClockMs deadline is the wall cap and stops the unit; a pre-dispatch
//     token exhaustion and a worker 'budget' stop preserve their observed
//     evidence without guessing a cap.
// Local, fake-driver fixtures only: no provider, no network, no credentials.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { DispatchError } from '../../../src/driver/errors.js';
import { openObservationWriter } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { AttemptFinishedJournalEvent } from '../../../src/kernel/types.js';
import { runTaskLoop, type TaskLoopEffects } from '../../../src/ops/sweep/taskLoop.js';
import { runLadder } from '../../../src/kernel/governor.js';

const UNIT = { package: 'alpha', fixer: 'fix', files: ['src/a.ts'] };
const PROBE = {
  verdict: 'failing' as const,
  attempts: 1,
  failureSet: {
    tool: 'vitest',
    exitCode: 1,
    failures: [
      {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: null,
        message: 'broken',
        severity: 'error' as const,
      },
    ],
  },
};
const EFFECTS: TaskLoopEffects = {
  broader: async () => ({
    final: {
      verdict: 'clean' as const,
      attempts: 1,
      failureSet: { tool: 'vitest', exitCode: 0, failures: [] },
    },
    treeSha: 'b'.repeat(40),
  }),
  commit: async () => 'c'.repeat(40),
  verify: async () => {},
  publish: async () => {},
};
/** A git stub that lets the FAILED-attempt evidence path settle cleanly. */
const stubGit = async (args: string[]) => ({
  code: 0,
  stdout:
    args[0] === 'write-tree' ? 'd'.repeat(40) : args.includes('commit-tree') ? 'e'.repeat(40) : '',
  stderr: '',
});

function fixedDriver(invocations: OpInvocation[], delayMs = 0): Driver {
  return {
    run: async (invocation: OpInvocation): Promise<WorkerResult> => {
      invocations.push(invocation);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
        denials: [],
        stopReason: 'complete',
        model: 'served-model-x',
      };
    },
  } as unknown as Driver;
}

function loopBindings(
  invocations: OpInvocation[],
  extra: Record<string, unknown> = {},
): Parameters<typeof runTaskLoop>[0] {
  return {
    driver: fixedDriver(invocations),
    prompt: () => 'fix it',
    // The gated tree and the broader probe's tree are the same 'b' tree: the
    // loop binds the commit to what the path/tamper gates inspected.
    git: async (args: string[]) => ({
      code: 0,
      stdout: args.includes('write-tree') ? `${'b'.repeat(40)}\n` : '',
      stderr: '',
    }),
    runCheck: async () => ({
      stdout: JSON.stringify({
        success: true,
        numTotalTests: 1,
        testResults: [
          {
            name: 's.test.js',
            status: 'passed',
            assertionResults: [{ fullName: 'p', status: 'passed' }],
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
    }),
    adapter: 'vitest-json' as const,
    checkCommand: () => ({ command: 'node', args: ['check'], cwd: '/tmp/unused' }),
    budget: { wallClockMs: 60_000 },
    runPrefix: 'run/x',
    scanPrompt: async () => {},
    modelSpec: { provider: 'fixture', model: 'scripted' },
    ...extra,
  } as unknown as Parameters<typeof runTaskLoop>[0];
}

const runLoop = (
  invocations: OpInvocation[],
  extra: Record<string, unknown> = {},
  effects: TaskLoopEffects = EFFECTS,
) =>
  runTaskLoop(
    loopBindings(invocations, extra),
    UNIT,
    { path: '/tmp/unused', branch: 'run/x' } as never,
    PROBE,
    'run/x',
    effects,
  );

async function headeredWriter(): Promise<{
  writer: ObservationWriter;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cq-attempt-journal-'));
  const workId = randomUUID();
  const writer = await openObservationWriter({
    journalDir: join(root, 'journal'),
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
        runPrefix: 'run/x',
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
        branch: 'run/x',
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

const okValue = (result: Awaited<ReturnType<typeof runTaskLoop>>) => {
  if (result.status !== 'ok') throw new Error('loop failed');
  return result.value;
};

describe('T13 attempt-journal', () => {
  test('T13 round-trip', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const outcome = await runLadder(
        () =>
          runLoop(invocations, {
            observationWriter: writer,
            driver: fixedDriver(invocations, 5),
          }),
        { wallClockMs: 5000 },
        { op: 'sweep.unit', jobKey: 'j-attempt-1', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      // Two invocations (edit + feedback), each exactly one event.
      const events = attemptEvents(writer);
      expect(events).toHaveLength(2);
      // Distinct inner ordinals, 1-based, no duplicates; the enclosing kernel
      // job identity travels separately as jobId, never this inner ordinal.
      expect(events.map((e) => e.attempt)).toEqual([1, 2]);
      for (const event of events) {
        expect(event.runId).toBe(writer.compositionRunId);
        expect(event.taskId).toBe('src/a.ts');
        // Production identity order is `<package>/<fixer>`; the unwired
        // fallback matches runFix/registry/unit.ts.
        expect(event.unitId).toBe('alpha/fix');
        // The governed dispatch's jobKey is the enclosing kernel job identity.
        expect(event.jobId).toBe('j-attempt-1');
        expect(event.payload.class).toBe('terminal');
        expect(event.payload.stopCode).toBe('completed');
        // Distinct edit/feedback identity per attempt.
        expect(event.payload.invocation).toBe(
          event.attempt === 1 ? 'run/x:src/a.ts:1:edit' : 'run/x:src/a.ts:2:feedback',
        );
        // Reasoning tokens land in the channels and the total.
        expect(event.payload.usageChannels.reasoning).toBe(3);
        expect(event.payload.tokens).toBe(21);
        expect(event.payload.requests).toBe(1);
        // wallMs is the measured elapsed wall of a driver that really took
        // time, never an invented placeholder.
        expect(event.payload.wallMs ?? -1).toBeGreaterThan(0);
        expect(event.payload.servedModel).toBe('served-model-x');
        expect(event.payload.model).toEqual({ provider: 'fixture', model: 'scripted' });
        expect(event.payload.error).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 unknown evidence', async () => {
    // A writer that refuses appends never invents completions, and the refusal
    // never changes the run verdict: the unit stays clean, publishes, and the
    // failure is observation evidence only. The closed writer refuses before
    // it can record the refusal on its own failure surface, so the unit report
    // carries it for the composition to fold into observation.status.
    const g = await headeredWriter();
    await g.writer.close();
    const lateInvocations: OpInvocation[] = [];
    let published = false;
    try {
      const value = okValue(
        await runLoop(
          lateInvocations,
          { observationWriter: g.writer, pushBranch: async () => {} },
          {
            ...EFFECTS,
            publish: async () => {
              published = true;
            },
          },
        ),
      );
      expect(value.indeterminate).toBeUndefined();
      expect(value.pushed).toBe(true);
      expect(published).toBe(true);
      expect(value.committedSha).toBe('c'.repeat(40));
      expect(value.observationFailures).toHaveLength(2);
      for (const failure of value.observationFailures ?? [])
        expect(failure).toContain('attempt observation failed');
      expect(attemptEvents(g.writer)).toHaveLength(0);
    } finally {
      await rm(g.root, { recursive: true, force: true });
    }
  });

  test('T13 invalid attempt payload stays observation evidence', async () => {
    // finishAttempt's strict schema rejects a negative usage count before the
    // writer sees anything. That build failure never changes the verdict: the
    // unit completes, publishes, and the report records the observation
    // failure for the composition.
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    let published = false;
    try {
      const invalidUsage: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          invocations.push(invocation);
          return {
            structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
            usage: { input: -1, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
            denials: [],
            stopReason: 'complete',
          };
        },
      } as unknown as Driver;
      const value = okValue(
        await runLoop(
          invocations,
          {
            observationWriter: writer,
            driver: invalidUsage,
            pushBranch: async () => {},
          },
          {
            ...EFFECTS,
            publish: async () => {
              published = true;
            },
          },
        ),
      );
      expect(value.indeterminate).toBeUndefined();
      expect(value.pushed).toBe(true);
      expect(published).toBe(true);
      expect(value.observationFailures).toHaveLength(2);
      for (const failure of value.observationFailures ?? [])
        expect(failure).toContain('attempt observation failed');
      expect(attemptEvents(writer)).toHaveLength(0);
      // Nothing reached the writer, so it never recorded a failure.
      expect(writer.failure).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 failure boundary', async () => {
    // Spawn failure: the driver throws before any result; the invocation
    // still finishes exactly once through the classifier with the cause
    // preserved as infrastructure/unclassified, never a candidate failure. A
    // pre-dispatch DispatchError's class is the stable error code.
    const spawnWriter = await headeredWriter();
    const spawnInvocations: OpInvocation[] = [];
    try {
      const failingDriver: Driver = {
        run: async () => {
          throw new DispatchError('auth', 'ECONNREFUSED 127.0.0.1:8080');
        },
      } as unknown as Driver;
      const bindings = loopBindings(spawnInvocations, {
        observationWriter: spawnWriter.writer,
      }) as unknown as Record<string, unknown>;
      bindings.driver = failingDriver;
      const result = await runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        EFFECTS,
      );
      expect(result.status).toBe('ok');
      const events = attemptEvents(spawnWriter.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no spawn event');
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopCode).toBe('unclassified');
      // The prose message survives in stopReason; error.code carries the
      // dispatch class, never the prose. The stop itself stays
      // infrastructure/unclassified, so its certainty is unknown.
      expect(event.payload.stopReason).toContain('ECONNREFUSED');
      expect(event.payload.error?.code).toBe('auth');
      expect(event.payload.error?.certainty).toBe('unknown');
      expect(event.payload.tokens).toBeNull();
    } finally {
      await rm(spawnWriter.root, { recursive: true, force: true });
    }

    // Cancellation: the fixture sets the cancel flag INSIDE driver.run, so the
    // invocation has already started; the post-run cancel check still finishes
    // it exactly once with the cancellation stop.
    const cancelWriter = await headeredWriter();
    const cancelInvocations: OpInvocation[] = [];
    try {
      const bindings = loopBindings(cancelInvocations, {
        observationWriter: cancelWriter.writer,
      }) as unknown as Record<string, unknown>;
      let cancelled = false;
      const failingDriver: Driver = {
        run: async () => {
          cancelled = true;
          throw new Error('driver interrupted mid-flight');
        },
      } as unknown as Driver;
      bindings.driver = failingDriver;
      bindings.cancelled = () => cancelled;
      const result = await runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        EFFECTS,
      );
      expect(result.status).toBe('ok');
      const events = attemptEvents(cancelWriter.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no cancel event');
      expect(event.payload.stopReason).toContain('cancelled');
      expect(event.payload.class).toBe('infrastructure');
      expect(event.attempt).toBe(1);
    } finally {
      await rm(cancelWriter.root, { recursive: true, force: true });
    }

    // #1195: a driver that rejects WITH the usage its run already settled
    // meters the thrown attempt row — tokens, usage channels and one request
    // — through the same finally boundary as a completed run. The stop
    // classification is untouched (still infrastructure/unclassified).
    const spendWriter = await headeredWriter();
    const spendInvocations: OpInvocation[] = [];
    try {
      const spendDriver: Driver = {
        run: async () => {
          throw Object.assign(new Error('provider transport reset mid-run'), {
            usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2, reasoning: 4 },
          });
        },
      } as unknown as Driver;
      const bindings = loopBindings(spendInvocations, {
        observationWriter: spendWriter.writer,
      }) as unknown as Record<string, unknown>;
      bindings.driver = spendDriver;
      const result = await runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        EFFECTS,
      );
      expect(result.status).toBe('ok');
      const events = attemptEvents(spendWriter.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no spend event');
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopReason).toContain('provider transport reset mid-run');
      // 7 + 3 + 1 + 2 + 4 — the rejection's settled usage, exactly.
      expect(event.payload.tokens).toBe(17);
      expect(event.payload.usageChannels).toEqual({
        input: 7,
        output: 3,
        cacheRead: 1,
        cacheWrite: 2,
        reasoning: 4,
      });
      expect(event.payload.requests).toBe(1);
    } finally {
      await rm(spendWriter.root, { recursive: true, force: true });
    }

    // #1195/#1189: a CORRUPT rejection usage (negative count) contributes
    // nothing — the row records usage unknown (nulls) instead of a lying
    // meter, and finishAttempt's strict schema never sees a negative value.
    const corruptWriter = await headeredWriter();
    const corruptInvocations: OpInvocation[] = [];
    try {
      const corruptDriver: Driver = {
        run: async () => {
          throw Object.assign(new Error('driver failed with a lying meter'), {
            usage: { input: -5, output: 3, cacheRead: 1, cacheWrite: 1 },
          });
        },
      } as unknown as Driver;
      const bindings = loopBindings(corruptInvocations, {
        observationWriter: corruptWriter.writer,
      }) as unknown as Record<string, unknown>;
      bindings.driver = corruptDriver;
      const result = await runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        EFFECTS,
      );
      expect(result.status).toBe('ok');
      const events = attemptEvents(corruptWriter.writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no corrupt-usage event');
      expect(event.payload.tokens).toBeNull();
      expect(event.payload.usageChannels).toEqual({});
      expect(event.payload.requests).toBeNull();
    } finally {
      await rm(corruptWriter.root, { recursive: true, force: true });
    }
  });

  test('T13 budget: token cap after a complete result names the cap', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const value = okValue(
        await runLoop(invocations, {
          observationWriter: writer,
          git: stubGit,
          budget: { wallClockMs: 60_000, maxTokens: 10 },
        }),
      );
      expect(value.budgetStopped).toBe(true);
      const events = attemptEvents(writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no token-cap event');
      // The worker completed, but the budget breach keeps the budget variant
      // and names the tripped cap.
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('token-cap');
      expect(event.payload.stopReason).toContain('maxTokens 10');
      expect(event.payload.budget.allowed.tokens).toBe(10);
      expect(event.payload.budget.spent.tokens).toBe(21);
      expect(event.payload.error).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 budget: a driver throw past the deadline is the wall cap', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const slowFailure: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          invocations.push(invocation);
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error('provider transport reset');
        },
      } as unknown as Driver;
      const value = okValue(
        await runLoop(invocations, {
          observationWriter: writer,
          driver: slowFailure,
          git: stubGit,
          budget: { wallClockMs: 20 },
        }),
      );
      // A throw past the deadline also stops the unit's budget: no further
      // attempts are scheduled.
      expect(value.budgetStopped).toBe(true);
      const events = attemptEvents(writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no wall-cap event');
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('wall-cap');
      expect(event.payload.timeout).toEqual({
        scope: 'attempt',
        boundMs: 20,
        source: 'sweep fixer wallClockMs deadline',
      });
      expect(event.payload.stopReason).toContain('sweep fixer wallClockMs deadline expired');
      expect(event.payload.stopReason).toContain('provider transport reset');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 budget: an exhausted task-run token budget stops before dispatch', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const value = okValue(
        await runLoop(invocations, {
          observationWriter: writer,
          git: stubGit,
          taskRunBudget: {
            remainingWallMs: () => 1_000_000,
            remainingTokens: () => 0,
            reportResult: () => {},
          },
        }),
      );
      expect(value.budgetStopped).toBe(true);
      // The cap tripped before any driver dispatch; the attempt boundary still
      // finished exactly once with the named cap.
      expect(invocations).toHaveLength(0);
      const events = attemptEvents(writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no pre-dispatch token-cap event');
      expect(event.payload.class).toBe('budget');
      expect(event.payload.stopCode).toBe('token-cap');
      expect(event.payload.tokens).toBeNull();
      expect(event.payload.wallMs ?? -1).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 budget: a worker budget stop without a named cap preserves the raw code', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const budgetStop: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          invocations.push(invocation);
          return {
            structuredOutput: { outcome: 'code-bug', summary: 'partial', confidence: 0.4 },
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'budget',
          };
        },
      } as unknown as Driver;
      const value = okValue(
        await runLoop(invocations, {
          observationWriter: writer,
          driver: budgetStop,
          git: stubGit,
        }),
      );
      expect(value.budgetStopped).toBe(true);
      const events = attemptEvents(writer);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('no budget-stop event');
      // The driver named no cap: the class stays infrastructure, the stable
      // raw code is preserved and certainty is unknown. Never a guessed cap.
      expect(event.payload.class).toBe('infrastructure');
      expect(event.payload.stopCode).toBe('unclassified');
      expect(event.payload.error?.code).toBe('budget');
      expect(event.payload.error?.certainty).toBe('unknown');
      expect(event.payload.stopReason).toContain('worker reported a budget stop');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
