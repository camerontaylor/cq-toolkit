import { spawn } from 'node:child_process';

/** POSIX platforms get per-command process groups (`detached` + group kill). */
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// runShellCommand — one `run` command in its own process group
// ---------------------------------------------------------------------------

/** How one shell command ended: a normal exit, a kill, or a failed spawn. */
export type RunOutcome =
  | { kind: 'exit'; code: number; stdout: string; stderr: string; overflowed: boolean }
  | { kind: 'killed'; stdout: string; stderr: string; overflowed: boolean }
  | { kind: 'spawn-error'; error: unknown };

/** Inputs to one shell command execution — plain data plus the cancellation signal. */
export interface RunCommandOptions {
  /** Explicit default-deny environment, composed by the harness core. */
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** Per-stream retention bound in bytes. */
  maxBytes: number;
  /** Per-command wall clock; on expiry the whole process group is killed. */
  timeoutMs?: number;
  /** Cancellation: abort kills the whole process group. */
  signal?: AbortSignal;
}

/**
 * Run `command` through the platform shell (`/bin/sh -c` on POSIX, as
 * `exec` did), cwd = workspace, stdin closed. On POSIX the shell LEADS ITS
 * OWN PROCESS GROUP, so a timeout or an abort signals `-pid` and reaches
 * every descendant; Windows has no groups in v1 and kills the direct child
 * only (the same limitation the subprocess lane records). The kill is
 * SIGKILL: the decision to stop has already been made (timeout, cancel, or
 * harness shutdown), and a command that traps SIGTERM must not outlive it.
 * Never rejects — a spawn failure is data.
 */
export function runShellCommand(command: string, opts: RunCommandOptions): Promise<RunOutcome> {
  return spawnAndCollect(command, [], opts, true);
}

/** Execute harness-owned argv without a shell, sharing the shell path's lifecycle. */
export function runArgvCommand(
  file: string,
  args: readonly string[],
  opts: RunCommandOptions,
): Promise<RunOutcome> {
  return spawnAndCollect(file, args, opts, false);
}

function spawnAndCollect(
  file: string,
  args: readonly string[],
  opts: RunCommandOptions,
  shell: boolean,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((settle) => {
    if (opts.signal?.aborted === true) {
      settle({ kind: 'killed', stdout: '', stderr: '', overflowed: false });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        shell,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(POSIX ? { detached: true } : {}),
      });
    } catch (err) {
      settle({ kind: 'spawn-error', error: err });
      return;
    }
    const collect = (): { chunks: Buffer[]; bytes: number } => ({ chunks: [], bytes: 0 });
    const out = collect();
    const err = collect();
    let overflowed = false;
    const retain = (sink: { chunks: Buffer[]; bytes: number }, chunk: Buffer): void => {
      const room = opts.maxBytes - sink.bytes;
      if (chunk.length > room) overflowed = true; // keep draining, stop retaining
      if (room <= 0) return;
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      sink.chunks.push(kept);
      sink.bytes += kept.length;
    };
    child.stdout?.on('data', (chunk: Buffer) => retain(out, chunk));
    child.stderr?.on('data', (chunk: Buffer) => retain(err, chunk));

    let killedByUs = false;
    const killGroup = (): void => {
      killedByUs = true;
      if (POSIX && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // group already gone — fall through to the direct kill
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(killGroup, opts.timeoutMs);
    opts.signal?.addEventListener('abort', killGroup, { once: true });

    let spawnError: unknown;
    child.on('error', (e: unknown) => {
      spawnError ??= e;
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', killGroup);
      const stdout = Buffer.concat(out.chunks).toString('utf8');
      const stderr = Buffer.concat(err.chunks).toString('utf8');
      if (spawnError !== undefined && child.pid === undefined) {
        settle({ kind: 'spawn-error', error: spawnError });
      } else if (killedByUs || signal !== null || code === null) {
        settle({ kind: 'killed', stdout, stderr, overflowed });
      } else {
        settle({ kind: 'exit', code, stdout, stderr, overflowed });
      }
    });
  });
}
