import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readCqEnv, type CqEnv } from '../../../src/config/env.js';
import { runWithCqEnv } from '../../../src/config/run-env.js';
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

  async function dispatch(
    snapshot: CqEnv | undefined,
    subject: string,
    ambient: string | undefined,
  ) {
    const saved = process.env['CQ_MERGE_PROTECTED_PATHS'];
    if (ambient === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
    else process.env['CQ_MERGE_PROTECTED_PATHS'] = ambient;
    try {
      // The wired snapshot is captured before dispatch; the ambient value below
      // is the drift a call-time read (the pre-#1185 behavior) would have seen.
      const op = await entry!.importer(snapshot === undefined ? {} : { cqEnv: snapshot });
      return await op(entry!.inputSchema.parse({ ...input(), subject }));
    } finally {
      if (saved === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
      else process.env['CQ_MERGE_PROTECTED_PATHS'] = saved;
    }
  }

  test('the wired snapshot decides, and is reported with its layer', async () => {
    const subject = importCommits(repo, {
      'registry-lint': { files: { 'lint/x.txt': 'rule4\n' } },
    })['registry-lint']!;
    // Snapshot diff-check, ambient human: a call-time ambient read would
    // report needs-human.
    const diffCheck = await dispatch(
      readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'diff-check' }),
      subject,
      'human',
    );
    expect(diffCheck).toMatchObject({
      status: 'ok',
      value: { verdict: 'pass', posture: 'diff-check', postureLayer: 'env' },
    });
    // Snapshot unset, ambient diff-check: the snapshot is the authority, so
    // the conservative default applies (a call-time read would pass).
    const unset = await dispatch(readCqEnv({}), subject, 'diff-check');
    expect(unset).toMatchObject({
      status: 'ok',
      value: { verdict: 'needs-human', posture: 'human', postureLayer: 'default' },
    });
  });

  test('an invalid wired posture fails the dispatch, never defaults', async () => {
    const result = await dispatch(
      readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'bogus' }),
      trust,
      undefined,
    );
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') {
      expect(result.error).toContain('CQ_MERGE_PROTECTED_PATHS');
      expect(result.error).toContain("'human', 'diff-check' or 'advisory'");
    }
  });

  test('without wiring the importer uses the enclosing run snapshot (library fallback)', async () => {
    const subject = importCommits(repo, {
      'registry-lib': { files: { 'lint/x.txt': 'rule5\n' } },
    })['registry-lib']!;
    // No wiring snapshot: the resolver's currentCqEnv() default is the
    // authority. Running it inside a run makes the assertion deterministic
    // (no dependence on the host's ambient CQ_* environment): the ambient
    // 'human' below would answer needs-human under the pre-#1185 call-time
    // process.env read.
    const result = await runWithCqEnv(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'diff-check' }), () =>
      dispatch(undefined, subject, 'human'),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { verdict: 'pass', posture: 'diff-check', postureLayer: 'env' },
    });
  });
});
