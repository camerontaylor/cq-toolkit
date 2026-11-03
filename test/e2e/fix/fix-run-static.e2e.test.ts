import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { exec, fixture, git, gitleaks, input, reportOf, scripted } from './fix-run-shared.js';

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

test('offline install supplies a dependency needed by the isolated check', async () => {
  const f = await fixture();
  try {
    const script = join(f.repo, 'scripts', 'tests.cjs');
    await writeFile(
      script,
      "require('../installed-dependency.cjs');\n" + (await readFile(script, 'utf8')),
    );
    await writeFile(join(f.repo, '.gitignore'), 'worktrees/\ninstalled-dependency.cjs\n');
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-m', 'require offline installed dependency');
    const missing = await makeFixRun({ drivers: scripted() })({
      ...input(f),
      runPrefix: 'cq/no-install',
    });
    expect(missing.status).not.toBe('ok');
    expect(reportOf(missing).fixesPerRun).toBe(0);
    const installed = await makeFixRun({ drivers: scripted() })({
      ...input(f),
      runPrefix: 'cq/with-install',
      journalDir: join(f.root, 'journal-with-install'),
      install: {
        command: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync('installed-dependency.cjs', 'module.exports = true;')",
        ],
      },
    });
    expect(installed.status, JSON.stringify(installed)).toBe('ok');
    expect(reportOf(installed).fixesPerRun).toBe(2);
    const sourceDependency = join(f.repo, 'installed-dependency.cjs');
    await expect(readFile(sourceDependency, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
