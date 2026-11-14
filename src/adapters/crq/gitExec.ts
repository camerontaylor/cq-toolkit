/**
 * Bounded Git subprocess helper for the review/author capability adapters.
 *
 * Mirrors `author_snapshot.git`: no ambient `GIT_*` variables, no system or
 * global config, no terminal prompt, replace refs disabled, and a hard
 * wall-clock bound. Children are registered so a forced-command deadline can
 * kill the whole set before the process exits; a snapshot Git call never
 * outlives its request.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { currentEntryEnv } from '../../config/run-env.js';

/** Hard per-call wall-clock bound (`author_snapshot.git` uses 10s). */
export const GIT_CALL_TIMEOUT_MS = 10_000;
/** Captured output ceiling for snapshot/history reads (`author_snapshot.MAX_WIRE`). */
export const GIT_MAX_OUTPUT = 6 * 1024 * 1024;

export interface GitResult {
  readonly code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(currentEntryEnv())) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Live git children, killed when the forced command hits its deadline. */
export class GitPool {
  private readonly children = new Set<ChildProcess>();

  killAll(): void {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.children.clear();
  }

  track(child: ChildProcess): void {
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
  }
}

/** One Git call with stdin, bounded output and a wall-clock kill. */
export function gitCall(
  pool: GitPool,
  cwd: string,
  args: readonly string[],
  options: {
    readonly input?: Uint8Array;
    readonly timeoutMs?: number;
    readonly maxOutput?: number;
  } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? GIT_CALL_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? GIT_MAX_OUTPUT;
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['-C', cwd, '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...GIT_HARDEN, ...args],
      {
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    pool.track(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64) stderr.push(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: new Uint8Array(0), stderr: 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: overflow ? new Uint8Array(0) : new Uint8Array(Buffer.concat(stdout)),
        stderr: overflow ? 'output exceeded bound' : Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (options.input !== undefined) child.stdin.end(Buffer.from(options.input));
    else child.stdin.end();
  });
}

/** The successful stdout of one Git call, or a refusal with the stderr line. */
export async function gitOk(
  pool: GitPool,
  cwd: string,
  args: readonly string[],
  options: { readonly input?: Uint8Array; readonly timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const result = await gitCall(pool, cwd, args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().slice(0, 200) || 'git operation refused');
  }
  return result.stdout;
}
