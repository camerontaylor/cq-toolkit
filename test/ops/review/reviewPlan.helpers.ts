// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This module carries
// the shared fixture surface verbatim from the original file; it declares no
// tests.
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import type {
  CreateReviewPlanInput,
  PlannedReviewSession,
} from '../../../src/ops/review/internal/reviewPlan.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const head = 'a'.repeat(40);
export const base = 'b'.repeat(40);

export function tracked(path: string, added: readonly string[] = ['changed']): ScanComponentInput {
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

export function untracked(path: string, text: string): ScanComponentInput {
  return { component: `untracked:${path}`, path, text };
}

export function planInput(
  components: readonly ScanComponentInput[],
  extra: Partial<CreateReviewPlanInput> = {},
): CreateReviewPlanInput {
  return { head, base, scope: 'full', components, ...extra };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'agent',
    severity: 'major',
    text: 'stale producer',
    status: 'open',
    ...overrides,
  };
}

export function expectExactPlacements(
  session: PlannedReviewSession,
  componentText: ReadonlyMap<string, string>,
): void {
  for (const placement of session.placements) {
    const source = componentText.get(placement.component);
    expect(source).toBeDefined();
    const length = placement.end - placement.start;
    expect(session.prompt.slice(placement.offset, placement.offset + length)).toBe(
      source!.slice(placement.start, placement.end),
    );
  }
}
