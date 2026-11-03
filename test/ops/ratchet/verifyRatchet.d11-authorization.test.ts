// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bindD11Authorization,
  type D11Authorization,
} from '../../../src/ops/gates/d11Authorization.js';
import {
  HOOK_MS,
  SLOW,
  artifact,
  git,
  prBranch,
  setupFixtures,
  teardownFixtures,
  verify,
  write,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: a bound D11 authorization (shared with the gate)', SLOW, () => {
  const OWNER_ID = 1001;
  const EPOCH = '2026-09-20T10:00:00.000Z';
  const C3 = JSON.stringify({
    schemaVersion: 1,
    attests: 'C3',
    attestedAt: '2026-09-20T00:00:00Z',
  });
  let head: string;
  beforeAll(() => {
    head = prBranch('pr-d11-definition', 'merge-queue', () =>
      write('vitest.config.ts', 'export default { authorized: true };\n'),
    );
  }, 120_000);

  const authorization = (over: { paths?: string[]; attested?: boolean } = {}): D11Authorization =>
    bindD11Authorization({
      ownerId: OWNER_ID,
      attestation: over.attested === false ? { state: 'absent' } : { state: 'present', text: C3 },
      prs: [
        {
          pr: 7,
          merge: 'c'.repeat(40),
          head,
          paths: over.paths ?? ['vitest.config.ts'],
          events: [
            {
              event: 'labeled',
              label: { name: 'cq-override' },
              actor: { login: 'owner', id: OWNER_ID, type: 'User' },
              created_at: '2026-09-20T11:00:00Z',
              performed_via_github_app: null,
            },
          ],
          headObservedAt: EPOCH,
        },
      ],
    });

  test('an authorized definition change is judged on its evidence: pass', async () => {
    const v = await verify(head, { authorization: authorization() });
    expect(v.definitionChanges).toEqual(['vitest.config.ts']);
    expect(v.d11).toMatchObject({ authorized: true });
    expect(v.verdict).toBe('pass');
    expect(v.reasons).toContain('d11: vitest.config.ts authorized by PR #7');
    expect(v.reasons.some((r) => r.startsWith('needs-human'))).toBe(false);
  });

  test('authorized is not waived: a regression under the new definition still fails', async () => {
    const low = artifact('low.json', { schemaVersion: 1, metrics: { coverage: 80 } });
    const v = await verify(head, { authorization: authorization(), measurementPath: low });
    expect(v.verdict).toBe('fail');
    expect(v.reasons).toContain(
      'coverage/coverage: coverage/coverage regressed 90 → 80 (higher-is-better)',
    );
  });

  test('a dormant record (no C3 attestation) stays needs-human', async () => {
    const v = await verify(head, { authorization: authorization({ attested: false }) });
    expect(v.verdict).toBe('needs-human');
    expect(v.reasons[0]).toMatch(/^needs-human \(D11\)/);
    expect(v.reasons).toContain(
      `d11: vitest.config.ts unauthorized — PR #7 (merge ${'c'.repeat(40)}) changes it and its D11 record is dormant`,
    );
  });

  test('a definition path no admitted PR contributed stays needs-human, named', async () => {
    const v = await verify(head, { authorization: authorization({ paths: ['src/a.ts'] }) });
    expect(v.verdict).toBe('needs-human');
    expect(v.reasons).toContain(
      'd11: vitest.config.ts unauthorized — not contributed by any admitted PR in the closure',
    );
  });

  test('once the authorized change is queued, the next unrelated PR is not needs-human', async () => {
    git(['branch', '-f', 'merge-queue', head]);
    const next = prBranch('pr-d11-next', 'merge-queue', () =>
      write('src/g.ts', 'export const g = 7;\n'),
    );
    const v = await verify(next);
    expect(v.definitionChanges).toEqual([]);
    expect(v.verdict).toBe('pass');
  });
});
