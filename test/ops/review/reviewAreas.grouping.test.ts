// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the grouping
// describes and the reviewed-slice exclusion check.
import { describe, expect, it } from 'vitest';
import { REVIEW_AREA_DEFAULTS } from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, sha256, tracked, untracked } from './reviewAreas.helpers.js';

describe('planReviewAreas grouping', () => {
  it('groups by directory affinity with shared intent, contracts and the manifest', () => {
    const components = [
      tracked('src/ops/review/run.ts', ['export const reviewer = 1;']),
      tracked('src/ops/review/run.ts.bak', ['const helpers = 2;']),
      untracked('src/ops/dev/new.ts', 'export function fresh(): number {\n  return 1;\n}\n'),
      tracked('docs/guide.md', ['documented value']),
    ];
    const result = plan({
      intent: 'Split area helpers from the planner.',
      components,
    });
    expect(result.kind).toBe('areas');
    expect(result.areas.map((area) => area.id)).toEqual(['area-1', 'area-2', 'area-3']);
    expect(result.areas[0]).toMatchObject({
      id: 'area-1',
      files: [1, 2],
      contracts: ['src/ops/review/run.ts:export const reviewer = 1;'],
      intent: 'Split area helpers from the planner.',
    });
    expect(result.areas[1]!.contracts).toEqual([
      'src/ops/dev/new.ts:export function fresh(): number {',
    ]);
    expect(result.areas[2]!.contracts).toEqual([]);
    expect(result.changedFiles).toHaveLength(4);
    expect(result.changedFiles[0]).toEqual({
      index: 1,
      path: 'src/ops/review/run.ts',
      chars: components[0]!.text.length,
      bytes: Buffer.byteLength(components[0]!.text, 'utf8'),
      sha256: sha256(components[0]!.text),
      untracked: false,
    });
    expect(result.changedFiles[3]).toMatchObject({ path: 'docs/guide.md', untracked: false });
    expect(result.totalChars).toBe(
      components.reduce((total, component) => total + component.text.length, 0),
    );
    expect(result.crossAreaPass).toEqual({
      required: true,
      reason: 'review areas share one change intent; a cross-area contract pass is required',
      promptReserveChars: REVIEW_AREA_DEFAULTS.crossAreaPromptReserveChars,
    });
  });

  it('keeps every component in exactly one area and manifest indexes ascending', () => {
    const components = [
      tracked('src/a.ts'),
      tracked('src/b.ts'),
      untracked('src/c.ts', 'plain\n'),
      tracked('docs/d.md'),
      tracked('other/e.ts'),
    ];
    const result = plan({ components });
    const owned = result.areas.flatMap((area) => area.files);
    expect([...owned].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(owned).size).toBe(owned.length);
    for (const area of result.areas)
      expect([...area.files]).toEqual([...area.files].sort((a, b) => a - b));
    expect(result.changedFiles.map((file) => file.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.changedFiles[2]).toMatchObject({ path: 'src/c.ts', untracked: true });
    expect(result.crossAreaPass.required).toBe(true);
  });

  it('is deterministic across calls, including contract ordering and ids', () => {
    const components = [
      tracked('src/a.ts', ['export const alpha = 1;', 'export const beta = 2;']),
      untracked('src/b.ts', 'export const gamma = 3;\nexport const delta = 4;\n'),
      tracked('web/x.ts', ['persisted value']),
    ];
    const first = plan({ intent: 'Same.', components });
    const second = plan({ intent: 'Same.', components });
    expect(first).toEqual(second);
    expect(first.areas[0]!.contracts).toEqual([
      'src/a.ts:export const alpha = 1;',
      'src/a.ts:export const beta = 2;',
      'src/b.ts:export const delta = 4;',
      'src/b.ts:export const gamma = 3;',
    ]);
  });

  it('accepts an empty intent as the shared common intent', () => {
    const result = plan({ components: [tracked('src/a.ts')] });
    expect(result.areas[0]!.intent).toBe('');
  });

  it('requires the cross-area pass for contracts even with a single area', () => {
    const result = plan({ components: [tracked('src/a.ts', ['export const a = 1;'])] });
    expect(result.areas).toHaveLength(1);
    expect(result.crossAreaPass.required).toBe(true);
  });

  it('skips the cross-area pass for one contract-free area', () => {
    const result = plan({ components: [tracked('src/plain.ts', ['const value = 1;'])] });
    expect(result.areas).toHaveLength(1);
    expect(result.areas[0]!.contracts).toEqual([]);
    expect(result.crossAreaPass).toEqual({
      required: false,
      reason: 'single area without contracts: no cross-area contract pass required',
      promptReserveChars: REVIEW_AREA_DEFAULTS.crossAreaPromptReserveChars,
    });
  });
});

describe('excluded components never enter the plan', () => {
  it('groups only the reviewed slice the caller passes', () => {
    const reviewedOnly = plan({ components: [tracked('src/a.ts', ['export const a = 1;'])] });
    expect(reviewedOnly.changedFiles).toHaveLength(1);
    expect(reviewedOnly.totalChars).toBe(tracked('src/a.ts', ['export const a = 1;']).text.length);
  });
});
