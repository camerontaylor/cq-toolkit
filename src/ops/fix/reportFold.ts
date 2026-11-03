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
