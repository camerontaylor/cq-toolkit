import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runCli } from '../../../src/cli/main.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { readCommittedMarkers } from '../../../src/ops/sweep/unit.js';

vi.setConfig({ testTimeout: 30_000 });

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', ['-C', cwd, ...args], { env: scrubbedGitEnv(), timeout: 10_000 })
  ).stdout.trim();
async function fixture(budget: number | undefined = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'cq-fix-e2e-'));
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  await mkdir(join(repo, 'cases'));
  await writeFile(
    join(repo, 'upload-policy.yml'),
    "rules:\n  - id: fixture-secret\n    description: fixture secret\n    regex: 'DO_NOT_UPLOAD'\n    sample: 'DO_NOT_UPLOAD'\nclean_probes:\n  - 'safe'\n",
  );
  for (const name of ['a', 'b'])
    await writeFile(
      join(repo, 'cases', `${name}.test.cjs`),
      'module.exports = { actual: 1, expected: 2 };\n',
    );
  await writeFile(
    join(repo, 'scripts', 'tests.cjs'),
    `
const fs = require('node:fs');
const files = process.argv.slice(2).filter(x => x !== '--');
const names = files.length ? files : ['cases/a.test.cjs', 'cases/b.test.cjs'];
let failed = false;
const testResults = names.map(name => {
 const { actual, expected } = require(require('node:path').resolve(name));
 const passes = actual === expected;
 failed ||= !passes;
 return { name: require('node:path').resolve(name), status: passes ? 'passed' : 'failed', assertionResults: [{fullName: name, status: passes ? 'passed' : 'failed', failureMessages: passes ? [] : ['expected ' + expected + ', received ' + actual]}] };
});
// Related checks may emit files; those must never become worker edits.
if (files.length) fs.writeFileSync('check-output.txt', 'generated');
console.log(JSON.stringify({success: !failed, numTotalTests: names.length, testResults}));
process.exitCode = failed ? 1 : 0;
`,
  );
  const config = {
    schemaVersion: 2,
    review: { denylistPatternsFile: 'upload-policy.yml' },
    checks: [
      {
        kind: 'tests',
        adapter: 'vitest-json',
        command: { command: process.execPath, args: ['scripts/tests.cjs'] },
        relatedArgs: ['scripts/tests.cjs', '{files}'],
      },
    ],
    roles: { worker: { provider: 'fixture', model: 'scripted' } },
    ...(budget === undefined ? {} : { budgets: { run: { maxTokens: budget } } }),
  };
  await writeFile(join(repo, 'cq.json'), JSON.stringify(config));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'seed failing tests');
  const origin = join(root, 'origin.git');
  await exec('git', ['init', '--bare', origin], { env: scrubbedGitEnv() });
  await git(repo, 'remote', 'add', 'origin', origin);
  return { root, repo, origin, journalDir: join(root, 'journal') };
}
function scripted(mode: 'fix' | 'fail-b' | 'none' = 'fix'): DriverFactory {
  return {
    resolve: ({ modelSpec }) => ({
      modelSpec,
      lane: 'ai-sdk',
      driver: {
        run: async (invocation) => {
          if (!invocation.workspace) throw new Error('fixture requires a workspace');
          expect(invocation.sessionRef).toBeUndefined();
          const line = invocation.prompt.split('\n').find((line) => line.startsWith('Task: '));
          const task = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
          for (const file of task.files)
            if (mode === 'fix' || (mode === 'fail-b' && !file.includes('b.test'))) {
              await writeFile(
                join(invocation.workspace.path, file),
                'module.exports = { actual: 1, expected: 1 };\n',
              );
            }
          return {
            stopReason: 'complete',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            structuredOutput: {
              outcome: 'broken-test',
              summary: 'correct fixture expectation',
              confidence: 0.8,
            },
          };
        },
      },
    }),
  };
}
const input = (f: Awaited<ReturnType<typeof fixture>>) => ({
  repoRoot: f.repo,
  source: 'tests' as const,
  selector: { mode: 'workspace-all' as const },
  journalDir: f.journalDir,
  runPrefix: 'cq/fixture',
});
const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>>) =>
  result.status === 'ok' ? result.value : (result.report as FixRunReport);

test('fresh fixture fixes both tests through real git gates without pushing', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted() })(input(f));
    const report = reportOf(result);
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(report.fixesPerRun).toBe(2);
    expect(report.tasks.map((task) => task.attempts.length)).toEqual([2, 2]);
    expect(
      report.tasks.every((task) => task.validation?.gates.every((gate) => gate.verdict === 'pass')),
    ).toBe(true);
    expect(await git(f.repo, 'log', '--format=%s', report.tasks[0]?.branch ?? '')).toContain(
      'fix(test):',
    );
    expect(await git(f.repo, 'log', '-1', '--format=%B', report.tasks[0]?.branch ?? '')).toContain(
      'Confidence: 0.8',
    );
    expect(await git(f.origin, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(await git(f.repo, 'status', '--porcelain')).toBe('');
    const tree = await git(f.repo, 'ls-tree', '-r', '--name-only', report.tasks[0]?.branch ?? '');
    expect(tree).not.toContain('check-output.txt');
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    expect(report.usage.input).toBe(4);
    if (process.env.CQ_FIX_TRANSCRIPT_PATH) {
      await mkdir(dirname(process.env.CQ_FIX_TRANSCRIPT_PATH), { recursive: true });
      await writeFile(
        process.env.CQ_FIX_TRANSCRIPT_PATH,
        '# fix.run tests fixture transcript\n\nCaptured by the fresh-fixture scripted-driver acceptance test. Real git, offline checks, no provider calls.\n\nEquivalent CLI input: `cq fix.run --source=tests --selector=\'{"mode":"workspace-all"}\' --json` with fixture repoRoot and journalDir. The SDK factory injects the scripted agent; the production registry uses the configured driver factory.\n\n```json\n' +
          JSON.stringify(
            {
              status: result.status,
              value: {
                ...report,
                run: undefined,
                units: report.units.map((unit) => ({
                  jobId: unit.jobId,
                  result: { status: unit.result.status },
                })),
              },
            },
            null,
            2,
          ).replaceAll(f.root, '<fixture>') +
          '\n```\n',
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('one failing task preserves evidence while a passing sibling remains committed', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('fail-b') })(input(f));
    expect(result.status).toBe('failed');
    expect(reportOf(result).tasks.map((task) => task.outcome)).toEqual(['fixed', 'unfixed']);
    expect(reportOf(result).fixesPerRun).toBe(1);
    expect(reportOf(result).tasks[1]?.preservedEdits).toBeUndefined();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test.each(['protectTests', 'proposeOnly'] as const)(
  '%s reports both proposals with no commits',
  async (flag) => {
    const f = await fixture();
    try {
      const result = await makeFixRun({ drivers: scripted() })({ ...input(f), [flag]: true });
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(reportOf(result).tasks).toHaveLength(2);
      expect(
        reportOf(result).tasks.every(
          (task) => task.commits.length === 0 && task.preservedEdits?.ref,
        ),
      ).toBe(true);
      expect(reportOf(result).tasks.every((task) => task.outcome === 'escalated-to-human')).toBe(
        true,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
test('budget stop pushes earlier verified commits and retains spend and task evidence', async () => {
  const f = await fixture(6);
  try {
    const result = await makeFixRun({ drivers: scripted() })({ ...input(f), push: true });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    expect(report.tasks[0]?.outcome).toBe('fixed');
    expect(report.tasks[1]?.outcome).toBe('unfixed');
    expect(await git(f.origin, 'rev-parse', report.tasks[0]?.branch ?? '')).toBe(
      report.tasks[0]?.commits[0],
    );
    expect(report.usage.input).toBe(3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test.each(['needs-human', 'failed'] as const)(
  'CLI keeps the %s report artifact and I1 exit',
  async (status) => {
    const f = await fixture();
    try {
      if (status === 'needs-human') {
        const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
          budgets?: unknown;
        };
        delete config.budgets;
        await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
      } else await writeFile(join(f.repo, 'package.json'), '{broken');
      let out = '';
      const code = await runCli(
        [
          'fix.run',
          `--repoRoot=${f.repo}`,
          '--source=tests',
          '--selector={"mode":"workspace-all"}',
          `--journalDir=${f.journalDir}`,
          '--json',
        ],
        {
          stdout: (text) => {
            out += text;
          },
          stderr: () => {},
        },
      );
      expect(code).toBe(status === 'needs-human' ? 3 : 1);
      const artifact = JSON.parse(out) as { status: string; report: FixRunReport };
      expect(artifact.status).toBe(status);
      expect(artifact.report.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(JSON.parse(await readFile(artifact.report.reportPath, 'utf8'))).toEqual(
        artifact.report,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('rerun retries a failed publish of verified multi-task commits without new workers', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const first = await makeFixRun({ drivers: scripted() })({ ...input(f), push: true });
    const report = reportOf(first);
    expect(first.status).toBe('failed');
    expect(report.fixesPerRun).toBe(2);
    expect(report.units[0]?.report?.indeterminate).toContain('publish failed');
    await unlink(join(f.origin, 'hooks', 'pre-receive'));
    await git(f.repo, 'config', 'remote.origin.url', f.origin);
    const second = await makeFixRun({ drivers: scripted('none') })({ ...input(f), push: true });
    const resumed = reportOf(second);
    expect(second.status, JSON.stringify(second)).toBe('ok');
    expect(resumed.tasks).toEqual([]);
    expect(resumed.usage.input).toBe(0);
    expect(resumed.units[0]?.report?.pushed).toBe(true);
    const markers = await readCommittedMarkers(
      f.repo,
      join(f.journalDir, 'worktrees'),
      'cq/fixture',
      join(f.journalDir, 'state'),
    );
    expect(markers.map((marker) => marker.branch)).toContain(report.tasks[0]?.branch);
    expect(resumed.units[0]?.report?.committedSha).toBe(report.tasks.at(-1)?.commits[0]);
    expect(await git(f.origin, 'rev-parse', report.tasks[0]?.branch ?? '')).toBe(
      report.tasks.at(-1)?.commits[0],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'opt-in PR assembly uses only committed markers and records forge failure (%s)',
  async (fail) => {
    const f = await fixture();
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

test.each(['absolute', 'relative'] as const)(
  'nested check cwd preserves repo-root task identity (%s failure names)',
  async (names) => {
    const f = await fixture();
    try {
      const pkg = join(f.repo, 'packages', 'demo');
      await mkdir(join(pkg, 'cases'), { recursive: true });
      await mkdir(join(pkg, 'scripts'));
      for (const name of ['a', 'b'])
        await writeFile(
          join(pkg, 'cases', name + '.test.cjs'),
          'module.exports = { actual: 1, expected: 2 };\n',
        );
      let script = await readFile(join(f.repo, 'scripts', 'tests.cjs'), 'utf8');
      if (names === 'relative')
        script = script.replace("name: require('node:path').resolve(name)", 'name');
      await writeFile(join(pkg, 'scripts', 'tests.cjs'), script);
      const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
        checks: Array<{ command: { cwd?: string } }>;
      };
      config.checks[0]!.command.cwd = 'packages/demo';
      await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
      await git(f.repo, 'add', '-A');
      await git(f.repo, 'commit', '-m', 'nested check');
      const result = await makeFixRun({ drivers: scripted() })({
        repoRoot: f.repo,
        source: 'tests',
        selector: { mode: 'workspace-all' },
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('ok');
      const report = result.report ?? (result.status === 'ok' ? result.value : undefined);
      expect(report?.fixesPerRun).toBe(2);
      expect(report?.tasks.map((t) => t.task.files)).toEqual([
        ['packages/demo/cases/a.test.cjs'],
        ['packages/demo/cases/b.test.cjs'],
      ]);
      const branch = report?.tasks[0]?.branch ?? '';
      expect(await git(f.repo, 'show', branch + ':cases/a.test.cjs')).toContain('expected: 2');
      expect(await git(f.repo, 'show', branch + ':packages/demo/cases/a.test.cjs')).toContain(
        'expected: 1',
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test.each(['active', 'entry', 'after-first'] as const)(
  'enclosing governed cancellation (%s) retains evidence and stops publication',
  async (mode) => {
    const f = await fixture();
    const controller = new AbortController();
    let observed = false;
    let workerCalls = 0;
    let parentSignal: AbortSignal | undefined;
    let result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>> | undefined;
    try {
      const drivers: DriverFactory = {
        resolve: ({ modelSpec }) => ({
          modelSpec,
          lane: 'ai-sdk',
          driver: {
            run: async (_request, options) => {
              workerCalls++;
              if (mode === 'after-first' && workerCalls <= 2)
                return scripted()
                  .resolve({ role: 'fixer', modelSpec })
                  .driver.run(_request, options);
              const signal = options?.signal;
              if (!signal) throw new Error('missing inner worker signal');
              expect(signal.aborted).toBe(false);
              controller.abort();
              observed = signal.aborted;
              return {
                stopReason: 'aborted',
                denials: [],
                usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                wallMs: 0,
              };
            },
          },
        }),
      };
      const entry: OpRegistryEntry = {
        name: 'fixture.fix',
        inputSchema: z.object({}),
        importer: async () => async () => {
          parentSignal = currentJobContext()?.signal;
          if (mode === 'entry') controller.abort();
          result = await makeFixRun({ drivers })({
            repoRoot: f.repo,
            source: 'tests',
            selector: { mode: 'workspace-all' },
            journalDir: f.journalDir,
            push: true,
          });
          // The parent op keeps its own strict result while the separate report survives.
          return { status: 'ok', value: 'settled' };
        },
      };
      await runPlan(
        { id: 'enclosing', jobs: [{ id: 'fix', op: entry.name, input: {} }] },
        { concurrency: 1, stopOnError: false },
        { get: () => entry as unknown as OpRegistryEntry<never, never> },
        {
          governor: createGovernor({ maxTokens: 1000 }),
          signal: controller.signal,
          allowAdvisory: true,
        },
      );
      expect(parentSignal?.aborted).toBe(true);
      expect(observed).toBe(mode !== 'entry');
      expect(workerCalls).toBe(mode === 'entry' ? 0 : mode === 'after-first' ? 3 : 1);
      expect(result?.status).toBe('needs-human');
      expect(result?.report?.tasks.flatMap((task) => task.commits)).toHaveLength(
        mode === 'after-first' ? 1 : 0,
      );
      expect(await git(f.origin, 'for-each-ref', '--format=%(refname)')).toBe('');
      expect(JSON.parse(await readFile(result?.report?.reportPath ?? '', 'utf8'))).toEqual(
        result?.report,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
