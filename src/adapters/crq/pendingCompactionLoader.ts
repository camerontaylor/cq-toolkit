/**
 * The loader half of `crq`'s pending admission-history compaction (`crq.py:267-291`),
 * bound for the offline differential and nothing else. Inactive: nothing imports this from a
 * runtime entry point, it is not composed into the tick and nothing routes to it.
 *
 * Python keeps one module global, `_pending_admission_compaction`, outside the queue document
 * ("checkpoint/transport copies serialize it"). `load_queue(persist_compaction=...)`:
 *
 * 1. stats the queue file first (`queue_identity()`, so a missing file is a `FileNotFoundError`
 *    before any read) and reads it through `admission_history.load`;
 * 2. when that pass compacted the document, OVERWRITES the global with the identity taken in
 *    step 1 (the file as it was before the load), and only then, when `persist_compaction`
 *    is true, calls `save_queue(q)` on the compacted, not-yet-retired queue, which consumes
 *    the identity and logs;
 * 3. a load that did not compact leaves the global alone (a stale identity survives until the
 *    next save clears it), and a failed read raises before any note, so it never records one;
 * 4. runs the retirement pass and returns the queue.
 *
 * TS shape. The queue is an immutable `JsonObject`, so the identity cannot ride on it (Python
 * keeps it off the dict for the same reason). {@link QueueCompaction} is the one tracker, owned
 * by the caller and shared between this loader and `fileRepairSaveQueue`; sharing one instance
 * is exactly Python's "one global per process", and two instances are two processes. The loader
 * hands the identity to the saver through that shared instance, never through the document, and
 * `save` is injected so the persist path runs the real logging save.
 *
 * Deviations, stated plainly:
 * - Read failures are mapped onto the Python class by this wrapper (`ENOENT` is
 *   `FileNotFoundError`, a malformed document `JSONDecodeError`/`ValueError`, a duplicate key
 *   `IntegrityError` (also the top-level duplicate or non-string key), a non-object admission row `AttributeError`). The reader underneath is the
 *   preview loader's, whose finer `summarize` cases (a non-string `quota_state`, which Python
 *   counts when hashable) are not modelled and are not vectored.
 * - Three further class/behaviour deviations, found by probing real `crq.load_queue` and NOT
 *   vectored: a UTF-8 BOM before `{` is a Python `ValueError` but loads here (and records a
 *   pending); a document with admission history but no `items` key is a Python `KeyError`, here
 *   a `ValueError`; an `open` item whose `cycles` is a string loads in Python, here a
 *   `ValueError`. The first lives in the read, the other two in the retire pass.
 * - `EACCES` and other errno failures map to `OSError` via `pyOsError` (the repo-wide
 *   convention), where Python raises the finer `PermissionError`; the class list is approximate.
 * - The `stat` and the read are two operations in both languages; a change between them is
 *   recorded under the pre-read identity in both.
 * - The retirement pass is `backfillQueueLoad.retire`; its own failure classes are mapped the
 *   same way and are not vectored.
 */
import { resolve } from 'node:path';
import { JsonParseError, type JsonObject } from '../../policy/crq/jsonValue.js';
import { PyError, pyOsError } from '../../queue-runner/pyErrors.js';
import { readCompactedQueue, retire } from './backfillQueueLoad.js';
import { queueIdentity, type QueueCompaction } from './repairHarvestForge.js';

export interface PendingCompactionLoaderOptions {
  /** `c.QUEUE`: `<state>/queue.json`. */
  readonly queuePath: string;
  /** The shared per-process tracker; the same instance the saver was built with. */
  readonly compaction: QueueCompaction;
  /** `c.save_queue`: the logging save. Called only for a compacting load with `persist`. */
  readonly save: (queue: JsonObject) => Promise<void>;
}

/** The Python exception class a failed read stands for. */
function pythonError(error: unknown, path: string): unknown {
  if (error instanceof PyError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return pyOsError(error, path);
  if (error instanceof TypeError && /utf-?8|encoded data/i.test(message))
    return new PyError('UnicodeDecodeError', message);
  if (error instanceof JsonParseError)
    return new PyError(
      /duplicate key/.test(message) ? 'IntegrityError' : 'JSONDecodeError',
      message,
    );
  if (error instanceof Error && /^invalid or duplicate queue key$/.test(message))
    return new PyError('IntegrityError', message);
  if (error instanceof Error && /must be an object$/.test(message))
    return new PyError('AttributeError', message);
  if (error instanceof Error) return new PyError('ValueError', message);
  return error;
}

/** `crq.load_queue(persist_compaction=...)` against one queue file. */
export function pendingCompactionLoader(
  options: PendingCompactionLoaderOptions,
): (loadOptions?: { readonly persistCompaction?: boolean }) => Promise<JsonObject> {
  const path = resolve(options.queuePath);
  return async (loadOptions) => {
    let identity;
    let loaded;
    try {
      // `identity = queue_identity()` precedes the read; a missing file stops here.
      identity = await queueIdentity(path);
      loaded = await readCompactedQueue(path);
    } catch (error) {
      throw pythonError(error, path);
    }
    if (loaded.compacted) options.compaction.note(identity);
    if (loaded.compacted && loadOptions?.persistCompaction === true) {
      await options.save(loaded.queue);
    }
    try {
      return retire(loaded.queue);
    } catch (error) {
      throw pythonError(error, path);
    }
  };
}
