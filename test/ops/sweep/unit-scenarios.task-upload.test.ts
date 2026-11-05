// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import { UNIT, bindingsOf, makeWorld } from './unit-scenarios.helpers.js';

test.each(['missing', 'fault', 'initial-hit', 'prior-output', 'related-output'] as const)(
  'task upload gate refuses %s without sending tainted prompts',
  async (mode) => {
    const world = await makeWorld([
      { failing: true, message: mode === 'initial-hit' ? 'DO_NOT_UPLOAD' : 'failure' },
      { failing: true, message: mode === 'related-output' ? 'DO_NOT_UPLOAD' : 'failure' },
    ]);
    let calls = 0;
    try {
      const base = world.driverFactory();
      const bindings = bindingsOf(world, {
        taskLoop: {},
        scanPrompt: async (text) => {
          if (mode === 'fault' || text.includes('DO_NOT_UPLOAD')) throw new Error('scan refused');
        },
        driver: {
          run: async (...args) => {
            calls++;
            expect(args[0].prompt).not.toContain('DO_NOT_UPLOAD');
            const result = await base.run(...args);
            return mode === 'prior-output'
              ? { ...result, structuredOutput: { summary: 'DO_NOT_UPLOAD' } }
              : result;
          },
        },
      });
      if (mode === 'missing') delete bindings.scanPrompt;
      const result = await makeSweepUnitOp(bindings)(UNIT);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(calls).toBe(['prior-output', 'related-output'].includes(mode) ? 1 : 0);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
