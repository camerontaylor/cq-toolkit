import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunReport, type FixRunResult } from '../../../src/ops/fix/runFix.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runCli } from '../../../src/cli/main.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { readCommittedMarkers } from '../../../src/ops/sweep/unit.js';

vi.setConfig({ testTimeout: 30_000 });

let gitleaks: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  gitleaks = await makeGitleaksFixture();
  vi.stubEnv('PATH', gitleaks.path);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(gitleaks.root, { recursive: true, force: true });
});

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', ['-C', cwd, ...args], { env: scrubbedGitEnv(), timeout: 10_000 })
  ).stdout.trim();
async function fixture(budget: number | undefined = 1000, configuredDenylist = true) {
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
const names = files.length ? files : fs.readdirSync('cases').filter(n => n.endsWith('.test.cjs')).sort().map(n => 'cases/' + n);
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
    ...(configuredDenylist ? { review: { denylistPatternsFile: 'upload-policy.yml' } } : {}),
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
function scripted(
  mode:
    | 'fix'
    | 'fail-b'
    | 'fail-b-safe-change'
    | 'none'
    | 'private-change'
    | 'throw-after-protected'
    | 'throw-after-secret'
    | 'throw-sensitive-diagnostic'
    | 'safe-change'
    | 'scan-fault' = 'fix',
): DriverFactory {
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
            if (
              mode === 'fix' ||
              ((mode === 'fail-b' || mode === 'fail-b-safe-change') && !file.includes('b.test'))
            ) {
              await writeFile(
                join(invocation.workspace.path, file),
                'module.exports = { actual: 1, expected: 1 };\n',
              );
            }
          if (mode === 'private-change')
            await writeFile(
              join(invocation.workspace.path, '.env.config'),
              'DO_NOT_UPLOAD=synthetic\n',
            );
          if (mode === 'scan-fault')
            await writeFile(
              join(invocation.workspace.path, '.env.config'),
              'SCANNER_FAULT=synthetic\n',
            );
          if (mode === 'throw-after-secret') {
            await writeFile(
              join(invocation.workspace.path, 'public-note.txt'),
              'DO_NOT_UPLOAD synthetic early failure\n',
            );
            throw new Error('scripted worker failure after edit');
          }
          if (mode === 'throw-after-protected') {
            await writeFile(join(invocation.workspace.path, 'package.json'), '{"name":"edited"}\n');
            throw new Error('scripted worker failure after protected edit');
          }
          if (mode === 'throw-sensitive-diagnostic') {
            await writeFile(join(invocation.workspace.path, 'public-note.txt'), 'safe content\n');
            throw new Error('DO_NOT_UPLOAD synthetic diagnostic');
          }
          if (mode === 'safe-change' || mode === 'fail-b-safe-change')
            await writeFile(
              join(invocation.workspace.path, 'public-note.txt'),
              'safe public content\n',
            );
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

test('spawned static CLI clusters real tsc diagnostics and commits each gated file-rule fix', async () => {
  const f = await fixture(1000, false);
  try {
    await mkdir(join(f.repo, 'src'), { recursive: true });
    await writeFile(
      join(f.repo, 'src/a.ts'),
      'export const value: string = 123;\nexport const bad = value.missing;\n',
    );
    await writeFile(join(f.repo, 'src/b.ts'), 'export const value: string = 123;\n');
    await writeFile(
      join(f.repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          types: [],
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      }),
    );
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    config.checks = [
      {
        kind: 'static',
        adapter: 'tsc-lines',
        command: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL('../../../node_modules/typescript/lib/tsc.js', import.meta.url)),
            '--noEmit',
            '--pretty',
            'false',
            '--project',
            'tsconfig.json',
          ],
        },
      },
      // Selection must exclude this unscoped ESLint check before worker dispatch.
      {
        kind: 'static',
        adapter: 'eslint-json',
        command: { command: process.execPath, args: ['must-not-run.cjs', '.'] },
      },
    ];
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'seed three static clusters');
    const argv = [
      fileURLToPath(new URL('../../fixtures/fix-cli/entry.mjs', import.meta.url)),
      'fix.run',
      '--source=static',
      '--checks=tsc',
      `--repoRoot=${f.repo}`,
      '--selector={"mode":"workspace-all"}',
      `--journalDir=${f.journalDir}`,
      '--runPrefix=cq/static-fixture',
      '--json',
    ];
    const { stdout, stderr } = await exec(process.execPath, argv, {
      env: scrubbedGitEnv(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as { status: string; value: FixRunReport };
    expect(result.status, stdout).toBe('ok');
    const report = result.value;
    expect(report.source).toBe('static');
    expect(report.tasks.map((task) => [task.task.files, task.task.failures[0]?.ruleId])).toEqual([
      [['src/a.ts'], 'TS2322'],
      [['src/a.ts'], 'TS2339'],
      [['src/b.ts'], 'TS2322'],
    ]);
    expect(report.tasks.map((task) => task.attempts.length)).toEqual([2, 2, 2]);
    expect(new Set(report.tasks.flatMap((task) => task.commits)).size).toBe(3);
    expect(
      report.tasks.every((task) => task.validation?.gates.every((gate) => gate.verdict === 'pass')),
    ).toBe(true);
    expect(
      report.tasks.every((task) =>
        task.validation?.gates
          .find((gate) => gate.gate === 'broader')
          ?.detail?.includes('base-owned staged tree'),
      ),
    ).toBe(true);
    expect(await git(f.repo, 'log', '-1', '--format=%B', report.tasks[0]?.branch ?? '')).toContain(
      'Outcome: code-bug',
    );
    expect(await git(f.origin, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(await git(f.repo, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    expect((await gitleaks.calls()).length).toBeGreaterThan(0);
    if (process.env.CQ_FIX_STATIC_TRANSCRIPT_PATH) {
      await writeFile(
        process.env.CQ_FIX_STATIC_TRANSCRIPT_PATH,
        '# fix.run static fixture transcript\n\nFresh repository; real installed TypeScript compiler, scripted driver, real git, hermetic gitleaks executable through production scanner composition. No project denylist, provider credentials, or network. The fixture entry injects only the driver; production CLI parsing and fix engine run unchanged.\n\nChecks select adapter aliases (`tsc`, `eslint`, `vitest`), as one alias or a JSON array; unknown or unavailable aliases refuse. Static ESLint requires explicit `checks[].relatedArgs` replacement argv with standalone `{files}`; `eslint .` must replace the broad target, never append files. Missing scope or literal . / ./ operands refuse before worker dispatch. Other wrapper/option semantics remain trusted configuration; arbitrary command scope is not proven. Tsc keeps the full configured project check; final related/broader validation shares one fresh base-owned staged-tree probe, while feedback remains mandatory.\n\nCommand: `node test/fixtures/fix-cli/entry.mjs fix.run --source=static --checks=tsc --repoRoot=<fixture>/repo --selector=\'{"mode":"workspace-all"}\' --journalDir=<fixture>/journal --runPrefix=cq/static-fixture --json`\n\nObserved process exit: `0`. Stderr: empty. Stdout (one JSON artifact; fixture paths redacted):\n\n```json\n' +
          JSON.stringify(result, null, 2).replaceAll(f.root, '<fixture>') +
          '\n```\n',
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('static ESLint wrapper scopes related argv to task files and keeps full broader argv', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, 'src'), { recursive: true });
    for (const name of ['a', 'b'])
      await writeFile(join(f.repo, `src/${name}.js`), 'const broken = true;\n');
    const callsPath = join(f.root, 'lint-calls.jsonl');
    await writeFile(
      join(f.repo, 'scripts/lint.cjs'),
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const files = args.includes('.') ? ['src/a.js', 'src/b.js'] : args;
let failed = false;
const results = files.map(file => {
 const broken = fs.readFileSync(file, 'utf8').includes('broken');
 failed ||= broken;
 return {filePath: require('node:path').resolve(file), messages: broken ? [{ruleId: 'no-broken', severity: 2, line: 1, column: 1, message: 'broken binding'}] : [], errorCount: broken ? 1 : 0, warningCount: 0};
});
console.log(JSON.stringify(results));
process.exitCode = failed ? 1 : 0;
`,
    );
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    config.checks = [
      {
        kind: 'static',
        adapter: 'eslint-json',
        command: { command: process.execPath, args: ['scripts/lint.cjs', '.'] },
        relatedArgs: ['scripts/lint.cjs', '{files}'],
      },
    ];
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'seed lint clusters');
    const drivers: DriverFactory = {
      resolve: ({ modelSpec }) => ({
        modelSpec,
        lane: 'ai-sdk',
        driver: {
          run: async (invocation) => {
            const line = invocation.prompt.split('\n').find((line) => line.startsWith('Task: '));
            const task = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
            for (const file of task.files)
              await writeFile(join(invocation.workspace!.path, file), 'const fixed = true;\n');
            return {
              stopReason: 'complete',
              denials: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              structuredOutput: {
                outcome: 'code-bug',
                summary: 'correct lint error',
                confidence: 0.8,
              },
            };
          },
        },
      }),
    };
    const result = await makeFixRun({ drivers })({
      ...input(f),
      source: 'static',
      checks: ['eslint'],
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(reportOf(result).tasks.map((task) => task.commits.length)).toEqual([1, 1]);
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args.includes('.')).length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((args) => !args.includes('.'))).toEqual([
      ['src/a.js'],
      ['src/a.js'],
      ['src/b.js'],
      ['src/b.js'],
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([
  undefined,
  ['.'],
  ['--files={files}'],
  ['.', '{files}', '--format=json'],
  ['scripts/lint.cjs', './', '{files}'],
])('static ESLint missing or invalid scope refuses before workers: %j', async (relatedArgs) => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    config.checks = [
      {
        kind: 'static',
        adapter: 'eslint-json',
        command: { command: process.execPath, args: ['eslint-wrapper.cjs', '.'] },
        ...(relatedArgs === undefined ? {} : { relatedArgs }),
      },
    ];
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', 'cq.json');
    await git(f.repo, 'commit', '-m', 'configure unscoped lint');
    const resolve = vi.fn(scripted().resolve);
    const result = await makeFixRun({ drivers: { resolve } })({
      ...input(f),
      source: 'static',
      checks: 'eslint',
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(JSON.stringify(result)).toContain('relatedArgs');
    expect(resolve).not.toHaveBeenCalled();
    expect(reportOf(result).tasks).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('unavailable check alias refuses before workers with a persisted report', async () => {
  const f = await fixture();
  try {
    const resolve = vi.fn(scripted().resolve);
    const result = await makeFixRun({ drivers: { resolve } })({ ...input(f), checks: ['tsc'] });
    expect(result.status).toBe('needs-human');
    expect(JSON.stringify(result)).toContain('unavailable');
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
      reportOf(result),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('fresh portable fixture CLI fixes both tests without a project denylist and exits zero', async () => {
  const f = await fixture(1000, false);
  try {
    const argv = [
      fileURLToPath(new URL('../../fixtures/fix-cli/entry.mjs', import.meta.url)),
      'fix.run',
      '--source=tests',
      `--repoRoot=${f.repo}`,
      '--selector={"mode":"workspace-all"}',
      `--journalDir=${f.journalDir}`,
      '--runPrefix=cq/fixture',
      '--json',
    ];
    const { stdout, stderr } = await exec(process.execPath, argv, {
      env: scrubbedGitEnv(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(stderr).toBe('');
    // execFile rejects nonzero exits: reaching this assertion proves CLI exit 0.
    const result = JSON.parse(stdout) as { status: string; value: FixRunReport };
    const report = result.value;
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
    expect((await gitleaks.calls()).length).toBeGreaterThan(0);
    if (process.env.CQ_FIX_TRANSCRIPT_PATH) {
      await mkdir(dirname(process.env.CQ_FIX_TRANSCRIPT_PATH), { recursive: true });
      await writeFile(
        process.env.CQ_FIX_TRANSCRIPT_PATH,
        '# fix.run tests fixture transcript\n\nFresh repository, scripted driver, real git and offline checks. A hermetic gitleaks executable supplies clean scan reports through the real subprocess scanner; the fixture entry injects the driver through the CLI ops-root seam; production CLI parsing, fix.run schema, fix engine and validation run unchanged.\n\nCommand: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector=\'{"mode":"workspace-all"}\' --journalDir=<fixture>/journal --runPrefix=cq/fixture --json`\n\nObserved process exit: `0`. Stderr: empty. Stdout (one JSON artifact; fixture paths redacted):\n\n```json\n' +
          JSON.stringify(result, null, 2).replaceAll(f.root, '<fixture>') +
          '\n```\n',
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('journal symlink alias preserves broader-probe task identity and commits both fixes', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'alias');
    await symlink(f.root, alias, 'dir');
    const result = await makeFixRun({ drivers: scripted() })({
      ...input(f),
      journalDir: join(alias, 'journal'),
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const report = reportOf(result);
    expect(report.tasks.map((task) => task.task.files)).toEqual([
      ['cases/a.test.cjs'],
      ['cases/b.test.cjs'],
    ]);
    expect(
      report.tasks.every(
        (task) =>
          task.commits.length === 1 &&
          task.validation?.gates.every((gate) => gate.verdict === 'pass'),
      ),
    ).toBe(true);
    expect(report.fixesPerRun).toBe(2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('one failing task has a failed-attempt commit while a passing sibling remains committed', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('fail-b') })(input(f));
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).tasks.map((task) => task.outcome)).toEqual([
      'fixed',
      'escalated-to-human',
    ]);
    expect(reportOf(result).fixesPerRun).toBe(1);
    expect(reportOf(result).tasks[1]?.failedAttempt?.branch).toMatch(
      /^cq\/fixture\/failed\/tests-1\/scratch-repo\/.*\/a\d+$/,
    );
    expect(
      reportOf(result)
        .failed.filter((attempt) => 'branch' in attempt)
        .map((attempt) => attempt.branch.split('/').at(-1)),
    ).toEqual(['a1', 'a2']);
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
          (task) => task.commits.length === 0 && task.failedAttempt?.branch,
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
test('pushFailed publishes only the failed-attempt branch with a CI-skip commit subject', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('fail-b') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.outcome !== 'fixed');
    expect(failed?.failedAttempt?.branch).toMatch(/^cq\/fixture\/failed\//);
    const remote = await git(
      f.repo,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${failed!.failedAttempt!.branch}`,
    );
    expect(remote.split(/\s+/)[0]).toBe(failed!.failedAttempt!.sha);
    expect(await git(f.repo, 'show', '-s', '--format=%s', failed!.failedAttempt!.sha)).toContain(
      '[skip ci]',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans the refused failed commit contents and keeps secret paths local', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('private-change') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    expect(result.status).toBe('needs-human');
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:.env.config`)).toContain(
      'DO_NOT_UPLOAD',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed keeps a failed branch local when its upload scan faults', async () => {
  const f = await fixture();
  vi.stubEnv('CQ_TEST_GITLEAKS_FAIL_ON', 'SCANNER_FAULT');
  try {
    const result = await makeFixRun({ drivers: scripted('scan-fault') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'rev-parse', `refs/heads/${failed.failedAttempt!.branch}`)).toBe(
      failed.failedAttempt!.sha,
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans edits captured by an early worker failure before path classification', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-after-secret') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:public-note.txt`)).toContain(
      'DO_NOT_UPLOAD',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed applies tamper gate before path policy after an early worker failure', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-after-protected') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt tamper gate refused publication');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:package.json`)).toContain(
      '"name":"edited"',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans refusal diagnostics embedded in the failed commit message', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-sensitive-diagnostic') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', '-s', '--format=%B', failed.failedAttempt!.sha)).toContain(
      'DO_NOT_UPLOAD synthetic diagnostic',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed publishes a clean public failed-attempt change', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('safe-change') })({
      ...input(f),
      pushFailed: true,
    });
    const failed = reportOf(result).tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:public-note.txt`)).toContain(
      'safe public content',
    );
    expect(
      (
        await git(
          f.repo,
          'ls-remote',
          '--heads',
          'origin',
          `refs/heads/${failed.failedAttempt!.branch}`,
        )
      ).split(/\s+/)[0],
    ).toBe(failed.failedAttempt!.sha);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed keeps path-policy-refused failed attempts local', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted() })({
      ...input(f),
      proposeOnly: true,
      pushFailed: true,
    });
    const report = reportOf(result);
    expect(result.status).toBe('needs-human');
    const attempts = report.tasks.flatMap(
      (task) =>
        task.rounds?.flatMap((round) => (round.failedAttempt ? [round.failedAttempt] : [])) ?? [],
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      report.tasks.some((task) =>
        task.rounds?.some(
          (round) => round.gate === 'path-policy' && round.reason.includes('propose-only worker'),
        ),
      ),
    ).toBe(true);
    for (const attempt of attempts) {
      expect(await git(f.repo, 'rev-parse', `refs/heads/${attempt.branch}`)).toBe(attempt.sha);
      expect(
        await git(f.repo, 'ls-remote', '--heads', 'origin', `refs/heads/${attempt.branch}`),
      ).toBe('');
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
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

test('PR body links pushed failed-attempt evidence in its Unfixed section', async () => {
  const f = await fixture();
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

test('mixed outcomes are fully accounted: fixed, failed-with-branch, branchless failure and never-started', async () => {
  const f = await fixture(1000);
  try {
    // A third failing task the run never reaches: the budget stop lands after
    // the second task's first worker call, so tasks one (fixed), two (failed
    // with a retained branch) and the never-started remainder are all visible.
    await writeFile(
      join(f.repo, 'cases', 'c.test.cjs'),
      'module.exports = { actual: 1, expected: 2 };\n',
    );
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'seed third failing task');
    // Worker contract: fix a.test.cjs, fail b.test.cjs with a retained patch,
    // and stop honestly with a budget stopReason before touching c.
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
            if (calls.length >= 2 && invocation.prompt.includes('Tier: worker')) {
              // The run budget (below) exhausts after this call settles.
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
            }
            return {
              stopReason: 'complete',
              denials: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
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
    // Five tokens total: a(2), b(2) settle; c never starts (b's feedback or
    // the next invocation breaches the budget first).
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      budgets?: { run: { maxTokens: number } };
    };
    config.budgets = { run: { maxTokens: 5 } };
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'configure tighter budget');
    const result = await makeFixRun({ drivers })({ ...input(f), push: true });
    const report = reportOf(result);
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const outcomes = report.planned.map((row) => [row.task.id, row.outcome] as const);
    // Every planned row appears exactly once with a truthful outcome.
    expect(outcomes).toContainEqual(['cases/a.test.cjs', 'fixed']);
    expect(outcomes).toContainEqual(['cases/b.test.cjs', 'unfixed']);
    const outstanding = report.planned.filter((row) => row.outcome !== 'fixed');
    expect(outstanding.length).toBeGreaterThanOrEqual(2);
    // Issue 615 (2): no placeholder row duplicates an attempted unit —
    // every not-started/exhausted/cancelled row names a task no other row
    // carries.
    const plannedIds = report.planned.map((row) => row.task.id);
    expect(new Set(plannedIds).size).toBe(plannedIds.length);
    // The fixed row keeps its verified evidence and the legacy metric.
    const fixed = report.planned.find((row) => row.outcome === 'fixed');
    expect(fixed?.commits).toHaveLength(1);
    expect(fixed?.attempts.length).toBeGreaterThan(0);
    // The failed task's retained branch survives in both views; the failed
    // row's failures carry branch and sha while every branchless row omits
    // both (no invented artifact).
    const failedWithBranch = report.planned.find(
      (row) => row.outcome === 'unfixed' && row.failures.some((failure) => 'branch' in failure),
    );
    const retained = failedWithBranch?.failures.find((failure) => 'branch' in failure);
    expect(retained && 'branch' in retained ? retained.branch : undefined).toMatch(
      /^cq\/fixture\/failed\//,
    );
    expect(retained && 'sha' in retained ? retained.sha : undefined).toMatch(/^[0-9a-f]{40}$/);
    for (const row of outstanding)
      for (const failure of row.failures)
        if (!('branch' in failure)) {
          expect(failure.gate).toBe('none');
          expect(failure.reason).toBeTruthy();
        }
    // Explicit denominators: planned = fixed + unresolved.
    expect(report.counters.planned).toBe(report.planned.length);
    expect(report.counters.fixed).toBe(1);
    expect(report.counters.unresolved).toBe(report.counters.planned - 1);
    expect(report.counters.attempted).toBeGreaterThanOrEqual(1);
    // The legacy failed evidence still carries the retained branch row.
    expect(report.failed.some((row) => 'branch' in row)).toBe(true);
    // fixesPerRun keeps its meaning: verified fixes only.
    expect(report.fixesPerRun).toBe(1);
    // The persisted artifact matches the returned report exactly.
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PR summary carries branchless refined rows before finalization (issue 615 #1)', async () => {
  const f = await fixture(1000);
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

test('cancellation keeps completed unit evidence and one cancelled sibling placeholder (issue 615 #2)', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let parentSignal: AbortSignal | undefined;
  let result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>> | undefined;
  let workerCalls = 0;
  try {
    // Two units over one package (two identical checks = two fixers), run
    // sequentially: the first completes both tasks; the second is cancelled
    // at its first worker call.
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      checks: unknown[];
    };
    config.checks.push({ ...(config.checks[0] as object) });
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'configure a second unit');
    const drivers: DriverFactory = {
      resolve: ({ modelSpec }) => ({
        modelSpec,
        lane: 'ai-sdk',
        driver: {
          run: async (_request, options) => {
            workerCalls++;
            // Unit tests-1: a(edit,feedback) + b(edit,feedback) = 4 calls.
            if (workerCalls <= 4) {
              const settled = await scripted()
                .resolve({ role: 'fixer', modelSpec })
                .driver.run(_request, options);
              // Abort after unit tests-1's last call settles, so unit
              // tests-2 sees the cancellation at its task-loop top.
              if (workerCalls === 4) controller.abort();
              return settled;
            }
            const signal = options?.signal;
            if (!signal) throw new Error('missing inner worker signal');
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
        result = await makeFixRun({ drivers })({
          repoRoot: f.repo,
          source: 'tests',
          selector: { mode: 'workspace-all' },
          journalDir: f.journalDir,
          push: true,
        });
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
    expect(result?.status).toBe('needs-human');
    const report = result?.report;
    expect(report).toBeDefined();
    if (!report) throw new Error('unreachable');
    // The completed unit's real evidence survives untouched.
    const fixedRows = report.planned.filter((row) => row.outcome === 'fixed');
    expect(fixedRows).toHaveLength(2);
    for (const row of fixedRows) {
      expect(row.commits).toHaveLength(1);
      expect(row.unit).toBe('tests-1/scratch-repo');
    }
    // The cancelled unit keeps its real planned rows (a, b) refined to
    // cancelled — no false never-started placeholder beside them.
    const cancelledRows = report.planned.filter((row) => row.outcome === 'cancelled');
    expect(cancelledRows.map((row) => row.task.id).toSorted()).toEqual([
      'cases/a.test.cjs',
      'cases/b.test.cjs',
    ]);
    for (const row of cancelledRows) expect(row.unit).toBe('tests-2/scratch-repo');
    const neverStarted = report.planned.filter((row) => row.outcome === 'not-started');
    expect(neverStarted).toEqual([]);
    // Distinct identities: every (unit, task) pair appears once.
    const plannedIds = report.planned.map((row) => `${row.unit}\n${row.task.id}`);
    expect(new Set(plannedIds).size).toBe(plannedIds.length);
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each(['missing-policy', 'scanner-fault'] as const)(
  'real scanner composition refuses %s before worker dispatch',
  async (mode) => {
    const f = await fixture();
    let calls = 0;
    try {
      if (mode === 'missing-policy') {
        await unlink(join(f.repo, 'upload-policy.yml'));
        await git(f.repo, 'add', '-A');
        await git(f.repo, 'commit', '-m', 'remove configured policy');
      } else vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '2');
      const drivers: DriverFactory = {
        resolve: (request) => {
          const resolved = scripted().resolve(request);
          return {
            ...resolved,
            driver: {
              run: async (invocation, options) => {
                calls++;
                return resolved.driver.run(invocation, options);
              },
            },
          };
        },
      };
      const result = await makeFixRun({ drivers })(input(f));
      expect(result.status).toBe('needs-human');
      expect(calls).toBe(0);
      expect(reportOf(result).tasks.every((task) => task.reason?.includes('upload refused'))).toBe(
        true,
      );
      expect(reportOf(result).fixesPerRun).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

// These execute the production CLI in a fresh process; only provider transport is scripted.
test.each([
  'rescue-success',
  'partial-human',
  'budget-stop',
  'regression-rescue',
  'concurrent-shared',
  'rescue-tainted-patch',
] as const)('spawned escalation CLI %s retains honest tier and commit evidence', async (mode) => {
  const f = await fixture(mode === 'budget-stop' ? 5 : 1000, mode === 'rescue-tainted-patch');
  try {
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as CqConfig;
    config.roles = {
      worker: {
        provider: 'fixture',
        model:
          mode === 'partial-human'
            ? 'worker-fixes-b'
            : mode === 'regression-rescue'
              ? 'worker-regression'
              : mode === 'rescue-tainted-patch'
                ? 'worker-tainted'
                : 'worker-fails',
      },
      rescue: {
        provider: 'fixture',
        model: mode === 'partial-human' ? 'rescue-fails' : 'rescue-fixes',
      },
    };
    config.escalation = {
      workerAttempts: 2,
      rescueBase: 1,
      rescuePerFixed: 10,
      rescuePerPackageCap: 1,
    };
    // Success needs one rescue per task; remove the second failure for this isolated case.
    if (mode === 'rescue-success' || mode === 'regression-rescue' || mode === 'concurrent-shared')
      await writeFile(
        join(f.repo, 'cases/b.test.cjs'),
        'module.exports = { actual: 1, expected: 1 };\n',
      );
    if (mode === 'concurrent-shared') config.checks.push({ ...config.checks[0]! });
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'configure escalation fixture');
    const argv = [
      fileURLToPath(new URL('../../fixtures/fix-cli/entry.mjs', import.meta.url)),
      'fix.run',
      '--source=tests',
      `--repoRoot=${f.repo}`,
      '--selector={"mode":"workspace-all"}',
      `--journalDir=${f.journalDir}`,
      '--runPrefix=cq/escalation-fixture',
      '--concurrency=2',
      '--json',
    ];
    let stdout = '';
    let exit = 0;
    try {
      ({ stdout } = await exec(process.execPath, argv, {
        env: {
          ...scrubbedGitEnv(),
          ...(mode === 'rescue-success' ? { CQ_FIX_ASSERT_RESCUE_BASELINE: '1' } : {}),
        },
        timeout: 30_000,
      }));
    } catch (error) {
      const failed = error as { code: number; stdout: string };
      exit = failed.code;
      stdout = failed.stdout;
    }
    const artifact = JSON.parse(stdout) as FixRunResult;
    const report = reportOf(artifact);
    expect(exit, stdout).toBe(['rescue-success', 'regression-rescue'].includes(mode) ? 0 : 3);
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    if (mode === 'rescue-success') {
      expect(report.tasks[0]?.attempts.map((a) => [a.tier, a.attempt, a.invocation])).toEqual([
        ['worker', 1, 'edit'],
        ['worker', 1, 'feedback'],
        ['worker', 2, 'edit'],
        ['worker', 2, 'feedback'],
        ['rescue', 1, 'edit'],
        ['rescue', 1, 'feedback'],
      ]);
      expect(report.tasks[0]?.commits).toHaveLength(1);
      expect(report.tasks[0]?.attempts.at(-1)?.model.model).toBe('rescue-fixes');
      expect(report.escalation?.fixedFingerprints).toHaveLength(1);
      expect(
        report.tasks[0]?.rounds
          ?.flatMap((round) => round.failedAttempt?.branch.split('/').at(-1) ?? [])
          .toSorted(),
      ).toEqual(['a1', 'a2']);
      expect(report.failed.filter((row) => 'branch' in row)).toHaveLength(2);
    } else if (mode === 'regression-rescue') {
      expect(report.tasks[0]?.attempts.map((a) => [a.tier, a.attempt])).toEqual([
        ['worker', 1],
        ['worker', 1],
        ['rescue', 1],
        ['rescue', 1],
      ]);
      expect(report.tasks[0]?.rounds?.[0]?.validation?.gates).toEqual(
        expect.arrayContaining([expect.objectContaining({ gate: 'broader', verdict: 'fail' })]),
      );
      const evidence = report.tasks[0]?.rounds?.[0]?.failedAttempt;
      expect(evidence?.branch).toMatch(/^cq\/escalation-fixture\/failed\//);
      expect(await git(f.repo, 'rev-parse', `refs/heads/${evidence!.branch}`)).toBe(evidence!.sha);
      expect(report.escalation?.events.find((e) => e.tier === 'rescue')?.reason).toContain(
        'broader regression',
      );
      expect(report.tasks[0]?.commits).toHaveLength(1);
    } else if (mode === 'concurrent-shared') {
      expect(report.units).toHaveLength(2);
      expect(report.escalation?.perRunUsed).toBe(1);
      expect(
        report.tasks
          .flatMap((task) => task.attempts)
          .filter((a) => a.tier === 'rescue' && a.invocation === 'edit'),
      ).toHaveLength(1);
      expect(report.tasks.flatMap((task) => task.commits)).toHaveLength(1);
      expect(report.escalation?.fixedFingerprints).toHaveLength(1);
    } else if (mode === 'partial-human') {
      expect(report.tasks.map((task) => task.outcome)).toEqual(['escalated-to-human', 'fixed']);
      expect(report.tasks[1]?.commits).toHaveLength(1);
      expect(report.escalation?.perRunUsed).toBe(1);
    } else if (mode === 'rescue-tainted-patch') {
      expect(report.tasks[0]?.attempts.every((attempt) => attempt.tier === 'worker')).toBe(true);
      expect(report.tasks[0]?.reason).toContain('upload refused');
      expect(report.tasks[0]?.failedAttempt).toBeDefined();
    } else {
      expect(report.tasks.flatMap((task) => task.commits)).toEqual([]);
      expect(report.usage.input + report.usage.output).toBe(6);
      expect(report.tasks.flatMap((task) => task.attempts).every((a) => a.tier === 'worker')).toBe(
        true,
      );
    }
    const transcriptDir = process.env.CQ_FIX_ESCALATION_TRANSCRIPT_DIR;
    if (transcriptDir) {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        join(transcriptDir, `${mode}.json`),
        JSON.stringify({ argv, exit, artifact }, null, 2) + '\n',
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('pre-task unit failure fallback keeps collision-resolved plan segments (issue 615 #3)', async () => {
  const f = await fixture();
  try {
    // Two packages whose normalized slugs collide: 'scratch-repo' and
    // 'scratch.repo' both derive slug 'scratch-repo', so the plan builder
    // resolves the second unit to 'scratch-repo-2' and ships kind/slug on
    // its dispatch. The check script faults (invalid JSON) only inside the
    // second unit's worktree — its path carries the resolved slug — so that
    // unit fails at its baseline probe, before deriving any tasks.
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      packages?: Array<{ name: string; path: string }>;
      checks: Array<{
        kind?: string;
        adapter: string;
        command: { command: string; args: string[] };
      }>;
    };
    config.packages = [
      { name: 'scratch-repo', path: '.' },
      { name: 'scratch.repo', path: '.' },
    ];
    const script = config.checks[0]!;
    config.checks[0] = {
      adapter: 'vitest-json',
      command: {
        command: '/bin/sh',
        args: [
          '-c',
          `if [ "$(basename "$(pwd)")" = "scratch-repo-2" ]; then echo '{invalid'; exit 1; fi; "${script.command.command}" "${script.command.args.join('" "')}"`,
        ],
      },
    };
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'configure colliding packages and probe fault');
    const result = await makeFixRun({ drivers: scripted() })({ ...input(f) });
    expect(result.status, JSON.stringify(result)).toBe('failed');
    const report = reportOf(result);
    // Unit 1 completed with its real task rows on the base identity.
    const unit1 = report.planned.filter((row) => row.unit === 'tests-1/scratch-repo');
    expect(unit1.map((row) => row.outcome).toSorted()).toEqual(['fixed', 'fixed']);
    // The failed second unit's fallback row carries the SHIPPED segments:
    // branch and unit label end in the resolved slug, not the collided fold.
    const fallback = report.planned.find((row) => row.unit === 'tests-1/scratch-repo-2');
    expect(fallback).toBeDefined();
    expect(fallback?.branch).toBe('cq/fixture/tests-1/scratch-repo-2');
    expect(fallback?.outcome).toBe('not-started');
    expect(fallback?.failures[0]?.branch).toBeUndefined();
    // Distinct identities: the fallback never shares unit1's identity.
    const identities = report.planned.map((row) => `${row.unit}\n${row.task.id}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
