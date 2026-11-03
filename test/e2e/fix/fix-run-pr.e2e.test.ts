import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import {
  fixture,
  git,
  gitleaks,
  input,
  reportOf,
  scripted,
  seedPrBase,
} from './fix-run-shared.js';

test.each([false, true])(
  'opt-in PR assembly uses only committed markers and records forge failure (%s)',
  async (fail) => {
    const f = await fixture();
    await seedPrBase(f);
    const called: string[] = [];
    try {
      const result = await makeFixRun({
        drivers: scripted(),
        registry: {
          get: (name) => {
            if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
            return {
              name,
              inputSchema: z.unknown(),
              importer: async () => async (raw: unknown) => {
                called.push(name);
                if (name === 'pr.assemblePrs') {
                  expect((raw as { packages: unknown[] }).packages).toHaveLength(1);
                  if (fail) return { status: 'failed', error: 'fixture forge refused' };
                }
                return { status: 'ok', value: { offline: true } };
              },
            } as unknown as OpRegistryEntry<never, never>;
          },
        },
      })({ ...input(f), pr: true });
      const report = reportOf(result);
      expect(result.status, JSON.stringify(result)).toBe(fail ? 'failed' : 'ok');
      expect(called).toEqual(['pr.ensureTrackerBranch', 'pr.assemblePrs']);
      expect(report.assembly?.jobs).toHaveLength(2);
      expect(report.fixesPerRun).toBe(2);
      expect(report.units[0]?.report?.pushed).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('PR body links pushed failed-attempt evidence in its Unfixed section', async () => {
  const f = await fixture();
  await seedPrBase(f);
  let packageBody = '';
  try {
    await git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/example/scratch.git');
    await git(f.repo, 'remote', 'set-url', '--push', 'origin', f.origin);
    await git(
      f.repo,
      'config',
      `url.${f.origin}.insteadOf`,
      'https://github.com/example/scratch.git',
    );
    const result = await makeFixRun({
      drivers: scripted('fail-b-safe-change'),
      registry: {
        get: (name) => {
          if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
          return {
            name,
            inputSchema: z.unknown(),
            importer: async () => async (raw: unknown) => {
              if (name === 'pr.assemblePrs') {
                const packages = (raw as { packages: Array<{ body?: string }> }).packages;
                expect(packages).toHaveLength(1);
                packageBody = packages[0]?.body ?? '';
              }
              return { status: 'ok', value: { offline: true } };
            },
          } as unknown as OpRegistryEntry<never, never>;
        },
      },
    })({ ...input(f), pr: true, pushFailed: true });

    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(packageBody).toContain('## Unfixed (1)');
    expect(packageBody).toContain('`cases/b.test.cjs`');
    expect(packageBody).toContain('[compare](https://github.com/example/scratch/compare/');
    expect(packageBody).toContain('...cq/fixture/failed/');
    expect(packageBody).toContain('diagnostic retained in local report');
    expect(packageBody).not.toContain('validation refused task');
    expect((await gitleaks.calls()).length).toBeGreaterThan(0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each(['denylist hit', 'scanner fault'] as const)(
  'PR body upload is refused on a %s while retaining local failed evidence',
  async (caseName) => {
    const f = await fixture();
    await seedPrBase(f);
    const dispatched: string[] = [];
    let scannedBody = '';
    try {
      if (caseName === 'denylist hit')
        await writeFile(
          join(f.repo, 'upload-policy.yml'),
          "rules:\n  - id: fixture-secret\n    description: PR body fixture secret\n    regex: 'diagnostic retained in local report'\n    sample: 'diagnostic retained in local report'\nclean_probes:\n  - 'safe'\n",
        );
      const result = await makeFixRun({
        drivers: scripted('fail-b-safe-change'),
        ...(caseName === 'scanner fault'
          ? {
              prBodyScanner: async (components) => {
                expect(components).toHaveLength(1);
                scannedBody = components[0]?.text ?? '';
                throw new Error('synthetic PR body scanner fault');
              },
            }
          : {}),
        registry: {
          get: (name) => {
            if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
            return {
              name,
              inputSchema: z.unknown(),
              importer: async () => async () => {
                dispatched.push(name);
                return { status: 'ok', value: { offline: true } };
              },
            } as unknown as OpRegistryEntry<never, never>;
          },
        },
      })({
        ...input(f),
        pr: true,
      });
      const report = reportOf(result);
      const failed = report.tasks.find((task) => task.outcome !== 'fixed');
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(failed?.reason).toContain('validation refused task');
      expect(failed?.failedAttempt).toBeDefined();
      expect(report.failed.length).toBeGreaterThan(0);
      expect(report.assembly).toBeUndefined();
      expect(dispatched).toEqual([]);
      if (caseName === 'scanner fault') {
        expect(scannedBody).toContain('## Unfixed (1)');
        expect(scannedBody).toContain('diagnostic retained in local report');
        expect(scannedBody).not.toContain('validation refused task');
      }
      if (caseName === 'denylist hit' && result.status === 'needs-human')
        expect(result.reason).toContain('fixture-secret');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('PR summary Unfixed section reads final refined planned rows (issue 615 #1)', async () => {
  const f = await fixture();
  await seedPrBase(f);
  let packageBody = '';
  try {
    // The failure that strands the unit leaves the run's planned rows empty
    // until the pre-assembly refresh; the uploaded Unfixed section must still
    // name the retained-branch row from the final accounting.
    const result = await makeFixRun({
      drivers: scripted('fail-b-safe-change'),
      registry: {
        get: (name) => {
          if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
          return {
            name,
            inputSchema: z.unknown(),
            importer: async () => async (raw: unknown) => {
              if (name === 'pr.assemblePrs') {
                const packages = (raw as { packages: Array<{ body?: string }> }).packages;
                packageBody = packages[0]?.body ?? '';
              }
              return { status: 'ok', value: { offline: true } };
            },
          } as unknown as OpRegistryEntry<never, never>;
        },
      },
    })({ ...input(f), pr: true, pushFailed: true });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(packageBody).toContain('## Unfixed (1)');
    expect(packageBody).toContain('`cases/b.test.cjs`');
    // The planned accounting behind the body matches the persisted report.
    const report = reportOf(result);
    expect(report.planned.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PR summary keeps an exhausted task when another unit retained the same task ID (#631)', async () => {
  const f = await fixture();
  await seedPrBase(f);
  const bodies = new Map<string, string>();
  try {
    await writeFile(
      join(f.repo, 'cases', 'c.test.cjs'),
      'module.exports = { actual: 1, expected: 2 };\n',
    );
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      checks: unknown[];
    };
    config.checks.push({ ...(config.checks[0] as object) });
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'seed two units with matching task paths');

    const drivers: DriverFactory = {
      resolve: ({ modelSpec }) => ({
        modelSpec,
        lane: 'ai-sdk',
        driver: {
          run: async (request, options) => {
            if (!request.workspace) throw new Error('fixture requires a workspace');
            const line = request.prompt.split('\n').find((text) => text.startsWith('Task: '));
            const task = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
            const unit2 = request.prompt.includes(join('tests-2', 'scratch-repo'));
            const failingFile = task.files.find(
              (file) => file.includes('b.test') || file.includes('c.test'),
            );
            if (failingFile && (!unit2 || failingFile.includes('b.test'))) {
              await writeFile(
                join(request.workspace.path, failingFile),
                'module.exports = { actual: 1, expected: 3 };\n',
              );
              return {
                stopReason: unit2 ? 'budget' : 'complete',
                denials: [],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                structuredOutput: {
                  outcome: 'broken-test',
                  summary: 'wrong fix',
                  confidence: 0.8,
                },
              } as const;
            }
            return scripted().resolve({ role: 'fixer', modelSpec }).driver.run(request, options);
          },
        },
      }),
    };
    const result = await makeFixRun({
      drivers,
      registry: {
        get: (name) => {
          if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
          return {
            name,
            inputSchema: z.unknown(),
            importer: async () => async (raw: unknown) => {
              if (name === 'pr.assemblePrs') {
                const packages = (
                  raw as {
                    packages: Array<{ branch: string; body?: string }>;
                  }
                ).packages;
                for (const pkg of packages) bodies.set(pkg.branch, pkg.body ?? '');
              }
              return { status: 'ok', value: { offline: true } };
            },
          } as unknown as OpRegistryEntry<never, never>;
        },
      },
    })({ ...input(f), pr: true });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    const unit1 = 'cq/fixture/tests-1/scratch-repo';
    const unit2 = 'cq/fixture/tests-2/scratch-repo';
    const retained = report.planned.find(
      (row) => row.branch === unit1 && row.task.id === 'cases/c.test.cjs',
    );
    const exhausted = report.planned.find(
      (row) => row.branch === unit2 && row.task.id === 'cases/c.test.cjs',
    );
    expect(retained?.failures.some((failure) => 'branch' in failure)).toBe(true);
    expect(exhausted?.outcome).toBe('exhausted');
    expect(exhausted?.attempts).toHaveLength(0);
    expect(exhausted?.failures.every((failure) => !('branch' in failure))).toBe(true);
    expect(bodies.size).toBe(2);
    expect(bodies.get(unit1)).toContain('cases/c.test.cjs');
    expect(bodies.get(unit1)).toContain('local branch');
    expect(bodies.get(unit2)).toContain('cases/c.test.cjs');
    expect(bodies.get(unit2)).toContain('exhausted;');
    expect(bodies.get(unit2)).not.toContain('failed/tests-1/');
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PR summary carries branchless refined rows before finalization (issue 615 #1)', async () => {
  const f = await fixture(1000);
  await seedPrBase(f);
  let packageBody = '';
  try {
    await writeFile(
      join(f.repo, 'cases', 'c.test.cjs'),
      'module.exports = { actual: 1, expected: 2 };\n',
    );
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'seed third failing task');
    const calls: string[] = [];
    const drivers: DriverFactory = {
      resolve: ({ modelSpec }) => ({
        modelSpec,
        lane: 'ai-sdk',
        driver: {
          run: async (invocation) => {
            if (!invocation.workspace) throw new Error('fixture requires a workspace');
            const line = invocation.prompt.split('\n').find((text) => text.startsWith('Task: '));
            const task = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
            calls.push(task.files[0] ?? '');
            if (task.files.some((file) => file.includes('a.test')))
              await writeFile(
                join(invocation.workspace.path, 'cases/a.test.cjs'),
                'module.exports = { actual: 1, expected: 1 };\n',
              );
            if (task.files.some((file) => file.includes('b.test')))
              await writeFile(
                join(invocation.workspace.path, 'cases/b.test.cjs'),
                'module.exports = { actual: 1, expected: 3 };\n',
              );
            return {
              stopReason: 'complete',
              denials: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              structuredOutput: {
                outcome: 'broken-test',
                summary: 'attempt',
                confidence: 0.8,
              },
            };
          },
        },
      }),
    };
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      budgets?: { run: { maxTokens: number } };
    };
    config.budgets = { run: { maxTokens: 5 } };
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'configure tighter budget');
    // The predecessor built the Unfixed section from report.planned, which
    // was empty until finish() — the branchless exhausted row for c and the
    // never-started remainder were omitted from the uploaded body. The body
    // must now carry them BEFORE finalization.
    const result = await makeFixRun({
      drivers,
      registry: {
        get: (name) => {
          if (!['pr.ensureTrackerBranch', 'pr.assemblePrs'].includes(name)) return undefined;
          return {
            name,
            inputSchema: z.unknown(),
            importer: async () => async (raw: unknown) => {
              if (name === 'pr.assemblePrs') {
                const packages = (raw as { packages: Array<{ body?: string }> }).packages;
                packageBody = packages[0]?.body ?? '';
              }
              return { status: 'ok', value: { offline: true } };
            },
          } as unknown as OpRegistryEntry<never, never>;
        },
      },
    })({ ...input(f), pr: true });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(packageBody).toContain('## Unfixed (');
    expect(packageBody).toContain('`cases/c.test.cjs`');
    // The retained-branch row still names its local branch in the same body.
    expect(packageBody).toContain('`cases/b.test.cjs`');
    expect(packageBody).toContain('local branch `cq/fixture');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each(['v1.0', 'feature/unfetched'])(
  'PR refusal identifies explicit unavailable base %s',
  async (base) => {
    const f = await fixture();
    try {
      const result = await makeFixRun({ drivers: scripted() })({ ...input(f), pr: true, base });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain(JSON.stringify(base));
        expect(result.reason).toContain('branch on origin');
        expect(result.reason).not.toContain('set base explicitly');
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
