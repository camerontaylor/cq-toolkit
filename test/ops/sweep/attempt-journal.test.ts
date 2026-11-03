// ADR-0008 T13: `attempt-finished` emission at sweep fix inner attempt
// boundaries. runTaskLoopInner emits through the T30 runtime observation
// writer in each invocation's finally:
//   - round-trip:  a fixed task emits completed invocations with distinct
//     inner ordinals, usage channels (including reasoning tokens), measured
//     wall, budget accounting and correct completed discriminants;
//   - unknown evidence:  a writer opened without a composition-started
//     header refuses the first append — the emission failure becomes
//     indeterminate and the run still completes (evidence, never invention);
//   - failure boundary:  spawn failure and cancellation routes still finish
//     exactly once, through finishAttempt's classifier, with the cause
//     surviving on the payload (spawn → infrastructure/unclassified with the
//     sanitized cause; cancel → infrastructure with the cancellation code).
// The write failure / report deletion case: after the writer fail-stops
// (T29/P2-1) the completed attempt's payload evidence remains on the writer's
// accepted events, and the run records indeterminate instead of claiming a
// clean observation. Local, fake-driver fixtures only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { openObservationWriter } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { AttemptFinishedJournalEvent } from '../../../src/kernel/types.js';
import { runTaskLoop } from '../../../src/ops/sweep/taskLoop.js';
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
const EFFECTS = {
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

function fixedDriver(invocations: OpInvocation[]): Driver {
  return {
    run: async (invocation: OpInvocation): Promise<WorkerResult> => {
      invocations.push(invocation);
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
  extra: { observationWriter?: ObservationWriter },
): Parameters<typeof runTaskLoop>[0] {
  return {
    driver: fixedDriver(invocations),
    prompt: () => 'fix it',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
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
  extra: { observationWriter?: ObservationWriter } = {},
) =>
  runTaskLoop(
    loopBindings(invocations, extra),
    UNIT,
    { path: '/tmp/unused', branch: 'run/x' } as never,
    PROBE,
    'run/x',
    EFFECTS,
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

describe('T13 attempt-journal', () => {
  test('T13 round-trip', async () => {
    const { writer, root } = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const outcome = await runLadder(
        () => runLoop(invocations, { observationWriter: writer }),
        { wallClockMs: 5000 },
        { op: 'sweep.unit', jobKey: 'j-attempt-1', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      // Two invocations (edit + feedback), each exactly one event.
      const events = attemptEvents(writer);
      expect(events).toHaveLength(2);
      // Distinct inner ordinals, 1-based, no duplicates; distinct from the
      // job retry ordinal (ungoverned run: jobId null).
      expect(events.map((e) => e.attempt)).toEqual([1, 2]);
      for (const event of events) {
        expect(event.runId).toBe(writer.compositionRunId);
        expect(event.taskId).toBe('src/a.ts');
        expect(event.unitId).toBe('fix/alpha');
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
        // wallMs is the measured elapsed wall (a real, non-null number),
        // never an invented placeholder for an unmeasured attempt.
        expect(typeof event.payload.wallMs === 'number').toBe(true);
        expect(event.payload.servedModel).toBe('served-model-x');
        expect(event.payload.model).toEqual({ provider: 'fixture', model: 'scripted' });
        expect(event.payload.error).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('T13 unknown evidence', async () => {
    // A writer whose stream was closed (report deleted / fail-stopped) is
    // refused: the emission failure becomes indeterminate and the run still
    // completes its loop — the events it DID accept remain the evidence.
    const f = await headeredWriter();
    const invocations: OpInvocation[] = [];
    try {
      const outcome = await runLadder(
        async () => {
          const result = await runLoop(invocations, { observationWriter: f.writer });
          await f.writer.close();
          return result;
        },
        { wallClockMs: 5000 },
        { op: 'sweep.unit', jobKey: 'j-attempt-2', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      // Closed after the loop: both events were accepted before close.
      expect(attemptEvents(f.writer)).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }

    // A writer that refuses appends (closed before the run) never invents
    // completions: every emission fails, the run reports indeterminate, and
    // no event is silently claimed.
    const g = await headeredWriter();
    await g.writer.close();
    const lateInvocations: OpInvocation[] = [];
    try {
      const result = await runLoop(lateInvocations, { observationWriter: g.writer });
      if (result.status !== 'ok') throw new Error('loop failed');
      expect(result.value.indeterminate).toContain('attempt observation failed');
      expect(attemptEvents(g.writer)).toHaveLength(0);
    } finally {
      await rm(g.root, { recursive: true, force: true });
    }
  });

  test('T13 failure boundary', async () => {
    // Spawn failure: the driver throws before any result; the invocation
    // still finishes exactly once through the classifier with the cause
    // preserved as infrastructure/unclassified, never a candidate failure.
    const spawnWriter = await headeredWriter();
    const spawnInvocations: OpInvocation[] = [];
    try {
      const failingDriver: Driver = {
        run: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:8080');
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
      expect(event.payload.error?.code).toContain('ECONNREFUSED');
      expect(event.payload.tokens).toBeNull();
    } finally {
      await rm(spawnWriter.root, { recursive: true, force: true });
    }

    // Cancellation: the cancellation stop still finishes the invocation once
    // through the same boundary. The cancel trips AFTER the first invocation
    // starts (the task loop skips already-cancelled tasks before any emit).
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
      // The cancel is observed before the driver runs; exactly one event
      // carries the cancellation cause through the classifier.
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
  });
});
