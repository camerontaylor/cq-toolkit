// W1.9 — the CQ_MERGE_PROTECTED_PATHS posture resolver (P7/P8, Annex B §B.1).
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
