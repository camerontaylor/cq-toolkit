// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  HOOK_MS,
  SLOW,
  artifact,
  baseline,
  prBranch,
  setupFixtures,
  teardownFixtures,
  verify,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: the guard judges the same range', SLOW, () => {
  test('an in-place baseline loosening fails; the trust baseline still governs', async () => {
    const head = prBranch('pr-loosen', 'merge-queue', () =>
      baseline('coverage', 'coverage', 'higher-is-better', 80, 'pct'),
    );
    const v = await verify(head, {
      measurementPath: artifact('85.json', { schemaVersion: 1, metrics: { coverage: 85 } }),
    });
    expect(v.verdict).toBe('fail');
    expect(v.guard).toMatchObject({ ok: false, violations: [{ why: 'loosened' }] });
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({ baseline: 90 });
  });

  test('a baseline tightening passes the guard', async () => {
    const head = prBranch('pr-tighten', 'merge-queue', () =>
      baseline('coverage', 'coverage', 'higher-is-better', 95, 'pct'),
    );
    expect((await verify(head)).guard.ok).toBe(true);
  });
});
