/**
 * The remaining `status_summary.publish` effect-section consumers, in
 * TypeScript (migration lane A1).
 *
 * Python's publisher appends four effect sections after the core document:
 * `systemd_timers`/`systemd_services` (`systemd_activity`), `repair`
 * (`repair_tick.digest`), `finding_triage`
 * (`backfill_report.finding_triage(strict=False, limit=32)`) and — already
 * ported — `utilization` and `schedule` (`summarySections.ts`). This module
 * ports the remaining three as pure functions over injected reads and probes;
 * none of them reads a file, the environment, the clock or a process here.
 *
 * The Python producers stay the oracle. Every refusal keeps the Python
 * exception class the oracle would raise, and every mapping keeps Python's
 * insertion order because the publisher serialises the assembled document
 * compactly in that order.
 *
 * Binding gates this module does NOT claim to clear:
 *
 * - `publish()` itself, the previous-summary title cache, the `gh` title
 *   lookup and the atomic XDG write are the composition layer
 *   (`src/ops/crq/summaryPublish.ts`) and stay review-gated before any
 *   production caller is wired.
 * - A real `systemctl`/`gh`/filesystem adapter is a later slice; tests bind
 *   these functions through injected values only.
 */
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerUnicodeDecodeError,
  ledgerLoads,
} from './ledger.js';
import { JsonNumber, JsonObject, JsonValue, parseJsonValue } from './jsonValue.js';
import { compareCodePoints } from './pythonJson.js';

/** Python exception classes these projections can surface. */
export type PublishEffectsPythonError =
  | 'AttributeError'
  | 'IndexError'
  | 'JSONDecodeError'
  | 'KeyError'
  | 'OSError'
  | 'OverflowError'
  | 'TypeError'
  | 'ValueError';

/** A refusal with the Python exception class the oracle would raise. */
export class PublishEffectsError extends Error {
  override readonly name: string = 'PublishEffectsError';
  readonly pythonError: PublishEffectsPythonError;

  constructor(message: string, pythonError: PublishEffectsPythonError) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** One `triage/*.json` row, as `backfill_report.finding_triage` reads it. */
export interface TriageRowFile {
  /** `state/backfill/findings/triage` file name, Python `filename.name`. */
  readonly name: string;
  /** The exact row bytes; absent or unreadable bytes become a row error. */
  readonly bytes: Uint8Array | null;
}

export interface RepairInboxEntry {
  /** Inbox file stem, e.g. `crq-abc-F1`. */
  readonly stem: string;
  /**
   * The `*.json` job document bytes; null when the file is absent. An
   * unreadable file must raise instead, like Python's failed `read_text()`.
   */
  readonly jobBytes: Uint8Array | null;
  /** `path.stat().st_mtime` seconds. */
  readonly mtime: number;
}

export interface RepairInboxState {
  /**
   * Inbox entries Python's `inbox.glob('*.json')` yields, in any order: the
   * digest is order-independent (min mtime, counts), and consumed or
   * undrainable entries are skipped by stem, not by position.
   */
  readonly entries: readonly RepairInboxEntry[];
  /**
   * `state/repair/<stem>/result.json` bytes, or null when the file is absent.
   * Python reads it only when it exists and refuses corrupt bytes
   * (`json.JSONDecodeError` propagates); an unreadable existing file must
   * raise from this callback instead of returning null, so the digest can
   * propagate the read failure exactly like Python's `read_text()`.
   */
  readResult(stem: string): Uint8Array | null;
  /** `state/repair/<stem>/result.json` existence, Python `.exists()`. */
  hasResult(stem: string): boolean;
  /** `state/repair/<stem>/progress.json` existence, Python `.exists()`. */
  hasProgress(stem: string): boolean;
}

/** The injected `systemctl --user show` probe result. */
export interface SystemdProbe {
  /**
   * The exact stdout, already captured; an unavailable probe is modelled as
   * `error` instead (Python's `command` raising OSError/RuntimeError/timeout).
   */
  readonly output?: string;
  /** `systemctl user show unavailable` when the probe itself failed. */
  readonly error?: string;
}

const FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'transient',
  'exhausted',
  'evidence',
  'protected-path',
  'owner-decision',
]);

/** `crq_repair.bounded.JOB_ID`: a drainable inbox job id. */
const JOB_ID = /^crq-[A-Za-z0-9._-]+$/;

const VERDICT_FAILURE_KEYS: ReadonlyMap<string, string> = new Map([
  ['NOT-FIXED', 'not-fixed'],
  ['STALE', 'stale'],
]);

/** `repair_tick.digest`'s zeroed verdict counters, in Python key order. */
function zeroVerdicts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of [
    'fixed@A0',
    'fixed@A1',
    'fixed@A2',
    'not-fixed',
    'stale',
    'judged-valid',
    'judged-invalid',
    'failed',
  ]) {
    counts[key] = 0;
  }
  return counts;
}

/**
 * `repair_tick.digest(root, queue)` minus the filesystem: verdicts from the
 * queue's `repair_runs`, then the repair inbox through the injected state.
 *
 * Raised refusals match the oracle's: a verdict without `attempts` is a
 * `KeyError('attempts')`, an empty attempts list an `IndexError`, a missing
 * `rung` a `KeyError('rung')`, a non-dict judge an `AttributeError`, a
 * non-subscriptable verdict a `TypeError`, a non-list `repair_runs` an
 * `AttributeError`, and a corrupt inbox job or result a
 * `JSONDecodeError`-shaped parse refusal.
 */
export function repairDigest(
  queue: unknown,
  inbox: RepairInboxState,
  clockSeconds: number,
): Record<string, unknown> {
  const counts = zeroVerdicts();
  const fixPrs: unknown[] = [];
  const sourcePublicationErrors: Record<string, unknown>[] = [];
  const consumed = new Set<string>();
  const items = queueItems(queue);
  for (const item of items) {
    for (const [run, record] of repairRuns(item)) {
      if (pyTruthy(recordGet(record, 'source_publication_error'))) {
        sourcePublicationErrors.push({
          item: plainOf2(itemGet(item, 'id')),
          run: plainOf2(run),
          error: plainOf2(recordGet(record, 'source_publication_error')),
        });
      }
      if (pyTruthy(recordGet(record, 'fix_pr'))) {
        fixPrs.push(plainOf2(recordGet(record, 'fix_pr')));
      }
      const verdictsValue = recordGet(record, 'verdicts');
      // Python `record.get('verdicts', [])`: only an absent key defaults; an
      // explicit None reaches the for-loop and refuses as not iterable.
      const verdicts = verdictsValue === undefined ? [] : verdictsValue;
      if (!Array.isArray(verdicts)) {
        // Python iterates the object: None refuses as not iterable, while a
        // dict yields its keys and a str its characters. Every such str
        // element then fails `value['job']` with the string-subscript error.
        throw new PublishEffectsError(
          verdicts === null
            ? "'NoneType' object is not iterable"
            : "string indices must be integers, not 'str'",
          'TypeError',
        );
      }
      for (const verdictValue of verdicts) {
        if (!isMapping(verdictValue)) {
          // Python iterates dicts/strings element-wise, so each element hits
          // the same subscript path as a scalar.
          throw new PublishEffectsError(subscriptMessage(verdictValue, 'value'), 'TypeError');
        }
        const value = verdictValue;
        // Python subscripts both keys; a missing one refuses.
        const job = subscriptRequired(value, 'job');
        const verdict = subscriptRequired(value, 'verdict');
        // Python `consumed.add(job)`: the value must be hashable.
        consumed.add(consumedKey(job));
        if (verdict === 'FIXED') {
          const attempts = value.get('attempts');
          if (attempts === undefined) {
            throw new PublishEffectsError("'attempts'", 'KeyError');
          }
          if (!Array.isArray(attempts)) {
            throw new PublishEffectsError(subscriptMessage(attempts, 'value'), 'TypeError');
          }
          if (attempts.length === 0) {
            throw new PublishEffectsError('list index out of range', 'IndexError');
          }
          const last: unknown = attempts.at(-1);
          if (!isMapping(last)) {
            throw new PublishEffectsError(subscriptMessage(last, 'value'), 'TypeError');
          }
          const rung = subscriptRequired(last, 'rung');
          if (typeof rung !== 'string') {
            throw new PublishEffectsError(
              'can only concatenate str (not "' + pythonTypeName(rung) + '") to str',
              'TypeError',
            );
          }
          // Python `counts['fixed@' + rung] += 1`: an unknown rung refuses;
          // no new key is ever created.
          const key = 'fixed@' + rung;
          if (!(key in counts)) {
            throw new PublishEffectsError(`'${key}'`, 'KeyError');
          }
          counts[key] = (counts[key] ?? 0) + 1;
        } else {
          const bucket = VERDICT_FAILURE_KEYS.get(verdict as string) ?? 'failed';
          counts[bucket] = (counts[bucket] ?? 0) + 1;
        }
        // Python `(value.get('judge') or {})`: every falsy judge collapses to
        // an empty mapping and is ignored.
        const judge = value.get('judge');
        if (pyTruthy(judge)) {
          if (!isMapping(judge)) {
            throw new PublishEffectsError(
              `'${pythonTypeName(judge)}' object has no attribute 'get'`,
              'AttributeError',
            );
          }
          const judged = judge.get('verdict');
          if (judged === 'valid' || judged === 'invalid') {
            const judgedKey = 'judged-' + judged;
            counts[judgedKey] = (counts[judgedKey] ?? 0) + 1;
          }
        }
      }
    }
  }

  // Only jobs the drain can still select count as inbox work: a job listed in
  // a 'queued' run (any item kind) whose id passes the drain grammar.
  const drainable = new Set<string>();
  for (const item of items) {
    for (const record of repairRuns(item).values()) {
      if (recordGet(record, 'state') !== 'queued') continue;
      const jobs = recordGet(record, 'jobs');
      if (jobs === undefined) continue;
      if (
        !Array.isArray(jobs) &&
        typeof jobs !== 'string' &&
        !(jobs instanceof TriageMapping) &&
        jobs !== null
      ) {
        // Python iterates `record.get('jobs', [])`: an int/float/None element
        // source refuses as not iterable.
        throw new PublishEffectsError(
          jobs === null
            ? "'NoneType' object is not iterable"
            : `'${pythonTypeName(jobs)}' object is not iterable`,
          'TypeError',
        );
      }
      const jobElements: readonly unknown[] = Array.isArray(jobs)
        ? jobs
        : typeof jobs === 'string'
          ? [...jobs]
          : jobs instanceof TriageMapping
            ? [...jobs.entriesOfSource().map(([key]) => key)]
            : [];
      for (const job of jobElements) {
        // Python `JOB_ID.fullmatch(job)` requires a string; anything else is
        // `TypeError: expected string or bytes-like object, got 'int'`.
        if (typeof job !== 'string') {
          throw new PublishEffectsError(
            `expected string or bytes-like object, got '${pythonTypeName(job)}'`,
            'TypeError',
          );
        }
        if (JOB_ID.test(job)) drainable.add(job);
      }
    }
  }

  const pendingMtimes: number[] = [];
  let deferred = 0;
  let running = 0;
  let orphaned = 0;
  for (const entry of inbox.entries) {
    if (consumed.has(entry.stem)) continue;
    if (!drainable.has(entry.stem)) {
      // Python tests only `result.json` existence for an undrainable stem;
      // progress is not consulted, so a progress-only stem is orphaned too.
      if (!inbox.hasResult(entry.stem)) {
        orphaned += 1;
      }
      continue;
    }
    // Python `json.loads(path.read_text())`: a missing job file is impossible
    // for a glob yield, and an unreadable one must have raised in the seam
    // before reaching here, so null bytes refuse as the glob/parse gap.
    if (entry.jobBytes === null) {
      throw new PublishEffectsError(
        `[Errno 2] No such file or directory: 'state/repair/inbox/${entry.stem}.json'`,
        'OSError',
      );
    }
    parsePlainJson(entry.jobBytes);
    const resultBytes = inbox.readResult(entry.stem);
    if (resultBytes !== null) {
      const data = parseResult(resultBytes);
      if (pyTruthy(data.get('retry_after'))) {
        deferred += 1;
      } else {
        continue;
      }
    } else if (inbox.hasProgress(entry.stem)) {
      running += 1;
    }
    pendingMtimes.push(entry.mtime);
  }
  // Python: `max(0, (now - min(mtimes)) / 60)` — a non-positive delta is the
  // int 0, a positive delta is a float.
  const rawOldest = pendingMtimes.length > 0 ? (clockSeconds - Math.min(...pendingMtimes)) / 60 : 0;
  const oldest = pendingMtimes.length > 0 && rawOldest > 0 ? JsonNumber.float(rawOldest) : 0;
  return {
    verdicts: counts,
    inbox: pendingMtimes.length,
    oldest_age_minutes: oldest,
    jobs_in_flight: running,
    rate_limit_deferred: deferred,
    orphaned,
    fix_prs: fixPrs,
    source_publication_errors: sourcePublicationErrors,
  };
}

/**
 * `backfill_report.finding_triage(root, strict=False, limit=32)` minus the
 * filesystem: the caller supplies the sorted `triage/*.json` rows. Malformed
 * rows count into `error_count` (first 32 recorded as `{file, error}`) with
 * the Python exception class of the refusal, and never stop the digest.
 */
export function findingTriage(rows: readonly TriageRowFile[]): Record<string, unknown> {
  const counts = new Map<string, number>();
  const needsHuman: Record<string, unknown>[] = [];
  const ownerDecisions: Record<string, unknown>[] = [];
  const operatorAttention: Record<string, unknown>[] = [];
  const unknownFailure: Record<string, unknown>[] = [];
  let ownerCount = 0;
  let operatorCount = 0;
  let unknownFailureCount = 0;
  const contextFailures: Record<string, unknown>[] = [];
  let humanCount = 0;
  let errorCount = 0;
  let contextFailureCount = 0;
  const errors: Record<string, string>[] = [];
  const LIMIT = 32;
  for (const row of rows) {
    try {
      if (row.bytes === null) throw new TriageRowError('OSError');
      const document = triageLoads(row.bytes);
      const status = subscriptString(document, 'status');
      const finding = subscriptMapping(document, 'finding');
      for (const value of [
        status,
        subscriptValue(document, 'canonical_id'),
        subscriptValue(document, 'target'),
        subscriptValue(finding, 'id'),
        subscriptValue(finding, 'title'),
        subscriptValue(finding, 'severity'),
      ]) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TriageRowError('ValueError', 'invalid finding row');
        }
      }
      const detail: Record<string, unknown> = {
        id: finding.get('id') as string,
        canonical_id: document.get('canonical_id') as string,
        path: pyTruthy(document.get('mapped_path'))
          ? plainOf(document.get('mapped_path') as JsonValue)
          : finding.has('path')
            ? plainOf(finding.get('path') as JsonValue)
            : null,
        title: finding.get('title') as string,
        severity: finding.get('severity') as string,
        target: Object.prototype.hasOwnProperty.call(document.plain, 'target_current')
          ? document.get('target_current')
          : document.get('target'),
        event_id: document.get('previous_event_id') ?? null,
      };
      const plainDetail = unwrapValues(detail);
      counts.set(status, (counts.get(status) ?? 0) + 1);
      const contextError = document.get('context_error');
      if (isMapping(contextError)) {
        contextFailureCount += 1;
        if (contextFailures.length < LIMIT) {
          contextFailures.push({ ...plainDetail, status, context_error: contextError.toPlain() });
        }
      }
      if (status === 'needs-human') {
        humanCount += 1;
        const failureClass = document.get('failure_class');
        const isUnknown = !(typeof failureClass === 'string' && FAILURE_CLASSES.has(failureClass));
        if (failureClass === 'owner-decision') {
          ownerCount += 1;
          if (ownerDecisions.length < LIMIT) {
            ownerDecisions.push({ ...plainDetail, failure_class: failureClass });
          }
        } else if (!isUnknown) {
          operatorCount += 1;
          if (operatorAttention.length < LIMIT) {
            operatorAttention.push({ ...plainDetail, failure_class: failureClass });
          }
        } else {
          unknownFailureCount += 1;
          if (unknownFailure.length < LIMIT) {
            // Python's `row.get("failure_class")` is None for an absent key;
            // a JSON null, never a missing key. Non-string values (including
            // objects and lists) stay data and must serialise, so views are
            // unwrapped to plain JSON here.
            unknownFailure.push({ ...plainDetail, failure_class: unwrap(failureClass ?? null) });
          }
          operatorCount += 1;
        }
        if (needsHuman.length < LIMIT) needsHuman.push(plainDetail);
      }
    } catch (error) {
      errorCount += 1;
      if (errors.length < LIMIT) {
        errors.push({
          file: row.name,
          error: error instanceof TriageRowError ? error.pythonError : 'ValueError',
        });
      }
      continue;
    }
  }
  const result: Record<string, unknown> = {
    counts: sortedCounts(counts),
    needs_human: needsHuman,
  };
  if (humanCount > 0) {
    result['owner_decisions'] = ownerDecisions;
    result['operator_attention'] = operatorAttention;
    result['owner_decisions_count'] = ownerCount;
    result['operator_attention_count'] = operatorCount;
    result['unknown_failure_class'] = unknownFailure;
    result['unknown_failure_class_count'] = unknownFailureCount;
    if (unknownFailureCount > 0) {
      result['unknown_failure_class_note'] =
        'rows with an absent or unrecognized failure_class (including ' +
        'non-string legacy values); treated as operator attention, not ' +
        'owner decisions (D7); unknown_failure_class_count is a subset ' +
        'of operator_attention_count';
    }
  }
  if (contextFailureCount > 0) {
    result['context_failures'] = contextFailures;
    result['context_failures_count'] = contextFailureCount;
    result['context_failures_omitted'] = contextFailureCount - contextFailures.length;
  }
  // Python: `if not strict or limit is not None` — always true here.
  result['counts_complete'] = errorCount === 0;
  result['error_count'] = errorCount;
  result['errors'] = errors;
  result['errors_omitted'] = errorCount - errors.length;
  result['needs_human_count'] = humanCount;
  result['needs_human_omitted'] = humanCount - needsHuman.length;
  result['unknown_failure_class_omitted'] = unknownFailureCount - unknownFailure.length;
  return result;
}

/** `collections.Counter` sorted by key: Python sorts str keys by code point. */
function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  const keys = [...counts.keys()].sort(compareCodePoints);
  // Own-property writes: a `__proto__` status is an ordinary Counter key in
  // Python; an assignment would set the prototype and silently drop the key.
  const sorted: Record<string, number> = {};
  for (const key of keys) {
    Object.defineProperty(sorted, key, {
      value: counts.get(key) as number,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sorted;
}

const TIMERS = [
  'crq-tick.timer',
  'crq-watchdog.timer',
  'crq-slot.timer',
  'crq-backfill.timer',
  'crq-repair.timer',
] as const;

/** One observed systemd unit entry, in Python key order. */
export interface SystemdUnitActivity {
  readonly active: boolean | null;
  readonly active_state: string | null;
  readonly load_state: string | null;
  readonly last_trigger?: string | null;
  readonly next_elapse?: string | null;
  readonly error?: string;
}

export interface SystemdActivity {
  readonly timers: Readonly<Record<string, SystemdUnitActivity>>;
  readonly services: Readonly<Record<string, SystemdUnitActivity>>;
}

interface SystemdClock {
  /** `time.time()` when the output was captured. */
  readonly realtime: number;
  /** `time.clock_gettime(CLOCK_MONOTONIC)` at the same moment. */
  readonly monotonic: number;
}

const UNIT_SCALES: Readonly<Record<string, number>> = {
  y: 31_557_600,
  month: 2_629_800,
  w: 604_800,
  d: 86_400,
  h: 3600,
  min: 60,
  s: 1,
  ms: 0.001,
  us: 0.000001,
  µs: 0.000001,
};
const UNIT_PATTERN = 'y|month|min|ms|us|µs|w|d|h|s';

/**
 * `status_summary.systemd_activity()` minus the process: the caller supplies
 * the `systemctl --user show --timestamp=unix --property=…` output (or an
 * `error`) and the realtime/monotonic clock pair. `systemd_services` stays the
 * empty object the oracle produces today (`services = ()`).
 */
export function systemdActivity(probe: SystemdProbe, clock: SystemdClock): SystemdActivity {
  const activity: Record<string, Record<string, unknown>> = {};
  for (const unit of TIMERS) {
    activity[unit] = {
      active: null,
      active_state: null,
      load_state: null,
      last_trigger: null,
      next_elapse: null,
    };
  }
  if (probe.error !== undefined || probe.output === undefined) {
    for (const entry of Object.values(activity)) {
      entry['error'] = 'systemctl user show unavailable';
    }
    return { timers: projectTimers(activity), services: {} };
  }

  const realtime = clock.realtime;
  const monotonic = clock.monotonic;

  const unixTime = (value: string | null): number | null => {
    if (
      value === null ||
      value === '' ||
      value === '0' ||
      value === 'infinity' ||
      value === 'n/a'
    ) {
      return null;
    }
    if (!value.startsWith('@')) {
      throw new PublishEffectsError('unexpected systemd timestamp', 'ValueError');
    }
    const parsed = Number.parseFloat(value.slice(1));
    if (Number.isNaN(parsed)) {
      throw new PublishEffectsError('unexpected systemd timestamp', 'ValueError');
    }
    return parsed === 0 ? null : parsed;
  };

  const isoTime = (value: number | null): string | null => {
    if (value === null) return null;
    // `datetime.fromtimestamp(value, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`:
    // a value outside the representable window refuses (OverflowError etc.)
    // and the caller records the timer-timestamp error.
    const micros = floatSecondsToMicros(value);
    if (micros === null) throw new PublishEffectsError('timestamp out of range', 'OverflowError');
    return microsToIsoSeconds(micros);
  };

  const monotonicTime = (value: string | null): number | null => {
    if (
      value === null ||
      value === '' ||
      value === '0' ||
      value === 'infinity' ||
      value === 'n/a'
    ) {
      return null;
    }
    const pattern = new RegExp(`(\\d+(?:\\.\\d+)?)(${UNIT_PATTERN})`, 'g');
    const parts: Array<[number, string]> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      parts.push([Number.parseFloat(match[1] as string), match[2] as string]);
    }
    const stripped = value
      .replace(new RegExp(`\\d+(?:\\.\\d+)?(?:${UNIT_PATTERN})\\s*`, 'g'), '')
      .trim();
    if (parts.length === 0 || stripped !== '') {
      throw new PublishEffectsError('unexpected systemd timespan', 'ValueError');
    }
    let sum = 0;
    for (const [n, unit] of parts) sum += n * (UNIT_SCALES[unit] ?? 1);
    return realtime + sum - monotonic;
  };

  for (const block of probe.output.trim().split('\n\n')) {
    const properties = new Map<string, string>();
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq >= 0) properties.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const unit = properties.get('Id');
    if (unit === undefined || !(unit in activity)) continue;
    const entry = activity[unit] as Record<string, unknown>;
    entry['active_state'] = properties.get('ActiveState') ?? null;
    entry['load_state'] = properties.get('LoadState') ?? null;
    if (entry['active_state'] !== null) entry['active'] = entry['active_state'] === 'active';
    if (entry['load_state'] !== 'loaded') entry['error'] = 'systemd unit not loaded';
    try {
      entry['last_trigger'] = isoTime(unixTime(properties.get('LastTriggerUSec') ?? null));
      let nextElapse = unixTime(properties.get('NextElapseUSecRealtime') ?? null);
      if (nextElapse === null) {
        nextElapse = monotonicTime(properties.get('NextElapseUSecMonotonic') ?? null);
      }
      entry['next_elapse'] = isoTime(nextElapse);
    } catch {
      entry['error'] = 'systemd timer timestamp unavailable';
      // Python assigns the failing field before the exception; the failed
      // field keeps the last successfully assigned value (usually None).
    }
  }
  for (const entry of Object.values(activity)) {
    if (entry['active_state'] === null) entry['error'] = 'systemd unit observation unavailable';
  }
  return { timers: projectTimers(activity), services: {} };
}

/** Project the mutable build records into the frozen result shape. */
function projectTimers(
  activity: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, SystemdUnitActivity> {
  const timers: Record<string, SystemdUnitActivity> = {};
  for (const unit of TIMERS) {
    const entry = activity[unit] as Record<string, unknown>;
    const out: Record<string, unknown> = {
      active: entry['active'] ?? null,
      active_state: entry['active_state'] ?? null,
      load_state: entry['load_state'] ?? null,
    };
    if ('last_trigger' in entry) out['last_trigger'] = entry['last_trigger'];
    if ('next_elapse' in entry) out['next_elapse'] = entry['next_elapse'];
    if ('error' in entry) out['error'] = entry['error'];
    timers[unit] = out as unknown as SystemdUnitActivity;
  }
  return timers;
}

/** Epoch seconds to whole-second ISO text with Python's truncation. */
function microsToIsoSeconds(micros: bigint): string {
  const seconds = micros / 1_000_000n;
  return epochSecondsText(seconds);
}

function floatSecondsToMicros(value: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 1_000_000;
  if (Math.abs(scaled) >= Number.MAX_SAFE_INTEGER) return null;
  return BigInt(Math.trunc(scaled));
}

/** `datetime.fromtimestamp(seconds, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function epochSecondsText(seconds: bigint): string {
  const days = floorDiv(seconds, 86_400n);
  const remainder = seconds - days * 86_400n;
  const { year, month, day } = civilFromDays(Number(days));
  const hour = Number(remainder / 3600n);
  const minute = Number((remainder % 3600n) / 60n);
  const second = Number(remainder % 60n);
  return (
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-` +
    `${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:` +
    `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`
  );
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder !== 0n && remainder < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
}

/** `review_ledger.loads` over triage bytes, with the oracle's refusal names. */
function triageLoads(bytes: Uint8Array): TriageMapping {
  let value: JsonValue;
  try {
    value = ledgerLoads(bytes);
  } catch (error) {
    if (error instanceof LedgerJsonDecodeError) {
      throw new TriageRowError('JSONDecodeError', error.message);
    }
    if (error instanceof LedgerUnicodeDecodeError) {
      throw new TriageRowError('UnicodeDecodeError', error.message);
    }
    if (error instanceof LedgerIntegrityError) {
      throw new TriageRowError('IntegrityError', error.message);
    }
    throw error;
  }
  if (!(value instanceof JsonObject)) {
    throw new TriageRowError('TypeError', subscriptMessage(value, 'value'));
  }
  return TriageMapping.of(value);
}

/** `json.loads` of an inbox `result.json`, refusing like the oracle. */
function parseResult(bytes: Uint8Array): TriageMapping {
  const value = parsePlainJson(bytes);
  if (!(value instanceof JsonObject)) {
    throw new PublishEffectsError(subscriptMessage(value, 'value'), 'TypeError');
  }
  return TriageMapping.of(value);
}

/** Plain `json.loads`: parse errors carry the JSONDecodeError class name. */
function parsePlainJson(bytes: Uint8Array): JsonValue {
  try {
    return parseJsonValue(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch (error) {
    throw new PublishEffectsError(
      error instanceof Error ? error.message : String(error),
      'JSONDecodeError',
    );
  }
}

class TriageRowError extends Error {
  readonly pythonError: string;
  constructor(pythonError: string, message = 'invalid finding row') {
    super(message);
    this.pythonError = pythonError;
  }
}

/** An object-shaped JSON view preserving Python `.get(key, default)`. */
class TriageMapping {
  readonly plain: Record<string, unknown>;
  private readonly source: JsonObject;

  private constructor(source: JsonObject, plain: Record<string, unknown>) {
    this.source = source;
    this.plain = plain;
  }

  static of(source: JsonObject): TriageMapping {
    const plain = plainOf(source);
    return new TriageMapping(source, isRecord(plain) ? plain : {});
  }

  get(key: string): unknown {
    const entry: JsonValue | undefined = this.source.has(key) ? this.source.get(key) : undefined;
    if (entry === undefined) return undefined;
    // Nested mappings stay TriageMapping views so `.get` chains like Python's.
    if (entry instanceof JsonObject) return TriageMapping.of(entry);
    if (Array.isArray(entry))
      return entry.map((item) =>
        item instanceof JsonObject ? TriageMapping.of(item) : pyValue(item),
      );
    return pyValue(entry);
  }

  /** Plain JSON projection of the whole mapping (for embedded results). */
  toPlain(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of this.source.entries) {
      // `__proto__` stays an own data property (see plainOf): an assignment
      // would set the prototype, drop the key, and refuse serialisation.
      Object.defineProperty(out, key, {
        value: entry instanceof JsonObject ? TriageMapping.of(entry).toPlain() : pyValue(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  has(key: string): boolean {
    return this.source.has(key);
  }

  /** Raw source entries, for callers that must walk record maps directly. */
  entriesOfSource(): ReadonlyArray<readonly [string, JsonValue]> {
    return this.source.entries;
  }
}

function plainOf(value: JsonValue): unknown {
  if (value instanceof JsonObject) {
    // `__proto__` is an ordinary own dict key in Python; a plain assignment
    // would set the prototype (dropping the key and later refusing
    // serialisation), so every projection writes own, enumerable properties.
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value.entries) {
      Object.defineProperty(out, key, {
        value: plainOf(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(plainOf);
  return value;
}

/** Unwrap a runtime value (mapping views, arrays of views) to plain JSON. */
function unwrap(value: unknown): unknown {
  if (value instanceof TriageMapping) return value.toPlain();
  if (Array.isArray(value)) return value.map(unwrap);
  return value;
}

function pyValue(value: JsonValue): unknown {
  return plainOf(value);
}

/** Unwrap TriageMapping views from an output row so JSON can serialise it. */
function unwrapValues(record: Record<string, unknown>): Record<string, unknown> {
  // Own-property writes: `detail` keys come from attacker-controlled triage
  // JSON, so a `__proto__` key must never become a prototype assignment.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const resolved =
      value instanceof TriageMapping
        ? value.toPlain()
        : Array.isArray(value)
          ? (value as unknown[]).map((item: unknown) =>
              item instanceof TriageMapping ? item.toPlain() : item,
            )
          : value;
    Object.defineProperty(out, key, {
      value: resolved,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMapping(value: unknown): value is TriageMapping {
  return value instanceof TriageMapping;
}

function subscriptString(container: TriageMapping, key: string): string {
  const value = container.get(key);
  if (value === undefined) {
    throw new TriageRowError('KeyError', `'${key}'`);
  }
  return value as string;
}

function subscriptMapping(container: TriageMapping, key: string): TriageMapping {
  const value = container.get(key);
  if (value === undefined) {
    throw new TriageRowError('KeyError', `'${key}'`);
  }
  if (!isMapping(value)) {
    throw new TriageRowError('TypeError', subscriptMessage(value, 'value'));
  }
  return value;
}

function subscriptValue(container: TriageMapping, key: string): unknown {
  const value = container.get(key);
  if (value === undefined) {
    throw new TriageRowError('KeyError', `'${key}'`);
  }
  return value;
}

function asMapping(
  value: unknown,
  error: string,
  pythonError: PublishEffectsPythonError,
): TriageMapping {
  if (value instanceof TriageMapping) return value;
  if (value instanceof JsonObject) return TriageMapping.of(value);
  if (isRecord(value)) {
    return TriageMapping.of(
      new JsonObject(
        Object.entries(value).map(([key, entry]) => [key, jsonValueOf(entry)] as const),
      ),
    );
  }
  throw new PublishEffectsError(error ?? subscriptMessage(value, 'value'), pythonError);
}

function jsonValueOf(value: unknown): JsonValue {
  if (value instanceof JsonNumber) return value;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (
    typeof value === 'number' &&
    (Number.isInteger(value) || Object.getOwnPropertySymbols(value).length === 0)
  ) {
    return Number.isInteger(value) ? JsonNumber.int(BigInt(value)) : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map(jsonValueOf);
  if (isRecord(value) && !(value instanceof JsonNumber) && value.constructor === Object) {
    return new JsonObject(
      Object.entries(value).map(([key, entry]) => [key, jsonValueOf(entry)] as const),
    );
  }
  throw new PublishEffectsError('unsupported JSON value', 'TypeError');
}

function queueItems(queue: unknown): TriageMapping[] {
  const mapping = asMapping(queue, subscriptMessage(queue, 'value'), 'TypeError');
  const items = mapping.get('items');
  if (!Array.isArray(items)) {
    throw new PublishEffectsError("'items'", 'KeyError');
  }
  const out: TriageMapping[] = [];
  for (const item of items) {
    out.push(asMapping(item, subscriptMessage(item, 'value'), 'TypeError'));
  }
  return out;
}

function repairRuns(item: TriageMapping): Map<string | number | boolean | null, TriageMapping> {
  const runs = item.get('repair_runs');
  const out = new Map<string | number | boolean | null, TriageMapping>();
  // Python `item.get('repair_runs', {})`: only an absent key defaults. An
  // explicit None reaches `.items()` and refuses with AttributeError.
  if (runs === undefined) return out;
  if (!isMapping(runs)) {
    throw new PublishEffectsError(
      `'${pythonTypeName(runs)}' object has no attribute 'items'`,
      'AttributeError',
    );
  }
  for (const [run, recordValue] of runs.entriesOfSource()) {
    const record = recordValue instanceof JsonObject ? TriageMapping.of(recordValue) : null;
    if (record === null) {
      throw new PublishEffectsError(
        `'${pythonTypeName(recordValue)}' object has no attribute 'get'`,
        'AttributeError',
      );
    }
    out.set(run, record);
  }
  return out;
}

function recordGet(record: TriageMapping, key: string): unknown {
  return record.get(key);
}

function itemGet(item: TriageMapping, key: string): unknown {
  return item.get(key);
}

/** Values leaving a digest result must be plain JSON, never views. */
function plainOf2(value: unknown): unknown {
  if (value instanceof TriageMapping) return value.toPlain();
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item: unknown) =>
      item instanceof TriageMapping ? item.toPlain() : item,
    );
  }
  return value;
}

function jobKey(job: unknown): string {
  return typeof job === 'string' ? job : JSON.stringify(job) + ':' + typeof job;
}

/**
 * `row[key]` where the key must exist: Python subscripts, so absence refuses
 * with `KeyError` while an explicit null is a value like any other.
 */
function subscriptRequired(row: TriageMapping, key: string): unknown {
  if (!row.has(key)) throw new PublishEffectsError(`'${key}'`, 'KeyError');
  return row.get(key);
}

/**
 * Python hashability for a `consumed` set element: NoneType/bool/int/float/str
 * are hashable, list/dict are not. Floats and ints hash equal, so `True`
 * collapses with `1` exactly as in the oracle.
 */
function consumedKey(job: unknown): string {
  if (job === null) return jobKey(job);
  if (job instanceof JsonNumber)
    return jobKey(job.kind === 'int' ? Number(job.integer) : (job.float as number));
  if (typeof job === 'boolean' || typeof job === 'number' || typeof job === 'string') {
    return jobKey(job);
  }
  if (job instanceof TriageMapping) {
    throw new PublishEffectsError(
      `cannot use 'dict' as a set element (unhashable type: 'dict')`,
      'TypeError',
    );
  }
  if (Array.isArray(job)) {
    throw new PublishEffectsError(
      `cannot use 'list' as a set element (unhashable type: 'list')`,
      'TypeError',
    );
  }
  // Any other structural value behaves like a dict for hashability.
  throw new PublishEffectsError(
    `cannot use 'dict' as a set element (unhashable type: 'dict')`,
    'TypeError',
  );
}

function pyTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  // A mapping view's truthiness follows its source entries, not the wrapper.
  if (value instanceof TriageMapping) return value.entriesOfSource().length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  if (typeof value === 'object' && value !== null && 'kind' in (value as object)) {
    // A lossless JsonNumber: truthiness follows the Python numeric value.
    const number = value as {
      kind: 'int' | 'float';
      integer?: bigint | null;
      float?: number | null;
    };
    return number.kind === 'int'
      ? (number.integer as bigint) !== 0n
      : (number.float as number) !== 0;
  }
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? 'int' : 'float';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

function subscriptMessage(value: unknown, context: string): string {
  void context;
  if (value === null || value === undefined) return `'NoneType' object is not subscriptable`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `'${pythonTypeName(value)}' object is not subscriptable`;
  }
  if (Array.isArray(value)) return 'list indices must be integers or slices, not str';
  if (typeof value === 'string') return "string indices must be integers, not 'str'";
  return `'${pythonTypeName(value)}' object is not subscriptable`;
}
