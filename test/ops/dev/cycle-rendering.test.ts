import { describe, expect, test } from 'vitest';
import {
  DEV_FINDINGS_SECTION_MARKER,
  followUpCommand,
  renderFindingsSection,
} from '../../../src/ops/dev/cycle.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
import { addressReport } from './cycle.helpers.js';

describe('followUpCommand and renderFindingsSection', () => {
  test('the follow-up command spells the PR-side address source', () => {
    expect(followUpCommand(7, '/repo')).toBe("cq review.address --repoRoot='/repo' --source=pr:7");
  });

  test('the findings section is markdown-safe and carries every attempt', () => {
    const state = {
      branch: 'feature/x',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
    } as WorkState;
    const finding = {
      id: 'c001|x',
      source: 'agent',
      file: 'src/a|b.ts',
      severity: 'major',
      text: 'has `backticks` and <script>',
      status: 'open' as const,
    };
    const report = addressReport(
      state,
      [finding],
      [
        {
          finding: 'c001|x',
          tier: 'rescue',
          attempt: 2,
          invocation: 'feedback',
          reason: 'the fix did not compile',
          model: { provider: 'fixture', model: 'rescue|m' },
          observedHead: state.head,
          wallMs: 1200,
        },
      ],
    );
    const section = renderFindingsSection(report);
    expect(section.startsWith(DEV_FINDINGS_SECTION_MARKER)).toBe(true);
    expect(section).toContain('<!-- /cq:dev-findings -->');
    // A no-stop report WITHOUT a selection is the clean-run framing: the
    // gates were green and the draft exists for readiness gaps — never the
    // round cap's "stopped" text.
    expect(section).toContain('## Open findings after a clean address run (readiness gaps)');
    expect(section).toContain('review.address finished clean');
    expect(section).toContain('readiness gaps');
    expect(section).not.toContain('round cap');
    // mdLine: pipes escape even inside code spans; mdSafe rewrites backticks
    // to typographic apostrophes and strips angle brackets.
    expect(section).toContain('`c001\\|x`');
    expect(section).toContain('src/a\\|b.ts');
    expect(section).toContain('’backticks’');
    // mdSafe strips angle brackets entirely: '<script>' → 'script'.
    expect(section).toContain('and script');
    expect(section).not.toContain('<script>');
    expect(section).toContain('rescue/feedback #2');
    expect(section).toContain('1200ms');
  });

  test('an empty attempt log renders the explicit none-note', () => {
    const state = {
      branch: 'feature/x',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
    } as WorkState;
    const section = renderFindingsSection(addressReport(state, [], []));
    expect(section).toContain('(no attempts were dispatched)');
    expect(section).toContain('(none)');
  });

  test('a structured stop keeps its own framing: the round cap never reads as a clean run', () => {
    const state = {
      branch: 'feature/x',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
    } as WorkState;
    const section = renderFindingsSection({
      ...addressReport(state, [], []),
      stop: 'round-cap' as const,
    });
    expect(section).toContain('## Open findings at the review round cap — author evidence');
    expect(section).toContain('stopped at its round cap');
    expect(section).not.toContain('clean address run');
  });
});
