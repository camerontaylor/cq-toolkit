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
// incomplete final line — by definition one WITHOUT its trailing newline.
// `read` tolerates exactly that: an unparsable LAST line is ignored only when
// the file does NOT end with '\n' (a torn final write), and whitespace-only
// trailing lines are dropped (no event bytes). Any other complete but
// invalid line — including last — throws, as does any unparsable middle
// line, and a line whose event.runId does not match the file's run: a hole
// or misattribution in complete evidence is corruption, not a torn write,
// and silently accepting it would poison the fold.
import { appendFile, mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
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

/**
 * Tail shape of a well-formed runId: `<timestamp>--<random>` — exactly two
 * more dash-free segments after the planId prefix (base36/hex by the
 * generator; case-insensitive so operator-copied evidence is not silently
 * dropped). OWNED HERE because journal.ts owns the runId shape
 * ({@link assertSafeRunId}); every consumer of the shape shares one
 * definition.
 */
const RUN_ID_TAIL = /^[0-9a-z]+--[0-9a-f]+$/i;

/**
 * The resume/seed candidate filter shared by EVERY consumer that picks a
 * plan's runs out of a journal dir (the runner's replay fold, which also
 * seeds the governor). A candidate must carry the `<planId>--` prefix AND the
 * two-segment tail, so a planId that itself ends in `--<segment>` ('a' vs
 * 'a--b') cannot match the other plan's files and a corrupt journal of
 * ANOTHER plan cannot block this plan's reads.
 *
 * Failure direction, named: a genuine evidence file whose tail does not
 * conform (operator-renamed) is skipped — that can only cause RE-RUNS, never
 * a wrong skip, because the per-file planId check still guards every parsed
 * run. System-written runIds always conform.
 */
export function candidateRunsForPlan(runIds: readonly string[], planId: string): string[] {
  return runIds.filter(
    (candidateId) =>
      candidateId.startsWith(`${planId}--`) &&
      RUN_ID_TAIL.test(candidateId.slice(planId.length + 2)),
  );
}

/** The journal surface one open run-log directory exposes. All async, all serializable. */
export interface RunLog {
  /**
   * Append one event as a JSON line to `<journalDir>/<runId>.ndjson`,
   * creating `journalDir` recursively if needed. Validates the event against
   * JournalEventSchema (throws on invalid events) and requires
   * `event.runId === runId`. Appends are serialized through an internal
   * write chain, so lines from concurrent jobs never interleave and land in
   * append-call order. With `{ durable: true }` the line is written through
   * an append-mode file handle and `fdatasync`ed before the promise settles
   * (ADR-0003 annex §2 durability: `reservation-*`-class facts), and the
   * journal DIRECTORY is fsync'd once per run file this process created, so
   * a crash cannot lose the directory entry of a file whose lines are
   * already durable. macOS `F_FULLFSYNC` remains a recorded power-loss
   * residual; process-crash durability does not depend on it.
   */
  append(runId: string, event: JournalEvent, opts?: { durable?: boolean }): Promise<void>;
  /**
   * Parse every line of `<runId>.ndjson` in order. A missing file means "no
   * facts yet" and yields `[]`; an unparsable last line is ignored ONLY when
   * the file has no trailing newline (a torn final write), and whitespace-only
   * trailing lines are dropped as byte-less; any other complete but invalid
   * line — including last — throws (evidence corruption), as does a line
   * whose event.runId does not match the file's run.
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
  // Run files this process has already dir-fsynced: the directory entry is
  // durable once, at creation; later appends to a known file skip the dir
  // fsync entirely.
  const dirSynced = new Set<string>();

  return {
    async append(runId, event, opts): Promise<void> {
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
      const durable = opts?.durable === true;
      const write = async (): Promise<void> => {
        await mkdir(journalDir, { recursive: true });
        const isNew = !dirSynced.has(runId);
        if (durable) {
          const handle = await open(pathFor(runId), 'a');
          try {
            await handle.writeFile(line, 'utf8');
            await handle.datasync();
          } finally {
            await handle.close();
          }
        } else {
          await appendFile(pathFor(runId), line, 'utf8');
        }
        if (isNew) {
          dirSynced.add(runId);
          await syncDir(journalDir);
        }
      };
      const next = tail.then(write, write);
      tail = next.catch(() => undefined);
      await next;
    },

    async read(runId: string): Promise<JournalEvent[]> {
      assertSafeRunId(runId);
      return readEvents(runId, pathFor(runId));
    },

    async runs(): Promise<string[]> {
      return listRuns(journalDir);
    },

    async statusOf(runId: string): Promise<JobStatus[]> {
      assertSafeRunId(runId);
      return deriveJobStatuses(await readEvents(runId, pathFor(runId)));
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

/**
 * fsync the DIRECTORY so a freshly created file's directory entry is durable
 * (annex §2: "the journal directory is fsync'd when a run file is created").
 * A read-mode directory fd + fsync is the POSIX idiom. Some exotic mounts
 * (network FS, certain container overlays) refuse it with EPERM/EACCES/
 * EINVAL/ENOSYS — on those the call is a recorded best-effort no-op: the
 * supported local-filesystem case (the only one the plan lock and resume
 * fold make claims about) gets real dirent durability, and a refusal never
 * blocks an otherwise-successful journal write. macOS F_FULLFSYNC remains a
 * power-loss residual (ADR-0003 §2.5); process-crash durability does not
 * depend on it.
 */
async function syncDir(dir: string): Promise<void> {
  const SOFT_ERRORS = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS']);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, 'r');
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

/**
 * Claim the next fold-order ordinal for a plan (ADR-0003 annex §2/§3): `seq`
 * is ASSIGNED by exclusive create of `<journalDir>/<planId>.seq.<n>`
 * (`'wx'`), retrying `n + 1` on `EEXIST`, so two contenders can never both
 * write `n` — uniqueness holds by construction, not by lock discipline
 * (critic r2 m-b; the lock is W2.4's and this claim does not wait for it).
 * The claim file is a tombstone: it is never read back, only its existence
 * is the claim. `startAt` is the first ordinal to try — the caller passes
 * 1 + the highest seq folded from the plan's existing journals. The journal
 * dir is created recursively first (the append path's lazy-create contract:
 * a FIRST governed run over a not-yet-existing `--journal-dir` claims its
 * seq instead of failing on the missing dir).
 *
 * Bounded: 10_000 consecutive EEXISTs mean something else is writing these
 * tombstones — corruption, not contention — and throws.
 */
export async function claimSeq(
  journalDir: string,
  planId: string,
  startAt: number,
): Promise<number> {
  if (!Number.isInteger(startAt) || startAt < 1) {
    throw new Error(`journal: claimSeq startAt must be an integer >= 1, got ${startAt}`);
  }
  await mkdir(journalDir, { recursive: true });
  for (let n = startAt; n < startAt + 10_000; n++) {
    try {
      // The exclusive open IS the claim — the tombstone's existence, never
      // its content (it is not read back). Closed immediately so a claimed
      // seq does not pin the descriptor for the process lifetime.
      const handle = await open(join(journalDir, `${planId}.seq.${n}`), 'wx');
      await handle.close();
      return n;
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'EEXIST'
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `journal: claimSeq could not claim a seq for plan '${planId}' after 10000 attempts starting at ${startAt}`,
  );
}

/** One parsed run of a plan, for fold ordering. */
export interface FoldRun {
  runId: string;
  events: readonly JournalEvent[];
}

/**
 * THE HIGHEST-CLAIM CHECK — the reader-side check for {@link claimSeq}.
 * Called with the highest `seq` folded from run-started events: a claim
 * tombstone (`<planId>.seq.<n>`) beyond it means a seq was claimed but its
 * run is gone. Refuse that trailing gap instead of silently lowering the
 * seeded spend. This max-only comparison does NOT detect deletion of an
 * interior run when a higher-seq run remains; it is not a contiguity check.
 *
 * Fail-closed trade, named: a crash between `claimSeq` and the first append
 * leaves an ORPHAN tombstone that also trips this check — the next run
 * refuses with this error until the operator deletes the named tombstone
 * (nothing was dispatched under a claimed-but-unstarted seq, so deleting it
 * is safe and the claim retries at that ordinal). That is the honest
 * direction: a one-file operator fix beats a ledger that silently forgets
 * spend.
 */
export async function assertNoSeqGap(
  journalDir: string,
  planId: string,
  maxFoldedSeq: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(journalDir);
  } catch (err) {
    if (isEnoent(err)) return; // no dir yet — no tombstones exist
    throw err;
  }
  const prefix = `${planId}.seq.`;
  let maxTombstone = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const ordinal = Number(name.slice(prefix.length));
    if (Number.isInteger(ordinal) && ordinal > maxTombstone) maxTombstone = ordinal;
  }
  if (maxTombstone > maxFoldedSeq) {
    throw new Error(
      `journal: corrupt — seq gap for plan '${planId}': claim tombstone '${prefix}${maxTombstone}' exists ` +
        `but the highest folded run-started seq is ${maxFoldedSeq} — a claimed run's file is missing, so its ` +
        `spend cannot seed the ledger. If the tombstone is an orphaned claim (a crash between claimSeq and ` +
        `the first append), delete '${prefix}${maxTombstone}' and re-run.`,
    );
  }
}

/**
 * THE FOLD ORDER (ADR-0003 annex §3, r1 m4): v1 runs (run-started without
 * `journalVersion`) ordered by `at` then runId, ALL before every v2 run; v2
 * runs ordered by `seq`. The injected clock can no longer reorder the fold —
 * `at` is display-only for v2 runs. Corruption is loud: a v2 run without
 * `seq`, or two v2 runs of the plan sharing one `seq`, throws (annex §2 —
 * uniqueness holds by construction for writers; a violation on READ is a
 * corrupted dir, never silently folded).
 */
export function foldOrderRuns(runs: readonly FoldRun[]): FoldRun[] {
  const v1: Array<{ run: FoldRun; at: string }> = [];
  const v2: Array<{ run: FoldRun; seq: number }> = [];
  for (const run of runs) {
    const started = run.events.find(
      (event): event is Extract<JournalEvent, { type: 'run-started' }> =>
        event.type === 'run-started',
    );
    if (started === undefined) {
      throw new Error(
        `journal: fold order requires a run-started event; run '${run.runId}' has none`,
      );
    }
    if (started.journalVersion === undefined) {
      v1.push({ run, at: started.at });
    } else {
      if (started.seq === undefined) {
        throw new Error(
          `journal: corrupt — v2 run '${run.runId}' (plan '${started.planId}') has no seq`,
        );
      }
      v2.push({ run, seq: started.seq });
    }
  }
  v1.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.run.runId < b.run.runId ? -1 : 1));
  v2.sort((a, b) => a.seq - b.seq);
  let previous: { run: FoldRun; seq: number } | undefined;
  for (const entry of v2) {
    if (previous !== undefined && entry.seq === previous.seq) {
      throw new Error(
        `journal: corrupt — duplicate seq ${entry.seq} across runs '${previous.run.runId}' and '${entry.run.runId}'`,
      );
    }
    previous = entry;
  }
  return [...v1.map((entry) => entry.run), ...v2.map((entry) => entry.run)];
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

async function readEvents(fileRunId: string, path: string): Promise<JournalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return []; // no facts yet for this runId
    throw err;
  }
  if (raw === '') return [];
  // Torn-tail detection BEFORE splitting: tolerance applies only when the
  // final write never completed (no trailing newline). A file that ends with
  // '\n' consists solely of complete lines — an invalid one is corruption,
  // even in last position. Whitespace-only trailing lines are the one
  // exception: they carry no event bytes (benign `echo '' >>` damage, not a
  // torn write of an event), so they are dropped, while a whitespace line in
  // the MIDDLE still throws — there it is a hole in the evidence.
  const tornTail = !raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop(); // file ended with a complete newline; the '' split artifact is not an event
  }
  while (lines.at(-1)?.trim() === '') {
    lines.pop();
  }
  const events: JournalEvent[] = [];
  for (const [i, line] of lines.entries()) {
    const parsed = parseLine(line);
    if (parsed !== null) {
      // The file name is the run identity (append enforces the same match at
      // write time), so a line claiming another runId is misattributed
      // evidence — e.g. operator-concatenated journals — and must throw, not
      // silently fold into the wrong run.
      if (parsed.runId !== fileRunId) {
        throw new Error(
          `journal: corrupt line ${i + 1} of ${path} — event.runId '${parsed.runId}' does not ` +
            `match this file's run '${fileRunId}'`,
        );
      }
      events.push(parsed);
      continue;
    }
    if (i === lines.length - 1 && tornTail) {
      break; // torn tail: crash mid-append, only an UNTERMINATED last line may be lost
    }
    throw new Error(
      `journal: corrupt line ${i + 1} of ${path} — a complete but invalid line is corruption; ` +
        'only a trailing torn line (one without a trailing newline) is tolerated',
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
  return runIds.sort((a, b) => (mtimeMs.get(a) ?? 0) - (mtimeMs.get(b) ?? 0) || (a < b ? -1 : 1));
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
      case 'reservation-opened':
      case 'reservation-settled':
      case 'reservation-refused':
      case 'job-quarantined':
      case 'quarantine-released':
        break; // no per-job VERDICT facts (a quarantine is not a terminal verdict; the governed runner owns it)
    }
  }
  return [...states].map(([jobId, state]) => ({ jobId, state }));
}
