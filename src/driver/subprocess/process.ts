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
// is ever re-interpreted by a shell. CHILD ENV IS DEFAULT-DENY (issue #183):
// the child receives ONLY the names on DEFAULT_CHILD_ENV_ALLOWLIST (PATH/
// HOME/terminal basics + documented driver-needed names) copied from the
// parent env, plus the caller's explicit override map. Per-Route vars
// (endpoint base URL, auth token) are composed deliberately and always ride
// that override map, so they reach the child regardless of the allowlist. A
// GH_TOKEN or repo secret in the entry process env is NOT inherited unless a
// Route or an explicit `envAllowlist` entry names it.
//
// PROCESS GROUPS (issue #19): on POSIX the child is spawned `detached` —
// it becomes the leader of its OWN process group, so a kill can take the
// WHOLE group down (`process.kill(-pid)`) and agent-spawned descendants die
// with the CLI instead of surviving it. WINDOWS LIMITATION (recorded): no
// Job Object in v1 — `detached` is not set there and descendants can
// survive a kill; closing that gap is a later lane's business.
//
// SPAWN FAILURES ARE DATA, NOT THROWS: a missing binary (ENOENT) surfaces
// on `close` as `spawnError` — the driver maps it to a stopReason 'error'
// WorkerResult and NEVER throws past the frozen seam once spawned.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** POSIX gets process-group semantics; Windows has no Job Object in v1 (header). */
const POSIX = process.platform !== 'win32';

/**
 * The stdout/stderr RETENTION cap (issue #19): the verdict path folds
 * evidence from the LINE callbacks, so the whole-stream buffers are
 * diagnostics hygiene only — past this cap the collector retains the TAIL
 * and counts what it dropped (exposed as `ProcessClose.droppedBytes`).
 */
export const DEFAULT_MAX_RETAINED_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// spawnManaged — the managed child
// ---------------------------------------------------------------------------

/**
 * The default-deny child-env allowlist (issue #183): the ONLY names copied
 * from the parent process env into a spawned worker. Deliberately EXCLUDES
 * credential-shaped names (`GH_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`,
 * `NPM_TOKEN`, `SSH_AUTH_SOCK`, `GOOGLE_APPLICATION_CREDENTIALS`, …) and
 * `NODE_OPTIONS`/`NODE_PATH` (code-execution vectors). A per-Route auth var
 * reaches the child through `SpawnOptions.env` — an explicit VALUE the driver
 * composed — not through this list. FROZEN: a mutable export would let any
 * in-process consumer push a credential name and weaken default-deny for
 * every later spawn (issue #183 r1).
 */
export const DEFAULT_CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // Executable resolution, home, identity, temp dirs — a CLI cannot run
  // without these. PWD is deliberately ABSENT: node's spawn does not rewrite
  // it for `cwd`, so an inherited PWD would be the PARENT's directory — a
  // stale, misleading value that leaks the entry process's path.
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Terminal/locale basics: output formatting, encoding, timezone.
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  // XDG base dirs: CLI config/cache/state discovery on POSIX.
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // Network egress + TLS trust config (issue #183 r1): a routed CLI on a
  // proxied or TLS-inspecting host cannot reach its endpoint without these.
  // The CA vars are non-secret paths. NOTE the proxy vars MAY embed egress
  // credentials — a worker can then read them; an operator who must not
  // expose those clears them in the entry env. Anything else a deployment
  // needs (e.g. SSH_AUTH_SOCK, NPM_CONFIG_*) is added explicitly through
  // `envAllowlist`, never inherited by default.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'no_proxy',
  // Windows equivalents: a spawned CLI on win32 needs these to run at all.
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
]);

/**
 * Compose a child environment with default-deny semantics (issue #183):
 * copy ONLY the allowlisted names actually set in `parentEnv`, then apply
 * the caller's explicit `overrides` — which ALWAYS win, because a Route
 * value is composed deliberately and the allowlist must never filter it.
 * `extraAllowlist` extends the copied names for a deployment without
 * weakening the default; a malformed entry is rejected at the seam (r1) so a
 * direct `spawnManaged` consumer cannot bypass the constructor's validation.
 * The result is a fresh object; the parent env is never mutated.
 */
export function buildChildEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  overrides?: Readonly<Record<string, string>>,
  extraAllowlist: readonly string[] = [],
): Record<string, string> {
  if (extraAllowlist.some((name) => name === '' || name.includes('='))) {
    throw new Error(
      `envAllowlist entries must be non-empty env var names without '=', got ${JSON.stringify(extraAllowlist)}`,
    );
  }
  const child: Record<string, string> = {};
  for (const name of [...DEFAULT_CHILD_ENV_ALLOWLIST, ...extraAllowlist]) {
    const value = parentEnv[name];
    if (value !== undefined) child[name] = value;
  }
  if (overrides !== undefined) {
    for (const [name, value] of Object.entries(overrides)) child[name] = value;
  }
  return child;
}

/** How to spawn one CLI run. All plain data. */
export interface SpawnOptions {
  /** The executable (resolved by the caller from its `binary` option). */
  command: string;
  /** Argv elements, driver-built — never a shell string. */
  args: readonly string[];
  /** Working directory: the invocation's workspace (I6 isolation boundary). */
  cwd: string;
  /**
   * Explicit child env values (per-Route endpoint + auth vars). Applied on
   * top of the allowlisted parent env (issue #183) and always win — the
   * caller composed these, so they are trusted by construction.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Extra parent-env NAMES copied into the child on top of
   * DEFAULT_CHILD_ENV_ALLOWLIST (issue #183). Default-deny is unchanged:
   * only names listed here or on the default allowlist are inherited. Use
   * for deployment-specific driver config (e.g. a CLI config-dir var),
   * never for secrets a Route can inject explicitly.
   */
  envAllowlist?: readonly string[];
  /** When set, written to the child's stdin and the pipe closed (prompt piping). */
  stdin?: string;
  /**
   * Stdout/stderr TAIL retention cap in bytes (issue #19). Default
   * DEFAULT_MAX_RETAINED_BYTES; past the cap the head is dropped and its
   * byte count reported on `ProcessClose.droppedBytes` — line callbacks
   * still see every line.
   */
  maxRetainedBytes?: number;
}

/** How the child process closed, with everything the driver harvested. */
export interface ProcessClose {
  /** Exit code (null when killed by signal or never spawned). */
  code: number | null;
  /** Terminating signal, when killed. */
  signal: NodeJS.Signals | null;
  /** Set when the process never ran (e.g. ENOENT — a missing binary). */
  spawnError?: Error;
  /** The retained stdout TAIL (≤ maxRetainedBytes) — evidence hygiene, NOT the whole stream. */
  stdout: string;
  /** The retained stderr TAIL (≤ maxRetainedBytes) — evidence hygiene, NOT the whole stream. */
  stderr: string;
  /** Total bytes dropped off the two streams' heads by the retention cap. */
  droppedBytes: number;
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

/** Whole-text TAIL retention + line streaming for one stdio pipe. */
interface StreamCollector {
  onChunk(chunk: string): void;
  /** Emit the final pending line at close (a truncated stream is still evidence). */
  flush(): void;
  /** The retained TAIL (≤ the retention cap) — evidence hygiene, not the whole stream. */
  readonly text: string;
  /** Bytes dropped off the HEAD once the retention cap was hit. */
  readonly droppedBytes: number;
}

/**
 * Collect one pipe's text and stream its complete lines (no trailing
 * newline) to listeners. The memory bound is ABSOLUTE (issue #19 + review):
 * BOTH retained buffers — the `tail` and the pending unterminated line —
 * are capped at `maxRetainedBytes` each, so a subprocess emitting one
 * arbitrarily large line cannot grow the collector unbounded; past a cap
 * the head is dropped and counted. Lines UNDER the cap are emitted whole by
 * the listeners; a line that outgrew the cap emits as its retained TAIL
 * (the cap bounds the buffer, never the under-cap evidence stream).
 */
function createCollector(
  listeners: Array<(line: string) => void>,
  maxRetainedBytes: number,
): StreamCollector {
  const tailBuf = { text: '', bytes: 0 };
  const restBuf = { text: '', bytes: 0 }; // the pending unterminated line
  let droppedBytes = 0;
  // Trim a buffer back under the cap, cutting whole CODE POINTS off the
  // head (a cut between the halves of an astral pair would leave a lone
  // surrogate — corruption at the head of retained evidence) and measuring
  // each cut in its real UTF-8 bytes (a code-unit advance mis-measures an
  // astral pair as 3+3 instead of 4, under-counts, and lets the retained
  // text exceed the documented absolute bound — review thread). Only the
  // TAIL's trims count toward droppedBytes: the pending line is a suffix of
  // the same stream, so everything its trim drops sits inside the head the
  // tail's trim drops anyway — counting both would inflate.
  const trimToCap = (buf: { text: string; bytes: number }): void => {
    if (buf.bytes <= maxRetainedBytes) return;
    let cut = 0;
    let cutBytes = 0;
    while (cut < buf.text.length && buf.bytes - cutBytes > maxRetainedBytes) {
      const width = (buf.text.codePointAt(cut) ?? 0) > 0xffff ? 2 : 1;
      cutBytes += Buffer.byteLength(buf.text.slice(cut, cut + width));
      cut += width;
    }
    if (buf === tailBuf) droppedBytes += cutBytes;
    buf.text = buf.text.slice(cut);
    buf.bytes -= cutBytes;
  };
  return {
    onChunk(chunk: string): void {
      const chunkBytes = Buffer.byteLength(chunk);
      restBuf.text += chunk;
      restBuf.bytes += chunkBytes;
      // Complete lines split FIRST and emit WHOLE — the trim below runs on
      // the remaining pending (unterminated) line only, so an under-cap
      // line is never head-dropped by a burst that carried it.
      let index = restBuf.text.indexOf('\n');
      while (index !== -1) {
        const line = restBuf.text.slice(0, index);
        restBuf.text = restBuf.text.slice(index + 1);
        restBuf.bytes -= Buffer.byteLength(line) + 1; // + the consumed '\n'
        for (const listener of listeners) listener(line);
        index = restBuf.text.indexOf('\n');
      }
      // Bound the PENDING line — a single unterminated line must not grow
      // `rest` unbounded; past the cap its head is dropped (its drops are a
      // subset of the tail's, see trimToCap) and flush emits the tail.
      trimToCap(restBuf);
      tailBuf.text += chunk;
      tailBuf.bytes += chunkBytes;
      trimToCap(tailBuf);
    },
    flush(): void {
      if (restBuf.text !== '') {
        // The pending bytes were ALREADY retained chunk-by-chunk in the
        // tail (onChunk appends every chunk), so flush only CLEARS the
        // pending buffer and emits the final line to the listeners — the
        // close result's text ends with it exactly once, and droppedBytes
        // is untouched (review thread: no double retention, no phantom
        // drops).
        const finalLine = restBuf.text;
        restBuf.text = '';
        restBuf.bytes = 0;
        for (const listener of listeners) listener(finalLine);
      }
    },
    get text(): string {
      return tailBuf.text;
    },
    get droppedBytes(): number {
      return droppedBytes;
    },
  };
}

/**
 * Spawn the CLI headless: no shell, piped stdio, cwd = workspace, env
 * overrides per Route. Stdout is split into complete lines (streamed to
 * listeners as they arrive; a final unterminated line is flushed at close)
 * and retained as a bounded TAIL on the `close` result; stderr likewise.
 * On POSIX the child is spawned DETACHED — the leader of its own process
 * group — so `kill` can take descendants down with it (header; Windows
 * limitation recorded there).
 */
export function spawnManaged(opts: SpawnOptions): ManagedChild {
  const stdoutListeners: Array<(line: string) => void> = [];
  const stderrListeners: Array<(line: string) => void> = [];
  const maxRetainedBytes = opts.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
  const stdout = createCollector(stdoutListeners, maxRetainedBytes);
  const stderr = createCollector(stderrListeners, maxRetainedBytes);
  let spawnError: Error | undefined;
  let exited = false;

  const child: ChildProcessWithoutNullStreams = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    shell: false, // driver-built argv — nothing is ever re-interpreted by a shell
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: the child becomes its own process-group leader, so the group
    // kill below reaches agent-spawned descendants too. Windows: not set —
    // no Job Object in v1, descendants can survive (header).
    ...(POSIX ? { detached: true } : {}),
    // DEFAULT-DENY child env (issue #183): only the allowlisted parent names
    // are inherited; the explicit per-Route overrides always ride on top.
    env: buildChildEnv(process.env, opts.env, opts.envAllowlist),
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
      droppedBytes: stdout.droppedBytes + stderr.droppedBytes,
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
      // GROUP KILL (issue #19): the child leads its own process group on
      // POSIX (spawned detached), so signal the WHOLE group first —
      // agent-spawned descendants die with it — falling back to the direct
      // child when there is no pid or the group kill throws (group already
      // gone). Windows: no detached spawn in v1, direct child only (header).
      if (POSIX && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
          // fall through — the direct kill below decides delivery
        }
      }
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
  const closed = (): Promise<boolean> =>
    child.close.then(
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
