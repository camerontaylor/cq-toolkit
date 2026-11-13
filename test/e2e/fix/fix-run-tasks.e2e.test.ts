import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { readCommittedMarkers } from '../../../src/ops/sweep/unit.js';
import { fixture, git, input, reportOf, scripted } from './fix-run-shared.js';

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
    const result = await makeFixRun({ drivers: scripted('fail-b-safe-change') })(input(f));
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).tasks.map((task) => task.outcome)).toEqual([
      'fixed',
      'escalated-to-human',
    ]);
    expect(reportOf(result).fixesPerRun).toBe(1);
    expect(reportOf(result).tasks[1]?.failedAttempt?.branch).toMatch(
      /^cq\/fixture\/failed\/tests-1-[0-9a-f]{16}\/scratch-repo-[0-9a-f]{16}\/cases-b-test-cjs-[0-9a-f]{16}\/a[1-9][0-9]*$/,
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
