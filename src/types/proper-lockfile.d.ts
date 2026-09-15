// Minimal ambient declaration for proper-lockfile (the runtime dependency
// ships no TypeScript types): only the surface the review registry uses —
// lock() resolves with a release function once acquired (undefined when it
// gives up without a retry policy) and REJECTS after the bounded retries
// are exhausted. The lockfile itself is a directory created beside the
// locked path: `<path>.lock`.
declare module 'proper-lockfile' {
  export interface LockOptions {
    /** Locks older than this many ms are considered stale and may be broken. */
    readonly stale?: number;
    /** How often (ms) the holder touches the lock to prove liveness. */
    readonly update?: number | null;
    /** Bounded acquire retries; exhausted retries REJECT with the error. */
    readonly retries?: {
      readonly retries: number;
      readonly minTimeout?: number;
      readonly maxTimeout?: number;
    };
  }
  export type Release = () => Promise<void>;
  export function lock(file: string, options?: LockOptions): Promise<Release | undefined>;
  export function unlock(file: string): Promise<void>;
}
