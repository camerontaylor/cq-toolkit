import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runCli } from '../../../src/cli/main.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { FixRunReport, FixRunResult } from '../../../src/ops/fix/runFix.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { exec, fixture, git, gitleaks, reportOf } from './fix-run-shared.js';

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
      expect(report.tasks[0]?.failedAttempt).toBeUndefined();
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
