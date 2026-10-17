// Dev lane — the subprocess effects seam: the ONE place the dev family
// touches processes, the host clock, and the filesystem outside the repo.
// The ops are composed over the injected {@link DevEffects}; tests inject
// recording fakes; production binds {@link makeSubprocessDevEffects}.
//
// Conventions kept consistent with the sweep/pr families:
//   - execFile with an ARGS ARRAY — never a shell string (no input value is
//     ever re-parsed as shell syntax).
//   - A command that RAN resolves with its exit code whatever it is (gates
//     classify red/green themselves); only a SPAWN failure rejects.
//   - One wall clock per invocation: a call exceeding timeoutMs is SIGKILLed
//     and reported as `timedOut` — never awaited forever.
//   - The review log lands OUTSIDE the repository (protocol §3: the cycle
//     log is saved outside the repo), under `<tmpdir>/cq-dev-review/`.
//   - The host review lock is tmpdir-rooted (one per host, like the heavy
//     lock), so two worktrees on one machine serialize their CLI reviews —
//     the scarce-reviewer quota is host-wide, not per-worktree.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadavg, tmpdir, uptime } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DevLedgerStore } from './record.js';
import { pathDevLedgerStore } from './record.js';
import { makeGitMutex } from '../sweep/gitMutex.js';

/** The result of one ran command: exit code (null when SIGKILLed), captured streams. */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Generous capture ceiling for a gate's output (a big lint report must not truncate into a fault). */
const GATE_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Run one command. Resolves with the result for ANY exit (a red gate is a
 * verdict, not a fault); rejects only when the command could not be SPAWNED
 * (binary missing) — a missing tool is an environment fault the op reports,
 * never a silently green gate.
 */
export type RunCommand = (
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number },
) => Promise<CommandResult>;

/** The injected effects seam of the dev family. */
export interface DevEffects {
  /** Run one command in the repo root (the only process runner the ops see). */
  runCommand: RunCommand;
  /** ISO-8601 now (injectable for deterministic tests). */
  nowIso(): string;
  /** The host load stamp (uptime + 1-minute load average + sample time). */
  loadStamp(): { uptimeSeconds: number; load1: number; at: string };
  /**
   * Hold the HOST review lock across `fn` — the scarce CLI-review quota is
   * serialized host-wide. A caller whose acquire retries run out REJECTS
   * (never runs unlocked).
   */
  withHostLock<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Save one review's raw log OUTSIDE the repository; resolves with the
   * absolute log path recorded in the cycle.
   */
  writeReviewLog(branch: string, cycleStamp: string, content: string): Promise<string>;
  /**
   * Read one repo-relative worktree file's content for the secret scan,
   * capped at `capBytes` (longer content is truncated, visibly, with a
   * trailing marker). Null when the file cannot be read — the caller
   * refuses, never skips. Containment: the resolved path must stay inside
   * the repo root.
   */
  readWorktreeFile(path: string, capBytes: number): Promise<string | null>;
  /** Open the branch's dev-record store inside the repo root. */
  openLedger(branch: string): DevLedgerStore;
}

/**
 * Map an execFile failure onto the gate runner's fault taxonomy (the
 * worktree/gh adapter branch order): maxBuffer overflow first, then the
 * SIGKILL timeout, then the spawn failure itself. Exported for the
 * fault-mapping pins.
 */
export function mapSpawnFault(
  command: string,
  error: { message: string; killed?: boolean | null },
  timeoutMs: number,
): Error {
  if (error.message.includes('maxBuffer')) {
    return new Error(
      `${command} exceeded the output limit (maxBuffer ${String(GATE_OUTPUT_MAX_BUFFER_BYTES)} bytes) — the output is too large to classify`,
      { cause: error },
    );
  }
  if (error.killed === true) {
    return new Error(
      `${command} timed out after ${String(timeoutMs)}ms and was SIGKILLed — no verdict was produced`,
      { cause: error },
    );
  }
  return new Error(`${command} could not be spawned — ${error.message}`, { cause: error });
}

/** The lock artifact's path: tmpdir-rooted, one per host (the heavy-lock precedent). */
export function hostReviewLockPath(): string {
  return join(tmpdir(), 'cq-toolkit-dev-review.lock');
}

/** The review-log directory: outside any repository. */
export function reviewLogDir(): string {
  return join(tmpdir(), 'cq-dev-review');
}

/** Flatten a branch name into a filename-safe slug for log files (not paths inside the repo). */
function logSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '_');
}

// --- Git reading helpers (pure, over CommandResult) -------------------------

/**
 * Trimmed stdout of a git read, or null when the command failed. A git
 * read that printed nothing but exited 0 is the empty string (real absence
 * is a non-zero exit — git's convention for "no such ref").
 */
export function gitOut(result: CommandResult): string | null {
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

/**
 * Trimmed stdout of a REQUIRED git read: a non-zero exit (or a kill)
 * THROWS — a failed read must never fold into absent data (an empty diff is
 * not a clean tree, and an unreadable file list is not an empty one). The
 * callers map the throw onto their own refusal class (needs-human before
 * the run; the lock-span catch inside a review).
 */
export function requireGitOut(result: CommandResult, what: string): string {
  if (result.exitCode !== 0 || result.timedOut) {
    const why = result.timedOut
      ? 'timed out'
      : `exit ${result.exitCode === null ? 'none (killed)' : String(result.exitCode)}`;
    const tail = `${result.stderr || result.stdout}`.trim().slice(0, 200);
    throw new Error(`git ${what} failed (${why})${tail === '' ? '' : ` — ${tail}`}`);
  }
  return result.stdout.trim();
}

/**
 * The current branch from `git rev-parse --abbrev-ref HEAD`: null when
 * detached (git prints the literal `HEAD`) — the ops refuse detached heads
 * rather than guess a record file name.
 */
export function branchFromRevParse(result: CommandResult): string | null {
  const out = gitOut(result);
  if (out === null || out === 'HEAD' || out === '') return null;
  return out;
}

/**
 * The shipped effects adapter. Inert at construction (closure-only; a
 * process spawns only when an effect is CALLED), so resolving a registry
 * entry never touches the host.
 */
export function makeSubprocessDevEffects(repoRoot: string): DevEffects {
  // The root is canonicalized LAZILY (first use, then cached) so effect
  // construction stays INERT — the registry contract: resolving an entry
  // never touches the filesystem, even for an input that would fail the op
  // boundary. realpath-to-realpath keeps a symlinked ancestor (macOS
  // /var → /private/var) a normalization, never a false refusal.
  let rootRealCache: string | undefined;
  const rootReal = (): string => {
    if (rootRealCache === undefined) rootRealCache = realpathSync(resolve(repoRoot));
    return rootRealCache;
  };
  const runCommand: RunCommand = (command, args, opts) =>
    new Promise<CommandResult>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd: repoRoot,
          maxBuffer: GATE_OUTPUT_MAX_BUFFER_BYTES,
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            // MaxBuffer FIRST (the mapSpawnFault branch order): an overflow
            // kills the child, so the killed/exit branch below would
            // misclassify it as a timeout verdict instead of the
            // output-too-large fault it is.
            if (error.message.includes('maxBuffer')) {
              reject(mapSpawnFault(command, error, opts.timeoutMs));
              return;
            }
            if (typeof (error as { code?: unknown }).code === 'number' || error.killed === true) {
              // The command RAN and exited non-zero (or was killed on
              // timeout): a verdict the gates classify, not a fault.
              resolve({
                exitCode:
                  typeof (error as { code?: unknown }).code === 'number'
                    ? ((error as { code?: number }).code as number)
                    : null,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                timedOut: error.killed === true,
              });
              return;
            }
            reject(mapSpawnFault(command, error, opts.timeoutMs));
            return;
          }
          resolve({
            exitCode: 0,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            timedOut: false,
          });
        },
      );
    });

  const mutex = makeGitMutex({ lockPath: hostReviewLockPath() });

  return {
    runCommand,
    nowIso: () => new Date().toISOString(),
    loadStamp: () => ({
      // Sampled together so one stamp describes one instant (the contract's
      // stamp pairs uptime with the load average at measurement time).
      uptimeSeconds: uptime(),
      load1: loadavg()[0] ?? 0,
      at: new Date().toISOString(),
    }),
    withHostLock: (fn) => mutex.withLock(fn),
    writeReviewLog: async (branch, cycleStamp, content) => {
      // Owner-only dir and file: the log carries raw diff content, so it
      // gets the ledger's restrictive posture (0700/0600, chmod-exact —
      // creation modes are umask-masked).
      const dir = reviewLogDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${logSlug(branch)}-${cycleStamp}.log`);
      await new Promise<void>((resolve, reject) => {
        writeFile(path, content, { encoding: 'utf8', mode: 0o600 }, (err) =>
          err === null ? resolve() : reject(err),
        );
      });
      chmodSync(path, 0o600);
      return path;
    },
    readWorktreeFile: async (path, capBytes) => {
      const root = rootReal();
      const resolved = resolve(root, path);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
      try {
        const text = await readFile(resolved, 'utf8');
        if (text.length > capBytes) {
          return `${text.slice(0, capBytes)}\n[truncated for scan — exceeded the per-file cap]`;
        }
        return text;
      } catch {
        return null;
      }
    },
    openLedger: (branch) => pathDevLedgerStore(repoRoot, branch),
  };
}
