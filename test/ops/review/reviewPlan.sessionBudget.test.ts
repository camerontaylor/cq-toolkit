// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// session-mode step-budget decisions.
import { describe, expect, it } from 'vitest';
import { REVIEW_SESSION_DEFAULTS } from '../../../src/ops/analyze/cqConfig.js';
import {
  REVIEW_TIER_STEPS,
  createReviewPlan,
} from '../../../src/ops/review/internal/reviewPlan.js';
import { planInput, tracked } from './reviewPlan.helpers.js';

describe('createReviewPlan session step budget', () => {
  const small = tracked('src/a.ts', ['export const a = 1;']);
  const medium = tracked(
    'src/big.ts',
    Array.from({ length: 400 }, (_, index) => `export const v${String(index)} = ${String(index)};`),
  );

  it('gives a small change the small-tier budget and says so in the prompt', () => {
    const session = createReviewPlan(planInput([small])).sessions[0]!;
    expect(session.maxSteps).toBe(REVIEW_TIER_STEPS.small);
    expect(session.maxSteps).toBeLessThan(REVIEW_SESSION_DEFAULTS.maxSteps);
    expect(session.prompt).toContain(`budget of ${String(REVIEW_TIER_STEPS.small)} model steps`);
    expect(session.prompt).toContain('Stop and answer');
  });

  it('gives a medium change the larger medium-tier budget', () => {
    const session = createReviewPlan(planInput([medium])).sessions[0]!;
    expect(session.maxSteps).toBe(REVIEW_TIER_STEPS.medium);
    expect(session.prompt).toContain(`budget of ${String(REVIEW_TIER_STEPS.medium)} model steps`);
  });

  it('never exceeds a lower configured session.maxSteps', () => {
    const session = createReviewPlan(planInput([small], { session: { maxSteps: 2 } })).sessions[0]!;
    expect(session.maxSteps).toBe(2);
    expect(session.prompt).toContain('budget of 2 model steps');
  });
});
