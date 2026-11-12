// Gates lane C3 — the expectation-change observer (#1198): scan one unified
// diff for places where a test's existing assertion value was rewritten in
// place — the oracle dispute contract item 10 (RI4, Giles Q32) requires an
// attempt report to surface ("otherwise report the oracle dispute
// unchanged"). Pure text analysis like the hack detector: zero I/O, no
// filesystem, no subprocesses — the diff arrives as a string and the
// observations leave as an array.
//
// This is an OBSERVER, not a gate finding: it never participates in any gate
// verdict. A governed fix lane may edit failing tests behind the commit,
// tamper and regression gates; changing an existing expectation needs an
// oracle-specific finding, a current ruling and independent acceptance, and
// until those exist the change is reported — never refused here and never
// waved through silently. The tamper scan keeps its own verdicts unchanged.
//
// What counts (deliberately narrow): within one edit block of a hunk in a
// test file (the shared protected-path test taxonomy — no new taxonomy), a
// removed line and the re-added line replacing it BOTH look like they sit
// inside an assertion call (`expect(`, `assert`, `.toBe(`, `.toEqual(`, or a
// `==` comparison) and their contents differ. One-sided matches flag
// nothing: a fresh assertion has no disputed oracle (the tamper scan already
// classifies fresh skip/focus markers), and deleting an assertion outright is
// the removed-test heuristic's territory, not a rewritten expectation.
//
// Invariants honored here:
//   - PAIRED LINES ONLY: a removed line is reported only when a re-added
//     line replaces it in the same edit block; removed lines are otherwise
//     invisible, exactly as in the hack detector (deleting a failing
//     assertion is an edit, not an expectation rewrite).
//   - Pattern knowledge is not call-site knowledge: the test-file shapes are
//     the one base-owned taxonomy from `protectedPaths.ts`.
//   - The op is a SCANNER, not a validator: diff text that parses
//     line-by-line yields best-effort observations (often none) — a
//     malformed diff is never an error here. Standard two-party unified
//     diffs only, mirroring the hack detector's parser.
//   - Only the paired before/after assertion lines are ever recorded — no
//     hunk context, no neighboring lines — so the observation carries no
//     content beyond the dispute itself.
import { isProtectedTestPath } from './protectedPaths.js';

/**
 * One rewritten test expectation. All fields plain data:
 *   - `file` — the new-file path the hunk tracks.
 *   - `line` — the re-added line's position in the NEW file, from
 *     hunk-header tracking (the same semantics as a tamper finding's line).
 *   - `before` — the removed assertion line's content, trimmed.
 *   - `after` — the re-added assertion line's content, trimmed.
 */
export interface ExpectationChange {
  file: string;
  line: number;
  before: string;
  after: string;
}

/**
 * Assertion-call shape, matched against BOTH sides of the pair on the raw
 * line content (comment syntax deliberately unrecognized — the noise
 * direction is the hack detector's accepted trade). The `==` arm covers
 * plain comparison assertions in any language (`x === 1`, `assert x == 1`).
 */
const ASSERTION_RE = /(?:\bexpect\s*\(|\bassert\b|\.toBe\s*\(|\.toEqual\s*\(|==)/;

/** Hunk header: `@@ -old[,[count]] +new[,[count]] @@` — captures the new start. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The expectation-change observer: every place the diff rewrites an
 * assertion line inside a test file, as `{ file, line, before, after }`.
 * An empty array is a diff with no rewritten test expectation — and since
 * this is an observer, callers render absence as absence (no entry, never
 * an empty entry) and must never read a verdict out of it.
 */
export function expectationChangesOf(diff: string): ExpectationChange[] {
  const changes: ExpectationChange[] = [];
  let newPath: string | null = null;
  let inHunk = false;
  let newLine = 0;
  // Removed lines of the current edit block awaiting their re-additions, in
  // order: a context line (or a hunk/section boundary) ends the block — a
  // replacement never spans untouched code.
  let removed: string[] = [];
  const clearBlock = (): void => {
    removed = [];
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      clearBlock();
      newPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        newPath = headerPathOf(line.slice(4));
        continue;
      }
      if (line.startsWith('--- ')) continue;
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        inHunk = true;
        newLine = Number(hunk[1]);
        clearBlock();
      }
      continue;
    }
    if (line.startsWith('@@ ')) {
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        clearBlock();
      }
      continue;
    }
    if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file" — metadata, not content
    }
    if (line.startsWith('+')) {
      const added = line.slice(1);
      const before = removed.shift();
      if (before !== undefined && newPath !== null && isProtectedTestPath(newPath)) {
        const beforeTrim = before.trim();
        const afterTrim = added.trim();
        if (beforeTrim !== afterTrim && ASSERTION_RE.test(before) && ASSERTION_RE.test(added)) {
          changes.push({ file: newPath, line: newLine, before: beforeTrim, after: afterTrim });
        }
      }
      newLine++;
      continue;
    }
    if (line.startsWith('-')) {
      removed.push(line.slice(1));
      continue; // removed line — reported only when a re-added line pairs it
    }
    clearBlock();
    newLine++; // context line ('' or ' ') ends the edit block and advances the cursor
  }
  return changes;
}

/** Path from a `+++` header body: `/dev/null`, or the path sans b/ prefix. */
function headerPathOf(rest: string): string {
  const trimmed = rest.replace(/\t.*$/, '').trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
      ? trimmed.slice(1, -1)
      : trimmed;
  if (unquoted === '/dev/null') return '/dev/null';
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
}
