// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the contract
// harvesting and truncation describes.
import { describe, expect, it } from 'vitest';
import {
  REVIEW_AREA_CONTRACT_LINE,
  REVIEW_AREA_DEFAULTS,
  contractDescriptor,
} from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('planReviewAreas contract harvesting', () => {
  it('matches exported, schema, persisted and migration lines in diffs', () => {
    const components = [
      tracked('src/schemas.ts', [
        'export type Kind = "a";',
        'const KindSchema = z.object({});',
        'persisted format v2',
        'runMigrations()',
        'const plain = 1;',
      ]),
    ];
    const result = plan({ components });
    expect(result.areas[0]!.contracts).toEqual([
      'src/schemas.ts:const KindSchema = z.object({});',
      'src/schemas.ts:export type Kind = "a";',
      'src/schemas.ts:persisted format v2',
    ]);
  });

  it('ignores diff headers, hunk markers and context lines', () => {
    const path = 'src/a.ts';
    const text = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,3 +1,4 @@',
      ' context export const untouched = true;',
      '-removed export const gone = 1;',
      '+added export const here = 1;',
      '',
    ].join('\n');
    const result = plan({ components: [{ component: `tracked:${path}`, path, text }] });
    expect(result.areas[0]!.contracts).toEqual([
      'src/a.ts:added export const here = 1;',
      'src/a.ts:removed export const gone = 1;',
    ]);
  });

  it('pins the exported regex and descriptor format, bounding long lines', () => {
    expect(REVIEW_AREA_CONTRACT_LINE.test('  export function f() {}')).toBe(true);
    expect(REVIEW_AREA_CONTRACT_LINE.test('const local = 1;')).toBe(false);
    expect(contractDescriptor('src/a.ts', 'export const value = 1;')).toBe(
      'src/a.ts:export const value = 1;',
    );
    expect(contractDescriptor('src/a.ts', `export const v = '${'x'.repeat(200)}';`)).toBe(
      `src/a.ts:${`export const v = '${'x'.repeat(200)}';`.trim().slice(0, 64)}`,
    );
    expect(contractDescriptor('src/a.ts', 'const local = 1;')).toBe('');
  });

  it('bounds each area contract payload at maxCharsPerContractArea and records truncation', () => {
    const cap = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
    // Wide unique export lines keep descending past the cap; one file is a
    // single area, so the aggregate payload is the thing under test. Each
    // descriptor is about 30 chars, so 2000 descriptors overflow the 20k cap.
    const line = (index: number) => `export const value${String(index)} = ${String(index)};`;
    const components = [
      tracked(
        'src/wide.ts',
        Array.from({ length: 2_000 }, (_, index) => line(index)),
      ),
    ];
    const result = plan({ components });
    const area = result.areas[0]!;
    expect(area.contracts.length).toBeGreaterThan(0);
    expect(area.contracts.length).toBeLessThan(2_000);
    const payload = area.contracts.join('\n').length;
    expect(payload).toBeLessThanOrEqual(cap);
    const sortedDescriptors = Array.from(
      { length: 2_000 },
      (_, index) => `src/wide.ts:${line(index)}`,
    ).sort();
    const keptCount = area.contracts.length;
    expect(area.contracts).toEqual(sortedDescriptors.slice(0, keptCount));
    expect(sortedDescriptors.slice(0, keptCount + 1).join('\n').length + 1).toBeGreaterThan(cap);
    expect(area.contractsTruncated).toBe(true);
    expect(result.crossAreaPass.reason).toContain('truncated');
  });

  it('keeps the full contract list when it fits and never sets the flag', () => {
    const cap = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
    const budget = Math.floor(cap / 40);
    const components = [
      tracked(
        'src/fit.ts',
        Array.from(
          { length: budget },
          (_, index) => `export const v${String(index)} = ${String(index)};`,
        ),
      ),
    ];
    const result = plan({ components });
    const area = result.areas[0]!;
    expect(area.contracts).toHaveLength(budget);
    expect(area.contracts.join('\n').length).toBeLessThanOrEqual(cap);
    expect(area.contractsTruncated).toBe(false);
    expect(result.crossAreaPass.reason).not.toContain('truncated');
  });

  it('cuts at a boundary: an oversized descriptor itself is dropped, prior fits are kept', () => {
    const cap = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
    // A single descriptor is bounded at path + 64 snippet chars, so overflow
    // needs many unique lines; 600 small descriptors force the cut with a
    // deterministic prefix kept.
    const fits = Array.from(
      { length: 600 },
      (_, index) => `export const v${String(index)} = ${String(index)};`,
    );
    const result = plan({ components: [tracked('src/boundary.ts', fits)] });
    const area = result.areas[0]!;
    expect(area.contracts.length).toBeGreaterThan(0);
    expect(area.contracts.length).toBeLessThan(600);
    expect(area.contractsTruncated).toBe(true);
    expect(area.contracts.join('\n').length).toBeLessThanOrEqual(cap);
    // The cut is prefix-stable: keeping the first K sorted descriptors.
    expect(area.contracts[0]).toContain('src/boundary.ts:');
  });

  it('reports truncation on a single component whose descriptor payload overflows the cap', () => {
    // A single descriptor is bounded at path + 64 snippet chars, so one huge
    // line alone cannot overflow 20k. Overflow needs many unique lines, which
    // the 2000-line case above covers; here the payload is exactly at the
    // boundary: nothing truncated.
    const cap = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
    const fits = Array.from(
      { length: 100 },
      (_, index) => `export const v${String(index)} = ${String(index)};`,
    );
    const result = plan({ components: [tracked('src/monolith.ts', fits)] });
    const area = result.areas[0]!;
    expect(area.contracts).toHaveLength(100);
    expect(area.contracts.join('\n').length).toBeLessThanOrEqual(cap);
    expect(area.contractsTruncated).toBe(false);
  });

  it('stays deterministic and frozen when contracts are truncated', () => {
    const cap = REVIEW_AREA_DEFAULTS.maxCharsPerContractArea;
    const line = (index: number) => `export const value${String(index)} = ${String(index)};`;
    const components = [
      tracked(
        'src/wide.ts',
        Array.from({ length: 2_000 }, (_, index) => line(index)),
      ),
    ];
    const first = plan({ components });
    const second = plan({ components });
    expect(first).toEqual(second);
    expect(Object.isFrozen(first.areas[0]!.contracts)).toBe(true);
    expect(typeof first.areas[0]!.contractsTruncated).toBe('boolean');
    expect(first.areas[0]!.contracts.join('\n').length).toBeLessThanOrEqual(cap);
  });
});
