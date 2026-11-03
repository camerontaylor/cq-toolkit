import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { mapWireUsage } from '../../src/driver/acp/protocol.js';
import { CONFORMANCE_MODEL } from '../../src/driver/conformance.js';
import type { SpawnCall } from './acp.helpers.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('THE SERVED-MODEL TEST: the requested model is observed via the modelEnv chain; a divergence is surfaced honestly', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
      const result = await driver.run(invocation({ prompt: 'observed-model run' }));
      // The observed chain: driver → modelEnv → fixture → materialized
      // config_option_update → WorkerResult.model — present and EQUAL to
      // the requested id (leg m's shape).
      expect(result.model).toBe(CONFORMANCE_MODEL);
      // The lazy session/new value is deliberately DIFFERENT
      // ('builtin:zai\<model>'): surfacing it would fail leg m, so passing
      // here PROVES the post-materialization read.
      expect(result.model).not.toBe(`builtin:zai\\${CONFORMANCE_MODEL}`);
      // And the requested id really rode the spawn env (the REQUEST channel).
      expect(calls[0]?.env['FAKE_ACP_MODEL']).toBe(CONFORMANCE_MODEL);

      // The remap demonstration: the vendor serves something ELSE than
      // requested (FAKE_ACP_SERVED_MODEL). The driver surfaces the honest
      // observation — which leg m would fail loudly, exactly like the
      // subprocess lane's remap test (the manufactured-requested id is
      // never substituted).
      const calls2: SpawnCall[] = [];
      const remapping = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'ok', FAKE_ACP_SERVED_MODEL: 'builtin:bigmodel\\GLM-5.3' },
          calls2,
        ),
      );
      const remapped = await remapping.run(invocation({ prompt: 'remapped run' }));
      expect(remapped.model).toBe('builtin:bigmodel\\GLM-5.3'); // the honest observation
      expect(remapped.model).not.toBe(CONFORMANCE_MODEL); // the suite's leg m fails this run loudly
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape — NO reasoning field', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, []));
      const result = await driver.run(invocation({ prompt: 'usage run' }));
      expect(result.stopReason).toBe('complete');
      // The wire carries {inputTokens:15, outputTokens:5, cachedReadTokens:2,
      // cachedWriteTokens:3} — inputTokens INCLUSIVE of the cached tokens
      // (totalTokens 20 = 15 + 5, the live-sample arithmetic). The fold
      // DERIVES input = 15 − 2 − 3 = 10 (cacheRead/cacheWrite stay the
      // breakdown terms, Σ = 20 = the wire's totalTokens): a driver that
      // maps inputTokens straight through reports 15 and fails here.
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      // thoughtTokens exists on the wire but its additivity is unproven —
      // reasoning is NEVER emitted (header; strategy §2.3).
      expect('reasoning' in result.usage).toBe(false);
      expect(result.costUSD).toBeUndefined(); // unpriced model — derived-only
      expect(result.costBasis).toBeUndefined();
    });
  });

  test('mapWireUsage: invalid token counts are NO measurement — negative/fractional/NaN/Infinity never reach accounting (PR #37 review, Codex P2)', () => {
    // The probed live sample folds unchanged (input INCLUSIVE of cache,
    // derived by subtraction — the committed arithmetic).
    expect(
      mapWireUsage({
        totalTokens: 15722,
        inputTokens: 15719,
        outputTokens: 3,
        cachedReadTokens: 11648,
        cachedWriteTokens: 0,
      }),
    ).toEqual({ input: 4071, output: 3, cacheRead: 11648, cacheWrite: 0 });
    // Every field rejects an invalid count by making the WHOLE usage
    // unshapeable: undefined, never zeros-that-look-measured and never a
    // corrupted fold (a negative inputToken could drag a total below
    // Budget.maxTokens; a negative outputToken a negative modeled cost).
    const badUsages: unknown[] = [
      { inputTokens: -1, outputTokens: 3 },
      { inputTokens: 15, outputTokens: -2 },
      { inputTokens: 1.5, outputTokens: 5 },
      { inputTokens: 15, outputTokens: 5, cachedReadTokens: -1 },
      { inputTokens: 15, outputTokens: 5, cachedWriteTokens: 2.5 },
      { inputTokens: 15, outputTokens: 5, thoughtTokens: Number.NaN },
      { inputTokens: 15, outputTokens: 5, totalTokens: Number.POSITIVE_INFINITY },
    ];
    for (const usage of badUsages) {
      expect(mapWireUsage(usage)).toBeUndefined();
    }
  });

  test('measured usage with NO observed served model: the cost is ABSENT even for a priced requested id — never silently priced (PR #37 review, Codex P2)', async () => {
    await withScratch(async (scratchDir) => {
      // FAKE_ACP_NO_SERVED_MODEL: the turn settles end_turn WITH usage but
      // the config_option_update never arrives. Pricing is trivially
      // satisfied for every spec, so the old requested-spec fallback would
      // surface a cost here; the fix keeps it absent (the DD-9 unpriced
      // trip then binds under a maxUsd instead of a silent misprice).
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_NO_SERVED_MODEL: '1' }, []),
        pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
      });
      const result = await driver.run(invocation({ prompt: 'no-observed-model run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // real measurement kept
      expect(result.model).toBeUndefined(); // observed-only, never requested
      expect(result.costUSD).toBeUndefined(); // never the requested-spec fallback
      expect(result.costBasis).toBeUndefined();
    });
  });

  test('a response CARRYING usage the wire gate rejects is an ERROR run — never zeros-that-look-measured (PR #97 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MALFORMED_USAGE: the turn settles end_turn with
      // inputTokens: -1. The verdict must pin to 'error' — the old code
      // treated the unshapeable usage as ABSENT, substituted zeros, and
      // classified the run 'complete', erasing accounting and bypassing
      // the unpriced check under a USD cap.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_MALFORMED_USAGE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'malformed-usage run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never trusted numbers
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"malformed-reported-usage"'))).toBe(true);
    });
  });
});

test('injected ACP pricing includes additive reasoning at the output rate', () => {
  const driver = new AcpDriver({ pricing: () => ({ input: 1, output: 2 }) });
  expect(
    driver['costUSDOf'](
      { provider: 'mock', model: 'mock' },
      { input: 0, output: 1_000_000, reasoning: 2_000_000, cacheRead: 0, cacheWrite: 0 },
    ),
  ).toBe(6);
});
