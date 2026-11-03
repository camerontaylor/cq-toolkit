// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import { verifyRatchet } from '../../../src/ops/ratchet/verifyRatchet.js';
import {
  HOOK_MS,
  MANIFEST,
  SLOW,
  baseline,
  git,
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

describe('verifyRatchet: faults are failed, never a pass', SLOW, () => {
  const coveragePath = baselineRelPath('coverage', 'coverage');

  test.each([
    [
      'missing',
      () => {
        git(['rm', '-q', coveragePath]);
      },
      /missing at the trust ref/,
    ],
    [
      'misnamed',
      () => {
        write(
          coveragePath,
          renderBaseline({
            schemaVersion: 1,
            target: 'another-target',
            metric: 'coverage',
            direction: 'higher-is-better',
            value: 90,
            unit: 'pct',
            capturedAt: '2026-09-20T00:00:00.000Z',
          }),
        );
      },
      /names another ratchet/,
    ],
    [
      'wrong-direction',
      () => baseline('coverage', 'coverage', 'lower-is-better', 90, 'pct'),
      /direction lower-is-better disagrees/,
    ],
    [
      'wrong-unit',
      () => baseline('coverage', 'coverage', 'higher-is-better', 90, 'errors'),
      /unit errors disagrees with the definition \(pct\)/,
    ],
    ['invalid-json', () => write(coveragePath, 'not JSON'), /not valid JSON/],
  ])('a %s trust baseline fails the coverage ratchet', async (name, edit, reason) => {
    const head = prBranch('pr-bad-trust-' + name, 'merge-queue', () =>
      write('src/bad-trust-' + name + '.ts', 'export const example = 1;\n'),
    );
    const variant = prBranch('trust-' + name, trust, edit);
    const verdict = await verify(head, { trustRef: variant });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.results.find((r) => r.metric === 'coverage')).toMatchObject({
      verdict: 'fail',
      value: null,
    });
    expect(verdict.reasons.join('\n')).toMatch(reason);
  });

  test('unsupported recompute metrics and invalid recompute counts fail closed', async () => {
    const head = prBranch('pr-recompute-evidence', 'merge-queue', () => {
      write('src/recompute-evidence.ts', 'export const example = 1;\n');
      // The subject carries the canonical baseline for the extra ratchet the
      // TRUST variant declares, so this case exercises the recompute-metric
      // rule (F4) rather than short-circuiting on an absent subject baseline.
      baseline('custom', 'custom-count', 'lower-is-better', 0, 'errors');
    });
    for (const count of [-1, 1.5]) {
      const verdict = await verify(head, { typecheckCount: count });
      expect(verdict.verdict).toBe('fail');
      expect(verdict.reasons.join('\n')).toMatch(/not a non-negative integer/);
    }

    const variant = prBranch('trust-unsupported-recompute', trust, () => {
      const manifest = structuredClone(MANIFEST);
      manifest.ratchets.push({
        target: 'custom',
        metric: 'custom-count',
        direction: 'lower-is-better',
        unit: 'errors',
        evidence: 'recompute',
      });
      write('baselines/ratchets.json', JSON.stringify(manifest));
      baseline('custom', 'custom-count', 'lower-is-better', 0, 'errors');
    });
    const verdict = await verify(head, { trustRef: variant });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(
      /no trusted recompute exists for metric 'custom-count'/,
    );
  });

  test('an unresolvable subject is `failed`', async () => {
    const result = await verifyRatchet({
      repo,
      trustRef: trust,
      subject: 'no-such-ref',
      subjectKind: 'pr',
      base: 'merge-queue',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });

  test('a push cannot be judged over a PR base', async () => {
    const result = await verifyRatchet({
      repo,
      trustRef: trust,
      subject: trust,
      subjectKind: 'push',
      base: 'merge-queue',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/invalid base/);
  });

  test('a trust ref without the manifest is `failed`', async () => {
    const bare = git(['commit-tree', git(['mktree']), '-m', 'empty']);
    const result = await verifyRatchet({
      repo,
      trustRef: bare,
      subject: trust,
      subjectKind: 'push',
      base: 'main',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });

  test('an option-shaped ref never reaches git as an option', async () => {
    const result = await verifyRatchet({
      repo,
      trustRef: '--output=/tmp/cq-w17-pwn',
      subject: trust,
      subjectKind: 'pr',
      base: 'merge-queue',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });
});
