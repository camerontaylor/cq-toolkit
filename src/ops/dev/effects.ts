// Dev lane — the subprocess effects seam: the ONE place the dev family
// touches processes, the host clock, and the filesystem outside the repo.
// The ops are composed over the injected {@link DevEffects}; tests inject
// recording fakes; production binds {@link makeSubprocessDevEffects}.
//
// Conventions kept consistent with the sweep/pr families:
//   - execFile with an ARGS ARRAY — never a shell string (no input value is
//     ever re-parsed as shell syntax); every git call carries the shared
//     global hardening (`GIT_HARDEN`), and diff call sites name their flags.
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
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir, uptime } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { z } from 'zod';
import type { Op, OpResult } from '../../kernel/types.js';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { makeGitMutex } from '../../shared/gitMutex.js';
import type { DevLedgerStore } from './record.js';
import { pathDevLedgerStore } from './record.js';

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
 * (binary missing) or overflowed the capture ceiling — an environment fault
 * the op reports, never a silently green gate.
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
   * Read one repo-relative worktree file's content for the secret scan.
   * FAIL-CLOSED with a reason: an unreadable file, a SYMLINK (never
   * followed), a path resolving outside the root, or content exceeding
   * `capBytes` all refuse with the cause named — an oversized file is never
   * silently truncated into a scan declared complete.
   */
  readWorktreeFile(
    path: string,
    capBytes: number,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /**
   * Create a unique scratch directory OUTSIDE the worktree (the system
   * temp root); the caller removes it via {@link DevEffects.removeScratchDir}.
   */
  makeScratchDir(prefix: string): Promise<string>;
  /** Create a directory (recursive) through node:fs — never an external mkdir. */
  ensureDir(path: string): Promise<void>;
  /**
   * Remove a directory under the system temp root (a strict descendant —
   * the temp root itself and any worktree path are refused).
   */
  removeScratchDir(path: string): Promise<void>;
  /** Open the branch's dev-record store inside the repo root. */
  openLedger(branch: string): DevLedgerStore;
}

/**
 * Map an execFile failure onto the runner's fault taxonomy: maxBuffer
 * overflow first (an overflow also kills the child), then the SIGKILL
 * timeout, then the spawn failure itself.
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

/**
 * The bounded log filename stem for a branch: a readable flattened prefix
 * plus a 16-hex sha256 of the full branch (the ledger filename's strategy),
 * so a git-maximal branch never exceeds the 255-byte name limit after the
 * (paid) review has run.
 */
function boundedLogStem(branch: string): string {
  const hash = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 16);
  return `${branch.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64)}-${hash}`;
}

/** Create the owner-only log directory, refusing a squatted or permissive one. */
function ensurePrivateLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error(`the review-log path is not a directory: '${dir}'`);
  // POSIX only: Windows mode bits are not Unix permission semantics.
  if (process.getuid === undefined) return;
  if (stats.uid !== process.getuid()) {
    throw new Error(
      `the review-log directory '${dir}' is owned by uid ${String(stats.uid)}, not this process — refusing to write logs into another user's directory`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `the review-log directory '${dir}' is readable by group/other — refusing to write diff content there`,
    );
  }
}

/**
 * The shipped effects adapter. Inert at construction (closure-only; a
 * process spawns only when an effect is CALLED), so resolving a registry
 * entry never touches the host.
 */
export function makeSubprocessDevEffects(repoRoot: string): DevEffects {
  const runCommand: RunCommand = (command, args, opts) =>
    new Promise<CommandResult>((resolvePromise, reject) => {
      execFile(
        command,
        command === 'git' ? [...GIT_HARDEN, ...args] : [...args],
        {
          cwd: repoRoot,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          maxBuffer: GATE_OUTPUT_MAX_BUFFER_BYTES,
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }
          const code = (error as { code?: unknown }).code;
          if (
            !error.message.includes('maxBuffer') &&
            (typeof code === 'number' || error.killed === true)
          ) {
            // The command RAN and exited non-zero (or was killed on
            // timeout): a verdict the caller classifies, not a fault.
            resolvePromise({
              exitCode: typeof code === 'number' ? code : null,
              stdout,
              stderr,
              timedOut: error.killed === true,
            });
            return;
          }
          reject(mapSpawnFault(command, error, opts.timeoutMs));
        },
      );
    });

  const mutex = makeGitMutex({ lockPath: hostReviewLockPath() });

  return {
    runCommand,
    nowIso: () => new Date().toISOString(),
    loadStamp: () => ({
      // Sampled together so one stamp describes one instant.
      uptimeSeconds: uptime(),
      load1: loadavg()[0] ?? 0,
      at: new Date().toISOString(),
    }),
    withHostLock: (fn) => mutex.withLock(fn),
    writeReviewLog: async (branch, cycleStamp, content) => {
      // Owner-only dir and file: the log carries raw diff content.
      const dir = reviewLogDir();
      ensurePrivateLogDir(dir);
      const path = join(dir, `${boundedLogStem(branch)}-${cycleStamp}.log`);
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    },
    readWorktreeFile: async (path, capBytes) => {
      const root = realpathSync(resolve(repoRoot));
      const inside = (candidate: string): boolean => candidate.startsWith(`${root}${sep}`);
      const resolved = resolve(root, path);
      if (!inside(resolved)) return { ok: false, reason: `path escapes the repository: ${path}` };
      try {
        const stats = await lstat(resolved);
        if (stats.isSymbolicLink()) return { ok: false, reason: `symlink (not followed): ${path}` };
        if (stats.size > capBytes) {
          return {
            ok: false,
            reason: `file exceeds the per-file scan cap (${String(stats.size)} > ${String(capBytes)} bytes): ${path} — split, ignore, or remove it; the scan refuses rather than truncate`,
          };
        }
        if (!inside(realpathSync(resolved))) {
          return { ok: false, reason: `path escapes the repository through a link: ${path}` };
        }
        return { ok: true, text: await readFile(resolved, 'utf8') };
      } catch (err) {
        return { ok: false, reason: `unreadable: ${faultText(err)}` };
      }
    },
    makeScratchDir: async (prefix) => mkdtemp(join(tmpdir(), `cq-${prefix}-`)),
    ensureDir: async (path) => {
      mkdirSync(path, { recursive: true });
    },
    removeScratchDir: async (path) => {
      const resolved = resolve(path);
      if (!resolved.startsWith(`${tmpdir()}${sep}`)) {
        throw new Error(`refusing to remove a path outside the temp root: ${path}`);
      }
      await rm(resolved, { recursive: true, force: true });
    },
    openLedger: (branch) => pathDevLedgerStore(repoRoot, branch),
  };
}

/** One-line text of a caught fault. */
export function faultText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The ONE boundary every public dev op goes through:
 *   - the input is parsed with the op's registry schema first, so an SDK
 *     caller that bypasses the CLI gets the `failed` taxonomy naming the
 *     schema issues — never a TypeError, never a spawn against a bad
 *     repoRoot;
 *   - any fault the body throws (a git spawn failure, an unreadable
 *     ledger) maps to `needs-human` naming it — the environment is the
 *     human's to fix — never a rejected promise outside the taxonomy.
 */
export function guardDevOp<S extends z.ZodType, O>(
  name: string,
  schema: S,
  body: (input: z.output<S>) => Promise<OpResult<O>>,
): Op<z.input<S>, O> {
  return async (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(input)'}: ${issue.message}`)
        .join('; ');
      return { status: 'failed', error: `${name}: invalid input — ${issues}` };
    }
    try {
      return await body(parsed.data);
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `${name}: environment read or execution failed — ${faultText(err)}`,
      };
    }
  };
}
