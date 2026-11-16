/* Inactive review process bindings. No runner route or capability is installed. */
import { spawn, execFile } from 'node:child_process';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { getSystemErrorMap, promisify } from 'node:util';
import { ReviewSpawnError } from '../../queue-runner/reviewLaunch.js';
import { atomicWrite } from './atomic.js';
import { launchDetached } from './process.js';

const exec = promisify(execFile);
function runDirectory(root: string, runId: string): string {
  if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
    throw new Error('invalid run id');
  return join(root, 'runs', runId);
}

/** Python OSError string, only for actual OS errors, not arbitrary adapter failures. */
function spawnError(error: unknown, omitPath = false): never {
  if (
    error instanceof Error &&
    'errno' in error &&
    typeof error.errno === 'number' &&
    error.errno < 0
  ) {
    const description = getSystemErrorMap().get(error.errno)?.[1];
    if (description) {
      const message = description.charAt(0).toUpperCase() + description.slice(1);
      const path =
        !omitPath && 'path' in error && typeof error.path === 'string' ? `: '${error.path}'` : '';
      throw new ReviewSpawnError(`[Errno ${-error.errno}] ${message}${path}`, { cause: error });
    }
  }
  throw error;
}

/** The supplied executable must eventually invoke the child body below; wiring is not provided here. */
export async function spawnReviewWrapper(options: {
  stateRoot: string;
  runId: string;
  cwd: string;
  executable: string;
  args: readonly string[];
}): Promise<number> {
  const dir = runDirectory(options.stateRoot, options.runId);
  let log;
  try {
    log = await open(join(dir, 'runner.log'), 'a');
  } catch (error) {
    return spawnError(error);
  }
  try {
    // Check the cwd before spawn so a known missing directory is not misreported
    // as a missing executable by Node. A later ENOENT remains ambiguous.
    try {
      const info = await stat(options.cwd);
      if (!info.isDirectory())
        throw new ReviewSpawnError(`[Errno 20] Not a directory: '${options.cwd}'`);
    } catch (error) {
      if (error instanceof ReviewSpawnError) throw error;
      return spawnError(error);
    }
    try {
      return await launchDetached(options.executable, [...options.args, options.runId], {
        cwd: options.cwd,
        stdout: log.fd,
        stderr: log.fd,
      });
    } catch (error) {
      return spawnError(
        error,
        error instanceof Error && 'code' in error && error.code === 'ENOENT',
      );
    }
  } finally {
    await log.close();
  }
}

interface Metadata {
  kind: string;
  cmd: string[];
  worktree: string;
}
function metadata(value: unknown): Metadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid review metadata');
  const data = value as Record<string, unknown>;
  if (
    typeof data.kind !== 'string' ||
    typeof data.worktree !== 'string' ||
    !Array.isArray(data.cmd) ||
    data.cmd.length === 0 ||
    !data.cmd.every((part: unknown) => typeof part === 'string')
  )
    throw new Error('invalid review metadata');
  return { kind: data.kind, worktree: data.worktree, cmd: data.cmd as string[] };
}

/** Callable only from an already detached session leader, never a tick entrypoint. */
export async function runReviewChild(options: {
  stateRoot: string;
  runId: string;
  timeoutMinutes: number;
  timeoutBinary?: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<number> {
  if (process.platform === 'win32') throw new Error('review process groups require POSIX');
  if (!Number.isSafeInteger(options.timeoutMinutes) || options.timeoutMinutes <= 0)
    throw new Error('invalid review timeout');
  const dir = runDirectory(options.stateRoot, options.runId);
  const metaRaw: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  if (
    metaRaw === null ||
    typeof metaRaw !== 'object' ||
    !('run_id' in metaRaw) ||
    metaRaw.run_id !== options.runId
  )
    throw new Error('review metadata run identity mismatch');
  const meta = metadata(metaRaw);
  const { stdout } = await exec('ps', ['-o', 'pgid=', '-o', 'sid=', '-p', String(process.pid)], {
    timeout: 20_000,
  });
  const parts = stdout.trim().split(/\s+/).map(Number);
  const [pgid, sid] = parts;
  if (parts.length !== 2 || pgid !== process.pid || sid !== process.pid)
    throw new Error('review child is not a detached session leader');
  process.on('SIGHUP', () => {});
  const identity = {
    run_id: options.runId,
    pid: process.pid,
    ppid: process.ppid,
    pgid,
    sid,
    group_owner: 'foreground-v1',
  };
  const pidPath = join(dir, 'review.pid');
  const save = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value) + '\n');
  await save(pidPath, identity);
  const now = options.now ?? (() => new Date());
  const iso = () => `${now().toISOString().slice(0, 19)}Z`;
  if (meta.kind === 'backfill') {
    await writeFile(
      join(dir, 'review.ndjson'),
      JSON.stringify({ type: 'error', message: 'backfill submission proof is not bound' }) + '\n',
    );
    await save(join(dir, 'exit.json'), {
      exit: 3,
      ended_at: iso(),
      timed_out: false,
      pre_vendor_refusal: true,
    });
    return 3;
  }
  const out = await open(join(dir, 'review.ndjson'), 'w');
  try {
    const err = await open(join(dir, 'stderr.log'), 'w');
    try {
      const child = spawn(
        options.timeoutBinary ?? 'timeout',
        ['--foreground', '--kill-after=60', `${options.timeoutMinutes}m`, ...meta.cmd],
        {
          cwd: meta.worktree,
          stdio: ['ignore', out.fd, err.fd],
          env: {
            ...options.env,
            CODERABBIT_CLI_DISABLE_AUTO_UPDATE: 'true',
            CODERABBIT_CLI_UPDATE_MANAGED: 'true',
          },
        },
      );
      const finished = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (code !== null) resolve(code);
          else if (signal && signal in osConstants.signals) resolve(-osConstants.signals[signal]);
          else reject(new Error('review process exited without status'));
        });
      });
      // Attach failure handler immediately: a failed identity write must not create an unhandled rejection.
      void finished.catch(() => {});
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (child.pid === undefined) throw new Error('review spawned without pid');
      await save(pidPath, { ...identity, cli_pid: child.pid });
      const exit = await finished;
      await save(join(dir, 'exit.json'), {
        exit,
        ended_at: iso(),
        timed_out: exit === 124 || exit === 137,
      });
      return 0;
    } finally {
      await err.close();
    }
  } finally {
    await out.close();
  }
}
