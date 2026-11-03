// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// session-mode coverage, size-tier and placement decisions.
import { describe, expect, it } from 'vitest';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import {
  ReviewCoverageV2Schema,
  isCoverageV2Complete,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';
import {
  base,
  expectExactPlacements,
  head,
  planInput,
  sha256,
  tracked,
  untracked,
} from './reviewPlan.helpers.js';

describe('createReviewPlan session mode', () => {
  it('plans one piece per original component and sends every reviewed byte once', () => {
    const components = [
      tracked('src/a.ts', ['export const a = 1;', 'export const b = 2;']),
      untracked('src/new.ts', 'export function fresh(): number {\n  return 1;\n}\n'),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        branch: 'fix/483-c',
        intent: 'Align the reviewer prompt with the tools it has.',
        fileList: '2\t0\tsrc/a.ts\n3\t0\tsrc/new.ts',
      }),
    );

    expect(plan.coverage.version).toBe(2);
    expect(plan.coverage.head).toBe(head);
    expect(plan.coverage.base).toBe(base);
    expect(plan.coverage.scope).toBe('full');
    expect(plan.coverage.mode).toBe('session');
    expect(plan.coverage.modeReason).toContain('small');
    expect(plan.coverage.sessions).toEqual([]);
    expect(plan.coverage.pieces).toHaveLength(2);
    expect(plan.coverage.pieces.map((piece) => piece.state)).toEqual(['planned', 'planned']);
    for (const [index, component] of components.entries()) {
      expect(plan.coverage.pieces[index]).toMatchObject({
        component: component.component,
        path: component.path,
        sha256: sha256(component.text),
        chars: component.text.length,
        bytes: Buffer.byteLength(component.text, 'utf8'),
      });
    }
    expect(isCoverageV2Complete(plan.coverage)).toBe(false);
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();

    expect(plan.sessions).toHaveLength(1);
    const [session] = plan.sessions;
    expect(session!.id).toBe('session-1');
    expect(session!.tools).toBe(true);
    expect(session!.placements.map((placement) => placement.component)).toEqual([
      'tracked:src/a.ts',
      'untracked:src/new.ts',
    ]);
    expectExactPlacements(
      session!,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
    for (const component of components)
      expect(session!.prompt.split(component.text)).toHaveLength(2);
    expect(session!.prompt).toContain('Branch: fix/483-c');
    expect(session!.prompt).toContain('## Intent');
    expect(session!.prompt).toContain('Align the reviewer prompt');
    expect(session!.prompt).toContain('## Changed files');
    expect(session!.prompt).toContain('Most reviews need 0-2 lookups');
    expect(session!.prompt).toContain('budget of 4 model steps');
    expect(session!.prompt).toContain('the last step has no tools and is your JSON answer');
    expect(session!.prompt).toContain('"findings"');
    expect(session!.prompt).not.toMatch(/receipt/i);
    expect(plan.advisories).toEqual([]);
    expect(plan.limitations).toEqual([]);
    expect('findings' in plan).toBe(false);
  });

  it('records exact builder offsets when component text repeats and data is empty', () => {
    const repeated = 'same repeated payload\n';
    const components = [
      tracked('src/a.ts', ['same repeated payload']),
      untracked('src/b.ts', repeated),
      untracked('src/c.ts', repeated),
      untracked('src/empty.ts', ''),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        session: { maxInputChars: 60_000 },
      }),
    );
    expect(plan.coverage.mode).toBe('session');
    const session = plan.sessions[0]!;
    expectExactPlacements(
      session,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
    const empty = session.placements.find(
      (placement) => placement.component === 'untracked:src/empty.ts',
    );
    expect(empty).toMatchObject({ start: 0, end: 0 });
    expect(empty!.offset).toBeGreaterThan(0);
    expect(
      plan.coverage.pieces.find((piece) => piece.component === 'untracked:src/empty.ts'),
    ).toMatchObject({
      chars: 0,
      bytes: 0,
      sha256: sha256(''),
    });
  });

  it('scales the exploration budget to the medium tier and honours custom thresholds', () => {
    const components = Array.from({ length: 6 }, (_, index) =>
      tracked(`src/m${String(index)}.ts`, ['a', 'b', 'c']),
    );
    const defaults = createReviewPlan(planInput(components));
    expect(defaults.coverage.mode).toBe('session');
    expect(defaults.coverage.modeReason).toContain('medium');
    expect(defaults.sessions[0]!.prompt).toContain('Prioritise contracts other code depends on');
  });

  it('uses the documented small and medium tiers with configurable thresholds', () => {
    const three = [tracked('src/a.ts', ['a', 'b', 'c']), tracked('src/b.ts', ['d'])];
    const medium = createReviewPlan(
      planInput(three, {
        size: {
          small: { maxChangedLines: 2, maxFiles: 2 },
          medium: { maxChangedLines: 8, maxFiles: 4 },
        },
      }),
    );
    expect(medium.coverage.mode).toBe('session');
    expect(medium.coverage.modeReason).toContain('medium');
    expect(medium.sessions[0]!.prompt).toContain('Prioritise contracts other code depends on');

    const small = createReviewPlan(
      planInput([tracked('src/a.ts', ['a', 'b'])], {
        size: { small: { maxChangedLines: 2 }, medium: { maxChangedLines: 8 } },
      }),
    );
    expect(small.coverage.modeReason).toContain('small');

    const large = createReviewPlan(
      planInput(three, {
        size: { small: { maxChangedLines: 2 }, medium: { maxChangedLines: 3 } },
      }),
    );
    expect(large.coverage.mode).toBe('partitioned');
    expect(large.coverage.modeReason).toBe('large change above the medium size tier');
  });

  it('chooses the size tier from reviewed content while retaining excluded coverage', () => {
    const components = [
      tracked('src/a.ts', ['changed']),
      tracked(
        'pnpm-lock.yaml',
        Array.from({ length: 1000 }, () => 'generated'),
      ),
      ...Array.from({ length: 21 }, (_, index) => tracked(`generated/${String(index)}.ts`)),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        exclude: [
          { pattern: 'pnpm-lock.yaml', assuredBy: 'lockfile check' },
          { pattern: 'generated/**', assuredBy: 'generator check' },
        ],
      }),
    );
    expect(plan.coverage.mode).toBe('session');
    expect(plan.coverage.modeReason).toContain('small');
    expect(plan.coverage.pieces.filter((piece) => piece.state === 'excluded')).toHaveLength(22);
    expect(plan.sessions[0]!.prompt).toContain('pnpm-lock.yaml');
  });
});
