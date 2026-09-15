// Gates lane C3 — the hack detector (R2 D5 tamper-guard pattern): scan one
// unified diff for signs that a change games the checks instead of fixing
// the code — newly added test suppressions, deleted test files, fresh
// skip/only markers, tautological assertions. Pure text analysis: zero I/O,
// no filesystem, no subprocesses — the diff arrives as a string and the
// findings leave as an array (UC §1 rows 27–28 are the behavioral contract).
//
// Invariants honored here:
//   - ADDED LINES ONLY: removed lines are never scanned (deleting a
//     suppression is a FIX, not a hack) and context lines are never scanned
//     — pre-existing suppressions in untouched code are invisible to this
//     op by construction (UC row 28); blaming them here would punish the
//     honest touch-ups around them.
//   - Pattern knowledge is CONFIG, not vendored code: the suppression list,
//     the test-file shapes, and the skip/only marker all have shipped,
//     frozen defaults that a caller-supplied value REPLACES wholesale (the
//     bail-pattern precedent from the baseline probe).
//   - The op is a SCANNER, not a validator: diff text that still parses
//     line-by-line yields best-effort findings (often none) — a malformed
//     diff is never a `failed` op. The one `failed` path is configuration
//     whose regex sources do not compile.
//   - Regex sources arrive as strings and are compiled with `new RegExp`.
//     Callers own their trustworthiness: a pattern source is arbitrary
//     code-adjacent input, and only RE.source semantics are exercised
//     here — still, never forward untrusted strings as patterns.
import type { Op } from '../../kernel/types.js';

/**
 * One configurable suppression signature. `pattern` is a regex SOURCE
 * compiled with `new RegExp(source, flags ?? 'i')` — the caller owns its
 * trustworthiness. When `requiresReason` is true, an added line is flagged
 * ONLY when the pattern matches AND no non-empty explanatory text follows
 * the match on that line (the `@ts-expect-error`-without-reason shape);
 * any non-empty remainder counts as a reason — the mechanism does not
 * judge reason quality.
 */
export interface SuppressionPattern {
  /** Stable identifier reported in {@link TamperFinding.pattern}. */
  name: string;
  /** Regex source matched against every ADDED line's content. */
  pattern: string;
  /** Regex flags (default `'i'`). */
  flags?: string;
  /** Flag only when nothing non-empty follows the match on the same line. */
  requiresReason?: boolean;
}

/**
 * The shipped suppression signatures, frozen: consumers can reference them
 * and pass their own list (which REPLACES this one — not extends — per
 * {@link HackDetectorInput.suppressionPatterns}) but never mutate it. The
 * `@ts-*` sources anchor only at the token's END: a leading `\b` before
 * `@` can never fire in JS regexes (`@` is a non-word character, so no
 * word boundary precedes it) — `\b@ts-ignore\b` would silently never match
 * the canonical `// @ts-ignore` line, which is the exact tamper the
 * default exists to catch.
 */
export const DEFAULT_SUPPRESSION_PATTERNS: readonly SuppressionPattern[] = Object.freeze([
  { name: 'eslint-disable', pattern: '\\beslint-disable\\b' },
  { name: '@ts-ignore', pattern: '@ts-ignore\\b' },
  { name: '@ts-expect-error', pattern: '@ts-expect-error\\b', requiresReason: true },
  { name: 'istanbul ignore', pattern: '\\bistanbul\\s+ignore\\b' },
]);

/**
 * Shipped test-file shapes (regex sources, matched case-insensitively
 * against both diff paths), frozen. Only consulted for DELETED-test-file
 * detection: a file section whose old path matches one of these and whose
 * new path is `/dev/null` is a test file this change deletes.
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = Object.freeze([
  '\\.test\\.[tj]sx?$',
  '\\.spec\\.[tj]sx?$',
  '__tests__/',
]);

/**
 * Regex source of the shipped skip/only marker, matched case-insensitively
 * against every ADDED line (`describe.skip`, `it.only`, `test . skip`, …).
 * Frozen: the marker taxonomy is a shipped default, not call-site knowledge.
 */
export const DEFAULT_SKIP_ONLY_PATTERN = '\\b(describe|it|test)\\s*\\.\\s*(skip|only)\\b';

/**
 * Tamper-heuristic tuning. Every field is optional with a shipped default;
 * `testFilePatterns` REPLACES {@link DEFAULT_TEST_FILE_PATTERNS} when
 * supplied (an empty array disables deleted-test-file detection without
 * touching the other heuristics).
 */
export interface TamperConfig {
  /** Regex sources for what counts as a test file (see the shipped default). */
  testFilePatterns?: string[];
  /** Flag whole deleted test files (default true). */
  detectDeletedTests?: boolean;
  /** Flag added skip/only markers (default true). */
  detectNewSkipOnly?: boolean;
  /** Flag tautological `expect(X).toBe(X)` assertions (default true). */
  detectTautologies?: boolean;
}

/** JSON-serializable input of the `gates.hackDetector` op. Plain data. */
export interface HackDetectorInput {
  /** The full unified diff text to scan (as `git diff` produces it). */
  diff: string;
  /** Suppression signatures; when supplied this list REPLACES the shipped defaults. */
  suppressionPatterns?: SuppressionPattern[];
  /** Tamper-heuristic tuning; defaults per {@link TamperConfig}. */
  tamper?: TamperConfig;
}

/** What a finding is about. Exactly four kinds. */
export type TamperFindingKind =
  | 'suppression'
  | 'deleted-test-file'
  | 'new-skip-only'
  | 'tautological-assertion';

/**
 * One tamper finding. All fields plain data:
 *   - `file` — the new-file path the hunk tracks (`'unknown'` only for
 *     diffs too malformed to carry a `+++` header before the hunk).
 *   - `line` — the added line's position in the NEW file, from hunk-header
 *     tracking; `null` when unknowable (deleted files have no new lines).
 *   - `pattern` — which configured pattern matched: a
 *     {@link SuppressionPattern} `name` for suppressions, the regex source
 *     for the built-in skip/only and test-file heuristics; omitted for
 *     tautologies (a pure heuristic with no configured pattern).
 *   - `snippet` — the matched line's content, trimmed (the `---` header
 *     line for deleted files).
 */
export interface TamperFinding {
  kind: TamperFindingKind;
  file: string;
  line: number | null;
  pattern?: string;
  snippet: string;
  message: string;
}

/** Compiled shape of the effective config for one scan. */
interface CompiledConfig {
  suppressions: { name: string; regex: RegExp; requiresReason: boolean }[];
  testFilePatterns: { source: string; regex: RegExp }[];
  detectDeletedTests: boolean;
  skipOnly: RegExp | null;
  detectTautologies: boolean;
}

/** Hunk header: `@@ -old[,[count]] +new[,[count]] @@` — captures the new start. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Tautology heuristic: capture both sides of `expect(X).toBe(X)` and flag
 * when the trimmed texts are identical (which covers `expect(true).toBe(true)`
 * and every same-expression call shape). Deliberately greedy-free: the
 * right side runs to the final `)`, so `expect(f(a)).toBe(f(a))` captures
 * `f(a)` on both sides, and `.not.toBe(...)` never matches.
 */
const TAUTOLOGY_RE = /\bexpect\((.*)\)\.toBe\((.*)\)/;

/**
 * The `gates.hackDetector` op: `ok` in every case where the diff text was
 * scanned line-by-line — an EMPTY findings array is a clean diff, and
 * malformed diff text is best-effort scanned (the op is a scanner, not a
 * validator: it never certifies diff well-formedness). `failed` is reserved
 * for config whose regex sources do not compile. Only ADDED lines are ever
 * scanned; removed and context lines are invisible to every heuristic.
 */
export const hackDetector: Op<HackDetectorInput, TamperFinding[]> = async (input) => {
  const tamper = input.tamper ?? {};
  let config: CompiledConfig;
  try {
    config = {
      suppressions: (input.suppressionPatterns ?? DEFAULT_SUPPRESSION_PATTERNS).map((p) => ({
        name: p.name,
        regex: new RegExp(p.pattern, p.flags ?? 'i'),
        requiresReason: p.requiresReason === true,
      })),
      testFilePatterns: (tamper.testFilePatterns ?? DEFAULT_TEST_FILE_PATTERNS).map((source) => ({
        source,
        regex: new RegExp(source, 'i'),
      })),
      detectDeletedTests: tamper.detectDeletedTests ?? true,
      skipOnly: tamper.detectNewSkipOnly === false ? null : new RegExp(DEFAULT_SKIP_ONLY_PATTERN, 'i'),
      detectTautologies: tamper.detectTautologies ?? true,
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { status: 'failed', error: `invalid pattern config for hackDetector: ${messageOf(err)}` };
    }
    throw err;
  }
  return { status: 'ok', value: scanDiff(input.diff, config) };
};

/** Line-based unified-diff scan. See the module comment for what is never scanned. */
function scanDiff(diff: string, config: CompiledConfig): TamperFinding[] {
  const findings: TamperFinding[] = [];
  let oldPath: string | null = null;
  let oldHeader: string | null = null;
  let newPath: string | null = null;
  let inHunk = false;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      oldPath = null;
      oldHeader = null;
      newPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        oldHeader = line;
        oldPath = headerPathOf(line.slice(4));
        continue;
      }
      if (line.startsWith('+++ ')) {
        newPath = headerPathOf(line.slice(4));
        reportDeletedTestFile(findings, config, oldPath, oldHeader, newPath);
        continue;
      }
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        inHunk = true;
        newLine = Number(hunk[1]);
      }
      continue;
    }
    if (line.startsWith('@@ ')) {
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
      }
      continue;
    }
    if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file" — metadata, not content
    }
    if (line.startsWith('+')) {
      scanAddedLine(findings, config, newPath, newLine, line.slice(1));
      newLine++;
      continue;
    }
    if (line.startsWith('-')) {
      continue; // removed line — a deleted suppression is a fix, never scanned
    }
    newLine++; // context line ('' or ' ') advances the new-file cursor
  }
  return findings;
}

/** Deleted test file: old path matches a test-file shape, new path is /dev/null. */
function reportDeletedTestFile(
  findings: TamperFinding[],
  config: CompiledConfig,
  oldPath: string | null,
  oldHeader: string | null,
  newPath: string | null,
): void {
  if (!config.detectDeletedTests || newPath !== '/dev/null') {
    return;
  }
  if (oldPath === null || oldPath === '/dev/null') {
    return;
  }
  const matched = config.testFilePatterns.find((p) => p.regex.test(oldPath as string));
  if (!matched) {
    return;
  }
  findings.push({
    kind: 'deleted-test-file',
    file: oldPath,
    line: null,
    pattern: matched.source,
    snippet: oldHeader ?? `--- a/${oldPath}`,
    message: `test file deleted by this change: ${oldPath}`,
  });
}

/** Every heuristic, against one ADDED line's content only. */
function scanAddedLine(
  findings: TamperFinding[],
  config: CompiledConfig,
  newPath: string | null,
  line: number,
  content: string,
): void {
  const file = newPath ?? 'unknown';
  const snippet = content.trim();
  for (const suppression of config.suppressions) {
    const match = suppression.regex.exec(content);
    if (!match) {
      continue;
    }
    if (suppression.requiresReason && content.slice(match.index + match[0].length).trim() !== '') {
      continue;
    }
    findings.push({
      kind: 'suppression',
      file,
      line,
      pattern: suppression.name,
      snippet,
      message: suppression.requiresReason
        ? `added suppression "${suppression.name}" without the required same-line reason`
        : `added suppression "${suppression.name}"`,
    });
  }
  if (config.skipOnly?.test(content)) {
    findings.push({
      kind: 'new-skip-only',
      file,
      line,
      pattern: DEFAULT_SKIP_ONLY_PATTERN,
      snippet,
      message: 'added line marks a test as skipped or focused',
    });
  }
  if (config.detectTautologies) {
    const tautology = TAUTOLOGY_RE.exec(content);
    if (tautology && tautology[1].trim() === tautology[2].trim()) {
      findings.push({
        kind: 'tautological-assertion',
        file,
        line,
        snippet,
        message: 'added assertion compares an expression to itself',
      });
    }
  }
}

/** Path from a `---`/`+++` header body: `/dev/null`, or the path sans a/ b/ prefix. */
function headerPathOf(rest: string): string {
  const trimmed = rest.replace(/\t.*$/, '').trim();
  if (trimmed === '/dev/null') {
    return '/dev/null';
  }
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
