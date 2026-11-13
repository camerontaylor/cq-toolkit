// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { verifyRatchet } from '../../../src/ops/ratchet/verifyRatchet.js';
import {
  HOOK_MS,
  SLOW,
  artifact,
  good,
  prBranch,
  repo,
  setupFixtures,
  teardownFixtures,
  trust,
  verify,
  write,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: a clean PR', SLOW, () => {
  test('passes with one-decimal coverage and the recompute count', async () => {
    const head = prBranch('pr-clean', 'merge-queue', () =>
      write('src/b.ts', 'export const b = 2;\n'),
    );
    const v = await verify(head);
    expect(v.verdict).toBe('pass');
    expect(v.trustRef).toBe(trust);
    expect(v.definitionChanges).toEqual([]);
    expect(v.results).toEqual([
      expect.objectContaining({
        metric: 'typecheck-count',
        value: 0,
        baseline: 0,
        verdict: 'pass',
      }),
      expect.objectContaining({ metric: 'coverage', value: 90, baseline: 90, verdict: 'pass' }),
    ]);
  });

  test('an intentional PR recompute skip passes with good coverage and still judges bad coverage', async () => {
    const head = prBranch('pr-skip-tc', 'merge-queue', () =>
      write('pnpm-lock.yaml', 'changed dependency graph\n'),
    );
    const reason = 'PR changes pnpm-lock.yaml; trusted typecheck recompute skipped';
    const v = await verify(head, { typecheckSkipped: reason });
    expect(v.verdict).toBe('pass');
    expect(v.results).toContainEqual(
      expect.objectContaining({ metric: 'typecheck-count', verdict: 'skipped', reason }),
    );
    expect(v.reasons.join('\n')).toContain(reason);
    expect(v.reasons.join('\n')).not.toContain('produced no count');
    const down = artifact('skip-down.json', { schemaVersion: 1, metrics: { coverage: 80 } });
    expect((await verify(head, { typecheckSkipped: reason, measurementPath: down })).verdict).toBe(
      'fail',
    );
  });

  test('a typecheck skip without any dependency or lockfile change is not a pass (I5)', async () => {
    const head = prBranch('pr-skip-nodep', 'merge-queue', () =>
      write('src/skip.ts', 'export const s = 1;\n'),
    );
    const v = await verify(head, { typecheckSkipped: 'claimed skip' });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toContain('no dependency or lockfile path changed');
  });

  test('a supplied recompute count together with a supplied skip reason conflicts and fails (I5)', async () => {
    const head = prBranch('pr-skip-conflict', 'merge-queue', () =>
      write('pnpm-lock.yaml', 'changed dependency graph\n'),
    );
    const v = await verify(head, {
      typecheckSkipped: 'PR changes pnpm-lock.yaml; trusted typecheck recompute skipped',
      typecheckCount: 1,
    });
    expect(v.verdict).toBe('fail');
    expect(v.results).toContainEqual(
      expect.objectContaining({
        metric: 'typecheck-count',
        verdict: 'fail',
        baseline: null,
        value: null,
        reason:
          'conflicting typecheck evidence: both a recompute count and a skip reason were supplied',
      }),
    );
    expect(v.reasons.join('\n')).toContain('conflicting typecheck evidence');
  });

  test('coverage is judged at one decimal place (89.96 → 90.0 passes, 89.94 → 89.9 fails)', async () => {
    const head = prBranch('pr-cov', 'merge-queue', () =>
      write('src/c.ts', 'export const c = 3;\n'),
    );
    const up = artifact('up.json', { schemaVersion: 1, metrics: { coverage: 89.96 } });
    expect((await verify(head, { measurementPath: up })).verdict).toBe('pass');
    const down = artifact('down.json', { schemaVersion: 1, metrics: { coverage: 89.94 } });
    const v = await verify(head, { measurementPath: down });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/coverage\/coverage: .*regressed 90 → 89\.9/);
  });

  test('a typecheck regression or an absent recompute count fails (I5)', async () => {
    const head = prBranch('pr-tc', 'merge-queue', () => write('src/d.ts', 'export const d = 4;\n'));
    expect((await verify(head, { typecheckCount: 1 })).verdict).toBe('fail');
    const { typecheckCount: _omit, ...noCount } = {
      repo,
      trustRef: trust,
      subject: head,
      subjectKind: 'pr' as const,
      base: 'merge-queue',
      measureConclusion: 'success',
      measurementPath: good(),
      typecheckCount: 0,
    };
    const result = await verifyRatchet(noCount);
    expect(result).toMatchObject({ status: 'ok', value: { verdict: 'fail' } });
  });
});
