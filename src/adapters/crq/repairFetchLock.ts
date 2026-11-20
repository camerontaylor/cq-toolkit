/**
 * Inactive file/git bindings of the repair drain's `fetchClone` and
 * `withAdmissionLock` effects (`RepairDrainEffects`): Python
 * `crq_repair.fetch_clone` and `crq_repair.cooldown_write`.
 *
 * Both take the one canonical `<stateRoot>/tick.lock` (the tick's own file)
 * through the shared flock helper (`lock.ts`), so they exclude the tick and
 * each other exactly as the Python processes do. Nothing imports this module
 * from a runtime entry point.
 *
 * `fetchClone` (`fetch_clone`): poll the lock without blocking, sleeping
 * `min(5 s, remaining)` between attempts, for `repair.tick_lock_wait_s`
 * seconds (default 300; always at least one attempt). A busy lock past the
 * deadline is the string `crq tick holds tick.lock`; the pass is skipped, never
 * raced. Under the lock it runs `git fetch --prune --quiet origin` in the
 * clone with a 60 s bound (below the tick's 90 s lock wait) and returns
 * `clone fetch failed: <stderr.strip()>` for a non-zero exit, or
 * `clone fetch failed: <str(exc)>` when the call raised: Python's
 * `TimeoutExpired` text, or the `[Errno N] ...: '<path>'` text of an OS error.
 * The lock covers the whole fetch and is released on every path. An error
 * opening or validating the lock itself is not a fetch failure and rejects,
 * as it raises in Python.
 *
 * `withAdmissionLock` (`cooldown_write`): block, with no bound, for the lock and
 * hold it across the one admission callback only, never across worker waits or
 * provider calls.
 *
 * Deliberate differences, all documented rather than hidden:
 * - the shared helper opens the lock `O_RDWR|O_NOFOLLOW` without truncation and
 *   refuses a replaced inode; Python opens `'w'`/`'a'` and follows a symlink.
 *   Nothing writes into `tick.lock`, so only the symlink refusal is observable;
 * - the fetch child's stdin is `/dev/null` (Python inherits the daemon's);
 * - stderr is decoded as lossy UTF-8; Python's strict decode would instead
 *   surface a `UnicodeDecodeError` text. Both skip the pass;
 * - SIGTERM, then SIGKILL after 5 s, goes to the child's own process group, as
 *   `command()` does; the options expose the bounds only so tests can shrink
 *   them.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { pythonStrip } from '../../policy/crq/repairBinding.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { withLock } from './lock.js';
import { osErrorText } from './repairClassifySource.js';

/** `TICK_LOCK_WAIT_S`. */
const DEFAULT_LOCK_WAIT_S = 300;
/** Longest single sleep between lock attempts (`min(5.0, remaining)`). */
const POLL_MAX_S = 5;
/** `remaining < 0.001` ends the wait. */
const POLL_EPSILON_S = 0.001;
/** `command(..., timeout=60)`. */
const FETCH_TIMEOUT_MS = 60_000;
/** `command()`'s SIGTERM-to-SIGKILL grace (`communicate(timeout=5)`). */
const TERM_GRACE_MS = 5_000;
const FETCH_ARGV: readonly string[] = ['fetch', '--prune', '--quiet', 'origin'];

/** The call's outcome; a raised Python exception is a rejection whose message is its `str()`. */
export interface FetchCallResult {
  /** Exit status; a signal death is non-zero, as Python's negative `returncode`. */
  readonly code: number;
  readonly stderr: string;
}

/** Run the fetch in `clone`. Test seam; the default spawns the real `git`. */
export type RunFetch = (clone: string) => Promise<FetchCallResult>;

export interface RepairFetchCloneOptions {
  /** The state root (`ROOT / 'state'`): holds `tick.lock`. */
  readonly stateRoot: string;
  /** `config['clone']`. */
  readonly clone: string;
  /** `config['repair'].get('tick_lock_wait_s')`; `undefined` when the key is absent. */
  readonly tickLockWait?: () => Promise<JsonValue | undefined>;
  /** Test seam; defaults to a real, bounded `git fetch`. */
  readonly runFetch?: RunFetch;
  /** Fetch bound and kill grace; the Python values unless a test shrinks them. */
  readonly fetchTimeoutMs?: number;
  readonly termGraceMs?: number;
  /** Child environment of the default runner; `process.env` when absent, like `command()`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Monotonic clock in milliseconds (`time.monotonic`). */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RepairAdmissionLockOptions {
  /** The state root (`ROOT / 'state'`): holds `tick.lock`. */
  readonly stateRoot: string;
}

/** `repair.tick_lock_wait_s` as Python computes `time.monotonic() + lock_wait`. */
function lockWaitSeconds(raw: JsonValue | undefined): number {
  if (raw === undefined) return DEFAULT_LOCK_WAIT_S;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (raw instanceof JsonNumber) {
    if (raw.integer !== null) {
      const seconds = Number(raw.integer);
      if (!Number.isFinite(seconds)) throw new RangeError('int too large to convert to float');
      return seconds;
    }
    return raw.float ?? Number.NaN;
  }
  const kind =
    raw === null
      ? 'NoneType'
      : typeof raw === 'string'
        ? 'str'
        : Array.isArray(raw)
          ? 'list'
          : raw instanceof JsonObject
            ? 'dict'
            : 'object';
  throw new TypeError(`unsupported operand type(s) for +: 'float' and '${kind}'`);
}

/** Python's `str(subprocess.TimeoutExpired)` for the fixed fetch argv. */
function timeoutText(timeoutMs: number): string {
  const cmd = `[${['git', ...FETCH_ARGV].map((arg) => `'${arg}'`).join(', ')}]`;
  return `Command '${cmd}' timed out after ${String(timeoutMs / 1000)} seconds`;
}

/** `command(['git', 'fetch', ...], cwd=clone, timeout=60)`. */
function spawnFetch(
  options: Pick<RepairFetchCloneOptions, 'env' | 'fetchTimeoutMs' | 'termGraceMs'>,
): RunFetch {
  const timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const graceMs = options.termGraceMs ?? TERM_GRACE_MS;
  return (clone) =>
    new Promise<FetchCallResult>((resolve, reject) => {
      // Python's Popen reports a bad cwd, not the command, in its OSError.
      try {
        if (!statSync(clone).isDirectory()) {
          reject(new Error(osErrorText({ code: 'ENOTDIR' }, clone)));
          return;
        }
      } catch (error) {
        reject(new Error(osErrorText(error, clone)));
        return;
      }
      const child = spawn('git', [...FETCH_ARGV], {
        cwd: clone,
        ...(options.env ? { env: options.env } : {}),
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true, // `start_new_session=True`: this command's own process group.
      });
      const pieces: Buffer[] = [];
      child.stderr.on('data', (piece: Buffer) => pieces.push(piece));
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs);
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(new Error(osErrorText(error, 'git')));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (timedOut) {
          reject(new Error(timeoutText(timeoutMs)));
          return;
        }
        resolve({ code: code ?? -1, stderr: Buffer.concat(pieces).toString('utf8') });
      });
    });
}

/** `fetch_clone(config)`: an error string skips the drain pass, `null` is a fetched clone. */
export function fileRepairFetchClone(
  options: RepairFetchCloneOptions,
): () => Promise<string | null> {
  const lockPath = join(options.stateRoot, 'tick.lock');
  const runFetch = options.runFetch ?? spawnFetch(options);
  const nowMs = options.nowMs ?? ((): number => performance.now());
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)));

  async function fetchUnderLock(): Promise<string | null> {
    try {
      const fetched = await runFetch(options.clone);
      return fetched.code !== 0 ? `clone fetch failed: ${pythonStrip(fetched.stderr)}` : null;
    } catch (error) {
      // Python's `except Exception`: a timeout or an OS error is a skipped pass.
      return `clone fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return async () => {
    const raw = options.tickLockWait ? await options.tickLockWait() : undefined;
    await mkdir(options.stateRoot, { recursive: true });
    const deadline = nowMs() + lockWaitSeconds(raw) * 1000;
    for (;;) {
      let entered = false;
      try {
        return await withLock(lockPath, { wait: false }, () => {
          entered = true;
          return fetchUnderLock();
        });
      } catch (error) {
        // Only a busy lock is retried; anything the held section threw is not.
        if (entered || !(error instanceof SlotBusyError)) throw error;
      }
      const remaining = (deadline - nowMs()) / 1000;
      if (remaining < POLL_EPSILON_S) return 'crq tick holds tick.lock';
      await sleep((remaining < POLL_MAX_S ? remaining : POLL_MAX_S) * 1000);
    }
  };
}

/** `cooldown_write()`: `state/tick.lock` held across one admission, waiting without bound. */
export function fileRepairAdmissionLock(
  options: RepairAdmissionLockOptions,
): <T>(admission: () => Promise<T>) => Promise<T> {
  const lockPath = join(options.stateRoot, 'tick.lock');
  return async (admission) => {
    await mkdir(options.stateRoot, { recursive: true });
    return withLock(lockPath, { wait: true }, admission);
  };
}
