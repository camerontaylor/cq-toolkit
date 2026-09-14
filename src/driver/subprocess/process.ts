// Child-process mechanics for the subprocess driver — T1.5 slice 1.
//
// I8 EXEMPTION (the ONE file under src/driver/** allowed to own scheduling
// primitives — the driver-hygiene scan exempts exactly this path,
// src/driver/subprocess/process.ts): the SIGTERM→SIGKILL grace ladder lives
// here because here the kernel has ALREADY DECIDED to kill (the governed
// signal from currentJobContext() fired — I8: the governor decides WHEN to
// abort, the driver only obeys) and this helper only EXECUTES that decision
// against a real OS process. It never decides to start a termination on its
// own: `terminateGracefully` is called by the driver purely as a reaction
// to the governed signal. Consequences, by design:
//   - every timer in this file is an EXECUTION detail of a decided kill
//     (the grace windows between rungs), never a scheduling policy;
//   - the delays are INJECTABLE (`GraceLadderOptions.delay`) so tests run
//     the ladder deterministically without real wall time.
//
// NO SHELL: `spawnManaged` uses node:child_process spawn with `shell:false`
// — the driver builds argv element-by-element, so nothing the caller wrote
// is ever re-interpreted by a shell. Env injection is an explicit override
// map merged over process.env (the CLI needs PATH/HOME etc. to function);
// per-Route vars (endpoint base URL, auth token) ride that override map.
//
// SPAWN FAILURES ARE DATA, NOT THROWS: a missing binary (ENOENT) surfaces
// on `close` as `spawnError` — the driver maps it to a stopReason 'error'
// WorkerResult and NEVER throws past the frozen seam once spawned.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// ---------------------------------------------------------------------------
// spawnManaged — the managed child
// ---------------------------------------------------------------------------

/** How to spawn one CLI run. All plain data. */
export interface SpawnOptions {
  /** The executable (resolved by the caller from its `binary` option). */
  command: string;
  /** Argv elements, driver-built — never a shell string. */
  args: readonly string[];
  /** Working directory: the invocation's workspace (I6 isolation boundary). */
  cwd: string;
  /** Env overrides merged over process.env (per-Route endpoint + auth vars). */
  env?: Readonly<Record<string, string>>;
  /** When set, written to the child's stdin and the pipe closed (prompt piping). */
  stdin?: string;
}

/** How the child process closed, with everything the driver harvested. */
export interface ProcessClose {
  /** Exit code (null when killed by signal or never spawned). */
  code: number | null;
  /** Terminating signal, when killed. */
  signal: NodeJS.Signals | null;
  /** Set when the process never ran (e.g. ENOENT — a missing binary). */
  spawnError?: Error;
  /** Complete collected stdout. */
  stdout: string;
  /** Complete collected stderr. */
  stderr: string;
}

/**
 * A spawned child under the driver's management: line-oriented stdout
 * (stream-json events as they arrive — session ids surface mid-run), whole
 * stderr capture, prompt piping, signal delivery, and a `close` promise
 * that always settles (spawn failure included).
 */
export interface ManagedChild {
  /** OS pid, undefined when the process never spawned. */
  readonly pid: number | undefined;
  /** Resolves once the process closed (exit + streams flushed) or failed to spawn. */
  readonly close: Promise<ProcessClose>;
  /** True once `close` has settled (sync check for the ladder). */
  readonly exited: boolean;
  /** Subscribe to complete stdout lines (no trailing newline). */
  onStdoutLine(listener: (line: string) => void): void;
  /** Subscribe to complete stderr lines (no trailing newline). */
  onStderrLine(listener: (line: string) => void): void;
  /** Write a chunk to the child's stdin. EPIPE after child death is swallowed. */
  writeStdin(chunk: string): void;
  /** Close the child's stdin (half-close: the CLI reads the prompt to EOF). */
  endStdin(): void;
  /** Deliver a signal; false when it could not be delivered (already gone). */
  kill(signal: NodeJS.Signals): boolean;
}

/** Whole-text accumulation + line streaming for one stdio pipe. */
interface StreamCollector {
  onChunk(chunk: string): void;
  /** Emit a final unterminated line at close (a truncated stream is still evidence). */
  flush(): void;
  /** The complete collected text. */
  readonly text: string;
}

/** Collect one pipe's text and stream its complete lines (no trailing newline) to listeners. */
function createCollector(listeners: Array<(line: string) => void>): StreamCollector {
  let all = '';
  let rest = '';
  return {
    onChunk(chunk: string): void {
      all += chunk;
      rest += chunk;
      let index = rest.indexOf('\n');
      while (index !== -1) {
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        for (const listener of listeners) listener(line);
        index = rest.indexOf('\n');
      }
    },
    flush(): void {
      if (rest !== '') {
        for (const listener of listeners) listener(rest);
        rest = '';
      }
    },
    get text(): string {
      return all;
    },
  };
}

/**
 * Spawn the CLI headless: no shell, piped stdio, cwd = workspace, env
 * overrides per Route. Stdout is split into complete lines (streamed to
 * listeners as they arrive; a final unterminated line is flushed at close)
 * and also accumulated whole on the `close` result; stderr likewise.
 */
export function spawnManaged(opts: SpawnOptions): ManagedChild {
  const stdoutListeners: Array<(line: string) => void> = [];
  const stderrListeners: Array<(line: string) => void> = [];
  const stdout = createCollector(stdoutListeners);
  const stderr = createCollector(stderrListeners);
  let spawnError: Error | undefined;
  let exited = false;

  const child: ChildProcessWithoutNullStreams = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    shell: false, // driver-built argv — nothing is ever re-interpreted by a shell
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.onChunk(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.onChunk(chunk));

  // Spawn failure (ENOENT — missing binary; EACCES …): captured as data.
  // 'close' still fires afterwards, so the single settle path stays 'close'.
  child.on('error', (err: Error) => {
    spawnError ??= err;
  });

  let settleClose!: (close: ProcessClose) => void;
  const close = new Promise<ProcessClose>((resolve) => {
    settleClose = resolve;
  });
  child.on('close', (code, signal) => {
    exited = true;
    stdout.flush();
    stderr.flush();
    settleClose({
      code,
      signal,
      ...(spawnError !== undefined ? { spawnError } : {}),
      stdout: stdout.text,
      stderr: stderr.text,
    });
  });

  // A dead child's full stdin pipe surfaces as EPIPE — a write into a
  // closed pipe is a no-op here, never a crash (the error event already
  // carries the real diagnosis).
  child.stdin.on('error', () => {});

  if (opts.stdin !== undefined) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }

  return {
    pid: child.pid,
    close,
    get exited(): boolean {
      return exited;
    },
    onStdoutLine(listener: (line: string) => void): void {
      stdoutListeners.push(listener);
    },
    onStderrLine(listener: (line: string) => void): void {
      stderrListeners.push(listener);
    },
    writeStdin(chunk: string): void {
      child.stdin.write(chunk);
    },
    endStdin(): void {
      child.stdin.end();
    },
    kill(signal: NodeJS.Signals): boolean {
      try {
        return child.kill(signal); // ChildProcess.kill needs no IPC channel
      } catch {
        return false; // already gone — the ladder treats this as progress
      }
    },
  };
}

// ---------------------------------------------------------------------------
// terminateGracefully — the SIGTERM→SIGKILL grace ladder
// ---------------------------------------------------------------------------

/** Grace defaults: generous, and mirror the governor's pre-spike graces (src/kernel/governor.ts). */
export const DEFAULT_TERM_GRACE_MS = 2_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** One observable ladder rung: WHICH signal fired, WHEN (epoch ms). */
export interface TerminationRungMarker {
  rung: 'sigterm' | 'sigkill';
  atMs: number;
}

/** How the ladder ended. 'terminated' = died on SIGTERM; 'killed' = needed SIGKILL (or ignored even that). */
export type TerminationOutcome = 'terminated' | 'killed';

/** Ladder options: the two grace windows plus the INJECTABLE delay (tests substitute fake time). */
export interface GraceLadderOptions {
  /** SIGTERM → SIGKILL grace in ms. Default DEFAULT_TERM_GRACE_MS. */
  termGraceMs?: number;
  /** SIGKILL → force-resolve grace in ms. Default DEFAULT_KILL_GRACE_MS. */
  killGraceMs?: number;
  /**
   * Injectable wait between rungs. Default: a real (unref'd) timeout —
   * the ONLY scheduling primitive under src/driver/**, allowed here
   * because it executes an already-decided kill (see the file header).
   */
  delay?: (ms: number) => Promise<void>;
}

/** Default inter-rung wait: a host timeout, unref'd so a pending grace window never holds the event loop open. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref(); // grace windows are execution details, not keep-alives
  });
}

/**
 * THE GRACE LADDER (executes an already-made kill decision — header):
 *
 *   already exited → resolve 'terminated' immediately, no rungs (nothing
 *                    was sent — the markers stay honest);
 *   SIGTERM  → mark { rung:'sigterm' }, send SIGTERM, wait `termGraceMs`;
 *              exits in the window → 'terminated';
 *   SIGKILL  → mark { rung:'sigkill' }, send SIGKILL, wait `killGraceMs`;
 *              exits in the window → 'killed';
 *   still alive after SIGKILL → force-resolve 'killed' (an unstoppable
 *              process must not hang the governed run; its `close` listener
 *              stays attached so a late exit is still recorded, just no
 *              longer awaited).
 *
 * `onRung` observes each marker as it fires. An `onRung`/`kill` throw is
 * contained: the ladder continues to the next rung (the same isolation
 * contract as the governor's ladder observers).
 */
export async function terminateGracefully(
  child: ManagedChild,
  opts: GraceLadderOptions = {},
  onRung?: (marker: TerminationRungMarker) => void,
): Promise<TerminationOutcome> {
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const wait = opts.delay ?? defaultDelay;
  /** true as soon as the child is closed (never rejects). */
  const closed = (): Promise<boolean> => child.close.then(
    () => true,
    () => true,
  );
  /** Wait the grace window; true if the child closed FIRST. */
  const closesWithin = (ms: number): Promise<boolean> =>
    Promise.race([closed(), wait(ms).then(() => false)]);

  if (child.exited) {
    return 'terminated'; // nothing to signal — no rungs fired
  }

  // Rung 1: SIGTERM — the cooperative rung (a well-behaved CLI flushes and exits).
  fireRung(onRung, 'sigterm');
  child.kill('SIGTERM');
  if (await closesWithin(termGraceMs)) {
    return 'terminated';
  }

  // Rung 2: SIGKILL — the unconditional rung.
  fireRung(onRung, 'sigkill');
  child.kill('SIGKILL');
  if (await closesWithin(killGraceMs)) {
    return 'killed';
  }

  // Force-resolve: the kill decision has been executed to its hardest rung;
  // the governed run must settle even if the OS cannot reap the process.
  return 'killed';
}

/** Fire one rung marker; an observer throw must never break the ladder. */
function fireRung(
  onRung: ((marker: TerminationRungMarker) => void) | undefined,
  rung: TerminationRungMarker['rung'],
): void {
  try {
    onRung?.({ rung, atMs: Date.now() });
  } catch {
    // deliberately swallowed — the ladder continues to the next rung
  }
}
