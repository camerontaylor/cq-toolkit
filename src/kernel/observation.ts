// Separate composition observation stream — ADR-0008 T29 (measurement slice
// M0-sink).
//
// The kernel-owned RunLog is not exposed to ops. Observational events live
// in their own stream: one file per composition run, created EXCLUSIVELY at
// `<journalDir>/observations/<workId>/<compositionRunId>.ndjson`, appended
// serially with fsync (complete v3 events only, validated before they hit
// disk). No new lock: exclusivity of creation plus the writer's internal
// serial write chain are the whole discipline; the composition owns writer
// lifetime and closes it in finally.
//
// Without `journalDir` the same writer API is MEMORY-ONLY: the report
// declares persistence unavailable, it never claims durability. A write
// failure makes its result indeterminate (the caller's contract; the writer
// rejects so the composition can classify).
//
// The reader validates each stream file separately and independently (the
// dual reader explicitly scans the observations subtree), preserves file
// order within a stream, and never manufactures cross-stream order from
// timestamps. A torn final line (crash mid-append: no trailing newline)
// leaves the stream INCOMPLETE — returned as partial evidence, never an
// invented completion. `foldObservations` joins streams to kernel runs by
// workId and kernel-run-linked only.
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ObservationEventSchema } from './schema.js';
import type {
  CorrelationRecord,
  KernelRunLinkedJournalEvent,
  ObservationEvent,
  ObservationStream,
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

/**
 * fsync a freshly created stream file's directory entry (same soft-refusal
 * semantics as the kernel journal's syncDir: exotic mounts that refuse a
 * directory fsync are a recorded best-effort no-op). Local copy so the
 * journal module's internal helper stays private.
 */
async function syncStreamDir(dir: string): Promise<void> {
  const SOFT_ERRORS = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS']);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, 'r');
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code !== undefined &&
      SOFT_ERRORS.has((err as { code?: unknown }).code as string)
    ) {
      return;
    }
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      SOFT_ERRORS.has((err as { code?: unknown }).code as string)
    ) {
      return;
    }
    throw err;
  } finally {
    await handle.close();
  }
}

/** The writer surface one open composition stream exposes (ADR-0008 T29). */
export interface ObservationWriter {
  /** The compositionRunId this writer was opened with; the observation `runId`. */
  readonly compositionRunId: string;
  /**
   * Append one observational event as a JSON line, serially, fsynced before
   * the promise settles. Validates against the observation union (throws on
   * invalid events) and requires `event.runId === compositionRunId`.
   */
  append(event: ObservationEvent): Promise<void>;
  /** Close the stream; idempotent. */
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
 * `journalDir` the stream file is created exclusively ('wx' semantics: an
 * existing file for the same workId/compositionRunId pair is a duplicate
 * composition run, refused rather than appended to); without one the writer
 * buffers in memory and persistence is declared unavailable. Appends are
 * serialized through an internal write chain so concurrent appends never
 * interleave and land in append-call order.
 */
export function openObservationWriter(options: OpenObservationWriterOptions): ObservationWriter {
  const { workId, compositionRunId } = options;
  if (!COMPOSITION_RUN_ID_PATTERN.test(compositionRunId)) {
    throw new Error(
      `observation: compositionRunId must match ${COMPOSITION_RUN_ID_PATTERN.source} ` +
        `(no slashes, not empty): '${compositionRunId}'`,
    );
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(workId)) {
    throw new Error(
      `observation: workId must be a UUID (it joins streams to kernel runs): '${workId}'`,
    );
  }
  const journalDir = options.journalDir;
  const streamDir = journalDir === undefined ? null : join(journalDir, 'observations', workId);
  const streamPath = streamDir === null ? null : join(streamDir, `${compositionRunId}.ndjson`);

  // Write chain: serial appends, in call order; a failed write does not
  // poison the chain (later appends still attempt).
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

  const write = async (line: string): Promise<void> => {
    if (streamPath === null) return; // memory-only
    if (writeFailed !== null) throw writeFailed;
    try {
      if (handle === null) {
        await mkdir(streamDir as string, { recursive: true });
        // Exclusive create IS the claim: a second writer for the same
        // composition run is refused, never merged into one file.
        handle = await open(streamPath, 'wx');
        await syncStreamDir(streamDir as string);
      }
      await handle.writeFile(line, 'utf8');
      await handle.datasync();
    } catch (err) {
      writeFailed ??= err;
      throw err;
    }
  };

  return {
    compositionRunId,

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
      if (
        parsed.type === 'composition-started' &&
        parsed.payload.correlation.workId !== workId
      ) {
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
      const next = tail.then(() => write(line));
      tail = next.catch(() => undefined);
      await next;
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
    },
  };
}

/** Read one stream file's events; null fields distinguish absent from torn. */
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
    const parsed = ObservationEventSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `observation: corrupt line ${i + 1} of ${path} — complete but invalid ` +
          `(${parsed.error.issues[0]?.message ?? 'schema mismatch'})`,
      );
    }
    events.push(parsed.data);
  }
  return { events, complete: !tornTail, exists: true };
}

/**
 * Read every observation stream under `<journalDir>/observations`, each
 * validated separately and independently, joined by workId. One corrupt
 * stream throws with its path; other streams are not folded from a bad
 * neighbor's bytes. File order is preserved within each stream; streams
 * sort by workId then compositionRunId (deterministic; timestamps never
 * manufacture cross-stream order).
 */
export async function readObservations(journalDir: string): Promise<ObservationStream[]> {
  const root = join(journalDir, 'observations');
  let workIds: string[];
  try {
    workIds = await readdir(root);
  } catch (err) {
    if (isEnoent(err)) return []; // no observations yet
    throw err;
  }
  const streams: ObservationStream[] = [];
  for (const workId of workIds.sort()) {
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
      const stream: ObservationStream = { workId, compositionRunId, events, complete };
      assertStreamIdentity(stream);
      streams.push(stream);
    }
  }
  return streams;
}

/**
 * Stream identity couplings (ADR-0008), enforced on the read and fold paths
 * too (readObservations/foldObservations never parse through the schema, so
 * the schema's refinement alone does not cover on-disk streams):
 *   - a COMPLETE stream opens with exactly one composition-started header
 *     (this requirement alone is waived for an INCOMPLETE stream — a crash
 *     during the header write leaves a torn or empty prefix);
 *   - every event's runId matches the stream's compositionRunId;
 *   - any present header's correlation.workId matches the stream's workId.
 * Identity of the events ALREADY PRESENT in a torn stream is validated too:
 * partial evidence is still attributed evidence.
 */
function assertStreamIdentity(stream: ObservationStream): void {
  for (const event of stream.events) {
    if (event.runId !== stream.compositionRunId) {
      throw new Error(
        `observation: stream '${stream.workId}/${stream.compositionRunId}' carries an event ` +
          `with runId '${event.runId}' that does not match its compositionRunId`,
      );
    }
  }
  const headers = stream.events.filter((e) => e.type === 'composition-started');
  for (const headerEvent of headers) {
    if (headerEvent.payload.correlation.workId !== stream.workId) {
      throw new Error(
        `observation: stream '${stream.workId}/${stream.compositionRunId}' header ` +
          `correlation.workId '${headerEvent.payload.correlation.workId}' does not match ` +
          `this stream's workId '${stream.workId}'`,
      );
    }
  }
  // A duplicate or misplaced header is a concatenated or corrupt stream in
  // BOTH modes — a torn prefix waives only the MISSING-header requirement.
  if (
    headers.length > 1 ||
    (headers.length === 1 && stream.events[0]?.type !== 'composition-started')
  ) {
    throw new Error(
      `observation: stream '${stream.workId}/${stream.compositionRunId}' has a misplaced or ` +
        `duplicate composition-started header (found ${headers.length})`,
    );
  }
  if (!stream.complete) return; // torn/empty prefix: missing header waived
  if (headers.length !== 1) {
    throw new Error(
      `observation: stream '${stream.workId}/${stream.compositionRunId}' must carry exactly ` +
        `one composition-started header at its head, found ${headers.length}`,
    );
  }
}

/**
 * Fold observation streams into per-composition-run observations joined to
 * their kernel runs (ADR-0008): the join is by workId and kernel-run-linked
 * ONLY — file order is preserved within each stream, and cross-stream order
 * is never manufactured from timestamps. Identity is validated before any
 * stream folds (see {@link assertStreamIdentity}). Kernel replay consumes
 * only kernel streams; observational events never alter reservations,
 * sequence claims or job statuses (that is the kernel fold's property,
 * untouched here).
 */
export function foldObservations(streams: readonly ObservationStream[]): ObservationStream[] {
  const folded: ObservationStream[] = [];
  for (const stream of streams) {
    assertStreamIdentity(stream);
    folded.push(stream);
  }
  return folded;
}

/** Kernel runs referenced by a folded stream's kernel-run-linked events, in stream order. */
export function linkedKernelRuns(stream: ObservationStream): string[] {
  return stream.events
    .filter((e): e is KernelRunLinkedJournalEvent => e.type === 'kernel-run-linked')
    .map((e) => e.payload.kernelRunId);
}

/** Reserved for the M0 wiring slices: the correlation record a header carries. */
export type HeaderCorrelation = CorrelationRecord;
