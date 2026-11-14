/**
 * The publisher's off-lock coverage refresh (`backfill_coverage.run` +
 * `refresh`): bring each target's persisted snapshot to the freshly fetched
 * ledger sequence after publication moved the head.
 *
 * Python parity, kept exactly:
 *
 * - Runs under the persistent `backfill/coverage.lock` inode, fetches the
 *   ledger through the publisher-owned clone under `backfill/publisher.lock`
 *   (so this once-a-minute worker never moves the scheduler checkpoint), and
 *   never touches `tick.lock`.
 * - Idle unless selection left a `backfill/coverage-request.json` marker or a
 *   publication moved the head. The queue read (without `tick.lock`) may
 *   predate the save that enqueued a target, so the request's own targets are
 *   always added.
 * - A request written while the refresh ran survives for the next run (the
 *   marker is removed only when its bytes are still the ones read).
 * - Targets are sorted; one bad target (`invalid-target`) or one failing fold
 *   (`error: ...`) never blocks the others, and snapshots for targets no live
 *   job uses are pruned.
 * - A refresh that could change admission (`extended`/`full`) wakes the next
 *   one-minute slot; `unchanged`/`current` do not, so a state-only head move
 *   cannot cause a minute-by-minute loop.
 *
 * Accounting (artifacts, `verify_review`, lineage/blame carry) is injected as
 * `CoverageRepository`; the git binding is `src/adapters/crq/coverageSource.ts`.
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, fsyncDir } from '../../adapters/crq/atomic.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerValidateSequence,
} from '../../policy/crq/ledger.js';
import {
  COVERAGE_DIRECTORY,
  COVERAGE_REQUEST,
  coverageLiveTargets,
  coveragePendingTargets,
  coveragePrefixDigest,
  coverageRefreshOutcome,
  coverageRefreshPlan,
  coverageRequestTargets,
  coverageSnapshotDocument,
  coverageSnapshotPath,
  coverageSortedTargets,
  parseCoverageSnapshot,
  type CoverageSnapshot,
} from '../../policy/crq/coverageSnapshot.js';
import { parseQueueBytes } from './publishRun.js';

/** Python's `str(exc)[:200]` slice used for a per-target refresh error. */
const ERROR_CHARS = 200;

function truncated(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return [...text].slice(0, ERROR_CHARS).join('');
}

/**
 * Python's `accounting.Repository` surface the refresher uses. `fold` adds each
 * creditable review's verified credit at `target`; failures are recorded as
 * gaps for that review, never raised.
 */
export interface CoverageRepository {
  /** Start one refresher pass: enable immutable caches, retry prior gaps. */
  beginInvocation(): void;
  fold(
    target: string,
    reviews: readonly JsonValue[],
    verifyArtifact: (reference: {
      readonly sha256: string;
      readonly location: string;
    }) => Promise<void>,
    covered: Map<string, Set<number>>,
    gaps: JsonValue[],
  ): Promise<void>;
}

/** The refresher's injected accounting seams. */
export interface CoverageRefreshEffects {
  /** Absolute state root (`state/`). */
  readonly stateRoot: string;
  readonly repository: CoverageRepository;
  /** The durable artifact verifier (`ArtifactStore.verify`). */
  readonly verifyArtifact: (reference: {
    readonly sha256: string;
    readonly location: string;
  }) => Promise<void>;
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  return readFile(path).then(
    (bytes) => new Uint8Array(bytes),
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function snapshotPathOrNull(stateRoot: string, target: string): string | null {
  try {
    return coverageSnapshotPath(stateRoot, target);
  } catch (error) {
    if (error instanceof LedgerIntegrityError) return null;
    throw error;
  }
}

async function readSnapshot(stateRoot: string, target: string): Promise<CoverageSnapshot | null> {
  const path = snapshotPathOrNull(stateRoot, target);
  if (path === null) return null;
  const bytes = await readBytes(path).catch(() => null);
  return bytes === null ? null : parseCoverageSnapshot(bytes, target);
}

/**
 * `backfill_coverage.refresh`: fold each target's snapshot forward and persist
 * it. Returns `{target: outcome}` where the outcome is `current`,
 * `unchanged`, `extended`, `full`, `invalid-target` or `error: ...`.
 */
export async function refreshCoverage(
  effects: CoverageRefreshEffects,
  events: readonly JsonValue[],
  targets: Iterable<string>,
  keep: Iterable<string> = [],
): Promise<Record<string, string>> {
  ledgerValidateSequence(events);
  effects.repository.beginInvocation();
  // Python's `ledger.atomic` creates the snapshot's parent on first write; a
  // fresh state root has no `backfill/coverage` yet.
  await mkdir(join(effects.stateRoot, COVERAGE_DIRECTORY), { recursive: true });
  const outcome: Record<string, string> = {};
  for (const target of coverageSortedTargets(targets)) {
    if (snapshotPathOrNull(effects.stateRoot, target) === null) {
      // One bad target never blocks the rest.
      outcome[target] = 'invalid-target';
      continue;
    }
    try {
      outcome[target] = await refreshOne(effects, events, target);
    } catch (error) {
      // Isolate: the remaining targets still refresh.
      outcome[target] = `error: ${truncated(error)}`;
    }
  }
  const directory = join(effects.stateRoot, COVERAGE_DIRECTORY);
  const keepSet = new Set(keep);
  const names = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    if (stem in outcome || keepSet.has(stem)) continue;
    await unlink(join(directory, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return outcome;
}

/** `backfill_coverage._refresh_one` with the persisted snapshot write. */
async function refreshOne(
  effects: CoverageRefreshEffects,
  events: readonly JsonValue[],
  target: string,
): Promise<'current' | 'unchanged' | 'extended' | 'full'> {
  const snapshot = await readSnapshot(effects.stateRoot, target);
  const plan = coverageRefreshPlan(snapshot, events);
  if (plan.current) return 'current';
  const covered = new Map<string, Set<number>>();
  for (const [name, lines] of plan.covered) covered.set(name, new Set(lines));
  const gaps: JsonValue[] = [];
  await effects.repository.fold(target, plan.todo, effects.verifyArtifact, covered, gaps);
  const path = coverageSnapshotPath(effects.stateRoot, target);
  await atomicWrite(
    path,
    ledgerCanonicalBytes(
      coverageSnapshotDocument({
        target,
        events: events.length,
        prefix: coveragePrefixDigest(events, events.length),
        covered,
        gaps,
      }),
    ),
  );
  // Python sets `snapshot = None` on the full-recompute branch, so the outcome
  // must classify against the plan's snapshot (a stale prefix is `full`).
  return coverageRefreshOutcome(plan.snapshot, plan.validBefore, covered, gaps);
}

/** The runner-facing refresher effects (one publisher run). */
export interface CoverageRunEffects extends CoverageRefreshEffects {
  /** `runtime.settings(STATE)`: the rollout document, or null when absent. */
  settings(): Promise<JsonObject | null>;
  /** Unlocked queue read (Python's `load_queue` without persistence). */
  readQueue(): Promise<Uint8Array>;
  /** `ledger.locked(backfill/coverage.lock)` (waiting, persistent inode). */
  withCoverageLock<T>(fn: () => Promise<T>): Promise<T>;
  /** `ledger.locked(backfill/publisher.lock)`. */
  withPublisherLock<T>(fn: () => Promise<T>): Promise<T>;
  /** `worker_services(...).fetch()` over the publisher-owned clone. */
  fetchLedger(
    config: JsonObject,
  ): Promise<{ readonly head: string; readonly values: readonly JsonValue[] }>;
  /** `usage_slots.write_next(state/next-review-at, c.iso())`. */
  wakeSlot(isoSeconds: string): Promise<void>;
  /** `c.iso()`: `YYYY-MM-DDTHH:MM:SSZ`. */
  nowIso(): string;
}

/** The refresher's JSON result (`coverage.run`'s dict). */
export interface CoverageRunResult {
  readonly head: string;
  readonly targets: Record<string, string>;
}

/**
 * `backfill_coverage.run`: the off-lock refresher the publisher runs after
 * publication. `disabled` when no rollout is provisioned, `idle` when neither
 * a request nor a published head asked for a refresh.
 */
export async function runCoverageRefresh(
  effects: CoverageRunEffects,
  publishedHead?: string,
): Promise<CoverageRunResult | 'disabled' | 'idle'> {
  const config = await effects.settings();
  if (config === null) return 'disabled';
  const requestPath = join(effects.stateRoot, COVERAGE_REQUEST);
  if ((await readBytes(requestPath)) === null && publishedHead === undefined) {
    return 'idle';
  }
  const result = await effects.withCoverageLock(async (): Promise<CoverageRunResult | 'idle'> => {
    const requested = await readBytes(requestPath);
    if (requested === null && publishedHead === undefined) return 'idle';
    // A read-only snapshot of the queue: targets only, never saved here.
    const parsed = parseQueueBytes(await effects.readQueue());
    if (!(parsed instanceof JsonObject)) throw new TypeError('queue must be an object');
    const targets = coveragePendingTargets(parsed);
    if (requested !== null) {
      let value: JsonValue | undefined;
      try {
        value = ledgerLoads(requested);
      } catch {
        value = undefined;
      }
      for (const target of coverageRequestTargets(value)) targets.add(target);
    }
    const { head, values } = await effects.withPublisherLock(() => effects.fetchLedger(config));
    const outcome = await refreshCoverage(effects, values, targets, coverageLiveTargets(parsed));
    // A request written while we computed survives for the next run.
    if (requested !== null) {
      const latest = await readBytes(requestPath);
      if (latest !== null && bytesEqual(latest, requested)) {
        await unlink(requestPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await fsyncDir(join(effects.stateRoot, 'backfill'));
      }
    }
    return { head, targets: outcome };
  });
  if (result === 'idle') return result;
  if (Object.values(result.targets).some((value) => value === 'extended' || value === 'full')) {
    // Wake the next one-minute slot rather than its quota-paced deadline:
    // jobs that waited on this refresh may now admit. Python wakes after
    // releasing the refresher lock, so a slow slot write cannot delay another
    // target's refresh.
    await effects.wakeSlot(effects.nowIso());
  }
  return result;
}
