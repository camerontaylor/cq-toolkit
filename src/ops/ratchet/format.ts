// Ratchet baseline file format — lane H slice 1.
//
// One baseline file per (target, metric): the unit the ratchet op family
// compares against. The file is committed evidence, so two properties are
// load-bearing:
//   - renderBaseline is BYTE-DETERMINISTIC: keys are emitted in schema order
//     regardless of the caller's insertion order, 2-space indent, exactly one
//     trailing newline. The same baseline always renders to the same bytes,
//     so a re-capture cannot produce a spurious diff.
//   - parseBaseline is STRICT: zod validates the full schema (extra keys fail
//     rather than being silently stripped, `value` must be finite — JSON's
//     1e999 parses to Infinity — and `capturedAt` must be a strict ISO-8601
//     instant per isIso8601Instant) and violations throw a plain Error with a
//     clear message.
// tightens/loosens are pure comparators: equal values are neither, so an
// unchanged metric never rewrites a baseline.
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Which way the metric's "better" points. */
export type Direction = 'lower-is-better' | 'higher-is-better';

/** The persisted baseline: one file per (target, metric). */
export interface BaselineFile {
  schemaVersion: 1;
  /** What is measured: a logical name or repo-relative path. */
  target: string;
  /** Adapter id, e.g. 'typecheck-count'. */
  metric: string;
  direction: Direction;
  /** The ratcheted value. */
  value: number;
  /** Adapter-defined, e.g. 'errors', 'pct'. */
  unit?: string;
  /** ISO-8601 timestamp. */
  capturedAt: string;
}

// Strict ISO-8601 instant: fixed-shape calendar date + time + optional
// sub-second digits + Z or numeric offset. Date.parse alone is NOT enough —
// it accepts locale formats ('September 15, 2026') and normalizes
// nonexistent calendar dates ('2026-02-30' rolls into March 2) — so shape
// and round-trip are checked explicitly below.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict ISO-8601 instant validation, shared by parseBaseline's schema and
 * captureBaseline's input check. Three gates: (1) the fixed shape above;
 * (2) Date.parse-able; (3) round-trip — the input, rebuilt in Z-form
 * (offset removed, sub-second digits TRUNCATED to milliseconds — beyond-ms
 * digits carry no baseline meaning), must equal the parsed instant's
 * toISOString(). A calendar-rollover input ('2026-02-30T00:00:00Z') parses
 * to a different instant than its own components claim, so the rebuilt
 * string disagrees and the input is rejected.
 */
export function isIso8601Instant(iso: string): boolean {
  if (ISO_INSTANT_PATTERN.test(iso) === false) return false;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return false;
  const offsetMatch = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const offsetMs =
    offsetMatch === null
      ? 0
      : (offsetMatch[1] === '-' ? -1 : 1) *
        (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) *
        60000;
  // The input's wall clock, as a UTC timestamp: the parse already subtracted
  // the stated offset from the wall clock, so ADD it back (Z inputs: no-op).
  const wallMs = instant.getTime() + offsetMs;
  const rebuilt = new Date(wallMs).toISOString();
  const expected = iso
    .replace(
      /(\.\d{1,9})?(?=Z$|[+-]\d{2}:\d{2}$)/,
      (_: string, frac: unknown) =>
        `.${(typeof frac === 'string' ? frac : '.000').slice(1, 4).padEnd(3, '0')}`,
    )
    .replace(/[+-]\d{2}:\d{2}$/, 'Z');
  return rebuilt === expected;
}

const BaselineFileSchema: z.ZodType<BaselineFile> = z
  .object({
    schemaVersion: z.literal(1),
    target: z.string(),
    metric: z.string(),
    direction: z.enum(['lower-is-better', 'higher-is-better']),
    value: z.number().finite(),
    unit: z.string().exactOptional(),
    capturedAt: z.string().refine(isIso8601Instant, {
      message: 'capturedAt must be a strict ISO-8601 instant (e.g. 2026-09-15T12:00:00Z)',
    }),
  })
  .strict();

/** Serialize a baseline deterministically: schema-order keys, 2-space indent, trailing newline. */
export function renderBaseline(b: BaselineFile): string {
  // Rebuilt field-by-field so the emitted key order is the schema order, not
  // the caller's insertion order. `unit: undefined` is dropped by
  // JSON.stringify, matching the schema's optional field.
  const ordered = {
    schemaVersion: b.schemaVersion,
    target: b.target,
    metric: b.metric,
    direction: b.direction,
    value: b.value,
    unit: b.unit,
    capturedAt: b.capturedAt,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parse and validate baseline text; throws a plain Error on any schema violation. */
export function parseBaseline(text: string): BaselineFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`baseline: not valid JSON — ${(err as Error).message}`, { cause: err });
  }
  const parsed = BaselineFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`baseline: schema violation — ${issues}`);
  }
  return parsed.data;
}

/**
 * Human-readable segment budget: truncating each sanitized segment keeps
 * every path component under the 255-byte filesystem limit for ANY input,
 * and loses NO distinctness — the digest (computed over the UNtruncated raw
 * pair) carries identity, so distinct long inputs still get distinct paths.
 */
const MAX_SEGMENT_CHARS = 80;

/** Collapse a target/metric to a path segment: lowercase, [a-z0-9-] only, no doubled or edge dashes, ≤80 chars. */
function sanitizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SEGMENT_CHARS);
}

/**
 * 12-hex (48-bit) disambiguator over the RAW (unsanitized) pair: distinct
 * originals stay collision-resistant in their baseline paths even when
 * sanitization collapses them ('src/kernel' and 'src-kernel' both sanitize
 * to 'src-kernel'). The digest input is the canonical JSON of the raw pair
 * (JSON.stringify([target, metric])) — an injective encoding, so even a raw
 * pair containing NUL itself cannot alias a different pair (a
 * NUL-delimited concatenation could: ('a\0-', 'x') vs ('a', '-\0x')).
 * Deterministic: same pair, same digest.
 */
function pathDigest(target: string, metric: string): string {
  return createHash('sha256')
    .update(JSON.stringify([target, metric]), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

/**
 * Deterministic repo-relative path for one (target, metric) baseline —
 * collision-RESISTANT, not collision-proof: the 48-bit raw-pair digest makes
 * a sanitization collision practically impossible without pretending a
 * 48-bit space cannot ever clash. Each sanitized segment is truncated to
 * {@link MAX_SEGMENT_CHARS} chars, so the longest component
 * (80 + 2 + 80 + 2 + 12 + 5) stays far under the 255-byte filesystem limit
 * for any input.
 */
export function baselineRelPath(target: string, metric: string): string {
  return `baselines/${sanitizeSegment(target)}--${sanitizeSegment(metric)}--${pathDigest(target, metric)}.json`;
}

/** True when `next` improves on `prev` for direction `d`; equal values are never a tighten. */
export function tightens(prev: number, next: number, d: Direction): boolean {
  return d === 'lower-is-better' ? next < prev : next > prev;
}

/** True when `next` regresses on `prev` for direction `d`; equal values are never a loosen. */
export function loosens(prev: number, next: number, d: Direction): boolean {
  return d === 'lower-is-better' ? next > prev : next < prev;
}

// ---------------------------------------------------------------------------
// Coverage diff re-basis — the uniform comparison basis for the diff guard
// ---------------------------------------------------------------------------

/**
 * Strict JSON-number token with a terminator lookahead (the guard's own
 * VALUE_RE shape, mirrored): a fractional baseline `"value"` is the only
 * thing this rewrites. Global for `replace` reuse (String.replace resets
 * `lastIndex`), never shared across a live `exec`.
 */
const DIFF_VALUE_TOKEN =
  /("value"\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[,}\s]|$)/g;

/** Fallback coverage-section matcher for callers without an engine-computed exact path. */
const COVERAGE_BASELINE_SECTION = /^baselines\/coverage/;

/** Every git path prefix a `+++`/`---` header may carry. */
const DIFF_PATH_PREFIXES = ['b/', 'a/', 'i/', 'w/', 'c/', 'o/'];

/** Path after a `+++ `/`--- ` header, prefix- and timestamp-stripped; null for /dev/null. */
function diffHeaderPath(line: string): string | null {
  const raw = line.slice(4);
  if (raw.startsWith('/dev/null')) return null;
  const path = raw.split('\t')[0];
  if (path === undefined) return null;
  for (const prefix of DIFF_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/**
 * Uniform comparison basis for the diff-mode guard — COVERAGE baselines
 * only: rewrite every `"value": <non-integer>` token to the SAME integer
 * normalization the live coverage reading uses (`Math.round`), on every
 * `-`/`+`/context line inside `baselines/coverage*` sections only.
 *
 * Rationale: a baseline and a reading must be compared in the SAME
 * granularity, and integer-pct is the COVERAGE reading's granularity (the
 * `coverage-json` source rounds `total.lines.pct` the same way) — a
 * fractional committed coverage baseline would be judged against a
 * differently-scaled number. The re-basis hunk `93.46 → 93` must read as the
 * no-op it is (both sides normalize to 93: equal passes), while a TRUE
 * loosening (`93 → 92`) still fails and a genuine tighten in fractional
 * clothing (`92.4 → 93`, old side normalizes to 92) still passes as a
 * tighten.
 *
 * SCOPE IS DELIBERATELY NARROW (PR-105 round-2 finding 4): other metrics'
 * granularity is their own — complexity avg-cx lives at 2 decimals, where
 * `2.40 → 2.49` is a REAL change, not noise — so their sections pass through
 * byte-identical and the guard judges them at full precision. Normalizing
 * them would round the loosening into an equal no-op and mask it.
 *
 * This is a symmetric COMPARISON-BASIS normalization applied to both diff
 * sides alike — never a guard exception: it cannot flip a loosening into a
 * pass, only remove sub-granularity float noise from both sides. The engine
 * (monotonicGuard) is untouched; the rewritten text is what it judges.
 * Sections are attributed by their `---`/`+++` file headers (before the
 * first `@@` — after it, `---`-prefixed lines are removed CONTENT and are
 * normalized like any other content line); every other file's diff passes
 * through byte-identical, so a `"value": 1.5` in a source-file hunk is
 * never touched.
 *
 * This is the ONE implementation shared by the `ratchet.monotonicGuard` op
 * (the required workflow's path) and the local `scripts/ratchet-check.mjs`
 * driver (through `loadEngine`).
 */
export function normalizeBaselineDiffValues(
  diff: string,
  exactCoverageBaselinePath?: string,
): string {
  const out: string[] = [];
  let isCoverageSection = false;
  let inHunk = false;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      isCoverageSection = false; // re-resolved by this section's own headers
      inHunk = false;
      out.push(line);
      continue;
    }
    if (inHunk === false && (line.startsWith('+++ ') || line.startsWith('--- '))) {
      const path = diffHeaderPath(line);
      // Assigned PER HEADER, never only-if-matches: a sibling file's header
      // must RESET the flag, so a non-coverage section following a coverage
      // one can never inherit its normalization. Keyed on the EXACT
      // coverage-baseline path when the caller provides it (review-debt
      // #120: a path-prefix regex would also catch an unrelated baseline
      // whose target merely starts with 'coverage').
      isCoverageSection =
        path !== null &&
        (exactCoverageBaselinePath !== undefined
          ? path === exactCoverageBaselinePath
          : COVERAGE_BASELINE_SECTION.test(path));
      out.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true; // from here on, `---`-prefixed lines are removed content
      out.push(line);
      continue;
    }
    if (
      isCoverageSection &&
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
    ) {
      out.push(
        line.replace(
          DIFF_VALUE_TOKEN,
          (_, head: string, num: string) => head + String(Math.round(Number(num))),
        ),
      );
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
