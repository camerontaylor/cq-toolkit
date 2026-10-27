import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CqConfigSchema,
  migrateCqConfig,
  parseCqConfig,
} from '../../../src/ops/analyze/cqConfig.js';

const check = { adapter: 'tsc-lines', command: { command: 'tsc', args: ['--noEmit'] } };
const minimal = { schemaVersion: 2, checks: [check] };
const full = {
  ...minimal,
  packages: [{ name: 'core', path: 'packages/core' }],
  checks: [{ ...check, kind: 'static', relatedArgs: ['--noEmit', '{files}'] }],
  roles: {
    worker: { provider: 'fixture-worker', model: 'fixture-small' },
    rescue: { provider: 'fixture-rescue', model: 'fixture-large' },
    reviewer: { provider: 'fixture-reviewer', model: 'fixture-review' },
  },
  budgets: {
    run: { maxTokens: 100_000, wallMs: 1200 },
    unit: { wallMs: 3600 },
    step: { wallMs: 1200 },
  },
  review: {
    rounds: 4,
    searchTools: false,
    blockingSeverities: ['critical', 'major'],
    agentSeverityMap: { high: 'major', medium: 'minor', low: 'info' },
    reviewers: ['coderabbit', 'agent'],
    addressConcurrency: 2,
    denylistPatternsFile: 'denylist.yml',
    bulk: { concurrency: 3, query: 'is:open -is:draft author:fixture' },
    session: { maxInputChars: 80_000, maxSteps: 20 },
    size: {
      small: { maxChangedLines: 100, maxFiles: 3 },
      medium: { maxChangedLines: 400, maxFiles: 8 },
    },
    exclude: [
      { pattern: 'pnpm-lock.yaml', assuredBy: 'dev.check' },
      { pattern: 'docs/generated/**' },
    ],
    reReview: { includePriorFindings: false },
  },
  escalation: { workerAttempts: 2, rescueBase: 20, rescuePerFixed: 10, rescuePerPackageCap: 10 },
};

describe('cq.json v2', () => {
  test('minimal and full configurations parse; check timeouts retain the dispatch default', () => {
    for (const config of [minimal, full]) {
      const parsed = parseCqConfig(JSON.stringify(config));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      if (parsed.ok) {
        expect(parsed.config).toMatchObject(config);
        expect(parsed.config.checks[0]?.command.timeoutMs).toBe(600_000);
      }
    }
  });

  test('v1 is refused with a one-line migration hint', () => {
    const result = parseCqConfig(JSON.stringify({ ...minimal, schemaVersion: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('cq analyze.init --migrate');
      expect(result.reason).toContain("--dir='.'");
      expect(result.migrationRequired).toBe(true);
      expect(result.reason).not.toMatch(/[\r\n]/);
    }
  });

  test('migration hint uses the requested project directory as one shell argument', () => {
    const result = parseCqConfig(
      JSON.stringify({ ...minimal, schemaVersion: 1 }),
      "project's folder",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("--dir='project'\\''s folder'");
  });

  test.each([
    { ...minimal, unknown: true },
    { ...minimal, packages: [{ name: 'core', path: '.', extra: true }] },
    { ...minimal, checks: [{ ...check, extra: true }] },
    { ...minimal, checks: [{ ...check, command: { ...check.command, extra: true } }] },
    { ...full, roles: { worker: { ...full.roles.worker, extra: true } } },
    { ...full, roles: { extra: {} } },
    { ...full, budgets: { extra: 1 } },
    { ...full, budgets: { run: { maxTokens: 10, extra: 1 } } },
    { ...full, budgets: { unit: { wallMs: 1, extra: 1 } } },
    { ...full, budgets: { step: { wallMs: 1, extra: 1 } } },
    { ...full, review: { extra: 1 } },
    { ...full, review: { ...full.review, extra: 1 } },
    { ...full, review: { agentSeverityMap: { typo: 'major' } } },
    { ...full, review: { bulk: { extra: 1 } } },
    { ...full, review: { ...full.review, session: { maxInputChars: 1, extra: 1 } } },
    { ...full, review: { ...full.review, size: { extra: 1 } } },
    { ...full, review: { ...full.review, size: { small: { maxFiles: 1, extra: 1 } } } },
    { ...full, review: { ...full.review, exclude: [{ pattern: 'x', extra: 1 }] } },
    { ...full, review: { ...full.review, reReview: { includePriorFindings: true, extra: 1 } } },
    { ...full, escalation: { extra: 1 } },
  ])('unknown keys fail at every level (%#)', (config) => {
    expect(CqConfigSchema.safeParse(config).success).toBe(false);
  });

  test.each([0, -1, 1.5, Infinity])('invalid run token budget %s fails', (maxTokens) => {
    expect(CqConfigSchema.safeParse({ ...minimal, budgets: { run: { maxTokens } } }).success).toBe(
      false,
    );
  });

  test.each([
    { session: { maxInputChars: 0 } },
    { session: { maxInputChars: -1 } },
    { session: { maxInputChars: 1.5 } },
    { session: { maxSteps: 0 } },
    { session: { maxSteps: 1.5 } },
    { size: { small: { maxChangedLines: -1 } } },
    { size: { small: { maxFiles: 1.5 } } },
    { size: { medium: { maxChangedLines: -1 } } },
    { exclude: [{ pattern: '' }] },
    { exclude: [{ pattern: 'x', assuredBy: '' }] },
    { reReview: { includePriorFindings: 'yes' } },
  ])('invalid review policy value fails at its field (%#)', (review) => {
    expect(CqConfigSchema.safeParse({ ...minimal, review }).success).toBe(false);
  });

  test('review size tiers must be monotonic, including against a defaulted sibling', () => {
    const parseSize = (size: unknown) => CqConfigSchema.safeParse({ ...minimal, review: { size } });
    expect(
      parseSize({
        small: { maxChangedLines: 200, maxFiles: 5 },
        medium: { maxChangedLines: 200, maxFiles: 5 },
      }).success,
    ).toBe(true);
    expect(
      parseSize({ small: { maxChangedLines: 100 }, medium: { maxChangedLines: 50 } }).success,
    ).toBe(false);
    expect(parseSize({ small: { maxFiles: 2 }, medium: { maxFiles: 1 } }).success).toBe(false);
    // Omitted tiers and fields take their documented defaults before comparison.
    expect(parseSize({ medium: { maxChangedLines: 150 } }).success).toBe(false);
    expect(parseSize({ small: { maxChangedLines: 900 } }).success).toBe(false);
    // Raising medium alone is valid; a flag may then raise small above the default medium.
    expect(parseSize({ medium: { maxChangedLines: 1_000 } }).success).toBe(true);
    const rejection = parseCqConfig(
      JSON.stringify({ ...minimal, review: { size: { small: { maxChangedLines: 900 } } } }),
    );
    expect(rejection.ok).toBe(false);
    if (!rejection.ok) expect(rejection.reason).toContain('review.size.medium.maxChangedLines');
  });

  test('missing token budget remains absent, and zero rescue allocation is permitted', () => {
    const result = CqConfigSchema.parse({
      ...minimal,
      budgets: { run: {} },
      escalation: { rescueBase: 0, rescuePerPackageCap: 0 },
    });
    expect(result.budgets?.run).not.toHaveProperty('maxTokens');
  });

  test('migration preserves argv, order, cwd, explicit and omitted timeouts exactly', () => {
    const checks = [
      check,
      {
        adapter: 'eslint-json',
        command: {
          command: 'my lint',
          args: ['space in arg', '$(literal)', '--format=json'],
          cwd: 'sub dir',
          timeoutMs: 1234,
        },
      },
    ];
    const result = migrateCqConfig(JSON.stringify({ schemaVersion: 1, checks }));
    expect(result).toEqual({ ok: true, config: { schemaVersion: 2, checks }, changed: true });
  });

  test('migration is idempotent for valid v2 and preserves omitted defaults', () => {
    expect(migrateCqConfig(JSON.stringify(full))).toEqual({
      ok: true,
      config: full,
      changed: false,
    });
    expect(migrateCqConfig(JSON.stringify(minimal))).toEqual({
      ok: true,
      config: minimal,
      changed: false,
    });
  });

  test('migration refuses invalid JSON, unknown fields and unsupported versions', () => {
    for (const text of [
      '{',
      JSON.stringify({ ...minimal, schemaVersion: 99 }),
      JSON.stringify({ schemaVersion: 1, checks: [], typo: true }),
      JSON.stringify({ schemaVersion: 1, checks: [{ ...check, extra: true }] }),
    ]) {
      expect(migrateCqConfig(text).ok).toBe(false);
    }
  });

  test('toolkit root config keeps CodeRabbit first and runs only the compiler and the format gate', () => {
    const result = parseCqConfig(
      readFileSync(new URL('../../../cq.json', import.meta.url), 'utf8'),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.config.review?.reviewers?.[0]).toBe('coderabbit');
      // Cheap static gates only (no test suite); the format gate makes a
      // review.address "verified" fix cover format too (S7 attempt K).
      expect(result.config.checks.map(({ adapter }) => adapter)).toEqual([
        'tsc-lines',
        'oxfmt-check',
      ]);
    }
  });
});
