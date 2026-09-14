// Append-only NDJSON run journal — T1.2 (durable facts, derived status).
//
// The journal is EVIDENCE, so it is deliberately dumb:
//   - The caller (the plan runner) owns runId generation; the journal only
//     asserts runIds are filesystem-safe (they become `<runId>.ndjson` file
//     names) and that the event's own `runId` matches the file it lands in.
//   - Append-only: one validated JSON line per event, never rewritten. Every
//     event is validated against the frozen JournalEventSchema BEFORE it hits
//     disk — an invalid event is a loud error, not silent evidence rot.
//   - Status is derived at READ time (`statusOf`): the file stores facts
//     (started, finished with result X); states are a fold over those facts,
//     so a corrupted or stale derived view can always be recomputed.
//
// Crash tolerance (torn-tail policy): a crash mid-append can leave an
// incomplete final line. `read` tolerates exactly that — an unparsable LAST
// line is ignored; an unparsable (invalid JSON or schema-invalid) MIDDLE line
// throws, because a hole in the middle of the evidence is corruption, not a
// torn write.
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JournalEventSchema } from './schema.js';
import type { JobState, JobStatus, JournalEvent } from './types.js';

/**
 * Filesystem-safe runId: 1+ chars of [A-Za-z0-9._-], starting alphanumeric.
 * This bans path separators (both `/` and `\`), empty ids, and dot-only ids,
 * so a runId can be used verbatim as `<runId>.ndjson` with no escaping.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `runId` is filesystem-safe (see RUN_ID_PATTERN). */
export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `journal: runId must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (no slashes, not empty): '${runId}'`,
    );
  }
}

/** The journal surface one open run-log directory exposes. All async, all serializable. */
export interface RunLog {
  /**
   * Append one event as a JSON line to `<journalDir>/<runId>.ndjson`,
   * creating `journalDir` recursively if needed. Validates the event against
   * JournalEventSchema (throws on invalid events) and requires
   * `event.runId === runId`. Appends are serialized through an internal
   * write chain, so lines from concurrent jobs never interleave and land in
   * append-call order.
   */
  append(runId: string, event: JournalEvent): Promise<void>;
  /**
   * Parse every line of `<runId>.ndjson` in order. A missing file means "no
   * facts yet" and yields `[]`; an unparsable LAST line is ignored (torn
   * tail); an unparsable middle line throws (evidence corruption).
   */
  read(runId: string): Promise<JournalEvent[]>;
  /** Run ids present in the dir, files sorted by mtime, oldest first (ties broken by id). */
  runs(): Promise<string[]>;
  /** Derive per-job status by folding this run's events — see {@link deriveJobStatuses}. */
  statusOf(runId: string): Promise<JobStatus[]>;
}

/** Open `journalDir` as a run-log directory. Pure accessor — no I/O until first use. */
export function openRunLog(journalDir: string): RunLog {
  const pathFor = (runId: string): string => join(journalDir, `${runId}.ndjson`);
  // Write chain: each append waits for the previous one, so concurrent job
  // completions produce ordered, non-interleaved lines. A failed write does
  // not poison the chain (later appends still run).
  let tail: Promise<void> = Promise.resolve();

  return {
    async append(runId: string, event: JournalEvent): Promise<void> {
      assertSafeRunId(runId);
      // Validate BEFORE writing: the journal only ever contains facts that
      // parse. The parsed value is what lands on disk.
      const parsed: JournalEvent = JournalEventSchema.parse(event);
      if (parsed.runId !== runId) {
        throw new Error(
          `journal: event.runId '${parsed.runId}' does not match target run '${runId}'`,
        );
      }
      const line = `${JSON.stringify(parsed)}\n`;
      const write = async (): Promise<void> => {
        await mkdir(journalDir, { recursive: true });
        await appendFile(pathFor(runId), line, 'utf8');
      };
      const next = tail.then(write, write);
      tail = next.catch(() => undefined);
      await next;
    },

    async read(runId: string): Promise<JournalEvent[]> {
      assertSafeRunId(runId);
      return readEvents(pathFor(runId));
    },

    async runs(): Promise<string[]> {
      return listRuns(journalDir);
    },

    async statusOf(runId: string): Promise<JobStatus[]> {
      assertSafeRunId(runId);
      return deriveJobStatuses(await readEvents(pathFor(runId)));
    },
  };
}

// ---------------------------------------------------------------------------
// Internals (also used by deriveJobStatuses tests via the RunLog surface)
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Parse one journal line: JSON.parse then JournalEventSchema; null when either fails. */
function parseLine(line: string): JournalEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const result = JournalEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

async function readEvents(path: string): Promise<JournalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return []; // no facts yet for this runId
    throw err;
  }
  if (raw === '') return [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop(); // file ended with a complete newline; the '' split artifact is not an event
  }
  const events: JournalEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed !== null) {
      events.push(parsed);
      continue;
    }
    if (i === lines.length - 1) {
      break; // torn tail: crash mid-append, only the LAST line may be lost
    }
    throw new Error(
      `journal: corrupt line ${i + 1} of ${path} — middle lines must be valid journal events ` +
        '(only a trailing torn line is tolerated)',
    );
  }
  return events;
}

async function listRuns(journalDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(journalDir);
  } catch (err) {
    if (isEnoent(err)) return []; // no runs yet
    throw err;
  }
  const runIds = names
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => name.slice(0, -'.ndjson'.length));
  const mtimeMs = new Map<string, number>();
  await Promise.all(
    runIds.map(async (runId) => {
      const stats = await stat(join(journalDir, `${runId}.ndjson`));
      mtimeMs.set(runId, stats.mtimeMs);
    }),
  );
  // Oldest first; ties broken by id so the order is deterministic.
  return runIds.sort(
    (a, b) => (mtimeMs.get(a) ?? 0) - (mtimeMs.get(b) ?? 0) || (a < b ? -1 : 1),
  );
}

/**
 * THE derivation rules (status is a fold over journal facts, in file order —
 * later facts win; output order is first appearance of each job):
 *
 *   - `job-started`                → `running` (a retry after a finish puts the
 *                                    job back to `running`).
 *   - `job-finished` result `ok`   → `done`
 *   - `job-finished` result `failed` → `failed`
 *   - `job-finished` result `budget-exhausted` → `budget-exhausted`
 *   - `job-finished` result `needs-human` or `indeterminate` → no frozen
 *     JobState is faithful (JobState has no needs-human value; `blocked`
 *     means waiting on dependencies; `failed` would overstate). The job
 *     KEEPS ITS LAST DERIVED STATE (typically `running`), so a resumed run
 *     re-dispatches it — the honest posture for an outcome that is not a
 *     verdict. KNOWN FRICTION with the T1.1 freeze (worked around, not
 *     edited): reported for the types-freeze owners.
 *   - Jobs never started do not appear at all: a journal only records facts
 *     about work actually dispatched, so the missing ids ARE the "to run"
 *     list for resume. `queued` and `blocked` are likewise not derivable —
 *     job-started events carry no dependency info.
 *   - `run-started` / `run-finished` carry no per-job facts here. Run-level
 *     budget-exhausted marking arrives with T1.3's run-level events.
 */
export function deriveJobStatuses(events: readonly JournalEvent[]): JobStatus[] {
  const states = new Map<string, JobState>();
  for (const event of events) {
    switch (event.type) {
      case 'job-started':
        states.set(event.jobId, 'running');
        break;
      case 'job-finished':
        switch (event.result.status) {
          case 'ok':
            states.set(event.jobId, 'done');
            break;
          case 'failed':
            states.set(event.jobId, 'failed');
            break;
          case 'budget-exhausted':
            states.set(event.jobId, 'budget-exhausted');
            break;
          case 'needs-human':
          case 'indeterminate':
            // No faithful frozen state — keep the last derived state.
            break;
        }
        break;
      case 'run-started':
      case 'run-finished':
        break; // no per-job facts
    }
  }
  return [...states].map(([jobId, state]) => ({ jobId, state }));
}
