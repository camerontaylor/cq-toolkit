import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { fixture, git, input, reportOf, scripted } from './fix-run-shared.js';

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
    // Explicit denominators: planned = fixed + skipped + unresolved.
    expect(report.counters.planned).toBe(report.planned.length);
    expect(report.counters.fixed).toBe(1);
    expect(report.counters.skipped).toBe(0);
    expect(report.counters.unresolved).toBe(
      report.counters.planned - report.counters.fixed - report.counters.skipped,
    );
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
    // The shim must forward EVERY appended argument (the related checks pass
    // task files after the configured argv; relatedCheckCommand appends them
    // to the command's args) while faulting only in the second unit's
    // worktree — whose directory name carries the resolved slug.
    config.checks[0] = {
      adapter: 'vitest-json',
      command: {
        command: '/bin/sh',
        args: [
          '-c',
          `if [ "$(basename "$(pwd)")" = "scratch-repo-2" ]; then echo '{invalid'; exit 1; fi; exec "${script.command.command}" "${script.command.args.join('" "')}" "$@"`,
          'sh',
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
    if (fallback === undefined) throw new Error('no fallback row for the failed unit');
    // The fallback is never-started work: its row names the planned branch,
    // and its failure evidence is branchless (no artifact was retained).
    expect(fallback.branch).toBe('cq/fixture/tests-1/scratch-repo-2');
    expect(fallback.outcome).toBe('not-started');
    const fallbackFailure = fallback.failures[0];
    if (fallbackFailure === undefined) throw new Error('fallback row carries no failure');
    expect('branch' in fallbackFailure).toBe(false);
    // Truthful stable classification: the unit label, the package-name task,
    // not-started, no gate (no artifact was retained), and the reason naming
    // the derivation boundary and the [PROBE] baseline fault class.
    expect(fallbackFailure).toEqual({
      unit: 'tests-1/scratch-repo-2',
      task: 'scratch.repo',
      outcome: 'not-started',
      gate: 'none',
      reason:
        'unit failed before deriving tasks: [PROBE] sweep.unit scratch.repo: ' +
        'the baseline probe returned indeterminate — vitest-json: output is not valid JSON',
    });
    // Distinct identities: the fallback never shares unit1's identity.
    const identities = report.planned.map((row) => `${row.unit}\n${row.task.id}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
