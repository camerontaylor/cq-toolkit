// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MEASUREMENT_MAX_BYTES } from '../../../src/ops/ratchet/verifyRatchet.js';
import {
  HOOK_MS,
  SLOW,
  artifact,
  artifactDir,
  good,
  prBranch,
  setupFixtures,
  teardownFixtures,
  verify,
  write,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: the measurement artifact is untrusted data', SLOW, () => {
  let head: string;
  beforeAll(() => {
    head = prBranch('pr-art', 'merge-queue', () => write('src/e.ts', 'export const e = 5;\n'));
  }, 120_000);

  test('a failed measure run voids the artifact', async () => {
    expect((await verify(head, { measureConclusion: 'failure' })).verdict).toBe('fail');
  });

  test.each([
    ['extra top-level key', { schemaVersion: 1, metrics: { coverage: 95 }, note: 'x' }],
    ['string value', { schemaVersion: 1, metrics: { coverage: '95' } }],
    ['nested object', { schemaVersion: 1, metrics: { coverage: { pct: 95 } } }],
    ['wrong schema version', { schemaVersion: 2, metrics: { coverage: 95 } }],
    ['coverage above 100', { schemaVersion: 1, metrics: { coverage: 101 } }],
    ['no coverage value', { schemaVersion: 1, metrics: {} }],
    ['not JSON', '{"schemaVersion": 1,'],
  ])('%s fails', async (_label, body) => {
    const v = await verify(head, { measurementPath: artifact('bad.json', body) });
    expect(v.verdict).toBe('fail');
  });

  test('an oversized artifact fails without being parsed', async () => {
    const big = artifact('big.json', `${' '.repeat(MEASUREMENT_MAX_BYTES)}{}`);
    const v = await verify(head, { measurementPath: big });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/exceeds/);
  });

  test('a symlinked artifact is refused, never followed', async () => {
    const link = join(artifactDir, 'link.json');
    symlinkSync(good(), link);
    const v = await verify(head, { measurementPath: link });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/not a regular file/);
  });

  test('a missing artifact fails', async () => {
    const v = await verify(head, { measurementPath: join(artifactDir, 'absent.json') });
    expect(v.verdict).toBe('fail');
  });
});
