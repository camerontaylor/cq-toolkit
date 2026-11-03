// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this module holds the shared
// fixtures and declares no tests, no describe.
import { createHash } from 'node:crypto';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import {
  planReviewAreas,
  type ReviewAreaPlan,
} from '../../../src/ops/review/internal/reviewAreas.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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

export function plan(
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
