// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { defaultClassifyConfig } from '../../../src/ops/review/classify.config.js';
import { baseState, itemsOf, thread, NOW } from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// Skip-pattern evaluation is stateless (CodeRabbit thread on this file):
// a config RegExp carrying the `g` or `y` flag mutates lastIndex across
// .test() calls, so a stateful implementation would alternate between
// match and no-match on identical bodies — the table must stay pure.
// ---------------------------------------------------------------------------

describe('skip-pattern evaluation is stateless vs lastIndex', () => {
  /** One shared pattern OBJECT reused across calls — exactly the shape a
   * config-supplied pattern takes, and the shape that goes stateful. */
  const gConfig = { ...defaultClassifyConfig, skipPatterns: [/skipped/g] };
  const yConfig = { ...defaultClassifyConfig, skipPatterns: [/skipped/y] };
  const state = baseState({
    threads: [thread({ id: 'TG1', body: 'CodeRabbit skipped this run' })],
  });
  const expected = [
    {
      kind: 'thread' as const,
      id: 'TG1',
      verdict: 'skip' as const,
      path: 'src/a.ts',
      reason: 'bot_skip_notice',
    },
  ];

  test('a /g config pattern classifies the same body identically across three consecutive calls', () => {
    const runs = [
      itemsOf(state, NOW, gConfig),
      itemsOf(state, NOW, gConfig),
      itemsOf(state, NOW, gConfig),
    ];
    // Without the fresh-expression fix, lastIndex makes the verdicts
    // alternate skip / actionable / skip — every run must be identical.
    expect(runs[0]).toEqual(expected);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test('a /y config pattern classifies the same body identically across three consecutive calls', () => {
    const runs = [
      itemsOf(state, NOW, yConfig),
      itemsOf(state, NOW, yConfig),
      itemsOf(state, NOW, yConfig),
    ];
    // Sticky alone would anchor at lastIndex and never match from an
    // advanced position; stripped, it must behave exactly like the /g case.
    expect(runs[0]).toEqual(expected);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});
