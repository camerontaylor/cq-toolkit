import { managedBlocked } from '../dev/reviewTestKit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runCli } from '../../../src/cli/main.js';
import type { CliIo } from '../../../src/cli/output.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo } from './run.helpers.js';

describe('review.run', () => {
  it('dispatches a queue-blocked managed CodeRabbit fixture through the application CLI', async () => {
    const repo = await makeTestRepo();
    const opsRoot = await mkdtemp(join(tmpdir(), 'cq-review-cli-ops-'));
    const bin = await mkdtemp(join(tmpdir(), 'cq-review-cli-bin-'));
    const priorPath = process.env['PATH'] ?? '';
    try {
      await configureAgentRepo(repo);
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('configure both review sources');
      await mkdir(join(opsRoot, 'review'));
      await writeFile(
        join(bin, 'coderabbit'),
        '#!/bin/sh\necho "not authenticated" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const registryUrl = pathToFileURL(join(process.cwd(), 'src/ops/review/registry.ts')).href;
      const runUrl = pathToFileURL(join(process.cwd(), 'src/ops/review/run.ts')).href;
      const effectsUrl = pathToFileURL(join(process.cwd(), 'src/ops/dev/effects.ts')).href;
      await writeFile(
        join(opsRoot, 'review/registry.js'),
        `import { registry as entries } from ${JSON.stringify(registryUrl)};\n` +
          `import { makeReviewRun } from ${JSON.stringify(runUrl)};\n` +
          `import { makeSubprocessDevEffects } from ${JSON.stringify(effectsUrl)};\n` +
          `const entry = entries.find((candidate) => candidate.name === 'review.run');\n` +
          `const drivers = { resolve: (request) => ({ lane: 'ai-sdk', modelSpec: { provider: 'mock', model: 'mock' }, driver: { run: async (invocation) => { await request.beforeRequest?.(JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }), [{ text: invocation.prompt }], { kind: 'model-request' }); return { stopReason: 'complete', structuredOutput: { findings: [{ file: 'src/a.ts', line: 1, rule: 'fixture', severity: 'high', text: 'Seeded fixture finding' }] }, usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, denials: [] }; } } }) };\n` +
          `export const registry = [{ ...entry, importer: async () => makeReviewRun({ managedSubmit: async () => ({ status: 'completed', value: { receiptId: 'b'.repeat(64), completion: { kind: 'blocked', reason: 'not authenticated' }, findings: [], advisories: [] } }), drivers, effectsFactory: makeSubprocessDevEffects, scannerFactory: () => async (components) => components.map((component) => ({ component: component.component, hits: [] })) }) }];\n`,
      );
      process.env['PATH'] = `${bin}:${priorPath}`;
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) };
      const code = await runCli(['review.run', `--repoRoot=${repo.root}`, '--json'], io, {
        opsRoot,
      });
      expect(code).toBe(3);
      expect(err).toEqual([]);
      const artifact = JSON.parse(out.join('')) as {
        status: string;
        reason: string;
        report?: { sources: { kind: string; status: string }[] };
      };
      expect(artifact).toMatchObject({
        status: 'needs-human',
        reason:
          'review.run: not every configured reviewer completed a terminal cycle; the findings record, including partial findings, was persisted',
      });
      expect(artifact.report?.sources).toContainEqual(
        expect.objectContaining({ kind: 'agent', status: 'terminal' }),
      );
      const headPrefix = repo.git('rev-parse', 'HEAD').trim().slice(0, 8);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string; reason?: string }[];
        findings: { id: string; source: string; text: string }[];
      };
      expect(persisted.sources).toMatchObject([
        {
          kind: 'coderabbit',
          status: 'blocked',
          cycleId: `c001-${headPrefix}`,
        },
        { kind: 'agent', status: 'terminal', cycleId: `c002-${headPrefix}` },
      ]);
      expect(persisted.sources[0]?.reason).toContain('BLOCKED');
      expect(persisted.findings).toContainEqual(
        expect.objectContaining({
          id: `${persisted.sources[1]?.cycleId}#f1`,
          source: 'agent',
          text: 'Seeded fixture finding',
        }),
      );
    } finally {
      process.env['PATH'] = priorPath;
      await repo.cleanup();
      const { rm } = await import('node:fs/promises');
      await rm(opsRoot, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

  it('persists agent findings and records unauthenticated CodeRabbit as blocked', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('fixture review setup');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? { exitCode: 1, stdout: '', stderr: 'not authenticated', timedOut: false }
          : undefined,
      );
      let wire = '';
      const drivers = {
        resolve: vi.fn(
          (request: {
            beforeRequest?: (
              text: string,
              contents?: readonly { text: string }[],
              context?: { kind: 'model-request' | 'tool-output' },
            ) => void | Promise<void>;
          }) => ({
            lane: 'ai-sdk',
            modelSpec: { provider: 'mock', model: 'mock' },
            driver: {
              run: async (invocation: {
                prompt: string;
                toolPolicy: { mode?: string; allow?: string[] };
                outputSchema?: unknown;
              }) => {
                expect(invocation.toolPolicy.mode).toBe('allowlist');
                expect(invocation.toolPolicy.allow).toEqual(['read', 'grep', 'glob']);
                expect(invocation.outputSchema).toBeDefined();
                wire = JSON.stringify({
                  prompt: [{ role: 'user', content: invocation.prompt }],
                });
                await request.beforeRequest?.(wire, [{ text: invocation.prompt }], {
                  kind: 'model-request',
                });
                return {
                  stopReason: 'complete' as const,
                  structuredOutput: {
                    findings: [
                      {
                        file: 'src/a.ts',
                        line: 1,
                        rule: 'fixture',
                        severity: 'high',
                        text: 'Seeded fixture finding',
                      },
                    ],
                  },
                  usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                };
              },
            },
          }),
        ),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
        managedSubmit: managedBlocked('not authenticated'),
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('not every configured reviewer completed');
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string }[];
        findings: { id: string; source: string; text: string }[];
      };
      expect(persisted.sources).toContainEqual(
        expect.objectContaining({ kind: 'coderabbit', status: 'blocked' }),
      );
      expect(persisted.sources).toContainEqual(
        expect.objectContaining({ kind: 'agent', status: 'terminal' }),
      );
      expect(persisted.findings).toContainEqual(
        expect.objectContaining({
          source: 'agent',
          severity: 'major',
          text: 'Seeded fixture finding',
        }),
      );
      expect(persisted.findings).toHaveLength(1);
      expect(persisted.findings[0]?.id).toBe(
        `${persisted.sources.find((source) => source.kind === 'agent')?.cycleId}#f1`,
      );
      expect(wire).toContain('"role":"user"');
    } finally {
      await repo.cleanup();
    }
  });
});
