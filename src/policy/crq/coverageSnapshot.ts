/**
 * Pure port of `apps/crq-python/backfill_coverage.py`: the persisted per-target
 * coverage snapshot model, its extension rule, and the refresh decisions.
 *
 * Coverage is a union over independent creditable ledger reviews and the
 * ledger is append-only, so a snapshot taken over the first n events remains
 * exact for any later head that appended no creditable review. Selection reads
 * these snapshots under `tick.lock`; only the off-lock refresher (the publisher
 * run, after publication moved the ledger head) does the expensive accounting.
 *
 * Python parity, kept exactly:
 *
 * - A snapshot document is `{version, target, events, prefix, covered, gaps}`.
 *   Anything unreadable, of another version or another target, with a
 *   non-integer `events`, a non-object `covered`, a non-list `gaps` or
 *   overlapping/out-of-order intervals reads as absent (a full recompute),
 *   never as an error.
 * - `prefix` is the digest of the first `events` record ids, so a sequence
 *   that no longer extends the snapshot (which append-only history forbids)
 *   recomputes in full.
 * - A refresh folds only the appended events plus earlier gap reviews; when
 *   that set holds no creditable review the snapshot is rewritten for the new
 *   head (`unchanged`), and is `current` when nothing at all moved.
 * - The outcome name is observable: `extended`/`full` wake selection,
 *   `unchanged`/`current` do not, `invalid-target` and `error: ...` stay local
 *   to their target.
 *
 * Filesystem, locks and git stay in the ops/adapter layers.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCreditable,
  ledgerDigestOf,
  ledgerIntervals,
  ledgerLoads,
} from './ledger.js';

/** Bump when accounting semantics change so old snapshots read stale. */
export const COVERAGE_VERSION = 1;

/** Snapshot directory under the state root. */
export const COVERAGE_DIRECTORY = 'backfill/coverage';

/** Selection's off-lock refresh request (`coverage.REQUEST`). */
export const COVERAGE_REQUEST = 'backfill/coverage-request.json';

/** The refresher lock, independent of `tick.lock` (`coverage.LOCK`). */
export const COVERAGE_LOCK = 'backfill/coverage.lock';

/** Python's target spelling: a full 40- or 64-hex object id. */
const COVERAGE_TARGET = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A validated snapshot: intervals are already expanded to line sets. */
export interface CoverageSnapshot {
  readonly version: number;
  readonly target: string;
  readonly events: number;
  readonly prefix: string;
  readonly covered: ReadonlyMap<string, ReadonlySet<number>>;
  readonly gaps: readonly JsonValue[];
}

/** `coverage.load`'s answer: credit and the gaps that block admission. */
export interface CoverageLoad {
  readonly covered: ReadonlyMap<string, ReadonlySet<number>>;
  readonly gaps: readonly JsonValue[];
}

/** `coverage._refresh_one`'s plan, pure: what to fold and how to classify. */
export interface CoverageRefreshPlan {
  /** A snapshot extended by this sequence (renamed snapshot output), if any. */
  readonly snapshot: CoverageSnapshot | null;
  /** Reviews to fold: retried gaps then (or) appended events. */
  readonly todo: readonly JsonValue[];
  /** Credit carried from the snapshot when only a suffix is folded. */
  readonly covered: ReadonlyMap<string, ReadonlySet<number>>;
  /** No appended creditable review: a valid snapshot for the new head. */
  readonly validBefore: boolean;
  /** Nothing at all to fold and nothing to rewrite. */
  readonly current: boolean;
}

/**
 * `coverage._snapshot_path`: refuses anything but a full object id, so a
 * hostile target can never escape the snapshot directory.
 */
export function coverageSnapshotPath(stateRoot: string, target: unknown): string {
  if (typeof target !== 'string' || !COVERAGE_TARGET.test(target)) {
    throw new LedgerIntegrityError('coverage target must be a full object ID');
  }
  return `${stateRoot}/${COVERAGE_DIRECTORY}/${target}.json`;
}

/** `coverage._prefix_digest`: digest over the first `count` record ids. */
export function coveragePrefixDigest(events: readonly JsonValue[], count: number): string {
  const ids: JsonValue[] = [];
  for (const value of events.slice(0, count)) {
    if (!(value instanceof JsonObject)) throw new TypeError('ledger record must be an object');
    const id = value.get('id');
    if (typeof id !== 'string') throw new TypeError('ledger record id must be a string');
    ids.push(id);
  }
  return ledgerDigestOf(ids);
}

/**
 * `coverage._read`: a snapshot for exactly this target and sequence prefix, or
 * null. Unreadable bytes and a refused target are stale, never errors.
 */
export function parseCoverageSnapshot(bytes: Uint8Array, target: string): CoverageSnapshot | null {
  let value: JsonValue;
  try {
    value = ledgerLoads(bytes);
  } catch {
    return null;
  }
  if (!(value instanceof JsonObject)) return null;
  if (!numberEquals(value.get('version'), COVERAGE_VERSION)) return null;
  if (value.get('target') !== target) return null;
  const events = value.get('events');
  if (!(events instanceof JsonNumber) || events.kind !== 'int') return null;
  const eventCount = Number(events.integer);
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) return null;
  const covered = value.get('covered');
  const gaps = value.get('gaps');
  if (!(covered instanceof JsonObject) || !Array.isArray(gaps)) return null;
  const expanded = new Map<string, ReadonlySet<number>>();
  try {
    for (const [name, rows] of covered.entries) {
      expanded.set(name, ledgerIntervals(rows));
    }
  } catch {
    return null;
  }
  const prefix = value.get('prefix');
  if (typeof prefix !== 'string') return null;
  return {
    version: COVERAGE_VERSION,
    target,
    events: eventCount,
    prefix,
    covered: expanded,
    gaps,
  };
}

/** A snapshot's `version` field must be an integer equal to the current one. */
function numberEquals(value: JsonValue | undefined, expected: number): boolean {
  return value instanceof JsonNumber && value.kind === 'int' && value.integer === BigInt(expected);
}

/**
 * `coverage._extends`: the snapshot's events are a prefix of this sequence.
 * `digests` memoizes one prefix hash per count across all targets in a pass.
 */
export function coverageExtends(
  snapshot: CoverageSnapshot,
  events: readonly JsonValue[],
  digests?: Map<number, string>,
): boolean {
  const count = snapshot.events;
  if (count < 0 || count > events.length) return false;
  let digest: string;
  if (digests === undefined) {
    digest = coveragePrefixDigest(events, count);
  } else {
    const cached = digests.get(count);
    if (cached === undefined) {
      digest = coveragePrefixDigest(events, count);
      digests.set(count, digest);
    } else {
      digest = cached;
    }
  }
  return snapshot.prefix === digest;
}

/**
 * `coverage.load`: the snapshot's answer for this ledger sequence, or null when
 * it is stale. Cheap and git-free: safe under `tick.lock`.
 */
export function coverageLoad(
  snapshot: CoverageSnapshot | null,
  events: readonly JsonValue[],
  digests?: Map<number, string>,
): CoverageLoad | null {
  if (snapshot === null || !coverageExtends(snapshot, events, digests)) return null;
  const appended = events.slice(snapshot.events);
  if (appended.some((value) => ledgerCreditable(value))) return null;
  return { covered: snapshot.covered, gaps: snapshot.gaps };
}

/**
 * `coverage._refresh_one`'s decision half: which reviews to fold and whether
 * the result is `current` (nothing to do), a suffix fold, or a full pass.
 */
export function coverageRefreshPlan(
  snapshot: CoverageSnapshot | null,
  events: readonly JsonValue[],
  digests?: Map<number, string>,
): CoverageRefreshPlan {
  if (snapshot !== null && coverageExtends(snapshot, events, digests)) {
    const start = snapshot.events;
    const retry = gapIds(snapshot.gaps);
    const appended = events.slice(start);
    const validBefore = !appended.some((value) => ledgerCreditable(value));
    const retried = events.slice(0, start).filter((value) => {
      if (!(value instanceof JsonObject)) return false;
      const id = value.get('id');
      return id !== undefined && retry.has(id);
    });
    let todo = [...retried, ...appended];
    if (!todo.some((value) => ledgerCreditable(value))) {
      if (start === events.length) {
        return { snapshot, todo: [], covered: snapshot.covered, validBefore, current: true };
      }
      todo = [];
    }
    return { snapshot, todo, covered: snapshot.covered, validBefore, current: false };
  }
  return {
    snapshot: null,
    todo: events,
    covered: new Map<string, ReadonlySet<number>>(),
    validBefore: false,
    current: false,
  };
}

/** The `review` ids a snapshot's gaps name (`coverage._gap_ids`). */
export function coverageGapIds(gaps: readonly JsonValue[]): Set<JsonValue> {
  return gapIds(gaps);
}

function gapIds(gaps: readonly JsonValue[]): Set<JsonValue> {
  const result = new Set<JsonValue>();
  for (const gap of gaps) {
    if (gap instanceof JsonObject) {
      const review = gap.get('review');
      if (review !== undefined) result.add(review);
    }
  }
  return result;
}

/**
 * `coverage._refresh_one`'s classification half, once the folded credit exists:
 * `full` for a first snapshot, `extended` when admission can change (a rejected
 * snapshot is now valid, credit grew, or a gap cleared), else `unchanged`.
 */
export function coverageRefreshOutcome(
  snapshot: CoverageSnapshot | null,
  validBefore: boolean,
  covered: ReadonlyMap<string, ReadonlySet<number>>,
  gaps: readonly JsonValue[],
): 'full' | 'extended' | 'unchanged' {
  if (snapshot === null) return 'full';
  const before = nonEmpty(snapshot.covered);
  const after = nonEmpty(covered);
  const gapBefore = gapIds(snapshot.gaps);
  const gapAfter = gapIds(gaps);
  // Python `not _gap_ids(gaps) >= _gap_ids(snapshot["gaps"])`: every previous
  // gap must still be present, so one cleared gap wakes selection.
  let clearedGap = false;
  for (const id of gapBefore) {
    if (!gapAfter.has(id)) {
      clearedGap = true;
      break;
    }
  }
  if (!validBefore || !sameCoverage(before, after) || clearedGap) return 'extended';
  return 'unchanged';
}

function nonEmpty(
  covered: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, ReadonlySet<number>> {
  const result = new Map<string, ReadonlySet<number>>();
  for (const [name, lines] of covered) {
    if (lines.size > 0) result.set(name, lines);
  }
  return result;
}

function sameCoverage(
  left: ReadonlyMap<string, ReadonlySet<number>>,
  right: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [name, lines] of left) {
    const other = right.get(name);
    if (other === undefined || other.size !== lines.size) return false;
    for (const line of lines) if (!other.has(line)) return false;
  }
  return true;
}

/** `coverage._ranges`: set of lines to disjoint ascending inclusive pairs. */
export function coverageRanges(lines: Iterable<number>): JsonValue[] {
  const ranges: { start: number; end: number }[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last.end === line - 1) {
      last.end = line;
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges.map((range) => [JsonNumber.int(range.start), JsonNumber.int(range.end)]);
}

/** The canonical snapshot document `coverage._refresh_one` persists. */
export function coverageSnapshotDocument(input: {
  readonly target: string;
  readonly events: number;
  readonly prefix: string;
  readonly covered: ReadonlyMap<string, ReadonlySet<number>>;
  readonly gaps: readonly JsonValue[];
}): JsonObject {
  const entries = [...input.covered.entries()]
    .filter(([, lines]) => lines.size > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, lines]) => [name, coverageRanges(lines)] as const);
  return new JsonObject([
    ['version', JsonNumber.int(COVERAGE_VERSION)],
    ['target', input.target],
    ['events', JsonNumber.int(input.events)],
    ['prefix', input.prefix],
    ['covered', new JsonObject(entries)],
    ['gaps', [...input.gaps]],
  ]);
}

/** `coverage.request`: the atomic refresh request selection writes. */
export function coverageRequestDocument(head: string, targets: Iterable<string>): JsonObject {
  return new JsonObject([
    ['head', head],
    ['targets', [...new Set(targets)].sort(compareCodePoints)],
  ]);
}

/** The `targets` a request document names; a malformed request contributes none. */
export function coverageRequestTargets(value: JsonValue | undefined): string[] {
  if (!(value instanceof JsonObject)) return [];
  const targets = value.get('targets');
  if (!Array.isArray(targets)) return [];
  return targets.filter((entry): entry is string => typeof entry === 'string');
}

/** Python `sorted(set(...))` over strings (code points, not UTF-16 units). */
export function coverageSortedTargets(targets: Iterable<string>): string[] {
  return [...new Set(targets)].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = (a[index] as string).codePointAt(0)! - (b[index] as string).codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** `coverage.pending_targets`: targets of still-pending backfill jobs. */
export function coveragePendingTargets(queue: JsonObject): Set<string> {
  const targets = new Set<string>();
  for (const item of itemsOf(queue)) {
    if (
      item.get('kind') === 'backfill' &&
      item.get('state') === 'pending' &&
      typeof item.get('target') === 'string'
    ) {
      targets.add(item.get('target') as string);
    }
  }
  return targets;
}

/** `coverage.live_targets`: targets a snapshot must not be pruned for. */
export function coverageLiveTargets(queue: JsonObject): Set<string> {
  const targets = new Set<string>();
  for (const item of itemsOf(queue)) {
    const state = item.get('state');
    if (item.get('kind') !== 'backfill' || state === 'done' || state === 'quarantined') continue;
    targets.add(requireTarget(item));
  }
  return targets;
}

function requireTarget(item: JsonObject): string {
  const target = item.get('target');
  if (typeof target !== 'string') throw new TypeError('backfill item target must be a string');
  return target;
}

function itemsOf(queue: JsonObject): JsonObject[] {
  const items = queue.get('items');
  return Array.isArray(items)
    ? items.filter((item): item is JsonObject => item instanceof JsonObject)
    : [];
}

/**
 * `backfill_publisher.coverage_failed`: a refresh that failed outright, or any
 * target whose outcome is an error or invalid target, fails the unit visibly
 * after publication already succeeded. Takes the `coverage` field itself, so
 * both the JSON outcome and the plain result object use one rule.
 */
export function coverageFailed(coverage: unknown): boolean {
  if (typeof coverage === 'string') return coverage.startsWith('failed');
  if (coverage === null || typeof coverage !== 'object') return false;
  if (coverage instanceof JsonObject) return failedTargets(coverage.get('targets'));
  return failedTargets((coverage as { readonly targets?: unknown }).targets);
}

function failedTargets(targets: unknown): boolean {
  if (targets === null || typeof targets !== 'object') return false;
  const values =
    targets instanceof JsonObject
      ? targets.entries.map(([, outcome]) => outcome)
      : Object.values(targets as Record<string, unknown>);
  // Python `str(outcome).startswith(("error", "invalid"))`: outcomes are
  // strings in practice; anything else has no such prefix.
  return values.some(
    (outcome) =>
      typeof outcome === 'string' && (outcome.startsWith('error') || outcome.startsWith('invalid')),
  );
}
