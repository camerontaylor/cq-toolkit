import { isProtectedStagePath, isProtectedConfigPath } from '../gates/protectedPaths.js';
import { messageOf } from '../../shared/messageOf.js';

/**
 * Compile the staged-path allowlist pattern SOURCES (jSKJY) CASE-SENSITIVELY
 * (review-debt #175 item 3): the patterns are built from manifest paths and
 * declared files, which carry the checkout's exact case. The old `i` flag let
 * a case-differing sibling package (`packages/Alpha/x` matching
 * `^packages/alpha/`) stage outside its scope on a case-sensitive checkout.
 * Exported as the case-sensitivity seam; a non-compiling source throws and
 * the caller folds it into a `failed` result.
 */
export function compileStagePathPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => new RegExp(source));
}

/** Typed result of the staged-path policy, never inferred from message text. */
export type StagePathGateResult =
  | { kind: 'clean'; paths: []; message: null }
  | { kind: 'protected'; paths: string[]; message: string }
  | { kind: 'propose-only'; paths: string[]; message: string }
  | { kind: 'scope'; paths: string[]; message: string }
  | { kind: 'infra'; paths: []; message: string };

/**
 * Apply the production staged-path policy to already-enumerated paths. The
 * unit op and tamper corpus call this same decision function.
 */
export function classifyStagePaths(
  staged: readonly string[],
  allowlist?: { patterns: string[] },
  proposeOnly = false,
  protectTests = true,
): StagePathGateResult {
  const protectedPaths = staged.filter((path) =>
    protectTests ? isProtectedStagePath(path) : isProtectedConfigPath(path),
  );
  if (protectedPaths.length > 0) {
    return {
      kind: 'protected',
      paths: protectedPaths,
      message: `sweep.unit: protected path(s) changed by a worker — ${protectedPaths.join(', ')} — tests, setup, runner/measurement config, lockfiles, automation, snapshots, and repository policy require needs-human review`,
    };
  }
  if (proposeOnly && staged.length > 0) {
    return {
      kind: 'propose-only',
      paths: [...staged],
      message: `sweep.unit: propose-only worker produced ${String(staged.length)} staged path(s) — ${staged.join(', ')}; nothing will be probed, committed, or pushed without human review`,
    };
  }
  if (allowlist === undefined) return { kind: 'clean', paths: [], message: null };
  let compiled: RegExp[];
  try {
    compiled = compileStagePathPatterns(allowlist.patterns);
  } catch (err) {
    return {
      kind: 'infra',
      paths: [],
      message: `invalid stage-path allowlist pattern — ${messageOf(err)}`,
    };
  }
  const offenders = staged.filter((path) => !compiled.some((regex) => regex.test(path)));
  return offenders.length > 0
    ? {
        kind: 'scope',
        paths: offenders,
        message:
          `staged path(s) outside the allowlist [${allowlist.patterns.join(', ')}] — ` +
          `the worker cannot commit outside its scope: ${offenders.join(', ')}`,
      }
    : { kind: 'clean', paths: [], message: null };
}

/**
 * The staged paths of one `diff --cached --name-status -z` capture: records
 * are `<status> NUL <path> [NUL <path2>]` — an R/C (rename/copy) status
 * carries the OLD then the NEW path, and BOTH are scope-checked (the source
 * is the production code a rename deletes); every other status carries one.
 */
export function stagedPathsOf(capture: string): string[] {
  const tokens = capture.split('\0').filter((token) => token !== '');
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index] as string;
    index += 1;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < pathCount; n += 1) {
      const path = tokens[index];
      if (path !== undefined) paths.push(path);
      index += 1;
    }
  }
  return paths;
}
