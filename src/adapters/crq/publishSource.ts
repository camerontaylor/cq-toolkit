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
 */
import { execFile, spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import {
  runPublish,
  type PublishRunEffects,
  type PublishRunResult,
} from '../../ops/crq/publishRun.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { SlotBusyError } from '../lock/slotLock.js';
import type { OpResult } from '../../kernel/types.js';

export interface PublisherRoots {
  /** The runner state root (`state/`), holding `queue.json` and `backfill/`. */
  readonly stateRoot: string;
  /** The scheduler clone (`config.json`'s `clone`). */
  readonly cloneRoot: string;
  /** The separately provisioned durable artifact volume. */
  readonly durableArtifactRoot: string;
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
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => {
      resolve({ args, code: null, stdout: new Uint8Array(0), stderr: 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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

/** The production effects over explicit roots. */
export function filePublishEffects(roots: PublisherRoots): PublishRunEffects {
  return {
    stateRoot: roots.stateRoot,
    durableArtifactRoot: roots.durableArtifactRoot,
    runSchedulerGit: runGitIn(roots.cloneRoot),
    runPublisherGit: runGitIn(join(roots.stateRoot, 'backfill', 'publisher.git')),
    async withTickLock<T>(
      fn: () => Promise<T>,
      options?: { readonly lockWait?: number },
    ): Promise<T | null> {
      const lock = join(roots.stateRoot, 'tick.lock');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(roots.stateRoot, { recursive: true });
      // Python with_lock: wait up to lock_wait seconds, then report busy as null.
      const waitMs = (options?.lockWait ?? 0) * 1000;
      const deadline = Date.now() + waitMs;
      for (;;) {
        try {
          return await withLock(lock, { wait: false }, fn);
        } catch (error) {
          if (!(error instanceof SlotBusyError) || Date.now() >= deadline) return null;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    async readQueue(): Promise<Uint8Array> {
      const { readFile } = await import('node:fs/promises');
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
 * The `publish` unit command: run the publisher route and return its JSON
 * outcome as the runner artifact. Exit codes follow the Python unit: 0 for
 * reconciled/idle, 1 for reconciliation-pending or a thrown failure.
 */
export async function runPublishUnit(roots: PublisherRoots): Promise<OpResult<PublishRunResult>> {
  try {
    const result = await runPublish(filePublishEffects(roots));
    return { status: 'ok', value: result };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
