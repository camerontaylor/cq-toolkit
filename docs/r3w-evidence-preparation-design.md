# R3W evidence preparation — pure repair-state helper design

Card R3W (`plans/upcoming-20261027/reviewer-lane.md`), PR split R3S → R3W. This document
covers only the R3W increment shipped by this branch: a new **pure** evidence
preparation/repair-state helper, its fixtures, and this design note. Session producer,
prompt and planner integration are **out of scope here**: they await the explicit
planner-writer handoff, and this helper claims no runtime improvement until that
integration consumes it.

## Inputs read (pinned, read-only)

- Product AGENTS.md and `docs/focused-checks-contract.md` at task start.
- R3S exact pin `b5100a0621660aaac07213690d4e8a807ca0f4a9`
  (`feat/r3s-evidence-schema-20261028`): `FindingEvidenceV1Schema` /
  `FindingAnchorSchema` / `SupportingEvidenceSchema` (`src/ops/review/findings.ts`) and
  the pure validator `validateFindingEvidence` (`src/ops/review/internal/findingAnchors.ts`).
- R2 exact pin `b6ee5c49b857c51f958f2ed58cb6bb1a79c05952`
  (`feat/r2-partition-references-20261028`), inspected read-only: bounded partition
  reference tools, `REVIEW_PARTITION_STEPS`, tool-surface wiring in
  `reviewSession.ts`. R2 merged into the queue as #545 (queue =
  `108cacd66b9e43641748897014e81fe04cda8f54`) while this branch was in flight; the
  helper does not depend on either form — it takes an abstract step-accounting seam.
- Production reviewer engine at the pre-R3W queue pin `e34586c0` (baseline manifest
  `.r3w-scratch/baseline/`): `runReviewSession` output contract `review.agent/v3`,
  `createReviewPlan` prompt/tier machinery, `lineAnchors` head-anchor extraction.

## Problem

R3S defines what valid evidence **is**; the engine must decide what to **do** with a
producer payload: validate it against the pinned comparison, repair boundedly when it is
invalid, persist what survives without ever manufacturing a clean result, and hand the
wiring an explicit, typed outcome it can map onto findings, coverage and repair calls.
Scattering that decision logic through `runReviewSession`/`agentReviewer` at integration
time would put mutable, hard-to-fixture state in the session producer. R3W therefore
extracts the decision into a pure module with no I/O, no clocks and no driver access, so
every outcome is fixture-testable before any session code calls it.

## Interface (NEW `src/ops/review/internal/reviewEvidencePreparation.ts`)

```ts
/** Caller pins, exactly as for validateFindingEvidence. */
interface EvidencePreparationContext {
  blobs: ReadonlyMap<string, AnchorBlobInput>;   // literal path -> both sides + hunks
  renames: ReadonlyMap<string, string>;          // old -> new, metadata/diagnostics only
}

/** One bounded repair: a re-submitted payload plus why the engine asked for it. */
interface EvidenceRepairTurn {
  evidence: FindingEvidenceV1;   // raw re-submission, stored verbatim
  requestedAfter: readonly string[]; // typed AnchorInvalidReason[] that triggered it
}

type EvidencePreparationStep =
  | { status: 'valid'; evidence: FindingEvidenceV1 }
  | {
      status: 'invalid';
      /** The best (final) candidate's verdict reasons, in validator order. */
      reasons: AnchorInvalidReason[];
      /** Raw candidates, first submission first, each with its own verdict. */
      candidates: { evidence: FindingEvidenceV1; reasons: AnchorInvalidReason[] }[];
      /** Full repair history: every bounded turn the engine granted. */
      repairs: EvidenceRepairTurn[];
      /** 'exhausted' = the cap bound this outcome; 'unused' = no repair was offered. */
      repairOutcome: 'exhausted' | 'unused';
    };

function prepareFindingEvidence(input: {
  /** First producer submission. Stored verbatim whatever the verdict. */
  candidate: FindingEvidenceV1;
  context: EvidencePreparationContext;
  /**
   * Additional candidates produced by bounded repair, in order. The pure
   * helper never asks a model for them; the session wiring does, within the
   * shared budget, and passes them in. Cap: 2 repair turns (so at most
   * 1 original + 2 repairs are ever evaluated).
   */
  repairs?: readonly FindingEvidenceV1[];
  /** Strict cap on repair turns; the default and maximum are both 2. */
  maxRepairs?: 0 | 1 | 2;
}): EvidencePreparationStep;
```

## Behavior contract

1. **Validate before anything else.** Each candidate goes through
   `validateFindingEvidence` with the caller's pins. The helper adds no validation rules
   of its own; it composes the R3S verdicts.
2. **First valid candidate wins.** Evaluation stops at the first `valid` verdict. The
   original candidate is never mutated; a repaired payload is stored exactly as
   submitted.
3. **Repairs are bounded.** At most `maxRepairs` (default 2, hard maximum 2) repair
   candidates are evaluated, in order, after the original. Extra submissions beyond the
   cap are ignored (and reported, see 6). Repair requests carry the typed reasons that
   triggered them, so a producer replay can target the defect class instead of guessing.
4. **No silent relocation.** Repeated quotes, renamed paths and near-miss lines are never
   "fixed" by searching for a better location: the literal-path, literal-line,
   literal-quote validation of R3S is inherited untouched. A repair that re-anchors
   evidence to a different path is just another candidate and must validate as written.
5. **Invalid survivors keep everything.** An `invalid` outcome retains: every raw
   candidate with its own reasons (first submission first), the final verdict reasons at
   top level for direct mapping into R3S's `validation: { status: 'invalid', reasons }`,
   and the full repair history with per-turn trigger reasons.
6. **Budget truthfulness.** `repairOutcome: 'exhausted'` means the cap bound the
   outcome; `'unused'` means no repair capacity was offered or needed. Attempts beyond
   the cap are visible: they are counted, not evaluated, and the excess count is
   reported on the step (`ignoredRepairSubmissions`).
7. **No false clean.** The helper returns data, never a completion claim. Whether an
   invalid survivor blocks its source is a coverage/readiness decision for the callers
   (per the card: unresolved required candidates keep the source blocked; filtering bad
   candidates cannot yield clean coverage). Nothing here can turn an invalid candidate
   into a passing record.

## Non-goals (explicit)

- No session, prompt, driver, planner or consumer edits on this branch.
- No provider/host literals; no config reads; no clocks.
- No semantic adjudication: a valid verdict proves integrity of the citation only.
- No schema changes: R3S types are consumed as-is via the R3S feature parent.

## Stack

Parent: R3S `b5100a06` (feature parent, normally merged — recorded per dispatch.md).
This helper merges cleanly with R2's files (no shared paths); integration ordering
R2 → R3W remains the planner writer's decision at handoff.

## Tests (NEW `test/ops/review/reviewEvidencePreparation.test.ts`)

Fixtures reuse the R3S anchor-test comparison shape (modified/renamed pair/added/
deleted/dependency) so outcomes are directly comparable:

- valid first submission → `valid`, original stored verbatim, no repair history;
- invalid original, valid repair → `valid`, repair stored verbatim, one recorded turn
  carrying the triggering reasons;
- two repairs then still invalid → `invalid` with `repairOutcome: 'exhausted'`, three
  raw candidates each with their own reasons, full history;
- third submitted repair ignored → counted in `ignoredRepairSubmissions`, never
  evaluated;
- `maxRepairs: 0` → `repairOutcome: 'unused'`, original only;
- repeated quote across paths → still `quote-mismatch` (no relocation);
- rename pair, wrong side, out-of-hunk, unavailable blob, malicious path (NUL/newline),
  empty file, source whitespace → per-case typed reasons, raw candidate retained;
- `validation` marker pre-baked on an input → ignored by validation (verdicts describe
  anchors, not history), but the raw candidate is still retained verbatim on failure;
- reason order preserved: primary reasons, distinct supporting reasons, marker.
