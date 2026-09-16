/** Minimal ambient types for proper-lockfile (the package ships none) — only what the ledger's pathLedgerStore uses. */
declare module 'proper-lockfile' {
  /** Options of proper-lockfile's lock (the subset the ledger relies on). */
  export interface LockOptions {
    /** Duration in ms after which a held lock is considered stale (clamped to ≥ 2000 by the library). */
    stale?: number;
    /** Interval in ms at which the holder refreshes the lock's mtime (defaults to stale/2, min 1000). */
    update?: number;
    /** Acquire retries: a count or a `retry` package options object ({retries, factor, minTimeout, maxTimeout}). */
    retries?:
      | number
      | {
          retries?: number;
          factor?: number;
          minTimeout?: number;
          maxTimeout?: number;
          randomize?: boolean;
        };
    /** Resolve symlinks via realpath before locking; must be false when the target may not exist yet. */
    realpath?: boolean;
    /** Called (instead of the default ASYNC THROW) when the held lock is found compromised — stolen after staleness, removed, or its refresh faulted. */
    onCompromised?: (err: Error) => void;
    /** Custom lockfile path (defaults to `<file>.lock`). */
    lockfilePath?: string;
  }
  /**
   * Acquire a lock; resolves to an async release function (call when the
   * critical section ends; rejects if the lock was compromised). With
   * `retries` configured, acquisition backs off and retries instead of
   * failing fast on a held lock.
   */
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  /** Release a lock acquired with {@link lock} (rejects on failure, e.g. a compromised lock). */
  export function unlock(file: string, options?: LockOptions): Promise<void>;
}
