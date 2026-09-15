// Process-lifecycle helpers for the acp driver — T1.8.
//
// THE I8 EXEMPT FILE (same posture as the subprocess and claude-agent
// lanes' process.ts): the driver-hygiene scan bans driver-owned
// scheduling primitives under src/driver/**, with the single exemption
// `driver/<name>/process.{ts,js,mjs}` — process-lifecycle helpers may own
// timers, because there the decision has ALREADY BEEN MADE. This file owns
// exactly the timer machines below:
//
//   - `spawnAcpProcess` — the shell-less spawn of the harness binary
//     (driver-built argv, piped stdio, cwd = the invocation's workspace).
//     Spawn FAILURES ARE DATA: a missing/unspawnable binary surfaces on
//     the exit promise (`spawnError`), never as a throw past the seam
//     (the pre-dispatch resolution in ./binaries.ts is what throws).
//
//   - `terminateAcpProcess` — the SIGTERM→SIGKILL grace ladder that
//     terminates the one-per-run harness process AT SETTLE. The driver
//     decides NOTHING about WHEN a run aborts (the governed signal from
//     currentJobContext() decides; the cooperative path is
//     session/cancel + awaiting the prompt response); this ladder only
//     executes the already-made decision that a settled run's child must
//     die — the vendor's in-process session dies with the child we
//     terminate at settle (strategy §6). Every timer here is an
//     EXECUTION detail of a decided kill, never a scheduling policy, and
//     the delays are INJECTABLE (`delay`) so tests run deterministically.
//
//   - `raceWithGrace` — the bounded grace racing the courtesy
//     session/cancel write in the governed-abort path (Codex P1, round
//     4): the kill the write precedes is ALREADY DECIDED when the race
//     starts, so its default 250 ms window is execution machinery of that
//     decision — the decided kill must never depend on the cooperation of
//     the thing being killed (a backpressured child that never drains its
//     stdin can hold the write open forever).
//
// NO RETRIES, one spawn per run (R2): nothing in this file re-spawns.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// spawnAcpProcess — the managed spawn seam
// ---------------------------------------------------------------------------

/** How to spawn one harness process. All plain data; `env` is the FULL child environment (caller-composed). */
export interface AcpSpawnOptions {
  /** The resolved binary (from ./binaries.ts). */
  command: string;
  /** Argv elements after the binary — driver-built, never a shell string. */
  args: readonly string[];
  /** Working directory: the invocation's workspace (I6 isolation boundary). */
  cwd: string;
  /** The FULL child environment (process.env + the driver's resolved additions). */
  env: Readonly<Record<string, string>>;
}

/** The spawn seam: `spawnAcpProcess` by default; tests wrap it to record calls / merge env. */
export type AcpSpawnFn = (opts: AcpSpawnOptions) => ChildProcess;

/**
 * win32 shim translation (review-debt #54/#55): Node's CVE-2024-27980
 * hardening throws EINVAL for a DIRECT shell-less spawn of a .cmd/.bat
 * file — while the PATH walk (issue #40) now deliberately RESOLVES those
 * shims, since npm-installed bare commands ship as .cmd shims on Windows.
 * The resolution's finds must therefore be launched through cmd.exe:
 * `/d` skips AutoRun scripts, `/s` makes cmd apply its full quoting rules
 * to everything after `/c` (the Node-documented shape for .bat/.cmd), and
 * the whole command line rides ONE verbatim token. PURE argv mapping —
 * unit-tested on every platform; the routing is win32-only at runtime,
 * keyed on the injectable platform (unobservable on the linux/macOS
 * suite, like the PATHEXT walk itself).
 */
export function argvForShimSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // ONE OUTER QUOTE PAIR around the whole /c string (PR #119 review,
    // Codex P1): with /s and verbatim args, cmd strips the FIRST and LAST
    // quote of the string after /c — without the outer pair it strips the
    // element-level quotes this translation exists to preserve (a
    // space-bearing shim path still parsed as its first token). The outer
    // pair is the documented sacrifice; the element quotes survive.
    const inner = [cmdQuote(command), ...args.map(cmdQuote)].join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: [...args], windowsVerbatimArguments: false };
}

/**
 * Quote ONE argv element for the cmd.exe /s /c command string (PR #111
 * review, Codex P1): a bare join(' ') destroys every element boundary —
 * a path like `C:\Program Files\nodejs\z.cmd` parses as `C:\Program`,
 * and a two-word argument splits in two. An element containing whitespace,
 * a quote, or a cmd metacharacter is wrapped in double quotes with
 * internal quotes doubled (the MSVCRT-at-the-callee convention); with /s,
 * cmd applies its full quoting rules to the string after /c. Residual,
 * documented: %-expansion cannot be escaped in cmd — argv elements are
 * DRIVER CONFIGURATION (trusted input), not untrusted data, so the
 * boundary-preservation goal is met without pretending to full cmd
 * escaping.
 */
function cmdQuote(element: string): string {
  if (element === '') return '""';
  if (/[\s"&|<>^()%!]/.test(element)) {
    return `"${element.replace(/"/g, '""')}"`;
  }
  return element;
}

/**
 * Spawn the harness binary: no shell, piped stdio, cwd = workspace.
 * stdout/stderr are utf8-decoded; a write into a dead child's stdin
 * (EPIPE) is swallowed — the exit promise carries the real diagnosis.
 */
export function spawnAcpProcess(opts: AcpSpawnOptions): ChildProcess {
  const spec = argvForShimSpawn(opts.command, opts.args);
  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    shell: false, // driver-built argv — nothing is ever re-interpreted by a shell
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...opts.env },
    // Only ever set on the win32 shim path (ignored elsewhere): the /s
    // token must reach cmd.exe verbatim, not node-quoted.
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdin?.on('error', () => {
    // deliberately swallowed — EPIPE after child death is a no-op
  });
  return child;
}

// ---------------------------------------------------------------------------
// Exit capture
// ---------------------------------------------------------------------------

/** How the harness process ended, with everything the driver harvested. */
export interface AcpExitInfo {
  /** Exit code (null when killed by signal or never spawned). */
  code: number | null;
  /** Terminating signal, when killed. */
  signal: NodeJS.Signals | null;
  /** Set when the process never ran (e.g. ENOENT — see the header). */
  spawnError?: Error;
}

/** Synchronous liveness check (the ladder's first rung decision). */
export function isAcpProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * The child's exit, as a promise that ALWAYS settles: 'close' (exit +
 * stdio flushed) or 'error' (spawn failure — ENOENT et al), whichever
 * fires first. A late second event is ignored.
 */
export function acpExitPromise(child: ChildProcess): Promise<AcpExitInfo> {
  return new Promise<AcpExitInfo>((resolve) => {
    let settled = false;
    let spawnError: Error | undefined;
    const done = (info: AcpExitInfo): void => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    child.once('error', (err: Error) => {
      spawnError ??= err;
      done({ code: null, signal: null, ...(spawnError !== undefined ? { spawnError } : {}) });
    });
    child.once('close', (code, signal) => {
      done({
        code,
        signal,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// terminateAcpProcess — the SIGTERM→SIGKILL grace ladder (I8 exempt machinery)
// ---------------------------------------------------------------------------

/** Grace defaults: mirror the subprocess lane's ladder (generous; execution details, not policy). */
export const DEFAULT_TERM_GRACE_MS = 2_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;
/**
 * The bounded grace racing the courtesy session/cancel write before the
 * decided kill executes anyway (Codex P1, round 4): the write rides the
 * same stdin a backpressured prompt may have wedged, so its settlement can
 * never be a precondition of the kill. Short by design — it buys the
 * vendor only a fair head start over the SIGTERM, never a veto.
 */
export const DEFAULT_CANCEL_WRITE_GRACE_MS = 250;

/** One observable ladder rung: WHICH signal fired, WHEN (epoch ms). */
export interface TerminationRungMarker {
  rung: 'sigterm' | 'sigkill';
  atMs: number;
}

/** How the ladder ended. 'terminated' = died on SIGTERM (or was already gone); 'killed' = needed SIGKILL. */
export type TerminationOutcome = 'terminated' | 'killed';

/** Ladder options: the two grace windows plus the INJECTABLE delay (tests substitute fake time). */
export interface AcpGraceLadderOptions {
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
 *              process must not hang the settled run; the exit listener
 *              stays attached so a late exit is still recorded, just no
 *              longer awaited).
 *
 * An `onRung` observer throw is contained: the ladder continues to the
 * next rung (the same isolation contract as the governor's ladder).
 */
export async function terminateAcpProcess(
  child: ChildProcess,
  opts: AcpGraceLadderOptions = {},
  onRung?: (marker: TerminationRungMarker) => void,
): Promise<TerminationOutcome> {
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const wait = opts.delay ?? defaultDelay;
  /** true as soon as the child closed (never rejects). */
  const closed = (): Promise<boolean> => acpExitPromise(child).then(
    () => true,
    () => true,
  );
  /** Wait the grace window; true if the child closed FIRST. */
  const closesWithin = (ms: number): Promise<boolean> =>
    Promise.race([closed(), wait(ms).then(() => false)]);

  if (isAcpProcessExited(child)) {
    return 'terminated'; // nothing to signal — no rungs fired
  }

  // Rung 1: SIGTERM — the cooperative rung (a well-behaved harness flushes and exits).
  fireRung(onRung, 'sigterm');
  try {
    child.kill('SIGTERM');
  } catch {
    return 'terminated'; // already gone — progress, not failure
  }
  if (await closesWithin(termGraceMs)) {
    return 'terminated';
  }

  // Rung 2: SIGKILL — the unconditional rung.
  fireRung(onRung, 'sigkill');
  try {
    child.kill('SIGKILL');
  } catch {
    return 'killed';
  }
  if (await closesWithin(killGraceMs)) {
    return 'killed';
  }

  // Force-resolve: the kill decision has been executed to its hardest rung;
  // the settled run must not hang on an unstoppable process.
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

/** How the race resolved: the watched promise settled inside the grace, or the grace expired first. */
export type GraceRaceOutcome = 'settled' | 'stalled';

/**
 * Race a pending promise against a bounded grace: 'settled' when the
 * promise settles (fulfilled OR rejected) inside the window, 'stalled'
 * when the grace expires first. This is the second I8-exempt timer machine
 * (file header): the caller has ALREADY decided the kill the watched write
 * precedes — the grace only bounds the courtesy, so the kill's execution
 * can never hang on the cooperation of the thing being killed (Codex P1).
 * The default wait is the same unref'd timeout the ladder uses — a stalled
 * write must never hold the event loop open — and is INJECTABLE so tests
 * run deterministically.
 */
export function raceWithGrace<T>(
  watched: Promise<T>,
  graceMs: number,
  delay: AcpGraceLadderOptions['delay'] = defaultDelay,
): Promise<GraceRaceOutcome> {
  return Promise.race([
    watched.then(
      () => 'settled' as const,
      () => 'settled' as const, // a failed write is a settled write — evidence, not a stall
    ),
    delay(graceMs).then(() => 'stalled' as const),
  ]);
}
