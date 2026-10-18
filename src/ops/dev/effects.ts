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
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFile } from 'node:fs';
import { lstat, readFile, rm } from 'node:fs/promises';
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
   * Read one repo-relative worktree file's content for the secret scan.
   * FAIL-CLOSED with a reason: an unreadable file, a SYMLINK (its target is
   * outside this scan's containment model — realpath-verified inside the
   * repo root before any byte is read), or content exceeding `capBytes` all
   * refuse with the cause named — an oversized file is never silently
   * truncated into a scan declared complete.
   */
  readWorktreeFile(
    path: string,
    capBytes: number,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /**
   * Create a unique scratch directory OUTSIDE the worktree (the system
   * temp root) for archive extraction and scanner runs; the caller removes
   * it via {@link DevEffects.removeScratchDir}.
   */
  makeScratchDir(prefix: string): Promise<string>;
  /** Create a directory (recursive) through node:fs — never an external mkdir. */
  ensureDir(path: string): Promise<void>;
  /**
   * Remove a directory this seam's makeScratchDir created. Containment:
   * only paths under the system temp root are removed — a worktree path is
   * refused.
   */
  removeScratchDir(path: string): Promise<void>;
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

/**
 * The bounded log filename stem for a branch: a readable flattened prefix
 * plus a 16-hex sha256 of the full branch — the ledger filename's strategy.
 * A valid git-maximal hierarchical branch must never produce a log
 * component over the filesystem's 255-byte limit AFTER the (paid) review
 * has run.
 */
function boundedLogStem(branch: string): string {
  const hash = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 16);
  return `${logSlug(branch).slice(0, 64)}-${hash}`;
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
    throw gitReadFailure(result, what);
  }
  return result.stdout.trim();
}

/**
 * UNTRIMMED stdout of a required git read — for the HASHING-sensitive reads
 * (the dirty-diff identity): {@link requireGitOut}'s trim would give two
 * dirty patches differing only in trailing whitespace on the final line the
 * SAME recorded identity, so an earlier green check could stay current for a
 * worktree whose present diff would fail `git diff --check`. Scalar reads
 * (rev-parse, branch names) keep the trimmed variant.
 */
export function requireGitOutRaw(result: CommandResult, what: string): string {
  if (result.exitCode !== 0 || result.timedOut) {
    throw gitReadFailure(result, what);
  }
  return result.stdout;
}

function gitReadFailure(result: CommandResult, what: string): Error {
  const why = result.timedOut
    ? 'timed out'
    : `exit ${result.exitCode === null ? 'none (killed)' : String(result.exitCode)}`;
  const tail = `${result.stderr || result.stdout}`.trim().slice(0, 200);
  return new Error(`git ${what} failed (${why})${tail === '' ? '' : ` — ${tail}`}`);
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
      // creation modes are umask-masked). mkdirSync succeeds silently on a
      // pre-existing directory, so the dir is then VERIFIED: a real
      // directory, owned by this user, with no group/other bits — a
      // squatted /tmp directory belonging to another user refuses the log.
      const dir = reviewLogDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dirStats = lstatSync(dir);
      if (!dirStats.isDirectory()) {
        throw new Error(`the review-log path is not a directory: '${dir}'`);
      }
      // POSIX ONLY: Windows node does not implement Unix permission
      // semantics — Stats.mode there normally retains group/other bits and
      // ownership checks are meaningless, so unconditional enforcement
      // would refuse every log write. POSIX gets the full squatter check.
      if (process.getuid !== undefined) {
        if (dirStats.uid !== process.getuid()) {
          throw new Error(
            `the review-log directory '${dir}' is owned by uid ${String(dirStats.uid)}, not this process (${String(process.getuid())}) — refusing to write logs into another user's directory`,
          );
        }
        if ((dirStats.mode & 0o077) !== 0) {
          throw new Error(
            `the review-log directory '${dir}' is too permissive (mode ${String(dirStats.mode & 0o777).padStart(3, 'o')}) — refusing to write diff content where group/other can read it`,
          );
        }
      }
      const path = join(dir, `${boundedLogStem(branch)}-${cycleStamp}.log`);
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
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
        return { ok: false, reason: `path escapes the repository root: ${path}` };
      }
      try {
        // Lstat FIRST: a symlink is refused (its target is outside this
        // scan's containment model), never followed. The REAL path is then
        // re-verified inside the root before the read.
        const stats = await lstat(resolved);
        if (stats.isSymbolicLink()) {
          return { ok: false, reason: `untracked symlink (refused, not followed): ${path}` };
        }
        if (stats.size > capBytes) {
          return {
            ok: false,
            reason: `untracked file exceeds the per-file scan cap (${String(stats.size)} > ${String(capBytes)} bytes): ${path} — split, ignore, or remove it; the scan refuses rather than truncate`,
          };
        }
        const real = realpathSync(resolved);
        if (real !== root && !real.startsWith(`${root}${sep}`)) {
          return { ok: false, reason: `path escapes the repository root through a link: ${path}` };
        }
        const text = await readFile(real, 'utf8');
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    makeScratchDir: async (prefix) => {
      const dir = join(
        tmpdir(),
        `cq-${prefix}-${process.pid}-${String(Math.random()).slice(2, 10)}`,
      );
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    ensureDir: async (path) => {
      mkdirSync(path, { recursive: true });
    },
    removeScratchDir: async (path) => {
      const tempRoot = tmpdir();
      const resolved = resolve(path);
      // STRICT descendant: the temp root itself is never a removal target —
      // a caller passing tmpdir() must fault, not recursively delete the
      // system temporary directory.
      if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${sep}`)) {
        throw new Error(`refusing to remove a path outside the temp root: ${path}`);
      }
      await rm(resolved, { recursive: true, force: true });
    },
    openLedger: (branch) => pathDevLedgerStore(repoRoot, branch),
  };
}
