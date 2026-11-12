// #1198 — the dev.cycle findings renderer lists expectation changes under
// "Expectation changes" with the before/after pair (the independent
// reviewer's Q32 evidence), dedups repeats across attempts and fixes, and
// renders no section at all when no attempt carried an observation.
import { describe, expect, test } from 'vitest';
import { renderFindingsSection } from '../../../src/ops/dev/cycle.js';
import type { ValidationVerdict } from '../../../src/ops/fix/validate.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
import { addressReport } from './cycle.helpers.js';

const state = { branch: 'feature/x', head: 'a'.repeat(40), base: 'b'.repeat(40) } as WorkState;

const attemptOf = (validation?: ValidationVerdict[]) => ({
  finding: 'c001|x',
  tier: 'worker' as const,
  attempt: 1,
  invocation: 'edit' as const,
  reason: 'the fix moved the failure',
  model: { provider: 'fixture', model: 'scripted' },
  observedHead: state.head,
  wallMs: 100,
  ...(validation === undefined ? {} : { validation }),
});

const expectationVerdict: ValidationVerdict = {
  verdict: 'pass',
  gates: [],
  expectationChanges: [
    {
      file: 'test/a.test.ts',
      line: 2,
      before: 'expect(x).toBe(1);',
      after: 'expect(x).toBe(2);',
    },
  ],
};

describe('renderFindingsSection expectation changes', () => {
  test('an expectation rewrite renders under Expectation changes with the pair', () => {
    const report = addressReport(state, [], [attemptOf([expectationVerdict])]);
    const section = renderFindingsSection(report);
    expect(section).toContain('- Expectation changes:');
    expect(section).toContain('`test/a.test.ts:2`');
    expect(section).toContain('expect(x).toBe(1);');
    expect(section).toContain('expect(x).toBe(2);');
  });

  test('the same rewrite on an attempt and its fix dedups to one line', () => {
    const report: ReviewAddressReport = {
      ...addressReport(state, [], [attemptOf([expectationVerdict])]),
      fixes: [
        {
          finding: {
            id: 'c001|x',
            source: 'agent',
            file: 'src/a.ts',
            severity: 'major',
            text: 'fix the constant',
            status: 'fixed',
          },
          observedHead: state.head,
          reason: 'fixed',
          validation: [expectationVerdict],
        },
      ],
    };
    const section = renderFindingsSection(report);
    expect(section.match(/expect\(x\)\.toBe\(1\);/g)?.length).toBe(1);
  });

  test('markdown-safe output: a pipe in the file path cannot break the section', () => {
    const verdict: ValidationVerdict = {
      verdict: 'pass',
      gates: [],
      expectationChanges: [
        { file: 'test/a|b.test.ts', line: 7, before: 'assert x == 1', after: 'assert x == 2' },
      ],
    };
    const section = renderFindingsSection(addressReport(state, [], [attemptOf([verdict])]));
    expect(section).toContain('`test/a\\|b.test.ts:7`');
    expect(section).toContain('assert x == 1');
    expect(section).toContain('assert x == 2');
  });

  test('no observation means no Expectation changes section at all', () => {
    const section = renderFindingsSection(
      addressReport(state, [], [attemptOf([{ verdict: 'pass', gates: [] }])]),
    );
    expect(section).not.toContain('Expectation changes');
    const empty = renderFindingsSection(addressReport(state, [], []));
    expect(empty).not.toContain('Expectation changes');
  });
});
