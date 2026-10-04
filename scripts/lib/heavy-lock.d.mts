/** Type boundary for the standalone JavaScript host-lock helper. */
export const LOCK_PATH: string;
export const EX_TEMPFAIL: 75;
export const MISSING_OWNER_MS: number;
export const MAX_HOLD_MS: number;
export const REPORT_EVERY_MS: number;
export interface LockOwner {
  pid: number;
  token: string;
  host: string;
  cwd: string;
  command: string;
  startedAt: string;
}
export interface LockDeps {
  fs: typeof import('node:fs');
  now: () => number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  pid: number;
  token: () => string;
}
export function isAlive(pid: number): boolean;
export function readOwner(dir: string, fs?: typeof import('node:fs')): LockOwner | null;
export function staleReason(
  holder: LockOwner | null,
  dirMtimeMs: number,
  deps: { now: number; isAlive: (pid: number) => boolean },
): string | null;
export function describeHolder(holder: LockOwner | null): string;
export function acquireLock(input: {
  path?: string;
  maxWaitMs: number;
  info: { cwd: string; command: string };
  deps?: Partial<LockDeps>;
}): Promise<
  | { acquired: true; waitedMs: number; release: () => void }
  | { acquired: false; waitedMs: number; holder: LockOwner | null }
>;
