import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  POLICY_LIST_PATH,
  createPolicyDiff,
  type PolicyDiffInput,
} from '../../../src/ops/gates/policyDiff.js';
import {
  HOOK_MS,
  SLOW,
  MANIFEST_PATH,
  POLICY,
  importCommits,
  repo,
  setupFixtures,
  teardownFixtures,
  trust,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: faults are failed, never a pass', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    c = importCommits(repo, {
      'bad-trust-policy': {
        files: { [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: ['^('] }) },
      },
      'unanchored-trust-policy': {
        files: { [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: ['src/'] }) },
      },
      'no-policy-list': { files: { [POLICY_LIST_PATH]: null } },
      'jobs-bad-key': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({
            ...POLICY,
            requiredJobs: { '../ci.yml': ['static'] },
          }),
        },
      },
      'jobs-empty': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, requiredJobs: { 'ci.yml': [] } }),
        },
      },
      'no-manifest': { files: { [MANIFEST_PATH]: null } },
    });
  }, HOOK_MS);

  const call = (over: Partial<PolicyDiffInput>) =>
    createPolicyDiff({ posture: 'human', layer: 'default' })({
      repo,
      trustRef: trust,
      subject: trust,
      subjectKind: 'pr',
      base: 'merge-queue',
      ...over,
    });

  test('an invalid base, or a push over a PR base, is failed', async () => {
    expect(await call({ base: 'feature' })).toMatchObject({ status: 'failed' });
    expect(await call({ subjectKind: 'push', base: 'merge-queue' })).toMatchObject({
      status: 'failed',
      error: "policy diff: push subject has invalid base 'merge-queue'",
    });
  });

  test('an unresolvable or option-shaped subject is failed', async () => {
    expect(await call({ subject: 'no-such-ref' })).toMatchObject({ status: 'failed' });
    expect(await call({ subject: '--output=/tmp/x' })).toMatchObject({ status: 'failed' });
  });

  test('an invalid policy list at the trust ref is failed (the check cannot judge)', async () => {
    const result = await call({ trustRef: c['bad-trust-policy']! });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(/protectedPaths entry must compile/);
  });

  test('an unanchored policy-list entry at the trust ref is failed', async () => {
    const result = await call({ trustRef: c['unanchored-trust-policy']! });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(
      /protectedPaths entry must be anchored/,
    );
  });

  test('a trust ref without the policy list judges, and says the project lists are inactive', async () => {
    const at = c['no-policy-list']!;
    const result = await call({ trustRef: at, subject: at });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.report).toContain(
      `policy list: ${POLICY_LIST_PATH} absent at the trust ref — project protectedPaths and requiredChecks are inactive`,
    );
    expect(result.status === 'ok' && result.value.requiredJobs).toEqual({});
  });

  test.each([
    ['jobs-bad-key', /requiredJobs/],
    ['jobs-empty', /requiredJobs\.ci\.yml/],
  ])('invalid requiredJobs at the trust ref (%s) is failed', async (name, error) => {
    const result = await call({ trustRef: c[name]! });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(error);
  });

  test('a trust ref without the manifest is failed', async () => {
    expect(await call({ trustRef: c['no-manifest']! })).toMatchObject({ status: 'failed' });
  });
});
