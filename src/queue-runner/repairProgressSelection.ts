/**
 * Initial result/progress selection of `crq_repair.process`
 * (apps/crq-python/crq_repair.py:486-508): which `result` a repair job starts
 * from, taken from the job directory's `result.json` and `progress.json`.
 *
 * DECISION ONLY. Nothing here creates a directory, writes, locks, spawns or
 * reaches a provider. Every fact is an injected read
 * ({@link RepairProgressSelectionReads}), asked in Python's order and lazily.
 * Inactive: nothing imports this outside tests. Everything after the selection
 * stays unported and caller-owned: the `mkdir(parents=True, exist_ok=True)` that
 * precedes the first probe (its `OSError` surfaces before any read below), the
 * worktree selection (`resume_worktree`, the missing-pending-worktree and
 * interrupted-dispatch failures, which also `.get` the selected value and so
 * raise `AttributeError` for a non-object progress file), `job.json`, the rung
 * loop, the judge and every save (docs/crq/tick-slot-missing-effects.md).
 *
 * Python's order, mirrored one read per line:
 *
 * 1. `repair = config['repair']`, then `job['job']` (both `KeyError` when absent);
 * 2. `result_path.exists()`; when present `json.loads(read_text())`, and a prior
 *    with no truthy `retry_after` is returned as is. A truthy `retry_after` is
 *    kept only while it is still in the future AND `repair` configures no
 *    `fallback_models`; the stamp is `datetime.fromisoformat(s.replace('Z',
 *    '+00:00'))`, compared with an aware `now`, so a naive stamp is a `TypeError`
 *    and a malformed one a `ValueError`. With fallbacks configured the deferral
 *    is always retried and the stamp is never parsed, so a malformed one is inert;
 * 3. `repair['roles']`, then the default `FAILED` result built from the job
 *    (`job['job']`, `item`, `repair_base`, `source_sha`, `finding_sha256`, then
 *    `origin_job` via `.get`) and `utc()`;
 * 4. a SECOND `result_path.exists()` and read: Python re-reads, so a file that
 *    changed in between is honoured, and the new value loses its `retry_after`
 *    via `.pop('retry_after', None)` (a non-dict is `TypeError` for a list,
 *    `AttributeError` otherwise);
 * 5. `progress_path.exists() and (not result_path.exists() or
 *    progress.stat().st_mtime_ns > result.stat().st_mtime_ns)`: progress wins
 *    only when it is strictly newer in integer nanoseconds (a tie keeps the
 *    result), or when there is no result at all. A third and fourth existence
 *    probe and the two stats are separate reads; a stat failure propagates;
 * 6. a winning progress file is `json.loads`ed and replaces the result.
 *
 * Errno policy is the caller's: `resultExists`/`progressExists` stand for
 * `Path.exists()`, which answers false for every stat error (CPython 3.14), and
 * the read and stat effects raise `PyError('OSError')` / `PyError('ValueError')`
 * for failed reads and failed decodes. This module classifies no errno and
 * swallows nothing, so it neither widens nor narrows what Python raises.
 *
 * Failures Python lets escape propagate as `PyError`s of the same class, with
 * the 3.14 message text where Python builds one from the value.
 *
 * Known limitation (representation unchanged): results are plain objects, which
 * list integer-like keys (`"1"`, `"2"`) ascending ahead of all others, while a
 * Python dict keeps insertion order. Every key the repair result and progress
 * files use (`job`, `attempts`, `rung`, ...) is non-integer, and the tests pin
 * their order; a file with integer-like keys would only differ in key order.
 */
import { parseUtcDetailed, UtcParseError, utcHasOffset } from '../policy/crq/utc.js';
import { JsonNumber } from '../policy/crq/jsonValue.js';
import { PyError } from './pyErrors.js';

type Rec = Record<string, unknown>;

/** Where the selected `result` came from. */
export type RepairResultSource =
  /** The default `FAILED` result built from the job. */
  | 'fresh'
  /** `result.json`, with `retry_after` removed. */
  | 'result'
  /** `progress.json`, newer than (or without) a result. */
  | 'progress';

export type RepairProgressSelection =
  /** `return prior`: the existing result is final (or still deferred). */
  | { readonly kind: 'preserved'; readonly result: unknown }
  /** `result` is what the rest of `process` continues from. */
  | { readonly kind: 'selected'; readonly source: RepairResultSource; readonly result: unknown };

/**
 * Read-only questions answered by the caller, scoped to one job directory.
 * Values are parsed JSON as Python's `json.loads` yields them; supply
 * `toPlainJsonRetainingNumbers` output so the int/float kind of a malformed
 * value reaches an error message.
 */
export interface RepairProgressSelectionReads {
  /** `result_path.exists()`. */
  resultExists(): Promise<boolean>;
  /** `json.loads(result_path.read_text())`: `OSError` unreadable, `ValueError` undecodable. */
  readResult(): Promise<unknown>;
  /** `progress_path.exists()`. */
  progressExists(): Promise<boolean>;
  /** `result_path.stat().st_mtime_ns`. */
  resultMtimeNs(): Promise<bigint>;
  /** `progress_path.stat().st_mtime_ns`. */
  progressMtimeNs(): Promise<bigint>;
  /** `json.loads(progress_path.read_text())`: `OSError` unreadable, `ValueError` undecodable. */
  readProgress(): Promise<unknown>;
  /** `datetime.now(timezone.utc)` as microseconds since the epoch; read only when compared. */
  nowMicros(): bigint;
  /** `utc()`: the `%Y-%m-%dT%H:%M:%SZ` stamp of the default result's `started_at`. */
  utc(): string;
}

export interface RepairProgressSelectionRequest {
  /** The loaded crq config; only `config['repair']` is read. */
  readonly config: unknown;
  /** `json.loads` of the job's inbox file. */
  readonly job: unknown;
  /** `str(wt)`: the worktree the default result records. */
  readonly worktree: string;
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  return Array.isArray(value) ? 'list' : 'dict';
}

const isDict = (value: unknown): value is Rec =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof JsonNumber);

/** Python `bool(value)` over parsed JSON. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value as Rec).length > 0;
}

/** `value.get(key)`: absent is `None`, and a non-dict receiver is `AttributeError`. */
function get(value: unknown, key: string): unknown {
  if (!isDict(value)) {
    throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : null;
}

/** `value[key]` for a string key: `KeyError` when absent, `TypeError` on a non-dict. */
function subscript(value: unknown, key: string): unknown {
  if (isDict(value)) {
    if (!Object.hasOwn(value, key)) throw new PyError('KeyError', pyStrRepr(key));
    return value[key];
  }
  if (Array.isArray(value)) {
    throw new PyError('TypeError', 'list indices must be integers or slices, not str');
  }
  if (typeof value === 'string') {
    throw new PyError('TypeError', "string indices must be integers, not 'str'");
  }
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not subscriptable`);
}

/**
 * What Python's `str.isprintable` rejects: the "Other" and "Separator" categories
 * except ASCII space (CPython `Py_UNICODE_ISPRINTABLE`). Category `Cn` follows the
 * runtime's Unicode tables, so a code point assigned after the Python minor's tables
 * (3.14 ships Unicode 16) can differ; every assigned code point agrees.
 */
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/**
 * Python `repr(str)`: single quotes unless the text holds one and no double quote;
 * `\\`, the quote, `\n`, `\r`, `\t` escaped; other non-printable code points as
 * `\xNN`, `\uNNNN` or `\UNNNNNNNN`; printable Unicode kept as is.
 */
function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char !== ' ' && NOT_PRINTABLE.test(char)) {
      const hex = code.toString(16);
      if (code < 0x100) out += `\\x${hex.padStart(2, '0')}`;
      else if (code < 0x10000) out += `\\u${hex.padStart(4, '0')}`;
      else out += `\\U${hex.padStart(8, '0')}`;
    } else out += char;
  }
  return out + quote;
}

/**
 * `datetime.fromisoformat(stamp.replace('Z', '+00:00')) > datetime.now(utc)`.
 * The caller has already established the stamp is truthy.
 */
function retryStillPending(stamp: unknown, reads: RepairProgressSelectionReads): boolean {
  if (typeof stamp !== 'string') {
    throw new PyError('AttributeError', `'${pyTypeName(stamp)}' object has no attribute 'replace'`);
  }
  const replaced = stamp.replaceAll('Z', '+00:00');
  let parsed: bigint | null;
  try {
    parsed = parseUtcDetailed(stamp);
  } catch (e) {
    if (e instanceof UtcParseError) throw new PyError('ValueError', e.message);
    throw e;
  }
  if (parsed === null) {
    throw new PyError('ValueError', `Invalid isoformat string: ${pyStrRepr(replaced)}`);
  }
  const now = reads.nowMicros();
  // `fromisoformat` of a stamp without an offset is naive; comparing it with an
  // aware `now` raises instead of assuming UTC.
  if (!utcHasOffset(stamp)) {
    throw new PyError('TypeError', "can't compare offset-naive and offset-aware datetimes");
  }
  return parsed > now;
}

/** `result.pop('retry_after', None)`; the input is never mutated. */
function withoutRetryAfter(result: unknown): unknown {
  if (isDict(result)) {
    if (!Object.hasOwn(result, 'retry_after')) return result;
    return Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'retry_after'));
  }
  if (Array.isArray(result)) {
    throw new PyError('TypeError', 'pop expected at most 1 argument, got 2');
  }
  throw new PyError('AttributeError', `'${pyTypeName(result)}' object has no attribute 'pop'`);
}

/**
 * Decide which result `process(config, job, wt)` continues from, or whether it
 * returns the prior result outright. Every probe is read-only and lazy; the
 * order matches Python's.
 */
export async function selectRepairProgress(
  request: RepairProgressSelectionRequest,
  reads: RepairProgressSelectionReads,
): Promise<RepairProgressSelection> {
  const { config, job, worktree } = request;
  const repair = subscript(config, 'repair');
  subscript(job, 'job');

  if (await reads.resultExists()) {
    const prior = await reads.readResult();
    const retryAfter = get(prior, 'retry_after');
    if (
      !truthy(retryAfter) ||
      (!truthy(get(repair, 'fallback_models')) && retryStillPending(retryAfter, reads))
    ) {
      return { kind: 'preserved', result: prior };
    }
  }

  subscript(repair, 'roles');
  let result: unknown = {
    job: subscript(job, 'job'),
    item: subscript(job, 'item'),
    repair_base: subscript(job, 'repair_base'),
    source_sha: subscript(job, 'source_sha'),
    finding_sha256: subscript(job, 'finding_sha256'),
    origin_job: get(job, 'origin_job'),
    verdict: 'FAILED',
    reason: '',
    commits: [],
    attempts: [],
    judge: null,
    worktree,
    started_at: reads.utc(),
  };
  let source: RepairResultSource = 'fresh';
  if (await reads.resultExists()) {
    result = withoutRetryAfter(await reads.readResult());
    source = 'result';
  }

  if (await reads.progressExists()) {
    const resume =
      !(await reads.resultExists()) ||
      (await reads.progressMtimeNs()) > (await reads.resultMtimeNs());
    if (resume) {
      result = await reads.readProgress();
      source = 'progress';
    }
  }
  return { kind: 'selected', source, result };
}
