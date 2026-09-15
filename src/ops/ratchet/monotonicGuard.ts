// monotonicGuard — lane H slice 2 (goal H2, ws-h item 6; old-plan §7.2).
//
// checkDiffMonotonicity is a PURE diff-mode checker: the unified diff text
// is the only input — no fs, no sources, no clock. The CI wiring that feeds
// it (the PR diff) lands in H4. The guard judges ONE property: a committed
// baseline may only move in the tightening direction — the same
// thresholds-only-tighten law checkRatchet enforces on live readings,
// applied to the diff a PR wants to commit.
//
// Parsing (deterministic, unified-diff format):
//   - Sections split on `diff --git ` lines; the new path comes from the
//     `+++ b/<path>` line (falling back to the b-side of the `diff --git
//     a/X b/Y` header, e.g. when the new side is /dev/null). Only sections
//     whose new path matches /^baselines\/.+\.json$/ are judged
//     (filesChecked counts those); src/, ci/, and every other file is
//     ignored — the guard judges baseline files only.
//   - LIFECYCLE comes from diff METADATA, never from content-line counts
//     (Codex P1): a section is ADDED only when it carries `new file mode`
//     or `--- /dev/null` — capture committing data, not a loosening of
//     existing evidence — and DELETED only when it carries `deleted file
//     mode` or `+++ /dev/null` — a removed target's prune, a legitimate
//     file lifecycle. An EXISTING-file modification CAN produce one-sided
//     content (inserting a second `"value": 100` line after the first:
//     JSON.parse honors the later duplicate and the effective threshold is
//     silently raised), so a section with content lines on only one side
//     and NO lifecycle marker FAILS CLOSED as 'unparsable baseline diff'.
//     Index/mode-only sections (no content lines at all) and
//     whitespace-only rewrites (the trimmed `-` set equals the trimmed
//     `+` set) → skip: nothing moved.
//   - Otherwise the section is MODIFIED: `"value"` — the ratcheted
//     quantity — is reconstructed ONLY from the `-`/`+` content lines (the
//     `---`/`+++` file headers are excluded so they are never mistaken for
//     removed/added content). Multiple occurrences per side resolve
//     LAST-minus against LAST-plus (hunks list old then new); a value count
//     mismatch between the sides means the pair cannot be lined up at all.
//     `"direction"`, `"metric"`, and `"target"` are identity fields: they
//     are scanned per side from the `-`/`+` lines FIRST, and when a side's
//     ± lines do not carry the field, from the section's CONTEXT lines
//     (space-prefixed hunk context — which is exactly where the direction
//     line of an unchanged baseline sits in a real value-only `git diff`
//     hunk). ± occurrences always win over context for their side; context
//     fills the gap.
//
// FAIL-CLOSED (I5: non-passing evidence, never a pass) — a MODIFIED section
// whose value pair is missing or unpairable (truncated hunks, renamed
// fields), or whose direction cannot be reconstructed from ANY line in the
// section (± or context — e.g. a baseline whose body omits direction
// entirely, or a non-Direction string on the governing side) yields
// why:'unparsable baseline diff'. Everything else is judged: a value-only
// hunk tightens or loosens exactly as its context-declared direction says,
// so a legitimate tighten PR passes and a sneaked loosen is named. A
// direction FLIP with values intact is condemned on its own terms
// (why:'direction changed'): flipping `direction` redefines which way
// "tighten" points, the same incomparable-evidence refusal captureBaseline's
// identity check enforces at write time. A same-value re-capture
// (oldValue === newValue — captureBaseline legitimately rewrites an
// equal-value baseline when only the clock moves) is skipped silently; only
// a direction flip survives that skip, and only DIFFERING values with an
// unreconstructable direction stay fail-closed. Both a 'loosened' and a
// 'direction changed' violation can fire on one section; 'unparsable' is
// terminal.
import { loosens } from './format.js';
import type { Direction } from './format.js';

/** A baseline movement a PR diff is not allowed to make. */
export interface BaselineViolation {
  /** The baselines/*.json path the diff section touches. */
  path: string;
  /** Reconstructed from the diff content when present (new side preferred). */
  target?: string;
  metric?: string;
  oldValue?: number;
  newValue?: number;
  /** Present only on 'direction changed' violations (rendered by formatViolations). */
  oldDirection?: string;
  newDirection?: string;
  why: 'loosened' | 'direction changed' | 'unparsable baseline diff';
}

export type DiffVerdict =
  | { ok: true; violations: []; filesChecked: number }
  | { ok: false; violations: BaselineViolation[]; filesChecked: number };

/** A section is a baseline iff its new path is a baselines/*.json file. */
const BASELINE_PATH = /^baselines\/.+\.json$/;

// Quote-anchored keys: `"value"` cannot match `"oldValue"` (capital V) nor
// `"myvalue"` (no quote before the v), so the extraction sees exactly the
// baseline schema's own fields.
const VALUE_RE = /"value"\s*:\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
const DIRECTION_RE = /"direction"\s*:\s*"([^"]*)"/g;
const METRIC_RE = /"metric"\s*:\s*"([^"]*)"/g;
const TARGET_RE = /"target"\s*:\s*"([^"]*)"/g;

function isDirection(d: string): d is Direction {
  return d === 'lower-is-better' || d === 'higher-is-better';
}

/** Split a unified diff into per-file sections on `diff --git ` boundaries; text before the first header is ignored. */
function splitSections(diff: string): string[][] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      sections.push(current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return sections;
}

/**
 * The section's NEW path: the `+++ b/<path>` line wins (tab-stripped — some
 * diff tools append timestamps); `/dev/null` (added/deleted files) and any
 * missing `+++ b/` fall back to the b-side of the `diff --git a/X b/Y`
 * header (last ` b/` — baseline paths contain no spaces, so this split is
 * exact for every path the guard will judge).
 */
function sectionPath(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length).split('\t')[0];
  }
  const header = lines.find((l) => l.startsWith('diff --git '));
  if (header === undefined) return null;
  const rest = header.slice('diff --git '.length);
  const bAt = rest.lastIndexOf(' b/');
  return bAt === -1 ? null : rest.slice(bAt + ' b/'.length).split('\t')[0];
}

/**
 * `-`/`+` CONTENT lines per side, with the `---`/`+++` file headers
 * excluded (they start with the same characters and would otherwise be
 * mistaken for removed/added content), plus the section's CONTEXT lines
 * (space-prefixed — hunk context; header lines never start with a space).
 * Hunk headers (`@@`), index lines, mode lines, and `\ No newline at end of
 * file` markers are ignored.
 */
function contentLines(lines: string[]): { minus: string[]; plus: string[]; context: string[] } {
  const minus: string[] = [];
  const plus: string[] = [];
  const context: string[] = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) plus.push(line.slice(1));
    else if (line.startsWith('-')) minus.push(line.slice(1));
    else if (line.startsWith(' ')) context.push(line.slice(1));
  }
  return { minus, plus, context };
}

/** True when the two sides carry the same lines modulo whitespace — a reformat, not a movement. */
function whitespaceOnly(minus: string[], plus: string[]): boolean {
  const norm = (ls: string[]): string[] => ls.map((l) => l.trim()).sort();
  const a = norm(minus);
  const b = norm(plus);
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** Count + last capture of one quoted field across one diff side. */
interface SideScan {
  count: number;
  last?: string;
}

function scanSide(lines: string[], re: RegExp): SideScan {
  let count = 0;
  let last: string | undefined;
  for (const line of lines) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      count += 1;
      last = m[1];
    }
  }
  return { count, last };
}

/**
 * Identity-field precedence for ONE side: the side's ± occurrences win; a
 * side that does not touch the field falls back to the section's context
 * lines (identical on both sides of the hunk, so they speak for each side
 * equally — this is how a value-only hunk learns the direction the
 * unchanged `direction` line declares).
 */
function preferDiffLines(inline: SideScan, context: SideScan): SideScan {
  return inline.count > 0 ? inline : context;
}

/**
 * Judge a MODIFIED baseline section (both sides have content lines). Every
 * return path is either [] (values equal / tightened under the governing
 * direction) or fail-closed violations; a section that cannot be judged is
 * NEVER silently passed (see the FAIL-CLOSED note in the header).
 */
function judgeModified(
  path: string,
  minus: string[],
  plus: string[],
  context: string[],
): BaselineViolation[] {
  // Value: ± lines ONLY — context never vouches for the ratcheted
  // quantity, because context shows the OLD state on both sides of the
  // hunk; old/new must come from the removed/added lines themselves.
  const oldSide = {
    value: scanSide(minus, VALUE_RE),
    direction: preferDiffLines(scanSide(minus, DIRECTION_RE), scanSide(context, DIRECTION_RE)),
    metric: preferDiffLines(scanSide(minus, METRIC_RE), scanSide(context, METRIC_RE)),
    target: preferDiffLines(scanSide(minus, TARGET_RE), scanSide(context, TARGET_RE)),
  };
  const newSide = {
    value: scanSide(plus, VALUE_RE),
    direction: preferDiffLines(scanSide(plus, DIRECTION_RE), scanSide(context, DIRECTION_RE)),
    metric: preferDiffLines(scanSide(plus, METRIC_RE), scanSide(context, METRIC_RE)),
    target: preferDiffLines(scanSide(plus, TARGET_RE), scanSide(context, TARGET_RE)),
  };
  const unparsable = (): BaselineViolation => ({ path, why: 'unparsable baseline diff' });
  // The ratcheted quantity must pair up old→new: a count mismatch (two
  // removed values, one added) or an absent value on either side leaves the
  // movement unjudgeable — fail closed (rules 4 and 5).
  if (oldSide.value.count !== newSide.value.count || oldSide.value.count === 0) {
    return [unparsable()];
  }
  // Direction: NEW side preferred, else OLD side (rule 3), with each side's
  // ± lines preferred over shared context. The unjudgeable-direction gate
  // below binds ONLY when the values differ — see the same-value skip.
  const newDir = newSide.direction.last;
  const oldDir = oldSide.direction.last;
  const direction = newDir ?? oldDir;
  const oldValue = Number(oldSide.value.last);
  const newValue = Number(newSide.value.last);
  const metric = newSide.metric.last ?? oldSide.metric.last;
  const target = newSide.target.last ?? oldSide.target.last;
  const violations: BaselineViolation[] = [];
  // A flip redefines which way "tighten" points — incomparable evidence
  // (fail-closed), the diff-side twin of captureBaseline's identity check.
  const flip = oldDir !== undefined && newDir !== undefined && oldDir !== newDir;
  // Same-value re-capture: with oldValue === newValue no loosening is
  // possible, and captureBaseline legitimately rewrites an equal-value
  // baseline when only the clock moves — skip the section silently
  // (filesChecked has already counted it). Two exceptions keep the guard
  // honest: a direction FLIP is condemned even at equal values (it
  // redefines the ratchet itself), and only DIFFERING values with an
  // unreconstructable direction stay fail-closed below.
  if (oldValue === newValue && flip === false) return [];
  if (oldValue !== newValue) {
    // No line in the section (± or context) declares a direction — or the
    // governing one is not a real Direction (hand-edited or corrupted
    // evidence): the loosens comparison is unjudgeable, so the section
    // fails closed (rule 4) — non-passing evidence, never a pass.
    if (direction === undefined || isDirection(direction) === false) {
      return [unparsable()];
    }
    if (loosens(oldValue, newValue, direction)) {
      violations.push({ path, target, metric, oldValue, newValue, why: 'loosened' });
    }
  }
  if (flip) {
    violations.push({
      path,
      target,
      metric,
      oldValue,
      newValue,
      why: 'direction changed',
      oldDirection: oldDir,
      newDirection: newDir,
    });
  }
  return violations;
}

/** True when any line of the section carries the metadata marker as a prefix. */
function hasMarker(lines: string[], marker: string): boolean {
  return lines.some((l) => l.startsWith(marker));
}

/** Judge a unified diff: do its baseline movements only tighten? Pure — no fs, no sources, no clock. */
export function checkDiffMonotonicity(diff: string): DiffVerdict {
  const violations: BaselineViolation[] = [];
  let filesChecked = 0;
  for (const section of splitSections(diff)) {
    const path = sectionPath(section);
    if (path === null || BASELINE_PATH.test(path) === false) continue; // judged: baseline files only
    filesChecked += 1;
    const { minus, plus, context } = contentLines(section);
    // Lifecycle from METADATA (Codex P1) — never from content-line counts:
    // an existing-file modification can produce one-sided content, and
    // counting lines would let it ride the added/deleted skips.
    if (hasMarker(section, 'new file mode') || hasMarker(section, '--- /dev/null')) {
      continue; // added baseline: capture committing data, not a loosening
    }
    if (hasMarker(section, 'deleted file mode') || hasMarker(section, '+++ /dev/null')) {
      continue; // deleted baseline: prune lifecycle, not a loosening
    }
    if (minus.length === 0 && plus.length === 0) continue; // index/mode churn only
    if (minus.length === 0 || plus.length === 0) {
      // One-sided content WITHOUT lifecycle metadata: a modification we
      // cannot confidently judge — a plus-only duplicate-"value" insertion
      // (the later duplicate wins JSON.parse and silently raises the
      // threshold), a pure insertion, or a truncated hunk — fail closed.
      violations.push({ path, why: 'unparsable baseline diff' });
      continue;
    }
    if (whitespaceOnly(minus, plus)) continue; // reformat: nothing moved
    violations.push(...judgeModified(path, minus, plus, context));
  }
  return violations.length === 0
    ? { ok: true, violations: [], filesChecked }
    : { ok: false, violations, filesChecked };
}

/** CI-ready one-line renderings, in violation order. */
export function formatViolations(violations: BaselineViolation[]): string[] {
  return violations.map((v) => {
    if (v.why === 'loosened') {
      return (
        `${v.path}: metric ${v.metric ?? '(unknown)'} loosened ` +
        `${v.oldValue} → ${v.newValue} — only tightening diffs pass`
      );
    }
    if (v.why === 'direction changed') {
      return `${v.path}: direction changed ${v.oldDirection} → ${v.newDirection}`;
    }
    return `${v.path}: unparsable baseline diff — non-passing evidence (I5)`;
  });
}
