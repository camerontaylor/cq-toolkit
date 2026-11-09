// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Driver } from '../../../src/driver/types.js';
import { isTodoCommitMessage } from '../../../src/ops/fix/measurement.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import { UNIT, bindingsOf, makeWorld, runUnit } from './unit-scenarios.helpers.js';

test('verified local task commits retain scanned authorization for publication retries', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const runStateDir = join(world.root, 'state');
  const driver: Driver = {
    run: async () => ({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
      structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
    }),
  };
  try {
    const local = bindingsOf(world, { taskLoop: {}, runStateDir, driver });
    delete local.pushBranch;
    const result = await makeSweepUnitOp(local)(UNIT);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const sha = result.value.tasks?.[0]?.commits[0];
    expect(sha).toBeDefined();
    const record = JSON.parse(
      await readFile(join(runStateDir, 'scanned', 'fix', 'alpha.json'), 'utf8'),
    ) as { sha: string };
    expect(record.sha).toBe(sha);
    expect(world.pushCalls).toEqual([]);
    expect(result.value.pushed).toBe(false);
    const markerPath = join(runStateDir, 'committed', 'fix', 'alpha.json');
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const original = world.gitFactory();
    const retry = await runUnit(world, {
      taskLoop: {},
      runStateDir,
      deriveTasks: () => [],
      git: async (args) =>
        args.includes('rev-list') ? { code: 0, stdout: '1', stderr: '' } : original(args),
    });
    expect(retry.status).toBe('ok');
    expect(world.pushCalls).toHaveLength(1);
    await expect(readFile(markerPath, 'utf8')).resolves.toContain('alpha');
    const moved = await runUnit(world, {
      taskLoop: {},
      runStateDir,
      deriveTasks: () => [],
      git: async (args) => {
        if (args.includes('rev-list')) return { code: 0, stdout: '2', stderr: '' };
        if (args.includes('rev-parse') && args.at(-1) === 'HEAD')
          return { code: 0, stdout: 'f'.repeat(40), stderr: '' };
        return original(args);
      },
    });
    expect(moved.status).toBe('ok');
    if (moved.status === 'ok') expect(moved.value.indeterminate).toBeTruthy();
    expect(world.pushCalls).toHaveLength(1);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['todo', 'code-bug'] as const)(
  'verified %s commits identify todo evidence precisely',
  async (outcome) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      await runUnit(world, {
        taskLoop: {},
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome, summary: 'repair source', confidence: 0.9 },
          }),
        },
      });
      const message = world.gitCalls.find((args) => args.includes('commit'))?.at(-1) ?? '';
      expect(message).toContain('Cq-Task:');
      expect(message.includes('Cq-Todo: true')).toBe(outcome === 'todo');
      expect(isTodoCommitMessage(message)).toBe(outcome === 'todo');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
