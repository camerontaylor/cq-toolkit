// Report v2 observation fold — ADR-0008 T36.
//
// Relationship to the kernel primitive: `src/kernel/observation.ts` also
// exports a `foldObservations`. That one is the IDENTITY/JOIN primitive: it
// validates each stream and resolves every `kernel-run-linked` event against
// the kernel v3 descriptors (resolved or unknown with a reason). THIS
// `foldObservations` is the report-v2 fold built ON that primitive: it
// preserves the kernel result unchanged, adds the report-level completeness
// state (a torn stream is `partial`, never silently complete), groups the
// shared `attempt-finished` kind generically (no producer-specific branch, so
// T14 address attempts fold with no change when they land), records the
// producer gaps as explicit unknown availability (T04 descriptors, T14
// address attempts), and sanitizes the returned surface before any consumer
// persists it. Do not confuse the two names: only this module owns report
// semantics; it never re-implements the join.
//
// The fold is READ-ONLY and verdict-neutral: it copies inputs, mutates
// nothing, and cannot change a run outcome. It never invents a value: empty
// evidence is `unavailable`, a zero count is only ever a measured zero, and
// every unresolved link keeps its kernel-primitive reason.
import type {
  AvailabilityRecord,
  AttemptFinishedJournalEvent,
  ObservationStream,
} from '../../kernel/types.js';
import {
  foldObservations as foldKernelLinks,
  type FoldedObservation,
  type KernelRunDescriptor,
  type ObservationPersistence,
  type ObservationWriter,
} from '../../kernel/observation.js';
import { sanitizeObservation } from './attemptRecord.js';

/** Inputs the consumers (makeFixRun, makeReviewAddress) hand the fold. */
export interface ReportFoldInput {
  /** Observation streams in fold order (per-stream file order preserved). */
  streams: readonly ObservationStream[];
  /** Kernel v3 descriptors links resolve against; absent descriptors stay unknown. */
  kernelRuns?: readonly KernelRunDescriptor[];
  /** The composition writer's declared persistence — never inferred durable. */
  persistence: ObservationPersistence;
}

/** Report-v2 observation evidence folded from one composition. */
export interface ReportObservationFold {
  reportVersion: 2;
  /** `complete` only when a stream exists and every folded stream is whole. */
  state: 'complete' | 'partial' | 'unavailable';
  persistence: ObservationPersistence;
  /** Kernel-primitive result, unchanged: links stay resolved/unknown with reasons. */
  streams: FoldedObservation[];
  /**
   * Every `attempt-finished` row, grouped generically across producers in
   * fold order (stream order, then file order). Absent means none was
   * observed; it is never a fabricated zero.
   */
  attempts: AttemptFinishedJournalEvent[];
  /** The descriptors the join ran against (`[]` until T04 lands). */
  kernelRuns: KernelRunDescriptor[];
  /** Availability keyed by JSON Pointer relative to this fold. */
  availability: Record<string, AvailabilityRecord>;
}

/**
 * The writer's in-memory stream snapshot for the fold. The identity is the
 * WRITER's (a test seam writer may declare a distinct one), and the stream is
 * complete only when no observation failure occurred AND its header actually
 * landed: header-first is the stream schema, so an accepted prefix without
 * the header is torn evidence.
 */
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

/**
 * Fold composition streams plus linked kernel streams into report v2
 * observation evidence (ADR-0008 T36). Partial completion stays partial.
 */
export function foldObservations(input: ReportFoldInput): ReportObservationFold {
  const folded = foldKernelLinks(input.streams, input.kernelRuns ?? []);
  const attempts = folded.flatMap(({ stream }) =>
    stream.events.filter(
      (event): event is AttemptFinishedJournalEvent => event.type === 'attempt-finished',
    ),
  );
  const state: ReportObservationFold['state'] =
    folded.length === 0
      ? 'unavailable'
      : folded.some(({ stream }) => !stream.complete)
        ? 'partial'
        : 'complete';
  const kernelRuns = [...(input.kernelRuns ?? [])];
  const availability: Record<string, AvailabilityRecord> = {
    '': {
      state: state === 'complete' ? 'known' : state,
      reason:
        state === 'unavailable'
          ? 'no composition observation stream was available'
          : state === 'partial'
            ? 'one or more observation streams are torn or indeterminate; partial evidence only'
            : 'every folded observation stream is whole',
      source: null,
    },
    '/kernelRuns':
      kernelRuns.length === 0
        ? {
            state: 'unavailable',
            reason:
              'no kernel v3 run descriptor was available: the v3 run-started header ' +
              'writer (T04) has not landed, so every kernel-run link is unknown',
            source: null,
          }
        : {
            state: 'known',
            reason:
              'kernel-run links resolve against the supplied v3 descriptors; ' +
              'an unresolved link carries its own reason',
            source: null,
          },
    '/attempts':
      attempts.length > 0
        ? {
            state: 'known',
            reason: 'attempt-finished events were observed in the folded streams',
            source: null,
          }
        : {
            state: 'not-collected',
            reason:
              'no attempt-finished event was observed in the folded streams; ' +
              'address attempts (T14) have not landed',
            source: null,
          },
  };
  return sanitizeObservation({
    reportVersion: 2 as const,
    state,
    persistence: input.persistence,
    streams: folded,
    attempts,
    kernelRuns,
    availability,
  });
}
