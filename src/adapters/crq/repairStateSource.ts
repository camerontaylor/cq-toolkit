/**
 * Offline file-state bindings for the repair drain (`crq_repair.py`): worker
 * limit, inbox order and job reads, the queue read, the backlog read, the
 * `result.json` pending/unreadable classification and the stale-result write.
 *
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the drain orchestration. {@link RepairStateEffects}
 * is the structural shape such an orchestration binds. No git, no network, no
 * provider call and no process spawn happen here; every path is derived from
 * the injected `stateRoot` (Python's `ROOT / 'state'`).
 *
 * What is reused rather than re-derived:
 * - {@link drainOrder} (`bounded.drain_order`) filters and sorts the inbox
 *   entries this module observes;
 * - {@link atomicWrite} (the fsync + rename discipline of `crq_repair.atomic`)
 *   with {@link atomicJsonText} (its `json.dump(indent=2)` + newline bytes);
 * - {@link parseJsonValue} (Python `json.loads`: last duplicate wins, ints and
 *   floats stay distinct), so a stale record carries the job's own numbers.
 *
 * `loadQueueDocument` is deliberately NOT used for the queue read: it refuses a
 * queue needing Python's admission-history compaction and rejects duplicate
 * keys, neither of which `crq_repair.drain` does. The drain reads
 * `json.loads(queue_path.read_text())` and treats only OSError/ValueError as
 * "queue unreadable".
 *
 * Failure honesty, matching Python 3.14 (the production minor):
 * - `Path.exists()` is `os.path.exists`: any failure to `stat` (ENOENT,
 *   EACCES on the parent, ENOTDIR, ...) reads as "missing".
 * - `Path.glob` swallows a scandir `OSError`, so an unlistable inbox is empty.
 * - `pending` raises where Python raises (an unreadable result, or one whose
 *   top level is not an object); `unreadableResult` is the classifier that
 *   turns those same failures into `true`.
 */
import { lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import { pythonTruthy } from '../../policy/crq/repairBinding.js';
import { drainOrder, type RepairInboxEntry } from '../../policy/crq/repairSelection.js';
import { atomicWrite } from './atomic.js';
import { checkRepairJobId } from './repairPreparation.js';

/** Python's `str(exc)[:300]` bound on a surfaced read failure. */
const MAX_REASON = 300;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** An `OSError`/`ValueError` reading `state/queue.json`; anything else propagates. */
export class RepairQueueUnreadableError extends Error {
  override readonly name = 'RepairQueueUnreadableError';
}

/** A `result.json` that exists but cannot be read as a JSON object (Python raises). */
export class RepairResultUnreadableError extends Error {
  override readonly name = 'RepairResultUnreadableError';
}

/** The file-state seams the drain consumes, bound to one `state/` root. */
export interface RepairStateEffects {
  /** `drain_order(ROOT)`: inbox job ids, oldest file first. */
  inboxOrder(): Promise<readonly string[]>;
  /** The job file's `item` value; `undefined` when unreadable or not an object. */
  inboxItem(jobId: string): Promise<JsonValue | undefined>;
  /** `state/queue.json`, or `{items: []}` when absent. Throws {@link RepairQueueUnreadableError}. */
  readQueue(): Promise<JsonValue>;
  /** `state/repair/fix-pr-backlog.json`; `undefined` when missing or unreadable. */
  readBacklog(): Promise<JsonValue | undefined>;
  /** `unreadable_result`: a `result.json` exists but cannot be classified. */
  unreadableResult(jobId: string): Promise<boolean>;
  /** `pending`: true unless the job has a terminal, non-deferred result. */
  pending(jobId: string): Promise<boolean>;
  /** `mark_stale`: the terminal, spend-free STALE result the tick harvests. */
  markStale(job: JsonObject, reason: string): Promise<void>;
}

export interface RepairStateSourceOptions {
  /** `ROOT / 'state'`. */
  readonly stateRoot: string;
  /** `crq_repair.utc()` as `%Y-%m-%dT%H:%M:%SZ`; injected so a test controls the stamp. */
  readonly utc?: () => string;
}

/**
 * `crq_repair.worker_limit`: `config['repair'].get('max_concurrent_items', 1)`,
 * which must be a Python `int` (a bool, float, string or null is refused) from 1 to 10.
 * A config with no object-valued `repair` raises where Python raises
 * (`KeyError`/`TypeError`/`AttributeError`).
 */
export function workerLimit(config: JsonValue): number {
  const repair = config instanceof JsonObject ? config.get('repair') : undefined;
  if (!(repair instanceof JsonObject)) {
    throw new TypeError('repair config section is missing or not an object');
  }
  const limit = repair.get('max_concurrent_items');
  if (limit === undefined) return 1;
  if (
    limit instanceof JsonNumber &&
    limit.kind === 'int' &&
    limit.integer !== null &&
    limit.integer >= 1n &&
    limit.integer <= 10n
  ) {
    return Number(limit.integer);
  }
  throw new Error('repair.max_concurrent_items must be an integer from 1 to 10');
}

/** `crq_repair.utc()`: UTC seconds, `Z`-suffixed. */
function defaultUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Python `st_mtime`: `sec + nsec * 1e-9` as one float, so ties fall where Python's do. */
function pythonMtime(mtimeNs: bigint): number {
  const sec = mtimeNs / 1_000_000_000n;
  const nsec = mtimeNs % 1_000_000_000n;
  return Number(sec) + Number(nsec) * 1e-9;
}

/** What `read_text()` + `json.loads` raise as `OSError`/`ValueError`. */
class StateFileUnreadable extends Error {}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/**
 * `json.loads(path.read_text())`: strict UTF-8, no BOM strip, Python parse.
 * Only the failures Python raises as `OSError` or `ValueError` become
 * {@link StateFileUnreadable}; anything else propagates untouched.
 */
async function readJsonValue(path: string): Promise<JsonValue> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isFsError(error)) throw new StateFileUnreadable(`${error.code ?? 'OSError'}: ${path}`);
    throw error;
  }
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    throw new StateFileUnreadable('invalid utf-8');
  }
  try {
    // Python's json.loads accepts NaN/Infinity/-Infinity as floats; the port's default refuses them.
    return parseJsonValue(text, {
      parseConstant: (raw) =>
        JsonNumber.float(raw === 'NaN' ? Number.NaN : raw === 'Infinity' ? Infinity : -Infinity),
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new StateFileUnreadable(error.message);
    throw error;
  }
}

/** `Path.exists()` on 3.14: any `stat` failure is "does not exist". */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function requireJobId(jobId: string): void {
  if (!checkRepairJobId(jobId)) throw new Error('invalid repair job id');
}

const bound = (text: string): string => text.slice(0, MAX_REASON);

export function fileRepairStateEffects(options: RepairStateSourceOptions): RepairStateEffects {
  const { stateRoot } = options;
  const utc = options.utc ?? defaultUtc;
  const inboxDir = join(stateRoot, 'repair', 'inbox');
  const resultPath = (jobId: string): string => {
    requireJobId(jobId);
    return join(stateRoot, 'repair', jobId, 'result.json');
  };

  /** The `result.json` body as `pending`/`unreadable_result` see it; null when absent. */
  async function readResultObject(jobId: string): Promise<JsonObject | null> {
    const path = resultPath(jobId);
    if (!(await pathExists(path))) return null;
    const value = await readJsonValue(path);
    if (!(value instanceof JsonObject)) throw new StateFileUnreadable('result is not an object');
    return value;
  }

  return {
    async inboxOrder() {
      let names: string[];
      try {
        names = await readdir(inboxDir);
      } catch {
        return [];
      }
      const entries: RepairInboxEntry[] = [];
      for (const name of names) {
        // Python stats only entries that already pass the glob and the id grammar.
        if (!name.endsWith('.json') || !checkRepairJobId(name.slice(0, -'.json'.length))) continue;
        const info = await lstat(join(inboxDir, name), { bigint: true });
        entries.push({
          name,
          mtime: pythonMtime(info.mtimeNs),
          symlink: info.isSymbolicLink(),
        });
      }
      return drainOrder(entries);
    },

    async inboxItem(jobId) {
      requireJobId(jobId);
      try {
        const job = await readJsonValue(join(inboxDir, `${jobId}.json`));
        return job instanceof JsonObject ? job.get('item') : undefined;
      } catch (error) {
        if (error instanceof StateFileUnreadable) return undefined;
        throw error;
      }
    },

    async readQueue() {
      const path = join(stateRoot, 'queue.json');
      if (!(await pathExists(path))) return new JsonObject([['items', []]]);
      try {
        return await readJsonValue(path);
      } catch (error) {
        if (error instanceof StateFileUnreadable) {
          throw new RepairQueueUnreadableError(bound(error.message));
        }
        throw error;
      }
    },

    async readBacklog() {
      try {
        return await readJsonValue(join(stateRoot, 'repair', 'fix-pr-backlog.json'));
      } catch (error) {
        if (error instanceof StateFileUnreadable) return undefined;
        throw error;
      }
    },

    async unreadableResult(jobId) {
      try {
        await readResultObject(jobId);
        return false;
      } catch (error) {
        if (error instanceof StateFileUnreadable) return true;
        throw error;
      }
    },

    async pending(jobId) {
      let prior: JsonObject | null;
      try {
        prior = await readResultObject(jobId);
      } catch (error) {
        if (error instanceof StateFileUnreadable) {
          throw new RepairResultUnreadableError(bound(error.message));
        }
        throw error;
      }
      if (prior === null) return true;
      return pythonTruthy(prior.get('retry_after'));
    },

    async markStale(job, reason) {
      const jobId = job.get('job');
      const item = job.get('item');
      if (typeof jobId !== 'string' || item === undefined) {
        // `job['job']` / `job['item']` raise KeyError in Python.
        throw new TypeError('stale job needs string "job" and an "item"');
      }
      const path = resultPath(jobId);
      const field = (name: string): JsonValue => job.get(name) ?? null;
      // Python evaluates started_at before finished_at, each from its own utc() read.
      const record = new JsonObject([
        ['job', jobId],
        ['item', item],
        ['repair_base', field('repair_base')],
        ['source_sha', field('source_sha')],
        ['finding_sha256', field('finding_sha256')],
        ['origin_job', field('origin_job')],
        ['verdict', 'STALE'],
        ['reason', reason],
        ['commits', []],
        ['attempts', []],
        ['judge', null],
        ['started_at', utc()],
        ['finished_at', utc()],
      ]);
      await mkdir(join(stateRoot, 'repair', jobId), { recursive: true });
      await atomicWrite(path, atomicJsonText(record));
    },
  };
}
