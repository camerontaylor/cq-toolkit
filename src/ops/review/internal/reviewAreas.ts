import { createHash } from 'node:crypto';
import type { ScanComponentInput } from '../../dev/denylist.js';

/**
 * Pure area-grouping helpers for the R6 reviewer lane (#508 follow-up): a
 * deterministic bounded grouping of one review's components into areas, an
 * immutable changed-file manifest, and the separately reserved cross-area
 * contract pass. Nothing here runs a session, builds a prompt or touches the
 * driver: callers own dispatch, budgets and coverage accounting. Grouping
 * failure is explicit (`unsafe`/`oversized`), so a caller can retain the
 * existing partition fallback instead of receiving a degraded grouped plan.
 */

/** Documented area bounds; `planReviewAreas` fills omitted fields with these. */
export const REVIEW_AREA_DEFAULTS = {
  /** Maximum summed UTF-16 chars for one area before it is split. */
  maxCharsPerArea: 30_000,
  /** Maximum file count for one area before it is split. */
  maxFilesPerArea: 12,
  /** Maximum areas across the whole change before grouping is oversized. */
  maxAreas: 12,
  /** The common intent is bounded to this many UTF-16 chars per area. */
  maxIntentChars: 2_000,
  /** Maximum summed contract-descriptor chars for one area. */
  maxCharsPerContractArea: 20_000,
  /** Planning reserve for the cross-area pass prompt (not a spend). */
  crossAreaPromptReserveChars: 8_000,
} as const;

/**
 * A changed line that touches a contract other code depends on. Same
 * vocabulary as the planner's `CONTRACT_LINE`, evaluated on a marker-stripped
 * line, so `export` matches anywhere the declared name begins an export
 * (diff `+`/`-` prefixes are already stripped before this runs). Exported so
 * consumers pin the exact match instead of re-deriving it.
 */
export const REVIEW_AREA_CONTRACT_LINE =
  /(?:\bexport\s|\b(?:schemaVersion|z\.object|z\.enum|z\.union|z\.literal|z\.array|z\.record|z\.tuple|migrations?|persisted)\b|\b[A-Za-z0-9_]+Schema\b)/;

/** Contract descriptors stay bounded: the trimmed line contributes at most this many chars. */
const CONTRACT_SNIPPET_CHARS = 64;

/**
 * Bounded descriptor for one contract line: `<path>:<trimmed line snippet>`,
 * or '' when the line matches no contract. Callers pass the content line with
 * any diff marker already stripped; the descriptor never embeds whole untyped
 * lines, so contract lists stay prompt-sized.
 */
export function contractDescriptor(path: string, line: string): string {
  if (!REVIEW_AREA_CONTRACT_LINE.test(line)) return '';
  return `${path}:${line.trim().slice(0, CONTRACT_SNIPPET_CHARS)}`;
}

/** One manifest row per reviewed component; byte identity without the text. */
export interface ReviewChangedFile {
  /** 1-based position of the component in the reviewed slice. */
  readonly index: number;
  readonly path: string;
  /** UTF-16 length of the component text (coverage-piece `chars`). */
  readonly chars: number;
  /** UTF-8 byte length (coverage-piece `bytes`). */
  readonly bytes: number;
  /** SHA-256 of the exact component text (coverage-piece `sha256`). */
  readonly sha256: string;
  /** True when the component identity is `untracked:<path>`. */
  readonly untracked: boolean;
}

/** One area: the files it owns, the contracts they touch, the shared intent. */
export interface ReviewArea {
  /** `area-1`, `area-2`, … in plan order; stable and referenceable. */
  readonly id: string;
  /** Ascending 1-based `changedFiles[].index` references owned by this area. */
  readonly files: readonly number[];
  /**
   * Sorted unique contract descriptors for the area's files, bounded to
   * `maxCharsPerContractArea` summed chars; `contractTruncated` records an
   * exceeded bound instead of silently dropping evidence.
   */
  readonly contracts: readonly string[];
  /** True when contracts overflowed `maxCharsPerContractArea` and were cut. */
  readonly contractsTruncated: boolean;
  /** The common change intent, bounded to `maxIntentChars`. */
  readonly intent: string;
}

/** A successful grouping: areas plus the manifest the cross-area pass reads. */
export interface ReviewAreaPlan {
  readonly kind: 'areas';
  readonly areas: readonly ReviewArea[];
  /** Immutable, one row per reviewed component, in reviewed order. */
  readonly changedFiles: readonly ReviewChangedFile[];
  /** Summed UTF-16 chars across the manifest. */
  readonly totalChars: number;
  /**
   * The cross-area contract pass over the manifest. `required` is a plan
   * property: a failed required pass leaves the review incomplete, never
   * clean. The reserve is prompt-planning data, not a token spend.
   */
  readonly crossAreaPass: {
    readonly required: boolean;
    readonly reason: string;
    readonly promptReserveChars: number;
  };
}

/** Grouping was not safe within its bounds; the caller keeps its fallback. */
export interface ReviewAreaFallback {
  readonly kind: 'unsafe' | 'oversized';
  /** Why grouping stopped, naming the exact bound or ambiguity. */
  readonly reason: string;
  readonly changedFiles: readonly ReviewChangedFile[];
  readonly totalChars: number;
}

export type ReviewAreaResult = ReviewAreaPlan | ReviewAreaFallback;

/**
 * The plan with the cross-area prompt reserve held. Purely an accounting
 * view: it never adds, removes or re-scores primary coverage — the covered
 * bytes are still exactly each area's component bytes. `primaryMaxChars`
 * bounds what primary sessions may spend chars on; the reserve is separate.
 */
export interface ReservedReviewAreaPlan {
  readonly kind: 'areas';
  readonly plan: ReviewAreaPlan;
  readonly reserveChars: number;
  readonly primaryMaxChars: number;
}

/**
 * Settled outcomes per area id, from the caller's session evidence: `true`
 * only for an area whose session ran to a complete verdict. An id absent
 * from the map has not settled; `false` records a failed or aborted area.
 */
export type AreaCompletion = ReadonlyMap<string, boolean>;

/**
 * Paths the cross-area contract pass actually covered, recorded by its
 * consumer. Membership discharges a manifest path from primary-coverage
 * accounting in a future wiring; an empty set (pass omitted, failed, or
 * not yet run) discharges nothing.
 */
export type CrossAreaCoveredPaths = ReadonlySet<string>;

const DIFF_MARKER = /^(?:diff --git |@@ )/m;

/** Frozen manifest row: identity and sizes, never the component text. */
function changedFile(index: number, component: ScanComponentInput): ReviewChangedFile {
  return Object.freeze({
    index,
    path: component.path,
    chars: component.text.length,
    bytes: Buffer.byteLength(component.text, 'utf8'),
    sha256: createHash('sha256').update(component.text).digest('hex'),
    untracked: component.component.startsWith('untracked:'),
  });
}

/**
 * Content lines to inspect for contracts: diff `+`/`-` lines for tracked
 * components (ignoring headers and hunk markers), whole lines for untracked
 * or plain text. Mirrors the planner's changed-line conventions.
 */
function contractLines(component: ScanComponentInput): readonly string[] {
  const untracked = component.component.startsWith('untracked:');
  if (untracked || !DIFF_MARKER.test(component.text)) return component.text.split('\n');
  const lines: string[] = [];
  for (const line of component.text.split('\n')) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@')
    )
      continue;
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    lines.push(line.slice(1));
  }
  return lines;
}

function contractsFor(component: ScanComponentInput): readonly string[] {
  const descriptors: string[] = [];
  for (const line of contractLines(component)) {
    const descriptor = contractDescriptor(component.path, line);
    if (descriptor !== '') descriptors.push(descriptor);
  }
  return descriptors;
}

/** Same bounded truncation convention as the planner's context caps. */
function boundedIntent(intent: string, maxIntentChars: number): string {
  if (intent.length <= maxIntentChars) return intent;
  const marker = `\n[truncated: ${String(intent.length - maxIntentChars)} characters omitted]`;
  if (marker.length >= maxIntentChars) return intent.slice(0, maxIntentChars);
  return intent.slice(0, maxIntentChars - marker.length) + marker;
}

/** Directory affinity key: everything before the last path segment. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '(root)' : path.slice(0, cut);
}

interface Split {
  areas: number;
  groups: readonly (readonly ScanComponentInput[])[];
}

/**
 * Split one directory bucket greedily in input order: flush when the current
 * area reaches `maxFilesPerArea` files or would pass `maxCharsPerArea`. A
 * single component larger than the char cap keeps its own area — the cap
 * bounds an area, never a file. Deterministic; never reorders.
 */
function splitBucket(
  bucket: readonly ScanComponentInput[],
  maxCharsPerArea: number,
  maxFilesPerArea: number,
): Split {
  const groups: ScanComponentInput[][] = [];
  let current: ScanComponentInput[] = [];
  let currentChars = 0;
  for (const component of bucket) {
    if (
      current.length >= maxFilesPerArea ||
      (current.length > 0 && currentChars + component.text.length > maxCharsPerArea)
    ) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(component);
    currentChars += component.text.length;
  }
  if (current.length > 0) groups.push(current);
  return { areas: groups.length, groups };
}

/** Code-unit comparison: byte-identical sort order on every host, no locale data. */
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Bound one area's contract descriptors to `maxCharsPerContractArea` summed
 * chars: keep whole descriptors while they fit (each including its single
 * separating newline), drop the rest, and return whether anything was cut so
 * the plan records the loss explicitly instead of degrading silently.
 * Deterministic: descriptors are sorted first, so the kept set is stable.
 */
function boundContracts(
  descriptors: readonly string[],
  maxCharsPerContractArea: number,
): { contracts: readonly string[]; truncated: boolean } {
  let used = 0;
  const kept: string[] = [];
  for (const descriptor of descriptors) {
    const cost = descriptor.length + 1;
    if (used + cost > maxCharsPerContractArea) return { contracts: kept, truncated: true };
    kept.push(descriptor);
    used += cost;
  }
  return { contracts: kept, truncated: false };
}

/**
 * Deterministically group the reviewed components of one change into areas.
 *
 * - Group by directory affinity, split oversized buckets by char/file bounds,
 *   and refuse (never degrade) when grouping exceeds `maxAreas` or the input
 *   is ambiguous (duplicate identities or duplicate changed paths).
 * - Attach the common intent to every area and the exact byte identity of
 *   every reviewed component to the manifest, so a caller can align planned
 *   sessions with its coverage pieces without a second source of truth.
 * - Plan the separately budgeted cross-area contract pass whenever the change
 *   spans areas or touches contracts.
 *
 * Excluded components are the caller's concern: pass only the reviewed slice,
 * exactly what should be covered. Empty intent is valid; the same input always
 * yields the same output.
 */
export function planReviewAreas(input: {
  intent?: string;
  components: readonly ScanComponentInput[];
}): ReviewAreaResult {
  const reviewed = input.components;
  const manifest = reviewed.map((component, index) => changedFile(index + 1, component));
  const totalChars = reviewed.reduce((total, component) => total + component.text.length, 0);
  const fallback = (kind: 'unsafe' | 'oversized', reason: string): ReviewAreaFallback =>
    Object.freeze({ kind, reason, changedFiles: Object.freeze(manifest), totalChars });

  if (reviewed.length === 0) return fallback('unsafe', 'review areas: no reviewed components');
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const component of reviewed) {
    if (component.component.length === 0)
      return fallback('unsafe', 'review areas: component identities must not be empty');
    if (identities.has(component.component))
      return fallback(
        'unsafe',
        `review areas: duplicate component identity '${component.component}'`,
      );
    identities.add(component.component);
    if (paths.has(component.path))
      return fallback('unsafe', `review areas: duplicate changed path '${component.path}'`);
    paths.add(component.path);
  }

  const buckets = new Map<string, ScanComponentInput[]>();
  for (const component of reviewed) {
    const directory = directoryOf(component.path);
    const bucket = buckets.get(directory);
    if (bucket === undefined) buckets.set(directory, [component]);
    else bucket.push(component);
  }

  const maxCharsPerArea = REVIEW_AREA_DEFAULTS.maxCharsPerArea;
  const maxFilesPerArea = REVIEW_AREA_DEFAULTS.maxFilesPerArea;
  const maxAreas = REVIEW_AREA_DEFAULTS.maxAreas;
  const groups: (readonly ScanComponentInput[])[] = [];
  for (const bucket of buckets.values()) {
    const split = splitBucket(bucket, maxCharsPerArea, maxFilesPerArea);
    groups.push(...split.groups);
  }
  if (groups.length > maxAreas)
    return fallback(
      'oversized',
      `review areas: grouping needs ${String(groups.length)} areas, over the maxAreas bound ${String(maxAreas)}`,
    );

  const intent = boundedIntent(input.intent ?? '', REVIEW_AREA_DEFAULTS.maxIntentChars);
  const maxCharsPerContractArea = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
  // Insertion-ordered buckets keep each group's components in reviewed order,
  // so group membership maps onto ascending manifest indexes without a lookup.
  const indexByComponent = new Map(reviewed.map((component, index) => [component, index + 1]));
  const areas: ReviewArea[] = [];
  let areaIndex = 0;
  for (const group of groups) {
    areaIndex += 1;
    const descriptors = new Set<string>();
    for (const component of group)
      for (const descriptor of contractsFor(component)) descriptors.add(descriptor);
    const sorted = [...descriptors].sort(compareCodeUnits);
    const bounded = boundContracts(sorted, maxCharsPerContractArea);
    areas.push(
      Object.freeze({
        id: `area-${String(areaIndex)}`,
        files: Object.freeze(group.map((component) => indexByComponent.get(component)!)),
        contracts: Object.freeze(bounded.contracts),
        contractsTruncated: bounded.truncated,
        intent,
      }),
    );
  }
  const frozenAreas = Object.freeze(areas);

  const required = frozenAreas.length > 1 || frozenAreas.some((area) => area.contracts.length > 0);
  const truncated = frozenAreas.some((area) => area.contractsTruncated);
  return Object.freeze({
    kind: 'areas',
    areas: frozenAreas,
    changedFiles: Object.freeze(manifest),
    totalChars,
    crossAreaPass: Object.freeze({
      required,
      reason: required
        ? truncated
          ? 'review areas share one change intent; a cross-area contract pass is required (some areas truncated their contract list at maxCharsPerContractArea)'
          : 'review areas share one change intent; a cross-area contract pass is required'
        : 'single area without contracts: no cross-area contract pass required',
      promptReserveChars: REVIEW_AREA_DEFAULTS.crossAreaPromptReserveChars,
    }),
  });
}

/**
 * Hold the cross-area prompt reserve out of the plan's char total. Purely an
 * accounting view for the caller's budget: it never adds, removes or
 * re-scores primary coverage, and a held reserve does not discharge any
 * requirement — a failed required area or cross-area pass still leaves the
 * review incomplete. The reserve can only be held before the first area
 * completes; afterwards the change is spent on primary coverage and the
 * caller must not defer completeness to a pass that cannot fit.
 */
export function reserveCrossAreaPass(
  plan: ReviewAreaPlan,
  reserveChars: number,
  completedAreaIds: readonly string[],
): ReservedReviewAreaPlan {
  if (!Number.isInteger(reserveChars) || reserveChars < 0 || reserveChars > plan.totalChars)
    throw new Error(
      `review areas: cross-area reserve must be an integer within 0..${String(plan.totalChars)} (got ${String(reserveChars)})`,
    );
  if (completedAreaIds.length > 0)
    throw new Error(
      'review areas: the cross-area reserve can only be held before the first area completes',
    );
  return Object.freeze({
    kind: 'areas',
    plan,
    reserveChars,
    primaryMaxChars: plan.totalChars - reserveChars,
  });
}

/**
 * Whether `path` is excluded from primary-coverage accounting because the
 * cross-area contract pass covered it AND primary coverage is actually
 * settled complete. Primary completion stays independently mandatory:
 *
 * - the path's own area must be completed, so a failed, aborted or unsettled
 *   required area keeps its paths primary-covered even when the covered set
 *   names them (context replay is not primary evidence);
 * - every OTHER area in the plan must also be completed, so one covered path
 *   cannot mask a failed sibling area's incomplete coverage;
 * - a cross-area pass recorded required=false discharges nothing at all;
 * - paths outside the manifest were never primary coverage to begin with.
 */
export function isExcludedFromPrimaryCoverage(
  reserved: ReservedReviewAreaPlan,
  completedAreas: AreaCompletion,
  covered: CrossAreaCoveredPaths,
  path: string,
): boolean {
  const { plan } = reserved;
  if (!plan.crossAreaPass.required) return false;
  const ownerOf = (candidate: string): ReviewArea | undefined =>
    plan.areas.find((area) =>
      area.files.some((index) => plan.changedFiles[index - 1]?.path === candidate),
    );
  const owner = ownerOf(path);
  if (owner === undefined) return false;
  if (completedAreas.get(owner.id) !== true) return false;
  for (const area of plan.areas) {
    if (area.id === owner.id) continue;
    if (completedAreas.get(area.id) !== true) return false;
  }
  return covered.has(path);
}
