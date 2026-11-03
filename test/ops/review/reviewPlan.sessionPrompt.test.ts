// Split provenance: test/ops/review/reviewPlan.test.ts was split into
// reviewPlan.{sessionCoverage,sessionPrompt,sessionBudget,partitionedFallback,
// partitionedTools,exclusions,boundaryValidation}.test.ts. This file holds the
// session-mode prompt content and context-budget decisions.
import { describe, expect, it } from 'vitest';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import {
  expectExactPlacements,
  finding,
  planInput,
  tracked,
  untracked,
} from './reviewPlan.helpers.js';

describe('createReviewPlan session mode', () => {
  it('adds the documentation and configuration instruction only for docs/config changes', () => {
    const docs = createReviewPlan(
      planInput([tracked('docs/guide.md', ['new value'])], {
        intent: 'Document the default.',
      }),
    );
    expect(docs.sessions[0]!.prompt).toContain(
      'check every documented value against its source of truth',
    );

    const code = createReviewPlan(
      planInput([tracked('src/value.ts', ['export const value = 1;'])]),
    );
    expect(code.sessions[0]!.prompt).not.toContain('check every documented value');
    expect(code.sessions[0]!.prompt).toContain('check every contract other code depends on');
  });

  it('includes contract scrutiny on a small diff and prior findings with dispositions', () => {
    const prior = [
      finding({
        id: 'f1',
        file: 'src/a.ts',
        line: 12,
        rule: 'causal',
        status: 'fixed',
        text: 'stale reader survived the rename',
      }),
      finding({
        id: 'f2',
        severity: 'minor',
        status: 'rejected',
        reason: 'false positive in generated file',
        text: 'generated lockfile mismatch',
      }),
    ];
    const plan = createReviewPlan(
      planInput([tracked('src/a.ts', ['export type Kind = "a" | "b";'])], { priorFindings: prior }),
    );
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).toContain('## Prior findings and dispositions');
    expect(prompt).toContain('stale reader survived the rename (fixed)');
    expect(prompt).toContain(
      'generated lockfile mismatch (rejected: false positive in generated file)',
    );
    expect(prompt).toContain('check that the fixes hold and look for regressions');
    expect(prompt).toContain('check every contract other code depends on');
  });

  it('caps intent, file list and prior-findings context at 4000 characters', () => {
    const intent = `start-${'i'.repeat(5_000)}-end`;
    const fileList = `start-${'f'.repeat(5_000)}-end`;
    const prior = [finding({ text: `start-${'p'.repeat(5_000)}-end` })];
    const plan = createReviewPlan(
      planInput([tracked('src/a.ts')], { intent, fileList, priorFindings: prior }),
    );
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).not.toContain('i'.repeat(5_000));
    expect(prompt).not.toContain('f'.repeat(5_000));
    expect(prompt).not.toContain('p'.repeat(5_000));
    expect(prompt.match(/\[truncated: /g)).toHaveLength(3);
  });

  it('never recovers placements by searching repeated text', () => {
    const marker = '### src/other.ts (component tracked:src/other.ts, UTF-16 range 0:1)';
    const components = [
      tracked('src/a.ts', [marker]),
      untracked('src/b.ts', 'prefix\n'),
      tracked('src/c.ts', [marker]),
    ];
    const plan = createReviewPlan(planInput(components));
    const session = plan.sessions[0]!;
    expect(session.prompt.split(marker).length).toBeGreaterThan(2);
    expectExactPlacements(
      session,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
  });

  it('keeps a session above the default harness prompt cap but inside the session budget', () => {
    const text = 'y'.repeat(25_000);
    const plan = createReviewPlan(planInput([untracked('src/wide.ts', text)]));
    expect(plan.coverage.mode).toBe('session');
    expect(plan.sessions[0]!.tools).toBe(true);
    expect(plan.sessions[0]!.prompt.length).toBeGreaterThan(20_000);
    expect(plan.sessions[0]!.prompt.length).toBeLessThanOrEqual(60_000);
    const placement = plan.sessions[0]!.placements[0]!;
    expect(
      plan.sessions[0]!.prompt.slice(
        placement.offset,
        placement.offset + (placement.end - placement.start),
      ),
    ).toBe(text);
  });
});
