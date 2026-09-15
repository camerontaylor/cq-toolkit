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
//     whitespace-only rewrites (the trimmed `-` lines equal the trimmed
//     `+` lines IN ORDER — a sort would hide duplicate-key reorders, whose
//     effective value is the LAST key JSON.parse honors) → skip: nothing
//     moved.
//   - Otherwise the section is MODIFIED: `"value"` — the ratcheted
//     quantity — is reconstructed ONLY from the `-`/`+` content lines (the
//     `---`/`+++` file headers are excluded so they are never mistaken for
//     removed/added content). Multiple occurrences per side resolve
//     LAST-minus against LAST-plus (hunks list old then new); a value count
//     mismatch between the sides means the pair cannot be lined up at all.
//     `"direction"`, `"metric"`, `"target"`, and `"unit"` are identity
//     fields: they are scanned per side from the `-`/`+` lines FIRST, and
//     when a side's ± lines do not carry the field, from the section's
//     CONTEXT lines (space-prefixed hunk context — which is exactly where
//     the direction line of an unchanged baseline sits in a real value-only
//     `git diff` hunk). ± occurrences always win over context for their
//     side; context fills the gap.
//
// FAIL-CLOSED (I5: non-passing evidence, never a pass) — a MODIFIED section
// whose value pair is missing or unpairable (truncated hunks, renamed
// fields), or NON-FINITE on either side (`"value": 1e999` is valid JSON
// parsing to Infinity — parseBaseline would reject the committed file as
// corrupt), or whose direction cannot be reconstructed from ANY line in the
// section (± or context — e.g. a baseline whose body omits direction
// entirely, or a non-Direction string on the governing side) yields
// why:'unparsable baseline diff'. Everything else is judged: a value-only
// hunk tightens or loosens exactly as its context-declared direction says,
// so a legitimate tighten PR passes and a sneaked loosen is named. A
// direction FLIP with values intact is condemned on its own terms
// (why:'direction changed'): flipping `direction` redefines which way
// "tighten" points, the same incomparable-evidence refusal captureBaseline's
// identity check enforces at write time — and so is a direction PRESENCE
// change (the field removed or added on exactly one side): the committed
// file would be schema-invalid. A same-value re-capture
// (oldValue === newValue — captureBaseline legitimately rewrites an
// equal-value baseline when only the clock moves) is skipped silently — and
// so is the REAL git shape of that rewrite, where the value line rides in
// undiffed context and counts as UNMOVED; only a direction flip survives
// that skip, and only genuinely DIFFERING values with an unreconstructable
// direction stay fail-closed. A UNIT change between the
// sides (Codex P1: `0.8 ratio` → `70 pct` must never read as an 87.5×
// tightening) is why:'unit changed' — incomparable scale: the loosens
// comparison NEVER runs across units, the section is terminal, and a unit
// appearing or vanishing re-scales the evidence exactly as much. Both a
// 'loosened' and a 'direction changed' violation can fire on one section;
// 'unparsable' is terminal.
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
  /** Present only on 'unit changed' violations; an absent side is undefined (rendered 'undefined'). */
  oldUnit?: string;
  newUnit?: string;
  why: 'loosened' | 'direction changed' | 'unit changed' | 'unparsable baseline diff';
}

export type DiffVerdict =
  | { ok: true; violations: []; filesChecked: number }
  | { ok: false; violations: BaselineViolation[]; filesChecked: number };

/** A section is a baseline iff its new path is a baselines/*.json file. */
const BASELINE_PATH = /^baselines\/.+\.json$/;

// Quote-anchored keys: `"value"` cannot match `"oldValue"` (capital V) nor
// `"myvalue"` (no quote before the v), so the extraction sees exactly the
// baseline schema's own fields.
// VALUE_RE is a STRICT JSON-number token with a terminator lookahead
// (post-cap Codex wave): without it, numeric PREFIXES of invalid JSON were
// judged as thresholds the committed file never contained — `1.` captured
// as 1, `01x` as 0, `.70` matched via the old leading-dot alternative. Now
// `.70` cannot start a match at all, and `1.` / `01x` fail the lookahead
// (the next char continues a number) → no capture → value unreconstructable
// → the existing fail-closed paths handle it. `1e999` still matches and is
// rejected by the non-finite gate in judgeModified.
const VALUE_RE = /"value"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[,}\s]|$)/g;
// String-field bodies capture the COMPLETE JSON string INCLUDING escape
// sequences (`[^"\\]|\\.` — a body may not contain a bare quote, but an
// ESCAPED quote `\"` is part of the value). The capture is JSON-decoded at
// consumption (decodeJsonString): the old `[^"]*` body stopped at the
// first escape's quote, so `scale\"old` and `scale\"new` both captured
// `scale\\` — the unit identity check read a REAL SCALE CHANGE as
// unchanged and the same-value shortcut waved it through (review-debt
// #79/#80).
// KEY presence (PR #108 review, Codex P1 + CodeRabbit Major): the value
// regexes capture only WELL-FORMED complete escaped strings — an
// UNTERMINATED body (a stray backslash before the closing quote) matches
// nothing, so the field read as absent. Key presence is tracked
// separately: a key the side carries whose value cannot be captured is
// malformed committed evidence — fail closed, never a lucky pass.
// ANCHORED to the property position (PR #123 review, Codex P2 — the
// PR #118 finding's hardening, landed for real this time): keys match
// only at a line's leading-whitespace property position. In RENDERED
// baselines quotes inside values are always JSON-escaped (\"), so an
// unanchored regex could not match them either — but a HAND-CRAFTED or
// hostile diff line can carry the raw sequence mid-line, and the anchor
// makes the property-position intent structural instead of incidental.
const DIRECTION_KEY_RE = /^\s*"direction"\s*:/g;
const DIRECTION_RE = /"direction"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const METRIC_RE = /"metric"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const TARGET_RE = /"target"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const UNIT_KEY_RE = /^\s*"unit"\s*:/g;
const UNIT_RE = /"unit"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Decode one captured JSON string body (the capture EXCLUDES the quotes):
 * re-quote and JSON.parse. undefined when the escapes are malformed — a
 * field the committed file could not parse back, which the strict callers
 * treat as fail-closed evidence.
 */
function decodeJsonString(escaped: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(`"${escaped}"`);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isDirection(d: string): d is Direction {
  return d === 'lower-is-better' || d === 'higher-is-better';
}

/** Split a unified diff into per-file sections on `diff --git ` boundaries; text before the first header is ignored. Lines are CRLF-normalized (a trailing `\r` would otherwise survive into extracted paths and fail the `$`-anchored baseline regex, silently skipping every section). */
function splitSections(diff: string): string[][] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      current = [line];
      sections.push(current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return sections;
}

/** Path prefixes git dialects put on diff paths (plus noprefix config, which has none). */
const DIFF_PREFIXES: readonly string[] = ['b/', 'a/', 'i/', 'w/', 'c/', 'o/'];

function stripDiffPrefix(p: string): string {
  for (const prefix of DIFF_PREFIXES) {
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return p;
}

/**
 * The section's NEW path, across dialects: the `+++ <path>` line wins
 * (tab-stripped — some diff tools append timestamps), accepting every
 * standard prefix (b/, a/, i/, w/, c/, o/) and noprefix config; a
 * `/dev/null` new-side is not a path (it means added/deleted — decided from
 * header metadata, item below) and falls back to the `diff --git a/X b/Y`
 * header, whose b-side is the LAST known-prefix marker in the line, or —
 * noprefix dialect — the second half of the printed-identical `X X` pair.
 */
function sectionPath(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith('+++ /dev/null')) continue; // lifecycle marker, not a path
    if (line.startsWith('+++ ')) return stripDiffPrefix(line.slice('+++ '.length).split('\t')[0]);
  }
  const header = lines.find((l) => l.startsWith('diff --git '));
  if (header === undefined) return null;
  const rest = header.slice('diff --git '.length);
  let bestAt = -1;
  let bestPrefix = '';
  for (const prefix of DIFF_PREFIXES) {
    const at = rest.lastIndexOf(` ${prefix}`);
    if (at > bestAt) {
      bestAt = at;
      bestPrefix = prefix;
    }
  }
  if (bestAt !== -1) {
    return stripDiffPrefix(rest.slice(bestAt + 1 + bestPrefix.length).split('\t')[0]);
  }
  // noprefix dialect prints the identical path twice: 'X X'. The pair is
  // always ODD-length (2·|X| + 1 for the separator space), so floor-halve:
  // first = rest[0..half), second = rest(half..] and the two must match.
  const half = Math.floor(rest.length / 2);
  const first = rest.slice(0, half);
  if (first.length > 0 && rest.slice(half + 1) === first) return first;
  return null;
}

/** The section's METADATA region: every line before the first hunk header (`@@`). */
function headerRegion(lines: string[]): string[] {
  const header: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) break;
    header.push(line);
  }
  return header;
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

/**
 * True when any line set carries the direction or unit KEY whose value is
 * malformed — uncapturable (an unterminated escape: the value regex
 * matches nothing) or undecodable (an invalid escape sequence) — PR #108
 * review (Codex P1 + CodeRabbit Major). Checked BEFORE the
 * whitespace-only reformat skip: a rewrite whose two sides are IDENTICALLY
 * malformed is not a reformat, it is committed evidence the file could not
 * parse back — fail closed wherever it appears.
 */
function carriesMalformedStringField(minus: string[], plus: string[], context: string[]): boolean {
  const fields: Array<[RegExp, RegExp]> = [
    [DIRECTION_KEY_RE, DIRECTION_RE],
    [UNIT_KEY_RE, UNIT_RE],
  ];
  for (const [keyRe, valueRe] of fields) {
    for (const lines of [minus, plus, context]) {
      const keys = scanSide(lines, keyRe).count;
      if (keys === 0) continue;
      const values = scanSide(lines, valueRe);
      if (values.count === 0) return true; // key present, nothing capturable
      if (values.last !== undefined && decodeJsonString(values.last) === undefined) return true;
    }
  }
  return false;
}

/** True when the two sides carry the same lines modulo whitespace, IN ORDER — a reformat, not a movement. */
function whitespaceOnly(minus: string[], plus: string[]): boolean {
  // No sort: a reorder of duplicate `"value"` keys presents the same line
  // multiset in a different order, and the effective value (the LAST key
  // JSON.parse honors) moves with it — that is a movement, judged below,
  // never a "reformat".
  if (minus.length !== plus.length) return false;
  const a = minus.map((l) => l.trim());
  const b = plus.map((l) => l.trim());
  return a.every((l, i) => l === b[i]);
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
 * return path is either [] (nothing moved — equal values, or the value
 * untouched in context — or tightened under the governing direction) or
 * fail-closed violations; a section that cannot be judged is NEVER silently
 * passed (see the FAIL-CLOSED note in the header).
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
    unit: preferDiffLines(scanSide(minus, UNIT_RE), scanSide(context, UNIT_RE)),
  };
  const newSide = {
    value: scanSide(plus, VALUE_RE),
    direction: preferDiffLines(scanSide(plus, DIRECTION_RE), scanSide(context, DIRECTION_RE)),
    metric: preferDiffLines(scanSide(plus, METRIC_RE), scanSide(context, METRIC_RE)),
    target: preferDiffLines(scanSide(plus, TARGET_RE), scanSide(context, TARGET_RE)),
    unit: preferDiffLines(scanSide(plus, UNIT_RE), scanSide(context, UNIT_RE)),
  };
  const unparsable = (): BaselineViolation => ({ path, why: 'unparsable baseline diff' });
  // The ratcheted quantity must pair up old→new WHENEVER either side shows
  // it: a count mismatch leaves the movement unjudgeable — fail closed
  // (rules 4 and 5). When BOTH counts are 0, the value sat in undiffed
  // context (the real -U3 clock-only re-capture shape): the value is
  // UNMOVED — undefined on both sides, never Number(undefined) — and
  // judgment falls through to the flip/unit checks. Both counts 0 with no
  // value in context anywhere (renamed fields, garbage content) remains
  // fail-closed: nothing identifies what moved.
  if (oldSide.value.count !== newSide.value.count) {
    return [unparsable()];
  }
  const valuesMoved = oldSide.value.count > 0;
  if (valuesMoved === false && scanSide(context, VALUE_RE).count === 0) {
    return [unparsable()];
  }
  // Direction: reconstructed per side — ± lines preferred over shared
  // context. Three mutually exclusive outcomes drive the verdicts below:
  // both sides present (flip/loosens under the NEW side's direction),
  // exactly ONE side present (the field was removed or added — the
  // committed file would be schema-invalid: parseBaseline rejects it, and
  // the guard's semantics would be undefined → terminal 'direction
  // changed'), or neither (a moved value is unjudgeable → fail-closed; an
  // unmoved value-only hunk passes via the shared context value).
  // String fields decode BEFORE any comparison (review-debt #79/#80): the
  // captures are JSON-escaped bodies, and only decoded values can be
  // compared. A present-but-undecodable direction (malformed escapes) is
  // fail-closed below via the undefined direction path; metric/target are
  // labels on violations and decode leniently (raw fallback keeps the
  // evidence named).
  // Key-presence fail-closed (PR #108 review, Codex P1 + CodeRabbit
  // Major): a side whose section CARRIES the direction key but yields no
  // decodable value — the value regex could not capture a complete
  // escaped body (unterminated escape) or the capture does not decode
  // (malformed escape) — is committed evidence the file could not parse
  // back. Unparsable, never a lucky pass and never a silent absence.
  const oldDirKeyPresent =
    preferDiffLines(scanSide(minus, DIRECTION_KEY_RE), scanSide(context, DIRECTION_KEY_RE)).count > 0;
  const newDirKeyPresent =
    preferDiffLines(scanSide(plus, DIRECTION_KEY_RE), scanSide(context, DIRECTION_KEY_RE)).count > 0;
  const newDir =
    newSide.direction.last === undefined ? undefined : decodeJsonString(newSide.direction.last);
  const oldDir =
    oldSide.direction.last === undefined ? undefined : decodeJsonString(oldSide.direction.last);
  if (
    (oldDirKeyPresent && oldDir === undefined) ||
    (newDirKeyPresent && newDir === undefined)
  ) {
    return [unparsable()];
  }
  const direction = newDir ?? oldDir;
  const oldValue: number | undefined = valuesMoved ? Number(oldSide.value.last) : undefined;
  const newValue: number | undefined = valuesMoved ? Number(newSide.value.last) : undefined;
  // Codex P1 (round 3, code-freeze fix): `"value": 1e999` is valid JSON
  // that parses to Infinity — parseBaseline rejects the committed baseline
  // as non-finite, so a diff moving the threshold onto a non-finite number
  // is corrupt evidence in the making. Comparing it raw would wave the
  // diff through (loosens(80, Infinity, 'higher-is-better') is false), so
  // a non-finite value on EITHER side fails closed.
  if (valuesMoved && (Number.isFinite(oldValue) === false || Number.isFinite(newValue) === false)) {
    return [unparsable()];
  }
  const metricRaw = newSide.metric.last ?? oldSide.metric.last;
  const targetRaw = newSide.target.last ?? oldSide.target.last;
  const metric = metricRaw === undefined ? undefined : (decodeJsonString(metricRaw) ?? metricRaw);
  const target = targetRaw === undefined ? undefined : (decodeJsonString(targetRaw) ?? targetRaw);
  const violations: BaselineViolation[] = [];
  // A flip redefines which way "tighten" points — incomparable evidence
  // (fail-closed), the diff-side twin of captureBaseline's identity check.
  const oldHasDir = oldDir !== undefined;
  const newHasDir = newDir !== undefined;
  const flip = oldHasDir && newHasDir && oldDir !== newDir;
  const directionPresenceChange = oldHasDir !== newHasDir;
  // Direction PRESENCE change (final post-cap Codex wave): removing (or
  // adding) the direction field on exactly one side makes the committed
  // baseline schema-invalid — parseBaseline would reject it — and leaves
  // the ratchet's semantics undefined. Terminal, like the unit gate, and
  // fired regardless of value movement; never for value-only-in-context
  // sections (both sides resolve to the same shared context value).
  if (directionPresenceChange) {
    return [
      {
        path,
        target,
        metric,
        oldValue,
        newValue,
        why: 'direction changed',
        oldDirection: oldDir,
        newDirection: newDir,
      },
    ];
  }
  // Unit identity (Codex P1): a scale change is incomparable however the
  // numbers line up — `0.8 ratio` → `70 pct` would otherwise read as an
  // 87.5× "tightening". Undefined counts as a value on BOTH sides: adding
  // or dropping the unit line re-scales the evidence just as much. The
  // section is TERMINAL here — the loosens comparison never runs across
  // units, and a flip is moot once the scale itself moved.
  // Units compare DECODED (review-debt #79/#80): `scale\"old` → `scale\"new`
  // is a real scale change — the old raw capture truncated both to
  // `scale\\` and the same-value shortcut waved the change through. The
  // key-presence rule applies here too (PR #108 review, Codex P1): a side
  // CARRYING the unit key whose value cannot be captured (unterminated
  // escape — the value regex matches nothing) or decoded (malformed
  // escape) is unparsable — the committed file could not parse back.
  const oldUnitKeyPresent =
    preferDiffLines(scanSide(minus, UNIT_KEY_RE), scanSide(context, UNIT_KEY_RE)).count > 0;
  const newUnitKeyPresent =
    preferDiffLines(scanSide(plus, UNIT_KEY_RE), scanSide(context, UNIT_KEY_RE)).count > 0;
  const oldUnitRaw = oldSide.unit.last;
  const newUnitRaw = newSide.unit.last;
  const oldUnit = oldUnitRaw === undefined ? undefined : decodeJsonString(oldUnitRaw);
  const newUnit = newUnitRaw === undefined ? undefined : decodeJsonString(newUnitRaw);
  if ((oldUnitKeyPresent && oldUnit === undefined) || (newUnitKeyPresent && newUnit === undefined)) {
    return [unparsable()];
  }
  if (oldUnit !== newUnit) {
    return [
      {
        path,
        target,
        metric,
        oldValue,
        newValue,
        why: 'unit changed',
        oldUnit,
        newUnit,
      },
    ];
  }
  // Same-value (or value-unmoved-in-context) re-capture: with the value
  // identical on both sides — or never touched by any hunk — no loosening
  // is possible, and captureBaseline legitimately rewrites an equal-value
  // baseline when only the clock moves — skip the section silently
  // (filesChecked has already counted it). Two exceptions keep the guard
  // honest: a direction FLIP is condemned even at equal values (it
  // redefines the ratchet itself — a PRESENCE change was already handled
  // above, terminal), and only DIFFERING values with an unreconstructable
  // direction stay fail-closed below.
  if (oldValue === newValue && flip === false) return [];
  if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
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
    if (path === null) {
      // Unknown dialect (Codex P1 round 2): content we cannot attribute to
      // a file is never silently unchecked — fail closed, naming the raw
      // section header. Header-only noise (no content lines at all) stays
      // ignored: there is nothing there to judge.
      const { minus, plus } = contentLines(section);
      if (minus.length > 0 || plus.length > 0) {
        violations.push({ path: section[0], why: 'unparsable baseline diff' });
      }
      continue;
    }
    if (BASELINE_PATH.test(path) === false) continue; // judged: baseline files only
    filesChecked += 1;
    // Binary baselines (post-cap Codex wave): a `Binary files ... differ`
    // line or a `GIT binary patch` payload has no ± lines to reconstruct —
    // and binary content is exactly what parseBaseline would reject as
    // corrupt. Fail closed; never ride the index/mode-only skip.
    if (hasMarker(section, 'Binary files') || hasMarker(section, 'GIT binary patch')) {
      violations.push({ path, why: 'unparsable baseline diff' });
      continue;
    }
    const { minus, plus, context } = contentLines(section);
    // Lifecycle from METADATA (Codex P1) — never from content-line counts:
    // an existing-file modification can produce one-sided content, and
    // counting lines would let it ride the added/deleted skips. The
    // /dev/null markers are honored only in the HEADER region (before the
    // first `@@`): a ± content line that renders as `--- /dev/null` (a
    // removed line whose own content was `-- /dev/null`) is evidence
    // movement, not file lifecycle.
    const header = headerRegion(section);
    // BELT-AND-BRACES COMPOSITION (review-debt #120 item 2, pinned here):
    // these lifecycle skips are per-DIFF by design — the two-PR
    // delete-then-re-add-LOOSER composition (PR 1 deletes the baseline, PR
    // 2 re-adds it looser) crosses TWO diffs and is invisible to any
    // single-diff guard. The LIVE checkRatchet leg catches it: PR 2's run
    // finds the baseline MISSING (PR 1 deleted it) and fails closed (I5 —
    // missing evidence is never passing evidence). Both legs are
    // load-bearing; neither alone is the whole defense.
    if (hasMarker(header, 'new file mode') || hasMarker(header, '--- /dev/null')) {
      continue; // added baseline: capture committing data, not a loosening
    }
    if (hasMarker(header, 'deleted file mode') || hasMarker(header, '+++ /dev/null')) {
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
    if (carriesMalformedStringField(minus, plus, context)) {
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
    if (v.why === 'unit changed') {
      // An absent side is rendered 'undefined' — a unit that appears or
      // vanishing re-scales the evidence exactly like a rename.
      return `${v.path}: unit changed ${v.oldUnit ?? 'undefined'} → ${v.newUnit ?? 'undefined'} — incomparable scale`;
    }
    return `${v.path}: unparsable baseline diff — non-passing evidence (I5)`;
  });
}
