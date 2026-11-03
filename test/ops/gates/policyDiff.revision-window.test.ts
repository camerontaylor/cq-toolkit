import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { POLICY_LIST_PATH, createPolicyDiff } from '../../../src/ops/gates/policyDiff.js';
import {
  HOOK_MS,
  SLOW,
  CI_PATH,
  POLICY,
  edit,
  importCommits,
  kinds,
  repo,
  setupFixtures,
  teardownFixtures,
  trust,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

// Owner ruling D-P (docs/protected-scope.md): a time-boxed diff-check window
// read from the TRUST REF's list only, applied only at the default layer,
// fail-closed outside its bounds, and never clearing a non-plain finding.
describe('policyDiff: the D-P revision window', SLOW, () => {
  const WINDOW = {
    posture: 'diff-check',
    opens: '2026-10-17T00:00:00Z',
    expires: '2026-10-31T00:00:00Z',
    ruling: 'D-P (owner, 2026-10-16)',
  };
  const at = (iso: string) => () => Date.parse(iso);
  const listWith = (extra: Record<string, unknown>): string =>
    `${JSON.stringify({ ...POLICY, ...extra }, null, 2)}\n`;
  let c: Record<string, string>;
  beforeAll(() => {
    c = importCommits(repo, {
      'window-trust': { files: { [POLICY_LIST_PATH]: listWith({ revisionWindow: WINDOW }) } },
      'window-too-long': {
        files: {
          [POLICY_LIST_PATH]: listWith({
            revisionWindow: { ...WINDOW, expires: '2026-11-18T00:00:01Z' },
          }),
        },
      },
      'window-inverted': {
        files: {
          [POLICY_LIST_PATH]: listWith({ revisionWindow: { ...WINDOW, expires: WINDOW.opens } }),
        },
      },
      'window-bad-date': {
        files: {
          [POLICY_LIST_PATH]: listWith({
            revisionWindow: { ...WINDOW, expires: '2026-10-32T00:00:00Z' },
          }),
        },
      },
      'window-human': {
        files: {
          [POLICY_LIST_PATH]: listWith({ revisionWindow: { ...WINDOW, posture: 'human' } }),
        },
      },
      'window-plain': { files: { 'lint/x.txt': 'rule-window\n' } },
      'window-pkg': { files: { 'package.json': '{ "name": "fixture-window" }\n' } },
      // The subject declares its own window: lists come from the trust ref only.
      'window-self': { files: { [POLICY_LIST_PATH]: listWith({ revisionWindow: WINDOW }) } },
      // The trust ref requires a ci.yml job `smoke` the workflow does not carry.
      'window-smoke-trust': {
        files: {
          [POLICY_LIST_PATH]: listWith({
            revisionWindow: WINDOW,
            requiredJobs: { 'ci.yml': ['static', 'smoke'] },
          }),
        },
      },
      'window-ci-comment': {
        files: { [CI_PATH]: edit(CI_PATH, '# lint the tree', '# lint the whole tree') },
      },
      'jobs-bad-key': {
        files: { [POLICY_LIST_PATH]: listWith({ requiredJobs: { '../ci.yml': ['static'] } }) },
      },
      'jobs-empty': { files: { [POLICY_LIST_PATH]: listWith({ requiredJobs: { 'ci.yml': [] } }) } },
    });
  }, HOOK_MS);

  const judge = async (
    trustRef: string,
    subject: string,
    now: () => number,
    layer: 'default' | 'env' = 'default',
  ) => {
    const result = await createPolicyDiff(
      { posture: 'human', layer },
      { now },
    )({
      repo,
      trustRef,
      subject,
      subjectKind: 'pr',
      base: 'merge-queue',
    });
    if (result.status !== 'ok')
      throw new Error(`policy ${result.status}: ${JSON.stringify(result)}`);
    return result.value;
  };

  test('inside the window a plain protected-path edit passes at the window layer', async () => {
    const out = await judge(c['window-trust']!, c['window-plain']!, at('2026-10-20T12:00:00Z'));
    expect(kinds(out)).toEqual(['protected-path']);
    expect(out).toMatchObject({ verdict: 'pass', posture: 'diff-check', postureLayer: 'window' });
    expect(out.report[0]).toBe('posture: diff-check (layer window)');
    expect(out.report[1]).toMatch(
      /revision window 2026-10-17T00:00:00Z\.\.2026-10-31T00:00:00Z .*: open/,
    );
  });

  test('at and after expiry, and before opening, the posture is human (fail closed)', async () => {
    const expired = await judge(c['window-trust']!, c['window-plain']!, at(WINDOW.expires));
    expect(expired).toMatchObject({
      verdict: 'needs-human',
      posture: 'human',
      postureLayer: 'default',
    });
    expect(expired.report).toContainEqual(
      expect.stringMatching(/EXPIRED — posture human \(fail closed\)/),
    );
    const early = await judge(c['window-trust']!, c['window-plain']!, at('2026-10-16T23:59:59Z'));
    expect(early).toMatchObject({ verdict: 'needs-human', posture: 'human' });
    expect(early.report).toContainEqual(expect.stringMatching(/not open yet/));
    const nan = await judge(c['window-trust']!, c['window-plain']!, () => Number.NaN);
    expect(nan.verdict).toBe('needs-human');
  });

  test('the window never clears a definition change (diff-check semantics stay)', async () => {
    const out = await judge(c['window-trust']!, c['window-pkg']!, at('2026-10-20T12:00:00Z'));
    expect(out.postureLayer).toBe('window');
    expect(kinds(out)).toContain('definition-changed');
    expect(out.verdict).toBe('needs-human');
  });

  test('an explicit env posture wins over the window', async () => {
    const out = await judge(
      c['window-trust']!,
      c['window-plain']!,
      at('2026-10-20T12:00:00Z'),
      'env',
    );
    expect(out).toMatchObject({ verdict: 'needs-human', posture: 'human', postureLayer: 'env' });
    expect(out.report).toContainEqual(
      expect.stringMatching(/not applied — posture set at the env layer/),
    );
  });

  test('a changed workflow without a trust-ref required job needs a human even in the window', async () => {
    const now = at('2026-10-20T12:00:00Z');
    // Control: the same comment-only ci.yml edit passes when every required job is present.
    const control = await judge(c['window-trust']!, c['window-ci-comment']!, now);
    expect(control).toMatchObject({ verdict: 'pass', postureLayer: 'window' });
    const out = await judge(c['window-smoke-trust']!, c['window-ci-comment']!, now);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: 'no statically named required job smoke',
    });
    expect(out.verdict).toBe('needs-human');
    // The gate's requiredJobs come from the TRUST ref's list, not the subject's.
    expect(out.requiredJobs).toEqual({ 'ci.yml': ['static', 'smoke'] });
    expect((await judge(trust, c['window-self']!, now)).requiredJobs).toEqual({
      'ci.yml': ['static'],
    });
  });

  test('a window in the SUBJECT has no effect', async () => {
    const out = await judge(trust, c['window-self']!, at('2026-10-20T12:00:00Z'));
    expect(out).toMatchObject({
      verdict: 'needs-human',
      posture: 'human',
      postureLayer: 'default',
    });
    expect(out.report.join('\n')).not.toMatch(/revision window/);
  });

  test.each([
    ['window-too-long', /revisionWindow may span at most 31 days/],
    ['window-inverted', /revisionWindow\.expires must be after opens/],
    ['window-bad-date', /must be a real UTC second/],
    ['window-human', /revisionWindow\.posture/],
    ['jobs-bad-key', /requiredJobs/],
    ['jobs-empty', /requiredJobs\.ci\.yml/],
  ])('an invalid window at the trust ref (%s) is failed', async (name, error) => {
    const result = await createPolicyDiff(
      { posture: 'human', layer: 'default' },
      { now: at('2026-10-20T12:00:00Z') },
    )({
      repo,
      trustRef: c[name]!,
      subject: c['window-plain']!,
      subjectKind: 'pr',
      base: 'merge-queue',
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(error);
  });
});
