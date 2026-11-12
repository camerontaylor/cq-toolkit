// fileDispatchLog — the crash-safe dispatch memory (the store adapter's
// dispatch log; extracted from ops/review/replyAndResolve.ts by Phase 1.4 —
// the responder op keeps the action vocabulary and OWNS the dispatch
// CONTRACT types (DispatchRecord, DispatchLog), imported from there
// adapters → ops (ADR-0005:27, PR #335 review, Codex P1); this module is
// their file-backed persistence and cross-process lock).
import { appendFile, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { lock } from 'proper-lockfile';
import { DISPATCH_RECORD_VERSION } from '../../ops/review/replyAndResolve.js';
import type { DispatchLog, DispatchRecord } from '../../ops/review/replyAndResolve.js';

/** The action kinds a dispatch record may carry (the ReviewAction union). */
const RECORD_KINDS: ReadonlySet<string> = new Set([
  'review_reply',
  'issue_comment',
  'resolve_thread',
]);

/**
 * Describe the first shape fault in a candidate record, or null when the
 * shape is one this reader may dispatch past. Extra keys are tolerated:
 * the version field (not key strictness) is the forward-compat mechanism,
 * so a v1 line carrying an unfamiliar extra key still loads while a line
 * missing or mistyping a REQUIRED field never does.
 */
function recordShapeFault(value: Record<string, unknown>): string | null {
  const actionId: unknown = value.actionId;
  if (typeof actionId !== 'string' || actionId.length === 0) {
    return `actionId must be a non-empty string (the dedupe key) — got ${JSON.stringify(actionId)}`;
  }
  const kind: unknown = value.kind;
  if (typeof kind !== 'string' || !RECORD_KINDS.has(kind)) {
    return `kind must be "review_reply", "issue_comment" or "resolve_thread" — got ${JSON.stringify(kind)}`;
  }
  const resultRef: unknown = value.resultRef;
  if (typeof resultRef !== 'string') {
    return `resultRef must be a string — got ${JSON.stringify(resultRef)}`;
  }
  const at: unknown = value.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return `at must be a finite number — got ${JSON.stringify(at)}`;
  }
  return null;
}

/**
 * Validate one parsed line (ADR-0005 decision 10 + issue #1199): an ABSENT
 * version is a legacy v1 line and reads as v1, `version: 1` is accepted,
 * and any other value is refused fail-closed. A non-object line is refused
 * too — and so is an object whose REQUIRED fields are missing or mistyped
 * (a renamed `actionId`, a stray record of another shape): without the
 * dedupe key the action would silently re-dispatch (a repost), so a
 * well-formed-JSON line that is not a record throws exactly like a corrupt
 * mid-file line does. A non-object line can never be a dispatch record.
 */
function parseDispatchLine(value: unknown, path: string, where: string): DispatchRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `fileDispatchLog: dispatch log at ${JSON.stringify(path)} ${where} is not a record object — refusing to dispatch on top of an unreadable log; fix or remove the file and re-run`,
    );
  }
  const version = (value as { version?: unknown }).version;
  if (version !== undefined && version !== DISPATCH_RECORD_VERSION) {
    throw new Error(
      `fileDispatchLog: dispatch log at ${JSON.stringify(path)} ${where} has unsupported record version ${JSON.stringify(version)} — this reader accepts ${DISPATCH_RECORD_VERSION} or a legacy record with no version; refusing to dispatch on top of an unreadable log; fix or remove the file and re-run`,
    );
  }
  const fault = recordShapeFault(value as Record<string, unknown>);
  if (fault !== null) {
    throw new Error(
      `fileDispatchLog: dispatch log at ${JSON.stringify(path)} ${where} has a malformed record (${fault}) — refusing to dispatch on top of an unreadable log; fix or remove the file and re-run`,
    );
  }
  // Return the normalized record: legacy v1 gains its explicit version.
  return { ...(value as Omit<DispatchRecord, 'version'>), version: DISPATCH_RECORD_VERSION };
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
 *
 * VERSION (ADR-0005 decision 10): every new line carries `version: 1`; a
 * line without one is a legacy v1 record (old logs exist in runner caches)
 * and reads as v1, while any other version is refused fail-closed — a
 * format this reader cannot truthfully interpret is never dispatched past.
 * SHAPE (issue #1199): every parsed line must also carry the required
 * record fields (`actionId`, `kind`, `resultRef`, `at`) with their
 * producer shapes — a renamed field or a stray record of another shape
 * throws naming the line, so a missing dedupe key can never silently
 * re-dispatch (a repost). Extra keys are tolerated; `record()` applies the
 * same shape rule before appending, so the writer cannot poison its own log.
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
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
      // A line that PARSES is not a truncated tail, whatever its position:
      // an unsupported version or a non-record value is refused loudly.
      records.push(parseDispatchLine(parsed, path, `line ${i + 1}`));
    }
    return records;
  };
  const record = async (entry: DispatchRecord): Promise<void> => {
    // The writer writes version 1 only (ADR-0005 decision 10): a caller that
    // hands over any other version gets a refusal, never a mixed-format log.
    if (entry.version !== DISPATCH_RECORD_VERSION) {
      throw new Error(
        `fileDispatchLog: refusing to record a dispatch with version ${JSON.stringify(entry.version)} — this writer writes ${DISPATCH_RECORD_VERSION} only`,
      );
    }
    // The writer never self-poisons the log: a malformed entry is refused
    // here rather than appended into a line the next load() must throw on.
    const fault = recordShapeFault(entry as unknown as Record<string, unknown>);
    if (fault !== null) {
      throw new Error(
        `fileDispatchLog: refusing to record a malformed dispatch record (${fault}) — nothing was appended; fix the caller and re-run`,
      );
    }
    // A discarded partial tail is truncated before the retry appends, so a
    // crash mid-append can never poison the next record — BUT not every
    // unterminated tail is garbage: a crash AFTER the record's closing '}'
    // but BEFORE its '\n' left a VALID record that load() already parses
    // and counts dispatched. The repair therefore mirrors load() exactly:
    // an unterminated tail that parses as JSON is KEPT (only its '\n'
    // boundary is added — truncating it would discard a landed dispatch
    // and cause a repost), while a tail that does not parse is truncated.
    // A tail that parses but the reader would REFUSE (wrong version, not a
    // record object) is never silently accepted as a boundary either.
    // Either way the new record lands on a clean newline boundary.
    let handle: FileHandle | null = null;
    let boundaryNeeded = false;
    try {
      handle = await open(path, 'r+');
      const bytes = await handle.readFile();
      const keep = bytes.lastIndexOf(0x0a) + 1; // through the last COMPLETE line
      if (keep < bytes.length) {
        const tail = bytes.subarray(keep).toString('utf8');
        let parsedTail: unknown;
        try {
          parsedTail = JSON.parse(tail);
        } catch {
          await handle.truncate(keep); // junk tail: cut it
        }
        if (parsedTail !== undefined) {
          // The tail IS a complete record — keep it byte-for-byte; only
          // the newline boundary is missing.
          parseDispatchLine(parsedTail, path, 'unterminated tail');
          boundaryNeeded = true;
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
