# R6 area helpers — review areas, manifest and cross-area reserve

Status: proposal implemented as a **pure planning layer** (2026-10-28). This
document records the typed contract, the deterministic grouping algorithm and
the integration proposal for the reviewer lane's R6 card ("F2 area sessions,
followed by a bounded cross-area contract pass"). No runtime session wiring,
planner dispatch, agentReviewer wiring, session/coverage schema change or CLI
grammar ships with it. Nothing in `src/` outside `internal/reviewAreas.ts`
changed.

## Scope and non-goals

**In scope (this PR):** the pure module `src/ops/review/internal/reviewAreas.ts`:

- deterministic bounded grouping of reviewed scan components into areas by
  changed contracts, common intent and directory affinity;
- an immutable changed-file manifest (one row per reviewed component, exact
  bytes, frozen);
- coverage-piece accounting over reviewed components (excluded components are
  never planned and never in the manifest);
- an explicit `unsafe` / `oversized` fallback result for grouping that cannot
  be done safely within its bounds, so callers retain the existing R2 partition
  fallback unchanged;
- a `crossAreaPass` object with a prompt reserve for a separately budgeted
  cross-area contract pass, holdable only before any primary area has run
  (`reserveCrossAreaPass`), and excludable (`isExcludedFromPrimaryCoverage`).

**Out of scope (integration proposal, see the end of this document):** planner
mode emission, `agentReviewer` wiring, a coverage-v2 mode value, a producer
schema for the cross-area session, budget plumbing, prompt construction and
every consumer change. R6's runtime behavior is a later PR stacked on this one.

## Typed API (exact)

All of it lives in `src/ops/review/internal/reviewAreas.ts`. Types:

```ts
export interface ReviewArea {
  readonly id: string; // `area-1`, `area-2`, … in output order
  readonly files: readonly number[]; // ascending 1-based `changedFiles[].index` references
  readonly contracts: readonly string[]; // sorted unique matched contract descriptors
  readonly contractsTruncated: boolean; // true when the list overflowed maxCharsPerContractArea
  readonly intent: string; // the shared change intent, bounded
}

export interface ReviewChangedFile {
  readonly index: number; // 1-based position in the reviewed slice
  readonly path: string;
  readonly chars: number; // UTF-16 length of the component text
  readonly bytes: number; // UTF-8 byte length
  readonly sha256: string; // exact bytes
  readonly untracked: boolean; // `untracked:<path>` component identity
}

export interface ReviewAreaPlan {
  readonly kind: 'areas';
  readonly areas: readonly ReviewArea[];
  readonly changedFiles: readonly ReviewChangedFile[]; // frozen; no text
  readonly totalChars: number;
  readonly crossAreaPass: {
    readonly required: boolean;
    readonly reason: string;
    readonly promptReserveChars: number;
  };
}

export interface ReviewAreaFallback {
  readonly kind: 'unsafe' | 'oversized';
  readonly reason: string;
  readonly changedFiles: readonly ReviewChangedFile[]; // frozen; no text
  readonly totalChars: number;
}

export type ReviewAreaResult = ReviewAreaPlan | ReviewAreaFallback;
```

Functions:

```ts
export const REVIEW_AREA_DEFAULTS: {
  maxCharsPerArea: 30_000;
  maxCharsPerContractArea: 20_000;
  maxFilesPerArea: 12;
  maxAreas: 12;
  maxIntentChars: 2_000;
  crossAreaPromptReserveChars: 8_000;
};

export const REVIEW_AREA_CONTRACT_LINE: RegExp;
// (?:\bexport\s|\b(?:schemaVersion|z\.object|z\.enum|z\.union|z\.literal|
//    z\.array|z\.record|z\.tuple|migrations?|persisted)\b|\b[A-Za-z0-9_]+Schema\b)

export function contractDescriptor(path: string, line: string): string;
// `<path>:<trimmed 64-char snippet of the matched contract line>`, '' when no
// match; the path and the line SLICE (not the whole line) stay bounded.

export function planReviewAreas(input: {
  intent?: string;
  components: readonly ScanComponentInput[];
}): ReviewAreaResult;
```

Determinism: same input, same output, `toEqual`-deep, always. Components are
partitioned (never reordered or copied textually), area ids and manifest rows
are 1-based in first-touch order, contract lists sort by UTF-16 code-unit
order, and manifest rows freeze and never carry component text. Empty intent
is valid; an empty reviewed component list is `unsafe` (`review areas: no
reviewed components`).

### Fallback states (fail closed, never manufacture a grouped plan)

- `unsafe`: empty reviewed components, duplicate component identities, or
  duplicate changed paths (two components claiming one path makes per-path
  grouping and the manifest ambiguous).
- `oversized`: more than `maxAreas` directories, or any single directory
  needing more areas than `maxAreas` allows (bytes-driven splitting below
  `maxCharsPerArea`/`maxFilesPerArea` needed more areas than `maxAreas`).

Both kinds keep the full manifest, `totalChars`, and a reason naming the bound;
the caller falls back to the R2 partition fallback unchanged. "unsafe or
oversized grouping" therefore always has an explicit, inspectable answer.

## Contract-line harvesting

The regex matches changed diff lines (`+`/`-`) with their markers stripped
first, and whole lines of untracked components. Each descriptor is bounded:
`<path>:<trimmed 64-char snippet>`. An area's aggregate descriptor payload is
bounded to `maxCharsPerContractArea` (20 000 chars): whole descriptors are
kept in sorted order while they fit, the rest are cut, and the area records
`contractsTruncated: true` (the plan's cross-area `reason` names the
truncation too) instead of silently dropping evidence or emitting an
unbounded payload. `contractDescriptor` exports the exact
`<path>:<snippet>` format, and `REVIEW_AREA_CONTRACT_LINE` exports the regex,
so tests and future consumers pin both.

## Directory affinity grouping (the algorithm)

Bounded and deterministic:

1. Group reviewed components by top-level directory (`a/b/c.ts` → `a/b`,
   `root.ts` → `(root)`). This is the affinity signal: changed code usually
   groups with its directory.
2. Split any directory whose summed `chars` exceeds `maxCharsPerArea` into
   byte-driven areas, each ≤ that cap and each ≤ `maxFilesPerArea` files.
3. Split any directory whose file count exceeds `maxFilesPerArea` into
   file-count-driven areas.
4. If the area count exceeds `maxAreas`, return `oversized`.

Never merges directories: cross-directory areas would break the affinity
property that makes the manifest checkable. Large directories split; small
nearby directories stay separate areas. A single huge component inside one
area is fine — the cap is on the area, not the file.

## Cross-area pass reserve

`crossAreaPass` on a successful plan:

- `required: true`, `reason: 'review areas share one change intent; a
cross-area contract pass is required'` when there are ≥ 2 areas or ≥ 1
  matched contract;
- `required: false`, `reason: 'single area without contracts: no cross-area
pass required'` when one area covers everything with no contracts.

`promptReserveChars` defaults to `crossAreaPromptReserveChars` (8 000). It is a
**planning reserve, not a spend**: the cross-area pass is separately budgeted
at runtime, and a failed area session never releases its primary bytes to a
reserve, which cannot exceed `totalChars`.

`reserveCrossAreaPass(plan, reserveChars, completedAreaIds)` returns a bounded
reserved-plan view (the hold is refused once any area has completed):

```ts
export interface ReservedReviewAreaPlan {
  readonly kind: 'areas';
  readonly plan: ReviewAreaPlan;
  readonly reserveChars: number;
  readonly primaryMaxChars: number; // plan.totalChars - reserveChars
}
```

It **holds** only before any primary area session has run (an empty
`completedAreaIds`). After the first area completes, the reserve is
unavailable: the change is spent on primary coverage, and the cross-area pass
would reduce primary completeness. `reserveChars` outside `0..totalChars`
throws. **A held reserve does not discharge primary coverage**:
`isExcludedFromPrimaryCoverage(reserved, completedAreas, covered, path)`
excludes a manifest path only when (a) the cross-area session actually
covered it, (b) the path's OWN area is recorded completed, AND (c) every
other area in the plan is also completed. A failed, aborted or unsettled
required area keeps its paths primary-covered even when the covered set names
them — context replay is not primary evidence — and a `required: false` plan
discharges nothing. Failed required areas or an exhausted final-pass reserve
therefore leave the review incomplete (truthful incomplete, never a false
clean).

## Coverage-piece accounting and the common intent

- **Common intent**: the `intent` input is attached to every area (`ReviewArea
.intent`) and to the manifest, so each session shares the change's stated
  purpose. Bounded by `maxIntentChars` (2 000); empty intent is valid.
- **Coverage-piece accounting**: `changedFiles` is one row per reviewed
  component with exact byte identity (`sha256`, `chars`, `bytes`), mirroring
  the coverage-v2 piece identity, so a future wiring can line up planned
  sessions against planned pieces without a second source of truth. Excluded
  components never enter the plan. **Replay context cannot count primary
  coverage**: repeated intent/manifest context is context, never additional
  delivery; only the area's own component bytes are primary coverage.

## Integration proposal (not implemented)

Stacked on R2 (`b6ee5c49b857c51f958f2ed58cb6bb1a79c05952`):

1. **reviewPlan** gains an `areas: { maxCharsPerArea?, maxAreas?, ... } | false`
   input next to `partitionTools`. Default: unset (partition fallback wins, R6
   off). Explicitly set: `planReviewAreas` runs on the reviewed slice before
   the size-tier decision; `kind: 'areas'` emits one session per area plus the
   cross-area session, each with the fixed read-only tool set and the R2 step
   allowance; `kind: 'unsafe' | 'oversized'` falls back to the existing
   partition path with the area reason on the plan as a limitation.
2. **coverage v2**: no schema change — each area session is a normal session
   with its area's component placements; the cross-area session's prompt is
   built from the manifest and cited evidence only, so it delivers no primary
   component bytes and adds none. `mode`/`modeReason` carry the area outcome;
   a failed required area or contract session already fails
   `isCoverageV2Complete` through existing piece/session rules.
3. **agentReviewer** gains `areas` forwarding only; the run pool, budget
   reservation and deterministic order stay untouched.
4. **Producer schema**: unchanged (`review.agent/v3`). The cross-area session
   uses the same findings schema; its prompt names the manifest and cites the
   area evidence to check.

Wiring order when R6 runtime lands: this helper PR first, then the planner PR,
then the producer/reserve PR — each mergeable alone.
