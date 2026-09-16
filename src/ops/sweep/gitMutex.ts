// Sweep lane (WS-D, goal D1) — the git-mutation MUTEX (UC §1 row 32; R2 D2):
// serialize one repo's git-mutating sections (worktree add/remove, branch
// pushes) across concurrent runs AND concurrent processes on one machine —
// interleaved index/refs mutations are exactly the corruption class the
// `.git/index.lock` wedge comes from. Library utility, NOT an op: it never
// appears in the family registry; a caller holds one mutex per repo root
// (ONE lock file per root is the granularity) and wraps sections in
// withLock. The guided default lockPath is `<repoRoot>/.cq/git-mutex.lock`;
// the on-disk artifact is `<lockPath>.lock` (proper-lockfile's documented
// derivation — a DIRECTORY, created by the atomic mkdir strategy).
//
// Built over proper-lockfile with the ledger store's idiom (store.ts):
// realpath off (the guarded path need not exist), mtime staleness, bounded
// acquire retries, and a non-throwing onCompromised. Two properties are
// load-bearing here:
//   - A STALE lock — mtime older than staleMs, the crashed-holder wedge —
//     is stolen by the acquire path, so a leftover lock can never wedge a
//     run forever; the recovery is observable via the onEvent hook.
//   - Exhausted retries REJECT with an error naming the lockPath and the
//     waiter budget — a contended mutex is never a silent proceed.
// Release happens when fn throws too (best-effort, the fn fault stays
// primary); a failed or compromised release on a SUCCESSFUL fn rejects —
// reporting ok while the lock may be racing a thief is never an option.
import { mkdirSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { lock } from 'proper-lockfile';

/** The default stale window (ms): an order of magnitude above any realistic git section, matching the ledger store's 30s disposition. */
export const DEFAULT_GIT_MUTEX_STALE_MS = 30_000;

/**
 * The default retry count. The backoff must OUTLIVE the stale window for
 * one-call crash recovery: a JUST-crashed holder's lock is not yet stale,
 * so acquire must still be retrying when staleness passes. At the 100ms
 * base, 9 retries give a ~51s backoff floor > the 30s window — the lock is
 * detected stale and stolen within the same withLock call.
 */
export const DEFAULT_GIT_MUTEX_RETRIES = 9;

/** The default backoff base (ms): exponential (factor 2) off this, randomized by the retry engine. */
export const DEFAULT_GIT_MUTEX_RETRY_BASE_MS = 100;

/**
 * proper-lockfile's stale floor: it clamps `stale` to ≥ 2000ms internally,
 * so a configured window below this would silently mean something else.
 * Configuration errors throw at construction — they are programmer errors,
 * not runtime faults.
 */
const MIN_STALE_MS = 2_000;

/**
 * Observability events, emitted synchronously, best-effort — never
 * load-bearing for correctness:
 *   - `stale-recovered` — the pre-acquire mtime probe saw an artifact
 *     older than staleMs and the acquire path is about to steal it (the
 *     probe is observational: a racing thief may have refreshed or removed
 *     the artifact first);
 *   - `acquired` — the lock is ours; `steal` mirrors whether the probe saw
 *     a stale artifact for THIS acquire;
 *   - `released` — the artifact was removed after a successful fn.
 */
export type GitMutexEvent =
  | { type: 'stale-recovered'; lockPath: string; ageMs: number }
  | { type: 'acquired'; lockPath: string; steal: boolean }
  | { type: 'released'; lockPath: string };

/** Configuration of {@link makeGitMutex}; every timing field has a shipped default. */
export interface GitMutexConfig {
  /**
   * The lock file path the mutex guards (one per repo root). The on-disk
   * artifact is `<lockPath>.lock`; the guided default is
   * `<repoRoot>/.cq/git-mutex.lock`. Caller-chosen so one machine can host
   * independent mutex domains.
   */
  lockPath: string;
  /** Stale window in ms (integer ≥ 2000, proper-lockfile's floor); default {@link DEFAULT_GIT_MUTEX_STALE_MS}. */
  staleMs?: number;
  /** Acquire retries after the first attempt (integer ≥ 0); default {@link DEFAULT_GIT_MUTEX_RETRIES}. */
  retries?: number;
  /** Exponential-backoff base in ms (integer ≥ 1); default {@link DEFAULT_GIT_MUTEX_RETRY_BASE_MS}. */
  retryBaseMs?: number;
  /** Optional observability hook (see {@link GitMutexEvent}). */
  onEvent?: (event: GitMutexEvent) => void;
}

/** A git-mutation mutex bound to one lock file. */
export interface GitMutex {
  /**
   * Run `fn` while holding the lock. Sync and async fns both fine (the
   * result is awaited); the fulfilled value is returned. Concurrent
   * callers — in this process or another — serialize on the artifact; a
   * caller whose retries run out is REJECTED, never run unlocked. fn
   * throwing releases best-effort and rethrows the fn fault as-is.
   */
  withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Build a git-mutation mutex over one lock file. Per acquire: mkdir -p of
 * the lock's parent (a first run's missing `.cq/` must not burn retries on
 * ENOENT — the ledger store's lesson), an mtime probe of the artifact for
 * staleness observability, then proper-lockfile's acquire with bounded
 * exponential backoff — a HELD lock is awaited; a STALE one (mtime older
 * than staleMs) is stolen by the acquire path, which is what keeps the
 * crashed-holder wedge class from ever wedging a run forever. Exhausted
 * retries reject naming the lockPath and the waiter budget. While held,
 * proper-lockfile refreshes the artifact's mtime (its ≥1000ms update clamp),
 * so a LIVE holder is never misclassified stale by a well-configured peer.
 */
export function makeGitMutex(config: GitMutexConfig): GitMutex {
  if (typeof config.lockPath !== 'string' || config.lockPath === '') {
    throw new RangeError('git-mutex: lockPath is required and must be a non-empty string');
  }
  const staleMs = config.staleMs ?? DEFAULT_GIT_MUTEX_STALE_MS;
  if (!Number.isInteger(staleMs) || staleMs < MIN_STALE_MS) {
    throw new RangeError(
      `git-mutex: staleMs (${String(staleMs)}) must be an integer ≥ ${String(MIN_STALE_MS)} — proper-lockfile clamps the stale window to that floor, and a config meaning less than it says is a misconfiguration`,
    );
  }
  const retries = config.retries ?? DEFAULT_GIT_MUTEX_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`git-mutex: retries (${String(retries)}) must be an integer ≥ 0`);
  }
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_GIT_MUTEX_RETRY_BASE_MS;
  if (!Number.isInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new RangeError(`git-mutex: retryBaseMs (${String(retryBaseMs)}) must be an integer ≥ 1`);
  }
  const onEvent = config.onEvent;
  const budgetMs = retryBaseMs * (2 ** retries - 1);
  // The artifact proper-lockfile derives from the guarded path (mkdir
  // strategy); the probe reads only its mtime, mirroring the library's own
  // isLockStale comparison.
  const artifactPath = `${config.lockPath}.lock`;

  return {
    async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
      mkdirSync(dirname(config.lockPath), { recursive: true });
      let steal = false;
      try {
        const stat: Stats = statSync(artifactPath);
        const ageMs = Date.now() - stat.mtime.getTime();
        if (ageMs > staleMs) {
          steal = true;
          if (onEvent !== undefined) {
            onEvent({ type: 'stale-recovered', lockPath: config.lockPath, ageMs });
          }
        }
      } catch {
        // No artifact (or unreadable): nothing stale to report — the
        // acquire itself surfaces any real fault.
      }
      // onCompromised MUST NOT be the library default: it throws
      // asynchronously from the mtime-refresh timer, outside every try
      // here, process-killing (the ledger store's PR #109 lesson). It is
      // recorded instead and surfaced on the release path below.
      let compromised: Error | undefined;
      let release: () => Promise<void>;
      try {
        release = await lock(config.lockPath, {
          realpath: false,
          stale: staleMs,
          retries: { retries, factor: 2, minTimeout: retryBaseMs },
          onCompromised: (err) => {
            compromised = err;
          },
        });
      } catch (err) {
        throw new Error(
          `git-mutex: could not acquire '${config.lockPath}' — still held after the waiter budget (${String(retries)} retries, ~${String(budgetMs)} ms backoff floor at ${String(retryBaseMs)} ms base, stale window ${String(staleMs)} ms) — ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (onEvent !== undefined) {
        onEvent({ type: 'acquired', lockPath: config.lockPath, steal });
      }
      let value: T;
      try {
        value = await Promise.resolve().then(fn);
      } catch (fnErr) {
        // fn already failed: its fault is primary; release is best-effort.
        await release().catch(() => undefined);
        throw fnErr;
      }
      try {
        await release();
      } catch (releaseErr) {
        throw new Error(
          `git-mutex: release of '${config.lockPath}' failed — ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
          { cause: releaseErr },
        );
      }
      if (compromised !== undefined) {
        throw new Error(
          `git-mutex: lock '${config.lockPath}' was compromised while held — ${compromised instanceof Error ? compromised.message : String(compromised)}`,
          { cause: compromised },
        );
      }
      if (onEvent !== undefined) {
        onEvent({ type: 'released', lockPath: config.lockPath });
      }
      return value;
    },
  };
}
