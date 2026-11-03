// The ai-sdk driver instantiation — T1.4 slice 3.
//
// Two layers:
//   1. THE CONFORMANCE SUITE, run against the real AiSdkDriver with a MOCK
//      model (ai/test helpers) scripted per the suite's ModelDirective
//      contract — structured output, budget/abort, denials, usage, the
//      vendor-vocabulary ban, and the I6 isolation pairs.
//   2. DRIVER-SPECIFIC unit tests: pre-dispatch failures (unknown provider,
//      missing env key), the stopReason mapping table, the exact
//      ai@7.0.99 → frozen Usage mapping, and pricing integration (derived
//      costUSD for a known model, absent for an unknown one).
//
// LIVE VARIANT: `describe.skipIf(!process.env.LIVE_DRIVERS)` runs the REAL
// default provider registry (no mocks) with tiny prompts and a hard
// Budget.maxUsd 2 / maxTokens 2000. SKIPPED unless LIVE_DRIVERS=1 — CI never
// sets it (the workflow wiring is T1.7's). When opted in, a missing provider
// key fails loudly instead of silently passing.
// Split by subject: the driver-specific layers named above now live in the
// sibling ai-sdk.*.test.ts files; the shared mock-model helpers in
// ai-sdk.helpers.ts. The LIVE variant stays here: a live-only file executes
// zero tests until LIVE_DRIVERS=1, which the narrow gate reads as a failure.
import { describe, expect, test } from 'vitest';
import { BANNED_VOCABULARY, runDriverConformance } from '../../src/driver/conformance.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import { runGovernedAbortLeg } from './conformance-kernel.js';
import { makeDriver } from './ai-sdk.helpers.js';

// ---------------------------------------------------------------------------
// 1. The conformance suite, mock-backed
// ---------------------------------------------------------------------------

runDriverConformance(
  makeDriver,
  { describe, test, expect },
  { label: 'ai-sdk driver (mock model)' },
);
runGovernedAbortLeg(makeDriver, { describe, test, expect });

// ---------------------------------------------------------------------------
// 3. LIVE variant — opt-in only (LIVE_DRIVERS=1); real provider registry, tiny prompts
// ---------------------------------------------------------------------------

// The deepseek wire SERVES `deepseek-flash` for a `deepseek-chat` request
// (observed live 2026-09-14, docs/eval-axes-demo.md) — eval/live wires
// request the id the wire actually serves (conductor decision, STATUS
// Deviations 2026-09-14), so the observed-model identity holds and the cost
// fold keys on the model that really ran.
const liveCases: ReadonlyArray<[provider: string, model: string, keyName: string]> = [
  ['anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY'],
  ['deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY'],
];

describe.skipIf(!process.env.LIVE_DRIVERS)('live ai-sdk driver (opt-in: LIVE_DRIVERS=1)', () => {
  test.each(liveCases)(
    '%s %s replies within the budget cap',
    async (provider, model, keyName) => {
      if (process.env[keyName] === undefined || process.env[keyName] === '') {
        throw new Error(
          `LIVE_DRIVERS=1 but ${keyName} is not set — refusing to silently skip one leg`,
        );
      }
      const driver = new AiSdkDriver(); // the REAL default registry, no mocks
      const result = await driver.run({
        prompt: 'Reply with the word ok.',
        modelSpec: { provider, model },
        toolPolicy: { allow: [], mode: 'none' },
        sandboxPolicy: { level: 'none' },
        budget: { maxUsd: 2, maxTokens: 2000 },
      });
      // The live assertions are the conformance invariants that make sense
      // over the wire: usage present, no vendor vocabulary, the strict mirror
      // parses the result, and a tiny prompt completes inside the cap.
      const serialized = JSON.stringify(result);
      for (const banned of BANNED_VOCABULARY) {
        expect(serialized).not.toContain(banned);
      }
      const parsed = WorkerResultSchema.parse(JSON.parse(serialized));
      expect(typeof parsed.usage.input).toBe('number');
      expect(typeof parsed.usage.output).toBe('number');
      expect(parsed.stopReason).toBe('complete');
      // Every live leg is now priced — `deepseek-flash` was vendored from
      // models.dev (fetched 2026-09-21), closing the old no-published-rates
      // gap — so each leg asserts a real derived figure under the declared
      // maxUsd cap. The observed-model identity asserts what the SDK
      // SURFACES (a remap it does not surface is recorded, not caught — the
      // fold falls back to the requested id).
      expect(parsed.costUSD).toBeDefined();
      expect(parsed.costUSD as number).toBeLessThan(2);
      expect(parsed.model).toBe(model);
    },
    60_000,
  );
});
