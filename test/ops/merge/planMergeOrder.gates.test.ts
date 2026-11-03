// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the fail-closed gates (truncation, unclassified, non-eligible
// verdicts, duplicate pr numbers, unresolved bases and the cascade). Shared
// fixtures live in ./planMergeOrder.helpers.ts (see its header for the
// rule-by-rule map).
import { describe, expect, test } from 'vitest';
import { classified, plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// The fail-closed gates
// ---------------------------------------------------------------------------

describe('planMergeOrder — fail-closed gates (nothing merges uninvited)', () => {
  test('a truncated PR is never ordered: needs-human, review_data_truncated (UC row 42)', () => {
    const result = plan('main', [
      planned(4, 'main', 'cap-hit', { truncated: true }),
      planned(2, 'main', 'fine'),
    ]);
    expect(result.order).toEqual([{ pr: 2, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 4, reason: 'review_data_truncated' }]);
  });

  test('an unclassified PR is never ordered: needs-human, unclassified', () => {
    const result = plan('main', [planned(6, 'main', 'never-classified', { classification: null })]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 6, reason: 'unclassified' }]);
  });

  test('truncated beats unclassified (first match wins, F1 row order)', () => {
    const result = plan('main', [
      planned(8, 'main', 'both', { classification: null, truncated: true }),
    ]);
    expect(result.needsHuman).toEqual([{ pr: 8, reason: 'review_data_truncated' }]);
  });

  test('a truncated PR with a ghost base keeps review_data_truncated (gates precede base resolution)', () => {
    const result = plan('main', [
      // Truncated AND its base matches no fetched head: the gate fires
      // first — the ledger never re-reports it as unresolved_base.
      planned(9, 'ghost-branch', 'cap-hit', { truncated: true }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 9, reason: 'review_data_truncated' }]);
  });

  test('a truncated cycle MEMBER keeps review_data_truncated; the clean partner gets stack_cycle', () => {
    const result = plan('main', [
      planned(1, 'h2', 'h1', { truncated: true }), // gated AND mutually stacked with 2
      planned(2, 'h1', 'h2'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'review_data_truncated' },
      { pr: 2, reason: 'stack_cycle' },
    ]);
  });

  test('a `never` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(13, 'main', 'still-draft', { classification: classified('never', 'is_draft') }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 13, reason: 'not_eligible' }]);
  });

  test('a `conflicting` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(14, 'main', 'dirty', {
        classification: classified('conflicting', 'merge_conflicts'),
      }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 14, reason: 'not_eligible' }]);
  });

  test('an `awaiting` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(15, 'main', 'settling', {
        classification: classified('awaiting', 'settle_window_pending'),
      }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 15, reason: 'not_eligible' }]);
  });

  test('the cascade reaches a non-eligible parent: awaiting root, eligible child → both withheld', () => {
    const result = plan('main', [
      planned(1, 'main', 'awaiting-root', {
        classification: classified('awaiting', 'settle_window_pending'),
      }),
      planned(2, 'awaiting-root', 'eligible-child'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'not_eligible' },
      { pr: 2, reason: 'stack_base_needs_human' },
    ]);
  });

  test('the cascade covers an unresolved_base parent: adrift rung, its child cascades', () => {
    const result = plan('main', [
      planned(1, 'ghost-branch', 'adrift'), // gate 5: base resolves to nothing
      planned(2, 'adrift', 'child'), // stacked on the adrift rung
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'unresolved_base' },
      { pr: 2, reason: 'stack_base_needs_human' },
    ]);
  });

  test('duplicate pr numbers: both entries withheld duplicate_pr, the child cascades, nothing plans', () => {
    const result = plan('main', [
      planned(5, 'main', 'x'), // pr 5, row A: a root with head 'x'
      planned(5, 'x', 'q'), // pr 5, row B: DIVERGENT refs — head 'q', stacked on 'x'
      planned(7, 'q', 'z'), // child of row B's head
    ]);
    // The plan cannot tell which row-5 is real, so pr 5 is withheld once
    // (one ledger line per PR, first gate wins) and pr 7 — whose base 'q'
    // is the withheld duplicate's head — cascades. Nothing plans.
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 5, reason: 'duplicate_pr' },
      { pr: 7, reason: 'stack_base_needs_human' },
    ]);
  });

  test('a duplicated CLOSED row never reports; its open twin is withheld (count spans all rows)', () => {
    const result = plan('main', [
      planned(5, 'main', 'x', { state: 'closed' }), // closed row of the pair
      planned(5, 'main', 'x'), // open twin — same pr number
      planned(6, 'main', 'independent'),
    ]);
    // The pr count spans BOTH rows, so the open half is withheld; the
    // closed half stays structural silence (never in needsHuman).
    expect(result.order).toEqual([{ pr: 6, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 5, reason: 'duplicate_pr' }]);
  });

  test('a lone pair of duplicated closed rows is structural silence — nothing anywhere', () => {
    const result = plan('main', [
      planned(5, 'main', 'x', { state: 'closed' }),
      planned(5, 'q', 'y', { state: 'closed' }),
      planned(6, 'main', 'independent'),
    ]);
    expect(result.order).toEqual([{ pr: 6, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([]);
  });

  test('a base ref that resolves to nothing is not guessed: unresolved_base', () => {
    const result = plan('main', [planned(12, 'ghost-branch', 'adrift')]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 12, reason: 'unresolved_base' }]);
  });

  test('the cascade: a child of a withheld PR is withheld too (stack_base_needs_human)', () => {
    const result = plan('main', [
      planned(1, 'main', 'cap-hit', { truncated: true }),
      planned(2, 'cap-hit', 'child'),
      planned(3, 'child', 'grandchild'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'review_data_truncated' },
      { pr: 2, reason: 'stack_base_needs_human' },
      { pr: 3, reason: 'stack_base_needs_human' },
    ]);
  });
});
