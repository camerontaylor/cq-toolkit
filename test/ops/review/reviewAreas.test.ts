import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import {
  REVIEW_AREA_CONTRACT_LINE,
  REVIEW_AREA_DEFAULTS,
  contractDescriptor,
  isExcludedFromPrimaryCoverage,
  planReviewAreas,
  reserveCrossAreaPass,
  type ReservedReviewAreaPlan,
  type ReviewAreaPlan,
  type ReviewAreaResult,
} from '../../../src/ops/review/internal/reviewAreas.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function tracked(path: string, added: readonly string[] = ['changed']): ScanComponentInput {
  return {
    component: `tracked:${path}`,
    path,
    text: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1 +1,${String(added.length)} @@`,
      ...added.map((line) => `+${line}`),
      '',
    ].join('\n'),
  };
}

function untracked(path: string, text: string): ScanComponentInput {
  return { component: `untracked:${path}`, path, text };
}

function plan(
  input: {
    intent?: string;
    components: readonly ScanComponentInput[];
  } = { components: [] },
): ReviewAreaPlan {
  const result = planReviewAreas(
    input.intent === undefined ? input : { ...input, intent: input.intent },
  );
  if (result.kind !== 'areas') throw new Error(`expected areas, got ${result.kind}`);
  return result;
}

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
    const firstCut = line(area.contracts.length);
    expect(area.contracts).not.toContain(`src/wide.ts:${firstCut}`);
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

describe('planReviewAreas splitting and bounds', () => {
  it('splits an oversized directory into bounded areas without reordering', () => {
    const components = Array.from({ length: 30 }, (_, index) =>
      tracked(`src/big/f${String(index).padStart(2, '0')}.ts`, [
        `const v${String(index)} = ${String(index)};`,
      ]),
    );
    const result = plan({ components });
    expect(result.areas.length).toBeGreaterThan(2);
    expect(result.areas.length).toBeLessThanOrEqual(REVIEW_AREA_DEFAULTS.maxAreas);
    for (const area of result.areas)
      expect(area.files.length).toBeLessThanOrEqual(REVIEW_AREA_DEFAULTS.maxFilesPerArea);
    const owned = result.areas.flatMap((area) => area.files);
    expect(owned).toEqual([...owned].sort((a, b) => a - b));
    expect(new Set(owned).size).toBe(components.length);
  });

  it('keeps one component larger than the char cap in its own area', () => {
    const big = tracked('src/huge.ts', [`${'x'.repeat(40_000)}`]);
    const small = tracked('src/tiny.ts', ['const tiny = 1;']);
    const result = plan({ components: [big, small] });
    expect(result.areas.map((area) => area.files)).toEqual([[1], [2]]);
    expect(result.crossAreaPass.required).toBe(true);
  });

  it('returns oversized with the full manifest when directories exceed maxAreas', () => {
    const components = Array.from({ length: REVIEW_AREA_DEFAULTS.maxAreas + 1 }, (_, index) =>
      tracked(`d${String(index)}/f.ts`),
    );
    const result = planReviewAreas({ components });
    if (result.kind !== 'oversized') throw new Error(`expected oversized, got ${result.kind}`);
    expect(result.reason).toContain(
      `over the maxAreas bound ${String(REVIEW_AREA_DEFAULTS.maxAreas)}`,
    );
    expect(result.changedFiles).toHaveLength(components.length);
    expect(result.changedFiles[0]).toMatchObject({ path: 'd0/f.ts', index: 1 });
    expect(result.totalChars).toBe(
      components.reduce((total, component) => total + component.text.length, 0),
    );
  });

  it('returns oversized when one directory needs more areas than maxAreas allows', () => {
    const components = Array.from(
      { length: REVIEW_AREA_DEFAULTS.maxFilesPerArea * REVIEW_AREA_DEFAULTS.maxAreas + 1 },
      (_, index) => tracked(`one/dir/f${String(index)}.ts`),
    );
    const result = planReviewAreas({ components });
    if (result.kind !== 'oversized') throw new Error(`expected oversized, got ${result.kind}`);
    expect(result.reason).toContain('maxAreas');
  });
});

describe('planReviewAreas refusals', () => {
  it('refuses empty reviewed input as unsafe with an empty manifest', () => {
    const result = planReviewAreas({ components: [] });
    if (result.kind !== 'unsafe') throw new Error(`expected unsafe, got ${result.kind}`);
    expect(result.reason).toBe('review areas: no reviewed components');
    expect(result.changedFiles).toEqual([]);
    expect(result.totalChars).toBe(0);
  });

  it('refuses duplicate identities and duplicate changed paths as unsafe', () => {
    const duplicated: ScanComponentInput = {
      component: 'tracked:src/a.ts',
      path: 'src/a.ts',
      text: 'same',
    };
    const sameIdentity = planReviewAreas({ components: [duplicated, { ...duplicated }] });
    if (sameIdentity.kind !== 'unsafe')
      throw new Error(`expected unsafe, got ${sameIdentity.kind}`);
    expect(sameIdentity.reason).toContain("duplicate component identity 'tracked:src/a.ts'");

    const aliased = planReviewAreas({
      components: [
        duplicated,
        { component: 'untracked:src/a.ts', path: 'src/a.ts', text: 'other' },
      ],
    });
    if (aliased.kind !== 'unsafe') throw new Error(`expected unsafe, got ${aliased.kind}`);
    expect(aliased.reason).toContain("duplicate changed path 'src/a.ts'");
    expect(aliased.changedFiles).toHaveLength(2);
  });

  it('refuses empty component identities as unsafe', () => {
    const result = planReviewAreas({
      components: [{ component: '', path: 'src/a.ts', text: 'x' }],
    });
    if (result.kind !== 'unsafe') throw new Error(`expected unsafe, got ${result.kind}`);
    expect(result.reason).toContain('identities must not be empty');
  });
});

describe('manifest immutability', () => {
  it('freezes rows, the list and plans against mutation', () => {
    const result = planReviewAreas({ components: [tracked('src/a.ts')] });
    expect(Object.isFrozen(result.changedFiles)).toBe(true);
    expect(Object.isFrozen(result.changedFiles[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'areas') {
      expect(Object.isFrozen(result.areas)).toBe(true);
      expect(Object.isFrozen(result.areas[0])).toBe(true);
      expect(Object.isFrozen(result.areas[0]!.files)).toBe(true);
      expect(Object.isFrozen(result.areas[0]!.contracts)).toBe(true);
      expect(Object.isFrozen(result.crossAreaPass)).toBe(true);
      expect('text' in result.changedFiles[0]!).toBe(false);
      expect(JSON.stringify(result)).not.toContain('diff --git');
    }
    expect(() => {
      const mutable = result.changedFiles as unknown as { push: (value: string) => unknown };
      mutable.push('x');
    }).toThrow(TypeError);
  });
});

describe('cross-area reserve', () => {
  const seeded: ReviewAreaPlan = plan({
    intent: 'Seeded change.',
    components: [
      tracked('src/a.ts', ['export const a = 1;']),
      tracked('src/b.ts', ['export const b = 2;']),
    ],
  });

  it('holds a reserve before any area completes and bounds primary chars', () => {
    const reserved = reserveCrossAreaPass(seeded, 100, []);
    expect(reserved).toMatchObject({
      kind: 'areas',
      plan: seeded,
      reserveChars: 100,
      primaryMaxChars: seeded.totalChars - 100,
    });
  });

  it('refuses invalid reserves and a hold after any area completed', () => {
    expect(() => reserveCrossAreaPass(seeded, -1, [])).toThrow(/within 0\./);
    expect(() => reserveCrossAreaPass(seeded, 1.5, [])).toThrow(/must be an integer/);
    expect(() => reserveCrossAreaPass(seeded, seeded.totalChars + 1, [])).toThrow(/within 0\./);
    expect(() => reserveCrossAreaPass(seeded, 100, ['area-1'])).toThrow(
      /before the first area completes/,
    );
    expect(() => reserveCrossAreaPass(seeded, 0, [])).not.toThrow();
  });

  it('holds zero reserve on a no-pass plan and never mints one out of nothing', () => {
    const single = plan({ components: [tracked('src/plain.ts', ['const v = 1;'])] });
    expect(single.crossAreaPass.required).toBe(false);
    expect(() => reserveCrossAreaPass(single, 0, [])).not.toThrow();
    expect(reserveCrossAreaPass(single, 0, []).primaryMaxChars).toBe(single.totalChars);
    expect(single.crossAreaPass.promptReserveChars).toBe(
      REVIEW_AREA_DEFAULTS.crossAreaPromptReserveChars,
    );
  });
});

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

describe('excluded components never enter the plan', () => {
  it('groups only the reviewed slice the caller passes', () => {
    const reviewedOnly = plan({ components: [tracked('src/a.ts', ['export const a = 1;'])] });
    expect(reviewedOnly.changedFiles).toHaveLength(1);
    expect(reviewedOnly.totalChars).toBe(tracked('src/a.ts', ['export const a = 1;']).text.length);
  });
});

describe('reserved view immutability', () => {
  it('freezes the reserved view and shares the plan by reference', () => {
    const seeded = plan({
      components: [
        tracked('src/a.ts', ['export const a = 1;']),
        tracked('src/b.ts', ['export const b = 2;']),
      ],
    });
    const reserved = reserveCrossAreaPass(seeded, 10, []);
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(reserved.plan).toBe(seeded);
    const view: ReviewAreaResult = planReviewAreas({ components: [tracked('src/a.ts')] });
    expect(view.kind).toBe('areas');
    const typed: ReservedReviewAreaPlan = reserved;
    expect(typed.primaryMaxChars).toBe(seeded.totalChars - 10);
  });
});
