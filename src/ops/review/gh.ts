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
// This module is transport only: no argument construction, no pagination, no
// retries — and no parsing beyond ghJson's JSON.parse.
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
 * through unchanged; args go to execve directly (no shell, no quoting). A
 * spawn failure (e.g. binary missing — no `close` may follow) resolves, not
 * rejects, with the shell's command-not-found code 127 and the OS error as
 * stderr: the seam is total.
 */
export function makeGhRunner(opts?: { bin?: string }): GhFn {
  return (args: string[]) =>
    new Promise<GhResult>((resolve) => {
      const bin = opts?.bin ?? process.env.CQ_GH_BIN ?? 'gh';
      let stdout = '';
      let stderr = '';
      const child = spawn(bin, args, { env: process.env });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err: Error) => {
        resolve({ code: 127, stdout, stderr: stderr === '' ? String(err) : stderr });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
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
