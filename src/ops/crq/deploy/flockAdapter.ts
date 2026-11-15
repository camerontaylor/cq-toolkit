/** Production `tryLock` for the deploy lock: a `flock(1)` child holds the kernel
 * `flock(2)` lock, exactly what `fcntl.flock(LOCK_EX | LOCK_NB)` in
 * `apps/crq-python/ops/deploy-runbook.py` takes, so a Python holder and a TypeScript
 * holder exclude each other. The child's lifetime is bound to ours by its stdin: it
 * runs `cat` until EOF, so releasing, crashing or being killed closes the pipe, the
 * child exits and the kernel drops the lock. Inactive: nothing imports this module.
 *
 * Structurally implements `LockFs` / `LockHandle` of `deployGuards.ts` (#1833).
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export interface FlockHandle {
  release(): Promise<void>;
}
export interface FlockProc {
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (error: Error) => void): void;
  closeStdin(): void;
  kill(): void;
}
export type SpawnFlock = (args: readonly string[]) => FlockProc;

/** flock(1) exit status for "would block"; distinct from any command failure. */
export const BUSY_EXIT = 75;
const HELD = 'held\n';

export function flockArgs(path: string): string[] {
  return [
    '-x',
    '-n',
    '-E',
    String(BUSY_EXIT),
    path,
    'sh',
    '-c',
    `printf '${HELD.slice(0, -1)}\\n'; exec cat >/dev/null`,
  ];
}

export const spawnFlock: SpawnFlock = (args) => {
  const child = spawn('flock', [...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdout.setEncoding('utf8');
  // The write end can EPIPE if the child is already gone; that is not an error here.
  child.stdin.on('error', () => undefined);
  return {
    onStdout: (cb) => void child.stdout.on('data', (c: string) => cb(c)),
    onExit: (cb) => void child.once('exit', (code) => cb(code)),
    onError: (cb) => void child.once('error', cb),
    closeStdin: () => void child.stdin.end(),
    kill: () => void child.kill('SIGKILL'),
  };
};

export interface FlockLockFs {
  mkdirp(dir: string): Promise<void>;
  tryLock(path: string): Promise<FlockHandle | null>;
}

export function flockLockFs(
  options: { spawn?: SpawnFlock; releaseGraceMs?: number } = {},
): FlockLockFs {
  const start = options.spawn ?? spawnFlock;
  const grace = options.releaseGraceMs ?? 5_000;
  return {
    mkdirp: async (dir) => void (await mkdir(dir, { recursive: true })),
    tryLock: (path) =>
      new Promise<FlockHandle | null>((resolve, reject) => {
        const proc = start(flockArgs(path));
        let acquired = false;
        let exited = false;
        let buffer = '';
        const exitWaiters: (() => void)[] = [];
        proc.onError((e) => {
          exited = true;
          if (!acquired) reject(new Error(`cannot run flock(1) for ${path}: ${e.message}`));
          exitWaiters.splice(0).forEach((w) => w());
        });
        proc.onExit((code) => {
          exited = true;
          exitWaiters.splice(0).forEach((w) => w());
          if (acquired) return;
          if (code === BUSY_EXIT) resolve(null);
          else reject(new Error(`flock(1) exited ${String(code)} before acquiring ${path}`));
        });
        proc.onStdout((chunk) => {
          buffer += chunk;
          if (acquired || !buffer.includes(HELD)) return;
          acquired = true;
          let released: Promise<void> | null = null;
          resolve({
            release: () =>
              (released ??= new Promise<void>((done) => {
                if (exited) return done();
                const timer = setTimeout(() => proc.kill(), grace);
                exitWaiters.push(() => {
                  clearTimeout(timer);
                  done();
                });
                proc.closeStdin();
              })),
          });
        });
      }),
  };
}
