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

async function configureAgentRepo(repo: Awaited<ReturnType<typeof makeTestRepo>>): Promise<void> {
  await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
  await repo.write(
    'cq.json',
    JSON.stringify({
      schemaVersion: 2,
      checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      roles: { reviewer: { provider: 'mock', model: 'mock' } },
      budgets: { run: { maxTokens: 500 } },
      review: { reviewers: ['agent'] },
    }),
  );
  repo.commitAll('fixture agent review setup');
}

function scriptedDrivers(onRun?: (input: { prompt: string }) => void) {
  return {
    resolve: vi.fn(() => ({
      lane: 'ai-sdk',
      modelSpec: { provider: 'mock', model: 'mock' },
      driver: {
        run: async (input: { prompt: string }) => {
          onRun?.(input);
          return {
            stopReason: 'complete' as const,
            structuredOutput: { findings: [{ severity: 'high', text: 'seeded' }] },
            usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    })),
  } as unknown as DriverFactory;
}

describe('review.run', () => {
  it('dispatches the fresh unauthenticated-CodeRabbit fixture through the CLI', async () => {
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
          `const drivers = { resolve: () => ({ lane: 'ai-sdk', modelSpec: { provider: 'mock', model: 'mock' }, driver: { run: async () => ({ stopReason: 'complete', structuredOutput: { findings: [{ file: 'src/a.ts', line: 1, rule: 'fixture', severity: 'high', text: 'Seeded fixture finding' }] }, usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, denials: [] }) } }) };\n` +
          `export const registry = [{ ...entry, importer: async () => makeReviewRun({ drivers, effectsFactory: makeSubprocessDevEffects, scannerFactory: () => async (components) => components.map((component) => ({ component: component.component, hits: [] })) }) }];\n`,
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
      const artifact = JSON.parse(out.join('')) as { status: string; reason: string };
      expect(artifact).toEqual({
        status: 'needs-human',
        reason:
          'review.run: not every configured reviewer completed a terminal cycle; the findings record, including partial findings, was persisted',
      });
      const headPrefix = repo.git('rev-parse', 'HEAD').trim().slice(0, 8);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string }[];
        findings: { id: string; source: string; text: string }[];
      };
      expect(persisted.sources).toEqual([
        {
          kind: 'coderabbit',
          status: 'blocked',
          cycleId: `c001-${headPrefix}`,
          reason: expect.any(String),
        },
        { kind: 'agent', status: 'terminal', cycleId: `c002-${headPrefix}` },
      ]);
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
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async (invocation: { toolPolicy: { mode?: string }; outputSchema?: unknown }) => {
              expect(invocation.toolPolicy.mode).toBe('none');
              expect(invocation.outputSchema).toBeDefined();
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
        })),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
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
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps findings from a blocked CodeRabbit cycle in the portable record', async () => {
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
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 1,
              stdout: `${JSON.stringify({ type: 'finding', severity: 'critical', fileName: 'src/a.ts', comment: 'partial critical evidence' })}\n`,
              stderr: 'review interrupted',
              timedOut: false,
            }
          : undefined,
      );
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string }[];
        findings: { id: string; source: string; severity: string; file?: string; text: string }[];
      };
      const source = persisted.sources.find((item) => item.kind === 'coderabbit');
      expect(source).toMatchObject({ kind: 'coderabbit', status: 'blocked' });
      expect(source?.cycleId).toMatch(/^c001-/);
      expect(persisted.findings).toContainEqual(
        expect.objectContaining({
          id: `${source?.cycleId}#f1`,
          source: 'coderabbit',
          severity: 'critical',
          file: 'src/a.ts',
          text: 'partial critical evidence',
          status: 'open',
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports uncertainty when a blocked cycle ledger cannot be read back', async () => {
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
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? { exitCode: 1, stdout: '', stderr: 'not authenticated', timedOut: false }
          : undefined,
      );
      const openLedger = effects.openLedger.bind(effects);
      effects.openLedger = (branch) => {
        const ledger = openLedger(branch);
        return {
          ...ledger,
          load: () => {
            throw new Error('ledger read fault');
          },
        };
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('ledger read fault');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a diff command rejection to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const run = effects.runCommand;
      effects.runCommand = async (command, args, options) => {
        if (
          command === 'git' &&
          args[0] === 'diff' &&
          args.includes('--no-textconv') &&
          args.includes('--name-only')
        )
          throw new Error('spawn failed');
        return run(command, args, options);
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('spawn failed');
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts an adopter target and immutable base pin consistently', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      repo.git('push', '-q', 'origin', 'origin/merge-queue:refs/heads/main');
      repo.git('fetch', '-q', 'origin');
      const base = repo.git('rev-parse', 'HEAD~1').trim();
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, target: 'main', base });
      expect(result.status).toBe('ok');
      const ledger = effects.openLedger('feature/x').load();
      const cycle = ledger.records.find((entry) => entry.kind === 'cycle');
      expect(cycle).toMatchObject({ target: 'main', base, reviewer: 'agent:reviewer' });
    } finally {
      await repo.cleanup();
    }
  });

  it('maps an invalid cq.json to needs-human before invoking a reviewer', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write('cq.json', '{ invalid');
      repo.commitAll('add malformed review config');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('not valid JSON');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a denylist scanner rejection to needs-human and refuses the upload', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async () => {
          throw new Error('scanner unavailable');
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('denylist scan failed closed');
    } finally {
      await repo.cleanup();
    }
  });

  it('returns indeterminate when the dev ledger mutation fails after the agent review', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const openLedger = effects.openLedger.bind(effects);
      effects.openLedger = (branch) => ({
        ...openLedger(branch),
        mutate: async () => {
          throw new Error('ledger locked');
        },
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({
        repoRoot: repo.root,
      });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('ledger locked');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps findings storage preparation failures to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('.cq/review', 'block the findings directory');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({
        repoRoot: repo.root,
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('prepare findings');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a findings record persistence failure to indeterminate', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        writeFindingsRecord: async () => {
          throw new Error('storage unavailable');
        },
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('storage unavailable');
    } finally {
      await repo.cleanup();
    }
  });

  it('records a failed agent response as a blocked source', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async () => ({
              stopReason: 'complete' as const,
              structuredOutput: { unexpected: true },
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            }),
          },
        })),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('not every configured reviewer completed');
        const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
        expect(await readdir(folder)).toContain('1.json');
      }
      const stored = JSON.parse(
        await readFile(join(repo.root, '.cq', 'review', 'feature%2Fx', '1.json'), 'utf8'),
      ) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      {
        const agent = stored.sources.find((source) => source.kind === 'agent');
        expect(agent?.status).toBe('blocked');
        expect(agent?.reason?.includes('invalid structured output')).toBe(true);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('chooses the next numeric findings record index and ignores other entries', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      await repo.write('.cq/review/feature%2Fx/3.json', '{}');
      await repo.write('.cq/review/feature%2Fx/notes.txt', 'not an index');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(await readdir(folder)).toContain('4.json');
    } finally {
      await repo.cleanup();
    }
  });

  it('scans tracked paths separately and includes staged plus unstaged changes without textconv', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/staged.ts', 'export const staged = true;\n');
      repo.git('add', 'src/staged.ts');
      await repo.write('src/a.ts', 'export const a = 2;\n');
      const effects = repoEffects(repo);
      const scanned: string[] = [];
      let prompt = '';
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => {
          prompt = input.prompt;
        }),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          scanned.push(...components.map((component) => component.path));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root, uncommitted: true });
      expect(result.status).toBe('ok');
      expect(scanned).toContain('src/staged.ts');
      expect(scanned).toContain('src/a.ts');
      expect(prompt).toContain('src/staged.ts');
      expect(prompt).toContain('src/a.ts');
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.every((call) => call.args.includes('--no-textconv'))).toBe(true);
      const patchCalls = diffCalls.filter((call) =>
        ['src/staged.ts', 'src/a.ts'].includes(call.args.at(-1) ?? ''),
      );
      expect(patchCalls.every((call) => call.args.includes('--text'))).toBe(true);
      expect(patchCalls.every((call) => !call.args.includes('--binary'))).toBe(true);
      expect(diffCalls.some((call) => call.args.includes('HEAD'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('exposes binary tracked file text to the fail-closed pre-upload scanner', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/payload.bin', 'baseline\0safe\n');
      repo.commitAll('add binary base content');
      const sentinel = ['port', 'key-secret-fixture'].join('');
      await repo.write('src/payload.bin', `changed\0${sentinel}\n`);
      const scanned: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          scanned.push(...components.map((component) => component.text));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(scanned.some((text) => text.includes(sentinel))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
