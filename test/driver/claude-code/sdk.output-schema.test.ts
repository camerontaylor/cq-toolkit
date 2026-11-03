// Seam v2 §2.3 (S3) — invocation outputSchema and the uniform
// output-invalid verdict: the schema rides outputFormat and a validated
// payload completes, a miss settles error/output-invalid with its usage
// kept, budget and abort carve-outs keep their own verdicts, an
// uncompilable schema is a LOCAL pre-contact verdict, and I8 precedence
// keeps an already-aborted signal on top.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import {
  AGENT_USAGE,
  ANSWER_OUTPUT_SCHEMA,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  driverWithCalls,
  invocation,
  mockSdkModule,
  optionsOf,
  streamDriver,
} from './sdk.helpers.js';
import type { MockQueryCall } from './sdk.helpers.js';

// ---------------------------------------------------------------------------
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the §2.2 classifier rows, and providerSignals
// ---------------------------------------------------------------------------

describe('claude-code sdk transport seam v2 §2.3 (S3): invocation outputSchema + output-invalid + classifier', () => {
  test('round-trip: an invocation outputSchema rides outputFormat and the validated payload completes', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"ok"}' }, calls }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // PRODUCER RULE: no class (and no error) on a non-error verdict.
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      // The transport carries the EXACT invocation document, meta-URI
      // stripped; the same document is what the validator judged over.
      const sent = optionsOf(calls)['outputFormat'] as { schema: Record<string, unknown> };
      expect(sent.schema).toEqual(ANSWER_OUTPUT_SCHEMA.schema);
      expect(sent.schema['$schema']).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('no schema requested: structuredOutput is ABSENT even when the reply is JSON', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: '{"answer":"ok"}' },
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.errorClass).toBeUndefined();
      expect(optionsOf(calls)['outputFormat']).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the native-retry-exhausted subtype settles error/output-invalid, usage kept', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const driver = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          session_id: 'agent-cli-s3',
          usage: AGENT_USAGE,
        },
      ]);
      const result = await driver.run(
        invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA, toolPolicy: { allow: [], mode: 'none' } }),
      );
      // The SDK's native outputFormat retry ran out — the §2.3 miss verdict.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.error).toContain('structured output invalid');
      expect(result.error).toContain('native structured-output retries');
      expect(result.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('carve-outs: a token cap that fires with a schema in force is budget, not a miss; a pre-aborted run is aborted', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      // The mock's success frame carries NO structured_output for a prose
      // reply — a miss — but the token cap fired first: the missing object
      // is the cap's consequence, so the verdict stays budget with NO class.
      const capped = streamDriver(scratchDir, () => [
        {
          type: 'assistant',
          session_id: 'agent-cli-s3',
          message: {
            model: 'conformance-1',
            content: [{ type: 'text', text: 'prose' }],
            usage: AGENT_USAGE,
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'agent-cli-s3',
          result: 'prose',
          usage: AGENT_USAGE,
          permission_denials: [],
        },
      ]);
      const cappedResult = await capped.run(
        invocation({
          outputSchema: ANSWER_OUTPUT_SCHEMA,
          toolPolicy: { allow: [], mode: 'none' },
          budget: { maxTokens: 1 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.error).toBeUndefined();
      expect(cappedResult.errorClass).toBeUndefined();
      expect(cappedResult.structuredOutput).toBeUndefined();

      // An already-fired signal never dispatches: 'aborted', no class.
      const dead = new AbortController();
      dead.abort();
      const aborted = streamDriver(scratchDir, () => []);
      const abortedResult = await aborted.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }), {
        signal: dead.signal,
      });
      expect(abortedResult.stopReason).toBe('aborted');
      expect(abortedResult.errorClass).toBeUndefined();
      expect(abortedResult.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a PARSED payload on a budget verdict stays absent (the served-model check judges completes)', async () => {
    // The cap fired AFTER the CLI produced a valid object: the payload is
    // still not a consumable outcome — withServedModelAssertion judges only
    // completes, so a payload riding a budget verdict would bypass the
    // observed-model check (parity with the ai-sdk lane; PR #238 review).
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const capped = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'agent-cli-s3',
          result: 'prose',
          structured_output: { answer: 'ok' },
          usage: AGENT_USAGE,
          permission_denials: [],
        },
      ]);
      const cappedResult = await capped.run(
        invocation({
          outputSchema: ANSWER_OUTPUT_SCHEMA,
          toolPolicy: { allow: [], mode: 'none' },
          budget: { maxTokens: 1 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.structuredOutput).toBeUndefined();
      expect(cappedResult.usage).toBeDefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an uncompilable outputSchema is the LOCAL output-invalid verdict before any agent contact (PR #238 review round 2)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-preflight-'));
    try {
      let consulted = false;
      const driver = streamDriver(scratchDir, () => {
        consulted = true;
        return [];
      });
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
          toolPolicy: { allow: [], mode: 'none' },
        }),
      );
      // The uniform schema-miss verdict, compiled locally — the same shape
      // the settle-time miss flow produces, never a provider/harness
      // failure from a request-setup rejection. The SDK was never entered
      // and no session state exists.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.error).toContain('test.broken/v1');
      expect(result.error).toContain('could not be compiled');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(consulted).toBe(false); // the agent SDK never ran
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('I8 precedence: an already-aborted signal outranks an uncompilable outputSchema (PR #241)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-i8-'));
    try {
      let consulted = false;
      const driver = streamDriver(scratchDir, () => {
        consulted = true;
        return [];
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
          toolPolicy: { allow: [], mode: 'none' },
        }),
        { signal: controller.signal },
      );
      // The governed cancellation outranks the schema fault: the run settles
      // the plain abort verdict, never the LOCAL output-invalid one.
      expect(result.stopReason).toBe('aborted');
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(consulted).toBe(false); // the agent SDK never ran
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
