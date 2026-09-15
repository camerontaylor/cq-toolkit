/** Minimal ambient types for proper-lockfile (the package ships none) — only what the ledger's pathLedgerStore uses. */
declare module 'proper-lockfile' {
  /** Options of proper-lockfile's lock/unlock (subset the ledger relies on). */
  export interface LockOptions {
    /** Duration in ms after which a held lock is considered stale (min 5000). */
    stale?: number;
    /** Acquire retries: a count or a `retry` package options object. */
    retries?: number | {
      retries?: number;
      factor?: number;
      minTimeout?: number;
      maxTimeout?: number;
      randomize?: boolean;
    };
    /** Resolve symlinks via realpath before locking; must be false when the target may not exist yet. */
    realpath?: boolean;
    /** Custom lockfile path (defaults to `<file>.lock`). */
    lockfilePath?: string;
  }
  /** Acquire a lock synchronously; returns the sync release function (throws on failure). */
  export function lockSync(file: string, options?: LockOptions): () => void;
  /** Release a lock synchronously (throws on failure, e.g. a compromised lock). */
  export function unlockSync(file: string, options?: LockOptions): void;
}
