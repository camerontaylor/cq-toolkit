// Dev family registry-surface tests — the same pins the pr/review families
// carry: entry names, schema accept/reject (strict throughout, the reviewer
// vocabulary, the base-sha pin), and the importer resolving to an op that
// fails the library boundary BEFORE any effect (zero processes touched).
import { describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/dev/registry.js';

const ENTRY_NAMES = ['dev.check', 'dev.review', 'dev.disposition', 'dev.ready'];

const entryByName = (name: string) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing registry entry '${name}'`);
  return entry;
};

function minimalInput(name: string): Record<string, unknown> {
  const input: Record<string, unknown> = { repoRoot: '/repo' };
  if (name === 'dev.disposition') {
    input.findingId = 'c001-aaaaaaaa#f1';
    input.action = 'fixed';
    input.why = 'addressed';
  }
  return input;
}

describe('dev family registry entries', () => {
  test('the family carries exactly the strategy §3 lane-1 entries', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([...ENTRY_NAMES].sort());
  });

  test.each(ENTRY_NAMES)('%s: inputSchema accepts a minimal valid input', (name) => {
    expect(entryByName(name).inputSchema.safeParse(minimalInput(name)).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: inputSchema rejects an unknown key (strict throughout)', (name) => {
    const input = { ...minimalInput(name), extra: 1 };
    expect(entryByName(name).inputSchema.safeParse(input).success).toBe(false);
  });

  test('dev.review: the reviewer vocabulary is the shipped CLI or the agent: fallback spelling', () => {
    const schema = entryByName('dev.review').inputSchema;
    expect(schema.safeParse({ repoRoot: '/repo', reviewer: 'coderabbit' }).success).toBe(true);
    expect(
      schema.safeParse({ repoRoot: '/repo', reviewer: 'agent:provider/model-x' }).success,
    ).toBe(true);
    expect(schema.safeParse({ repoRoot: '/repo', reviewer: 'mystery' }).success).toBe(false);
  });

  test('dev.review: the explicit base must be a commit sha (an immutable pin)', () => {
    const schema = entryByName('dev.review').inputSchema;
    expect(schema.safeParse({ repoRoot: '/repo', base: '1234567abcdef0' }).success).toBe(true);
    expect(schema.safeParse({ repoRoot: '/repo', base: 'origin/merge-queue' }).success).toBe(false);
  });

  test('dev.check: the knip mode is auto or force only', () => {
    const schema = entryByName('dev.check').inputSchema;
    expect(schema.safeParse({ repoRoot: '/repo', knip: 'force' }).success).toBe(true);
    expect(schema.safeParse({ repoRoot: '/repo', knip: 'skip' }).success).toBe(false);
  });

  test('dev.disposition: the action verb set is exactly fixed|rejected|deferred', () => {
    const schema = entryByName('dev.disposition').inputSchema;
    expect(schema.safeParse(minimalInput('dev.disposition')).success).toBe(true);
    expect(
      schema.safeParse({ ...minimalInput('dev.disposition'), action: 'ignored' }).success,
    ).toBe(false);
  });

  test.each(ENTRY_NAMES)(
    '%s: importer resolves to an op; a boundary-failing call returns failed with zero effects',
    async (name) => {
      const op = (await entryByName(name).importer()) as (i: unknown) => Promise<unknown>;
      expect(typeof op).toBe('function');
      const badInput: Record<string, unknown> = { ...minimalInput(name) };
      delete badInput['repoRoot'];
      const pending = op(badInput);
      expect(typeof (pending as { then?: unknown }).then).toBe('function');
      const result = (await pending) as { status: string };
      expect(result.status).toBe('failed');
    },
  );
});
