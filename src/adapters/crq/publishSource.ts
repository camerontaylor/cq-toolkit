/**
 * Production binding for the publisher run route.
 *
 * Realizes `PublishRunEffects` against the existing layout: the runner state
 * root (`state/`), the configured durable artifact volume, and the hardened
 * git runner of `src/adapters/git/ratchetGit.ts` (argv-array `execFile`,
 * scrubbed git environment, no replace objects, no prompts) bound per repo.
 * The queue write is Python's atomic fsync replace (`crq_repair.atomic`
 * bytes: compact `json.dumps` with `indent=2`, trailing newline, UTF-8).
 *
 * Paths arrive from the caller (`crq.ts`), never the environment; the unit
 * command surface stays argument-free. The tick lock is the same persistent
 * `tick.lock` flock inode Python holds, through the existing `fs-ext`
 * adapter, with Python's `with_lock` busy semantics (null after the wait).
 *
 * The unit (not just the publication body) also binds the two daemon effects
 * Python's `main` runs: the notification drain under `review-notify.lock`
 * (`./notifySource.ts`) and the off-lock coverage refresh under
 * `backfill/coverage.lock` (`./coverageSource.ts`).
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import {
  readRollout,
  publisherLedger,
  publisherLockPath,
  PublishRolloutDisabled,
  type PublishRunEffects,
} from '../../ops/crq/publishRun.js';
import { drainNotifications } from '../../ops/crq/notifyDrain.js';
import { runCoverageRefresh, type CoverageRunEffects } from '../../ops/crq/coverageRefresh.js';
import {
  publishUnitFailed,
  runPublishMain,
  type PublishUnitEffects,
  type PublishUnitOutcome,
} from '../../ops/crq/publishUnit.js';
import { readNotifyConfig, spawnNotifySend } from './notifySource.js';
import { gitCoverageRepository } from './coverageSource.js';
import { fileArtifactStore } from './findingStore.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { SlotBusyError } from '../lock/slotLock.js';
import type { OpResult } from '../../kernel/types.js';

export interface PublisherRoots {
  /** The runner state root (`state/`), holding `queue.json` and `backfill/`. */
  readonly stateRoot: string;
  /** The scheduler clone (`config.json`'s `clone`). */
  readonly cloneRoot: string;
  /** The runner root, holding `config.json` (Python's `crq.ROOT`). */
  readonly runnerRoot: string;
  /**
   * The separately provisioned durable artifact volume, or null when the
   * rollout is absent (no publication can run, so no artifact is read).
   */
  readonly durableArtifactRoot: string | null;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 330_000; // Python's signer ssh timeout plus headroom.

/** Variables that could redirect git away from the intended repository. */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_REPLACE_REF_BASE',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
] as const;

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  // Same allowlist class as `src/adapters/git/ratchetGit.ts` (cq/no-process-env
  // off): the publisher child-env builder inherits the ambient environment,
  // scrubs redirections and pins the hardened switches.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  if (
    process.env['GIT_CONFIG_GLOBAL'] === '/dev/null' ||
    process.env['GIT_CONFIG_GLOBAL'] === devNull
  ) {
    env['GIT_CONFIG_GLOBAL'] = devNull;
  }
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  if (extra !== undefined) Object.assign(env, extra);
  return env;
}

/** One hardened git invocation bound to one repository directory. */
export function runGitIn(repo: string): RunGit {
  return async (args, options) => {
    if (options?.input !== undefined && options.input.length > 0) {
      // execFile cannot stream stdin; input-carrying calls (hash-object,
      // diff-tree, cat-file --batch) run through the piped form.
      return pipedGit(repo, args, options.env, options.input);
    }
    const call = await new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>(
      (resolve) => {
        execFile(
          'git',
          ['-C', repo, ...GIT_HARDEN, ...args],
          {
            env: gitEnv(options?.env),
            encoding: 'buffer',
            maxBuffer: MAX_BUFFER,
            timeout: EXEC_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const rawCode = error === null ? 0 : (error as { code?: unknown }).code;
            resolve({
              code: typeof rawCode === 'number' ? rawCode : null,
              stdout,
              stderr,
            });
          },
        );
      },
    );
    return {
      args,
      code: call.code,
      stdout: new Uint8Array(call.stdout),
      stderr: call.stderr.toString('utf8'),
    };
  };
}

/** The input-carrying form: spawn with a stdin pipe, write, collect. */
function pipedGit(
  repo: string,
  args: readonly string[],
  extraEnv: Record<string, string> | undefined,
  input: Uint8Array,
): Promise<GitCall> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...GIT_HARDEN, ...args], {
      env: gitEnv(extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    // execFile enforces maxBuffer; the piped path must bound accumulation the
    // same way (GitLedger.read streams whole-history diffs through here). On
    // overflow kill the child and fail the call: never truncated output with
    // a successful exit code.
    const killForOverflow = (): void => {
      overflow = true;
      child.kill('SIGKILL');
    };
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_BUFFER) return killForOverflow();
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_BUFFER) return killForOverflow();
      stderr.push(chunk);
    });
    // The child exits once it has read its input; a late write to the closed
    // pipe (EPIPE) must not crash the process. The close handler below is the
    // single completion authority.
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      resolve({ args, code: null, stdout: new Uint8Array(0), stderr: 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (overflow) {
        resolve({
          args,
          code: null,
          stdout: new Uint8Array(0),
          stderr: `output exceeded ${MAX_BUFFER} bytes`,
        });
        return;
      }
      resolve({
        args,
        code: code ?? null,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
    // Python's git() timeout applies to the whole call; the exec timeout
    // above does not cover this path, so guard it here.
    const timer = setTimeout(() => child.kill('SIGKILL'), EXEC_TIMEOUT_MS);
  });
}

/** Python's queue write bytes: `json.dumps(q, indent=2)` plus a newline. */
export function pythonQueueText(queue: JsonObject): string {
  const text = pythonJsonText(queue, {
    asciiOnly: true,
    sortKeys: false,
    keyOrder: 'insertion',
    indent: 2,
    trailingNewline: true,
  });
  return text;
}

/** The tick-lock seam (`tick.lock`, Python's `with_lock` busy semantics). */
function fileTickLock(stateRoot: string) {
  return async function withTickLock<T>(
    fn: () => Promise<T>,
    options?: { readonly lockWait?: number },
  ): Promise<T | null> {
    const lock = join(stateRoot, 'tick.lock');
    await mkdir(stateRoot, { recursive: true });
    // Python with_lock: wait up to lock_wait seconds, then report busy as
    // null. A callback that throws under a held lock propagates: only
    // exhausted contention is contention.
    const waitMs = (options?.lockWait ?? 0) * 1000;
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return await withLock(lock, { wait: false }, fn);
      } catch (error) {
        if (!(error instanceof SlotBusyError)) throw error;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
}

/** The publication effects over explicit roots (a rollout must be configured). */
export function filePublishEffects(roots: PublisherRoots): PublishRunEffects {
  return {
    stateRoot: roots.stateRoot,
    // The unit binds this when the rollout provisions a durable volume; the
    // publication body refuses an unconfigured root before any artifact read.
    durableArtifactRoot: roots.durableArtifactRoot ?? '',
    runSchedulerGit: runGitIn(roots.cloneRoot),
    runPublisherGit: runGitIn(join(roots.stateRoot, 'backfill', 'publisher.git')),
    withTickLock: fileTickLock(roots.stateRoot),
    async readQueue(): Promise<Uint8Array> {
      return new Uint8Array(await readFile(join(roots.stateRoot, 'queue.json')));
    },
    async writeQueue(queue: JsonObject): Promise<void> {
      await atomicWrite(
        join(roots.stateRoot, 'queue.json'),
        new TextEncoder().encode(pythonQueueText(queue)),
      );
    },
  };
}

/**
 * The full `publish` unit effects: publication plus the two daemon phases.
 *
 * - The notification drain reads `config.json` (`notify.hosts`,
 *   `error_backoff_min`) and delivers by argv.
 * - The coverage refresh reads the rollout (`runtime.settings`), folds through
 *   the scheduler clone, fetches through the publisher-owned clone under the
 *   publisher lock, and wakes the slot by writing `state/next-review-at`.
 */
export function filePublishUnitEffects(roots: PublisherRoots): PublishUnitEffects {
  const base = filePublishEffects(roots);
  const durableRoot = roots.durableArtifactRoot;
  const artifacts = durableRoot === null ? null : fileArtifactStore(durableRoot);
  const verifyArtifact =
    artifacts === null
      ? async (): Promise<void> => {
          // Unreachable while the rollout is absent: publication and coverage
          // both report disabled before any artifact is read.
          throw new Error('durable artifact root is not configured');
        }
      : artifacts.verify.bind(artifacts);
  const coverage: CoverageRunEffects = {
    stateRoot: roots.stateRoot,
    repository: gitCoverageRepository(base.runSchedulerGit),
    verifyArtifact,
    async settings(): Promise<JsonObject | null> {
      try {
        return await readRollout(base);
      } catch (error) {
        // Python `settings()` returns None only when the file is absent; a
        // present-but-incomplete rollout stays an integrity refusal.
        if (error instanceof PublishRolloutDisabled) return null;
        throw error;
      }
    },
    readQueue: base.readQueue,
    withCoverageLock: (fn) =>
      withLock(join(roots.stateRoot, 'backfill', 'coverage.lock'), { wait: true }, fn),
    withPublisherLock: async (fn) => withLock(await publisherLockPath(base), { wait: true }, fn),
    fetchLedger: async (config) => publisherLedger(base, config).then((ledger) => ledger.fetch()),
    async wakeSlot(isoSeconds: string): Promise<void> {
      // `usage_slots.write_next`: one atomic hint, separate from the queue.
      await mkdir(roots.stateRoot, { recursive: true });
      await atomicWrite(join(roots.stateRoot, 'next-review-at'), `${isoSeconds}\n`);
    },
    nowIso: () => `${new Date().toISOString().slice(0, 19)}Z`,
  };
  return {
    ...base,
    async drainNotifications(): Promise<number> {
      return drainNotifications({
        stateRoot: roots.stateRoot,
        config: await readNotifyConfig(roots.runnerRoot),
        nowMicros: () => BigInt(Date.now()) * 1000n,
        readQueue: base.readQueue,
        writeQueue: base.writeQueue,
        withTickLock: base.withTickLock,
        notify: spawnNotifySend,
      });
    },
    refreshCoverage: (publishedHead) => runCoverageRefresh(coverage, publishedHead),
  };
}

/**
 * The `publish` unit command: Python's `main` (notifications, publication,
 * coverage refresh) as the runner artifact.
 *
 * Exit 0 for a reconciled/pending/idle/disabled outcome with fresh or idle
 * coverage; exit 1 when publication threw (the run route already persisted the
 * failure marker and halt) or when the coverage refresh failed or errored for
 * a target. The coverage case still reports the publication outcome, exactly
 * Python's `coverage_failed` exit.
 */
export async function runPublishUnit(
  roots: PublisherRoots,
): Promise<OpResult<PublishUnitOutcome> & { readonly exitCode?: number }> {
  try {
    const outcome = await runPublishMain(filePublishUnitEffects(roots));
    return {
      status: 'ok',
      value: outcome,
      exitCode: publishUnitFailed(outcome) ? 1 : 0,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
