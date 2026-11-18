import { checkoutWriterStdio, trackCheckoutWriter } from '../shared/checkoutWriterContext.js';
import { spawn } from 'node:child_process';
import { registerProcessSignalCleanup } from '../shared/process-signals.js';
import { DEFAULT_KILL_GRACE_MS, MAX_KILL_GRACE_MS } from './config.js';

/** POSIX platforms get per-command process groups (`detached` + group kill). */
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// runShellCommand — one `run` command in its own process group
// ---------------------------------------------------------------------------

/** How one shell command ended: a normal exit, a kill, or a failed spawn. */
export type RunOutcome =
  | {
      kind: 'exit';
      code: number;
      stdout: string;
      stderr: string;
      overflowed: boolean;
      /** The post-kill grace closed the pipes before `close`: output may be cut short. */
      incomplete?: boolean;
    }
  | {
      kind: 'killed';
      stdout: string;
      stderr: string;
      overflowed: boolean;
      /** The post-kill grace closed the pipes before `close`: output may be cut short. */
      incomplete?: boolean;
    }
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
  /**
   * How long `close` may lag a kill of ours before finalization stops waiting;
   * per-op CONFIG data (`bash.killGraceMs`), defaulting to the config default.
   */
  killGraceMs?: number;
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
        stdio: checkoutWriterStdio(['ignore', 'pipe', 'pipe']),
        ...(POSIX ? { detached: true } : {}),
      });
    } catch (err) {
      settle({ kind: 'spawn-error', error: err });
      return;
    }
    // The checkout writer may treat this child as drained only when a `close`
    // proves the pipes ended on their own. A grace-forced finalize below
    // destroys the pipes while a descendant outside the killed group may still
    // hold them, so the `close` that destroy manufactures reconciles nothing:
    // the drain gate resolves only on a close reached without forced
    // destruction, keeping `isComplete()`/`complete()` honest.
    let markDrained!: () => void;
    const drained = new Promise<void>((done) => {
      markDrained = done;
    });
    trackCheckoutWriter(child, drained);
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

    let settled = false;
    let graceExpired = false;
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined;
    // Armed by a kill of ours: a descendant outside the killed group can hold
    // the inherited pipes open forever, so waiting for `close` may never end.
    const armFinalize = (): void => {
      if (finalizeTimer !== undefined) return;
      finalizeTimer = setTimeout(
        () => {
          graceExpired = true;
          finalize(null, null);
        },
        Math.min(opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS, MAX_KILL_GRACE_MS),
      );
    };

    let killedByUs = false;
    const killGroup = (): void => {
      killedByUs = true;
      armFinalize();
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
    const unregisterSignalCleanup = registerProcessSignalCleanup(() => {
      killGroup(); // in-process tool groups also belong to the executable
      return undefined; // the existing abort path already uses SIGKILL
    });
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(killGroup, opts.timeoutMs);
    opts.signal?.addEventListener('abort', killGroup, { once: true });

    let spawnError: unknown;
    // `close` waits for BOTH pipes, so a backgrounded descendant (`cmd &`) that
    // inherits stdout/stderr can delay it past the command's own exit. Record
    // the real code at `exit` — only while no kill of ours has happened yet —
    // so a timeout or abort landing in that gap cannot relabel a finished
    // command as `killed` and drop the exit it actually reached.
    let exitedCleanly: number | undefined;
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!killedByUs && signal === null && code !== null) exitedCleanly = code;
    });
    child.on('error', (e: unknown) => {
      spawnError ??= e;
    });
    // Finalization is bounded and runs exactly once: either when `close` says
    // both pipes are done, or when the post-kill grace expires because a
    // descendant outside the killed group still holds them. Either way the
    // capture streams are released, the timer/listeners/cleanup hooks are
    // removed, and the promise settles — so a timeout or cancellation can
    // never leave the runner pending. A grace-forced destroy is not a drain
    // proof: it must not release the checkout writer's child tracking (the
    // close handler resolves that gate only when `graceExpired` is false).
    function finalize(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      if (finalizeTimer !== undefined) clearTimeout(finalizeTimer);
      unregisterSignalCleanup();
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', killGroup);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.stdout?.destroy();
      child.stderr?.destroy();
      const stdout = Buffer.concat(out.chunks).toString('utf8');
      const stderr = Buffer.concat(err.chunks).toString('utf8');
      if (spawnError !== undefined && child.pid === undefined) {
        settle({ kind: 'spawn-error', error: spawnError });
      } else if (exitedCleanly !== undefined) {
        // The command finished on its own before any kill of ours: its exit is
        // the truth, whatever the (possibly late) close reports.
        settle({
          kind: 'exit',
          code: exitedCleanly,
          stdout,
          stderr,
          overflowed,
          ...(graceExpired ? { incomplete: true } : {}),
        });
      } else if (killedByUs || signal !== null || code === null) {
        settle({
          kind: 'killed',
          stdout,
          stderr,
          overflowed,
          ...(graceExpired ? { incomplete: true } : {}),
        });
      } else {
        settle({ kind: 'exit', code, stdout, stderr, overflowed });
      }
    }
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // Reconcile the checkout writer before settling: a close arriving after
      // the grace-forced finalize was manufactured by the pipe destruction, so
      // it must never count as drained.
      if (!graceExpired) markDrained();
      finalize(code, signal);
    });
  });
}
