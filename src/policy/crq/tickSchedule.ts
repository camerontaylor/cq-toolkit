/**
 * Queue scheduling policy for the crq tick/slot port.
 *
 * The Python oracle is `apps/crq-python/crq.py` at the slice's baseline:
 * `live_items`, `item_repo`, `dump_*`-free rank ordering, `deps_met`,
 * `optional_wait`, `inflight`, `starts_last_hour`, `has_collectable_runs`,
 * `background_turn` and the superseded-open retirement `load_queue` performs.
 * Everything here is pure: the caller supplies the queue document, the
 * repository configuration and one clock reading. No filesystem, process,
 * environment or network effect is performed.
 *
 * Numeric and identity edges follow the oracle rather than JavaScript
 * convenience:
 *
 * - `depends_on` is `string | array | null` in the queue schema; Python
 *   compares `i["id"] == dep`, so a non-string dependency matches nothing and
 *   `deps_met` is true (there is no item whose id equals a list).
 * - Two missing `pr` values compare equal in Python (`None == None`), which is
 *   what `parked_merged_linked_receipt` relies on; {@link pythonEqual} models
 *   that for the schema-constrained scalar `pr` values it sees.
 * - `rank` reads `now()` only for the `local-review` aging gate, so the caller
 *   passes it explicitly instead of the module reading a clock.
 * - `background_turn` orders reservation chronology as Python sorts
 *   `(datetime, run_id, band)` tuples: microsecond instant first, then the
 *   run id as a code-point string. Run ids are generated ASCII.
 */
import { isRecord, type CrqRecord } from './receiptIdentity.js';
import { UtcParseError, parseIso, parseUtc, type UtcInstant } from './utc.js';

/** The retired queue kind: retained on disk, never live scheduling work. */
export const PROMOTION_KIND = 'promotion';
/** `review_operation.KIND` (`local_review_runtime.KIND` re-exports it). */
export const LOCAL_REVIEW_KIND = 'local-review';
/** `author_quota.AUTHOR_KIND`. */
export const AUTHOR_KIND = 'author';
/** `review_receipt.KIND`. */
export const REVIEW_RECEIPT_KIND = 'merged-current';
/** `backfill_jobs.KIND` and its `RANK4` companion. */
export const BACKFILL_KIND = 'backfill';
/** `coverage.COVERAGE_RANK`. */
export const COVERAGE_RANK = 4;
/** `author_quota.AUTHOR_RANK`. */
export const AUTHOR_RANK = 4;

/** `repo_registry.DEFAULT_RANK`: an unconfigured non-primary repo's tier. */
export const DEFAULT_REPO_RANK = 3;
const MIN_REPO_RANK = 2;
const MAX_REPO_RANK = 4;

const HOUR_MICROS = 3_600_000_000n;
const SECOND_MICROS = 1_000_000n;

/** One configured non-primary repository, reduced to what ranking reads. */
export interface RepoRank {
  readonly repo: string;
  readonly rank_tier: number;
}

/** The repository configuration ranking needs. */
export interface ScheduleConfig {
  /** Top-level `config.repo`: the primary repository. */
  readonly primaryRepo: string;
  /** `repo_registry.parse(config)`, reduced to identity and rank. */
  readonly repos: readonly RepoRank[];
  /** `config.local_review_aging_minutes` (Python's `.get(..., 60)`). */
  readonly localReviewAgingMinutes: number;
}

/** One scheduling observation: the queue's own facts plus a clock reading. */
export interface ScheduleContext {
  readonly config: ScheduleConfig;
  /** `crq.now()` in epoch microseconds. */
  readonly nowMicros: bigint;
}

/** Raised when a scheduling input cannot be read the way Python reads it. */
export class TickScheduleError extends Error {
  override readonly name = 'TickScheduleError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * `crq.live_items`: every item except the exact retired `promotion` kind.
 * Objects are returned by reference, so callers that mutate the document see
 * the same item instances `optional_wait` compares by identity.
 */
export function liveItems(queue: CrqRecord): CrqRecord[] {
  const items = queue.items;
  if (!Array.isArray(items)) throw new TickScheduleError('queue.items must be an array');
  return items.filter((item): item is CrqRecord => isRecord(item) && item.kind !== PROMOTION_KIND);
}

/** `repo_registry._identity`: GitHub slugs compare case-insensitively. */
function repoIdentity(slug: unknown): string {
  return typeof slug === 'string' ? slug.toLowerCase() : '';
}

/** `repo_registry.same_repo`: non-empty identities only. */
export function sameRepo(left: unknown, right: unknown): boolean {
  const identity = repoIdentity(left);
  return identity !== '' && identity === repoIdentity(right);
}

/** `crq.item_repo`: legacy items without `repo` are primary-repo items. */
export function itemRepo(item: CrqRecord, primaryRepo: string): string {
  const repo = item.repo;
  return typeof repo === 'string' && repo !== '' ? repo : primaryRepo;
}

/** Python truthiness for the JSON values the scheduler reads. */
function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `==` for the JSON scalars this policy compares, including two missing values. */
function pythonEqual(left: unknown, right: unknown): boolean {
  return (left === undefined ? null : left) === (right === undefined ? null : right);
}

/** `len(item.get("cycles", []))` for a schema-validated item. */
export function completedOpenCycles(item: CrqRecord): number {
  const cycles = item.cycles;
  return Array.isArray(cycles) ? cycles.length : 0;
}

/** `crq.optional_open`. */
export function optionalOpen(item: CrqRecord): boolean {
  return item.kind === 'open' && completedOpenCycles(item) >= 1;
}

/** `crq.additional_cycle`: an optional open cycle or a second author cycle. */
export function additionalCycle(item: CrqRecord): boolean {
  if (optionalOpen(item)) return true;
  const author = item.author;
  const cycle = isRecord(author) ? author.cycle : undefined;
  return item.kind === AUTHOR_KIND && typeof cycle === 'number' && cycle > 1;
}

/**
 * `crq.parked_merged_linked_receipt`: a merged row parked for a linked
 * current-code receipt never starts on its own, so it demands no wait.
 */
export function parkedMergedLinkedReceipt(queue: CrqRecord, item: CrqRecord): boolean {
  if (item.kind !== 'merged') return false;
  return liveItems(queue).some(
    (other) => other.kind === REVIEW_RECEIPT_KIND && pythonEqual(other.pr, item.pr),
  );
}

/**
 * `repo_registry.rank_for`: a non-primary item's configured tier, or the
 * default tier when the repo has been removed from configuration. `null`
 * keeps the kind's own rank (the primary repo).
 */
export function repoRankFor(item: CrqRecord, config: ScheduleConfig): number | null {
  const slug = typeof item.repo === 'string' && item.repo !== '' ? item.repo : config.primaryRepo;
  if (sameRepo(slug, config.primaryRepo)) return null;
  const wanted = repoIdentity(slug);
  const configured = config.repos.find((repo) => repoIdentity(repo.repo) === wanted);
  return configured ? configured.rank_tier : DEFAULT_REPO_RANK;
}

/** `crq.rank`: required open 0, open delta 1, merged/current 2, backlog 3, rank-4 work 4, optional 5. */
export function rank(item: CrqRecord, context: ScheduleContext): number {
  if (additionalCycle(item)) return 5;
  if (item.kind === 'open') return 0;
  if (item.kind === 'delta' && item.followup !== 'merged') return 1;
  if (item.kind === LOCAL_REVIEW_KIND) {
    // First review unless generation, an explicit repeat, or verified ancestry
    // classifies it as a repeat; branch continuity alone never counts.
    if (
      (item.generation === undefined ? 1 : item.generation) === 1 &&
      item.repeat_requested !== true &&
      item.ancestry_repeat !== true
    ) {
      return 0;
    }
    const created = parseUtc(item.created_at);
    const aged =
      created !== null &&
      context.nowMicros - created.epochMicros >=
        BigInt(context.config.localReviewAgingMinutes) * 60n * SECOND_MICROS;
    return aged ? 0 : 1;
  }
  const repoRank = repoRankFor(item, context.config);
  if (repoRank !== null) return repoRank;
  if (item.kind === REVIEW_RECEIPT_KIND) return 2;
  if (item.kind === 'coverage' || item.kind === BACKFILL_KIND) return COVERAGE_RANK;
  if (item.kind === AUTHOR_KIND) return AUTHOR_RANK;
  if (item.kind === 'delta') return 2;
  return item.source === 'followup' ? 2 : 3;
}

/** `crq.sort_key`: explicit operator priority, then rank, then insertion order. */
export function sortKey(
  item: CrqRecord,
  context: ScheduleContext,
): readonly [number, number, number] {
  const order = typeof item.order === 'number' ? item.order : 999;
  return [item.operator_priority === true ? 0 : 1, rank(item, context), order];
}

/** Compare two sort keys (Python tuple ordering). */
export function compareSortKeys(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The items in `crq.sort_key` order, stable like Python's `sorted`. */
export function sortItems(items: readonly CrqRecord[], context: ScheduleContext): CrqRecord[] {
  return [...items]
    .map((item, index) => ({ item, index, key: sortKey(item, context) }))
    .sort((left, right) => compareSortKeys(left.key, right.key) || left.index - right.index)
    .map((entry) => entry.item);
}

/** `crq.launch_band`: rank 0-1 work is interactive, everything else background. */
export function launchBand(
  item: CrqRecord,
  context: ScheduleContext,
): 'interactive' | 'background' {
  return rank(item, context) < 2 ? 'interactive' : 'background';
}

/** `crq.deps_met`: a missing/deleted dependency is satisfied; done/skipped and optional cycles too. */
export function depsMet(queue: CrqRecord, item: CrqRecord): boolean {
  const dependency = item.depends_on;
  if (!pythonTruthy(dependency)) return true;
  const found = liveItems(queue).find((candidate) => candidate.id === dependency);
  if (found === undefined) return true;
  return found.state === 'done' || found.state === 'skipped' || additionalCycle(found);
}

/** `crq.optional_wait`: a due optional cycle waits while rank <= 3 work is pending. */
export function optionalWait(queue: CrqRecord, item: CrqRecord, context: ScheduleContext): boolean {
  if (!additionalCycle(item)) return false;
  return liveItems(queue).some(
    (other) =>
      other !== item &&
      other.state === 'pending' &&
      rank(other, context) <= 3 &&
      !parkedMergedLinkedReceipt(queue, other),
  );
}

/** `backfill_jobs.is_execution_owner`, the rank-4 half of `inflight`. */
function isExecutionOwner(item: CrqRecord): boolean {
  const vendorState = item.vendor_state;
  return (
    vendorState === 'live' ||
    vendorState === 'unknown' ||
    pythonTruthy(item.run) ||
    item.state === 'reviewing' ||
    item.state === 'launch-unknown'
  );
}

/** `crq.inflight`: detached reviews plus rank-4 items that own execution. */
export function inflight(queue: CrqRecord): CrqRecord[] {
  return liveItems(queue).filter(
    (item) =>
      item.state === 'reviewing' ||
      ((item.kind === 'coverage' || item.kind === BACKFILL_KIND) && isExecutionOwner(item)),
  );
}

/** `crq.starts_last_hour`: journaled reservations inside the rolling hour. */
export function startsLastHour(queue: CrqRecord, nowMicros: bigint): number {
  const starts = queue.starts;
  if (starts === undefined) return 0;
  if (!Array.isArray(starts)) throw new TickScheduleError('queue.starts must be an array');
  const cutoff = nowMicros - HOUR_MICROS;
  let count = 0;
  for (const start of starts) {
    let instant: UtcInstant | null;
    try {
      instant = parseIso(start);
    } catch (error) {
      if (error instanceof UtcParseError) throw new TickScheduleError(error.message);
      throw error;
    }
    if (instant !== null && instant.epochMicros > cutoff) count += 1;
  }
  return count;
}

/** `crq.has_collectable_runs`: a detached review a minute-harvester must collect. */
export function hasCollectableRuns(queue: CrqRecord): boolean {
  return liveItems(queue).some((item) => item.state === 'reviewing' && pythonTruthy(item.run));
}

interface LaunchRecord {
  readonly runId: string;
  readonly started: bigint | null;
  readonly startedAtPresent: boolean;
  readonly band: unknown;
}

/**
 * `crq.background_turn`: true when the two most recent launches (including
 * running work) were both interactive. Unknown chronology supplies no credit.
 */
export function backgroundTurn(queue: CrqRecord): boolean {
  const items = queue.items;
  if (!Array.isArray(items)) throw new TickScheduleError('queue.items must be an array');
  const records = new Map<string, LaunchRecord>();
  for (const rawItem of items) {
    if (!isRecord(rawItem)) continue;
    const attempts: unknown[] = Array.isArray(rawItem.attempts) ? rawItem.attempts : [];
    const candidates: unknown[] = [...attempts];
    if (isRecord(rawItem.run)) candidates.push(rawItem.run);
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.run_id !== 'string') continue;
      const previous = records.get(candidate.run_id);
      const startedAt = candidate.started_at;
      if (previous === undefined || parseUtcLoose(startedAt) !== null) {
        records.set(candidate.run_id, {
          runId: candidate.run_id,
          started: parseUtcLoose(startedAt),
          startedAtPresent: startedAt !== undefined && startedAt !== null,
          band: candidate.band,
        });
      }
    }
  }
  const launches: LaunchRecord[] = [];
  for (const record of records.values()) {
    let started = record.started;
    let band: unknown = record.band === undefined ? 'background' : record.band;
    if (started === null) {
      started = parseUtcLoose(record.runId.slice(record.runId.lastIndexOf('-') + 1));
      // A present-but-malformed launch timestamp never extends a streak.
      if (record.startedAtPresent) band = 'background';
      if (started === null) continue;
    }
    launches.push({ ...record, started, band });
  }
  launches.sort((left, right) => {
    const difference = Number((left.started ?? 0n) - (right.started ?? 0n));
    if (difference !== 0) return difference < 0 ? -1 : 1;
    if (left.runId === right.runId) return 0;
    return left.runId < right.runId ? -1 : 1;
  });
  const latest = launches.slice(-2);
  return latest.length === 2 && latest.every((record) => record.band === 'interactive');
}

function parseUtcLoose(value: unknown): bigint | null {
  const instant = parseUtc(value);
  return instant === null ? null : instant.epochMicros;
}

/** One item `load_queue` retires: a superseded optional open cycle's debt. */
export interface RetiredOpen {
  /** Position in `queue.items`, so a plan can name the exact document pointer. */
  readonly index: number;
  readonly id: string;
  readonly state: 'done';
  readonly not_before: null;
  readonly last_error: null;
}

/**
 * `crq.load_queue`'s idempotent retirement of a superseded second-cycle debt:
 * an `open` item with a completed cycle that is still pending/blocked and is
 * not an explicit optional requeue becomes done. `boost` is dropped from every
 * live item, as Python does. The document is mutated in place; the returned
 * records are the exact post-load values a writer must persist.
 */
export function retireSupersededOpen(queue: CrqRecord): RetiredOpen[] {
  const retired: RetiredOpen[] = [];
  const items = queue.items;
  if (!Array.isArray(items)) throw new TickScheduleError('queue.items must be an array');
  for (let index = 0; index < items.length; index += 1) {
    const candidate: unknown = items[index];
    // Indices address the raw `queue.items` array, so a plan's pointer stays
    // valid even if a foreign writer left a non-object entry beside the rest.
    if (!isRecord(candidate) || candidate.kind === PROMOTION_KIND) continue;
    const item = candidate as Record<string, unknown>;
    delete item.boost;
    if (
      item.kind === 'open' &&
      completedOpenCycles(item) >= 1 &&
      (item.state === 'pending' || item.state === 'blocked') &&
      !pythonTruthy(item.optional_cycle)
    ) {
      item.state = 'done';
      item.not_before = null;
      item.last_error = null;
      retired.push({
        index,
        id: typeof item.id === 'string' ? item.id : '',
        state: 'done',
        not_before: null,
        last_error: null,
      });
    }
  }
  return retired;
}

/** Refuse a `repos` configuration ranking cannot read faithfully. */
export function repoRanks(config: CrqRecord): RepoRank[] {
  const repos = config.repos;
  if (repos === undefined || repos === null) return [];
  if (!Array.isArray(repos)) throw new TickScheduleError('config.repos must be an array');
  const ranks: RepoRank[] = [];
  for (const entry of repos) {
    if (!isRecord(entry) || typeof entry.repo !== 'string' || entry.repo === '') {
      throw new TickScheduleError('config.repos entries must name a repository');
    }
    const tier = entry.rank_tier === undefined ? DEFAULT_REPO_RANK : entry.rank_tier;
    if (
      typeof tier !== 'number' ||
      !Number.isInteger(tier) ||
      tier < MIN_REPO_RANK ||
      tier > MAX_REPO_RANK
    ) {
      throw new TickScheduleError(
        `config.repos rank_tier must be an integer in [${MIN_REPO_RANK}, ${MAX_REPO_RANK}]`,
      );
    }
    ranks.push({ repo: entry.repo, rank_tier: tier });
  }
  return ranks;
}
