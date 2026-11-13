// Entry-point helpers for the env snapshot (config contract C3).
//
// Every process entry (CLI main, MCP harness bin, selfhost entry modules)
// reads the environment ONCE through `checkEntryEnv`, prints the warning
// lines once, refuses to continue on any error line, and passes the snapshot
// down. Library entries (runPlan) call `assertCqEnv`, which throws one error
// listing every problem. Nothing here prints on its own.
import { formatCqEnvDiagnostics, readCqEnv, type CqEnv, type CqEnvDiagnostic } from './env.js';
import type { EntryEnv } from './run-env.js';

export interface EntryEnvCheck {
  readonly cqEnv: CqEnv;
  /**
   * A frozen copy of the environment record the snapshot was read from: the
   * entry's one capture, handed to `runWithCqEnv` and the importer wiring so
   * foreign-name readers see entry values for the whole run. A later in-place
   * `process.env` mutation cannot move it.
   */
  readonly env: EntryEnv;
  /** `cq: error: …` lines (empty when the environment is valid). */
  readonly errorLines: readonly string[];
  /** `cq: warning: …` lines, to print once per process. */
  readonly warningLines: readonly string[];
  /** Structured warnings, for a JSON result's `warnings`. */
  readonly warnings: readonly CqEnvDiagnostic[];
}

/** Snapshot the environment and render its diagnostics. */
export function checkEntryEnv(env: EntryEnv = process.env): EntryEnvCheck {
  const cqEnv = readCqEnv(env);
  return {
    cqEnv,
    // The entry's ONE capture: frozen, so the importer wiring and the run
    // context hand down the same immutable record.
    env: Object.freeze({ ...env }),
    errorLines: formatCqEnvDiagnostics({ warnings: [], errors: cqEnv.errors }),
    warningLines: formatCqEnvDiagnostics({ warnings: cqEnv.warnings, errors: [] }),
    warnings: cqEnv.warnings,
  };
}

/** A configuration (usage-class) failure: one error naming every bad CQ_* value. */
export class CqEnvError extends Error {
  readonly diagnostics: readonly CqEnvDiagnostic[];
  constructor(prefix: string, diagnostics: readonly CqEnvDiagnostic[]) {
    super(`${prefix}: invalid CQ_* environment — ${diagnostics.map((d) => d.message).join('; ')}`);
    this.name = 'CqEnvError';
    this.diagnostics = diagnostics;
  }
}

/** Throw one {@link CqEnvError} when the snapshot carries any error. */
export function assertCqEnv(cqEnv: CqEnv, prefix: string): void {
  if (cqEnv.errors.length > 0) throw new CqEnvError(prefix, cqEnv.errors);
}

/**
 * Refuse a snapshot that carries an error for `name`. A resolver that reads one
 * key from a snapshot calls this before using the (then unset) value, so an
 * invalid or denied key can never fall through to the built-in default.
 */
export function assertCqEnvName(cqEnv: CqEnv, prefix: string, name: string): void {
  const own = cqEnv.errors.filter((d) => d.name === name);
  if (own.length > 0) throw new CqEnvError(prefix, own);
}

/**
 * Process-entry gate for scripts: print each warning once and every error on
 * `stderr`, and return the check (snapshot plus the captured environment
 * record), or `undefined` when the caller must exit (code 2) before doing
 * anything.
 */
export function enterWithEntryEnv(
  stderr: (text: string) => void = (text) => void process.stderr.write(text),
  env: EntryEnv = process.env,
): EntryEnvCheck | undefined {
  const check = checkEntryEnv(env);
  for (const line of check.errorLines) stderr(`${line}\n`);
  if (check.errorLines.length > 0) return undefined;
  for (const line of check.warningLines) stderr(`${line}\n`);
  return check;
}

/**
 * The `enterWithEntryEnv` gate when the caller only needs the CQ_* snapshot.
 * Use `enterWithEntryEnv` when the entry also reads foreign names (it must
 * read them from the returned record, at entry, not from the ambient env).
 */
export function enterWithCqEnv(
  stderr: (text: string) => void = (text) => void process.stderr.write(text),
  env: EntryEnv = process.env,
): CqEnv | undefined {
  return enterWithEntryEnv(stderr, env)?.cqEnv;
}
