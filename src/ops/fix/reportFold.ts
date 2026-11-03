// ADR-0008 T36: read-only, verdict-neutral ReportV2 assembly.
import type {
  AvailabilityRecord,
  CompositionStartedJournalEvent,
  ObservationStream,
  ReportV2,
} from '../../kernel/types.js';
import { ReportV2Schema } from '../../kernel/schema.js';
import {
  foldObservations as foldKernelLinks,
  type KernelRunDescriptor,
  type ObservationWriter,
} from '../../kernel/observation.js';
import { sanitizeObservation } from './attemptRecord.js';
import { distinctFixedCommitCount } from './measurement.js';

export interface ReportFoldInput {
  streams: readonly ObservationStream[];
  kernelRuns?: readonly KernelRunDescriptor[];
  producer: 'fix' | 'address';
}
const unavailable = (reason: string): AvailabilityRecord => ({
  state: 'unavailable',
  reason,
  source: null,
});

export function observationStreamOf(
  writer: ObservationWriter,
  failureFree: boolean,
): ObservationStream {
  const events = writer.events();
  return {
    workId: writer.workId,
    compositionRunId: writer.compositionRunId,
    events,
    complete: failureFree && events[0]?.type === 'composition-started',
  };
}

export function foldObservations(input: ReportFoldInput): ReportV2 {
  const identities = new Set<string>();
  for (const stream of input.streams) {
    const key = `${stream.workId}\0${stream.compositionRunId}`;
    if (identities.has(key)) throw new Error('duplicate composition observation stream');
    identities.add(key);
  }
  const folded = foldKernelLinks(input.streams, input.kernelRuns ?? []);
  const header = folded[0]?.stream.events[0];
  if (header?.type !== 'composition-started') throw new Error('no composition header landed');
  const partial = folded.some(({ stream }) => !stream.complete);
  const attempts = folded.flatMap(({ stream }) =>
    stream.events.filter((event) => event.type === 'attempt-finished'),
  );
  const availability: ReportV2['availability'] = {
    '': {
      state: partial ? 'partial' : 'known',
      reason: partial
        ? 'torn observation stream; partial evidence only'
        : 'all observation streams are whole',
      source: null,
    },
    '/attempts': {
      state: partial
        ? 'partial'
        : attempts.length
          ? 'known'
          : input.producer === 'address'
            ? 'unavailable'
            : 'known-zero',
      reason:
        input.producer === 'address' && !attempts.length
          ? 'address attempts (T14) have not landed'
          : 'measured attempt-finished events in the composition stream',
      source: null,
    },
  };
  const unknownLinks = folded
    .flatMap((row) => row.kernelRunLinks)
    .filter((link) => link.state === 'unknown');
  // The provenance record is fully known from the witnessed composition
  // header; unresolved T04 kernel descriptors concern the journal link only.
  availability['/provenance'] = {
    state: 'known',
    reason: 'witnessed composition header',
    source: null,
  };
  if (unknownLinks.length) {
    availability['/provenance/journalLink'] = unavailable(
      'T04 kernel v3 descriptors unavailable: ' +
        unknownLinks.map((link) => link.reason).join('; '),
    );
  }
  for (const field of [
    'tasks',
    'gates',
    'dispositions',
    'reviews',
    'approvals',
    'writeDecisions',
    'metric',
    'metric/fixesPerRun/numerator',
    'metric/fixesPerRun/denominator',
  ]) {
    availability[`/${field}`] = unavailable('producer not yet wired to the composition report');
  }
  availability['/acceptances'] = unavailable(
    'T20 acceptance importer deferred; empty evidence is not all-clear',
  );
  return ReportV2Schema.parse(
    sanitizeObservation({
      reportVersion: 2,
      provenance: header.payload.provenance,
      correlation: header.payload.correlation,
      tasks: [],
      attempts,
      gates: [],
      dispositions: [],
      acceptances: [],
      reviews: [],
      approvals: [],
      writeDecisions: [],
      metric: {
        fixesPerRun: { numerator: null, denominator: null },
        verifiedCommits: [],
        closures: [],
        baselineFailures: [],
      },
      availability,
    }),
  );
}

/** Report boundary: corrupt evidence cannot change the operational verdict.
 * A declared header may supply attribution after append failure, never evidence rows.
 */
export function assembleReportV2(
  input: Omit<ReportFoldInput, 'streams'> & {
    writer?: ObservationWriter | undefined;
    streams?: readonly ObservationStream[];
    failureFree: boolean;
    header?: CompositionStartedJournalEvent | undefined;
  },
): { reportV2?: ReportV2; availability: AvailabilityRecord } {
  try {
    const stream =
      input.writer === undefined ? undefined : observationStreamOf(input.writer, input.failureFree);
    if (input.streams === undefined && stream?.events[0]?.type !== 'composition-started')
      throw new Error('no composition header landed');
    const reportV2 = foldObservations({
      ...input,
      streams: input.streams ?? (stream === undefined ? [] : [stream]),
    });
    return { reportV2, availability: reportV2.availability['']! };
  } catch (error) {
    const availability = unavailable(`ReportV2 assembly unavailable: ${String(error)}`);
    if (input.header === undefined) return sanitizeObservation({ availability });
    try {
      const reportV2 = foldObservations({
        producer: input.producer,
        streams: [
          {
            workId: input.header.payload.correlation.workId,
            compositionRunId: input.header.runId,
            events: [input.header],
            complete: false,
          },
        ],
      });
      reportV2.attempts = [];
      reportV2.availability[''] = availability;
      reportV2.availability['/attempts'] = availability;
      return {
        reportV2: ReportV2Schema.parse(sanitizeObservation(reportV2)),
        availability: sanitizeObservation(availability),
      };
    } catch {
      return { availability: sanitizeObservation(availability) };
    }
  }
}

/**
 * ADR-0008 T37: the explicit, LOSSY pre-v2 view that legacy fix/address
 * report consumers read. This is the only derivation from v2 evidence; the
 * pre-v2 writers still compute the old scalar themselves (fixesPerRunOf and
 * the address commit set) and no other module derives it from a ReportV2.
 * Display-only: it never replays evidence and is never replay, approval or
 * acceptance input. `lossy: true` keeps it distinguishable from a report v2
 * payload on disk, and the projection carries no evidence rows.
 */
export interface LegacyReportProjection {
  /** Always true: this is the lossy legacy view, never a ReportV2. */
  lossy: true;
  /**
   * The pre-v2 scalar: distinct verified commit SHAs. `null` means the
   * evidence is absent, partial or inconsistent; never a zero or a guess.
   */
  fixesPerRun: number | null;
  /** T28 availability for the scalar, so unknown and measured zero stay distinct. */
  availability: AvailabilityRecord;
}

/**
 * The legacy carrier's own rows. These carry the pre-v2 rule exactly, so the
 * projection prefers them whenever they are supplied; the projection never
 * invents rows.
 */
export type LegacyProjectionEvidence =
  | { producer: 'fix'; tasks: readonly { outcome: string; commits: readonly string[] }[] }
  | { producer: 'address'; fixes: readonly { commit?: string | undefined }[] };

export interface LegacyProjectionSource {
  /**
   * The v2 report carried by the report, when the run assembled one. A
   * FALLBACK only: its numerator measures a different quantity (validation
   * pass, Cq-Task trailer, not todo), so it is read only when no legacy rows
   * are supplied.
   */
  reportV2?: ReportV2 | undefined;
  /** The pre-v2 carrier rows; preferred whenever supplied. */
  evidence?: LegacyProjectionEvidence | undefined;
}

const legacyUnavailable = (reason: string): AvailabilityRecord => ({
  state: 'unavailable',
  reason,
  source: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/**
 * The legacy scalar over legacy rows, mirroring the pre-v2 producers' rule:
 * `fixesPerRunOf` in runFix.ts (distinct commits on rows whose outcome is
 * `fixed`) and the address writer's `new Set(fixes.flatMap((fix) =>
 * (fix.commit ? [fix.commit] : []))).size`.
 */
function legacyEvidenceCount(evidence: LegacyProjectionEvidence): number {
  const commits = new Set<string>();
  if (evidence.producer === 'fix') {
    if (!Array.isArray(evidence.tasks)) throw new Error('fix task rows are absent');
    const fixedRows: { outcome: string; commits: readonly string[] }[] = [];
    for (const raw of evidence.tasks as readonly unknown[]) {
      if (!isRecord(raw)) throw new Error('malformed fix task row');
      const outcome = raw.outcome;
      const rowCommits = raw.commits;
      if (typeof outcome !== 'string' || !Array.isArray(rowCommits))
        throw new Error('malformed fix task row');
      if (outcome !== 'fixed') continue;
      for (const sha of rowCommits as readonly unknown[])
        if (typeof sha !== 'string') throw new Error('malformed fix commit');
      fixedRows.push({ outcome, commits: rowCommits as string[] });
    }
    return distinctFixedCommitCount(fixedRows);
  }
  if (!Array.isArray(evidence.fixes)) throw new Error('address fix rows are absent');
  for (const raw of evidence.fixes as readonly unknown[]) {
    if (!isRecord(raw)) throw new Error('malformed address fix row');
    const commit = raw.commit;
    // The pre-v2 address rule is truthiness, verbatim: `fix.commit ?
    // [fix.commit] : []`. Falsy commits (undefined, null, empty string) are
    // skipped, never counted and never made into an availability.
    if (!commit) continue;
    if (typeof commit !== 'string') throw new Error('malformed address fix commit');
    commits.add(commit);
  }
  return commits.size;
}

function projectFromEvidence(evidence: LegacyProjectionEvidence): LegacyReportProjection {
  const count = legacyEvidenceCount(evidence);
  return {
    lossy: true,
    fixesPerRun: count,
    availability: {
      state: count === 0 ? 'known-zero' : 'known',
      reason: 'projected from legacy carrier rows with the pre-v2 rule; explicitly lossy',
      source: null,
    },
  };
}

function projectFromReportV2(reportV2: ReportV2): LegacyReportProjection {
  const parsed = ReportV2Schema.safeParse(reportV2);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      lossy: true,
      fixesPerRun: null,
      availability: legacyUnavailable(
        `report v2 evidence is not schema-valid: ${issue?.message ?? 'unknown issue'}`,
      ),
    };
  }
  const report = parsed.data;
  const numerator = report.metric.fixesPerRun.numerator;
  if (numerator === null) {
    const recorded = report.availability['/metric/fixesPerRun/numerator'];
    return {
      lossy: true,
      fixesPerRun: null,
      availability: recorded ?? {
        state: 'not-collected',
        reason: 'report v2 metric numerator is unknown without an availability record',
        source: null,
      },
    };
  }
  // The numerator is the deduplicated verified-commit count; a disagreement
  // makes the evidence untrustworthy, so the scalar is withheld rather than
  // guessed. This is a count, never the numerator/denominator ratio.
  if (numerator !== report.metric.verifiedCommits.length) {
    return {
      lossy: true,
      fixesPerRun: null,
      availability: legacyUnavailable(
        'report v2 metric numerator disagrees with its verified commit projection',
      ),
    };
  }
  return {
    lossy: true,
    fixesPerRun: numerator,
    availability: {
      state: numerator === 0 ? 'known-zero' : 'known',
      reason:
        'fallback: projected from report v2 verified commits, not the pre-v2 carrier rows; explicitly lossy',
      source: null,
    },
  };
}

/**
 * Project a report to the lossy pre-v2 view. The legacy carrier rows win
 * whenever they are supplied, because they carry the pre-v2 rule that legacy
 * consumers expect; the v2 payload is only a fallback for a carrier that holds
 * no rows. Never throws, never mutates its input, never emits evidence rows
 * and never changes a verdict. Without any evidence the old scalar is
 * `null`/not-collected, exactly as absence, not zero.
 */
export function legacyReportProjection(
  source: LegacyProjectionSource = {},
): LegacyReportProjection {
  try {
    const projection: LegacyReportProjection =
      source.evidence !== undefined
        ? projectFromEvidence(source.evidence)
        : source.reportV2 !== undefined
          ? projectFromReportV2(source.reportV2)
          : {
              lossy: true,
              fixesPerRun: null,
              availability: {
                state: 'not-collected',
                reason: 'no legacy evidence and no report v2 to project',
                source: null,
              },
            };
    return sanitizeObservation(projection);
  } catch (error) {
    return sanitizeObservation({
      lossy: true,
      fixesPerRun: null,
      availability: legacyUnavailable(`legacy projection unavailable: ${String(error)}`),
    });
  }
}
