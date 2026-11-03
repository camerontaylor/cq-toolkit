// Shared fixtures for the observation-wiring.*.test.ts files split out of the
// former test/ops/fix/observation-wiring.test.ts: the scratch repo the fix
// composition accepts, the unit report a stubbed sweep returns, the stubbed
// sweep registries, the scripted fixing driver and the input/report accessors.
// The per-file `roots` bookkeeping stays with each test file (it is the
// afterEach cleanup list every file still mutates), so `fixtureIn` takes that
// list instead of owning it. Fake/local inputs only: no provider, no network,
// no credentials. This module declares no tests.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts, observation-wiring.unknown-evidence.test.ts,
// observation-wiring.failure-boundary.test.ts and
// observation-wiring.attempt-evidence.test.ts.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import type { SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const execIn = async (cwd: string, ...args: string[]): Promise<void> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['-C', cwd, ...args], {
    env: scrubbedGitEnv(),
    timeout: 10_000,
  });
};

const scratchIn = async (roots: string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 't30-obs-'));
  roots.push(root);
  return root;
};

/** A scratch repo with a cq.json the composition accepts. */
export const fixtureIn = async (
  roots: string[],
): Promise<{ root: string; repo: string; journalDir: string }> => {
  const root = await scratchIn(roots);
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  await writeFile(
    join(repo, 'cq.json'),
    JSON.stringify({
      schemaVersion: 2,
      checks: [
        {
          kind: 'tests',
          adapter: 'vitest-json',
          command: { command: process.execPath, args: ['scripts/tests.cjs'] },
          relatedArgs: ['scripts/tests.cjs', '{files}'],
        },
      ],
      roles: { worker: { provider: 'fixture', model: 'scripted' } },
      budgets: { run: { maxTokens: 1000 } },
    }),
  );
  await execIn(repo, 'add', '-A');
  await execIn(repo, 'commit', '-m', 'seed failing tests');
  return { root, repo, journalDir: join(root, 'journal') };
};

export const fixingDrivers = (): DriverFactory => ({
  resolve: ({ modelSpec }) => ({
    modelSpec,
    lane: 'ai-sdk',
    driver: {
      run: async (invocation) => {
        if (!invocation.workspace) throw new Error('fixture requires a workspace');
        const line = invocation.prompt.split('\n').find((line) => line.startsWith('Task: '));
        const taskRow = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
        for (const file of taskRow.files)
          await writeFile(
            join(invocation.workspace.path, file),
            'module.exports = { actual: 1, expected: 1 };\n',
          );
        return {
          stopReason: 'complete',
          denials: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          structuredOutput: { outcome: 'broken-test', summary: 'fixed', confidence: 0.8 },
        };
      },
    },
  }),
});

export const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>>) =>
  result.status === 'ok' ? result.value : (result.report as FixRunReport);

export const fixedUnitReport = (): SweepUnitReport => ({
  package: 'scratch-repo',
  fixer: 'tests-1',
  worktree: {
    path: join('tmp', 'worktree'),
    branch: 'cq/fixture/tests-1/scratch-repo',
    requestedBase: 'HEAD',
    reused: false,
    clearedBaselineCaches: [],
    refusedBaselineCaches: [],
  },
  mode: 'fix',
  baseline: {
    verdict: 'failing',
    attempts: 1,
    failureSet: { tool: 'vitest', failures: [], exitCode: 1, numTotalTests: 1 },
  },
  final: {
    verdict: 'clean',
    attempts: 1,
    failureSet: { tool: 'vitest', failures: [], exitCode: 0, numTotalTests: 0 },
  },
  prBranch: 'cq/fixture/tests-1/scratch-repo',
  committed: true,
  committedSha: 'a'.repeat(40),
  tasks: [],
});

export const stubSweepRegistries = (
  unitReport: SweepUnitReport,
  seen: { input?: unknown } = {},
) => {
  const unitJob = {
    id: 'fixture-unit',
    op: 'sweep.unit',
    input: { package: 'scratch-repo', fixer: 'tests-1', files: ['cases/a.test.cjs'] },
    dependsOn: [],
  };
  const planEntry = {
    name: 'sweep.planSweep',
    inputSchema: z.unknown(),
    importer: async () => async () => ({
      status: 'ok' as const,
      value: { jobs: [unitJob], units: [unitJob.input], suppressed: [], needsHuman: [] },
    }),
  } as unknown as OpRegistryEntry<never, never>;
  const unitEntry = {
    name: 'sweep.unit',
    inputSchema: z.unknown(),
    importer: async () =>
      (async (raw: unknown) => {
        seen.input = raw;
        return { status: 'ok' as const, value: unitReport };
      }) as unknown as Op<unknown, unknown>,
  } as unknown as OpRegistryEntry<never, never>;
  const entries = new Map([planEntry, unitEntry].map((entry) => [entry.name, entry]));
  return (name: string): OpRegistryEntry<never, never> | undefined => entries.get(name);
};

export const input = (f: Awaited<ReturnType<typeof fixtureIn>>) => ({
  repoRoot: f.repo,
  source: 'tests' as const,
  selector: { mode: 'workspace-all' as const },
  journalDir: f.journalDir,
  runPrefix: 'cq/fixture',
});
