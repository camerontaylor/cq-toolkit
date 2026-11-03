// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the primary
// coverage exclusion checks.
import { describe, expect, it } from 'vitest';
import {
  isExcludedFromPrimaryCoverage,
  reserveCrossAreaPass,
  type ReviewAreaPlan,
} from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('primary-coverage exclusion', () => {
  // Two directories, so the seeded plan has two areas; one can fail while the
  // other (or the cross-area pass) is covered.
  const seeded: ReviewAreaPlan = plan({
    components: [
      tracked('src/a.ts', ['export const a = 1;']),
      tracked('docs/b.md', ['documented b']),
    ],
  });
  const srcPath = 'src/a.ts';
  const docsPath = 'docs/b.md';
  const bothComplete = new Map<string, boolean>([
    ['area-1', true],
    ['area-2', true],
  ]);

  it('spans two areas so a failure case has a surviving sibling', () => {
    expect(seeded.areas).toHaveLength(2);
    expect(seeded.areas.map((area) => area.id)).toEqual(['area-1', 'area-2']);
  });

  it('excludes a covered manifest path only when every area completed', () => {
    const covered = new Set<string>([srcPath]);
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    expect(reserved.plan.changedFiles.map((file) => file.path)).toEqual([srcPath, docsPath]);
    expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, srcPath)).toBe(true);
    expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, docsPath)).toBe(false);
    expect(
      isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, 'src/never-planned.ts'),
    ).toBe(false);
  });

  it('keeps the FAILED primary area path primary-covered even when the covered set names it', () => {
    // The reviewer's exact repro: two areas, src area failed, cross-area set
    // claims the src path. The replayed coverage must not mask the failure.
    const covered = new Set<string>([srcPath]);
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    const srcFailed = new Map<string, boolean>([
      ['area-1', false],
      ['area-2', true],
    ]);
    expect(isExcludedFromPrimaryCoverage(reserved, srcFailed, covered, srcPath)).toBe(false);
    // Same for an aborted/unsettled sibling: only settled completion counts.
    const siblingUnsettled = new Map<string, boolean>([['area-1', true]]);
    expect(isExcludedFromPrimaryCoverage(reserved, siblingUnsettled, covered, srcPath)).toBe(false);
    const siblingAborted = new Map<string, boolean>([
      ['area-1', true],
      ['area-2', false],
    ]);
    expect(isExcludedFromPrimaryCoverage(reserved, siblingAborted, covered, srcPath)).toBe(false);
  });

  it('discharges nothing when the completed set holds unknown ids or the covered set unknown paths', () => {
    const covered = new Set<string>([srcPath]);
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    const unknownIds = new Map<string, boolean>([
      ['area-9', true],
      ['area-1', true],
      ['area-2', true],
    ]);
    expect(isExcludedFromPrimaryCoverage(reserved, unknownIds, covered, srcPath)).toBe(true);
    const unknownPaths = new Set<string>(['src/unknown.ts']);
    expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, unknownPaths, srcPath)).toBe(
      false,
    );
    expect(
      isExcludedFromPrimaryCoverage(reserved, bothComplete, unknownPaths, 'src/unknown.ts'),
    ).toBe(false);
  });

  it('excludes nothing when the cross-area pass is not required', () => {
    const single = plan({ components: [tracked('src/plain.ts', ['const v = 1;'])] });
    expect(single.crossAreaPass.required).toBe(false);
    const reserved = reserveCrossAreaPass(single, 0, []);
    const everything = new Set([single.changedFiles[0]!.path]);
    expect(
      isExcludedFromPrimaryCoverage(
        reserved,
        new Map([['area-1', true]]),
        everything,
        single.changedFiles[0]!.path,
      ),
    ).toBe(false);
  });

  it('requires settled completion across the whole plan before any exclusion', () => {
    const covered = new Set<string>([srcPath, docsPath]);
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    expect(isExcludedFromPrimaryCoverage(reserved, new Map(), covered, srcPath)).toBe(false);
    expect(isExcludedFromPrimaryCoverage(reserved, new Map(), covered, docsPath)).toBe(false);
    const onlySrc = new Map<string, boolean>([['area-1', true]]);
    expect(isExcludedFromPrimaryCoverage(reserved, onlySrc, covered, srcPath)).toBe(false);
    expect(isExcludedFromPrimaryCoverage(reserved, onlySrc, covered, docsPath)).toBe(false);
    expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, srcPath)).toBe(true);
    expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, docsPath)).toBe(true);
  });

  it('treats a held reserve as non-discharging: no path is excluded without cross-area coverage', () => {
    const bounded = Math.min(seeded.crossAreaPass.promptReserveChars, seeded.totalChars);
    const reserved = reserveCrossAreaPass(seeded, bounded, []);
    const covered = new Set<string>();
    for (const file of reserved.plan.changedFiles)
      expect(isExcludedFromPrimaryCoverage(reserved, bothComplete, covered, file.path)).toBe(false);
  });

  it('keeps failed required areas non-excluded: incomplete stays incomplete', () => {
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    const failedArea = seeded.areas[0]!;
    // The failed area's own bytes stay primary coverage even when a sibling
    // area (or the cross-area pass) covered something else.
    const covered = new Set<string>([docsPath]);
    const siblingComplete = new Map<string, boolean>([
      ['area-1', false],
      ['area-2', true],
    ]);
    for (const file of failedArea.files) {
      const path = seeded.changedFiles[file - 1]!.path;
      expect(covered.has(path)).toBe(false);
      expect(isExcludedFromPrimaryCoverage(reserved, siblingComplete, covered, path)).toBe(false);
    }
  });
});
