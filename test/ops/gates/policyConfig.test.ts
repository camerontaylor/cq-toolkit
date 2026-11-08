// W1.9 — the CQ_MERGE_PROTECTED_PATHS posture resolver (P7/P8, Annex B §B.1).
import { trustedOptIn } from '../../../src/config/optin.js';
import { describe, expect, test } from 'vitest';
import {
  PROTECTED_PATHS_ENV,
  PROTECTED_PATHS_OPT_IN,
  resolveProtectedPathsConfig,
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

  test.each(['human', 'diff-check', 'advisory'] as const)(
    'env %s resolves at the env layer',
    (posture) => {
      expect(resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: posture } })).toEqual({
        posture,
        layer: 'env',
      });
    },
  );

  test.each(['Human', 'diff_check', ' human', 'diff-check ', 'Advisory', 'advisory ', 'off', '*'])(
    'any other env value %j throws',
    (value) => {
      expect(() =>
        resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: value } }),
      ).toThrow(
        `policy: CQ_MERGE_PROTECTED_PATHS must be 'human', 'diff-check' or 'advisory', got '${value}'`,
      );
    },
  );

  test('a per-call opt-in to diff-check wins over the env (explicitly named relaxation)', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'human' },
        optIn: trustedOptIn({ 'merge.protectedPaths': 'diff-check' }),
      }),
    ).toEqual({ posture: 'diff-check', layer: 'call' });
  });

  test('a per-call opt-in to advisory wins over the env (explicitly named relaxation)', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'human' },
        optIn: trustedOptIn({ 'merge.protectedPaths': 'advisory' }),
      }),
    ).toEqual({ posture: 'advisory', layer: 'call' });
  });

  test('a per-call opt-in to human tightens an env advisory', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'advisory' },
        optIn: trustedOptIn({ 'merge.protectedPaths': 'human' }),
      }),
    ).toEqual({ posture: 'human', layer: 'call' });
  });

  test('a per-call opt-in to human tightens an env diff-check', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'diff-check' },
        optIn: trustedOptIn({ 'merge.protectedPaths': 'human' }),
      }),
    ).toEqual({ posture: 'human', layer: 'call' });
  });

  test('the opt-in wins even over an invalid env value', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'bogus' },
        optIn: trustedOptIn({ 'merge.protectedPaths': 'human' }),
      }),
    ).toEqual({ posture: 'human', layer: 'call' });
  });

  test.each(['', '  ', 'Diff-Check', 'all'])('a blank or unknown opt-in %j throws', (value) => {
    expect(() =>
      resolveProtectedPathsConfig({
        env: {},
        optIn: trustedOptIn({ 'merge.protectedPaths': value }),
      }),
    ).toThrow(/merge\.protectedPaths must be 'human', 'diff-check' or 'advisory'/);
  });

  test('an empty opt-in object falls through to the env', () => {
    expect(
      resolveProtectedPathsConfig({
        env: { CQ_MERGE_PROTECTED_PATHS: 'diff-check' },
        optIn: trustedOptIn({}),
      }),
    ).toEqual({ posture: 'diff-check', layer: 'env' });
  });

  test('the result is frozen', () => {
    expect(Object.isFrozen(resolveProtectedPathsConfig({ env: {} }))).toBe(true);
    expect(
      Object.isFrozen(
        resolveProtectedPathsConfig({
          env: {},
          optIn: trustedOptIn({ 'merge.protectedPaths': 'human' }),
        }),
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

describe('resolveProtectedPathsConfig with a CqEnv snapshot', () => {
  test('the snapshot wins over the process env and an unset key is the default', async () => {
    const { readCqEnv } = await import('../../../src/config/env.js');
    const set = resolveProtectedPathsConfig({
      cqEnv: readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'advisory' }),
      env: { CQ_MERGE_PROTECTED_PATHS: 'human' },
    });
    expect(set).toEqual({ posture: 'advisory', layer: 'env' });
    expect(resolveProtectedPathsConfig({ cqEnv: readCqEnv({}) })).toEqual({
      posture: 'human',
      layer: 'default',
    });
  });

  test('a snapshot with an error for the key is refused, not defaulted to human', async () => {
    const { readCqEnv } = await import('../../../src/config/env.js');
    const bad = readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'bogus' });
    expect(() => resolveProtectedPathsConfig({ cqEnv: bad })).toThrow(/CQ_MERGE_PROTECTED_PATHS/);
    // A call opt-in still wins over the env layer, as before.
    expect(
      resolveProtectedPathsConfig({
        cqEnv: bad,
        optIn: trustedOptIn({ 'merge.protectedPaths': 'human' }),
      }).layer,
    ).toBe('call');
    // An error for an unrelated key does not affect this resolver.
    expect(resolveProtectedPathsConfig({ cqEnv: readCqEnv({ CQ_SANDBOX: 'of' }) }).layer).toBe(
      'default',
    );
  });
});
