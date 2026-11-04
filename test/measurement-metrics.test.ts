// M10c: compute fix and cost panels over M10b-admitted evidence. One case per
// asserted condition, under each evidence regime (nominal, missing, failure):
//   - verified SHAs separate defects — the numerator counts distinct verified
//     non-todo closure commits; one commit closing two findings counts once,
//     and separate SHAs count separately;
//   - dedup invocation usage channels — channel usage sums once per
//     (repo, runId, invocation) leaf identity, and disagreeing copies of one
//     identity contribute nothing (a conflict, never a silent pick);
//   - run elapsed differs from summed attempt wall — the provenance window is
//     reported beside the attempt-wall sum, per run and in aggregate, and
//     neither ever stands in for the other;
//   - modeled price coverage explicit — modeledUsd never reads as complete
//     without a uniform non-null priceCoverage/priceTableRevision statement;
//   - untrusted child values unknown rather than zero — a null child value,
//     a torn leaf or a rejected input degrades completeness, never a zero;
//   - per-run denominator only — fixesPerRun stays per-run with no cross-run
//     ratio, and a placeholder unit (null count) never mixes into the
//     denominator: the aggregate goes null, not a subtotal.
// Local fixtures only: in-memory rows in the M10b reader shapes, no files,
// no providers, no network.
import { describe, expect, test } from 'vitest';
import { computeMeasurementPanels } from '../scripts/measurement-metrics.mjs';
import type {
  AvailabilityRecord,
  AvailabilityState,
  BaselineFailureRecord,
  ClosureRecord,
} from '../src/kernel/types.js';
import type {
  MeasurementInputRecord,
  UnknownMeasurementInput,
} from '../scripts/measurement-inputs.mjs';
import type { MeasurementPanelRun } from '../scripts/measurement-metrics.mjs';

const REPO = `sha256:${'a'.repeat(64)}`;
const RUN = 'run-1';
const RUN2 = 'run-2';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

function leaf(
  invocation: string,
  overrides: Partial<MeasurementInputRecord> = {},
): MeasurementInputRecord {
  return {
    tier: 'worker',
    invocation,
    model: { model: 'glm-5.3', provider: 'zai' },
    provider: 'zai',
    requestedModel: 'glm-5.3',
    servedModel: null,
    tokens: 10,
    usageChannels: {},
    requests: 1,
    wallMs: 1_000,
    modeledUsd: null,
    priceTableRevision: null,
    priceCoverage: null,
    stopReason: 'completed',
    stopCode: 'completed',
    class: 'terminal',
    error: null,
    timeout: null,
    budget: {
      allowed: { tokens: null, wallMs: null },
      spent: { tokens: 10, wallMs: 1_000 },
      remaining: { tokens: null, wallMs: null },
    },
    availability: {},
    repo: REPO,
    workId: '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f',
    runId: RUN,
    source: 'bundle:reports/w/r.json',
    ...overrides,
  };
}

const avail = (state: AvailabilityState, reason: string): AvailabilityRecord => ({
  state,
  reason,
  source: null,
});

function closure(commitSha: string, todo = false): ClosureRecord {
  return {
    commitSha,
    taskIds: ['task-1'],
    findingFingerprints: [],
    verificationEvidence: ['validation: pass'],
    todo,
  };
}

function baseline(unitId: string, count: number | null): BaselineFailureRecord {
  return {
    unitId,
    probeHead: count === null ? null : 'b'.repeat(40),
    completed: count !== null,
    count,
    unknownReason: count === null ? 'probe never ran' : null,
  };
}

function makeRun(overrides: Partial<MeasurementPanelRun> = {}): MeasurementPanelRun {
  return {
    repo: REPO,
    runId: RUN,
    attempts: [],
    closures: [],
    baselineFailures: [],
    startedAt: '2026-11-03T04:00:00.000Z',
    endedAt: '2026-11-03T04:02:00.000Z',
    ...overrides,
  };
}

describe('M10c nominal evidence', () => {
  test('verified SHAs separate defects', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          closures: [closure(SHA1), closure(SHA1), closure(SHA2, true), closure(SHA3)],
          baselineFailures: [baseline('unit-1', 3), baseline('unit-2', 4)],
        }),
      ],
    });
    const [row] = panels.fix.runs;
    // SHA1 closes two findings yet counts once; SHA2 is a todo commit; SHA3 is
    // a separate defect.
    expect(row?.fixesPerRun.numerator).toBe(2);
    expect(row?.verifiedCommits).toEqual([SHA1, SHA3]);
    expect(row?.fixesPerRun.denominator).toBe(7);
    // One commit closing two distinct findings (different task links) is
    // multiplicity, never a conflict: it still counts once, and a matching
    // producer-recorded scalar cross-checks through.
    const multiplicity = computeMeasurementPanels({
      runs: [
        makeRun({
          closures: [{ ...closure(SHA1), taskIds: ['task-2'] }, closure(SHA1), closure(SHA3)],
          recordedNumerator: 2,
          baselineFailures: [baseline('unit-1', 3), baseline('unit-2', 4)],
        }),
      ],
    });
    expect(multiplicity.fix.runs[0]?.fixesPerRun.numerator).toBe(2);
    expect(multiplicity.fix.runs[0]?.verifiedCommits).toEqual([SHA1, SHA3]);
  });

  test('dedup invocation usage channels', () => {
    const once = leaf('inv-1', { usageChannels: { input: 100, output: 50 }, wallMs: 60_000 });
    const panels = computeMeasurementPanels({
      runs: [makeRun({ attempts: [once, { ...once }] })],
    });
    expect(panels.cost.usageChannels).toEqual({ input: 100, output: 50 });
    expect(panels.cost.availability['/usageChannels/input']?.state).toBe('known');
    expect(panels.cost.attemptWallMs).toBe(60_000);
  });

  test('run elapsed differs from summed attempt wall', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          startedAt: '2026-11-03T04:00:00.000Z',
          endedAt: '2026-11-03T04:02:00.000Z',
          attempts: [leaf('inv-1', { wallMs: 60_000 }), leaf('inv-2', { wallMs: 30_000 })],
        }),
      ],
    });
    // The window (120s) exceeds the summed attempt wall (90s): both figures
    // are reported, neither substituted for the other.
    expect(panels.cost.runElapsedMs).toBe(120_000);
    expect(panels.cost.attemptWallMs).toBe(90_000);
    // Fractional instants compare as instants, never as strings.
    const fractional = computeMeasurementPanels({
      runs: [makeRun({ startedAt: '2026-11-03T04:00:00.000Z', endedAt: '2026-11-03T04:02:00.5Z' })],
    });
    expect(fractional.cost.runElapsedMs).toBe(120_500);
    // An identical duplicate run entry is admitted once: the window is not
    // doubled and there is one fix row.
    const once = makeRun({ attempts: [leaf('inv-3')] });
    const duplicated = computeMeasurementPanels({ runs: [once, { ...once }] });
    expect(duplicated.cost.runElapsedMs).toBe(120_000);
    expect(duplicated.fix.runs).toHaveLength(1);
  });

  test('modeled price coverage explicit', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', {
              modeledUsd: 0.25,
              priceCoverage: 'full',
              priceTableRevision: 'rev-2026-11',
            }),
            leaf('inv-2', {
              modeledUsd: 0.5,
              priceCoverage: 'full',
              priceTableRevision: 'rev-2026-11',
            }),
          ],
        }),
      ],
    });
    expect(panels.cost.modeledUsd).toBe(0.75);
    expect(panels.cost.priceCoverage).toBe('full');
    expect(panels.cost.priceTableRevision).toBe('rev-2026-11');
    expect(panels.cost.availability['/modeledUsd']?.state).toBe('known');
  });

  test('untrusted child values unknown rather than zero', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({ attempts: [leaf('inv-1', { usageChannels: { input: 100, cached: null } })] }),
      ],
    });
    // The child could not report its cached-channel usage: unknown stays
    // null, never a zero, while the observed channel stays known.
    expect(panels.cost.usageChannels.cached).toBeNull();
    expect(panels.cost.availability['/usageChannels/cached']?.state).toBe('not-collected');
    expect(panels.cost.usageChannels.input).toBe(100);
    expect(panels.cost.availability['/usageChannels/input']?.state).toBe('known');
    // A torn per-channel pointer degrades exactly its own channel: the sibling
    // channel and the attempt wall stay known, and a pointer the panel does
    // not consume (/servedModel) degrades nothing at all.
    const scoped = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-2', {
              usageChannels: { input: 100, output: 50 },
              wallMs: 5_000,
              availability: { '/usageChannels/input': avail('partial', 'settled late') },
            }),
          ],
        }),
      ],
    });
    expect(scoped.cost.availability['/usageChannels/input']?.state).toBe('partial');
    expect(scoped.cost.availability['/usageChannels/output']?.state).toBe('known');
    expect(scoped.cost.availability['/attemptWallMs']?.state).toBe('known');
    // A channel name containing the pointer metacharacters is escaped in its
    // availability pointer and torn exactly on its own channel.
    const escaped = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-4', {
              usageChannels: { 'cache/edge~2': 25, input: 100 },
              availability: { '/usageChannels/cache~1edge~02': avail('partial', 'settled late') },
            }),
          ],
        }),
      ],
    });
    expect(escaped.cost.usageChannels['cache/edge~2']).toBe(25);
    expect(escaped.cost.availability['/usageChannels/cache~1edge~02']?.state).toBe('partial');
    expect(escaped.cost.availability['/usageChannels/input']?.state).toBe('known');
    const unrelated = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-3', {
              usageChannels: { input: 100 },
              availability: { '/servedModel': avail('unavailable', 'provider omitted it') },
            }),
          ],
        }),
      ],
    });
    expect(unrelated.cost.availability['/usageChannels/input']?.state).toBe('known');
  });

  test('per-run denominator only, never mix placeholder units with failures', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({ baselineFailures: [baseline('unit-1', 3), baseline('unit-2', 4)] }),
        makeRun({
          runId: RUN2,
          baselineFailures: [baseline('unit-3', 2), baseline('unit-4', null)],
        }),
      ],
    });
    // fixesPerRun stays per-run: no aggregate ratio exists on the panel.
    expect(Object.keys(panels.fix)).toEqual(['runs']);
    expect(panels.fix.runs[0]?.fixesPerRun.denominator).toBe(7);
    // A placeholder unit never mixes into run-2's denominator: unknown, not 2.
    expect(panels.fix.runs[1]?.fixesPerRun.denominator).toBeNull();
    // Identical duplicate baseline rows are admitted once: the denominator
    // is not doubled.
    const dupUnits = computeMeasurementPanels({
      runs: [makeRun({ baselineFailures: [baseline('unit-1', 3), baseline('unit-1', 3)] })],
    });
    expect(dupUnits.fix.runs[0]?.fixesPerRun.denominator).toBe(3);
  });
});

describe('M10c missing evidence', () => {
  test('verified SHAs separate defects', () => {
    const panels = computeMeasurementPanels({
      runs: [
        {
          repo: REPO,
          runId: RUN,
          attempts: [],
          startedAt: '2026-11-03T04:00:00.000Z',
          endedAt: '2026-11-03T04:02:00.000Z',
        },
      ],
    });
    // No closure evidence was collected: the numerator is unknown, never zero.
    expect(panels.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    expect(panels.fix.runs[0]?.verifiedCommits).toEqual([]);
  });

  test('dedup invocation usage channels', () => {
    const panels = computeMeasurementPanels({ runs: [makeRun()] });
    expect(panels.cost.usageChannels).toEqual({});
    expect(panels.cost.availability['/usageChannels']?.state).toBe('n-a');
  });

  test('run elapsed differs from summed attempt wall', () => {
    const panels = computeMeasurementPanels({
      runs: [makeRun({ endedAt: null, attempts: [leaf('inv-1', { wallMs: 60_000 })] })],
    });
    // The window never completed: elapsed is unknown and never borrows the
    // attempt wall, which stays its own known figure.
    expect(panels.cost.runElapsedMs).toBeNull();
    expect(panels.cost.availability['/runElapsedMs']?.state).toBe('not-collected');
    expect(panels.cost.attemptWallMs).toBe(60_000);
  });

  test('modeled price coverage explicit', () => {
    const panels = computeMeasurementPanels({
      runs: [makeRun({ attempts: [leaf('inv-1'), leaf('inv-2')] })],
    });
    // No modeled price was collected: null with an explicit coverage
    // statement, never a zero and never an implied covered total.
    expect(panels.cost.modeledUsd).toBeNull();
    expect(panels.cost.priceCoverage).toBeNull();
    expect(panels.cost.availability['/modeledUsd']?.state).toBe('not-collected');
  });

  test('untrusted child values unknown rather than zero', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [leaf('inv-1', { wallMs: 1_000 }), leaf('inv-2', { wallMs: null })],
        }),
      ],
    });
    // One child's wall is unknown: the sum is a partial subtotal, never a
    // known total over a silently zeroed child.
    expect(panels.cost.attemptWallMs).toBe(1_000);
    expect(panels.cost.availability['/attemptWallMs']?.state).toBe('partial');
  });

  test('per-run denominator only, never mix placeholder units with failures', () => {
    const panels = computeMeasurementPanels({
      runs: [
        {
          repo: REPO,
          runId: RUN,
          attempts: [],
          closures: [],
          startedAt: '2026-11-03T04:00:00.000Z',
          endedAt: '2026-11-03T04:02:00.000Z',
        },
      ],
    });
    expect(panels.fix.runs[0]?.fixesPerRun.denominator).toBeNull();
  });
});

describe('M10c failure evidence', () => {
  test('verified SHAs separate defects', () => {
    const panels = computeMeasurementPanels({
      runs: [makeRun({ closures: [closure(SHA1, true), closure(SHA2, true)] })],
    });
    // Every closure is a todo commit: a measured zero, never an unknown and
    // never a counted defect.
    expect(panels.fix.runs[0]?.fixesPerRun.numerator).toBe(0);
    expect(panels.fix.runs[0]?.verifiedCommits).toEqual([]);
    // The producer declared the numerator unknown (unreadable trailer
    // commits) while closure rows exist: it stays unknown, never a count.
    const declaredUnknown = computeMeasurementPanels({
      runs: [makeRun({ closures: [closure(SHA3)], recordedNumerator: null })],
    });
    expect(declaredUnknown.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    expect(declaredUnknown.fix.runs[0]?.verifiedCommits).toEqual([SHA3]);
    // A recorded scalar disagreeing with the distinct-SHA count is withheld.
    const disagreement = computeMeasurementPanels({
      runs: [makeRun({ closures: [closure(SHA3)], recordedNumerator: 5 })],
    });
    expect(disagreement.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    // The same SHA with contradictory todo trailers is a conflict: the count
    // is uncertain and therefore unknown.
    const todoConflict = computeMeasurementPanels({
      runs: [makeRun({ closures: [closure(SHA1), closure(SHA1, true)] })],
    });
    expect(todoConflict.fix.runs[0]?.fixesPerRun.numerator).toBeNull();
    expect(todoConflict.fix.runs[0]?.verifiedCommits).toEqual([]);
  });

  test('dedup invocation usage channels', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', { usageChannels: { input: 100 }, wallMs: 1_000 }),
            leaf('inv-1', { usageChannels: { input: 300 }, wallMs: 2_000 }),
          ],
        }),
      ],
    });
    // Two disagreeing copies of one invocation identity are a conflict:
    // neither copy's usage counts, and the totals say why they are unknown.
    expect(panels.cost.usageChannels).toEqual({});
    expect(panels.cost.availability['/usageChannels']?.state).toBe('unavailable');
    expect(panels.cost.attemptWallMs).toBeNull();
    expect(panels.cost.availability['/attemptWallMs']?.state).toBe('unavailable');
    // The conflict is order-independent, and a third copy cannot resurrect
    // the identity: whichever order the evidence arrives in, nothing counts.
    const reversed = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', { usageChannels: { input: 300 }, wallMs: 2_000 }),
            leaf('inv-1', { usageChannels: { input: 100 }, wallMs: 1_000 }),
          ],
        }),
      ],
    });
    expect(reversed.cost.usageChannels).toEqual({});
    expect(reversed.cost.attemptWallMs).toBeNull();
    const triple = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', { usageChannels: { input: 300 } }),
            leaf('inv-1', { usageChannels: { input: 100 } }),
            leaf('inv-1', { usageChannels: { input: 100 } }),
          ],
        }),
      ],
    });
    expect(triple.cost.usageChannels).toEqual({});
    // Shape guards reject malformed input rather than reading it.
    expect(() => computeMeasurementPanels({ runs: [makeRun(), makeRun()] })).not.toThrow();
    expect(() =>
      computeMeasurementPanels({
        // @ts-expect-error runtime shape guard, not a type-level one
        runs: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      computeMeasurementPanels({
        // @ts-expect-error runtime shape guard, not a type-level one
        runs: [{ repo: REPO, runId: RUN }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      computeMeasurementPanels({
        runs: [makeRun()],
        // @ts-expect-error runtime shape guard, not a type-level one
        unknown: 'nope',
      }),
    ).toThrow(TypeError);
    // An attempt row with a missing wall field is unknown, never a known NaN.
    const { wallMs: _wallMs, ...rowless } = leaf('inv-2');
    const missing = computeMeasurementPanels({
      runs: [makeRun({ attempts: [rowless as MeasurementInputRecord] })],
    });
    expect(missing.cost.attemptWallMs).toBeNull();
    expect(missing.cost.availability['/attemptWallMs']?.state).toBe('not-collected');
  });

  test('run elapsed differs from summed attempt wall', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          startedAt: '2026-11-03T04:02:00.000Z',
          endedAt: '2026-11-03T04:00:00.000Z',
          attempts: [leaf('inv-1', { wallMs: 60_000 })],
        }),
      ],
    });
    // An offset-less stamp would be read in the host timezone and mix into a
    // silently wrong window (2h reads as 13h under UTC+11): ADR-0008 instants
    // are UTC ISO-8601, so anything but the Z-form on both stamps is unknown,
    // whatever the host timezone is.
    const mixedStamps = computeMeasurementPanels({
      runs: [makeRun({ startedAt: '2026-11-03T04:00:00.000Z', endedAt: '2026-11-03T06:00:00' })],
    });
    expect(mixedStamps.cost.runElapsedMs).toBeNull();
    expect(mixedStamps.cost.availability['/runElapsedMs']?.state).toBe('unavailable');
    const offsetlessPair = computeMeasurementPanels({
      runs: [makeRun({ startedAt: '2026-11-03T04:00:00', endedAt: '2026-11-03T06:00:00' })],
    });
    expect(offsetlessPair.cost.runElapsedMs).toBeNull();
    expect(offsetlessPair.cost.availability['/runElapsedMs']?.state).toBe('unavailable');
    // An inverted window is unknown, and the attempt wall stays known beside
    // it: the failure of one figure never corrupts the other.
    expect(panels.cost.runElapsedMs).toBeNull();
    expect(panels.cost.availability['/runElapsedMs']?.state).toBe('unavailable');
    expect(panels.cost.attemptWallMs).toBe(60_000);
    // Two disagreeing run entries conflict: the window is unknown and the fix
    // figures are withheld, never silently picked from one copy.
    const conflictedRun = computeMeasurementPanels({
      runs: [
        makeRun({ startedAt: '2026-11-03T04:00:00.000Z' }),
        makeRun({ startedAt: '2026-11-03T05:00:00.000Z' }),
      ],
    });
    expect(conflictedRun.cost.runElapsedMs).toBeNull();
    expect(conflictedRun.cost.availability['/runElapsedMs']?.state).toBe('unavailable');
    expect(conflictedRun.fix.runs).toHaveLength(0);
  });

  test('modeled price coverage explicit', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', {
              modeledUsd: 0.25,
              priceCoverage: 'full',
              priceTableRevision: 'rev-2026-11',
            }),
            leaf('inv-2', {}),
          ],
        }),
      ],
    });
    // One attempt carries coverage and one does not: the coverage statement
    // stays null and the USD sum is a partial subtotal, never complete.
    expect(panels.cost.modeledUsd).toBe(0.25);
    expect(panels.cost.priceCoverage).toBeNull();
    expect(panels.cost.availability['/modeledUsd']?.state).toBe('partial');
    expect(panels.cost.availability['/modeledUsd']?.reason).toContain('price coverage');
    // Uniform coverage over two different price tables is still not a known
    // total: USD from mixed (or unstated) tables stays a partial subtotal.
    const mixedTables = computeMeasurementPanels({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-3', { modeledUsd: 0.25, priceCoverage: 'full', priceTableRevision: 'rev-a' }),
            leaf('inv-4', { modeledUsd: 0.5, priceCoverage: 'full', priceTableRevision: 'rev-b' }),
          ],
        }),
      ],
    });
    expect(mixedTables.cost.modeledUsd).toBe(0.75);
    expect(mixedTables.cost.priceTableRevision).toBeNull();
    expect(mixedTables.cost.availability['/modeledUsd']?.state).toBe('partial');
    expect(mixedTables.cost.availability['/modeledUsd']?.reason).toContain('price coverage');
  });

  test('untrusted child values unknown rather than zero', () => {
    const untrusted: UnknownMeasurementInput = {
      source: 'bundle:reports/w/torn.json',
      kind: 'untrusted',
      reason: 'checksum mismatch',
    };
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({ attempts: [leaf('inv-1', { usageChannels: { input: 100 }, wallMs: 1_000 })] }),
      ],
      unknown: [untrusted],
    });
    // A rejected child degrades every cost total to partial beside its
    // observed values; nothing quietly reads as zero.
    expect(panels.cost.usageChannels.input).toBe(100);
    expect(panels.cost.availability['/usageChannels/input']?.state).toBe('partial');
    expect(panels.cost.attemptWallMs).toBe(1_000);
    expect(panels.cost.availability['/attemptWallMs']?.state).toBe('partial');
    expect(panels.cost.runElapsedMs).toBe(120_000);
    expect(panels.cost.availability['/runElapsedMs']?.state).toBe('partial');
    // Report-level availability reaches the panel through the reader's own
    // totals availability: a torn report root never reads known here.
    const tornReport = computeMeasurementPanels({
      runs: [
        makeRun({ attempts: [leaf('inv-2', { usageChannels: { input: 100 }, wallMs: 1_000 })] }),
      ],
      evidenceAvailability: {
        '': avail('partial', 'report stream torn'),
        '/attempts': avail('known', 'measured attempt-finished events'),
      },
    });
    expect(tornReport.cost.attemptWallMs).toBe(1_000);
    expect(tornReport.cost.availability['/attemptWallMs']?.state).toBe('partial');
    expect(tornReport.cost.usageChannels.input).toBe(100);
    expect(tornReport.cost.availability['/usageChannels/input']?.state).toBe('partial');
    const tornAttempts = computeMeasurementPanels({
      runs: [makeRun({ attempts: [leaf('inv-3')] })],
      evidenceAvailability: { '/attempts': avail('partial', 'torn attempts list') },
    });
    expect(tornAttempts.cost.availability['/attemptWallMs']?.state).toBe('partial');
  });

  test('per-run denominator only, never mix placeholder units with failures', () => {
    const panels = computeMeasurementPanels({
      runs: [
        makeRun({
          baselineFailures: [
            baseline('unit-1', 3),
            baseline('unit-2', null),
            baseline('unit-3', null),
          ],
        }),
      ],
    });
    // Known counts sit beside placeholders: the denominator is unknown with
    // the known subtotal withheld, never 3 and never 5.
    expect(panels.fix.runs[0]?.fixesPerRun.denominator).toBeNull();
    // Disagreeing duplicate rows for one unit conflict: the denominator is
    // unknown, never their sum and never one pick.
    const conflictUnits = computeMeasurementPanels({
      runs: [makeRun({ baselineFailures: [baseline('unit-1', 3), baseline('unit-1', 4)] })],
    });
    expect(conflictUnits.fix.runs[0]?.fixesPerRun.denominator).toBeNull();
    // An uncompleted probe's count is not failure evidence: completed is
    // required, whatever the count says.
    const uncompleted = computeMeasurementPanels({
      runs: [
        makeRun({
          baselineFailures: [
            {
              unitId: 'unit-1',
              probeHead: null,
              completed: false,
              count: 3,
              unknownReason: 'baseline probe did not complete for this unit',
            },
          ],
        }),
      ],
    });
    expect(uncompleted.fix.runs[0]?.fixesPerRun.denominator).toBeNull();
  });
});
