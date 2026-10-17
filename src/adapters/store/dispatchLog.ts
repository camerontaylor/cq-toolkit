// fileDispatchLog — the crash-safe dispatch memory (the store adapter's
// dispatch log; extracted from ops/review/replyAndResolve.ts by Phase 1.4 —
// the responder op keeps the action vocabulary and the dispatch CONTRACT,
// this module is its file-backed persistence and cross-process lock).
import { appendFile, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { lock } from 'proper-lockfile';
import type { ReviewAction } from '../../ops/review/replyAndResolve.js';

/** One recorded successful dispatch — the dedupe memory's unit. */
export interface DispatchRecord {
  /** The action's stable id (the dedupe key). */
  actionId: string;
  /** Which action kind produced the record. */
  kind: ReviewAction['kind'];
  /** The created comment's REST id, or the resolved thread id. */
  resultRef: string;
  /** When the dispatch happened: the run's injected nowMs. */
  at: number;
}

/**
 * The crash-safe dispatch memory. `load` returns every prior record (an
 * absent log = empty history); `record` persists one entry before the
 * caller proceeds. Injectable: tests use an in-memory log, the CLI uses
 * fileDispatchLog.
 */
export interface DispatchLog {
  load(): Promise<DispatchRecord[]>;
  record(entry: DispatchRecord): Promise<void>;
  /**
   * OPTIONAL cross-process serialization for ONE action's load →
   * check → post → record sequence. The file-backed log provides it (a
   * `<logPath>.lock` lockfile, proper-lockfile, bounded retries — failure
   * to acquire within the bound throws loud naming the path); the
   * in-memory log does not: in-process callers are single-threaded, and
   * cross-process dedupe needs the file-backed log. Callers must hold the
   * lock around exactly ONE action's sequence, never the whole batch (a
   * whole-batch critical section is an avoidably long lock).
   */
  withLogLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The file-backed DispatchLog: one JSON record per line (JSON-lines-ish).
 * `load` reads the whole file — a missing file is an EMPTY log (first run).
 * It parses line-by-line and is CRASH-TOLERANT AT THE TAIL: `record` is a
 * single-line `appendFile`, so a crash mid-append can only truncate the
 * FINAL line — a truncated tail line is tolerated (dropped; the action was
 * never truly recorded, so the next run retries it safely), while a broken
 * line MID-FILE (more records follow it) still throws a clear message:
 * dispatching on top of an unreadable log would silently duplicate prior
 * posts, so mid-file corruption stays loud, never tolerant. `record`
 * appends exactly one newline-terminated line — no read-modify-write, so
 * interleaved loads/records can never lose a record and a crash can never
 * damage PRIOR lines — and it repairs the tail before appending: junk is
 * truncated, while an unterminated tail that already parses as a complete
 * record is KEPT (load() counts it dispatched) and only its newline
 * boundary is added — the retry never discards a landed dispatch nor
 * concatenates onto junk.
 */
export function fileDispatchLog(path: string): DispatchLog {
  const load = async (): Promise<DispatchRecord[]> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const records: DispatchRecord[] = [];
    const lines = text.split('\n');
    // Trailing newline(s) are termination, not content.
    let lastContent = lines.length - 1;
    while (lastContent >= 0 && (lines[lastContent] ?? '').trim() === '') {
      lastContent -= 1;
    }
    for (let i = 0; i <= lastContent; i++) {
      const line = (lines[i] ?? '').trim();
      if (line === '') continue;
      try {
        records.push(JSON.parse(line) as DispatchRecord);
      } catch {
        if (i === lastContent) {
          // Truncated FINAL line — a crash mid-append. Drop it: the record
          // never landed, so the action stays retriable on the next run.
          break;
        }
        throw new Error(
          `fileDispatchLog: dispatch log at ${JSON.stringify(path)} is corrupt (line ${i + 1} does not parse as JSON, and later lines follow it) — refusing to dispatch on top of an unreadable log; fix or remove the file and re-run`,
        );
      }
    }
    return records;
  };
  const record = async (entry: DispatchRecord): Promise<void> => {
    // A discarded partial tail is truncated before the retry appends, so a
    // crash mid-append can never poison the next record — BUT not every
    // unterminated tail is garbage: a crash AFTER the record's closing '}'
    // but BEFORE its '\n' left a VALID record that load() already parses
    // and counts dispatched. The repair therefore mirrors load() exactly:
    // an unterminated tail that parses as JSON is KEPT (only its '\n'
    // boundary is added — truncating it would discard a landed dispatch
    // and cause a repost), while a tail that does not parse is truncated.
    // Either way the new record lands on a clean newline boundary.
    let handle: FileHandle | null = null;
    let boundaryNeeded = false;
    try {
      handle = await open(path, 'r+');
      const bytes = await handle.readFile();
      const keep = bytes.lastIndexOf(0x0a) + 1; // through the last COMPLETE line
      if (keep < bytes.length) {
        const tail = bytes.subarray(keep).toString('utf8');
        try {
          JSON.parse(tail);
          // The tail IS a complete record — keep it byte-for-byte; only
          // the newline boundary is missing.
          boundaryNeeded = true;
        } catch {
          await handle.truncate(keep); // junk tail: cut it
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // Missing file (the very first record): nothing to repair —
      // appendFile creates it below.
    } finally {
      await handle?.close();
    }
    if (boundaryNeeded) {
      await appendFile(path, '\n', 'utf8');
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  /**
   * The cross-process dedupe lock: serializes ONE action's load → check →
   * post → record so two jobs processing the same PR cannot both see the
   * actionId unseen and both POST (a duplicate user-visible reply). Same
   * proper-lockfile pattern as the worktree registry: `<path>.lock`,
   * bounded retries, loud throw naming the path on failure. The log file
   * is materialized (empty) before locking — proper-lockfile lstats the
   * target, and an empty file is a valid empty log.
   */
  const withLogLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      await appendFile(path, '', 'utf8');
    } catch {
      // Materialization is best-effort: a failure here (e.g. missing
      // directory) surfaces from the lock attempt below with the path.
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(path, {
        stale: 10_000,
        retries: { retries: 5, minTimeout: 25, maxTimeout: 200 },
      });
    } catch (err) {
      throw new Error(
        `fileDispatchLog: could not acquire the dispatch log lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing an unserialized check-post-record; clear the stale lock and re-run`,
        { cause: err },
      );
    }
    if (release === undefined) {
      throw new Error(
        `fileDispatchLog: could not acquire the dispatch log lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing an unserialized check-post-record; clear the stale lock and re-run`,
      );
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  return { load, record, withLogLock };
}
