/* Inactive review process bindings. No runner route or capability is installed. */
import { spawn, execFile } from 'node:child_process';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { getSystemErrorMap, promisify } from 'node:util';
import { ReviewSpawnError } from '../../queue-runner/reviewLaunch.js';
import { atomicWrite } from './atomic.js';
import { backfillSubmissionProof, BackfillSubmissionRefused } from './backfillSubmission.js';
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
  backfill?: { head: string; base: string; attemptId: string };
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
  const meta: Metadata = { kind: data.kind, worktree: data.worktree, cmd: data.cmd as string[] };
  if (data.kind === 'backfill') {
    const attempt = (data.backfill as { attempt_id?: unknown } | null | undefined)?.attempt_id;
    // A malformed backfill identity is a refusal at proof time, not a crash.
    if (
      typeof data.head === 'string' &&
      typeof data.base === 'string' &&
      typeof attempt === 'string'
    )
      meta.backfill = { head: data.head, base: data.base, attemptId: attempt };
  }
  return meta;
}

const KILL_AFTER_SECONDS = 60;

/** `review_wrapper_argv`: `--foreground` keeps the review in the runner's own group. */
export function reviewWrapperArgv(
  cmd: readonly string[],
  timeoutMinutes: number,
  timeoutBinary = 'timeout',
): string[] {
  return [
    timeoutBinary,
    '--foreground',
    `--kill-after=${KILL_AFTER_SECONDS}`,
    `${timeoutMinutes}m`,
    ...cmd,
  ];
}

/** Live (non-zombie) members of a process group other than `self`. */
async function groupMembers(pgid: number, self: number): Promise<number[]> {
  const listing = exec('ps', ['-e', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], {
    timeout: 20_000,
  });
  // The ps process is itself a member of this group while it runs.
  const lister = listing.child.pid;
  const { stdout } = await listing;
  const members: number[] = [];
  for (const line of stdout.split('\n')) {
    const [pid, group, stat] = line.trim().split(/\s+/);
    if (
      Number(group) === pgid &&
      Number(pid) !== self &&
      Number(pid) !== lister &&
      !(stat ?? '').startsWith('Z')
    )
      members.push(Number(pid));
  }
  return members;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, or not ours to signal: the next poll decides.
    }
  }
}

/**
 * `timeout --foreground` signals only its direct child, so descendants of the review
 * command stay in the runner's group after it exits. The group cannot be signalled
 * wholesale (that would stop this runner), so terminate every other live member
 * individually: TERM, then KILL after the grace. Throws if one survives KILL, so the
 * terminal record is never written over a still-running review. A descendant that
 * left the group (its own `setsid`) stays outside this cleanup.
 */
async function reapGroup(pgid: number, self: number, graceMs: number): Promise<void> {
  let members = await groupMembers(pgid, self);
  if (members.length === 0) return;
  signalAll(members, 'SIGTERM');
  // Each poll spawns `ps`, so back off geometrically (100 ms doubling to a 2 s cap):
  // a 60 s grace costs about 35 listings, not 600, while a quick exit is still seen fast.
  const wait = async (limitMs: number): Promise<void> => {
    let delay = 100;
    for (let waited = 0; waited < limitMs;) {
      const step = Math.min(delay, limitMs - waited);
      await sleep(step);
      waited += step;
      members = await groupMembers(pgid, self);
      if (members.length === 0) return;
      delay = Math.min(delay * 2, 2000);
    }
  };
  await wait(graceMs);
  if (members.length === 0) return;
  signalAll(members, 'SIGKILL');
  await wait(10_000);
  if (members.length > 0) throw new Error('review descendants survived SIGKILL');
}

/** Ask systemd to run the tick now; the periodic timer remains the recovery path. */
async function kickTick(): Promise<void> {
  try {
    await exec('systemctl', ['--user', '--no-block', 'start', 'crq-tick.service'], {
      timeout: 10_000,
    });
  } catch {
    // Non-systemd host, missing binary, non-zero exit or timeout: all tolerated.
  }
}

/** Callable only from an already detached session leader, never a tick entrypoint. */
export async function runReviewChild(options: {
  stateRoot: string;
  runId: string;
  timeoutMinutes: number;
  timeoutBinary?: string;
  env: NodeJS.ProcessEnv;
  /** Test seams for the backfill proof (version probe and git). */
  backfillProof?: Pick<Parameters<typeof backfillSubmissionProof>[0], 'runGit' | 'version'>;
  /** Test seam for the post-exit tick kick; defaults to `systemctl --user --no-block start`. */
  kick?: () => Promise<void>;
  /** Grace between TERM and KILL for leftover group members; defaults to the timeout's 60 s. */
  descendantGraceMs?: number;
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
  const reviewerEnv = {
    ...options.env,
    CODERABBIT_CLI_DISABLE_AUTO_UPDATE: 'true',
    CODERABBIT_CLI_UPDATE_MANAGED: 'true',
  };
  if (meta.kind === 'backfill') {
    try {
      if (meta.backfill === undefined)
        throw new BackfillSubmissionRefused('backfill run metadata is incomplete');
      const proof = await backfillSubmissionProof({
        runId: options.runId,
        worktree: meta.worktree,
        cmd: meta.cmd,
        head: meta.backfill.head,
        base: meta.backfill.base,
        attemptId: meta.backfill.attemptId,
        env: reviewerEnv,
        ...options.backfillProof,
      });
      await save(join(dir, 'submission.json'), proof);
    } catch (error) {
      // Python catches ValueError/RuntimeError/OSError/SubprocessError. Any Error is a
      // refusal here: an uncaught crash would leave no exit.json and strand the run.
      if (!(error instanceof Error)) throw error;
      await writeFile(
        join(dir, 'review.ndjson'),
        JSON.stringify({ type: 'error', message: error.message }) + '\n',
      );
      await save(join(dir, 'exit.json'), {
        exit: 3,
        ended_at: iso(),
        timed_out: false,
        pre_vendor_refusal: true,
      });
      return 3;
    }
  }
  const out = await open(join(dir, 'review.ndjson'), 'w');
  try {
    const err = await open(join(dir, 'stderr.log'), 'w');
    try {
      const [wrapper, ...wrapperArgs] = reviewWrapperArgv(
        meta.cmd,
        options.timeoutMinutes,
        options.timeoutBinary,
      );
      const child = spawn(wrapper as string, wrapperArgs, {
        cwd: meta.worktree,
        stdio: ['ignore', out.fd, err.fd],
        env: reviewerEnv,
      });
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
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
      } catch (error) {
        // The reviewer never started: leave a terminal record (shell convention, 127 for
        // a missing executable, 126 otherwise) so the run is not stranded without
        // exit.json, kick the tick to reconcile it, then surface the failure.
        await save(join(dir, 'exit.json'), {
          exit: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 126,
          ended_at: iso(),
          timed_out: false,
        });
        await (options.kick ?? kickTick)();
        throw error;
      }
      if (child.pid === undefined) throw new Error('review spawned without pid');
      try {
        await save(pidPath, { ...identity, cli_pid: child.pid });
      } catch (error) {
        // A failed identity write must not leave an unrecorded review running: stop the
        // spawned wrapper itself and wait for it to exit. Never signal the process group;
        // the wrapper shares the group recorded above, so a group signal also stops us.
        child.kill('SIGTERM');
        await finished.catch(() => {});
        throw error;
      }
      const exit = await finished;
      // The terminal record and tick kick wait until no descendant is still running.
      await reapGroup(pgid, process.pid, options.descendantGraceMs ?? KILL_AFTER_SECONDS * 1000);
      // GNU timeout exits 124 when it sends TERM at the deadline; a `--kill-after` SIGKILL
      // (or an external KILL) can surface as 137. Both record as timed_out without inferring
      // the cause. `--foreground` keeps timeout out of the group-wide KILL, so a signal
      // exit (-9) is a plain failure, matching Python's negative returncode.
      await save(join(dir, 'exit.json'), {
        exit,
        ended_at: iso(),
        timed_out: exit === 124 || exit === 137,
      });
      await (options.kick ?? kickTick)();
      return 0;
    } finally {
      await err.close();
    }
  } finally {
    await out.close();
  }
}
