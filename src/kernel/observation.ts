// Separate composition observation stream — ADR-0008 T29 (measurement slice
// M0-sink).
//
// The kernel-owned RunLog is not exposed to ops. Observational events live
// in their own stream: one file per composition run, created EXCLUSIVELY at
// open time (`<journalDir>/observations/<workId>/<compositionRunId>.ndjson`,
// 'wx' — a duplicate composition run is refused at open, before any event),
// appended serially with fsync (complete v3 events only, validated before
// they hit disk). No new lock: exclusivity of creation plus the writer's
// internal serial write chain are the whole discipline; the composition owns
// writer lifetime and closes it in finally.
//
// Without `journalDir` the same writer API retains the validated events in
// memory (exposed through `events()`) and declares `persistence:
// 'unavailable'`: the report states persistence is unavailable, it never
// claims durability. A write failure makes its result indeterminate: the
// writer fail-stops after the first write error, exposes it through
// `failure`, and close() re-rejects with that error.
//
// The reader validates each stream against the strict stream schema (the
// schema carries the identity couplings), preserves file order within a
// stream, and never manufactures cross-stream order from timestamps. A torn
// final line (crash mid-append: no trailing newline) — or an empty file
// left by a crash between exclusive create and the first write — leaves the
// stream INCOMPLETE: returned as partial evidence, never an invented
// completion. `foldObservations` resolves each kernel-run-linked event
// against the kernel v3 headers by workId and planId; unresolvable links
// stay unknown, never guessed. Kernel-run-linked payloads carry the same
// filesystem-safe id discipline as journal runIds (they become file names
// at the descriptor read side).
//
// Residual: losing a datasync or a directory sync is not detected by any
// test (a crash-simulation harness cannot observe it without mocking the
// fs layer); the failure boundary tests cover detectable corruption only.
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assertSafeRunId, openRunLog, syncDir } from './journal.js';
import { ObservationStreamSchema, ObservationEventSchema } from './schema.js';
import type {
  KernelRunLinkedJournalEvent,
  ObservationEvent,
  ObservationStream,
  RunStartedJournalEvent,
  RunStartedV3JournalEvent,
} from './types.js';

/** Filesystem-safe composition run id: same discipline as journal runIds. */
const COMPOSITION_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Where the writer's validated events land. */
export type ObservationPersistence = 'durable' | 'unavailable';

/**
 * One kernel run a fold may resolve kernel-run-linked events against: the
 * run id, the plan it belongs to, and the run-started header EXACTLY AS THE
 * KERNEL WROTE IT, discriminated by the header's own journal version. The
 * version discriminant is enforced BY THE TYPE (v1 headers cannot carry a
 * v2 journalVersion and vice versa), so the read model is sound by
 * construction while the runtime header stays verbatim. A v3 header
 * carries the correlation.workId the fold joins on; v1/v2 headers carry
 * only the envelope facts (runId/at/planId, plus seq/governance for v2) —
 * real evidence, never upgraded or padded: no correlation, provenance or
 * availability is ever invented for them (T04 ruling 2026-11-12). This is
 * a plain internal read model: it changes no kernel journal schema, no
 * writer and no frozen OpResult shape.
 */
export type KernelRunDescriptor =
  | {
      journalVersion: 1;
      runId: string;
      planId: string;
      header: RunStartedJournalEvent & { journalVersion?: undefined };
    }
  | {
      journalVersion: 2;
      runId: string;
      planId: string;
      header: RunStartedJournalEvent & { journalVersion: 2 };
    }
  | { journalVersion: 3; runId: string; planId: string; header: RunStartedV3JournalEvent };

/** Runtime discriminant: a header the kernel persisted WITHOUT journalVersion. */
const isV1RunStarted = (
  header: RunStartedJournalEvent,
): header is RunStartedJournalEvent & { journalVersion?: undefined } =>
  header.journalVersion === undefined;

/** Runtime discriminant: a header the kernel persisted WITH journalVersion 2. */
const isV2RunStarted = (
  header: RunStartedJournalEvent,
): header is RunStartedJournalEvent & { journalVersion: 2 } => header.journalVersion === 2;

/** A kernel-run-linked event after fold resolution (ADR-0008: never guessed). */
export type ResolvedKernelRunLink =
  | { state: 'resolved'; event: KernelRunLinkedJournalEvent; kernelRunId: string; planId: string }
  | { state: 'unknown'; event: KernelRunLinkedJournalEvent; reason: string };

/** A folded composition stream plus its resolved kernel-run links. */
export interface FoldedObservation {
  stream: ObservationStream;
  kernelRunLinks: ResolvedKernelRunLink[];
}

/** The writer surface one open composition stream exposes (ADR-0008 T29). */
export interface ObservationWriter {
  /** The compositionRunId this writer was opened with; the observation `runId`. */
  readonly compositionRunId: string;
  /**
   * The workId this writer was opened with; the correlation identity its
   * streams join kernel runs on. A composition adopting an injected writer
   * takes BOTH identities from it (never a second, divergent allocation).
   */
  readonly workId: string;
  /** `'durable'` with a journalDir; `'unavailable'` memory-only (P2-2 ruling). */
  readonly persistence: ObservationPersistence;
  /**
   * The first write error, or null while every write has succeeded. A
   * non-null failure makes the stream's on-disk evidence indeterminate.
   */
  readonly failure: unknown;
  /**
   * Snapshot of the validated events this writer accepted. Durable in both
   * modes; without a journalDir this is the ONLY copy (persistence
   * unavailable), so T30/T31 can build report rows from it.
   */
  events(): ObservationEvent[];
  /**
   * Append one observational event as a JSON line, serially, fsynced before
   * the promise settles. Validates against the observation union (throws on
   * invalid events) and requires `event.runId === compositionRunId`.
   * Fail-stop: after the first write error every later append rejects with
   * that same error.
   */
  append(event: ObservationEvent): Promise<void>;
  /**
   * Close the stream; idempotent. Refuses new appends, drains the queued
   * appends, then closes the handle. Rejects with the first write error if
   * one occurred (after the handle is closed).
   */
  close(): Promise<void>;
}

/** Options for {@link openObservationWriter}: journalDir omitted means memory-only. */
export interface OpenObservationWriterOptions {
  /** Run-log directory; omitted → memory-only (persistence unavailable). */
  journalDir?: string;
  workId: string;
  compositionRunId: string;
}

/**
 * Open one exclusive composition observation stream (ADR-0008 T29). With a
 * `journalDir` the stream file is created exclusively at OPEN time ('wx': a
 * duplicate composition run is refused here, before any event is written).
 * Without one the writer keeps the validated events in memory only.
 * Appends are serialized through an internal write chain so concurrent
 * appends never interleave and land in append-call order.
 */
export async function openObservationWriter(
  options: OpenObservationWriterOptions,
): Promise<ObservationWriter> {
  const { workId, compositionRunId } = options;
  if (!COMPOSITION_RUN_ID_PATTERN.test(compositionRunId)) {
    throw new Error(
      `observation: compositionRunId must match ${COMPOSITION_RUN_ID_PATTERN.source} ` +
        `(no slashes, not empty): '${compositionRunId}'`,
    );
  }
  // z.uuid().safeParse: exactly the UUID grammar (36-dash junk is refused).
  if (!observationUuid(workId)) {
    throw new Error(
      `observation: workId must be a UUID (it joins streams to kernel runs): '${workId}'`,
    );
  }
  const journalDir = options.journalDir;
  const streamDir = journalDir === undefined ? null : join(journalDir, 'observations', workId);
  const streamPath = streamDir === null ? null : join(streamDir, `${compositionRunId}.ndjson`);

  // Write chain: serial appends, in call order; a failed write fail-stops
  // the writer (writeFailed is thrown by every later write before touching
  // the file), but the chain itself never deadlocks.
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  // Header-first discipline (ADR-0008: exactly one composition-started per
  // stream, at its head) enforced at WRITE time too: a non-header first
  // event or a duplicate header would produce a file the reader must
  // reject — refuse before any byte lands.
  let headerWritten = false;
  // Fail-stop: a failed write means the stream's on-disk evidence is
  // already indeterminate; later appends must not silently interleave after
  // the failure. The caller classifies the rejection as indeterminate.
  let writeFailed: unknown = null;
  // Every validated event this writer accepted (P2-2), in append order.
  const accepted: ObservationEvent[] = [];

  if (streamPath !== null) {
    // Exclusive create AT OPEN (P3 ruling): a second writer for the same
    // composition run is refused here, before any event exists.
    await mkdir(streamDir as string, { recursive: true });
    handle = await open(streamPath, 'wx');
    // mkdir -p may have created observations/ and observations/<workId>:
    // make those directory entries durable too (the stream file's whole
    // directory chain, matching openRunLog's per-creation fsync). A refusal
    // here (exotic mount) must not leak the open handle: the stream file
    // exists but the caller sees the error, so close before rethrowing.
    try {
      await syncDir(streamDir as string);
      await syncDir(join(journalDir as string, 'observations'));
      await syncDir(journalDir as string);
    } catch (err) {
      await handle.close();
      handle = null;
      throw err;
    }
  }

  const write = async (line: string): Promise<void> => {
    if (streamPath === null) return; // memory-only: accepted[], never durable
    if (writeFailed !== null) throw writeFailed;
    try {
      const h = handle;
      if (h === null) throw new Error('observation: stream handle lost — cannot append');
      await h.writeFile(line, 'utf8');
      await h.datasync();
    } catch (err) {
      writeFailed ??= err;
      throw err;
    }
  };

  return {
    compositionRunId,
    workId,
    persistence: streamPath === null ? 'unavailable' : 'durable',
    get failure(): unknown {
      return writeFailed;
    },

    events(): ObservationEvent[] {
      return [...accepted];
    },

    async append(event): Promise<void> {
      if (closed) {
        throw new Error(`observation: writer for '${compositionRunId}' is closed — append refused`);
      }
      const parsed: ObservationEvent = ObservationEventSchema.parse(event);
      if (parsed.runId !== compositionRunId) {
        throw new Error(
          `observation: event.runId '${parsed.runId}' does not match this stream's ` +
            `compositionRunId '${compositionRunId}'`,
        );
      }
      // The stream file lives under its workId: a header claiming another
      // workId would misattribute the whole stream at the join.
      if (parsed.type === 'composition-started' && parsed.payload.correlation.workId !== workId) {
        throw new Error(
          `observation: header correlation.workId '${parsed.payload.correlation.workId}' ` +
            `does not match this stream's workId '${workId}'`,
        );
      }
      if (parsed.type === 'composition-started') {
        if (headerWritten) {
          throw new Error(
            `observation: stream '${compositionRunId}' already has its composition-started ` +
              'header — a second is a concatenated stream, not evidence',
          );
        }
        headerWritten = true;
      } else if (!headerWritten) {
        throw new Error(
          `observation: stream '${compositionRunId}' must open with its composition-started ` +
            `header — got ${parsed.type} first`,
        );
      }
      const line = `${JSON.stringify(parsed)}\n`;
      if (streamPath === null) {
        // Memory-only: accepted[] is the ONLY copy, and nothing below can
        // fail in this mode — record immediately.
        accepted.push(parsed);
      }
      const next = tail.then(() => write(line));
      tail = next.catch(() => undefined);
      await next;
      // Durable mode: record the event only once its bytes (and the
      // datasync) succeeded — events() never claims evidence that did not
      // reach disk.
      if (streamPath !== null) accepted.push(parsed);
    },

    async close(): Promise<void> {
      // Refuse new appends FIRST (an append starting during the drain would
      // otherwise queue behind the tail close() already captured and reopen
      // or leak a handle), then drain the appends already queued.
      closed = true;
      await tail;
      if (handle !== null) {
        const h = handle;
        handle = null;
        await h.close();
      }
      // A failed write leaves the stream indeterminate: close reports it
      // (P2-1) instead of succeeding silently.
      if (writeFailed !== null) {
        throw writeFailed;
      }
    },
  };
}

/** Read one stream file's events; `complete` distinguishes torn from whole. */
async function readStreamFile(
  path: string,
): Promise<{ events: ObservationEvent[]; complete: boolean; exists: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return { events: [], complete: true, exists: false };
    throw err;
  }
  if (raw === '') {
    // A crash after the exclusive create but before the first write leaves
    // an empty file: its evidence is explicitly INCOMPLETE (the header never
    // landed), not a complete empty stream.
    return { events: [], complete: false, exists: true };
  }
  // Torn tail (crash mid-append): only an UNTERMINATED final line may be
  // lost, and it makes the stream incomplete — partial evidence, never a
  // fabricated completion. Any complete-but-invalid line is corruption.
  const tornTail = !raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const events: ObservationEvent[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' && i === lines.length - 1) break; // trailing whitespace: byte-less
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && tornTail) break;
      throw new Error(
        `observation: corrupt line ${i + 1} of ${path} — complete but unparsable is corruption`,
      );
    }
    events.push(data as ObservationEvent); // identity validated below via the stream schema
  }
  return { events, complete: !tornTail, exists: true };
}

const uuidSchema = z.uuid();

/**
 * UUID grammar check via z.uuid() — stricter than a 36-char dash pattern (P3).
 */
function observationUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

/**
 * Kernel run descriptors a fold resolves links against, read STRICTLY
 * through the kernel's own reader (openRunLog().read): a corrupt kernel
 * file throws — corruption is never folded into descriptors — and each
 * file's FIRST event must be its run-started header with the file's runId.
 * Every header the kernel actually writes yields a descriptor (T04 ruling
 * 2026-11-12): v3 headers as-is, and v1/v2 headers as-is with only the
 * facts they provably carry — the descriptor never upgrades a legacy
 * header or invents correlation/provenance/availability to fill the fold's
 * join. The fold keeps the workId join UNKNOWN for those legacy runs with
 * a version-accurate reason instead. Missing/empty files yield no
 * descriptor (unknown, not guessed); torn tails are the kernel reader's
 * tolerance and stay non-descriptors.
 */
export async function readKernelRunDescriptors(
  journalDir: string,
  runIds: readonly string[],
): Promise<KernelRunDescriptor[]> {
  const descriptors: KernelRunDescriptor[] = [];
  for (const runId of runIds) {
    // The id becomes a file name under journalDir: the journal's own grammar
    // guards it (no separators, no traversal) before any read.
    assertSafeRunId(runId);
    const runLog = openRunLog(journalDir);
    let events: Awaited<ReturnType<typeof runLog.read>>;
    try {
      events = await runLog.read(runId);
    } catch (err) {
      if (isEnoent(err)) continue; // unknown kernel run: links stay unknown
      throw err;
    }
    if (events.length === 0) continue; // no evidence yet: unknown, not guessed
    const first = events[0];
    if (first?.type !== 'run-started') {
      throw new Error(
        `kernel run '${runId}' does not open with its run-started header — ` +
          'corrupt or forged kernel stream, not evidence',
      );
    }
    if (first.runId !== runId) {
      // Defense in depth: the kernel reader already refuses a line whose
      // runId differs from the file's run.
      throw new Error(
        `kernel run file '${runId}.ndjson' carries header runId '${first.runId}' — ` +
          'misattributed evidence, refused',
      );
    }
    if (first.journalVersion === 3) {
      descriptors.push({ journalVersion: 3, runId, planId: first.planId, header: first });
    } else if (isV2RunStarted(first)) {
      // v2: the kernel reader's schema already validated the exact persisted
      // shape (journalVersion 2 + exactly one of governance/ungoverned). The
      // descriptor reports the header VERBATIM — runId/planId are proven
      // facts; correlation and friends do not exist on this record, so none
      // are synthesized here.
      descriptors.push({ journalVersion: 2, runId, planId: first.planId, header: first });
    } else if (isV1RunStarted(first)) {
      // v1 (journalVersion absent): same verbatim discipline, no invented
      // fields.
      descriptors.push({ journalVersion: 1, runId, planId: first.planId, header: first });
    } else {
      // Defense in depth: the kernel reader accepts only v1/v2/v3 headers,
      // so this arm is unreachable unless that guarantee regresses.
      throw new Error(`kernel run '${runId}' header carries unsupported journalVersion — refused`);
    }
  }
  return descriptors;
}

/**
 * Read every observation stream under `<journalDir>/observations`, each
 * validated separately and independently through the strict stream schema
 * (the schema carries the identity couplings: header-first, header workId
 * vs directory workId, per-event runId). One corrupt stream throws with its
 * path; other streams are not folded from a bad neighbor's bytes. File
 * order is preserved within each stream; streams sort by workId then
 * compositionRunId (deterministic; timestamps never manufacture cross-stream
 * order).
 */
export async function readObservations(journalDir: string): Promise<ObservationStream[]> {
  const root = join(journalDir, 'observations');
  let workIds: string[];
  try {
    // Only directories are stream scopes: a stray file under observations/
    // (editor temp, .DS_Store) must not fail the whole scan with ENOTDIR.
    workIds = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if (isEnoent(err)) return []; // no observations yet
    throw err;
  }
  const streams: ObservationStream[] = [];
  for (const workId of workIds.sort()) {
    // The directory name IS the workId: a non-UUID directory is not a stream
    // scope (P2-3) — skip it rather than failing the scan.
    if (!uuidSchema.safeParse(workId).success) continue;
    const dir = join(root, workId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      if (isEnoent(err)) {
        continue; // removed during the scan: no streams to omit
      }
      // Unavailable evidence is not absent evidence: a permission or I/O
      // failure on a stream directory propagates instead of silently
      // omitting every stream under it.
      throw err;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.ndjson')) continue;
      const compositionRunId = file.slice(0, -'.ndjson'.length);
      const { events, complete, exists } = await readStreamFile(join(dir, file));
      if (!exists) continue; // removed between readdir and read: no streams to omit
      // The stream schema validates identity: workId UUID, compositionRunId
      // shape, header-first couplings, header workId === directory workId,
      // per-event runId === compositionRunId.
      const parsed = ObservationStreamSchema.safeParse({
        workId,
        compositionRunId,
        events,
        complete,
      });
      if (!parsed.success) {
        // A schema failure must name the file like a parse failure does: the
        // scan stops here, so the path is the operator's only pointer.
        throw new Error(
          `observation: invalid stream ${join(dir, file)} — ${parsed.error.message}`,
          {
            cause: parsed.error,
          },
        );
      }
      streams.push(parsed.data);
    }
  }
  return streams;
}

/**
 * Fold observation streams against their kernel runs (ADR-0008): the join
 * resolves each kernel-run-linked event by planId + kernelRunId + the
 * header's correlation.workId. Each link is `resolved` when the referenced
 * kernel v3 run exists with the same planId AND a matching workId.
 * A v1/v2 descriptor (run + plan match) is NEVER resolved on runId alone:
 * its header carries no correlation.workId, so the link stays `unknown`
 * with a version-accurate reason — never guessed, never dropped, and no
 * legacy header is upgraded to manufacture the join. File order is
 * preserved within each stream; streams sort by workId then
 * compositionRunId. Kernel replay consumes only kernel streams;
 * observational events never alter reservations, sequence claims or job
 * statuses.
 */
export function foldObservations(
  streams: readonly ObservationStream[],
  kernelRuns: readonly KernelRunDescriptor[] = [],
): FoldedObservation[] {
  const byKey = new Map<string, KernelRunDescriptor>();
  for (const run of kernelRuns) {
    byKey.set(`id\u0000${run.runId}`, run);
  }
  const folded: FoldedObservation[] = [];
  for (const stream of streams) {
    // Validate through the stream schema (P2-3: one set of identity rules —
    // header-first couplings, header workId, per-event runId).
    const validated: ObservationStream = ObservationStreamSchema.parse(stream);
    const kernelRunLinks: ResolvedKernelRunLink[] = validated.events
      .filter((e): e is KernelRunLinkedJournalEvent => e.type === 'kernel-run-linked')
      .map((event): ResolvedKernelRunLink => {
        const byId = byKey.get(`id\u0000${event.payload.kernelRunId}`);
        if (byId === undefined) {
          return {
            state: 'unknown',
            event,
            reason: `kernel run '${event.payload.kernelRunId}' not found among the returned kernel runs`,
          };
        }
        if (byId.planId !== event.payload.planId) {
          return {
            state: 'unknown',
            event,
            reason:
              `kernel run '${event.payload.kernelRunId}' belongs to plan '${byId.planId}', ` +
              `not '${event.payload.planId}'`,
          };
        }
        // The workId join exists only on v3 headers. A v1/v2 header proves
        // the run and the plan but not the composition identity: resolving
        // on runId alone would forge the join, so it stays unknown with the
        // actual journal version named.
        const headerWorkId = byId.journalVersion === 3 ? byId.header.correlation.workId : undefined;
        if (headerWorkId === undefined) {
          return {
            state: 'unknown',
            event,
            reason:
              `kernel run '${event.payload.kernelRunId}' is a journalVersion ` +
              `${byId.journalVersion} run: its run-started header carries no ` +
              'correlation.workId, so the composition workId join cannot be proven',
          };
        }
        if (headerWorkId !== validated.workId) {
          return {
            state: 'unknown',
            event,
            reason:
              `kernel run '${event.payload.kernelRunId}' carries workId ` +
              `'${headerWorkId}', not this stream's '${validated.workId}'`,
          };
        }
        return { state: 'resolved', event, kernelRunId: byId.runId, planId: byId.planId };
      });
    folded.push({ stream: validated, kernelRunLinks });
  }
  return folded;
}
