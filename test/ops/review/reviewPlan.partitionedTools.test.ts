// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// partitioned-fallback tooling and step-budget decisions.
import { describe, expect, it } from 'vitest';
import {
  REVIEW_PARTITION_STEPS,
  createReviewPlan,
} from '../../../src/ops/review/internal/reviewPlan.js';
import { planInput, tracked } from './reviewPlan.helpers.js';

describe('createReviewPlan partitioned fallback', () => {
  it('gives every fallback partition the fixed read-only tool set and bounded steps', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components));
    expect(plan.coverage.mode).toBe('partitioned');
    expect(plan.limitations).toEqual([]);
    for (const session of plan.sessions) {
      expect(session.tools).toBe(true);
      expect(session.maxSteps).toBe(REVIEW_PARTITION_STEPS);
      expect(session.prompt).toContain('bounded read-only reference tools (read');
      expect(session.prompt).toContain('verify cited code and one direct dependency');
      expect(session.prompt).toContain('denied on your final step');
      expect(session.prompt).not.toContain('This session has no tools');
    }
  });

  it('clamps partition steps under a lower configured session.maxSteps ceiling', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(
      planInput(components, { session: { maxSteps: 2 }, partitionTools: { steps: 9 } }),
    );
    expect(plan.sessions.every((session) => session.tools)).toBe(true);
    expect(plan.sessions.every((session) => session.maxSteps === 2)).toBe(true);
  });

  it('keeps the explicit one-step partition budget but omits unusable tools', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components, { partitionTools: { steps: 1 } }));

    expect(plan.sessions.every((session) => !session.tools)).toBe(true);
    expect(plan.sessions.every((session) => session.maxSteps === 1)).toBe(true);
    for (const session of plan.sessions) {
      expect(session.prompt).toContain('This session has no tools');
      expect(session.prompt).not.toContain('bounded read-only');
    }
    expect(plan.limitations).toEqual([
      'partitioned fallback ran without tools: the one-step budget is reserved for the final answer, so partition findings could not be verified against referenced code',
    ]);
  });

  it('keeps a one-step global ceiling and omits unusable partition tools', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components, { session: { maxSteps: 1 } }));

    expect(plan.sessions.every((session) => !session.tools)).toBe(true);
    expect(plan.sessions.every((session) => session.maxSteps === 1)).toBe(true);
    for (const session of plan.sessions) {
      expect(session.prompt).toContain('This session has no tools');
      expect(session.prompt).not.toContain('bounded read-only');
    }
    expect(plan.limitations).toEqual([
      'partitioned fallback ran without tools: the one-step budget is reserved for the final answer, so partition findings could not be verified against referenced code',
    ]);
  });

  it('keeps the read-only file-only set when searchTools is false', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components, { searchTools: false }));
    expect(plan.sessions.every((session) => session.tools)).toBe(true);
    expect(plan.sessions.every((session) => session.maxSteps === REVIEW_PARTITION_STEPS)).toBe(
      true,
    );
    for (const session of plan.sessions)
      expect(session.prompt).toContain('bounded read-only file tool');
  });

  it('keeps an explicit tool-less fallback opt-out with its stated limitation', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components, { partitionTools: false }));
    expect(plan.sessions.every((session) => !session.tools)).toBe(true);
    expect(plan.sessions.every((session) => session.maxSteps === undefined)).toBe(true);
    for (const session of plan.sessions) {
      expect(session.prompt).toContain('This session has no tools');
      expect(session.prompt).not.toContain('bounded read-only');
    }
    expect(plan.limitations).toEqual([
      'partitioned fallback ran without tools: partition findings could not be verified against referenced code',
    ]);
  });

  it('is deterministic with partition tooling configured', () => {
    const components = [tracked('src/a.ts', ['a']), tracked('src/b.ts', ['b'])];
    const input = planInput(components, { partitionTools: { steps: 5 } });
    expect(createReviewPlan(input)).toEqual(createReviewPlan(input));
  });
});
