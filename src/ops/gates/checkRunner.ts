// Gates lane C1 — the generic CheckRunner contract: turn a check tool's raw
// captured output (test / lint / typecheck) into a typed FailureSet. Pure
// decision core: zero I/O beyond the INJECTED RunCheck seam — the shipped
// {@link subprocessRunCheck} is the lane's only process-touching piece, and
// it sits behind the seam so tests inject fakes and never spawn processes.
//
// Invariants honored here:
//   - I5 (non-passing evidence): "unparsable" NEVER conflates with "clean".
//     The parse verdict is either `parsed` (a FailureSet, possibly empty) or
//     `indeterminate` (the adapter did not recognize the output shape) —
//     empty output alone is never a pass for a summary-bearing tool.
//   - Output shape is adapter CONFIG, not vendored knowledge: named adapters
//     are pure JSON-describable config ({@link AdapterName}); a custom
//     {@link CheckAdapter} object is the library-level extension and cannot
//     cross the JSON op boundary (CheckRunnerInput carries only the name).
//   - The op decides NOTHING beyond mapping parse verdicts onto the frozen
//     OpResult taxonomy — gate decisions live in C2's probe/gate ops.
import { execFile } from 'node:child_process';
import type { Op } from '../../kernel/types.js';
import { eslintJsonAdapter } from './adapters/eslint.js';
import { tscLinesAdapter } from './adapters/tsc.js';
import { vitestJsonAdapter } from './adapters/vitest.js';

/** The command a check op asks its injected runner to execute. */
export interface CheckCommand {
  command: string;
  args: string[];
  cwd?: string;
}

/** Raw captured output of one check run — plain captured bytes, serializable. */
export interface RawCheckOutput {
  stdout: string;
  stderr: string;
  /**
   * Process exit code, or null when the runner could not observe one
   * (killed by signal, timed out, buffer overflow, spawn failure).
   */
  exitCode: number | null;
}

/**
 * Injected execution seam — the ONE I/O point of the check-runner lane.
 * Tests inject fakes; production injects {@link subprocessRunCheck}.
 */
export type RunCheck = (cmd: CheckCommand) => Promise<RawCheckOutput>;

/** One typed failure extracted from a tool report. */
export interface CheckFailure {
  /** Source file as the tool reported it (null when it attributed none). */
  file: string | null;
  line: number | null;
  column: number | null;
  /** Rule or diagnostic identifier (eslint ruleId, TS code); null when none. */
  ruleId: string | null;
  message: string;
  severity: 'error' | 'warning';
}

/** The typed failure set for one tool run — the op's entire output. */
export interface FailureSet {
  tool: string;
  failures: CheckFailure[];
  exitCode: number | null;
}

/**
 * Parse verdict that never conflates "unparsable" with "clean" (I5):
 * `indeterminate` means the adapter did not RECOGNIZE the output shape —
 * callers must treat it as non-passing evidence, never as a pass.
 */
export type CheckParseResult =
  | { verdict: 'parsed'; set: FailureSet }
  | { verdict: 'indeterminate'; reason: string };

/**
 * Adapter names shipped as JSON-describable config. Each names a wire
 * format the toolkit parses; the wire knowledge itself lives in ./adapters.
 */
export type AdapterName = 'vitest-json' | 'eslint-json' | 'tsc-lines';

/**
 * Output-shape adapter: the ONLY home of tool-specific wire knowledge.
 * Named adapters (looked up by {@link AdapterName}) cross the op boundary
 * as data; a custom CheckAdapter object is the library-level extension and
 * cannot — it carries a function field.
 */
export interface CheckAdapter {
  name: string;
  parse(raw: RawCheckOutput): CheckParseResult;
}

/** JSON-serializable input of the `gates.checkRunner` op. */
export interface CheckRunnerInput {
  adapter: AdapterName;
  command: CheckCommand;
}

/** The named adapters, by config name. */
export function adapterByName(name: AdapterName): CheckAdapter {
  switch (name) {
    case 'vitest-json':
      return vitestJsonAdapter;
    case 'eslint-json':
      return eslintJsonAdapter;
    case 'tsc-lines':
      return tscLinesAdapter;
  }
}

/** Run one adapter over one raw capture — the single call site the op uses. */
export function parseCheckOutput(adapter: CheckAdapter, raw: RawCheckOutput): CheckParseResult {
  return adapter.parse(raw);
}

/**
 * Build the `gates.checkRunner` op over an injected runner. Verdict mapping
 * is the op's ENTIRE decision surface: `parsed` → `ok` (the FailureSet),
 * `indeterminate` → `indeterminate` (the reason as detail), a thrown or
 * rejected runner → `failed` (the runner never produced evidence).
 */
export function makeCheckRunner(run: RunCheck): Op<CheckRunnerInput, FailureSet> {
  return async (input) => {
    let raw: RawCheckOutput;
    try {
      raw = await run(input.command);
    } catch (err) {
      return { status: 'failed', error: messageOf(err) };
    }
    const result = parseCheckOutput(adapterByName(input.adapter), raw);
    return result.verdict === 'parsed'
      ? { status: 'ok', value: result.set }
      : { status: 'indeterminate', detail: result.reason };
  };
}

/**
 * The default injected runner: execFile-based, capturing stdout/stderr as
 * strings and reporting exitCode null whenever no code was observed (killed
 * by signal, timed out, buffer overflow, spawn failure). Never rejects — a
 * check that RAN and misbehaved still produced a RawCheckOutput; only the
 * op-level contract turns a runner-level throw into `failed`.
 */
export const subprocessRunCheck: RunCheck = (cmd) =>
  new Promise((resolve) => {
    execFile(
      cmd.command,
      cmd.args,
      { cwd: cmd.cwd, maxBuffer: CHECK_OUTPUT_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });

/** Generous capture ceiling — a big real report must not truncate into a fake indeterminate. */
const CHECK_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
