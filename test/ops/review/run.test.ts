import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runCli } from '../../../src/cli/main.js';
import type { CliIo } from '../../../src/cli/output.js';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { cycleRecord, dispositionRecord } from '../dev/fakes.js';
import { repoEffects, makeTestRepo, seed } from '../dev/repo.js';

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
          run: async (input: { prompt: string }) => {
            onRun?.(input);
            // The engine records delivery from the real serialized ai-sdk
            // request shape, not from the model's output.
            await request.beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: input.prompt }] }),
              [{ text: input.prompt }],
              { kind: 'model-request' },
            );
            return {
              stopReason: 'complete' as const,
              structuredOutput: {
                findings: [{ severity: 'high', text: 'seeded' }],
              },
              usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      }),
    ),
  } as unknown as DriverFactory;
}

describe('review.run', () => {
  it('requires a readable cq.json before starting a review', async () => {
    const repo = await makeTestRepo();
    try {
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root });
      expect(result).toEqual({ status: 'needs-human', reason: 'review.run: cq.json is required' });
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('maps an unresolvable target to needs-human before starting a reviewer', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root, target: 'missing-target' });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('origin/missing-target');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it.each([
    [
      'a dropped connection (con_err) is marked blockedTransient',
      'Review failed: con_err: webSocket connection failed',
      true,
    ],
    ['any other CLI error is not', 'Review failed: auth_required', false],
    [
      'a dropped connection followed by an auth error is not',
      'Review failed: con_err: socket closed\nAUTH',
      false,
    ],
  ] as const)('#509: %s', async (_label, message, transient) => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 1,
              stdout: message
                .split('\nAUTH')
                .map((text, index) =>
                  index === 0
                    ? `${JSON.stringify({ type: 'error', errorType: 'review', message: text, recoverable: false })}\n`
                    : `${JSON.stringify({ type: 'error', errorType: 'review', message: 'Review failed: auth_err: login required', recoverable: false })}\n`,
                )
                .join(''),
              stderr: 'Error: An unexpected error occurred.',
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
      expect(result.report?.blockedTransient).toBe(transient ? true : undefined);
    } finally {
      await repo.cleanup();
    }
  });

  it('normalizes a successful CodeRabbit-only cycle and persists its finding', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 0,
              stdout:
                `${JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'seeded CodeRabbit finding' })}\n` +
                `${JSON.stringify({ type: 'complete', status: 'review_completed' })}\n`,
              stderr: '',
              timedOut: false,
            }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.sources).toEqual([
        expect.objectContaining({ kind: 'coderabbit', status: 'terminal' }),
      ]);
      expect(result.value.findings).toEqual([
        expect.objectContaining({
          source: 'coderabbit',
          severity: 'major',
          file: 'src/a.ts',
          text: 'seeded CodeRabbit finding',
          status: 'open',
        }),
      ]);
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

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
          `const drivers = { resolve: (request) => ({ lane: 'ai-sdk', modelSpec: { provider: 'mock', model: 'mock' }, driver: { run: async (invocation) => { await request.beforeRequest?.(JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }), [{ text: invocation.prompt }], { kind: 'model-request' }); return { stopReason: 'complete', structuredOutput: { findings: [{ file: 'src/a.ts', line: 1, rule: 'fixture', severity: 'high', text: 'Seeded fixture finding' }] }, usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, denials: [] }; } } }) };\n` +
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

  it('refuses reviewer dispatch when the denylist scan finds protected content', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({
            component: component.component,
            hits: [{ ruleId: 'fixture-secret', lines: [1] }],
          })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked source when cq.json requests an agent without a reviewer role', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('configure agent review without a role');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual({
        kind: 'agent',
        status: 'blocked',
        reason: 'cq.json roles.reviewer is required for an agent review',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('persists an agent source blocked by the required token budget', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('configure agent review without a token budget');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      const agent = stored.sources.find((source) => source.kind === 'agent');
      expect(agent?.status).toBe('blocked');
      expect(agent?.reason).toContain('Agentic runs require budgets.run.maxTokens');
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked agent source when git cannot list the review diff', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) =>
        command === 'git' && args[0] === 'diff' && args.includes('--name-only')
          ? { exitCode: 2, stdout: '', stderr: 'diff unavailable', timedOut: false }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'could not list review diff paths (exit 2)',
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('scans and reviews the full content of untracked files', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const scanned: { path: string; text: string }[] = [];
      let prompt = '';
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => {
          prompt += input.prompt;
        }),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          scanned.push(...components.map(({ path, text }) => ({ path, text })));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(scanned).toContainEqual({
        path: 'src/untracked.ts',
        text: 'export const pending = true;\n',
      });
      expect(prompt).toContain('src/untracked.ts');
      expect(prompt).toContain('export const pending = true;');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to scan when an untracked file cannot be read safely', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const effects = repoEffects(repo);
      effects.readWorktreeFile = async () => ({ ok: false, reason: 'fixture symlink refusal' });
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('fixture symlink refusal');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked agent source when a per-file diff command fails', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) =>
        command === 'git' &&
        args[0] === 'diff' &&
        args.includes('--text') &&
        args.at(-1) === 'src/a.ts'
          ? { exitCode: 2, stdout: '', stderr: 'patch unavailable', timedOut: false }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: "could not collect diff for 'src/a.ts' (exit 2)",
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses reviewer dispatch when repository state changes during the scan', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          await repo.write('src/a.ts', 'export const a = 99;\n');
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('state changed after the scan');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('records an agent cycle blocked by the model token budget', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async () => ({
              stopReason: 'budget' as const,
              structuredOutput: { findings: [] },
              usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            }),
          },
        })),
      } as unknown as DriverFactory;
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result).toMatchObject({ report: { blockedBudget: true } });
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      const ledger = effects.openLedger('feature/x').load();
      expect(ledger.records).toContainEqual(
        expect.objectContaining({
          kind: 'cycle',
          reviewer: 'agent:reviewer',
          completion: expect.objectContaining({
            kind: 'blocked',
            reason: expect.stringContaining('agent review budget exhausted') as unknown,
          }) as unknown,
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('returns indeterminate when the dispatched agent review log cannot be written', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, () => undefined, {
        writeReviewLog: async () => {
          throw new Error('log disk full');
        },
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('log disk full');
      expect(effects.openLedger('feature/x').load().records).toEqual([]);
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
      const state = await seed(repo, (current) => [
        cycleRecord({
          cycleId: `c002-${current.head.slice(0, 8)}`,
          reviewer: 'agent:reviewer',
          base: current.base,
          head: current.head,
          dirtySha256: current.dirtySha256,
          target: 'merge-queue',
          at: '2026-10-24T00:00:00.000Z',
        }),
      ]);
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
        sources: { kind: string; status: string; reason?: string; cycleId?: string }[];
      };
      {
        const agent = stored.sources.find((source) => source.kind === 'agent');
        expect(agent?.status).toBe('blocked');
        expect(agent?.reason?.includes('invalid structured output')).toBe(true);
      }
      const ledger = repoEffects(repo).openLedger(state.branch).load();
      const latestAgent = ledger.records
        .filter((record) => record.kind === 'cycle' && record.reviewer === 'agent:reviewer')
        .at(-1);
      expect(latestAgent).toMatchObject({
        kind: 'cycle',
        completion: expect.objectContaining({
          kind: 'blocked',
          reason: expect.stringContaining(
            'agent review returned invalid structured output',
          ) as unknown,
        }) as unknown,
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
        target: 'merge-queue',
        scope: 'full',
      });
      if (!latestAgent || latestAgent.kind !== 'cycle') throw new Error('missing agent cycle');
      const readiness = assembleReadiness({
        branch: state.branch,
        target: 'merge-queue',
        identity: {
          base: state.base,
          head: state.head,
          dirtySha256: state.dirtySha256,
        },
        ledger: { version: DEV_LEDGER_VERSION, branch: state.branch, records: ledger.records },
        untracked: state.untracked,
        configuredReviewers: ['agent'],
        nowIso: '2026-10-24T00:00:00.000Z',
      });
      expect(readiness.ready).toBe(false);
      if (!readiness.ready)
        expect(
          readiness.gaps.find((gap) => gap.field === 'latest-review-blocked')?.detail,
        ).toContain(latestAgent.cycleId);
      expect(stored.sources.find((source) => source.kind === 'agent')?.cycleId).toBe(
        latestAgent.cycleId,
      );
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
          prompt += input.prompt;
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

  it('keeps protected rename provenance visible to the scanner and refuses reviewer upload', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const syntheticPrivateBytes = ['synthetic', 'corpus', 'marker', '7f3'].join('-');
      await repo.write('.env.config', `${syntheticPrivateBytes}\n`);
      repo.commitAll('add synthetic private fixture');
      repo.git('push', '-q', 'origin', 'HEAD:merge-queue');
      repo.git('mv', '.env.config', 'config.txt');
      repo.commitAll('rename synthetic private fixture');

      const drivers = scriptedDrivers();
      const scanned: { path: string; text: string }[] = [];
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          scanned.push(...components.map(({ path, text }) => ({ path, text })));
          return components.map((component) => ({
            component: component.component,
            hits:
              component.path === '.env.config' && component.text.includes(syntheticPrivateBytes)
                ? [{ ruleId: 'fixture-private-path', lines: [1] }]
                : [],
          }));
        },
      })({ repoRoot: repo.root });

      const oldPathComponent = scanned.find((component) => component.path === '.env.config');
      expect(oldPathComponent?.text).toContain(syntheticPrivateBytes);
      expect(scanned.some((component) => component.path === 'config.txt')).toBe(true);
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.length).toBeGreaterThan(1);
      expect(diffCalls.every((call) => call.args.includes('--no-renames'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('allows a public file rename after scanning both path sides', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      repo.git('rm', 'package.json');
      repo.commitAll('remove optional package metadata');
      await repo.write('src/public.txt', 'ordinary public fixture\n');
      repo.commitAll('add public fixture');
      repo.git('push', '-q', 'origin', 'HEAD:merge-queue');
      repo.git('mv', 'src/public.txt', 'src/public-renamed.txt');
      repo.commitAll('rename public fixture');

      const drivers = scriptedDrivers();
      const scanned = new Set<string>();
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          components.forEach(({ path }) => scanned.add(path));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });

      expect(scanned).toContain('src/public.txt');
      expect(scanned).toContain('src/public-renamed.txt');
      expect(result.status).toBe('ok');
      expect(drivers.resolve).toHaveBeenCalledTimes(1);
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.every((call) => call.args.includes('--no-renames'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a thrown per-path diff command to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) => {
        if (
          command === 'git' &&
          args[0] === 'diff' &&
          args.includes('--text') &&
          args.at(-1) === 'src/a.ts'
        )
          throw new Error('diff process unavailable');
        return undefined;
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('diff process unavailable');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a thrown untracked-file read to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const effects = repoEffects(repo);
      effects.readWorktreeFile = async () => {
        throw new Error('worktree read unavailable');
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('worktree read unavailable');
    } finally {
      await repo.cleanup();
    }
  });
});

it.each(['deadline', 'parent'] as const)(
  'remaining review budget stops CodeRabbit and later providers: %s',
  async (mode) => {
    const repo = await makeTestRepo();
    let clock = Date.now();
    const originalNow = Date.now;
    try {
      await configureAgentRepo(repo);
      const controller = new AbortController();
      const effects = repoEffects(repo, (command) => {
        if (command !== 'coderabbit') return undefined;
        if (mode === 'deadline') clock += 1001;
        else controller.abort(new Error('parent stopped reviewer'));
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({
              type: 'finding',
              severity: 'major',
              fileName: 'src/a.ts',
              comment: 'partial finding',
            }),
            JSON.stringify({ type: 'complete', status: 'review_completed' }),
          ].join('\n'),
          stderr: '',
          timedOut: false,
        };
      });
      const originalRun = effects.runCommand;
      effects.runCommand = async (command, args, opts) => {
        if (command === 'coderabbit') {
          expect(opts.timeoutMs).toBe(1000);
          expect(opts.signal).toBeDefined();
        }
        return originalRun(command, args, opts);
      };
      const drivers = scriptedDrivers();
      let persisted: unknown;
      Date.now = () => clock;
      const result = await makeReviewRun({
        drivers,
        parentSignal: controller.signal,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
        writeFindingsRecord: async (_path, content) => {
          persisted = JSON.parse(content);
        },
      })({ repoRoot: repo.root, wallMs: 1000, reviewers: ['coderabbit', 'agent'] });
      expect(result.status).toBe('needs-human');
      if (mode === 'deadline') expect(result).toMatchObject({ report: { blockedBudget: true } });
      else expect(result).not.toMatchObject({ report: { blockedBudget: true } });
      expect(drivers.resolve).not.toHaveBeenCalled();
      expect(persisted).toMatchObject({
        findings: [expect.objectContaining({ text: 'partial finding', status: 'open' })],
      });
      const cycles = effects
        .openLedger('feature/x')
        .load()
        .records.filter((entry) => entry.kind === 'cycle');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
      expect(cycles[0]?.findings).toHaveLength(1);
    } finally {
      Date.now = originalNow;
      await repo.cleanup();
    }
  },
);

it.each([false, true])(
  'persists immutable reviewed base and scope for uncommitted=%s',
  async (uncommitted) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/a.ts', 'export const a = 2;\n');
      repo.commitAll('reviewed clean candidate');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, uncommitted });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const reviewed = {
        base: uncommitted
          ? repo.git('rev-parse', 'HEAD').trim()
          : repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
        scope: uncommitted ? 'uncommitted' : 'full',
      };
      expect(result.value.reviewed).toEqual(reviewed);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [file] = await readdir(folder);
      expect(JSON.parse(await readFile(join(folder, file!), 'utf8')) as unknown).toMatchObject({
        reviewed,
      });
    } finally {
      await repo.cleanup();
    }
  },
);

it('persists completed findings as blocked when the source changes during the agent review', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write('src/a.ts', 'export const a = 2;\n');
    const drivers = scriptedDrivers(() => {
      repo.git('checkout', '--', 'src/a.ts');
    });
    let persisted: unknown;
    const result = await makeReviewRun({
      drivers,
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map(({ component }) => ({ component, hits: [] })),
      writeFindingsRecord: async (_path, content) => {
        persisted = JSON.parse(content);
      },
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(persisted).toMatchObject({
      sources: [
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'repository state changed during agent review',
        }),
      ],
      findings: [expect.objectContaining({ text: 'seeded' })],
    });
    expect(persisted).not.toHaveProperty('reviewed');
  } finally {
    await repo.cleanup();
  }
});

it('sends commit intent and the numstat file list through the scanned session prompt', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write('src/intent.ts', 'export const intent = 1;\n');
    repo.commitAll('feat: capture INTENT_MARKER\n\nexplains the change');
    const prompts: string[] = [];
    const scanned: { component: string; text: string }[] = [];
    const result = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) => {
        scanned.push(...components.map(({ component, text }) => ({ component, text })));
        return components.map((component) => ({ component: component.component, hits: [] }));
      },
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    const prompt = prompts.join('\n');
    expect(prompt).toContain('INTENT_MARKER');
    expect(prompt).toContain('explains the change');
    expect(prompt).toContain('## Changed files');
    expect(prompt).toMatch(/\d+\t\d+\tsrc\/intent\.ts/);
    expect(scanned).toContainEqual(
      expect.objectContaining({
        component: 'review-prompt',
        text: expect.stringContaining('INTENT_MARKER') as unknown,
      }),
    );
  } finally {
    await repo.cleanup();
  }
});

it('forwards prior findings only when reReview.includePriorFindings is enabled', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const writeConfig = async (includePriorFindings: boolean) => {
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'], reReview: { includePriorFindings } },
        }),
      );
      repo.commitAll(`review.reReview.includePriorFindings=${String(includePriorFindings)}`);
    };
    const priorFindings = [
      {
        id: 'c001#f1',
        source: 'agent',
        file: 'src/a.ts',
        line: 1,
        rule: 'fixture',
        severity: 'major',
        text: 'PRIOR_FINDING_MARKER',
        status: 'fixed' as const,
        reason: 'addressed in the previous round',
      },
    ];
    const prompts: string[] = [];
    await writeConfig(true);
    const included = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, priorFindings });
    expect(included.status).toBe('ok');
    expect(prompts.join('\n')).toContain('PRIOR_FINDING_MARKER');
    expect(prompts.join('\n')).toContain('addressed in the previous round');

    prompts.length = 0;
    await writeConfig(false);
    const excluded = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, priorFindings });
    expect(excluded.status).toBe('ok');
    expect(prompts.join('\n')).not.toContain('PRIOR_FINDING_MARKER');
  } finally {
    await repo.cleanup();
  }
});

it('threads review.size and review.exclude, persisting advisories outside findings', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: {
          reviewers: ['agent'],
          size: {
            small: { maxChangedLines: 0, maxFiles: 0 },
            medium: { maxChangedLines: 1000, maxFiles: 100 },
          },
          exclude: [{ pattern: '**' }],
        },
      }),
    );
    repo.commitAll('configure review size and exclusions');
    const effects = repoEffects(repo);
    const drivers = scriptedDrivers();
    const result = await makeReviewRun({
      drivers,
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings).toEqual([]);
    expect(result.value.advisories).toEqual([
      'agent review covered no content: all components excluded',
    ]);
    expect(result.value.sources[0]?.coverage).toMatchObject({
      version: 2,
      mode: 'session',
      pieces: expect.arrayContaining([
        expect.objectContaining({
          state: 'excluded',
          exclusion: expect.objectContaining({
            rule: '**',
            limitation: expect.any(String) as unknown,
          }) as unknown,
        }),
      ]) as unknown,
    });
    expect(drivers.resolve).not.toHaveBeenCalled();
    const cycle = effects
      .openLedger('feature/x')
      .load()
      .records.find((entry) => entry.kind === 'cycle' && entry.reviewer === 'agent:reviewer');
    expect(cycle).toMatchObject({
      advisories: ['agent review covered no content: all components excluded'],
    });
    expect(effects.logs[0]).toContain('mode=session');
    expect(effects.logs[0]).toContain('limitation=');
    expect(effects.logs[0]).toContain(
      'advisories: agent review covered no content: all components excluded',
    );
  } finally {
    await repo.cleanup();
  }
});

it('threads review.session maxInputChars and forces the recorded partitioned fallback', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: { reviewers: ['agent'], session: { maxInputChars: 1 } },
      }),
    );
    repo.commitAll('configure a tiny session budget');
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.sources[0]?.coverage).toMatchObject({
      version: 2,
      mode: 'partitioned',
      modeReason: 'over session input budget',
    });
    expect(result.value.advisories).toContainEqual(expect.stringContaining('partitioned fallback'));
    expect(effects.logs[0]).toContain('mode=partitioned');
  } finally {
    await repo.cleanup();
  }
});

it('threads review.size thresholds into the reviewer instructions', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: {
          reviewers: ['agent'],
          size: {
            small: { maxChangedLines: 0, maxFiles: 0 },
            medium: { maxChangedLines: 1000, maxFiles: 100 },
          },
        },
      }),
    );
    repo.commitAll('configure review size thresholds');
    const prompts: string[] = [];
    const result = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(prompts.join('\n')).toContain('Prioritise contracts other code depends on');
  } finally {
    await repo.cleanup();
  }
});

it('keeps blocked evidence when an engine report carries malformed coverage', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const effects = repoEffects(repo);
    const malformed = { version: 999, nonsense: true };
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
      runAgentReviewer: async () => ({
        status: 'needs-human',
        reason: 'fixture engine blocked',
        report: {
          findings: [],
          usage: 1,
          coverage: malformed as never,
          advisories: ['fixture advisory'],
          limitations: ['fixture limitation'],
        },
      }),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result.report?.sources[0]).toMatchObject({
      kind: 'agent',
      status: 'blocked',
      reason: 'fixture engine blocked',
    });
    expect(result.report?.sources[0]).not.toHaveProperty('coverage');
    expect(result.report?.advisories).toEqual(['fixture advisory']);
    expect(effects.logs[0]).toContain('"version":999');
    const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
    const [recordFile] = await readdir(folder);
    const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
      sources: { kind: string; status: string; coverage?: unknown }[];
    };
    expect(persisted.sources[0]).toMatchObject({ kind: 'agent', status: 'blocked' });
    expect(persisted.sources[0]).not.toHaveProperty('coverage');
  } finally {
    await repo.cleanup();
  }
});

it('maps blocked partial findings to the ledger cycle so a disposition closes them', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
      runAgentReviewer: async () => ({
        status: 'needs-human',
        reason: 'fixture engine blocked',
        report: {
          findings: [
            {
              id: 'session-1-1',
              source: 'agent',
              severity: 'major',
              text: 'blocked partial finding',
              status: 'open',
            },
          ],
          usage: 1,
          coverage: undefined as never,
          advisories: ['blocked advisory'],
          limitations: [],
        },
      }),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    const ledger = effects.openLedger('feature/x').load();
    const cycle = ledger.records.find(
      (entry) => entry.kind === 'cycle' && entry.reviewer === 'agent:reviewer',
    );
    if (cycle?.kind !== 'cycle') throw new Error('missing agent cycle');
    const findingId = cycle.findings[0]?.id;
    expect(findingId).toBe(`c001-${cycle.head.slice(0, 8)}#f1`);
    expect(result.report?.findings).toEqual([
      expect.objectContaining({ id: findingId, text: 'blocked partial finding' }),
    ]);
    expect(result.report?.advisories).toEqual(['blocked advisory']);

    const readiness = assembleReadiness({
      branch: ledger.branch,
      target: 'merge-queue',
      identity: {
        base: cycle.base,
        head: cycle.head,
        dirtySha256: cycle.dirtySha256,
      },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: ledger.branch,
        records: [
          ...ledger.records,
          dispositionRecord({
            findingId: findingId!,
            action: 'fixed',
            why: 'fixture disposition closes the blocked partial finding',
            head: cycle.head,
          }),
        ],
      },
      untracked: [],
      configuredReviewers: ['agent'],
      nowIso: '2026-10-26T00:00:00.000Z',
    });
    expect(readiness.ready).toBe(false);
    if (!readiness.ready)
      expect(readiness.gaps.some((gap) => gap.field === 'open-blocking-findings')).toBe(false);
  } finally {
    await repo.cleanup();
  }
});

it('shares the review deadline signal with intent and numstat reads', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const controller = new AbortController();
    const inner = repoEffects(repo);
    const contextCalls: {
      args: readonly string[];
      timeoutMs: number;
      signal?: AbortSignal;
    }[] = [];
    const effects = {
      ...inner,
      runCommand: async (
        command: string,
        args: readonly string[],
        options: { timeoutMs: number; cwd?: string; signal?: AbortSignal },
      ) => {
        if (
          command === 'git' &&
          (args[0] === 'log' || (args[0] === 'diff' && args.includes('--numstat')))
        ) {
          contextCalls.push({
            args: [...args],
            timeoutMs: options.timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          const result = await inner.runCommand(command, args, options);
          if (args[0] === 'diff') controller.abort(new Error('fixture cancel after numstat'));
          return result;
        }
        return inner.runCommand(command, args, options);
      },
    };
    const drivers = scriptedDrivers();
    const result = await makeReviewRun({
      drivers,
      parentSignal: controller.signal,
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(contextCalls.map((call) => call.args[0])).toEqual(['log', 'diff']);
    expect(contextCalls[0]?.signal).toBeDefined();
    expect(contextCalls[0]?.signal).toBe(contextCalls[1]?.signal);
    expect(contextCalls[1]?.signal?.aborted).toBe(true);
    expect(contextCalls.every((call) => call.timeoutMs > 0)).toBe(true);
    expect(drivers.resolve).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  } finally {
    await repo.cleanup();
  }
});

it.each(['auth', 'mixed', 'coverage', 'drift', 'scan', 'thrown'] as const)(
  '#532: coincident deadline never attributes %s failure to the budget',
  async (mode) => {
    const repo = await makeTestRepo();
    const originalNow = Date.now;
    let clock = originalNow();
    try {
      await configureAgentRepo(repo);
      Date.now = () => clock;
      const result = await makeReviewRun({
        // 'thrown' faults the driver under the real reviewer seam (never a raw
        // throw past the engine): a coincident deadline must not reclassify an
        // unexpected fault as a budget stop.
        drivers: scriptedDrivers(() => {
          if (mode === 'thrown') {
            clock += 1001;
            throw new Error('unexpected reviewer fault');
          }
        }),
        effectsFactory: () =>
          repoEffects(repo, (command) => {
            if (command !== 'coderabbit') return undefined;
            if (mode === 'auth') clock += 1001;
            return {
              exitCode: 1,
              stdout: 'Review failed: auth_required',
              stderr: '',
              timedOut: false,
            };
          }),
        scannerFactory: () => async (components) => {
          if (mode === 'scan') {
            clock += 1001;
            throw new Error('scan refused');
          }
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
        // No injected reviewer for 'thrown', so the real seam runs. No .catch
        // fallback either: the engine must refuse with a structured result,
        // and a thrown engine error fails the test instead of being laundered
        // into a report-less needs-human object that satisfies both
        // assertions vacuously.
        ...(mode === 'thrown'
          ? {}
          : {
              runAgentReviewer: async () => {
                clock += 1001;
                if (mode === 'drift') repo.git('commit', '--allow-empty', '-m', 'drift');
                return mode === 'coverage'
                  ? { status: 'needs-human' as const, reason: 'coverage incomplete' }
                  : { status: 'budget-exhausted' as const };
              },
            }),
      })({
        repoRoot: repo.root,
        wallMs: 1000,
        reviewers: mode === 'auth' || mode === 'mixed' ? ['coderabbit', 'agent'] : ['agent'],
      });
      expect(result.status).toBe('needs-human');
      expect(result).not.toMatchObject({ report: { blockedBudget: true } });
    } finally {
      Date.now = originalNow;
      await repo.cleanup();
    }
  },
);

it('#532: an agent wall stop is attributed through the real review engine', async () => {
  const repo = await makeTestRepo();
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    await configureAgentRepo(repo);
    Date.now = () => clock;
    const result = await makeReviewRun({
      drivers: scriptedDrivers(() => {
        clock += 10001;
      }),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, wallMs: 10000 });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ report: { blockedBudget: true } });
  } finally {
    Date.now = originalNow;
    await repo.cleanup();
  }
});
