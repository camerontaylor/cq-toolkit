// planReviewBatch — E2 slice 2 (goal E2; UC §2 row 35; invariant I6): group
// actionable ClassifiedItems into fixer batches. Pure and deterministic —
// plain data in, plain data out, no I/O, no clocks.
//
// I6 — PER-ITEM ISOLATION IS THE ASSERTED DEFAULT: each fixer worker runs
// as a fresh isolated invocation, so context never leaks between workers;
// the default plan is therefore ONE batch per actionable item
// (worktreeMode: 'isolated'). Shared-worktree fan-out (worktreeMode:
// 'shared') is a SUPPORTED OPTION — a legacy user preference — never the
// default. The mode is data (PlanBatchConfig), not a behavior switch buried
// in code: R3 may tune the config AS DATA, but the default stays isolated.
//
// What batches:
//   - ONLY `verdict === 'actionable'` items. `responded` and `skip` are
//     "nothing to do" (the responder holds the last word; bot notices /
//     the responder's own words); `blocked` is needs-human (e.g. an
//     outdated unresolved thread a head-of-branch commit cannot fix) —
//     none of them may reach a fixer worker.
//   - Isolated mode: one batch per actionable item, `worktreeHint: null` —
//     the actual per-PR worktree resolution belongs to E3's `prWorktree`
//     op; batches carry only the hint slot, never the worktree itself.
//   - Shared mode: items grouped by `path` when sharedGroupBy is 'file'
//     (stable: first-appearance order of paths; a null path is its OWN
//     bucket — it never mixes with a concrete path), then every group is
//     chunked at maxItemsPerSharedBatch. The cap ALWAYS holds, even in
//     shared mode: a group larger than the cap splits into multiple
//     batches. Each batch carries `worktreeHint: 'shared-pr-worktree'`.
//
// Order guarantees: input order is preserved within batches, and batches
// come out in first-appearance order (isolated: item order; shared: path
// first-appearance, chunk order within a path). Empty input → empty array;
// no actionable items → empty array.
//
// CONTRACT — takes the FULL Classification (not bare items) and REFUSES a
// truncated one: if classification.truncated is true it THROWS, naming
// every truncatedBecause cause. A truncated fetch means fresh threads/
// reviews are MISSING from the verdict set, so dispatch must never plan
// from incomplete data — the guard makes the fail-closed flag structurally
// impossible to skip (a caller wanting softer handling must consult the
// flag itself BEFORE calling here). Pure otherwise: same inputs →
// deep-equal output.
import type { ClassifiedItem, Classification } from './classifyThreads.js';

/**
 * Batch-planning configuration. `worktreeMode: 'isolated'` is the asserted
 * default (I6 — fresh isolated invocation per fixer worker); 'shared' is
 * the supported legacy option. Tuned AS DATA; structure frozen.
 */
export interface PlanBatchConfig {
  /**
   * 'isolated' (default, I6): one batch per actionable item, each destined
   * for its own fresh worktree/invocation. 'shared': items may share the
   * PR worktree — grouped per config.sharedGroupBy.
   */
  worktreeMode: 'isolated' | 'shared';
  /**
   * Shared-mode grouping only: 'file' groups actionable items by their
   * `path` (null paths group under their own bucket); 'none' treats all
   * actionable items as one group. Ignored in isolated mode.
   */
  sharedGroupBy: 'file' | 'none';
  /**
   * Hard cap on items per shared batch — a group larger than the cap
   * splits into multiple batches. The cap ALWAYS holds, even in shared
   * mode (a fixer worker never receives an unbounded pile). Ignored in
   * isolated mode (every batch holds exactly one item by construction).
   */
  maxItemsPerSharedBatch: number;
}

/**
 * The conservative default: per-item isolation (I6, UC row 35). Shared
 * fan-out exists for the legacy preference and must be opted into
 * explicitly.
 */
export const defaultPlanBatchConfig: PlanBatchConfig = {
  worktreeMode: 'isolated',
  sharedGroupBy: 'file',
  maxItemsPerSharedBatch: 8,
};

/** One fixer batch: the items one fixer worker will handle, plus the
 * worktree hint. `worktreeHint` is null in isolated mode — resolving the
 * actual per-PR worktree is E3's `prWorktree` op's concern, not this
 * module's; shared batches hint at the single shared PR worktree. */
export interface PlannedBatch {
  /** Whether this batch wants an isolated worktree or the shared one. */
  mode: 'isolated' | 'shared';
  /** Batch-level worktree hint (see interface doc). Null when isolated. */
  worktreeHint: string | null;
  /** The actionable items for this batch, in input order. */
  items: ClassifiedItem[];
}

/** Split one group into cap-sized chunks (the last chunk takes the rest). */
const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

/**
 * Plan fixer batches from a Classification (the full classifyThreads
 * result). TRUNCATION GUARD: a classification with truncated=true is
 * REFUSED — the error names every truncatedBecause cause — because a
 * partial fetch means fresh threads/reviews are missing from the verdict
 * set and dispatch must never plan from incomplete data (fail closed).
 * Otherwise: filters to actionable items, then — per config — emits one
 * isolated batch per item (the I6 default) or groups+chunks shared
 * batches. Pure and deterministic: same inputs (and config) → deep-equal
 * output, always. A shared-mode maxItemsPerSharedBatch that is not an
 * integer >= 1 would corrupt the chunking into an unbounded or an empty
 * plan — rejected loudly instead (fail loud, never fail open), naming the
 * field.
 */
export function planReviewBatch(
  classification: Classification,
  config: PlanBatchConfig = defaultPlanBatchConfig,
): PlannedBatch[] {
  // The structural fail-closed guard: an unconsulted truncation flag can
  // no longer plan batches — the refusal names every recorded cause so
  // the operator sees exactly what the fetch was missing.
  if (classification.truncated) {
    throw new Error(
      `planReviewBatch: refusing a TRUNCATED classification — dispatch must never plan from incomplete data; truncatedBecause: ${JSON.stringify(
        classification.truncatedBecause,
      )}`,
    );
  }
  const items = classification.items;
  const actionable = items.filter((item) => item.verdict === 'actionable');

  if (config.worktreeMode === 'isolated') {
    // I6 default: one fresh isolated invocation per actionable item.
    return actionable.map((item) => ({
      mode: 'isolated' as const,
      worktreeHint: null,
      items: [item],
    }));
  }

  // Policy validation at use (the cap is only consulted in shared mode):
  // a non-integer or < 1 cap would make the chunker below emit an empty
  // or infinite plan. Reject loudly, naming the field.
  if (!Number.isInteger(config.maxItemsPerSharedBatch) || config.maxItemsPerSharedBatch < 1) {
    throw new Error(
      `planReviewBatch: config.maxItemsPerSharedBatch must be an integer >= 1, got ${config.maxItemsPerSharedBatch}`,
    );
  }

  // Stable grouping: Map iteration is insertion order, so paths batch in
  // first-appearance order; a null path is its own bucket (Map keys may be
  // null) and never mixes with a concrete path.
  let groups: ClassifiedItem[][];
  if (config.sharedGroupBy === 'file') {
    const byPath = new Map<string | null, ClassifiedItem[]>();
    for (const item of actionable) {
      const bucket = byPath.get(item.path);
      if (bucket === undefined) {
        byPath.set(item.path, [item]);
      } else {
        bucket.push(item);
      }
    }
    groups = [...byPath.values()];
  } else {
    groups = [actionable];
  }

  return groups.flatMap((group) =>
    chunk(group, config.maxItemsPerSharedBatch).map((batchItems) => ({
      mode: 'shared' as const,
      worktreeHint: 'shared-pr-worktree',
      items: batchItems,
    })),
  );
}
