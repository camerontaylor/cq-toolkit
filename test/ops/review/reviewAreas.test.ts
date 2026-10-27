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

  it('spans two areas so a failure case has a surviving sibling', () => {
    expect(seeded.areas).toHaveLength(2);
  });

  it('excludes only cross-area-covered manifest paths from primary coverage', () => {
    const covered = new Set<string>(['src/a.ts']);
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    expect(reserved.plan.changedFiles.map((file) => file.path)).toEqual(['src/a.ts', 'docs/b.md']);
    expect(isExcludedFromPrimaryCoverage(reserved, covered, 'src/a.ts')).toBe(true);
    expect(isExcludedFromPrimaryCoverage(reserved, covered, 'docs/b.md')).toBe(false);
    expect(isExcludedFromPrimaryCoverage(reserved, covered, 'src/never-planned.ts')).toBe(false);
  });

  it('treats a held reserve as non-discharging: no path is excluded without cross-area coverage', () => {
    const bounded = Math.min(seeded.crossAreaPass.promptReserveChars, seeded.totalChars);
    const reserved = reserveCrossAreaPass(seeded, bounded, []);
    const covered = new Set<string>();
    for (const file of reserved.plan.changedFiles)
      expect(isExcludedFromPrimaryCoverage(reserved, covered, file.path)).toBe(false);
  });

  it('keeps failed required areas non-excluded: incomplete stays incomplete', () => {
    const reserved = reserveCrossAreaPass(seeded, 50, []);
    const failedArea = seeded.areas[0]!;
    // The failed area's own bytes stay primary coverage even when a sibling
    // area (or the cross-area pass) covered something else.
    const covered = new Set<string>(
      seeded.changedFiles
        .map((file) => file.path)
        .filter(
          (path) =>
            !failedArea.files.some((index) => seeded.changedFiles[index - 1]!.path === path),
        ),
    );
    for (const file of failedArea.files) {
      const path = seeded.changedFiles[file - 1]!.path;
      expect(covered.has(path)).toBe(false);
      expect(isExcludedFromPrimaryCoverage(reserved, covered, path)).toBe(false);
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
