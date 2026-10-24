import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

vi.setConfig({ testTimeout: 30000 });
const exec = promisify(execFile);
let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});
const git = async (root: string, ...args: string[]) =>
  (
    await exec('git', ['-C', root, ...args], { env: scrubbedGitEnv(), timeout: 10000 })
  ).stdout.trim();
async function fixture(model = 'scripted', maxTokens = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'cq-address-cli-'));
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/a.ts'), 'export const a = "BAD";\n');
  await writeFile(join(repo, '.gitignore'), '.cq/\n');
  await writeFile(join(repo, 'scripts/check.cjs'), 'process.exitCode=0;\n');
  await writeFile(
    join(repo, 'cq.json'),
    JSON.stringify({
      schemaVersion: 2,
      checks: [
        {
          adapter: 'tsc-lines',
          command: { command: process.execPath, args: ['scripts/check.cjs'] },
        },
      ],
      roles: {
        worker: { provider: 'fixture', model },
        reviewer: { provider: 'fixture', model: 'reviewer' },
      },
      budgets: { run: { maxTokens, wallMs: 20000 }, step: { wallMs: 5000 } },
      review: { reviewers: ['agent'], rounds: 1 },
      escalation: { workerAttempts: 1, rescueBase: 0 },
    }),
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'seed address finding');
  const head = await git(repo, 'rev-parse', 'HEAD'),
    branch = await git(repo, 'symbolic-ref', '--short', 'HEAD');
  const record = join(root, 'findings.json'),
    journal = join(root, 'journal');
  await writeFile(
    record,
    JSON.stringify({
      schemaVersion: 1,
      branch,
      head,
      sources: [{ kind: 'agent', status: 'terminal' }],
      findings: [
        {
          id: 'seed-a',
          source: 'agent',
          file: 'src/a.ts',
          line: 1,
          severity: 'major',
          text: 'Replace BAD with GOOD',
          status: 'open',
        },
      ],
    }),
  );
  return { root, repo, head, record, journal };
}
async function run(f: Awaited<ReturnType<typeof fixture>>) {
  const argv = [
    fileURLToPath(new URL('../../fixtures/address-cli/entry.mjs', import.meta.url)),
    'review.address',
    `--repoRoot=${f.repo}`,
    '--source=local',
    `--base=${f.head}`,
    `--record=${f.record}`,
    `--journalDir=${f.journal}`,
  ];
  try {
    const result = await exec(process.execPath, argv, { env: scrubbedGitEnv(), timeout: 25000 });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}
test('spawned local CLI fixes through an aliased repository root', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'repo-alias');
    await symlink(f.repo, alias, 'dir');
    const result = await run({ ...f, repo: alias });
    expect(result.code, result.stdout).toBe(0);
    const report = (JSON.parse(result.stdout) as { value: ReviewAddressReport }).value;
    expect(report.fixesPerRun).toBe(1);
    expect(report.openBlocking).toEqual([]);
    expect(report.fixes[0]?.finding.file).toBe('src/a.ts');
    expect(await git(f.repo, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/a.ts');
    expect((await scanner.calls()).length).toBeGreaterThan(3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test.each([
  { model: 'scripted', tokens: 1000, code: 0 },
  { model: 'defer', tokens: 1000, code: 3 },
  { model: 'scripted', tokens: 1, code: 3 },
])(
  'spawned review.address CLI: $model budget $tokens exits $code with retained report',
  async ({ model, tokens, code }) => {
    const f = await fixture(model, tokens);
    try {
      const result = await run(f);
      expect(result.code, result.stderr + result.stdout).toBe(code);
      const artifact = JSON.parse(result.stdout) as {
        status: string;
        value?: ReviewAddressReport;
        report?: ReviewAddressReport;
      };
      const report = (artifact.value ?? artifact.report)!;
      expect(
        JSON.parse(await readFile(join(f.journal, 'review-address-report.json'), 'utf8')),
      ).toEqual(report);
      expect((await scanner.calls()).length).toBeGreaterThan(0);
      if (code === 0) {
        expect(artifact.status).toBe('ok');
        expect(report.fixesPerRun).toBe(1);
        expect(report.openBlocking).toEqual([]);
        expect(await git(f.repo, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/a.ts');
        expect(report.attempts.map((a: { invocation: string }) => a.invocation)).toEqual([
          'edit',
          'feedback',
          'closure',
        ]);
        expect(await git(f.repo, 'rev-parse', 'HEAD^')).toBe(f.head);
      } else {
        expect(artifact.status).toBe('needs-human');
        expect(report.usage.input + report.usage.output).toBeGreaterThan(0);
      }
      console.log(
        `review.address fixture: mode=${model} budget=${tokens} exit=${result.code} fixesPerRun=${report.fixesPerRun} openBlocking=${report.openBlocking.length} usage=${JSON.stringify(report.usage)}`,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
