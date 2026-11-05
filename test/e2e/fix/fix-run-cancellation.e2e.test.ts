import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { fixture, git, scripted } from './fix-run-shared.js';

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

test('cancellation keeps completed unit evidence and truthful sibling rows (issue 615 #2)', async () => {
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
          run: async (request, options) => {
            workerCalls++;
            // The shipped prompt template embeds the unit's worktree path,
            // which carries the unit's kind/slug segments — the observable
            // first-unit/second-unit boundary. Unit tests-1 runs to genuine
            // completion (both tasks commit); the abort fires at the FIRST
            // tests-2 dispatch, so its task loop sees the cancel at the top.
            if (!request.prompt.includes(join('tests-2', 'scratch-repo')))
              return scripted().resolve({ role: 'fixer', modelSpec }).driver.run(request, options);
            controller.abort();
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
    // Unit tests-2's first dispatch aborts mid-flight: task a carries its
    // recorded aborted attempt and escalates; task b, never dispatched,
    // refines to cancelled. Both keep unit tests-2's identity.
    const escalated = report.planned.find(
      (row) => row.outcome === 'escalated-to-human' && row.unit === 'tests-2/scratch-repo',
    );
    if (escalated === undefined) throw new Error('no escalated row for unit tests-2');
    expect(escalated.task.id).toBe('cases/a.test.cjs');
    expect(escalated.attempts).toHaveLength(1);
    expect(escalated.attempts[0]?.stopReason).toBe('aborted');
    const cancelledRows = report.planned.filter((row) => row.outcome === 'cancelled');
    expect(cancelledRows.map((row) => row.task.id)).toEqual(['cases/b.test.cjs']);
    for (const row of cancelledRows) expect(row.unit).toBe('tests-2/scratch-repo');
    // No false never-started placeholder beside the real rows (the finding-2
    // dedup: the cancelled unit was dispatched, so its rows are its own).
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
