// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import {
  HOOK_MS,
  SLOW,
  artifact,
  baseline,
  git,
  prBranch,
  repo,
  setupFixtures,
  teardownFixtures,
  verify,
  write,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: the subject baseline is required and enforced (F3, F4)', SLOW, () => {
  const coveragePath = baselineRelPath('coverage', 'coverage');

  test('a tightening that has landed in the subject is enforced before promotion (F3)', async () => {
    // The queue already holds 95; the trust ref still says 90. A reading of
    // 92 satisfies the trust ref alone and must still FAIL, or the window
    // between a landing and its promotion is a free regression.
    const head = prBranch('pr-f3-coverage', 'merge-queue', () => {
      baseline('coverage', 'coverage', 'higher-is-better', 95, 'pct');
      write('src/f3.ts', 'export const f3 = 1;\n');
    });
    const v = await verify(head, {
      measurementPath: artifact('f3.json', { schemaVersion: 1, metrics: { coverage: 92 } }),
    });
    expect(v.verdict).toBe('fail');
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({
      baseline: 95,
      value: 92,
      verdict: 'fail',
    });
    // Meeting the stricter bar passes, and the reported baseline is it.
    const ok = await verify(head, {
      measurementPath: artifact('f3ok.json', { schemaVersion: 1, metrics: { coverage: 95 } }),
    });
    expect(ok.results.find((r) => r.metric === 'coverage')).toMatchObject({
      baseline: 95,
      value: 95,
      verdict: 'pass',
    });
  });

  test('the stricter side is direction-agnostic: a subject LOOSENING buys nothing (F3)', async () => {
    // typecheck-count, lower-is-better: trust 0, subject claims 3. The trust
    // ref's 0 still governs — had the subject's 3 been taken, a count of 1
    // would have passed. It fails.
    const head = prBranch('pr-f3-typecheck', 'merge-queue', () => {
      baseline('typecheck', 'typecheck-count', 'lower-is-better', 3, 'errors');
      write('src/f3tc.ts', 'export const f3tc = 1;\n');
    });
    const v = await verify(head, { typecheckCount: 1 });
    expect(v.results.find((r) => r.metric === 'typecheck-count')).toMatchObject({
      baseline: 0,
      value: 1,
      verdict: 'fail',
    });
    // Meeting the trust bar is still a pass, and the reported baseline is 0.
    const ok = await verify(head, { typecheckCount: 0 });
    expect(ok.results.find((r) => r.metric === 'typecheck-count')).toMatchObject({
      baseline: 0,
      value: 0,
      verdict: 'pass',
    });
  });

  test('a moved canonical baseline is refused even when the guard pairs it (F4)', async () => {
    // The guard pairs on (target, metric), so delete + an equal body at a
    // non-canonical path passes IT. The verifier then refuses the subject for
    // having no canonical baseline, instead of failing every later PR.
    const body = readFileSync(join(repo, coveragePath), 'utf8');
    const head = prBranch('pr-f4-move', 'merge-queue', () => {
      git(['rm', '-q', coveragePath]);
      write('baselines/nested/cov.json', body);
    });
    const v = await verify(head);
    expect(v.verdict).toBe('fail');
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({
      verdict: 'fail',
      value: null,
    });
    expect(v.reasons.join('\n')).toMatch(/is missing at the subject/);
  });
});
