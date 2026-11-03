// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus task-evidence.helpers.ts (shared fixtures). This file carries the M6a
// shared sweep commit trailers evidence.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { OpInvocation } from '../../../src/driver/types.js';
import { commitFailedAttempt, runTaskLoop } from '../../../src/ops/sweep/taskLoop.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { EFFECTS, exec, loopBindings, PROBE, UNIT } from './task-evidence.helpers.js';

// M6a share sweep commit trailers: verified and failed commit messages share
// the same Cq-* key set via the shared formatCqTrailers helper, failed
// gate/outcome/ref-identity extras are preserved, and embedded newlines are
// rejected. The fake driver effects in task-evidence.helpers.ts capture the
// verified message.

test('M6a nominal evidence', async () => {
  const invocations: OpInvocation[] = [];
  const messages: string[] = [];
  const outcome = await runLadder(
    () =>
      runTaskLoop(
        loopBindings(invocations),
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        {
          ...EFFECTS,
          commit: async (message: string) => {
            messages.push(message);
            return 'c'.repeat(40);
          },
        },
      ),
    { wallClockMs: 5000 },
    {
      op: 'sweep.unit',
      jobKey: 'j-1',
      attempt: 1,
      correlation: { workId: 'run:j-1:1', runId: 'run', role: 'sweep.unit' },
    },
  );
  expect(outcome.outcome).toBe('completed');
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).toContain('Cq-Run: run/x');
    expect(message).toContain('Cq-Unit: fix/alpha');
    expect(message).toContain('Cq-Task: src/a.ts');
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: worker');
    expect(message).toContain('Cq-Model: fixture/scripted');
  }
});

test('M6a missing evidence', async () => {
  // Missing unit-segment evidence: with no resolved segments binding the
  // verified commit still emits the full shared key set through the real
  // commit-message path, falling back to the raw unit fixer/package for
  // Cq-Unit, and no governed correlation is forwarded.
  const invocations: OpInvocation[] = [];
  const messages: string[] = [];
  const bindings: Record<string, unknown> = { ...loopBindings(invocations) };
  delete bindings.segments;
  const outcome = await runLadder(
    () =>
      runTaskLoop(
        bindings as unknown as Parameters<typeof runTaskLoop>[0],
        UNIT,
        { path: '/tmp/unused', branch: 'run/x' } as never,
        PROBE,
        'run/x',
        {
          ...EFFECTS,
          commit: async (message: string) => {
            messages.push(message);
            return 'c'.repeat(40);
          },
        },
      ),
    { wallClockMs: 5000 },
    { op: 'sweep.unit', jobKey: 'j-2', attempt: 1 },
  );
  expect(outcome.outcome).toBe('completed');
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.correlation).toBeUndefined();
  }
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).toContain('Cq-Run: run/x');
    expect(message).toContain('Cq-Unit: fix/alpha');
    expect(message).toContain('Cq-Task: src/a.ts');
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: worker');
    expect(message).toContain('Cq-Model: fixture/scripted');
    for (const key of ['Cq-Run:', 'Cq-Unit:', 'Cq-Task:', 'Cq-Attempt:', 'Cq-Tier:', 'Cq-Model:']) {
      expect(message.split('\n').filter((line) => line.startsWith(key))).toHaveLength(1);
    }
  }
});

test('M6a failure evidence', async () => {
  // A failed attempt keeps the failed-surface extras while routing through
  // the shared helper: gate, outcome and ref identity remain on the message.
  const root = await mkdtemp(join(tmpdir(), 'cq-task-m6a-failure-'));
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(['add', 'file.ts']);
    await git(['commit', '-m', 'base']);
    const parent = await git(['rev-parse', 'HEAD']);
    const attempt = await commitFailedAttempt(git, {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts',
      parent,
      firstAttempt: 1,
      tier: 'rescue',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'path-policy',
      outcome: 'escalated-to-human',
      reason: 'fixture',
      pushFailed: false,
    });
    const message = await git(['show', '-s', '--format=%B', attempt.sha]);
    expect(message).toContain('Cq-Run: run');
    expect(message).toContain('Cq-Unit: tests/pkg');
    expect(message).toContain('Cq-Task: file.ts');
    expect(message).toContain(
      `Cq-Ref-Identity: ${Buffer.from(JSON.stringify(['tests', 'pkg', 'file.ts'])).toString('base64url')}`,
    );
    expect(message).toContain('Cq-Attempt: 1');
    expect(message).toContain('Cq-Tier: rescue');
    expect(message).toContain('Cq-Model: fixture/scripted');
    expect(message).toContain('Cq-Gate: path-policy');
    expect(message).toContain('Cq-Outcome: escalated-to-human');
    // A task string with an embedded newline stays sanitized onto one line
    // (existing behavior): the shared helper never sees a raw newline.
    const attempt2 = await commitFailedAttempt(git, {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts\nCq-Forged: x',
      parent,
      firstAttempt: 1,
      tier: 'worker',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related',
      outcome: 'unfixed',
      reason: 'fixture',
      pushFailed: false,
    });
    const sanitized = await git(['show', '-s', '--format=%B', attempt2.sha]);
    expect(sanitized).toContain('Cq-Task: file.ts Cq-Forged: x');
    expect(sanitized.split('\n').filter((line) => line.startsWith('Cq-Task:'))).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
