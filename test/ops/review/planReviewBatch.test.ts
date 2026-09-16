// E2 slice 2 — tests for planReviewBatch (src/ops/review/planReviewBatch.ts),
// round 2: the planner takes the FULL Classification and REFUSES truncated
// data (structural truncation guard).
//
// Pinned here:
//   1. Only `actionable` items batch — resolved/responded/blocked/skip
//      produce nothing (responded/skip are "nothing to do"; blocked is
//      needs-human).
//   2. The I6 DEFAULT is per-item isolation: every actionable item gets its
//      own isolated batch (one item, worktreeHint null — the actual
//      worktree resolution is E3's prWorktree op's concern). The default
//      is asserted in the test NAME.
//   3. Shared mode is the supported option: grouping by path (stable,
//      first-appearance order; null paths their own bucket) or 'none', and
//      the maxItemsPerSharedBatch cap ALWAYS holds — a larger group splits
//      into multiple batches.
//   4. Structural truncation guard: truncated=true THROWS naming every
//      truncatedBecause cause — dispatch must never plan from incomplete
//      data.
//   5. Determinism: same input+config runs deep-equal, twice.
//
// Pure data tests: no I/O, no clocks — instant by construction.
import { describe, expect, test } from 'vitest';
import { defaultPlanBatchConfig } from '../../../src/ops/review/planReviewBatch.js';
import { planReviewBatch } from '../../../src/ops/review/planReviewBatch.js';
import type { ClassifiedItem } from '../../../src/ops/review/classifyThreads.js';
import type { Classification } from '../../../src/ops/review/classifyThreads.js';
import type { PlanBatchConfig } from '../../../src/ops/review/planReviewBatch.js';

// ---------------------------------------------------------------------------
// Fixtures (ClassifiedItem style, mirroring classifyThreads.test.ts)
// ---------------------------------------------------------------------------

let nextId = 0;

/** An actionable thread item overridable field by field, with unique ids. */
const item = (extra?: Partial<ClassifiedItem>): ClassifiedItem => {
  nextId += 1;
  return {
    kind: 'thread',
    id: `IT-${nextId}`,
    verdict: 'actionable',
    path: 'src/a.ts',
    reason: 'thread_needs_response',
    ...extra,
  };
};

/** A clean (non-truncated) Classification over the given items. */
const classificationOf = (
  items: ClassifiedItem[],
  extra?: Partial<Classification>,
): Classification => ({
  items,
  truncated: false,
  truncatedBecause: [],
  ...extra,
});

/** Shared-mode config overridable field by field. */
const sharedConfig = (extra?: Partial<PlanBatchConfig>): PlanBatchConfig => ({
  ...defaultPlanBatchConfig,
  worktreeMode: 'shared',
  ...extra,
});

// ---------------------------------------------------------------------------
// Truncation guard (the structural fail-closed gate)
// ---------------------------------------------------------------------------

describe('planReviewBatch truncation guard', () => {
  test('a truncated classification is REFUSED — the error names every truncatedBecause cause', () => {
    expect(() =>
      planReviewBatch(
        classificationOf([item()], {
          truncated: true,
          truncatedBecause: ['reviewThreads.lag', 'restComments.pageCap'],
        }),
      ),
    ).toThrow(/reviewThreads\.lag.*restComments\.pageCap/);
  });

  test('empty items, non-truncated → empty array', () => {
    expect(planReviewBatch(classificationOf([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Actionable-only filtering
// ---------------------------------------------------------------------------

describe('planReviewBatch filters to actionable', () => {
  test('no actionable items (resolved/responded/blocked/skip) → empty array', () => {
    const items: ClassifiedItem[] = [
      item({ verdict: 'resolved', reason: 'thread_resolved' }),
      item({ verdict: 'responded', reason: 'responder_last_word' }),
      item({ verdict: 'blocked', reason: 'outdated_unresolved' }),
      item({ verdict: 'skip', reason: 'bot_skip_notice' }),
    ];
    expect(planReviewBatch(classificationOf(items))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The I6 default: per-item isolation
// ---------------------------------------------------------------------------

describe('planReviewBatch isolation default (I6)', () => {
  test('I6 default: a single actionable item → exactly ONE isolated batch with ONE item and worktreeHint null', () => {
    const single = item();
    const batches = planReviewBatch(classificationOf([single]));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      mode: 'isolated',
      worktreeHint: null,
      items: [single],
    });
  });

  test('I6 default: multiple actionable items → one isolated batch EACH, input order preserved', () => {
    const first = item({ path: 'src/a.ts' });
    const second = item({ kind: 'review', path: null, reason: 'review_summary_needs_response' });
    const third = item({ kind: 'comment', path: null, reason: 'top_level_summary' });
    const batches = planReviewBatch(classificationOf([first, second, third]));
    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch.mode)).toEqual(['isolated', 'isolated', 'isolated']);
    expect(batches.map((batch) => batch.worktreeHint)).toEqual([null, null, null]);
    expect(batches.map((batch) => batch.items[0]?.id)).toEqual([first.id, second.id, third.id]);
    batches.forEach((batch) => expect(batch.items).toHaveLength(1));
  });

  test('isolated mode ignores sharedGroupBy and the cap — never consulted', () => {
    const batches = planReviewBatch(classificationOf([item(), item()]), {
      ...defaultPlanBatchConfig,
      sharedGroupBy: 'none',
      maxItemsPerSharedBatch: 1,
    });
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.mode === 'isolated' && batch.items.length === 1)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Shared mode: grouping, bucketing, and the always-holding cap
// ---------------------------------------------------------------------------

describe('planReviewBatch shared mode', () => {
  test("sharedGroupBy 'file': two items on the same path → ONE batch holding both, in input order", () => {
    const first = item({ path: 'src/a.ts' });
    const second = item({ path: 'src/a.ts' });
    const batches = planReviewBatch(classificationOf([first, second]), sharedConfig());
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      mode: 'shared',
      worktreeHint: 'shared-pr-worktree',
      items: [first, second],
    });
  });

  test("sharedGroupBy 'file': distinct paths → separate batches, in FIRST-APPEARANCE order", () => {
    const laterListedButFirstSeen = item({ path: 'src/b.ts' });
    const secondSeen = item({ path: 'src/a.ts' });
    const batches = planReviewBatch(
      classificationOf([laterListedButFirstSeen, secondSeen]),
      sharedConfig(),
    );
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.items[0]?.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(batches.every((batch) => batch.worktreeHint === 'shared-pr-worktree')).toBe(true);
  });

  test('null paths group under their OWN bucket — never mixed with a concrete path', () => {
    const fileItem = item({ path: 'src/a.ts' });
    const nullOne = item({ kind: 'review', path: null, reason: 'review_summary_needs_response' });
    const nullTwo = item({ kind: 'comment', path: null, reason: 'top_level_summary' });
    const batches = planReviewBatch(classificationOf([fileItem, nullOne, nullTwo]), sharedConfig());
    expect(batches).toHaveLength(2);
    expect(batches[0]?.items).toEqual([fileItem]);
    expect(batches[1]?.items).toEqual([nullOne, nullTwo]);
  });

  test('the cap ALWAYS holds, even in shared mode: 3 items on one path, cap 2 → two batches [2, 1]', () => {
    const items = [
      item({ path: 'src/a.ts' }),
      item({ path: 'src/a.ts' }),
      item({ path: 'src/a.ts' }),
    ];
    const batches = planReviewBatch(
      classificationOf(items),
      sharedConfig({ maxItemsPerSharedBatch: 2 }),
    );
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.items)).toEqual([[items[0], items[1]], [items[2]]]);
    expect(batches.every((batch) => batch.items.length <= 2)).toBe(true);
  });

  test("cap with sharedGroupBy 'none': one group of 5, cap 3 → chunks [3, 2]", () => {
    const items = [
      item({ path: 'src/a.ts' }),
      item({ path: 'src/b.ts' }),
      item({ path: null }),
      item({ path: 'src/c.ts' }),
      item({ path: 'src/b.ts' }),
    ];
    const batches = planReviewBatch(
      classificationOf(items),
      sharedConfig({ sharedGroupBy: 'none', maxItemsPerSharedBatch: 3 }),
    );
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.items)).toEqual([items.slice(0, 3), items.slice(3)]);
  });

  test('a shared cap that is not an integer >= 1 is rejected loudly, naming the field', () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() =>
        planReviewBatch(classificationOf([item()]), sharedConfig({ maxItemsPerSharedBatch: bad })),
      ).toThrow(/maxItemsPerSharedBatch/);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('planReviewBatch determinism', () => {
  test('two runs with the same input and config deep-equal, in both modes', () => {
    const items: ClassifiedItem[] = [
      item({ path: 'src/a.ts' }),
      item({ verdict: 'skip', reason: 'bot_skip_notice' }),
      item({ path: 'src/b.ts' }),
      item({ path: 'src/a.ts' }),
      item({ kind: 'review', path: null, reason: 'review_summary_needs_response' }),
      item({ path: null }),
    ];
    const classification = classificationOf(items);
    expect(planReviewBatch(classification)).toEqual(planReviewBatch(classification));
    const config = sharedConfig({ maxItemsPerSharedBatch: 2 });
    expect(planReviewBatch(classification, config)).toEqual(
      planReviewBatch(classification, config),
    );
  });
});
