/**
 * The `status_summary.publish` composer: the core document, the previous-
 * summary title cache with `gh` enrichment, the effect sections and the exact
 * compact publish bytes, over injected reads and probes.
 *
 * Python order is observable through those bytes and is preserved here:
 *
 * 1. `summarize` runs first; a falsy `last_tick` refuses with
 *    `ValueError("no completed tick to publish")` before any read of the
 *    previous summary.
 * 2. The previous summary is read once for the title cache. The read maps
 *    `(repo, pr) -> title` for its `pending_items` rows; `OSError`,
 *    `ValueError` (JSON decode), `KeyError` and `TypeError` are caught and
 *    void the cache (`titles = {}`), exactly like the producer's except
 *    clause. An `AttributeError` (a list or scalar document) is not caught
 *    and escapes, as probed against the producer.
 * 3. Each pending row is enriched in place: a falsy title falls back to the
 *    cache, then (only for a truthy repo and a positive-int `pr`) to the
 *    `gh` lookup, whose trimmed empty output becomes null. `OSError`,
 *    `RuntimeError` and timeout are swallowed per row.
 * 4. `schema_version` then `generated_at` are appended (`data.update`),
 *    followed by the effect sections in publish order: `systemd_timers`,
 *    `systemd_services`, `repair`, `finding_triage`, `utilization`,
 *    `schedule`.
 *
 * The caller supplies the core document from `readSummaryCore` (`{value}`),
 * the exact queue the core was read from, and every process seam as injected
 * values: the previous-summary bytes (or null when absent), the repair inbox
 * state, the sorted triage rows, the systemd probe result with its
 * realtime/monotonic clock pair, the `gh` lookup and the receipt reader.
 *
 * This module never touches a file, the environment, a clock or a process.
 *
 * Serialisation is `pythonJsonText` with
 * the compact separators and one trailing newline (the atomic writer's
 * exact bytes); never `JSON.stringify`.
 */
import { JsonNumber } from './jsonValue.js';
import {
  PublishEffectsError,
  findingTriage,
  repairDigest,
  systemdActivity,
  type RepairInboxState,
  type SystemdProbe,
  type TriageRowFile,
} from './publishEffects.js';
import { pythonJsonText, type PythonJsonOptions } from './pythonJson.js';
import type { CrqRecord } from './receiptIdentity.js';
import { mergedCurrent, type ReceiptReader } from './statusSummary.js';
import { SummarySectionsError, assembleSummarySections } from './summarySections.js';

/** Python exception classes the publish composer can surface. */
export type SummaryPublishPythonError = PublishEffectsError['pythonError'];

/** A refusal with the Python exception class the oracle would raise. */
export class SummaryPublishError extends Error {
  override readonly name: string = 'SummaryPublishError';
  readonly pythonError: SummaryPublishPythonError;

  constructor(message: string, pythonError: SummaryPublishPythonError) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** The injected process seams, mirroring `status_summary.publish`'s inputs. */
export interface SummaryPublishEffects {
  /** The state root: `state/events.jsonl`, `state/repair/`, triage rows. */
  readonly root: string;
  /** The XDG state home (`XDG_STATE_HOME`, or `~/.local/state`). */
  readonly xdgStateHome: string;
  /** The one clock reading for the whole invocation, epoch seconds. */
  readonly now: number;
  /** Previous `crq/summary.json` bytes, or null when the file is absent. */
  readonly previousBytes: Uint8Array | null;
  /** The repair inbox state (`repair_tick.digest`'s seam). */
  readonly inbox: RepairInboxState;
  /** The sorted `triage/*.json` rows (`finding_triage`'s seam). */
  readonly triageRows: readonly TriageRowFile[];
  /** The `systemctl --user show` probe result (or its failure). */
  readonly systemd: SystemdProbe;
  /** The realtime/monotonic clock pair captured with the probe output. */
  readonly systemdClock: { readonly realtime: number; readonly monotonic: number };
  /**
   * `gh api repos/<repo>/pulls/<pr> --jq .title`, already executed; return
   * the exact stdout, or null when the process failed (OSError/RuntimeError/
   * timeout), which the producer swallows per row.
   */
  readonly ghTitle: (repo: string, pr: number) => string | null;
  /** Retained receipt bytes by id for the receipt-aware `merged_current`. */
  readonly readReceipt: ReceiptReader;
}

/** The published document plus the exact bytes the atomic writer writes. */
export interface SummaryPublishResult {
  /** The document, plain (no views), in Python insertion order. */
  readonly value: Record<string, unknown>;
  /** `pythonJsonText(value, compact) + "\n"`: the writer's exact bytes. */
  readonly bytes: Uint8Array;
  /** The compact text (the bytes decoded). */
  readonly text: string;
}

const COMPACT_NEWLINE: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
  trailingNewline: true,
};

/**
 * `status_summary.publish` up to (not including) the filesystem write.
 *
 * Raises {@link SummaryPublishError} with the Python exception class and
 * message on every refusal the producer would raise for the same inputs.
 */
export function publishSummary(
  core: Record<string, unknown>,
  queue: CrqRecord,
  config: Record<string, unknown>,
  scheduleProbe: unknown,
  effects: SummaryPublishEffects,
): SummaryPublishResult {
  const lastTick = core['last_tick'];
  if (!pyTruthy(lastTick)) {
    throw new SummaryPublishError('no completed tick to publish', 'ValueError');
  }

  // Python reads the previous summary once, inside the cache try-block. The
  // producer's except clause covers OSError/ValueError/KeyError/TypeError but
  // not AttributeError, so a non-dict previous document escapes (probed).
  const titles = titleCache(effects.previousBytes);

  const pendingItems = core['pending_items'];
  if (!Array.isArray(pendingItems)) {
    throw new SummaryPublishError(
      subscriptMessage(pendingItems),
      pendingItems === null || pendingItems === undefined ? 'TypeError' : 'TypeError',
    );
  }
  for (const item of pendingItems) {
    if (!isRecord(item)) {
      throw new SummaryPublishError(
        item === null || item === undefined
          ? `'NoneType' object is not subscriptable`
          : Array.isArray(item)
            ? 'list indices must be integers or slices, not str'
            : `'${pythonTypeName(item)}' object is not subscriptable`,
        'TypeError',
      );
    }
    const repo = item['repo'];
    const pr = item['pr'];
    if (!pyTruthy(item['title'])) {
      const cached = cacheLookup(titles, repo, pr);
      if (cached !== undefined) {
        item['title'] = cached;
      }
    }
    const ghPr = ghIntegerPr(pr);
    if (!pyTruthy(item['title']) && pyTruthy(repo) && ghPr !== null) {
      // `type(pr) is int`: JSON integers only (a lossless JsonNumber int is
      // still Python's int; a float lexeme never qualifies). The gh seam
      // returns null for a failed process; the producer swallows those.
      const stdout = effects.ghTitle(repo as string, ghPr);
      const title = stdout === null ? null : stdout.trim();
      item['title'] = title === '' ? null : title;
    }
  }

  // `data.update(schema_version=2, generated_at=generated)` keeps the core's
  // key order and appends these two last, before the effect sections.
  const value: Record<string, unknown> = { ...core };
  value['schema_version'] = 2;
  value['generated_at'] = core['generated_at'];

  const activity = systemdActivity(effects.systemd, effects.systemdClock);
  // Publish order: `systemd_timers`, then `systemd_services`.
  value['systemd_timers'] = activity.timers;
  value['systemd_services'] = activity.services;

  try {
    value['merged_current'] = mergedCurrent(queue, effects.readReceipt);
  } catch (error) {
    throw wrapPublish(error);
  }

  value['repair'] = repairDigest(queue, effects.inbox, effects.now);
  value['finding_triage'] = findingTriage(effects.triageRows);
  // Python evaluates the utilization arguments (queue coverage first, then
  // the cap) and then the schedule dict, in that order. Only `utilization`
  // comes from the section assembler; the schedule literal is composed here
  // so an unknown probe appends `error` before `schedule` serialises.
  let schedule: Record<string, unknown>;
  try {
    const coverage = queue['coverage'];
    const ledger = pyTruthy(coverage)
      ? coverage
      : { schema_version: 1, paths: {}, runs: {}, observations: {} };
    const startsCap = core['starts_cap'];
    const sections = assembleSections(queue, ledger, effects.now, startsCap);
    value['utilization'] = sections.utilization;
  } catch (error) {
    throw wrapPublish(error);
  }
  const probeStatus = isRecord(scheduleProbe) ? scheduleProbe['status'] : null;
  schedule = {
    id:
      config['schedule_id'] === undefined || config['schedule_id'] === null
        ? 'crq-tick.timer'
        : config['schedule_id'],
    state: pyTruthy(probeStatus) ? probeStatus : 'systemd',
  };
  if (schedule['state'] === 'unknown') {
    schedule['error'] = 'schedule probe unavailable';
  }
  value['schedule'] = schedule;

  const text = pythonJsonText(value, COMPACT_NEWLINE);
  return { value, bytes: new TextEncoder().encode(text), text };
}

function assembleSections(
  queue: CrqRecord,
  ledger: unknown,
  now: number,
  startsCap: unknown,
): Pick<ReturnType<typeof assembleSummarySections>, 'utilization'> {
  return assembleSummarySections({
    core: { last_tick: 'published', starts_cap: startsCap },
    queue,
    config: {},
    schedule: {},
    now,
  });
}

/**
 * The exact target path `status_summary.publish` writes: `<XDG_STATE_HOME or
 * ~/.local/state>/crq/summary.json`. Exported so the adapter and tests share
 * one source of truth for the path policy.
 */
export function summaryTargetPath(xdgStateHome: string, home: string): string {
  const base = xdgStateHome === '' ? `${home}/.local/state` : xdgStateHome;
  return `${base}/crq/summary.json`;
}

/** `(repo, pr) -> title` over the previous summary, the producer's cache. */
function titleCache(previousBytes: Uint8Array | null): Map<string, Map<CacheKey, unknown>> {
  const cache = new Map<string, Map<CacheKey, unknown>>();
  if (previousBytes === null) return cache;
  let document: unknown;
  try {
    document = parsePlainPrevious(previousBytes);
  } catch (error) {
    // OSError (unreadable/absent) and ValueError (json decode) void the cache.
    if (isPublishRefusal(error)) {
      const refusal = error as SummaryPublishError;
      if (refusal.pythonError === 'OSError' || refusal.pythonError === 'ValueError') return cache;
    }
    throw error;
  }
  if (!isRecord(document)) {
    // AttributeError escapes the producer's except clause (probed: a list or
    // scalar previous summary crashes publish).
    throw new SummaryPublishError(
      `'${pythonTypeName(document)}' object has no attribute 'get'`,
      'AttributeError',
    );
  }
  const rows = document['pending_items'];
  if (rows === undefined || rows === null) return cache;
  if (!Array.isArray(rows)) {
    // `for i in <non-list>`: NoneType/str/int iterate element-wise and the
    // row subscripts then fail with TypeError -> caught, cache voided.
    return cache;
  }
  try {
    for (const row of rows) {
      if (!isRecord(row)) {
        // `i["repo"]` on a str/list element raises TypeError -> voided.
        throw new SummaryPublishError(
          typeof row === 'string'
            ? "string indices must be integers, not 'str'"
            : Array.isArray(row)
              ? 'list indices must be integers or slices, not str'
              : `'${pythonTypeName(row)}' object is not subscriptable`,
          'TypeError',
        );
      }
      if (!('repo' in row) || !('pr' in row)) {
        throw new SummaryPublishError("'repo'", 'KeyError');
      }
      const repo = row['repo'];
      const pr = row['pr'];
      cacheLookupKey(repo, pr);
      cache.set(
        cacheBucket(repo),
        cacheBucketMap(cache, repo).set(cacheKey2(pr), row['title'] ?? null),
      );
    }
  } catch (error) {
    if (isPublishRefusal(error) && isCacheVoidClass((error as SummaryPublishError).pythonError)) {
      return new Map();
    }
    throw error;
  }
  return cache;
}

// Python's dict key is the tuple `(repo, pr)` with value equality; the port
// splits it into a repo bucket string plus a primitive `pr` string key so
// `Map` equality matches Python's `1 == 1.0 == True` hashing rules.
type CacheKey = string;

function cacheBucket(repo: unknown): string {
  if (repo === null) return 'null';
  if (typeof repo === 'string') return `s:${repo}`;
  if (typeof repo === 'number' || typeof repo === 'boolean') {
    // Python value-hashes across 1/1.0/True, so those share one bucket.
    if (typeof repo === 'number' && Number.isInteger(repo) && repo >= -5 && repo <= 256) {
      return `h:int:${repo}`;
    }
    return `h:${String(repo)}:${typeof repo}`;
  }
  // Unhashable repo keys void the cache at build time (TypeError caught).
  throw new SummaryPublishError(
    Array.isArray(repo) ? "string indices must be integers, not 'str'" : 'unhashable type',
    'TypeError',
  );
}

function cacheBucketMap(
  cache: Map<string, Map<CacheKey, unknown>>,
  repo: unknown,
): Map<CacheKey, unknown> {
  const bucket = cacheBucket(repo);
  let map = cache.get(bucket);
  if (map === undefined) {
    map = new Map();
    cache.set(bucket, map);
  }
  return map;
}

function cacheKey2(pr: unknown): CacheKey {
  // Python's tuple key hashes `pr` by value: `True == 1` and `1 == 1.0` share
  // one slot and strings are their own key, so the port maps every hashable
  // `pr` onto one primitive-string key space with those collapses. A
  // lossless JsonNumber keeps its exact integer value (the real route reads
  // queue subtrees with numbers retained), and hashes by that value so
  // `JsonNumber.int(7)` and the parsed-from-previous `7` share one slot.
  if (pr === null || pr === undefined) return 'p:null';
  if (typeof pr === 'boolean') return `p:${pr ? 1 : 0}`;
  if (typeof pr === 'number') return `p:${String(pr)}`;
  if (typeof pr === 'string') return `s:${pr}`;
  if (pr instanceof JsonNumber) {
    return pr.kind === 'int' ? `p:${(pr.integer as bigint).toString()}` : `p:${String(pr.float)}`;
  }
  // Unhashable pr voids the cache at build time (TypeError caught).
  throw new SummaryPublishError('unhashable type', 'TypeError');
}

function cacheLookupKey(repo: unknown, pr: unknown): void {
  cacheBucket(repo);
  cacheKey2(pr);
}

/** `type(pr) is int and pr > 0`: a plain JSON integer or a lossless int
 * JsonNumber; floats, bools and everything else return null (no gh lookup). */
function ghIntegerPr(pr: unknown): number | null {
  if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) return pr;
  if (pr instanceof JsonNumber && pr.kind === 'int') {
    const value = pr.integer as bigint;
    if (value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  }
  return null;
}

function cacheLookup(
  titles: Map<string, Map<CacheKey, unknown>>,
  repo: unknown,
  pr: unknown,
): unknown {
  if (titles.size === 0) return undefined;
  const bucket = titles.get(cacheBucket(repo));
  if (bucket === undefined) return undefined;
  return bucket.get(cacheKey2(pr));
}

function isCacheVoidClass(pythonError: string): boolean {
  return pythonError === 'TypeError' || pythonError === 'KeyError';
}

function isPublishRefusal(error: unknown): boolean {
  return error instanceof SummaryPublishError || error instanceof PublishEffectsError;
}

function wrapPublish(error: unknown): SummaryPublishError {
  if (error instanceof SummarySectionsError) {
    return new SummaryPublishError(error.message, error.pythonError as SummaryPublishPythonError);
  }
  if (error instanceof PublishEffectsError) {
    return new SummaryPublishError(error.message, error.pythonError);
  }
  return error as SummaryPublishError;
}

function parsePlainPrevious(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    // Python `Path.read_text()` on invalid UTF-8 raises UnicodeDecodeError,
    // a ValueError subclass: caught, cache voided.
    throw new SummaryPublishError(
      error instanceof Error ? error.message : String(error),
      'ValueError',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SummaryPublishError(
      error instanceof Error ? error.message : String(error),
      'ValueError',
    );
  }
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? (value.integer as bigint) !== 0n : (value.float as number) !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

function subscriptMessage(value: unknown): string {
  if (value === null || value === undefined) return `'NoneType' object is not subscriptable`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `'${pythonTypeName(value)}' object is not subscriptable`;
  }
  if (Array.isArray(value)) return 'list indices must be integers or slices, not str';
  if (typeof value === 'string') return "string indices must be integers, not 'str'";
  return `'${pythonTypeName(value)}' object is not subscriptable`;
}
