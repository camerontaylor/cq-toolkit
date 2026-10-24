// Dev family registry-surface tests — the same pins the pr/review families
// carry: entry names, schema accept/reject (strict throughout, the reviewer
// vocabulary, the base-sha pin), and the importer resolving to an op that
// fails the library boundary BEFORE any effect (zero processes touched).
import { describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/dev/registry.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestRepo } from './repo.js';

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
  test('fresh adopter dispatch scans without the toolkit denylist script or policy file', async () => {
    const repo = await makeTestRepo();
    const bin = await mkdtemp(join(tmpdir(), 'cq-adopter-bin-'));
    const priorPath = process.env['PATH'] ?? '';
    const priorLog = process.env['CQ_NODE_LOG'];
    const nodeLog = join(bin, 'node-calls.log');
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fresh-adopter' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'fake-check', args: [] } }],
        }),
      );
      await repo.write('src/a.ts', 'export const a = true;\n');
      repo.commitAll('fresh adopter config');
      await writeFile(join(bin, 'fake-check'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(
        join(bin, 'gitleaks'),
        `#!${process.execPath}\nconst fs=require("node:fs"); const a=process.argv; fs.writeFileSync(a[a.indexOf("--report-path")+1],"[]");\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, 'node'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CQ_NODE_LOG"\nexit 97\n',
        { mode: 0o755 },
      );
      process.env['PATH'] = `${bin}:${priorPath}`;
      process.env['CQ_NODE_LOG'] = nodeLog;
      const op = (await entryByName('dev.check').importer()) as (input: unknown) => Promise<{
        status: string;
        value?: { gates: { name: string; status: string }[] };
      }>;
      const result = await op({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(result.value?.gates).toContainEqual(
        expect.objectContaining({ name: 'denylist-scan', status: 'pass' }),
      );
      expect(
        await import('node:fs/promises').then((fs) =>
          fs.readFile(join(repo.root, 'policy/denylist/patterns.yml'), 'utf8').catch(() => ''),
        ),
      ).toBe('');
      const nodeCalls = await import('node:fs/promises').then((fs) =>
        fs.readFile(nodeLog, 'utf8').catch(() => ''),
      );
      expect(nodeCalls).not.toContain('scripts/denylist-scan');
    } finally {
      process.env['PATH'] = priorPath;
      if (priorLog === undefined) delete process.env['CQ_NODE_LOG'];
      else process.env['CQ_NODE_LOG'] = priorLog;
      await repo.cleanup();
    }
  });

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

  test('dev.check: a range is <ref>..<ref>, never option-shaped', () => {
    const schema = entryByName('dev.check').inputSchema;
    expect(schema.safeParse({ repoRoot: '/repo', range: 'origin/main..HEAD' }).success).toBe(true);
    for (const range of ['--output=x..HEAD', 'HEAD', 'a.. b', '..HEAD']) {
      expect(schema.safeParse({ repoRoot: '/repo', range }).success).toBe(false);
    }
  });

  test('dev.disposition: a blank reason is refused at the schema', () => {
    const schema = entryByName('dev.disposition').inputSchema;
    expect(schema.safeParse({ ...minimalInput('dev.disposition'), why: '   ' }).success).toBe(
      false,
    );
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
