// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// exclusion and zero-content review decisions.
import { describe, expect, it } from 'vitest';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import {
  ReviewCoverageV2Schema,
  isCoverageV2Complete,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';
import { planInput, tracked } from './reviewPlan.helpers.js';

describe('createReviewPlan exclusions', () => {
  it('keeps one piece per original component and only sends reviewed bytes', () => {
    const components = [
      tracked('src/a.ts', ['export const a = 1;']),
      tracked('pnpm-lock.yaml', ['lockfile change']),
      tracked('docs/guide.md', ['doc change']),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        fileList: '1\t0\tsrc/a.ts',
        exclude: [
          { pattern: '**/pnpm-lock.yaml', assuredBy: 'dev.check lockfile integrity' },
          { pattern: 'docs/**' },
        ],
      }),
    );
    const lock = plan.coverage.pieces.find((piece) => piece.path === 'pnpm-lock.yaml');
    const docs = plan.coverage.pieces.find((piece) => piece.path === 'docs/guide.md');
    expect(lock).toMatchObject({
      state: 'excluded',
      exclusion: { rule: '**/pnpm-lock.yaml', assuredBy: 'dev.check lockfile integrity' },
    });
    expect(docs).toMatchObject({
      state: 'excluded',
      exclusion: { rule: 'docs/**' },
    });
    expect(docs!.exclusion?.limitation).toContain('no assuredBy check');
    expect(plan.limitations).toEqual([docs!.exclusion!.limitation]);
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).not.toContain('lockfile change');
    expect(prompt).not.toContain('doc change');
    expect(prompt).toContain('export const a = 1;');
    expect(prompt).toContain('## Changed files');
    expect(prompt).toContain('pnpm-lock.yaml');
    expect(prompt).toContain('docs/guide.md');
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();
  });

  it('reports a zero-content review when every component is excluded', () => {
    const components = [tracked('docs/a.md', ['a']), tracked('docs/b.md', ['b'])];
    const plan = createReviewPlan(planInput(components, { exclude: [{ pattern: 'docs/**' }] }));
    expect(plan.sessions).toEqual([]);
    expect(plan.advisories).toEqual(['agent review covered no content: all components excluded']);
    expect(plan.coverage.pieces.map((piece) => piece.state)).toEqual(['excluded', 'excluded']);
    expect(plan.limitations).toHaveLength(2);
    expect(plan.coverage.sessions).toEqual([]);
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();
    expect(isCoverageV2Complete(plan.coverage)).toBe(true);
  });
});
