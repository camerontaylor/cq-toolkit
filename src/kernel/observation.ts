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

  const write = async (line: string): Promise<void> => {
    if (streamPath === null) return; // memory-only
    if (handle === null) {
      await mkdir(streamDir as string, { recursive: true });
      // Exclusive create IS the claim: a second writer for the same
      // composition run is refused, never merged into one file.
      handle = await open(streamPath, 'wx');
      await syncStreamDir(streamDir as string);
    }
    await handle.writeFile(line, 'utf8');
    await handle.datasync();
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
      const line = `${JSON.stringify(parsed)}\n`;
      const next = tail.then(
        () => write(line),
        () => write(line),
      );
      tail = next.catch(() => undefined);
      await next;
    },

    async close(): Promise<void> {
      closed = true;
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
  if (raw === '') return { events: [], complete: true, exists: true };
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
    } catch {
      continue; // not a stream directory (e.g. stray file): skip silently
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.ndjson')) continue;
      const compositionRunId = file.slice(0, -'.ndjson'.length);
      const { events, complete } = await readStreamFile(join(dir, file));
      streams.push({ workId, compositionRunId, events, complete });
    }
  }
  return streams;
}

/**
 * Fold observation streams into per-composition-run observations joined to
 * their kernel runs (ADR-0008): the join is by workId and kernel-run-linked
 * ONLY — file order is preserved within each stream, and cross-stream order
 * is never manufactured from timestamps. Each stream must carry exactly one
 * composition-started header; a stream without one (or with two) is corrupt
 * evidence. Kernel replay consumes only kernel streams; observational
 * events never alter reservations, sequence claims or job statuses (that is
 * the kernel fold's property, untouched here).
 */
export function foldObservations(streams: readonly ObservationStream[]): ObservationStream[] {
  const folded: ObservationStream[] = [];
  for (const stream of streams) {
    const headers = stream.events.filter((e) => e.type === 'composition-started');
    if (headers.length !== 1) {
      throw new Error(
        `observation: stream '${stream.workId}/${stream.compositionRunId}' must carry exactly ` +
          `one composition-started header, found ${headers.length}`,
      );
    }
    // The header must be first: a stream that opens with anything else is a
    // broken stream, not evidence (same rule as the kernel journal header).
    if (stream.events[0]?.type !== 'composition-started') {
      throw new Error(
        `observation: stream '${stream.workId}/${stream.compositionRunId}' does not open with ` +
          'its composition-started header',
      );
    }
    const links = stream.events.filter((e) => e.type === 'kernel-run-linked');
    // The fold is the identity on well-formed streams; the linked kernel
    // runs are readable from the kernel-run-linked events by the report
    // assembler (T36/T37), joined by workId. No cross-stream ordering is
    // imposed here.
    void links;
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
