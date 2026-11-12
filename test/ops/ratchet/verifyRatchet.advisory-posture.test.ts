// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bindD11Authorization } from '../../../src/ops/gates/d11Authorization.js';
import { createVerifyRatchet } from '../../../src/ops/ratchet/verifyRatchet.js';
import {
  HOOK_MS,
  SLOW,
  artifact,
  baseline,
  git,
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

describe('trusted advisory posture', SLOW, () => {
  const advisory = createVerifyRatchet({ posture: 'advisory', layer: 'env' });
  test('ordinary definitions and a numeric stale-dependency regression are advisory', async () => {
    const head = prBranch('advisory-deps', trust, () => {
      write('package.json', '{"dependencies":{"new-package":"1.0.0"}}');
      write('tsconfig.json', '{"compilerOptions":{"strict":true}}');
    });
    const v = await verify(head, { typecheckCount: 2 }, advisory);
    expect(v.verdict).toBe('pass');
    expect(v.results.find((r) => r.metric === 'typecheck-count')?.verdict).toBe('fail');
    expect(v.reasons.join(' ')).toContain('advisory (dependency universe)');
    expect((await verify(head, { typecheckCount: 2 })).verdict).toBe('needs-human');
    expect((await verify(head, { typecheckCount: Number.NaN }, advisory)).verdict).toBe('fail');
    expect(
      (await verify(head, { measurementPath: artifact('advisory-bad.json', '{}') }, advisory))
        .verdict,
    ).toBe('fail');
    expect(
      (
        await verify(
          head,
          {
            measurementPath: artifact('advisory-low.json', {
              schemaVersion: 1,
              metrics: { coverage: 80 },
            }),
          },
          advisory,
        )
      ).verdict,
    ).toBe('fail');
  });
  test('source-only regressions remain blocking', async () => {
    const head = prBranch('advisory-source', trust, () => write('src/b.ts', 'export const b = 2;'));
    expect((await verify(head, { typecheckCount: 2 }, advisory)).verdict).toBe('fail');
  });
  test('privileged ranges keep numeric dependency regressions blocking', async () => {
    const head = prBranch('advisory-privileged', trust, () => {
      write('policy/guard.ts', 'changed');
      write('tsconfig.json', '{}');
      write('package.json', '{}');
    });
    expect((await verify(head, { typecheckCount: 2 }, advisory)).verdict).toBe('fail');
  });
  test('an unrelated privileged change does not make graph definitions require D11', async () => {
    const head = prBranch('advisory-mixed-ordinary', trust, () => {
      write('policy/guard.ts', 'changed');
      write('tsconfig.json', '{}');
    });
    const v = await verify(head, {}, advisory);
    expect(v.verdict).toBe('pass');
    expect(v.reasons.join(' ')).toContain('advisory (D11): definition changes — tsconfig.json');
  });
  test('mixed definitions authorize only privileged paths', async () => {
    const protectedTrust = prBranch('advisory-protected-trust', trust, () => {
      write(
        'policy/protected-paths.json',
        JSON.stringify({
          schemaVersion: 1,
          protectedPaths: ['^policy/', '^vitest\\.config\\.ts$'],
          requiredChecks: [],
        }),
      );
    });
    const head = prBranch('advisory-mixed-definitions', protectedTrust, () => {
      write('vitest.config.ts', 'export default {};');
      write('tsconfig.json', '{}');
    });
    const authorization = bindD11Authorization({
      ownerId: 1001,
      attestation: {
        state: 'present',
        text: JSON.stringify({
          schemaVersion: 1,
          attests: 'C3',
          attestedAt: '2026-09-20T00:00:00Z',
        }),
      },
      prs: [
        {
          pr: 7,
          merge: 'c'.repeat(40),
          head,
          paths: ['vitest.config.ts'],
          events: [
            {
              event: 'labeled',
              label: { name: 'cq-override' },
              actor: { login: 'owner', id: 1001, type: 'User' },
              created_at: '2026-09-20T11:00:00Z',
              performed_via_github_app: null,
            },
          ],
          headObservedAt: '2026-09-20T10:00:00Z',
        },
      ],
    });
    const v = await verify(head, { trustRef: protectedTrust, authorization }, advisory);
    expect(v.verdict).toBe('pass');
    expect(v.d11).toMatchObject({ authorized: true });
    expect(v.reasons).toContain('d11: vitest.config.ts authorized by PR #7');
    expect(v.reasons.join(' ')).toContain('advisory (D11): definition changes — tsconfig.json');
    expect((await verify(head, { trustRef: protectedTrust }, advisory)).verdict).toBe(
      'needs-human',
    );
  });
  test('ordinary advisory definitions cannot loosen baselines', async () => {
    const head = prBranch('advisory-loosen', trust, () => {
      write('tsconfig.json', '{}');
      baseline('coverage', 'coverage', 'higher-is-better', 80, 'pct');
    });
    expect((await verify(head, {}, advisory)).verdict).toBe('fail');
  });
  test('missing trusted privileged-path list fails closed', async () => {
    const head = prBranch('advisory-no-policy', trust, () =>
      git(['rm', 'policy/protected-paths.json']),
    );
    const result = await advisory({
      repo,
      trustRef: head,
      subject: head,
      subjectKind: 'pr',
      base: 'merge-queue',
      measureConclusion: 'success',
      measurementPath: good(),
      typecheckCount: 0,
    });
    expect(result.status).toBe('failed');
  });
});
