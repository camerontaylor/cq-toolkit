// ADR-0008 T23 — the `measurement-summary` event: honest fix and review
// denominators print through the composition observation writer on EVERY
// exit (ok, needs-human, failure and cancellation included), fold into
// R.metric, stay per-run (no cross-run state), and never become a ratio
// when the denominator is unknown. The T34/T35 legacy totals on the report
// carrier keep their own pre-v2 rule and are preserved verbatim.
// M2c — the fix denominator is WIRED: a real fix run's collected baseline
// probes (failure counts at their worktree HEADs) reach the summary, and a
// planned unit with no collected report keeps the denominator null.
// Fake/local inputs only: no providers, no network, no credentials.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  openObservationWriter,
  readObservations,
  type ObservationWriter,
} from '../../../src/kernel/observation.js';
import type {
  MeasurementSummaryJournalEvent,
  ObservationEvent,
} from '../../../src/kernel/types.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import type { ValidationVerdict } from '../../../src/ops/fix/validate.js';
import type { AddressFix, AddressWorker } from '../../../src/ops/review/addressWorker.js';
import {
  fixedUnitReport,
  fixingDrivers,
  fixtureIn,
  input,
  reportOf,
  stubSweepRegistries,
} from './observation-wiring.helpers.js';
import {
  fixture as addressFixture,
  finding as addressFinding,
  reportOf as addressReportOf,
} from '../review/address.helpers.js';
import { fixture as localFixture, useGitleaksPath } from '../review/address-local.helpers.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

useGitleaksPath();

const execFileAsync = promisify(execFile);
const passing: ValidationVerdict = { verdict: 'pass', gates: [] };

let roots: string[] = [];
beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const summariesOf = (events: readonly ObservationEvent[]): MeasurementSummaryJournalEvent[] =>
  events.filter(
    (event): event is MeasurementSummaryJournalEvent => event.type === 'measurement-summary',
  );

/** A real empty commit in the scratch repo whose trailer block names taskId. */
const linkedCommit = async (repo: string, taskId: string): Promise<string> => {
  const git = (args: string[]) =>
    execFileAsync('git', ['-C', repo, ...args], {
      env: scrubbedGitEnv(),
      timeout: 10_000,
    });
  await git(['commit', '--allow-empty', '-m', `fix: ${taskId}\n\nCq-Task: ${taskId}`]);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
};

const fixedTaskWith = (taskId: string, commits: string[]): FixTaskReport => ({
  task: { id: taskId, files: ['cases/a.test.cjs'], failures: [] },
  attempts: [],
  outcome: 'fixed',
  branch: 'cq/fixture/tests-1/scratch-repo',
  commits,
  validation: passing,
});

test('T23 round-trip', async () => {
  // Fix composition, durable: one terminal measurement-summary whose numerator
  // is counted from the real commit's Cq-Task trailer, and whose denominator
  // is honestly null — no baseline probe producer is wired, never a zero.
  const f = await fixtureIn(roots);
  try {
    const sha = await linkedCommit(f.repo, 'scratch-repo/task-1');
    const unit = { ...fixedUnitReport(), tasks: [fixedTaskWith('scratch-repo/task-1', [sha])] };
    const report = reportOf(
      await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(unit) },
      })(input(f)),
    );
    const metric = report.reportV2?.metric;
    expect(metric?.fixesPerRun).toEqual({ numerator: 1, denominator: null });
    expect(metric?.verifiedCommits).toEqual([sha]);
    expect(metric?.baselineFailures).toEqual([
      {
        unitId: 'scratch-repo/tests-1',
        probeHead: null,
        completed: false,
        count: null,
        unknownReason: 'baseline probe did not complete for this unit',
      },
    ]);
    expect(report.reportV2?.availability['/metric']?.state).toBe('known');
    expect(report.reportV2?.availability['/metric/fixesPerRun/numerator']?.state).toBe('known');
    expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe(
      'not-collected',
    );
    // The persisted stream round-trips: exactly one summary, as the last event.
    const streams = await readObservations(f.journalDir);
    expect(streams).toHaveLength(1);
    const events = streams[0]?.events ?? [];
    const summaries = summariesOf(events);
    expect(summaries).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe('measurement-summary');
    expect(summaries[0]?.payload.metric).toEqual(metric);
    expect(streams[0]?.complete).toBe(true);
    // T34's legacy total keeps its own pre-v2 rule on the same exit.
    expect(report.fixesPerRun).toBe(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    roots = roots.filter((root) => root !== f.root);
  }

  // Address composition: the same event from review evidence. The seeded
  // INITIAL open-blocker population is the denominator (each captured blocker
  // is one observed baseline failure); a deferred worker leaves a known-zero
  // numerator, and no commit ever counted a ratio.
  const a = await addressFixture([addressFinding('a')]);
  try {
    const report = addressReportOf(await makeReviewAddress(a.deps)(a.input));
    expect(report.initialOpenBlocking).toEqual(['a']);
    const metric = report.reportV2?.metric;
    expect(metric?.fixesPerRun).toEqual({ numerator: 0, denominator: 1 });
    expect(metric?.baselineFailures).toEqual([
      { unitId: 'a', probeHead: null, completed: true, count: 1, unknownReason: null },
    ]);
    expect(report.reportV2?.availability['/metric/fixesPerRun/numerator']?.state).toBe(
      'known-zero',
    );
    expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe('known');
    const streams = await readObservations(a.input.journalDir);
    const summaries = streams.flatMap((stream) => summariesOf(stream.events));
    expect(summaries).toHaveLength(1);
    // T35's legacy total keeps its own pre-v2 rule on the same exit.
    expect(report.fixesPerRun).toBe(0);
  } finally {
    await a.cleanup();
  }
});

test('T23 unknown evidence', async () => {
  // Fix: a candidate closure whose commit message cannot be read is genuinely
  // unknown — numerator null (never zero), denominator null with the planned
  // unit represented as unprobed, and no ratio field anywhere.
  const f = await fixtureIn(roots);
  try {
    const unit = {
      ...fixedUnitReport(),
      tasks: [fixedTaskWith('scratch-repo/task-1', ['f'.repeat(40)])],
    };
    const report = reportOf(
      await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(unit) },
      })(input(f)),
    );
    const metric = report.reportV2?.metric;
    expect(metric?.fixesPerRun).toEqual({ numerator: null, denominator: null });
    expect(metric?.verifiedCommits).toEqual([]);
    expect(Object.keys(metric?.fixesPerRun ?? {}).sort()).toEqual(['denominator', 'numerator']);
    expect(report.reportV2?.availability['/metric/fixesPerRun/numerator']?.state).toBe(
      'unavailable',
    );
    expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe(
      'not-collected',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
    roots = roots.filter((root) => root !== f.root);
  }

  // Address: a fixed row whose commit SHA the repository cannot resolve leaves
  // the numerator unknown while the seeded denominator stays known at 1.
  const a = await addressFixture([addressFinding('a')]);
  try {
    const deps = {
      ...a.deps,
      workerFactory: (): AddressWorker => ({
        escalation: createEscalationState,
        fix: async (finding): Promise<AddressFix> => ({
          finding: { ...finding, status: 'fixed' as const, reason: 'fixed' },
          reason: 'fixed',
          observedHead: a.record().head,
          commit: 'zz-not-a-sha',
          validation: [passing],
        }),
      }),
    };
    // A non-object-id commit never reaches git (P3-3): the recording seam
    // delegates every call, and the guard must keep `show` at zero.
    const realGit = makeGhRunner({ bin: 'git', timeoutMs: 10_000 });
    let showCalls = 0;
    deps.git = async (args: string[]) => {
      if (args[0] === 'show') showCalls++;
      return realGit(args);
    };
    const report = addressReportOf(await makeReviewAddress(deps)(a.input));
    const metric = report.reportV2?.metric;
    expect(metric?.fixesPerRun).toEqual({ numerator: null, denominator: 1 });
    expect(showCalls).toBe(0);
    expect(report.reportV2?.availability['/metric/fixesPerRun/numerator']?.state).toBe(
      'unavailable',
    );
    expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe('known');
    expect(Object.keys(metric?.fixesPerRun ?? {}).sort()).toEqual(['denominator', 'numerator']);
  } finally {
    await a.cleanup();
  }
});

test('T23 failure boundary', async () => {
  // A refused measurement-summary append is evidence, never a verdict: the
  // run's ok result stands, the surface turns indeterminate with the failure,
  // and the folded metric stays explicitly unavailable.
  const base = await openObservationWriter({
    workId: randomUUID(),
    compositionRunId: `comp-t23-${Date.now()}`,
  });
  const refusing: ObservationWriter = {
    compositionRunId: base.compositionRunId,
    workId: base.workId,
    persistence: base.persistence,
    get failure() {
      return base.failure;
    },
    events: () => base.events(),
    append: async (event) => {
      if (event.type === 'measurement-summary')
        throw new Error('measurement append refused: disk full');
      // The injected writer has a distinct stream identity (as in the T30
      // boundary fixtures): pass-through events adopt it.
      await base.append(
        event.type === 'composition-started'
          ? {
              ...event,
              runId: base.compositionRunId,
              payload: {
                ...event.payload,
                correlation: { ...event.payload.correlation, workId: base.workId },
              },
            }
          : { ...event, runId: base.compositionRunId },
      );
    },
    close: () => base.close(),
  };
  const f = await fixtureIn(roots);
  try {
    const sha = await linkedCommit(f.repo, 'scratch-repo/task-1');
    const unit = { ...fixedUnitReport(), tasks: [fixedTaskWith('scratch-repo/task-1', [sha])] };
    const result = await makeFixRun({
      drivers: fixingDrivers(),
      registry: { get: stubSweepRegistries(unit) },
      observationWriter: refusing,
    })(input(f));
    expect(result.status).toBe('ok');
    const report = reportOf(result);
    expect(report.observation?.status).toBe('indeterminate');
    expect(report.observation?.failure).toContain('measurement append refused');
    expect(report.reportV2?.metric.fixesPerRun).toEqual({ numerator: null, denominator: null });
    expect(report.reportV2?.availability['/metric']?.state).toBe('unavailable');
    expect(summariesOf(base.events())).toHaveLength(0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    roots = roots.filter((root) => root !== f.root);
  }

  // Cancellation is an exit too: a parent aborted mid-edit still prints its
  // counts through the writer before the cancelled result returns.
  const a = await localFixture();
  const parent = new AbortController();
  const drivers: DriverFactory = {
    resolve: (request) => {
      const resolved = a.drivers.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (invocation) => {
            await writeFile(join(invocation.workspace!.path, 'src/a.ts'), 'CANCELLED PARTIAL\n');
            parent.abort();
            return {
              stopReason: 'aborted',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      };
    },
  };
  try {
    const governed = await runLadder(
      () =>
        makeReviewAddress({ drivers, initialRecord: a.record })({
          repoRoot: a.repo.root,
          source: 'local',
          journalDir: a.journalDir,
        }),
      {},
      { op: 'review.address', jobKey: 't23-cancelled-address', attempt: 1 },
      { signal: parent.signal },
    );
    expect(governed.outcome).toBe('completed');
    if (governed.outcome !== 'completed') return;
    expect(governed.value.status).toBe('needs-human');
    const streams = await readObservations(a.journalDir);
    const summaries = streams.flatMap((stream) => summariesOf(stream.events));
    expect(summaries).toHaveLength(1);
    // The summary is the LAST event on the cancel path: the link drain and
    // settleObservations are skipped there, so nothing appends after it.
    const events = streams.flatMap((stream) => stream.events);
    expect(events[events.length - 1]?.type).toBe('measurement-summary');
    // Round 1 seeded the full initial population before the abort; no closure
    // landed, so the numerator is an honest known zero.
    expect(summaries[0]?.payload.metric.fixesPerRun).toEqual({ numerator: 0, denominator: 1 });
    // The cancelled envelope carries the observation surface too: the counts
    // it printed — and any emission failure — never vanish from the result
    // the caller reads (the lease's cancelled result is this same report).
    const cancelled = governed.value;
    if (cancelled.status === 'ok' || cancelled.report === undefined) throw new Error('no report');
    expect(cancelled.report.observation?.status).toBe('durable');
    expect(cancelled.report.reportV2?.metric).toEqual(summaries[0]?.payload.metric);
  } finally {
    await a.cleanup();
  }
});

describe('M2c baseline probes in the fix denominator', () => {
  vi.setConfig({ testTimeout: 30_000 });

  /**
   * A REAL-composition fixture (no stubbed sweep registries — the unit op,
   * its worktree and its probes all run for real, in-process): the shared
   * scratch repo plus a runnable vitest-json probe with two seeded failing
   * cases (the e2e fix-run shape). `extraChecks` appends further planned
   * checks — a second planned unit — whose commands may be deliberately
   * broken.
   */
  const realFixtureIn = async (
    roots: string[],
    extraChecks: Array<{ kind: string; adapter: string; command: Record<string, unknown> }> = [],
  ): Promise<{ root: string; repo: string; journalDir: string }> => {
    const f = await fixtureIn(roots);
    await mkdir(join(f.repo, 'cases'));
    for (const name of ['a', 'b'])
      await writeFile(
        join(f.repo, 'cases', `${name}.test.cjs`),
        'module.exports = { actual: 1, expected: 2 };\n',
      );
    await writeFile(
      join(f.repo, 'scripts', 'tests.cjs'),
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
console.log(JSON.stringify({success: !failed, numTotalTests: names.length, testResults}));
process.exitCode = failed ? 1 : 0;
`,
    );
    const config = JSON.parse(await readFile(join(f.repo, 'cq.json'), 'utf8')) as {
      checks: Array<{ kind: string; adapter: string; command: Record<string, unknown> }>;
    };
    config.checks = [...config.checks, ...extraChecks];
    await writeFile(join(f.repo, 'cq.json'), JSON.stringify(config));
    for (const args of [
      ['add', '-A'],
      ['commit', '-m', 'seed the runnable probe cases'],
    ])
      await execFileAsync('git', ['-C', f.repo, ...args], {
        env: scrubbedGitEnv(),
        timeout: 10_000,
      });
    return f;
  };
  const headOf = async (repo: string): Promise<string> =>
    (
      await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        env: scrubbedGitEnv(),
        timeout: 10_000,
      })
    ).stdout.trim();

  test('M2c known denominator', async () => {
    // A fix run whose planned units all report baselines emits a
    // measurement-summary with a NON-NULL denominator — the summed baseline
    // failure counts at their probe heads (the seeded repo has exactly two
    // failing cases; the worktree HEAD at acquisition is the seed commit).
    const f = await realFixtureIn(roots);
    try {
      const seed = await headOf(f.repo);
      const report = reportOf(await makeFixRun({ drivers: fixingDrivers() })(input(f)));
      const metric = report.reportV2?.metric;
      expect(metric?.fixesPerRun).toEqual({ numerator: 2, denominator: 2 });
      expect(metric?.baselineFailures).toEqual([
        {
          unitId: 'scratch-repo/tests-1',
          probeHead: seed,
          completed: true,
          count: 2,
          unknownReason: null,
        },
      ]);
      expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe('known');
      // The persisted stream round-trips the wired denominator.
      const streams = await readObservations(f.journalDir);
      const summaries = streams.flatMap((stream) => summariesOf(stream.events));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.payload.metric.fixesPerRun).toEqual({ numerator: 2, denominator: 2 });
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('M2c partial denominator', async () => {
    // One planned unit whose probe cannot run (its check script is missing)
    // produces NO collected report: its baseline row stays unknown with the
    // existing reason and the denominator stays null — never a zero that
    // would fake a fully-known population.
    const f = await realFixtureIn(roots, [
      {
        kind: 'tests',
        adapter: 'vitest-json',
        command: { command: process.execPath, args: ['scripts/definitely-missing.cjs'] },
      },
    ]);
    try {
      const seed = await headOf(f.repo);
      const report = reportOf(await makeFixRun({ drivers: fixingDrivers() })(input(f)));
      const metric = report.reportV2?.metric;
      expect(metric?.fixesPerRun).toEqual({ numerator: 2, denominator: null });
      expect(metric?.baselineFailures).toEqual([
        {
          unitId: 'scratch-repo/tests-1',
          probeHead: seed,
          completed: true,
          count: 2,
          unknownReason: null,
        },
        {
          unitId: 'scratch-repo/tests-2',
          probeHead: null,
          completed: false,
          count: null,
          unknownReason: 'baseline probe did not complete for this unit',
        },
      ]);
      expect(report.reportV2?.availability['/metric/fixesPerRun/denominator']?.state).toBe(
        'not-collected',
      );
      expect(report.reportV2?.availability['/metric/baselineFailures/1/count']?.state).toBe(
        'not-collected',
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
