/** Type boundary for the standalone JavaScript host-lock helper. */
export const LOCK_PATH: string;
export const EX_TEMPFAIL: 75;
export const MISSING_OWNER_MS: number;
export const MAX_HOLD_MS: number;
export const REPORT_EVERY_MS: number;
export const GUARD_STALE_MS: number;
export interface LockOwner {
  pid: number;
  token: string;
  host: string;
  cwd: string;
  command: string;
  startedAt: string;
  childPgid?: number;
  childPending?: boolean;
  /** ISO time recorded before a child spawn. */
  childPendingAt?: string;
  /** ISO start time of the child group's leader, recorded with childPgid. */
  childStartedAt?: string;
}
export interface LockDeps {
  fs: typeof import('node:fs');
  now: () => number;
  isAlive: (pid: number, startedAt?: string) => boolean;
  processStartMs: (pid: number) => number | null;
  groupAlive: (pgid: number) => boolean;
  killGroup: (pgid: number) => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  pid: number;
  token: () => string;
}
export function isAlive(pid: number, startedAt?: string): boolean;
export function readOwner(dir: string, fs?: typeof import('node:fs')): LockOwner | null;
export interface JudgeDeps {
  now: number;
  isAlive: (pid: number, startedAt?: string) => boolean;
  groupAlive: (pgid: number) => boolean;
  processStartMs: (pid: number) => number | null;
}
export function judgeHolder(
  holder: LockOwner | null,
  dirMtimeMs: number,
  deps: JudgeDeps,
): { reason: string | null; kill?: number; note?: string };
export function describeHolder(holder: LockOwner | null): string;
export function acquireLock(input: {
  path?: string;
  maxWaitMs: number;
  info: { cwd: string; command: string };
  deps?: Partial<LockDeps>;
}): Promise<
  | {
      acquired: true;
      waitedMs: number;
      release: () => void;
      stillHeld: () => boolean;
      annotate: (fields: {
        childPgid?: number | null;
        childPending?: boolean;
      }) => LockOwner | undefined;
    }
  | { acquired: false; waitedMs: number; holder: LockOwner | null }
>;

export function canSignalGroup(
  holder: Pick<LockOwner, 'childPgid' | 'childStartedAt'> | null,
  deps?: Pick<LockDeps, 'isAlive' | 'groupAlive' | 'processStartMs'>,
): boolean;
