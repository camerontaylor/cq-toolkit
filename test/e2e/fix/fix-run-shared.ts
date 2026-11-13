import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

// Each of these e2e tests spawns the production CLI against real git, so the
// per-test budget is wall-clock, not assertion time. The pre-split single file
// ran one worker at 30 s; the split files can run in parallel workers, so keep
// generous headroom instead of letting runner load surface as timeouts.
vi.setConfig({ testTimeout: 60_000 });

export let gitleaks: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  gitleaks = await makeGitleaksFixture();
  vi.stubEnv('PATH', gitleaks.path);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(gitleaks.root, { recursive: true, force: true });
});

export const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', ['-C', cwd, ...args], { env: scrubbedGitEnv(), timeout: 10_000 })
  ).stdout.trim();
export async function fixture(budget: number | undefined = 1000, configuredDenylist = true) {
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
/** PR publication requires an actual remote default branch, unlike local-only runs. */
export async function seedPrBase(f: Awaited<ReturnType<typeof fixture>>) {
  await git(f.repo, 'push', 'origin', 'HEAD:refs/heads/main');
  await git(f.repo, 'fetch', 'origin', 'main');
  await git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

export function scripted(
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
          if (mode === 'safe-change')
            await writeFile(
              join(invocation.workspace.path, 'public-note.txt'),
              'safe public content\n',
            );
          if (mode === 'fail-b-safe-change')
            await writeFile(
              join(invocation.workspace.path, 'public-note.txt'),
              `safe public content ${task.files.join(',')} attempt ${Number(/attempt: (\d+)/.exec(invocation.prompt)?.[1] ?? 1)}\n`,
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
export const input = (f: Awaited<ReturnType<typeof fixture>>) => ({
  repoRoot: f.repo,
  source: 'tests' as const,
  selector: { mode: 'workspace-all' as const },
  journalDir: f.journalDir,
  runPrefix: 'cq/fixture',
});
export const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>>) =>
  result.status === 'ok' ? result.value : (result.report as FixRunReport);
