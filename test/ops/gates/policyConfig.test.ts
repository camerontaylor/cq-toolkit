// W1.9 — the CQ_MERGE_PROTECTED_PATHS posture resolver (P7/P8, Annex B §B.1).
import { trustedOptIn } from '../../../src/config/optin.js';
import { readCqEnv } from '../../../src/config/env.js';
import { runWithCqEnv } from '../../../src/config/run-env.js';
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

  test('no injection defaults to the ambient snapshot (one fresh read outside a run)', () => {
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

describe('resolveProtectedPathsConfig entry-time snapshot and injection precedence (#1185)', () => {
  /** Run `fn` with `CQ_MERGE_PROTECTED_PATHS` ambiently set to `value`, then restore. */
  const withAmbient = <T>(value: string | undefined, fn: () => T): T => {
    const saved = process.env[PROTECTED_PATHS_ENV];
    if (value === undefined) delete process.env[PROTECTED_PATHS_ENV];
    else process.env[PROTECTED_PATHS_ENV] = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[PROTECTED_PATHS_ENV];
      else process.env[PROTECTED_PATHS_ENV] = saved;
    }
  };

  test('no injection reads the enclosing run snapshot, not a later ambient change', () => {
    withAmbient('human', () =>
      runWithCqEnv(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'advisory' }), () => {
        // Ambient drift after the run resolved its snapshot: a call-time
        // process.env read would answer 'human'/'default' here.
        process.env[PROTECTED_PATHS_ENV] = 'human';
        expect(resolveProtectedPathsConfig()).toEqual({ posture: 'advisory', layer: 'env' });
      }),
    );
  });

  test('a blank run snapshot is the conservative default even when the ambient env is set', () => {
    withAmbient('diff-check', () =>
      runWithCqEnv(readCqEnv({}), () => {
        expect(resolveProtectedPathsConfig()).toEqual({ posture: 'human', layer: 'default' });
      }),
    );
  });

  test('an explicit raw env record still wins over the run snapshot', () => {
    withAmbient('advisory', () =>
      runWithCqEnv(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'advisory' }), () => {
        expect(
          resolveProtectedPathsConfig({ env: { CQ_MERGE_PROTECTED_PATHS: 'diff-check' } }),
        ).toEqual({ posture: 'diff-check', layer: 'env' });
        // A blank explicit record is unset, not a fallback to the run snapshot.
        expect(resolveProtectedPathsConfig({ env: {} })).toEqual({
          posture: 'human',
          layer: 'default',
        });
      }),
    );
  });

  test('a call opt-in wins over the run snapshot', () => {
    withAmbient('human', () =>
      runWithCqEnv(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'human' }), () => {
        expect(
          resolveProtectedPathsConfig({
            optIn: trustedOptIn({ 'merge.protectedPaths': 'advisory' }),
          }),
        ).toEqual({ posture: 'advisory', layer: 'call' });
      }),
    );
  });

  test('an invalid run snapshot value is refused by name, never defaulted', () => {
    withAmbient(undefined, () =>
      runWithCqEnv(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'bogus' }), () => {
        expect(() => resolveProtectedPathsConfig()).toThrow(/CQ_MERGE_PROTECTED_PATHS/);
      }),
    );
  });
});
