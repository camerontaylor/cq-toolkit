import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/gates/registry.js';
import {
  HOOK_MS,
  SLOW,
  importCommits,
  repo,
  setupFixtures,
  teardownFixtures,
  trust,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('gates.policyDiff registry entry: the posture comes from config only', SLOW, () => {
  const entry = registry.find((e) => e.name === 'gates.policyDiff');
  const input = (): Record<string, unknown> => ({
    repo,
    trustRef: trust,
    subject: trust,
    subjectKind: 'pr',
    base: 'merge-queue',
  });

  test('the input schema is strict and has no posture field', () => {
    expect(entry).toBeDefined();
    expect(entry!.inputSchema.safeParse(input()).success).toBe(true);
    expect(entry!.inputSchema.safeParse({ ...input(), posture: 'diff-check' }).success).toBe(false);
    expect(entry!.inputSchema.safeParse({ ...input(), protectedPaths: 'diff-check' }).success).toBe(
      false,
    );
    expect(entry!.inputSchema.safeParse({ ...input(), pr: 0 }).success).toBe(false);
    expect(
      entry!.inputSchema.safeParse({ ...input(), settleStatePath: 'other.json' }).success,
    ).toBe(false);
  });

  async function dispatch(env: string | undefined, subject: string) {
    const saved = process.env['CQ_MERGE_PROTECTED_PATHS'];
    if (env === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
    else process.env['CQ_MERGE_PROTECTED_PATHS'] = env;
    try {
      const op = await entry!.importer();
      return await op(entry!.inputSchema.parse({ ...input(), subject }));
    } finally {
      if (saved === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
      else process.env['CQ_MERGE_PROTECTED_PATHS'] = saved;
    }
  }

  test('the resolved env posture decides, and is reported with its layer', async () => {
    const subject = importCommits(repo, {
      'registry-lint': { files: { 'lint/x.txt': 'rule4\n' } },
    })['registry-lint']!;
    const diffCheck = await dispatch('diff-check', subject);
    expect(diffCheck).toMatchObject({
      status: 'ok',
      value: { verdict: 'pass', posture: 'diff-check', postureLayer: 'env' },
    });
    const unset = await dispatch(undefined, subject);
    expect(unset).toMatchObject({
      status: 'ok',
      value: { verdict: 'needs-human', posture: 'human', postureLayer: 'default' },
    });
  });

  test('a bogus env posture fails the dispatch', async () => {
    expect(await dispatch('bogus', trust)).toEqual({
      status: 'failed',
      error:
        "policy: CQ_MERGE_PROTECTED_PATHS must be 'human', 'diff-check' or 'advisory', got 'bogus'",
    });
  });
});
