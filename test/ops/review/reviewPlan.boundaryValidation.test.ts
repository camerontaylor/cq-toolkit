// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// boundary-validation and determinism decisions.
import { describe, expect, it } from 'vitest';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import { planInput, tracked } from './reviewPlan.helpers.js';

describe('createReviewPlan boundary validation', () => {
  const component = tracked('src/a.ts');

  it('rejects an effective medium tier below the effective small tier', () => {
    expect(() =>
      createReviewPlan(planInput([component], { size: { medium: { maxChangedLines: 1 } } })),
    ).toThrow(/medium maxChangedLines/);
    expect(() =>
      createReviewPlan(planInput([component], { size: { medium: { maxFiles: 4 } } })),
    ).toThrow(/medium maxFiles/);
  });

  it('rejects negative, fractional or NaN thresholds', () => {
    expect(() =>
      createReviewPlan(planInput([component], { size: { small: { maxChangedLines: -1 } } })),
    ).toThrow(/size\.small\.maxChangedLines/);
    expect(() =>
      createReviewPlan(planInput([component], { size: { small: { maxFiles: 1.5 } } })),
    ).toThrow(/size\.small\.maxFiles/);
    expect(() =>
      createReviewPlan(
        planInput([component], { size: { medium: { maxChangedLines: Number.NaN } } }),
      ),
    ).toThrow(/size\.medium\.maxChangedLines/);
  });

  it('rejects invalid session bounds', () => {
    expect(() =>
      createReviewPlan(planInput([component], { session: { maxInputChars: 0 } })),
    ).toThrow(/session\.maxInputChars/);
    expect(() => createReviewPlan(planInput([component], { session: { maxSteps: 0 } }))).toThrow(
      /session\.maxSteps/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { session: { concurrency: Number.NaN } })),
    ).toThrow(/session\.concurrency/);
    expect(() => createReviewPlan(planInput([component], { session: { concurrency: 0 } }))).toThrow(
      /session\.concurrency/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { session: { maxInputChars: Number.NaN } })),
    ).toThrow(/session\.maxInputChars/);
  });

  it('rejects invalid partition tool budgets', () => {
    expect(() =>
      createReviewPlan(planInput([component], { partitionTools: { steps: 0 } })),
    ).toThrow(/partitionTools\.steps/);
    expect(() =>
      createReviewPlan(planInput([component], { partitionTools: { steps: 1.5 } })),
    ).toThrow(/partitionTools\.steps/);
    expect(() =>
      createReviewPlan(planInput([component], { partitionTools: { steps: Number.NaN } })),
    ).toThrow(/partitionTools\.steps/);
  });

  it('rejects empty, duplicate or unnamable components', () => {
    expect(() => createReviewPlan(planInput([]))).toThrow(/at least one scan component/);
    expect(() =>
      createReviewPlan(planInput([{ component: '', path: 'src/a.ts', text: 'x' }])),
    ).toThrow(/identities must not be empty/);
    expect(() =>
      createReviewPlan(planInput([component, { ...component, path: 'src/b.ts' }])),
    ).toThrow(/duplicate component identity/);
  });

  it('rejects empty exclusion rules and empty assurance names', () => {
    expect(() => createReviewPlan(planInput([component], { exclude: [{ pattern: '' }] }))).toThrow(
      /patterns must not be empty/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { exclude: [{ pattern: 'src/**', assuredBy: '' }] })),
    ).toThrow(/empty assuredBy/);
  });

  it('is deterministic across calls', () => {
    const input = planInput([tracked('src/a.ts', ['a']), tracked('src/b.ts', ['b'])]);
    expect(createReviewPlan(input)).toEqual(createReviewPlan(input));
  });
});
