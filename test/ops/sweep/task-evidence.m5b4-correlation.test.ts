// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus task-evidence.helpers.ts (shared fixtures). This file carries the M5b4
// governed invocation correlation evidence.
import { expect, test } from 'vitest';
import type { OpInvocation } from '../../../src/driver/types.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { runLoop } from './task-evidence.helpers.js';

// M5b4 forward governed invocation correlation: every OpInvocation the task
// loop builds forwards the governed job's correlation (the shared
// correlationInvocation helper result); run/work/parent/task forward
// verbatim and the role is passed through, never re-derived.

test('M5b4 nominal evidence', async () => {
  const invocations: OpInvocation[] = [];
  const outcome = await runLadder(
    () => runLoop(invocations),
    { wallClockMs: 5000 },
    {
      op: 'sweep.unit',
      jobKey: 'j-1',
      attempt: 1,
      correlation: { workId: 'run:j-1:1', runId: 'run', role: 'sweep.unit' },
    },
  );
  expect(outcome.outcome).toBe('completed');
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.correlation).toEqual({
      workId: 'run:j-1:1',
      runId: 'run',
      role: 'sweep.unit',
    });
  }
});

test('M5b4 missing evidence', async () => {
  const invocations: OpInvocation[] = [];
  const outcome = await runLoop(invocations);
  // The fixture deterministically fixes its one baseline failure: a status
  // regression would be invisible behind a permissive ['ok','failed'].
  expect(outcome.status).toBe('ok');
  if (outcome.status === 'ok') expect(outcome.value.tasks?.[0]?.outcome).toBe('fixed');
  // Discriminating, not vacuous: the loop must actually have built driver
  // invocations to inspect, and every one of them must carry NO correlation
  // (a forwarded correlation key here would fail the loop below).
  expect(invocations.length).toBeGreaterThan(0);
  expect(invocations.some((invocation) => invocation.correlation !== undefined)).toBe(false);
  for (const invocation of invocations) {
    expect(invocation.correlation).toBeUndefined();
  }
});

// Table-driven over the correlation shapes the runner may hand the task
// loop: run/work/parent/task forward verbatim, the role passes through
// untouched, and an absent role falls back to the helper's 'fixer' default
// (never re-derived from the op id).
test('M5b4 failure evidence', async () => {
  const cases: Array<{
    name: string;
    correlation: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: 'run id forwards verbatim',
      correlation: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'orchestrator' },
      expected: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'orchestrator' },
    },
    {
      name: 'work/parent ids forward verbatim',
      correlation: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        parentWorkId: 'parent-1',
        role: 'orchestrator',
      },
      expected: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        parentWorkId: 'parent-1',
        role: 'orchestrator',
      },
    },
    {
      name: 'task label forwards verbatim and no role is re-derived',
      correlation: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        role: 'orchestrator',
        task: 'outer task',
      },
      expected: {
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        role: 'orchestrator',
        task: 'outer task',
      },
    },
    {
      name: 'absent role defaults to fixer',
      correlation: { workId: 'run:j-outer:7', runId: 'outer-run' },
      expected: { workId: 'run:j-outer:7', runId: 'outer-run', role: 'fixer' },
    },
  ];
  for (const { name, correlation, expected } of cases) {
    const invocations: OpInvocation[] = [];
    // A governed correlation carrying the OUTER job's identity fields: the
    // invocation forwards them verbatim and invents NO new role.
    const outcome = await runLadder(
      () => runLoop(invocations),
      { wallClockMs: 5000 },
      {
        op: 'sweep.unit',
        jobKey: 'j-outer',
        attempt: 7,
        correlation: correlation as never,
      },
    );
    // Completion alone does not exclude a resolved failed task loop.
    expect(outcome.outcome, name).toBe('completed');
    if (outcome.outcome === 'completed') {
      expect(outcome.value.status, name).toBe('ok');
    }
    expect(invocations.length, name).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.correlation, name).toEqual(expected);
    }
  }
});
