// ADR-0008 T23 — the `measurement-summary` event: honest fix and review
// denominators print through the composition observation writer on EVERY
// exit (ok, needs-human, failure and cancellation included), fold into
// R.metric, stay per-run (no cross-run state), and never become a ratio
// when the denominator is unknown. The T34/T35 legacy totals on the report
// carrier keep their own pre-v2 rule and are preserved verbatim.
// Fake/local inputs only: no providers, no network, no credentials.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
          commit: 'e'.repeat(40),
          validation: [passing],
        }),
      }),
    };
    const report = addressReportOf(await makeReviewAddress(deps)(a.input));
    const metric = report.reportV2?.metric;
    expect(metric?.fixesPerRun).toEqual({ numerator: null, denominator: 1 });
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
    // Round 1 seeded the full initial population before the abort; no closure
    // landed, so the numerator is an honest known zero.
    expect(summaries[0]?.payload.metric.fixesPerRun).toEqual({ numerator: 0, denominator: 1 });
  } finally {
    await a.cleanup();
  }
});
