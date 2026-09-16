// The injectable `gh` CLI runner — E1 slice 1 (goal E1: address-review fetch
// lane).
//
// Every gh interaction in the review family goes through a `GhFn`: a thin
// `(args) => Promise<GhResult>` seam that RESOLVES with the exit code instead
// of throwing on nonzero, so each caller implements its own fail-closed
// policy. The default runner spawns the real `gh`; CLI-driven tests
// substitute a fake gh script via the CQ_GH_BIN environment seam (or
// `makeGhRunner({ bin })` directly).
//
// This module is transport only: no argument construction, no pagination,
// no retries — and no parsing beyond ghJson's JSON.parse PLUS the two
// shared payload/request guards every review consumer imports (the
// owner/repo spelling validator and the `--paginate --slurp` payload
// normalizer) — hoisted here so the seams cannot drift apart.
import { spawn } from 'node:child_process';

/** Result of one `gh` invocation: the exit code plus the captured streams. */
export interface GhResult {
  /** gh's exit code — resolved, never thrown; 0 is success. */
  code: number;
  /** Captured stdout, verbatim. */
  stdout: string;
  /** Captured stderr, verbatim. */
  stderr: string;
}

/**
 * The gh seam: one invocation of the gh CLI with the given argv (sans the
 * binary name). Resolves with the exit code — does NOT throw on nonzero —
 * so callers can implement their own fail-closed policies.
 */
export type GhFn = (args: string[]) => Promise<GhResult>;

/**
 * A gh invocation that failed (nonzero exit) or whose stdout was not the
 * JSON the caller asked for. Carries the exit code, the captured stderr, and
 * the argv — never the stdout, which may be arbitrarily large.
 */
export class GhError extends Error {
  /** gh's exit code (0 when the failure is unparseable stdout, not gh). */
  readonly code: number;
  /** Captured stderr, verbatim. */
  readonly stderr: string;
  /** The argv passed to gh, sans the binary name. */
  readonly args: string[];

  constructor(code: number, stderr: string, args: string[], why: string) {
    const argv = args.map((arg) => JSON.stringify(arg)).join(' ');
    const trimmed = stderr.trim();
    super(`gh ${why} (exit ${code}): gh ${argv}${trimmed === '' ? '' : `\nstderr: ${trimmed}`}`);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

/**
 * The default GhFn: spawns `opts.bin`, else CQ_GH_BIN, else `'gh'` (CQ_GH_BIN
 * is the seam CLI-driven tests use to substitute a fake gh script), captures
 * both streams, and resolves with code + streams. The environment passes
 * through unchanged, layered with `opts.env` overrides (the test seam for
 * scenario/log plumbing like CQ_GH_SCENARIO and CQ_GH_LOG); args go to execve
 * directly (no shell, no quoting). `timeoutMs` — default UNDEFINED, wait
 * forever — SIGKILLs the child when it elapses and resolves (never rejects,
 * the seam stays total) with the timeout convention code 124 and a
 * `gh timed out after <ms>ms` marker appended to stderr. A spawn failure
 * (e.g. binary missing — no `close` may follow) resolves with the shell's
 * command-not-found code 127 and the OS error as stderr.
 */
export function makeGhRunner(opts?: {
  bin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): GhFn {
  return (args: string[]) =>
    new Promise<GhResult>((resolve) => {
      const bin = opts?.bin ?? process.env.CQ_GH_BIN ?? 'gh';
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      const child = spawn(bin, args, { env: { ...process.env, ...opts?.env } });
      // The runner — not the child — owns this one wall clock: it bounds a
      // single spawned gh invocation and OBEYS by killing, never by deciding
      // policy (the governor owns WHEN a run aborts; this only bounds one
      // subprocess so a hung gh cannot wedge the caller forever).
      const timer =
        opts?.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, opts.timeoutMs)
          : undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', (err: Error) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({
          code: 127,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: stderr === '' ? String(err) : stderr,
        });
      });
      child.on('close', (code) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        // UTF-8 decoded ONCE over the whole stream: a multi-byte character
        // split across pipe chunks must survive (chunk-wise decoding would
        // replace it with U+FFFD).
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        let stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (timedOut) {
          stderr = `${stderr}\ngh timed out after ${String(opts?.timeoutMs)}ms`;
        }
        resolve({ code: timedOut ? 124 : (code ?? -1), stdout, stderr });
      });
    });
}

/**
 * Run gh and parse its stdout as JSON. Throws GhError on a nonzero exit
 * (message carries the stderr and the argv, never the stdout) or when stdout
 * does not parse (the error's code is gh's 0 — the failure is ours, not
 * gh's). Returns the parsed value otherwise.
 */
export async function ghJson<T>(run: GhFn, args: string[]): Promise<T> {
  const result = await run(args);
  if (result.code !== 0) {
    throw new GhError(result.code, result.stderr, args, 'failed');
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new GhError(result.code, result.stderr, args, 'printed non-JSON output');
  }
}

/** The only owner/repo spellings allowed near a gh REST path (the E1
 * convention, shared by every review consumer so the seams cannot drift). */
export const GH_NAME_OK = /^[A-Za-z0-9_.-]+$/;

/**
 * The shared transport guard for owner/repo spellings: GH_NAME_OK plus the
 * DOT-SEGMENT rule — "." and ".." pass the charset but ride into the
 * request path as relative segments (`repos/../..`), so they are rejected
 * outright (values containing "/" already fail the charset). Callers keep
 * their own module-prefixed error messages (the fail-loud convention names
 * the module that refused); this predicate is the single source of the
 * accept/reject decision.
 */
export const ghNameOk = (value: string): boolean =>
  GH_NAME_OK.test(value) && value !== '.' && value !== '..';

/**
 * Normalize a `--paginate --slurp` REST payload to PAGES. THREE shapes
 * arrive in the wild and are read defensively:
 *   - `[[page1…], [page2…]]` — the --slurp shape (gh >= 2.51): ONE outer
 *     array of page arrays — used as the page list;
 *   - `[c1, c2, …]` — already-flat (an older gh variant, or pages merged
 *     flat WITHOUT --slurp) — tolerated as ONE retained page;
 *   - `[]` — empty under either reading.
 * A MIXED payload (array pages alongside non-array entries) satisfies
 * NEITHER shape and throws with the request path in the message — a
 * silently partial read would corrupt every count built on top of it.
 * Transport-level by design: no cap, retention, or truncation policy —
 * callers decide what the pages mean.
 */
export function slurpedComments<T = unknown>(payload: unknown, path: string): T[][] {
  if (!Array.isArray(payload)) {
    throw new Error(`gh api ${path} returned a non-array payload — payload untrustworthy`);
  }
  const allPages = payload.every((entry) => Array.isArray(entry));
  const anyPages = payload.some((entry) => Array.isArray(entry));
  if (payload.length > 0 && allPages !== anyPages) {
    throw new Error(
      `gh api ${path} returned a MIXED page payload (array pages alongside non-array entries) — payload untrustworthy`,
    );
  }
  return allPages ? (payload as T[][]) : [payload as T[]];
}
