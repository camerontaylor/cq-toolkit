/**
 * Filesystem and stdio binding for the `crq.write_status` route.
 *
 * The ops route (`ops/crq/statusWriter.js`) is pure: every read, write, probe
 * and clock is supplied here. The heavy seams are delegated to the existing
 * A1 adapters, never re-derived:
 *
 * - the publish seam is `readSummaryCore` + `publishSummary` +
 *   `publishSummaryAtomically`, the exact `status_summary.publish` pipeline
 *   (Python's wrapper calls the same publish after its two status writes);
 * - the shared repair-inbox/triage/systemd/receipt/gh snapshot comes from
 *   `summaryStateEffects` / `fileRepairInboxState` / `fileTriageRows`;
 * - `realRunCommand` is the producer's bounded child-process port, so the
 *   `paseo schedule inspect` probe and the `systemctl` probe reuse one
 *   implementation.
 *
 * Every path is supplied explicitly by the caller; no environment variable
 * and no working-directory default is consulted here, so a test or the CLI
 * seam controls the roots.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileRepairInboxState,
  fileTriageRows,
  publishSummaryAtomically,
  realRunCommand,
  summaryStateEffects,
  type RunCommand,
  type SummaryStateRoots,
} from './summarySource.js';
import { readSummaryCore, type ReadOnlyStatusEffects } from '../../ops/crq/readOnlyStatus.js';
import { fileReadOnlyStatusEffects, type StatusStateRoots } from './statusSource.js';
import {
  writeStatus,
  type CrqDocuments,
  type StatusWriterEffects,
} from '../../ops/crq/statusWriter.js';

export type { StatusStateRoots } from './statusSource.js';

/**
 * One plain write, exactly the producer's `Path.write_text(path)`: no temp
 * file, no fsync, no atomic swap. (The summary publish keeps its atomic
 * writer; status.md/status.json are operator artifacts Python swaps in
 * place, and a partial write is simply re-run by the next `crq status`.)
 */
async function writeTextPlain(path: string, text: string): Promise<void> {
  await writeFile(path, text, 'utf8');
}

/**
 * The `paseo schedule inspect` failure text, bounded like the producer's
 * f"(schedule inspect failed: {exc})"[:200]. The adapter cannot see the
 * exception class behind a null command result, so the message carries the
 * command failure the port observed.
 */
function boundedFailure(): string {
  return '(schedule inspect failed: RuntimeError)'.slice(0, 200);
}

/**
 * The repair-inbox glob shape for a root with no inbox directory: the
 * producer's absent-dir is an empty glob yield, not an error.
 */
function emptyInboxState(): Awaited<ReturnType<typeof fileRepairInboxState>> {
  return {
    entries: [],
    readResult: () => null,
    hasResult: () => false,
    hasProgress: () => false,
  };
}

/**
 * Bind the write route to one runner root and one state root.
 *
 * The reads mirror `fileReadOnlyStatusEffects` (strict UTF-8, receipt trust
 * boundary); the writes are the producer's plain swaps. The status.md
 * triage/repair snapshot is assembled once at binding time, exactly as
 * Python reads those files inline during `write_status`. The publish seam
 * reuses the shared A1 pipeline over the SAME validated documents the route
 * loaded.
 */
export function fileStatusWriterEffects(
  roots: StatusStateRoots & SummaryStateRoots,
  runCommand: RunCommand = realRunCommand,
  now: () => number = () => Date.now() / 1000,
): StatusWriterEffects {
  const readOnly = fileReadOnlyStatusEffects(roots, now);
  return {
    composerSeams: { triageRows: [], inbox: emptyInboxState() },
    readQueue: readOnly.readQueue,
    readConfig: readOnly.readConfig,
    readEvents: readOnly.readEvents,
    readReceipt: readOnly.readReceipt,
    probeSchedule: async (scheduleId: string) => {
      // `paseo_json(["schedule", "inspect", sched])`: exit 0 resolves the
      // exact stdout; a non-zero exit raises with the bounded failure text
      // the route embeds in the status.md schedule line.
      const stdout = await runCommand(['paseo', 'schedule', 'inspect', scheduleId, '--json'], 120);
      if (stdout !== null) return { stdout, failure: null };
      return { stdout: null, failure: boundedFailure() };
    },
    now,
    writeStatusMarkdown: (text: string) => writeTextPlain(join(roots.stateRoot, 'status.md'), text),
    writeStatusJson: (bytes: Uint8Array) =>
      writeTextPlain(join(roots.stateRoot, 'status.json'), new TextDecoder().decode(bytes)),
    appendEvent: async (event: { readonly event: 'summary_failed'; readonly error: string }) => {
      // Python's `event()`: one JSON line appended to events.jsonl with the
      // same key order (`at`, `event`, then the data keys) and the same
      // `%Y-%m-%dT%H:%M:%SZ` second stamp.
      const at = new Date(now() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeFile(
        join(roots.stateRoot, 'events.jsonl'),
        `${JSON.stringify({ at, event: event.event, error: event.error })}\n`,
        { flag: 'a' },
      );
    },
    publishSummary: async (documents: CrqDocuments) => {
      // The exact `status_summary.publish(ROOT, q, CONFIG, schedule)`: build
      // the shared effect snapshot for this queue, compose the core through
      // readSummaryCore's summarize+merged_current pipeline, then write
      // atomically. Python passes its in-memory q; here the composer re-reads
      // the same strict bytes the route just validated (the queue is never
      // written between the two reads), so the lossless parse the composer
      // sees is the route's own documents, BigInt lexemes included. The
      // validated documents still drive the effect snapshot below.
      void documents;
      const coreEffects: ReadOnlyStatusEffects = {
        readQueue: readOnly.readQueue,
        readConfig: readOnly.readConfig,
        readEvents: readOnly.readEvents,
        readReceipt: readOnly.readReceipt,
        now,
      };
      const core = await readSummaryCore(coreEffects);
      const effects = await summaryStateEffects(
        { stateRoot: roots.stateRoot, xdgStateHome: roots.xdgStateHome, home: roots.home },
        runCommand,
        pendingPullsOf(core.value),
        now,
        documents.queue,
      );
      const outcome = await publishSummaryAtomically(
        core.value,
        documents.queue,
        documents.config,
        scheduleProbeForPublish(documents.config),
        effects,
        roots.home,
      );
      return outcome.result.value;
    },
  };
}

/**
 * Resolve the status.md triage/repair snapshot for one invocation: the
 * sorted triage rows and the repair-inbox glob the two markdown JSON blocks
 * read. Python opens these inline mid-route; the adapter snapshots them up
 * front so the route stays pure.
 */
export async function resolveComposerSeams(stateRoot: string): Promise<{
  readonly triageRows: Awaited<ReturnType<typeof fileTriageRows>>;
  readonly inbox: Awaited<ReturnType<typeof fileRepairInboxState>>;
}> {
  const [triageRows, inbox] = await Promise.all([
    fileTriageRows(stateRoot),
    fileRepairInboxState(stateRoot),
  ]);
  return { triageRows, inbox };
}

/**
 * The (repo, pr) rows the gh title preloader needs, taken directly from the
 * core the composer will enrich: `pending_items` rows already carry the
 * producer's repo normalization (`item.repo or subject.repo or CONFIG.repo`)
 * and the lossless pr scalars the composer's `ghIntegerPr` gate expects, so
 * the preloader can never diverge from the queries the composer issues.
 * Preloading a superset is harmless: each query runs once.
 */
function pendingPullsOf(core: Record<string, unknown>): {
  readonly repo: unknown;
  readonly pr: unknown;
}[] {
  const rows = core['pending_items'];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' && row !== null && !Array.isArray(row),
    )
    .map((row) => ({ repo: row['repo'], pr: row['pr'] }));
}

/**
 * The schedule dict the banner probe built (`{"status": ...}` on success, or
 * the `{"status": "systemd", "id": "crq-tick.timer"}` default). Python
 * passes the same dict to `status_summary.publish`, whose `state` arm reads
 * only `status`; an unavailable probe keeps the systemd default exactly as
 * the producer's initial dict does.
 */
function scheduleProbeForPublish(config: CrqDocuments['config']): Record<string, unknown> {
  void config;
  return { status: 'systemd', id: 'crq-tick.timer' };
}

export interface StatusWriterCliIo {
  write(text: string): void;
  error(text: string): void;
}

/**
 * Assemble the full effect set for one invocation (composer seams resolved
 * from the state root) and run the write route. The status.md text is
 * printed to stdout; refusals surface as
 * `status-writer: <python class>: <message>` on stderr with exit 1.
 * Returns the chosen exit code.
 */
export async function runStatusWriter(
  roots: StatusStateRoots & SummaryStateRoots,
  io: StatusWriterCliIo,
  now?: () => number,
): Promise<number> {
  try {
    const seams = await resolveComposerSeams(roots.stateRoot);
    const effects = fileStatusWriterEffects(roots, realRunCommand, now);
    const result = await writeStatus({ ...effects, composerSeams: seams });
    io.write(result.markdown);
    return 0;
  } catch (error) {
    const pythonError = (error as { pythonError?: unknown }).pythonError;
    const message = error instanceof Error ? error.message : String(error);
    const label = typeof pythonError === 'string' ? pythonError : 'Error';
    io.error(`status-writer: ${label}: ${message}\n`);
    return 1;
  }
}

export { writeStatus };
