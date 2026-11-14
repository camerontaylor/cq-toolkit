/**
 * Persisted per-target backfill coverage snapshots (`backfill_coverage`).
 *
 * Coverage is a union over independent creditable ledger reviews, and the ledger
 * is append-only, so a snapshot taken over the first n events extends to any
 * later head by folding only the appended events. Selection under the tick lock
 * reads snapshots only; the expensive Git fold runs off-lock in the refresher.
 *
 * This module owns the cheap, Git-free half: reading and validating a stored
 * snapshot, deciding whether it still extends the current ledger sequence, and
 * naming the targets that need a refresh. The fold itself stays in the
 * accounting adapter. Bumping {@link COVERAGE_SNAPSHOT_VERSION} makes every
 * existing snapshot read as stale, which is the only supported invalidation.
 */
import { ledgerCreditable } from './ledger.js';
import { ledgerJsonDigest } from './pythonJson.js';
import { intervalsOf, pythonInt } from './backfillInventory.js';
import {
  isJsonRecord,
  recordEntries,
  recordGet,
  recordHas,
  fromPlainJson,
  type JsonRecordLike,
} from './queueDoc.js';

/** `backfill_coverage.VERSION`. */
export const COVERAGE_SNAPSHOT_VERSION = 1;

/** The directory (under the crq state root) that holds one snapshot per target. */
export const COVERAGE_DIRECTORY = 'backfill/coverage';

/** The refresh request the off-lock refresher consumes. */
export const COVERAGE_REQUEST = 'backfill/coverage-request.json';

/** The refresher's exclusive lock. */
export const COVERAGE_LOCK = 'backfill/coverage.lock';

/** A snapshot that cannot be used is worth less than one that reads as stale. */
export class BackfillCoverageError extends Error {
  override readonly name: string = 'BackfillCoverageError';

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new BackfillCoverageError(message);
}

/** A validated snapshot: `events` counts the ledger prefix it covers. */
export interface CoverageSnapshot {
  readonly version: number;
  readonly target: string;
  readonly events: number;
  readonly prefix: unknown;
  readonly covered: Map<string, Set<number>>;
  readonly gaps: readonly unknown[];
}

/** `backfill_coverage._snapshot_path`: a full object id or a refusal. */
export function coverageSnapshotTarget(target: unknown): string {
  if (
    typeof target !== 'string' ||
    !/^[0-9a-f]+$/.test(target) ||
    (target.length !== 40 && target.length !== 64)
  ) {
    fail('coverage target must be a full object ID');
  }
  return target;
}

/** The field as a Python `int`, or `null` when it is absent or not one. */
function integerAt(value: JsonRecordLike, key: string): number | null {
  if (!recordHas(value, key)) return null;
  try {
    return pythonInt(recordGet(value, key), `coverage snapshot ${key}`);
  } catch {
    return null;
  }
}

/**
 * `backfill_coverage._read`: the stored, already-decoded snapshot, or `null`.
 *
 * A missing, foreign-version, wrong-target or malformed snapshot reads as
 * `null`, which the caller treats as stale and recomputes in full.
 */
export function readCoverageSnapshot(value: unknown, target: string): CoverageSnapshot | null {
  if (!isJsonRecord(value)) return null;
  // A persisted snapshot is decoded losslessly, so `version` and `events` are
  // `JsonNumber` there and native numbers in a hand-built object: read both
  // through the same integer view the rest of the module uses, and treat a
  // non-integer as stale rather than as a reason to fail.
  if (integerAt(value, 'version') !== COVERAGE_SNAPSHOT_VERSION) return null;
  if (recordGet(value, 'target') !== target) return null;
  const events = integerAt(value, 'events');
  if (events === null || events < 0) return null;
  const coveredValue = recordGet(value, 'covered');
  const gaps = recordGet(value, 'gaps');
  if (!isJsonRecord(coveredValue) || !Array.isArray(gaps)) return null;
  const covered = new Map<string, Set<number>>();
  try {
    for (const [name, rows] of recordEntries(coveredValue)) {
      covered.set(name, intervalsOf(rows, `coverage intervals for ${name}`));
    }
  } catch {
    return null;
  }
  return {
    version: COVERAGE_SNAPSHOT_VERSION,
    target,
    events,
    prefix: recordGet(value, 'prefix'),
    covered,
    gaps,
  };
}

/** `backfill_coverage._prefix_digest`: the digest of a ledger event-id prefix. */
export function coveragePrefixDigest(events: readonly unknown[], count: number): string {
  const ids: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = events[index];
    if (!isJsonRecord(value) || !recordHas(value, 'id')) fail('ledger event is missing its id');
    ids.push(recordGet(value, 'id'));
  }
  return ledgerJsonDigest(ids);
}

/** `backfill_coverage._extends`: the snapshot's events are a prefix of this sequence. */
export function coverageSnapshotExtends(
  snapshot: CoverageSnapshot,
  events: readonly unknown[],
  digests?: Map<number, string>,
): boolean {
  const count = snapshot.events;
  if (count < 0 || count > events.length) return false;
  if (digests !== undefined && !digests.has(count))
    digests.set(count, coveragePrefixDigest(events, count));
  const expected = digests === undefined ? coveragePrefixDigest(events, count) : digests.get(count);
  return snapshot.prefix === expected;
}

/**
 * `backfill_coverage.load`: `{covered, gaps}` valid for this ledger sequence, or
 * `null` when the snapshot is stale.
 *
 * A snapshot over a prefix stays exact when no appended event is a creditable
 * review. Pass one `digests` map for every target checked against the same
 * events so each prefix is hashed once.
 */
export function loadCoverageSnapshot(
  snapshot: CoverageSnapshot | null,
  events: readonly unknown[],
  digests?: Map<number, string>,
): { readonly covered: Map<string, Set<number>>; readonly gaps: readonly unknown[] } | null {
  if (snapshot === null || !coverageSnapshotExtends(snapshot, events, digests)) return null;
  for (const value of events.slice(snapshot.events)) {
    // `ledgerCreditable` reads the lossless model, so a plain event is minted
    // first; an event already decoded by the ledger passes through unchanged.
    if (ledgerCreditable(fromPlainJson(value))) return null;
  }
  // `list(snapshot["gaps"])`: a caller cannot mutate the snapshot it was handed.
  return { covered: snapshot.covered, gaps: [...snapshot.gaps] };
}

/** `backfill_coverage.pending_targets`: targets with a pending backfill job. */
export function pendingTargets(queue: unknown): Set<string> {
  return targetSet(queue, (job) => recordGet(job, 'state') === 'pending');
}

/** `backfill_coverage.live_targets`: targets that may still need dispatch. */
export function liveTargets(queue: unknown): Set<string> {
  return targetSet(
    queue,
    (job) => recordGet(job, 'state') !== 'done' && recordGet(job, 'state') !== 'quarantined',
  );
}

function targetSet(queue: unknown, include: (job: JsonRecordLike) => boolean): Set<string> {
  const targets = new Set<string>();
  if (!isJsonRecord(queue)) fail('queue snapshot must be an object');
  const items = recordGet(queue, 'items');
  if (items === undefined || items === null) return targets;
  if (!Array.isArray(items)) fail('queue items must be an array');
  for (const value of items) {
    if (!isJsonRecord(value)) fail('queue item must be an object');
    if (recordGet(value, 'kind') !== 'backfill') continue;
    if (!include(value)) continue;
    const target = recordGet(value, 'target');
    if (typeof target === 'string') targets.add(target);
  }
  return targets;
}

/** `backfill_coverage.request`: the refresher's atomic small write. */
export function coverageRequestFrame(
  head: unknown,
  targets: Iterable<string>,
): Record<string, unknown> {
  return {
    head,
    targets: [...new Set(targets)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
}
