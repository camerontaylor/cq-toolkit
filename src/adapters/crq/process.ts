import { spawn } from 'node:child_process';

/** Launch a durable session leader; output descriptors are owned by the caller. */
export async function launchDetached(
  command: string,
  args: readonly string[],
  options: { cwd: string; stdout: number; stderr: number; env?: NodeJS.ProcessEnv },
): Promise<number> {
  if (process.platform === 'win32') throw new Error('Detached process groups require POSIX');
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', options.stdout, options.stderr],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Spawn succeeded without pid');
  child.unref();
  return pid;
}

/** Treat errors other than a proven absent group as alive. */
export function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
