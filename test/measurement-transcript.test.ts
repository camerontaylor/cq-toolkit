// M11-fixture: publish the offline fixture transcript. One case per asserted
// condition, under each evidence regime (nominal, missing, failure):
//   - fake-driver local fix.run and review.address reproduce plan transcript
//     (the synthetic fixture F/R transcripts through the merged panels and
//     the composition observation writer/reader);
//   - delete reports before journal classification assertion (classification
//     reconstructs from journal lines alone, reports or no reports);
//   - 129 synthetic cause-bearing attempts classify without sessions (the
//     RP01 regression reconstruction; no session index exists or is read);
//   - imported historical RP01 probable/unknown stay so (recorded certainty
//     is never upgraded by new instrumentation).
// The committed transcript at test/fixtures/measurement/transcript.json is
// SYNTHETIC: fake drivers, fixed timestamps, seeded local repositories. It is
// not live dogfood and claims no completed 30-day collection.
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { openObservationWriter, readObservations } from '../src/kernel/observation.js';
import { STOP_CODE_CLASS, finishAttempt } from '../src/ops/fix/attemptRecord.js';
import { reviewPlannedUnitsOf, verifiedClosuresOf } from '../src/ops/fix/measurement.js';
import { computeMeasurementPanels } from '../scripts/measurement-metrics.mjs';
import type { MeasurementPanelRun } from '../scripts/measurement-metrics.mjs';
import type { MeasurementInputRecord } from '../scripts/measurement-inputs.mjs';
import { computeOutcomePanels } from '../scripts/measurement-outcomes.mjs';
import type {
  AcceptancePayload,
  AttemptFinishedJournalEvent,
  AttemptFinishedPayload,
  BaselineFailureRecord,
  ClosureRecord,
  DispositionPayload,
  FindingFingerprint,
  ObservationEvent,
  ObservationStream,
  ReviewObservedPayload,
} from '../src/kernel/types.js';

// -- fixture -----------------------------------------------------------------

/** One synthetic attempt-finished journal line, fixture-typed. */
type FixtureAttemptEvent = AttemptFinishedJournalEvent;

interface FixtureRun {
  runId: string;
  workId: string;
  compositionRunId: string;
  startedAt: string;
  endedAt: string;
  header: ObservationEvent;
  attempts: FixtureAttemptEvent[];
  fixEvidence?: {
    closures: ClosureRecord[];
    baselineFailures: BaselineFailureRecord[];
    recordedNumerator?: number;
  };
}

/** The minimal cause evidence classification reads: the code and its class. */
interface CauseRow {
  stopReason: string;
  stopCode: string;
  class: string;
  error: { certainty: string } | null;
  timeout?: { scope: string } | null;
}

interface FixtureDoc {
  fixture: string;
  synthetic: boolean;
  repo: string;
  shas: Record<string, string>;
  fixRun: FixtureRun;
  reviewRun: FixtureRun & {
    fingerprints: Record<string, FindingFingerprint>;
    dispositions: unknown[];
    acceptance: unknown;
    reviews: unknown[];
    population: Array<{ headSha: string; mergedAt: string }>;
    observedAt: string;
    followUpDays: number;
  };
  rp01Regression: {
    workId: string;
    compositionRunId: string;
    firstAt: string;
    header: ObservationEvent;
    causes: Record<string, number>;
    shared: Record<string, unknown>;
    templates: Record<string, Omit<AttemptFinishedPayload, 'invocation'>>;
  };
  rp01Historical: { groups: Array<{ group: string; count: number; row: CauseRow }> };
}

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/measurement/transcript.json', import.meta.url), 'utf8'),
) as unknown as FixtureDoc;

// -- helpers -----------------------------------------------------------------

const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-m11-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Materialize one synthetic composition stream through the real writer. */
async function materialize(
  journalDir: string,
  run: {
    workId: string;
    compositionRunId: string;
    header: ObservationEvent;
    attempts: readonly ObservationEvent[];
  },
): Promise<void> {
  const writer = await openObservationWriter({
    journalDir,
    workId: run.workId,
    compositionRunId: run.compositionRunId,
  });
  try {
    await writer.append(run.header);
    for (const event of run.attempts) await writer.append(event);
  } finally {
    await writer.close();
  }
}

/** Synthetic stub reports stand where the compositions would persist them. */
async function writeReportStubs(root: string): Promise<string> {
  const reports = join(root, 'reports');
  await mkdir(reports, { recursive: true });
  for (const run of [fixture.fixRun, fixture.reviewRun])
    await writeFile(
      join(reports, `${run.runId}.json`),
      JSON.stringify({
        synthetic: true,
        note: 'synthetic stub report; deleted before the journal classification assertion',
      }),
    );
  return reports;
}

const attemptRowsOf = (streams: readonly ObservationStream[]): CauseRow[] =>
  streams.flatMap((stream) =>
    stream.events
      .filter((event): event is AttemptFinishedJournalEvent => event.type === 'attempt-finished')
      .map((event) => event.payload),
  );

// Classification is reconstructed from the journal lines alone: the stable
// stop CODE is the classifier input (ADR-0008 fixed table), never human prose,
// never the elapsed wall, never the session archive.
const CAUSE_OF_STOP_CODE: ReadonlyMap<string, string> = new Map([
  ['transport', 'timeout'],
  ['dns', 'dns'],
  ['model-output', 'model'],
  ['provider-outage', 'outage'],
]);

const causeOfRow = (row: CauseRow): string =>
  row.stopCode === 'completed' ? 'completed' : (CAUSE_OF_STOP_CODE.get(row.stopCode) ?? 'unknown');

function causeCounts(rows: readonly CauseRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[causeOfRow(row)] = (counts[causeOfRow(row)] ?? 0) + 1;
  return counts;
}

/** Every row's class matches the merged fixed stop-code table; an unrecognized code is infrastructure. */
const classesConsistent = (rows: readonly CauseRow[]): boolean =>
  rows.every((row) => {
    const expected = STOP_CODE_CLASS.get(row.stopCode);
    return expected === undefined ? row.class === 'infrastructure' : row.class === expected;
  });

const rowsOfCause = (rows: readonly CauseRow[], cause: string): CauseRow[] =>
  rows.filter((row) => causeOfRow(row) === cause);

/** Fixture opt-in to completeness claims, as in the M10c tests. */
function attested(input: Parameters<typeof computeMeasurementPanels>[0]) {
  return computeMeasurementPanels(
    input.evidenceAvailability === undefined ? { ...input, evidenceAvailability: {} } : input,
  );
}

function leafOf(run: FixtureRun, event: FixtureAttemptEvent): MeasurementInputRecord {
  return {
    ...event.payload,
    repo: fixture.repo,
    workId: run.workId,
    runId: event.runId,
    source: `fixture:${run.compositionRunId}`,
  };
}

function panelRunOf(
  run: FixtureRun,
  overrides: Partial<MeasurementPanelRun> = {},
): MeasurementPanelRun {
  return {
    repo: fixture.repo,
    runId: run.runId,
    attempts: run.attempts.map((event) => leafOf(run, event)),
    ...(run.fixEvidence ?? {}),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    ...overrides,
  };
}

const fp = (key: string): FindingFingerprint => {
  const found = fixture.reviewRun.fingerprints[key];
  if (found === undefined) throw new Error(`fixture fingerprint '${key}' is missing`);
  return found;
};

function dispositionRows(): DispositionPayload[] {
  return (
    fixture.reviewRun.dispositions as unknown as Array<
      Omit<DispositionPayload, 'fingerprint'> & { fingerprint: string }
    >
  ).map(({ fingerprint, ...rest }) => ({ ...rest, fingerprint: fp(fingerprint) }));
}

interface FixtureReviewRow extends Omit<
  ReviewObservedPayload,
  'findingFingerprints' | 'initialBlocking'
> {
  findingFingerprints: string[];
  initialBlocking: string[] | null;
}

function reviewRows(): ReviewObservedPayload[] {
  return (fixture.reviewRun.reviews as unknown as FixtureReviewRow[]).map((row) => ({
    ...row,
    findingFingerprints: row.findingFingerprints.map(fp),
    initialBlocking: row.initialBlocking === null ? null : row.initialBlocking.map(fp),
  }));
}

const acceptanceRow = () => fixture.reviewRun.acceptance as unknown as AcceptancePayload;

const fpKey = (f: FindingFingerprint): string =>
  JSON.stringify([f.version, f.checkId, f.rule, f.path, f.spanContentHash]);

/**
 * Latest open blockers: the initial population minus terminal dispositions. A
 * deferred finding stays open. Fixture-level derivation: no merged reader
 * computes latestOpenBlocking over finding-disposition records, so this helper
 * derives it from the transcript's own rows.
 */
function openRemainder(
  initial: readonly FindingFingerprint[],
  dispositions: readonly DispositionPayload[],
): FindingFingerprint[] {
  const terminal = new Set(
    dispositions.filter((d) => d.status !== 'deferred').map((d) => fpKey(d.fingerprint)),
  );
  return initial.filter((f) => !terminal.has(fpKey(f)));
}

/** Expand the synthetic RP01 regression: 129 cause-bearing journal lines. */
function rp01Events(detailless = false): ObservationEvent[] {
  const reg = fixture.rp01Regression;
  const events: ObservationEvent[] = [];
  let seq = 0;
  for (const [cause, count] of Object.entries(reg.causes)) {
    const template = reg.templates[cause];
    if (template === undefined) throw new Error(`fixture rp01 template '${cause}' is missing`);
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      const id = `rp01-${String(seq).padStart(4, '0')}`;
      events.push({
        type: 'attempt-finished',
        runId: reg.compositionRunId,
        at: new Date(Date.parse(reg.firstAt) + seq * 1000).toISOString(),
        unitId: id,
        jobId: null,
        taskId: id,
        attempt: 1,
        payload: {
          ...reg.shared,
          ...template,
          invocation: id,
          ...(detailless ? { error: null, timeout: null } : {}),
        },
      } as unknown as ObservationEvent);
    }
  }
  return events;
}

const rp01Stream = (attempts: readonly ObservationEvent[] = rp01Events()) => ({
  workId: fixture.rp01Regression.workId,
  compositionRunId: fixture.rp01Regression.compositionRunId,
  header: fixture.rp01Regression.header,
  attempts,
});

/** Expand the imported historical RP01 rows (21 probable timeouts, 9 probable outages, 6 unrecoverable). */
function historicalRows(): CauseRow[] {
  const rows: CauseRow[] = [];
  for (const group of fixture.rp01Historical.groups)
    for (let i = 0; i < group.count; i += 1) rows.push({ ...group.row });
  return rows;
}

// -- nominal evidence --------------------------------------------------------

describe('M11-fixture nominal evidence', () => {
  test('fake-driver local fix.run and review.address reproduce plan transcript', () => {
    const fix = fixture.fixRun;
    const fixPanels = attested({ runs: [panelRunOf(fix)] });
    const fixRow = fixPanels.fix.runs[0];
    // c1 closes BOTH t1 and t2 (two closure rows, the producer's one-row-per-
    // unit shape, sharing one commit SHA): one commit, counted once. The todo
    // commit is excluded by the panel's todo rule.
    expect(fixRow?.fixesPerRun).toEqual({ numerator: 1, denominator: null });
    expect(fixRow?.verifiedCommits).toEqual([fixture.shas.c1]);
    // The failed retained commit f1 is excluded by the producer predicate
    // itself (fixed + validated + trailer-linked): driven through the merged
    // verifiedClosuresOf, the failed task's commit never becomes a closure, so
    // it can never reach the panel's verified list.
    const messages = new Map([
      [fixture.shas.c1, 'fix unit A\n\nCq-Task: task-t1'],
      [fixture.shas.f1, 'failed attempt evidence\n\nCq-Task: task-f1'],
    ]);
    const produced = verifiedClosuresOf(
      [
        {
          task: { id: 'task-t1', files: [], failures: [] },
          attempts: [],
          outcome: 'fixed',
          branch: 'fixture/f',
          commits: [fixture.shas.c1],
          validation: { verdict: 'pass', gates: [] },
        },
        {
          task: { id: 'task-f1', files: [], failures: [] },
          attempts: [],
          outcome: 'unfixed',
          branch: 'fixture/f',
          commits: [fixture.shas.f1],
        },
      ],
      (sha) => messages.get(sha),
    );
    expect(produced.closures.map((row) => row.commitSha)).toEqual([fixture.shas.c1]);
    expect(produced.unknownTrailerShas).toEqual([]);
    // baselineFailures known=5 (A=3, B=2) beside unknownUnits=1 (C cancelled
    // before its probe): the denominator is unknown, never 5 and never 0.
    const units = fix.fixEvidence?.baselineFailures ?? [];
    expect(units.reduce((sum, unit) => sum + (unit.count ?? 0), 0)).toBe(5);
    expect(units.filter((unit) => unit.count === null)).toHaveLength(1);
    // There is no ratio to print for an unknown denominator: the fix panel is
    // per-run only (a known-zero baseline gives no infinite rate either).
    expect(Object.keys(fixPanels.fix)).toEqual(['runs']);
    // The plan's attempt lines: worker 120 tokens / 50 ms infrastructure
    // timeout, rescue 80 tokens / 30 ms to a verified commit.
    expect(fixPanels.cost.attemptWallMs).toBe(80);
    expect(fixPanels.cost.usageChannels).toEqual({ input: 200, output: 50 });
    expect(fixPanels.cost.runElapsedMs).toBe(300000);

    const review = fixture.reviewRun;
    const reviewPanels = attested({ runs: [panelRunOf(review)] });
    // fixesPerRun=1 (c2 for finding a) over the captured initial population of 3.
    expect(reviewPanels.fix.runs[0]?.fixesPerRun).toEqual({ numerator: 1, denominator: 3 });
    const outcomes = computeOutcomePanels({
      reviews: reviewRows(),
      dispositions: dispositionRows(),
      acceptances: [acceptanceRow()],
      population: review.population,
      ciObservedHeads: [],
      followUpDays: review.followUpDays,
      observedAt: review.observedAt,
    });
    // The independent fixture-critic PASS at h1 makes exactly that head
    // eligible and mature; the acceptance is never credited to h2.
    expect(outcomes.population.eligible).toBe(1);
    expect(outcomes.population.mature).toBe(1);
    expect(
      outcomes.unknown.filter((row) => row.reason.includes('no independent PASS acceptance')),
    ).toHaveLength(1);
    // rounds/exposures=2: both review rounds are observed (1 and 2).
    expect(reviewRows().map((row) => row.round)).toEqual([1, 2]);
    // initialOpenBlocking=3, latestOpenBlocking=1 (fixture-level derivation):
    // only the deferred finding c stays open (fixed a and rejected b are
    // terminal).
    const initial = reviewRows()[0]?.initialBlocking ?? [];
    expect(initial).toHaveLength(3);
    const open = openRemainder(initial, dispositionRows());
    expect(open).toHaveLength(1);
    expect(open[0] && fpKey(open[0])).toBe(fpKey(fp('c')));
    // The EAI_AGAIN attempt on c is infrastructure — an attempt outcome, not
    // itself a deferral (class human would be the deferral signal).
    const eai = review.attempts[1]?.payload;
    expect(eai?.stopCode).toBe('dns');
    expect(eai?.class).toBe('infrastructure');
  });

  test('129 synthetic cause-bearing attempts classify without sessions', async () => {
    const root = await tempRoot();
    // No session archive exists for this synthetic run. A stray session index
    // beside the observations tree is not journal evidence and is never read.
    await writeFile(
      join(root, 'session-index.json'),
      JSON.stringify({ indexVersion: 1, sessions: [] }),
    );
    await materialize(root, rp01Stream());
    const streams = await readObservations(root);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.complete).toBe(true);
    const rows = attemptRowsOf(streams);
    expect(rows).toHaveLength(129);
    expect(causeCounts(rows)).toEqual({ timeout: 41, dns: 29, model: 47, unknown: 12 });
    expect(classesConsistent(rows)).toBe(true);
  });

  test('delete reports before journal classification assertion', async () => {
    const root = await tempRoot();
    const reports = await writeReportStubs(root);
    await materialize(root, fixture.fixRun);
    await materialize(root, fixture.reviewRun);
    // Delete the reports BEFORE classifying: the journal lines are the only
    // remaining evidence, and the classification is unchanged by that.
    await rm(reports, { recursive: true, force: true });
    const rows = attemptRowsOf(await readObservations(root));
    expect(rows).toHaveLength(4);
    expect(causeCounts(rows)).toEqual({ completed: 2, timeout: 1, dns: 1 });
    expect(classesConsistent(rows)).toBe(true);
  });

  test('imported historical RP01 probable/unknown stay so', () => {
    // No merged historical importer exists yet, so these cases pin the rows'
    // recorded certainty against the classification's refusal to re-guess;
    // the upgrade refusal becomes enforceable when an importer lands.
    const rows = historicalRows();
    expect(rows).toHaveLength(36);
    expect(causeCounts(rows)).toEqual({ timeout: 21, outage: 9, unknown: 6 });
    expect(classesConsistent(rows)).toBe(true);
    // Probable stays inferred (21 timeouts, 9 outages), unrecoverable stays
    // unknown (no cause evidence at all): nothing is recorded-observed.
    for (const cause of ['timeout', 'outage'])
      expect(rowsOfCause(rows, cause).every((row) => row.error?.certainty === 'inferred')).toBe(
        true,
      );
    expect(rowsOfCause(rows, 'unknown').every((row) => row.error === null)).toBe(true);
    expect(rows.every((row) => row.error?.certainty !== 'observed')).toBe(true);
  });
});

// -- missing evidence --------------------------------------------------------

describe('M11-fixture missing evidence', () => {
  test('fake-driver local fix.run and review.address reproduce plan transcript', () => {
    const fix = fixture.fixRun;
    // No closure evidence was collected: the numerator is unknown, never zero.
    const { closures: _c, recordedNumerator: _n, ...fixBaseline } = fix.fixEvidence ?? {};
    const fixMissing = attested({
      runs: [
        {
          repo: fixture.repo,
          runId: fix.runId,
          attempts: fix.attempts.map((event) => leafOf(fix, event)),
          ...fixBaseline,
          startedAt: fix.startedAt,
          endedAt: fix.endedAt,
        },
      ],
    });
    expect(fixMissing.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    // The empty list is not evidence of zero commits: the null numerator above
    // carries the unknown (merged M10c behaviour).
    expect(fixMissing.fix.runs[0]?.verifiedCommits).toEqual([]);
    // No initial open-blocker population was captured: the review denominator
    // is unknown, never recomputed from the survivors.
    const review = fixture.reviewRun;
    const { baselineFailures: _b, ...reviewClosures } = review.fixEvidence ?? {};
    const reviewMissing = attested({
      runs: [
        {
          repo: fixture.repo,
          runId: review.runId,
          attempts: review.attempts.map((event) => leafOf(review, event)),
          ...reviewClosures,
          startedAt: review.startedAt,
          endedAt: review.endedAt,
        },
      ],
    });
    expect(reviewMissing.fix.runs[0]?.fixesPerRun.denominator).toBeNull();
    // The merged planned-units seam says the same thing about the capture: a
    // captured population is the denominator evidence, and a report that never
    // captured one yields null (unknown) — never a known zero off an empty list.
    const captured = (fixture.reviewRun.reviews as unknown as FixtureReviewRow[])[0]
      ?.initialBlocking;
    expect(captured && reviewPlannedUnitsOf({ initialOpenBlocking: captured })).toHaveLength(3);
    expect(reviewPlannedUnitsOf({})).toBeNull();
    // No acceptance evidence was imported: no head is eligible and both
    // declared PRs are unknown, never silently clean.
    const outcomes = computeOutcomePanels({
      reviews: reviewRows(),
      dispositions: dispositionRows(),
      acceptances: [],
      population: review.population,
      ciObservedHeads: [],
      followUpDays: review.followUpDays,
      observedAt: review.observedAt,
    });
    expect(outcomes.population.eligible).toBe(0);
    expect(
      outcomes.unknown.filter((row) => row.reason.includes('no independent PASS acceptance')),
    ).toHaveLength(2);
  });

  test('delete reports before journal classification assertion', async () => {
    const root = await tempRoot();
    await materialize(root, fixture.fixRun);
    await materialize(root, fixture.reviewRun);
    // The reports were never persisted at all, and a crash before the header
    // left one empty (explicitly incomplete) stream: the journal lines that
    // do exist still classify, and nothing is invented for the rest.
    await mkdir(join(root, 'observations', fixture.rp01Regression.workId), { recursive: true });
    await writeFile(
      join(root, 'observations', fixture.rp01Regression.workId, 'cr-rp01-regression.ndjson'),
      '',
    );
    const streams = await readObservations(root);
    expect(streams).toHaveLength(3);
    expect(streams.filter((stream) => stream.complete)).toHaveLength(2);
    const rows = attemptRowsOf(streams);
    expect(causeCounts(rows)).toEqual({ completed: 2, timeout: 1, dns: 1 });
  });

  test('129 synthetic cause-bearing attempts classify without sessions', async () => {
    const root = await tempRoot();
    // Detail-stripped reconstruction: the error and timeout records are gone.
    // The stable code is the classifier input — never the prose, never the
    // elapsed wall — so every bucket is unchanged without session evidence.
    await materialize(root, rp01Stream(rp01Events(true)));
    const rows = attemptRowsOf(await readObservations(root));
    expect(rows).toHaveLength(129);
    expect(causeCounts(rows)).toEqual({ timeout: 41, dns: 29, model: 47, unknown: 12 });
    expect(classesConsistent(rows)).toBe(true);
    expect(rows.every((row) => row.error === null && row.timeout === null)).toBe(true);
  });

  test('imported historical RP01 probable/unknown stay so', () => {
    // The original error detail is lost; the recorded certainty is the
    // evidence: probable rows stay inferred and unrecoverable rows stay
    // unknown — never observed, and never re-guessed from what is gone. (No
    // merged importer exists yet; this pins the recorded certainty, not an
    // admission path.)
    const rows = historicalRows().map((row) => ({
      ...row,
      error:
        row.error === null
          ? null
          : { ...row.error, type: null, code: null, providerFinishReason: null },
    }));
    expect(causeCounts(rows)).toEqual({ timeout: 21, outage: 9, unknown: 6 });
    for (const cause of ['timeout', 'outage'])
      expect(rowsOfCause(rows, cause).every((row) => row.error?.certainty === 'inferred')).toBe(
        true,
      );
    expect(rows.every((row) => row.error?.certainty !== 'observed')).toBe(true);
  });
});

// -- failure evidence --------------------------------------------------------

describe('M11-fixture failure evidence', () => {
  test('fake-driver local fix.run and review.address reproduce plan transcript', () => {
    const fix = fixture.fixRun;
    const closures = fix.fixEvidence?.closures ?? [];
    // A contradictory todo trailer on the same SHA makes the count uncertain:
    // unknown, never a pick.
    const conflict = attested({
      runs: [panelRunOf(fix, { closures: [...closures, { ...closures[0]!, todo: true }] })],
    });
    expect(conflict.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    // A producer scalar disagreeing with the distinct verified count withholds it.
    const disagreement = attested({ runs: [panelRunOf(fix, { recordedNumerator: 5 })] });
    expect(disagreement.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    // An inverted provenance window is unknown while the attempt wall stays known.
    const inverted = attested({
      runs: [panelRunOf(fix, { startedAt: fix.endedAt, endedAt: fix.startedAt })],
    });
    expect(inverted.cost.runElapsedMs).toBeNull();
    expect(inverted.cost.availability['/runElapsedMs']?.state).toBe('unavailable');
    expect(inverted.cost.attemptWallMs).toBe(80);
    // The EAI_AGAIN failure on c is an attempt outcome, never a deferral: no
    // attempt carries class human, and c's deferral exists only as a
    // deliberate disposition with a nonempty trigger. With that record
    // withheld the finding stays open and unresolved — an operational failure
    // never disposes a finding.
    const review = fixture.reviewRun;
    expect(review.attempts.every((event) => event.payload.class !== 'human')).toBe(true);
    const deliberate = dispositionRows().filter((d) => d.status === 'deferred');
    expect(deliberate).toHaveLength(1);
    expect(deliberate[0]?.reviewTrigger).toBe('domain-answer');
    const initial = reviewRows()[0]?.initialBlocking ?? [];
    expect(
      openRemainder(
        initial,
        dispositionRows().filter((d) => d.status !== 'deferred'),
      ),
    ).toHaveLength(1);
  });

  test('delete reports before journal classification assertion', async () => {
    const root = await tempRoot();
    const reg = fixture.rp01Regression;
    const streamPath = join(root, 'observations', reg.workId, `${reg.compositionRunId}.ndjson`);
    await materialize(root, rp01Stream());
    // A crash mid-append tears only the final line (the 129th attempt dies
    // unterminated): the surviving prefix is partial evidence that classifies
    // what landed, never a completion.
    const whole = await readFile(streamPath, 'utf8');
    await writeFile(streamPath, whole.slice(0, -10));
    const torn = await readObservations(root);
    expect(torn[0]?.complete).toBe(false);
    const rows = attemptRowsOf(torn);
    expect(rows).toHaveLength(128);
    expect(causeCounts(rows)).toEqual({ timeout: 41, dns: 29, model: 47, unknown: 11 });
    // Completing that line with unparsable bytes is corruption, refused
    // loudly — never folded into a count.
    await appendFile(streamPath, '\u0000not json\n');
    await expect(readObservations(root)).rejects.toThrow(/corrupt/);
  });

  test('129 synthetic cause-bearing attempts classify without sessions', async () => {
    const root = await tempRoot();
    const reg = fixture.rp01Regression;
    const at = new Date(Date.parse(reg.firstAt) + 200_000).toISOString();
    const inject = (id: string, payload: Partial<AttemptFinishedPayload>): ObservationEvent => ({
      type: 'attempt-finished',
      runId: reg.compositionRunId,
      at,
      unitId: id,
      jobId: null,
      taskId: id,
      attempt: 1,
      payload: {
        ...reg.shared,
        invocation: id,
        timeout: null,
        ...payload,
      } as unknown as AttemptFinishedPayload,
    });
    const injected = [
      inject('rp01-inject-1', {
        // An unrecognized live code with timeout-flavored prose: unknown, by
        // the code alone — prose never migrates a bucket.
        stopReason: 'gateway melted before the request timed out',
        stopCode: 'mystery-glitch',
        class: 'infrastructure',
        error: {
          type: 'Error',
          code: 'mystery-glitch',
          providerFinishReason: null,
          source: 'fixture inject',
          certainty: 'unknown',
        },
      }),
      inject('rp01-inject-2', {
        // A model failure whose prose says timeout stays a model failure.
        stopReason: 'request timed out while the model was editing',
        stopCode: 'model-output',
        class: 'terminal',
        error: {
          type: 'APIError',
          code: 'malformed-edit',
          providerFinishReason: null,
          source: 'fixture inject',
          certainty: 'observed',
        },
      }),
    ];
    await materialize(root, rp01Stream([...rp01Events(), ...injected]));
    const rows = attemptRowsOf(await readObservations(root));
    expect(rows).toHaveLength(131);
    expect(causeCounts(rows)).toEqual({ timeout: 41, dns: 29, model: 48, unknown: 13 });
    expect(classesConsistent(rows)).toBe(true);
    // The merged boundary classifier normalizes an unrecognized live code the
    // same way the reconstruction reads it: infrastructure / unclassified,
    // certainty unknown.
    const normalized = finishAttempt({
      tier: 'worker',
      invocation: 'inject-3',
      model: null,
      stopCode: 'mystery-glitch',
      stopReason: 'gateway melted',
    });
    expect(normalized.stopCode).toBe('unclassified');
    expect(normalized.class).toBe('infrastructure');
    expect(normalized.error?.certainty).toBe('unknown');
    expect(causeOfRow(normalized)).toBe('unknown');
  });

  test('imported historical RP01 probable/unknown stay so', () => {
    // No merged historical importer exists yet: this pins the recorded
    // certainty, not an admission path.
    const outage = fixture.rp01Historical.groups[1]?.row;
    if (outage === undefined) throw new Error('fixture rp01 outage group is missing');
    const rows = [
      ...historicalRows(),
      // An unrecognized historical code is unknown-cause, never an outage by
      // affiliation; a probable outage whose prose mentions timeouts stays an
      // outage. Re-running the classification upgrades nothing.
      {
        stopReason: 'gateway melted (prose mentions timeout)',
        stopCode: 'rpc-havoc',
        class: 'infrastructure',
        error: {
          type: 'Error',
          code: null,
          providerFinishReason: null,
          source: 'rp01 historical import',
          certainty: 'unknown',
        },
      },
      {
        ...outage,
        stopReason: 'probable provider outage; a request timed out during the incident',
      },
    ];
    expect(rows).toHaveLength(38);
    expect(causeCounts(rows)).toEqual({ timeout: 21, outage: 10, unknown: 7 });
    expect(classesConsistent(rows)).toBe(true);
    // Classifying independent copies a second time upgrades nothing: the same
    // buckets, the same recorded certainties (no merged importer exists yet, so
    // this pins the recorded certainty rather than an admission path).
    const copies = rows.map((row) => ({
      ...row,
      error: row.error === null ? null : { ...row.error },
    }));
    expect(causeCounts(copies)).toEqual({ timeout: 21, outage: 10, unknown: 7 });
    expect(copies.every((row) => row.error?.certainty !== 'observed')).toBe(true);
    for (const cause of ['timeout', 'outage'])
      expect(rowsOfCause(rows, cause).every((row) => row.error?.certainty === 'inferred')).toBe(
        true,
      );
    expect(rows.every((row) => row.error?.certainty !== 'observed')).toBe(true);
  });
});
