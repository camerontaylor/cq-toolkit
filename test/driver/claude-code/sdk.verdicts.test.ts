// claude-code SDK transport specifics (mock sdk): verdict, usage and cost
// mapping — the native structured-output option and its output-invalid
// verdict, pricing override → modeled costUSD (unpriced → both absent),
// unmeasured aborts, measured error verdicts, served-model pricing, the
// stopReason/resultStatus mapping tables, the agent→Usage fold (lying
// usage, thinking tokens never lifted), and the pure
// allowedToolNames/sandboxOption helpers.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { allowedToolNames } from '../../../src/driver/claude-code/cli.js';
import { sandboxOption } from '../../../src/driver/claude-code/sdk.js';
import { usageFromWire as usageFromAgent } from '../../../src/driver/claude-code/usage.js';
import { resultStatusOf, stopReasonOf } from '../../../src/driver/claude-code/verdict.js';
import type { StopReasonInputs } from '../../../src/driver/claude-code/verdict.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { runLadder } from '../../../src/kernel/governor.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  driverWithCalls,
  initFrame,
  invocation,
  mockAdapters,
  mockSdkModule,
  optionsOf,
} from './sdk.helpers.js';
import type { MockQueryCall } from './sdk.helpers.js';

describe('claude-code sdk transport specifics (mock sdk)', () => {
  test('structured output: the native json_schema option is sent; a schema-invalid payload is the output-invalid verdict (S3)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const schema = z.object({ answer: z.string() }).strict();
      const calls: MockQueryCall[] = [];
      const base = {
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      };
      // First run: a schema-valid payload — the happy path lands it.
      const ok = await new ClaudeCodeDriver({
        transport: 'sdk',
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"ok"}' }, calls }),
      }).run(
        invocation({
          prompt: 'structured ok',
          outputSchema: toOutputSchema('test/native/v1', schema),
        }),
      );
      const sent = optionsOf(calls, 0)['outputFormat'] as {
        type: string;
        schema: Record<string, unknown>;
      };
      expect(sent.type).toBe('json_schema');
      // The draft-2020-12 meta `$schema` URI is stripped before the SDK
      // hands the schema to the CLI (the CLI rejects that URI pre-model,
      // #209); the body is the seam document the validator judges over.
      expect(sent.schema['$schema']).toBeUndefined();
      expect(sent.schema).toEqual(toOutputSchema('test/native/v1', schema).schema);
      expect(ok.structuredOutput).toEqual({ answer: 'ok' });
      expect(ok.stopReason).toBe('complete');

      // Second run: a payload that fails the schema is NOT a model score —
      // the uniform §2.3 miss verdict (the old "complete with the payload
      // dropped to narration" behaviour is deleted).
      const bad = await new ClaudeCodeDriver({
        transport: 'sdk',
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"nope":true}' }, calls }),
      }).run(
        invocation({
          prompt: 'structured bad',
          outputSchema: toOutputSchema('test/native/v1', schema),
        }),
      );
      expect(bad.stopReason).toBe('error');
      expect(bad.errorClass).toBe('output-invalid');
      expect(bad.structuredOutput).toBeUndefined();
      expect(bad.error).toContain('structured output invalid');
      expect(bad.error).toContain("schema 'test/native/v1'");
      // A real measurement keeps its usage evidence on the miss verdict.
      expect(bad.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('pricing override: costUSD derived and labeled modeled; unpriced → both absent', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const priced = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        routingTable: conformanceEndpointTable(),
        pricing: () => ({ input: 3, output: 15 }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await priced.run(invocation());
      // usage {120, 12, 15, 5} at 3 / 15 per-million = (360 + 180) / 1e6.
      expect(result.costUSD).toBeCloseTo(0.00054, 12);
      expect(result.costBasis).toBe('modeled');

      const unpriced = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        routingTable: conformanceEndpointTable(),
        pricing: () => undefined, // the map does not know the model
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const absent = await unpriced.run(invocation());
      expect(absent.costUSD).toBeUndefined(); // derived-only: never fabricated
      expect(absent.costBasis).toBeUndefined(); // no basis without a cost
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unmeasured abort: zero usage and NO cost claim (never fabricate)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir, { directive: { kind: 'block-until-abort' } });
      // The governor's own channel mechanics: the ladder fires its signal at
      // wallClockMs; the wired cancellation root settles the query 'aborted'.
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(invocation({ budget: { maxTokens: 10_000 } }), { signal: ctx.signal }),
        { wallClockMs: 25 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      // Seam v3: the placeholder declares itself unmeasured, so the summary
      // observer counts it as unknown rather than a known zero.
      expect(outcome.value.usageProvenance).toBe('unmeasured');
      expect(outcome.value.costUSD).toBeUndefined(); // unmeasured: 0 would be a fabricated fact
      expect(outcome.value.costBasis).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('measured error verdict: a result event keeps its real usage and derived cost', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              calls.push({ prompt: 'n/a', options });
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        pricing: () => ({ input: 3, output: 15 }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // PRODUCER RULE (ADR-0002 §2.2): the error verdict carries its class —
      // a failed result frame is a provider-side outcome.
      expect(result.errorClass).toBe('provider-error');
      expect(result.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(result.costUSD).toBeCloseTo(0.00054, 12); // measured → derived cost is honest
      expect(result.costBasis).toBe('modeled');
      expect(calls).toHaveLength(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('cost prices the SERVED model when one was observed (remap rates, not requested rates)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            servedModel: 'gateway-default-served-instead',
          }),
        routingTable: conformanceEndpointTable(),
        // The price map knows ONLY the served id — pricing the REQUESTED id
        // would return undefined and the verdict would carry no cost.
        pricing: (modelSpec) =>
          modelSpec.model === 'gateway-default-served-instead'
            ? { input: 3, output: 15 }
            : undefined,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'what-we-asked-for' } }),
      );
      expect(result.model).toBe('gateway-default-served-instead'); // the remap was surfaced
      expect(result.costUSD).toBeCloseTo(0.00054, 12); // usage {120, 12} at the SERVED id's rates
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopReason mapping table (checked in order: aborted → budget → error → complete)', () => {
    const inputs = (over: Partial<StopReasonInputs>): StopReasonInputs => ({
      aborted: false,
      maxTokens: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      resultStatus: 'success',
      ...over,
    });
    // 1. abort dominates every other condition.
    expect(
      stopReasonOf(
        inputs({
          aborted: true,
          maxTokens: 1,
          usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
          resultStatus: 'error',
        }),
      ),
    ).toBe('aborted');
    // 2. the token budget (folded usage >= maxTokens) trips before statuses.
    expect(
      stopReasonOf(
        inputs({
          maxTokens: 10,
          usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
          resultStatus: 'success',
        }),
      ),
    ).toBe('budget');
    expect(
      stopReasonOf(
        inputs({
          maxTokens: 10,
          usage: { input: 4, output: 4, cacheRead: 1, cacheWrite: 1, reasoning: 2 },
          resultStatus: 'error',
        }),
      ),
    ).toBe('budget');
    // 3. the SDK's own caps are budget stops (error_max_turns / error_max_budget_usd).
    expect(stopReasonOf(inputs({ resultStatus: 'cap' }))).toBe('budget');
    // 4. success (is_error ≠ true) is the only complete.
    expect(stopReasonOf(inputs({ resultStatus: 'success' }))).toBe('complete');
    // 5. everything else is an error: success-with-is_error, other subtypes, no result.
    expect(stopReasonOf(inputs({ resultStatus: 'error' }))).toBe('error');
    expect(stopReasonOf(inputs({ resultStatus: 'none' }))).toBe('error');
  });

  test('resultStatusOf: success / cap / error / none over the raw result event', () => {
    expect(resultStatusOf(undefined)).toBe('none');
    expect(resultStatusOf({ subtype: 'success', is_error: false })).toBe('success');
    expect(resultStatusOf({ subtype: 'success', is_error: true })).toBe('error'); // success-with-is_error
    expect(resultStatusOf({ subtype: 'error_max_turns', is_error: true })).toBe('cap');
    expect(resultStatusOf({ subtype: 'error_max_budget_usd', is_error: true })).toBe('cap');
    expect(resultStatusOf({ subtype: 'error_during_execution', is_error: true })).toBe('error');
    expect(resultStatusOf({ subtype: 'error_max_structured_output_retries', is_error: true })).toBe(
      'error',
    );
    expect(resultStatusOf({ subtype: 'something-new' })).toBe('error'); // unknown → not a success
  });

  test('usage mapping: agent vocabulary → frozen Usage; reasoning NEVER set (thinking tokens are a subset of output)', () => {
    // thinkingTokens reported → reasoning still ABSENT: the SDK counts
    // thinking INSIDE output_tokens, so a separate field would double-count
    // every total that sums the frozen Usage fields.
    expect(
      usageFromAgent({
        input_tokens: 90,
        output_tokens: 42,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({ input: 90, output: 42, cacheRead: 15, cacheWrite: 5 });
    expect(usageFromAgent({ input_tokens: 1, output_tokens: 2 })).not.toHaveProperty('reasoning');
    // Missing numeric fields map to 0.
    expect(usageFromAgent({ input_tokens: 10, output_tokens: 3 })).toEqual({
      input: 10,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // An unshaped usage is NO measurement.
    expect(usageFromAgent('garbage')).toBeUndefined();
    expect(usageFromAgent(undefined)).toBeUndefined();
    // Non-finite numbers are as absent as missing ones.
    expect(usageFromAgent({ input_tokens: Number.NaN, output_tokens: 1 })).toEqual({
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // Lying measurements (issue #19-3 twin): negatives and fractions fold to
    // an honest 0 — never negative usage, never a negative-cost propagation.
    expect(
      usageFromAgent({
        input_tokens: -200_000,
        output_tokens: 150_000,
        cache_read_input_tokens: -3,
        cache_creation_input_tokens: 2.5,
      }),
    ).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
  });

  test('a LYING usage report trips the maxTokens budget verdict instead of bypassing it (#19-3 twin)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'lying usage' },
            calls,
            // The lying SDK shape: a negative input masks real spend — the
            // OLD asNumber folded -200,000 (total −50,000, never `>= cap`)
            // and the budget verdict was bypassed forever.
            usage: {
              input_tokens: -200_000,
              output_tokens: 150_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ prompt: 'lying usage run', budget: { maxTokens: 1000 } }),
      );
      // The tightened fold: the negative field → 0, so the total is 150,000
      // ≥ 1000 — the budget verdict, not a silent bypass.
      expect(result.stopReason).toBe('budget');
      expect(result.usage).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('budget classification uses the TRUE total — thinking tokens are not added on top of output', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // The mock's result usage totals 152 (120+12+15+5) and its modelUsage
      // reports thinkingTokens: 2. With the old double-count (152 + 2 = 154)
      // a cap of 153 would misclassify 'budget'; the true total is below it.
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const below = await driver.run(invocation({ budget: { maxTokens: 153 } }));
      expect(below.stopReason).toBe('complete'); // 152 < 153 — the true total decides
      expect(below.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(below.usage.reasoning).toBeUndefined();
      const at = await driver.run(invocation({ budget: { maxTokens: 152 } }));
      expect(at.stopReason).toBe('budget'); // 152 >= 152 — the boundary still trips on the true total
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('pure helpers: allowedToolNames and sandboxOption', () => {
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [], mode: 'none' })).toEqual([]);
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [] })).toEqual([]); // default reading: allowlist
    expect(
      allowedToolNames(['read', 'edit', 'run'], { allow: ['run'], mode: 'allowlist' }),
    ).toEqual(['run']);
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [], mode: 'unrestricted' })).toEqual([
      'read',
      'edit',
      'run',
    ]);
    expect(sandboxOption('none')).toBeUndefined();
    expect(sandboxOption('workspace-write')).toEqual({ enabled: true, failIfUnavailable: false });
    expect(sandboxOption('read-only')).toEqual({ enabled: true, failIfUnavailable: false });
  });
});
