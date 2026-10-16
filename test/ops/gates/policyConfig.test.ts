// W1.9 — the CQ_MERGE_PROTECTED_PATHS posture resolver (P7/P8, Annex B §B.1).
import { describe, expect, test } from 'vitest';
import {
  PROTECTED_PATHS_ENV,
  PROTECTED_PATHS_OPT_IN,
  applyRevisionWindow,
  resolveProtectedPathsConfig,
  type RevisionWindow,
} from '../../../src/ops/gates/policyConfig.js';

describe('resolveProtectedPathsConfig', () => {
  test('names the Annex B keys', () => {
    expect(PROTECTED_PATHS_ENV).toBe('CQ_MERGE_PROTECTED_PATHS');
    expect(PROTECTED_PATHS_OPT_IN).toBe('merge.protectedPaths');
  });

  test.each([
    ['unset', {}],
    ['empty', { CQ_MERGE_PROTECTED_PATHS: '' }],
    ['blank', { CQ_MERGE_PROTECTED_PATHS: '  \t' }],
    ['explicit undefined', { CQ_MERGE_PROTECTED_PATHS: undefined }],
  ])('%s env resolves to the conservative human default (P8)', (_label, env) => {
    expect(resolveProtectedPathsConfig({ env })).toEqual({ posture: 'human', layer: 'default' });
  });

  test.each(['human', 'diff-check'] as const)('env %s resolves at the env layer', (posture) => {
    expect(resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: posture } })).toEqual({
      posture,
      layer: 'env',
    });
  });

  test.each(['Human', 'diff_check', ' human', 'diff-check ', 'off', '*'])(
    'any other env value %j throws',
    (value) => {
      expect(() =>
        resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: value } }),
      ).toThrow(`policy: CQ_MERGE_PROTECTED_PATHS must be 'human' or 'diff-check', got '${value}'`);
    },
  );

  test('a per-call opt-in to diff-check wins over the env (explicitly named relaxation)', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'human' },
        optIn: { 'merge.protectedPaths': 'diff-check' },
      }),
    ).toEqual({ posture: 'diff-check', layer: 'call' });
  });

  test('a per-call opt-in to human tightens an env diff-check', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'diff-check' },
        optIn: { 'merge.protectedPaths': 'human' },
      }),
    ).toEqual({ posture: 'human', layer: 'call' });
  });

  test('the opt-in wins even over an invalid env value', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'bogus' },
        optIn: { 'merge.protectedPaths': 'human' },
      }),
    ).toEqual({ posture: 'human', layer: 'call' });
  });

  test.each(['', '  ', 'Diff-Check', 'all'])('a blank or unknown opt-in %j throws', (value) => {
    expect(() =>
      resolveProtectedPathsConfig({ env: {}, optIn: { 'merge.protectedPaths': value } }),
    ).toThrow(/merge\.protectedPaths must be 'human' or 'diff-check'/);
  });

  test('an empty opt-in object falls through to the env', () => {
    expect(
      resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: 'diff-check' }, optIn: {} }),
    ).toEqual({ posture: 'diff-check', layer: 'env' });
  });

  test('the result is frozen', () => {
    expect(Object.isFrozen(resolveProtectedPathsConfig({ env: {} }))).toBe(true);
    expect(
      Object.isFrozen(
        resolveProtectedPathsConfig({ env: {}, optIn: { 'merge.protectedPaths': 'human' } }),
      ),
    ).toBe(true);
  });

  test('defaults env to process.env', () => {
    const saved = process.env[PROTECTED_PATHS_ENV];
    try {
      process.env[PROTECTED_PATHS_ENV] = 'diff-check';
      expect(resolveProtectedPathsConfig()).toEqual({ posture: 'diff-check', layer: 'env' });
    } finally {
      if (saved === undefined) delete process.env[PROTECTED_PATHS_ENV];
      else process.env[PROTECTED_PATHS_ENV] = saved;
    }
  });
});

// Owner ruling D-P: the trust-ref revision window (pure half; the policy list
// schema and the trust-ref-only read are covered in policyDiff.test.ts).
describe('applyRevisionWindow', () => {
  const window: RevisionWindow = {
    posture: 'diff-check',
    opens: '2026-10-17T00:00:00Z',
    expires: '2026-10-31T00:00:00Z',
    ruling: 'D-P',
  };
  const human = { posture: 'human', layer: 'default' } as const;

  test('no window: the resolved posture stands, no report line', () => {
    expect(applyRevisionWindow(human, undefined, 0)).toEqual({ ...human, lines: [] });
  });

  test('[opens, expires): default human becomes diff-check at the window layer', () => {
    for (const iso of ['2026-10-17T00:00:00Z', '2026-10-30T23:59:59Z']) {
      expect(applyRevisionWindow(human, window, Date.parse(iso))).toMatchObject({
        posture: 'diff-check',
        layer: 'window',
      });
    }
  });

  test.each([
    ['before opening', '2026-10-16T23:59:59Z', /not open yet — posture human \(fail closed\)/],
    ['at expiry', '2026-10-31T00:00:00Z', /EXPIRED — posture human \(fail closed\)/],
    ['long after expiry', '2027-01-01T00:00:00Z', /EXPIRED/],
  ])('%s: human, reported', (_label, iso, line) => {
    const out = applyRevisionWindow(human, window, Date.parse(iso));
    expect(out).toMatchObject({ posture: 'human', layer: 'default' });
    expect(out.lines.join('\n')).toMatch(line);
  });

  test('an unusable clock or unreadable bounds stay human (fail closed)', () => {
    const clock = applyRevisionWindow(human, window, Number.NaN);
    expect(clock.posture).toBe('human');
    expect(clock.lines.join('\n')).toMatch(/clock unusable — posture human \(fail closed\)/);
    // Unreachable through the policy-list schema, but the function is exported.
    const bounds = applyRevisionWindow(
      human,
      { ...window, expires: 'not-a-date' },
      Date.parse('2026-10-20T00:00:00Z'),
    );
    expect(bounds.posture).toBe('human');
    expect(bounds.lines.join('\n')).toMatch(/bounds unreadable/);
  });

  test('an expired window stays visible at an explicit layer', () => {
    const out = applyRevisionWindow(
      { posture: 'human', layer: 'env' },
      window,
      Date.parse('2026-11-01T00:00:00Z'),
    );
    expect(out.lines.join('\n')).toMatch(/not applied — posture set at the env layer \(expired\)/);
  });

  test.each([
    [{ posture: 'human', layer: 'env' }],
    [{ posture: 'human', layer: 'call' }],
    [{ posture: 'diff-check', layer: 'env' }],
  ] as const)('an explicit %o posture wins over the window', (config) => {
    const out = applyRevisionWindow(config, window, Date.parse('2026-10-20T00:00:00Z'));
    expect(out).toMatchObject(config);
    expect(out.lines.join('\n')).toMatch(/not applied/);
  });
});
