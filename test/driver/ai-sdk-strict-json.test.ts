// C7 STRICT-JSON STRATEGY (owner decision, 2026-10-15) — the ai-sdk lane's
// text-only structured output when an invocation opts into
// `Budget.strictTokenBudget`.
//
// WHAT IS PINNED HERE (offline; a mock model and a fake capability, no provider,
// no network, no credentials, no child process):
//   1. the strict lane puts NO hosted structured response on the wire — no
//      `responseFormat` (the SDK's `Output.object` channel is not used at all);
//   2. the JSON Schema + output contract ride the COUNTED prompt text, so they
//      are inside the exact canonical projection the durable reservation bound
//      (the receipt's digest equals the digest of the parameters that were sent);
//   3. a parse or validation failure goes through the EXISTING bounded repair,
//      and that repair is a REAL, separately CHARGED send with its own canonical
//      digest — and there is never a third send;
//   4. nothing is accepted without the SAME shared validator succeeding, even
//      when the reply parses as JSON;
//   5. the non-strict lane is unchanged: `Output.object` still rides
//      `responseFormat`, and the driver adds no contract turn.
//
// AUTHORED, NOT RUN in this lane: execution is centralized on Neptune.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import type {
  AiSdkDriverOptions,
  StrictTokenRepairStage,
  StrictTokenWireAdapter,
} from '../../src/driver/ai-sdk/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import {
  serializeRequestForCounting,
  type StrictTokenCapability,
  type WireReservation,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  buildCountedProjection,
  canonicalProjectionDigest,
} from '../../src/driver/ai-sdk/canonical-projection.js';
import {
  GLM_TEXT_PROFILE,
  UnboundedGlmRequestShape,
  createGlmTextCapability,
  type GlmCapabilityInput,
  type GlmHostedTransformAttestation,
} from '../../src/driver/ai-sdk/glm-capability.js';
import { createCrqWireAdapter } from '../../src/driver/ai-sdk/crq-wire-adapter.js';
import {
  CrqWireRefusal,
  type CrqWireAck,
  type CrqWireIdentity,
  type CrqWireOutcomeKind,
  type CrqWireOutcomeReply,
  type CrqWireTransport,
} from '../../src/driver/ai-sdk/crq-wire-wrapper.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import type { OpInvocation } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// generateText arg capture — a TRANSPARENT spy over the real 'ai' module (the
// same pattern ai-sdk.test.ts uses), so the tests assert what the driver
// actually ASKED the SDK for: in particular that the strict lane passes no
// `output` (which is what would make the SDK put `responseFormat` on the wire).
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({ generateTextArgs: [] as unknown[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (args: Parameters<typeof actual.generateText>[0]) => {
      captured.generateTextArgs.push(args);
      return actual.generateText(args);
    },
  };
});

/** The args of a generateText call counted from the END (0 = most recent). */
function generateTextArgsFromEnd(offsetFromEnd: number): {
  output?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
} {
  const args = captured.generateTextArgs[captured.generateTextArgs.length - 1 - offsetFromEnd];
  if (args === undefined) throw new Error(`no generateText call at offset ${offsetFromEnd}`);
  return args as { output?: unknown; messages?: Array<{ role: string; content: unknown }> };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The contract the strict lane restates in the counted prompt. */
const CONTRACT = z.object({ verdict: z.enum(['pass', 'fail']), note: z.string() });
const OUTPUT_SCHEMA = toOutputSchema('strict-json-contract', CONTRACT);
const SCHEMA_JSON = JSON.stringify(OUTPUT_SCHEMA.schema);

/**
 * The contract text this driver sends (mirrored here so the test pins the
 * counted bytes, not just "something was appended"). The production wording is
 * shared with the repair turn.
 */
function expectedContract(): string {
  return (
    'Reply with ONLY one JSON object — no prose, no code fences — that validates against ' +
    `this JSON Schema (draft 2020-12):\n${SCHEMA_JSON}`
  );
}

/** A trusted test capability: utf8 byte count + applies maxOutputTokens. */
function fakeCapability(): StrictTokenCapability {
  return {
    provenance: 'test:utf8-byte-count',
    count: (serialized) => Buffer.byteLength(serialized, 'utf8'),
    withOutputCeiling: (params, reserveOutputTokens) => ({
      ...params,
      maxOutputTokens: reserveOutputTokens,
    }),
  };
}

function usageOf(input: number, output: number): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function textResult(
  text: string,
  usage: LanguageModelV4GenerateResult['usage'] = usageOf(100, 5),
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage,
    warnings: [],
  };
}

/** A scripted reply: a result, or an error the mock THROWS from that send. */
type ScriptedReply = LanguageModelV4GenerateResult | { readonly throwError: unknown };

function isThrowingReply(reply: ScriptedReply): reply is { readonly throwError: unknown } {
  return 'throwError' in reply;
}

/** A retryable provider error (the SDK's own class; HTTP 503 -> 'transient'). */
function retryableApiError(): APICallError {
  return new APICallError({
    message: 'endpoint hiccup',
    url: 'https://example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
}

interface Fixture {
  readonly driver: AiSdkDriver;
  /** Every set of params the MODEL actually received (one entry per send). */
  readonly wire: LanguageModelV4CallOptions[];
  /** Every durable pre-wire reservation the ceiling took (one per send). */
  readonly receipts: WireReservation[];
}

/**
 * A driver over a scripted mock model. The scripted replies are served in order
 * (the last one repeats, so an UNBOUNDED extra send would be served rather than
 * crashing — the send COUNT is what the tests assert).
 */
async function fixture(
  replies: readonly ScriptedReply[],
  options: {
    strict: boolean;
    stage?: StrictTokenRepairStage;
    /** Installs the adapter INSTEAD of the standalone hook/stage options. */
    adapter?: StrictTokenWireAdapter;
    /** Overrides the injected capability (e.g. to record the ceiling's order). */
    capability?: StrictTokenCapability;
    /** The provider key the mock model is registered under (default anthropic). */
    providerName?: string;
    /** Runs while send `sendIndex` (0-based) is in flight, before it returns. */
    onSend?: (sendIndex: number) => void;
  },
): Promise<Fixture & { cleanup: () => Promise<void> }> {
  const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-json-'));
  const wire: LanguageModelV4CallOptions[] = [];
  const receipts: WireReservation[] = [];
  let served = 0;
  const model = new MockLanguageModelV4({
    modelId: 'claude-test',
    doGenerate: async (params) => {
      wire.push(params);
      options.onSend?.(wire.length - 1);
      const reply = replies[Math.min(served, replies.length - 1)] ?? textResult('');
      served += 1;
      // A scripted THROW is a real send failure: the driver sees it exactly as it
      // sees a provider rejection.
      if (isThrowingReply(reply)) throw reply.throwError;
      return reply;
    },
  });
  // When an adapter is installed the fixture still records the ceiling's receipt
  // stream: it wraps the adapter's OWN reserve (the adapter keeps its own
  // observations), so a leg can assert both sides.
  const providedAdapter = options.adapter;
  const adapter: StrictTokenWireAdapter | undefined =
    providedAdapter === undefined
      ? undefined
      : {
          ...providedAdapter,
          reserve: async (receipt) => {
            receipts.push(receipt);
            await providedAdapter.reserve(receipt);
          },
        };
  const strictOptions: Partial<AiSdkDriverOptions> = options.strict
    ? {
        strictTokenCapability: () => options.capability ?? fakeCapability(),
        ...(adapter !== undefined
          ? { strictTokenWireAdapter: adapter }
          : {
              strictTokenReservationHook: (receipt) => {
                receipts.push(receipt);
              },
              ...(options.stage !== undefined ? { strictTokenRepairStage: options.stage } : {}),
            }),
      }
    : {};
  const driver = new AiSdkDriver({
    providers: { [options.providerName ?? 'anthropic']: () => model },
    sessionsDir: join(scratch, 'sessions'),
    ...strictOptions,
  });
  return { driver, wire, receipts, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'strict json run',
    modelSpec: { provider: 'anthropic', model: 'claude-test' },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
    outputSchema: OUTPUT_SCHEMA,
    ...overrides,
  };
}

/** The params of send `index`, or a loud failure (never a silent undefined). */
function sent(
  wire: readonly LanguageModelV4CallOptions[],
  index: number,
): LanguageModelV4CallOptions {
  const params = wire[index];
  if (params === undefined) throw new Error(`no wire params were captured at index ${index}`);
  return params;
}

function receiptAt(receipts: readonly WireReservation[], index: number): WireReservation {
  const receipt = receipts[index];
  if (receipt === undefined) throw new Error(`no reservation was taken at index ${index}`);
  return receipt;
}

/** The prompt turns the model received. */
function promptTurns(
  params: LanguageModelV4CallOptions,
): Array<{ role: string; content: unknown }> {
  return params.prompt as Array<{ role: string; content: unknown }>;
}

/**
 * The ACTUAL text of a normalized V4 prompt turn, narrowed from `unknown` with
 * runtime checks only — no cast, no `any`, no coercion. The wire shape is an
 * array of exactly one plain object whose `type` is the literal 'text' and whose
 * `text` is a string (the SDK normalizes a composed string turn into content
 * parts). Anything else THROWS rather than degrading the caller's assertion, so
 * a shape drift can never turn into a passing `[object Object]` comparison. The
 * element binding mirrors the shipped `const element: unknown = value[i]` idiom
 * (src/cli/output.ts, src/kernel/runner.ts), which keeps `Array.isArray`'s
 * `any[]` from leaking.
 */
function wireTextOf(turn: { role: string; content: unknown } | undefined): string {
  const content = turn?.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error('expected the normalized turn to carry exactly one content part');
  }
  const part: unknown = content[0];
  if (typeof part !== 'object' || part === null) {
    throw new Error('expected the content part to be an object');
  }
  if (!('type' in part) || part.type !== 'text') {
    throw new Error('expected the content part type to be text');
  }
  if (!('text' in part) || typeof part.text !== 'string') {
    throw new Error('expected the content part to carry a text string');
  }
  return part.text;
}

/**
 * A repair stage that counts its calls and can refuse either of them. Both
 * methods are synchronous and return void, exactly as the driver's contract
 * requires; the stage carries no acknowledgement, sequence or ordinal, because
 * the driver never sees one.
 */
function countingStage(refuse: { enter?: boolean; exit?: boolean } = {}): {
  readonly stage: StrictTokenRepairStage;
  readonly calls: { enter: number; exit: number };
} {
  const calls = { enter: 0, exit: 0 };
  return {
    calls,
    stage: {
      enterRepairStage: () => {
        calls.enter += 1;
        if (refuse.enter === true) throw new Error('the prior wire acknowledgement is not durable');
      },
      exitRepairStage: () => {
        calls.exit += 1;
        if (refuse.exit === true) throw new Error('the repair stage could not be closed');
      },
    },
  };
}

/** A minimal adapter for legs that only exercise wiring or a refusal. */
function adapterOver(over: Partial<StrictTokenWireAdapter> = {}): StrictTokenWireAdapter {
  return {
    reserve: () => Promise.resolve(),
    repairStage: { enterRepairStage: () => {}, exitRepairStage: () => {} },
    wrapModel: (model) => model,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The strict lane emits no hosted structured response
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: the wire carries no hosted structured output', () => {
  test('no responseFormat, and the schema rides the counted prompt inside the bound canonical projection', async () => {
    const fx = await fixture([textResult(JSON.stringify({ verdict: 'pass', note: 'ok' }))], {
      strict: true,
    });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'ok' });
      expect(fx.wire).toHaveLength(1);

      const params = sent(fx.wire, 0);
      // (1) The hosted structured-output channel is NOT used: the SDK's
      // `Output.object` is what would put a json schema on `responseFormat`.
      expect(params.responseFormat).toBeUndefined();
      // ... and the driver never even ASKED for it: the call carried no
      // `output`, and its last message is the restated contract. This layer is
      // the driver's OWN args, so the content is the raw string it composed.
      const mainArgs = generateTextArgsFromEnd(0);
      expect(mainArgs.output).toBeUndefined();
      const mainTurns = mainArgs.messages ?? [];
      expect(mainTurns[mainTurns.length - 1]?.content).toBe(expectedContract());

      // (2) The contract + schema are the LAST counted prompt turn. On the WIRE
      // the SDK has normalized a user turn's string content into V4 content
      // PARTS, so the exact part shape, its exact types and the exact text bytes
      // are asserted with toEqual (no String() coercion, no cast), and the
      // schema bytes are then asserted against the ACTUAL wire text the helper
      // narrows out of that value.
      const turns = promptTurns(params);
      const last = turns[turns.length - 1];
      expect(last?.role).toBe('user');
      expect(last?.content).toEqual([{ type: 'text', text: expectedContract() }]);
      expect(wireTextOf(last)).toContain(SCHEMA_JSON);

      // (3) The byte ceiling measured that text: the counted serialization
      // carries the JSON-escaped schema bytes the capability was handed.
      const counted = serializeRequestForCounting(params);
      expect(counted).toContain(JSON.stringify(expectedContract()).slice(1, -1));

      // (4) And the schema is inside the EXACT canonical snapshot the durable
      // reservation bound: the receipt's digest is the digest of these params,
      // so a host that re-decodes the receipt's bytes sees the schema too.
      const receipt = receiptAt(fx.receipts, 0);
      expect(fx.receipts).toHaveLength(1);
      expect(receipt.canonicalProjectionProtocol).toBe('crq/request-projection/v1');
      expect(receipt.canonicalProjectionDigest).toBe(
        canonicalProjectionDigest(buildCountedProjection(params)),
      );
    } finally {
      await fx.cleanup();
    }
  });

  test('a plain reply with no JSON at all is refused, never accepted', async () => {
    const replies = [textResult('I could not produce anything.'), textResult('still prose')];
    const fx = await fixture(replies, { strict: true });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The repair: charged, bounded, and the ONLY retry
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: the repair is one extra CHARGED send', () => {
  test('a malformed reply is repaired by exactly ONE further send, both charged with their own digest', async () => {
    const replies = [
      textResult('Sorry, here is prose instead of JSON.', usageOf(100, 5)),
      textResult(JSON.stringify({ verdict: 'fail', note: 'repaired' }), usageOf(40, 7)),
    ];
    const fx = await fixture(replies, { strict: true });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'fail', note: 'repaired' });

      // BOUNDED: one repair, and no third send even though the run completed.
      expect(fx.wire).toHaveLength(2);
      // Each send is its own durable reservation (the host assigns the
      // monotonic sequence; the driver exposes no sequence of its own).
      expect(fx.receipts).toHaveLength(2);
      expect(receiptAt(fx.receipts, 1).canonicalProjectionDigest).not.toBe(
        receiptAt(fx.receipts, 0).canonicalProjectionDigest,
      );
      expect(receiptAt(fx.receipts, 0).canonicalProjectionDigest).toBe(
        canonicalProjectionDigest(buildCountedProjection(sent(fx.wire, 0))),
      );
      expect(receiptAt(fx.receipts, 1).canonicalProjectionDigest).toBe(
        canonicalProjectionDigest(buildCountedProjection(sent(fx.wire, 1))),
      );
      // The repair is text-only too: no hosted structured response on it either.
      expect(sent(fx.wire, 1).responseFormat).toBeUndefined();
      // Both sends asked the SDK for NO structured output (offset 1 = the main
      // call, offset 0 = the repair).
      expect(generateTextArgsFromEnd(1).output).toBeUndefined();
      expect(generateTextArgsFromEnd(0).output).toBeUndefined();
      // ... and its prompt restates the SAME contract, on the WIRE as ONE
      // normalized text part whose bytes are the established repair wording plus
      // the contract (exact shape, exact types, exact bytes; no coercion).
      const expectedRepairText =
        `Your previous reply did not satisfy the required JSON contract. ` + expectedContract();
      const repairTurns = promptTurns(sent(fx.wire, 1));
      const repairLast = repairTurns[repairTurns.length - 1];
      expect(repairLast?.role).toBe('user');
      expect(repairLast?.content).toEqual([{ type: 'text', text: expectedRepairText }]);
      expect(wireTextOf(repairLast)).toBe(expectedRepairText);

      // USAGE KEEPS BOTH CALLS: 100 + 40 in, 5 + 7 out.
      expect(result.usage.input).toBe(140);
      expect(result.usage.output).toBe(12);
    } finally {
      await fx.cleanup();
    }
  });

  test('a repair that is ALSO malformed settles output-invalid after exactly two sends', async () => {
    const replies = [textResult('nope'), textResult('{ not still json')];
    const fx = await fixture(replies, { strict: true });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.error).toContain('structured output invalid after the repair attempt');
      expect(fx.wire).toHaveLength(2);
      expect(fx.receipts).toHaveLength(2);
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Validation gates acceptance — parsing is not enough
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: nothing is accepted before the shared validator succeeds', () => {
  test('a parseable reply that violates the schema is never accepted as the result', async () => {
    const invalid = JSON.stringify({ verdict: 'maybe', note: 'not an enum member' });
    const fx = await fixture([textResult(invalid), textResult(invalid)], { strict: true });
    try {
      const result = await fx.driver.run(invocation());
      // The payload parsed, but the schema judgment refused it — and the repair
      // (a second charged send) was attempted before giving up.
      expect(fx.wire).toHaveLength(2);
      expect(result.structuredOutput).toBeUndefined();
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
    } finally {
      await fx.cleanup();
    }
  });

  test('a parseable reply whose repair satisfies the schema IS accepted, with the validated value', async () => {
    const replies = [
      textResult(JSON.stringify({ verdict: 'maybe', note: 'bad enum' })),
      textResult(JSON.stringify({ verdict: 'pass', note: 'good' })),
    ];
    const fx = await fixture(replies, { strict: true });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'good' });
      expect(fx.wire).toHaveLength(2);
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The non-strict lane is unchanged
// ---------------------------------------------------------------------------

describe('non-strict lanes keep the SDK structured-output path', () => {
  test('Output.object still rides responseFormat and no contract turn is added', async () => {
    const fx = await fixture([textResult(JSON.stringify({ verdict: 'pass', note: 'ok' }))], {
      strict: false,
    });
    try {
      const result = await fx.driver.run(
        invocation({
          // No strict-budget opt-in: the legacy structured-output path.
          budget: {},
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'ok' });
      expect(fx.wire).toHaveLength(1);
      const params = sent(fx.wire, 0);
      // The hosted structured-output channel is still used (the SDK derived it
      // from `Output.object`), and no strict contract turn was appended.
      expect(generateTextArgsFromEnd(0).output).toBeDefined();
      expect(params.responseFormat).toBeDefined();
      expect(JSON.stringify(promptTurns(params))).not.toContain('Reply with ONLY one JSON object');
      // No strict capability was injected, so no ceiling took a reservation.
      expect(fx.receipts).toHaveLength(0);
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The repair-stage lifecycle: wrapper-owned, the driver only opens/closes it
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: the repair-stage lifecycle', () => {
  test('a refused enterRepairStage sends nothing further, reserves nothing and never exits', async () => {
    const { stage, calls } = countingStage({ enter: true });
    const replies = [
      textResult('prose, not JSON'),
      textResult(JSON.stringify({ verdict: 'pass', note: 'never sent' })),
    ];
    const fx = await fixture(replies, { strict: true, stage });
    try {
      const result = await fx.driver.run(invocation());
      expect(calls.enter).toBe(1);
      // The stage never opened, so it is never closed.
      expect(calls.exit).toBe(0);
      // No second send and no second reservation: the repair was refused first.
      expect(fx.wire).toHaveLength(1);
      expect(fx.receipts).toHaveLength(1);
      // A refusal is a non-success verdict and is NOT reported as a model outcome.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).not.toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      // No repair send happened, so the verdict carries the MAIN call's measured
      // usage only (the fixture's 100/5) — no repair spend is invented.
      expect(result.usage.input).toBe(100);
      expect(result.usage.output).toBe(5);
    } finally {
      await fx.cleanup();
    }
  });

  test('a refused exitRepairStage accepts no result even though the repair validated', async () => {
    const { stage, calls } = countingStage({ exit: true });
    const validReply = JSON.stringify({ verdict: 'pass', note: 'validated but not accepted' });
    const replies = [
      textResult('prose, not JSON', usageOf(100, 5)),
      textResult(validReply, usageOf(40, 7)),
    ];
    const fx = await fixture(replies, { strict: true, stage });
    try {
      const result = await fx.driver.run(invocation());
      expect(calls.enter).toBe(1);
      expect(calls.exit).toBe(1);
      // The repair WAS sent and charged; the close refusal still denies the result.
      expect(fx.wire).toHaveLength(2);
      expect(fx.receipts).toHaveLength(2);
      expect(result.structuredOutput).toBeUndefined();
      expect(result.stopReason).toBe('error');
      // The verdict still aggregates BOTH calls — the main response (100/5) plus
      // the MEASURED repair response (40/7). A paid response is never reported as
      // main-only usage, and the numbers are never invented.
      expect(result.usage.input).toBe(140);
      expect(result.usage.output).toBe(12);
    } finally {
      await fx.cleanup();
    }
  });

  test('an abort during the repair closes the stage exactly once and settles aborted', async () => {
    const controller = new AbortController();
    const { stage, calls } = countingStage();
    const replies = [
      textResult('prose, not JSON'),
      textResult(JSON.stringify({ verdict: 'pass', note: 'arrived after the abort' })),
    ];
    const fx = await fixture(replies, {
      strict: true,
      stage,
      // Abort WHILE the repair send is in flight: the mock still returns, so the
      // driver observes the live signal on the resolve path.
      onSend: (sendIndex) => {
        if (sendIndex === 1) controller.abort();
      },
    });
    try {
      const result = await fx.driver.run(invocation(), { signal: controller.signal });
      expect(calls.enter).toBe(1);
      expect(calls.exit).toBe(1);
      expect(fx.wire).toHaveLength(2);
      expect(result.stopReason).toBe('aborted');
      // A governed abort never accepts a payload.
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  });

  test('a successful repair enters and exits the stage exactly once', async () => {
    const { stage, calls } = countingStage();
    const replies = [
      textResult('prose, not JSON'),
      textResult(JSON.stringify({ verdict: 'pass', note: 'repaired' })),
    ];
    const fx = await fixture(replies, { strict: true, stage });
    try {
      const result = await fx.driver.run(invocation());
      expect(calls).toEqual({ enter: 1, exit: 1 });
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'repaired' });
      expect(fx.wire).toHaveLength(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('a run that needs no repair never opens the stage', async () => {
    const { stage, calls } = countingStage();
    const replies = [textResult(JSON.stringify({ verdict: 'pass', note: 'first try' }))];
    const fx = await fixture(replies, { strict: true, stage });
    try {
      const result = await fx.driver.run(invocation());
      expect(calls).toEqual({ enter: 0, exit: 0 });
      expect(result.stopReason).toBe('complete');
      expect(fx.wire).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('a coincident send failure and close refusal keep BOTH causes, classified by the send', async () => {
    const { stage, calls } = countingStage({ exit: true });
    const replies: ScriptedReply[] = [
      textResult('prose, not JSON', usageOf(100, 5)),
      { throwError: retryableApiError() },
    ];
    const fx = await fixture(replies, { strict: true, stage });
    try {
      const result = await fx.driver.run(invocation());
      // The stage opened and closed exactly once; the repair WAS sent and charged,
      // and then the send failed.
      expect(calls).toEqual({ enter: 1, exit: 1 });
      expect(fx.wire).toHaveLength(2);
      expect(fx.receipts).toHaveLength(2);
      // No payload, and the CLASSIFICATION is the SEND error's (HTTP 503 ->
      // 'transient') — never the close refusal's ('unknown').
      expect(result.structuredOutput).toBeUndefined();
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('transient');
      // BOTH failures are visible in the persisted bounded text.
      expect(result.error).toContain('endpoint hiccup');
      expect(result.error).toContain('the repair stage close also refused');
      expect(result.error).toContain('the repair stage could not be closed');
      // The fold is main + OBSERVED repair usage: the thrown send completed no
      // step, so nothing is invented for it.
      expect(result.usage.input).toBe(100);
      expect(result.usage.output).toBe(5);
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The strict wire adapter: one cohesive seam, composed INNER to the ceiling
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: the strict wire adapter', () => {
  test('an adapter supplies the reservation, the stage and the INNER model wrap', async () => {
    const events: string[] = [];
    const adapterReceipts: WireReservation[] = [];
    const stageCalls = { enter: 0, exit: 0 };
    const capability: StrictTokenCapability = {
      provenance: 'test:order-probe',
      count: (serialized) => {
        events.push('ceiling-count');
        return Buffer.byteLength(serialized, 'utf8');
      },
      withOutputCeiling: (params, reserveOutputTokens) => ({
        ...params,
        maxOutputTokens: reserveOutputTokens,
      }),
    };
    const adapter = adapterOver({
      reserve: (receipt) => {
        events.push('adapter-reserve');
        adapterReceipts.push(receipt);
        return Promise.resolve();
      },
      repairStage: {
        enterRepairStage: () => {
          stageCalls.enter += 1;
        },
        exitRepairStage: () => {
          stageCalls.exit += 1;
        },
      },
      wrapModel: (inner) => {
        // The lane hands a RESOLVED model, never a gateway id string — the same
        // refusal the driver's own ceiling wrap applies. Narrow, never cast.
        if (typeof inner === 'string') {
          throw new Error('the adapter received a gateway model id, not a resolved model');
        }
        return wrapLanguageModel({
          model: inner,
          middleware: {
            // `transformParams` is a PromiseLike contract (the C1 fix pattern):
            // the callback is async and returns the params unchanged.
            transformParams: async ({ params }) => {
              events.push('adapter-wire');
              return params;
            },
          },
        });
      },
    });
    const replies = [
      textResult('prose, not JSON'),
      textResult(JSON.stringify({ verdict: 'pass', note: 'repaired' })),
    ];
    const fx = await fixture(replies, { strict: true, adapter, capability });
    try {
      const result = await fx.driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'repaired' });
      // The adapter's OWN reserve and stage drove the run: two sends, two
      // reservations, one stage open/close pair.
      expect(adapterReceipts).toHaveLength(2);
      expect(stageCalls).toEqual({ enter: 1, exit: 1 });
      expect(fx.receipts).toHaveLength(2);
      // The wrap is INNER: for the first send the ceiling counts and reserves
      // BEFORE the adapter's wire middleware sees the call, so the adapter can
      // never observe a ceiling refusal or a refused no-send.
      expect(events.slice(0, 3)).toEqual(['ceiling-count', 'adapter-reserve', 'adapter-wire']);
    } finally {
      await fx.cleanup();
    }
  });

  test('an adapter with no strict budget refuses before the provider factory runs', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-adapter-off-'));
    try {
      let providerCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () => {
            providerCalls += 1;
            return new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: textResult('ok'),
            });
          },
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenWireAdapter: adapterOver(),
      });
      let caught: unknown;
      try {
        await driver.run(invocation({ budget: {} }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DispatchError);
      expect(errorClassOf(caught)).toBe('config');
      expect((caught as Error).message).toContain('strictTokenWireAdapter is configured');
      // Nothing was dispatched: the provider factory never ran.
      expect(providerCalls).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a divergent adapter pairing refuses at construction; the identical one is accepted', () => {
    const adapter = adapterOver();
    // A DIFFERENT hook function is a divergence: refuse, never silently pick one.
    expect(
      () =>
        new AiSdkDriver({
          strictTokenWireAdapter: adapter,
          strictTokenReservationHook: () => {},
        }),
    ).toThrow(/DIFFERENT functions/);
    // A DIFFERENT stage object is a divergence too.
    expect(
      () =>
        new AiSdkDriver({
          strictTokenWireAdapter: adapter,
          strictTokenRepairStage: { enterRepairStage: () => {}, exitRepairStage: () => {} },
        }),
    ).toThrow(/DIFFERENT objects/);
    // The IDENTICAL function and object ARE the same seam: accepted.
    expect(
      () =>
        new AiSdkDriver({
          strictTokenWireAdapter: adapter,
          strictTokenReservationHook: adapter.reserve,
          strictTokenRepairStage: adapter.repairStage,
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. The C2 GLM text-only capability composed ON THE DRIVER PATH
//
// The runner asked for the strict lane composed with the injected capability and
// a non-null responseFormat pinned through the DRIVER, not only the module. The
// REAL GLM profile is the injected capability here, so the run proves the driver's
// own counted pipeline document is exactly what that profile accepts, and the
// negative leg injects a hosted responseFormat (what `Output.object` would put on
// the wire) into the SAME counted document. Nothing is smuggled: the driver never
// emits `responseFormat`, and no arbitrary params ride outside the counted
// projection.
// ---------------------------------------------------------------------------

describe('strict-JSON strategy: the GLM text-only capability on the driver path', () => {
  const GLM_INPUT: GlmCapabilityInput = {
    provider: 'zai',
    model: 'glm-5.3-flash',
    endpoint: 'https://api.z.ai/api/coding/paas/v4',
  };
  const GLM_ATTESTATION: GlmHostedTransformAttestation = {
    provider: 'zai',
    model: 'glm-5.3-flash',
    endpoint: 'https://api.z.ai/api/coding/paas/v4',
    hostedBuild: 'zai-coding-paas-v4-build-2026-10',
    templateRevision: GLM_TEXT_PROFILE.publisherTemplate.revision,
    tokenizerRevision: GLM_TEXT_PROFILE.publisherTokenizerRevision,
    reasoningInclusiveMaxTokens: true,
    noUnreservedHiddenGeneration: true,
    provenance: 'offline test attestation',
  };

  test('the REAL GLM profile counts the driver counted projection and refuses a hosted responseFormat', async () => {
    const glm = createGlmTextCapability(GLM_INPUT, GLM_ATTESTATION);
    expect(glm).toBeDefined();
    if (glm === undefined) throw new Error('expected the GLM capability to be present');
    const counted: string[] = [];
    const capability: StrictTokenCapability = {
      provenance: glm.provenance,
      // The REAL profile stays the counting authority; this only records the
      // EXACT document the ceiling handed it.
      count: (serialized) => {
        counted.push(serialized);
        return glm.count(serialized);
      },
      withOutputCeiling: (params, reserve) => glm.withOutputCeiling(params, reserve),
    };
    const fx = await fixture([textResult(JSON.stringify({ verdict: 'pass', note: 'ok' }))], {
      strict: true,
      providerName: 'zai',
      capability,
    });
    try {
      const result = await fx.driver.run(
        invocation({ modelSpec: { provider: 'zai', model: 'glm-5.3-flash' } }),
      );
      // The real profile ACCEPTED the lane's own counted document, so the run
      // really rode the GLM text-only bound (this is not an accept-any stub).
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ verdict: 'pass', note: 'ok' });
      expect(counted.length).toBeGreaterThan(0);

      // The wire carries no hosted structured response.
      const params = sent(fx.wire, 0);
      expect(params.responseFormat).toBeUndefined();

      const document = counted[0] ?? '';
      expect(document).not.toBe('');
      const projection = JSON.parse(document) as Record<string, unknown>;
      // The counted projection's responseFormat is null: the schema rides the
      // counted prompt text, so there is no field to smuggle past the bound.
      expect(projection['responseFormat']).toBeNull();
      // ... and the SAME document is accepted when re-counted (base is proven).
      expect(glm.count(document)).toBeGreaterThan(0);

      // The negative leg on the driver's OWN document: injecting a non-null
      // responseFormat (what the SDK's `Output.object` would put on the wire) is
      // refused by the real profile before any dispatch could count it.
      const withFormat = {
        ...projection,
        responseFormat: { type: 'json', schema: { type: 'object' } },
      };
      expect(() => glm.count(JSON.stringify(withFormat))).toThrow(UnboundedGlmRequestShape);
      // The refusal is the profile's OWN refusal, not a missing-field accident:
      // the unmodified document still counts.
      expect(() =>
        glm.count(JSON.stringify({ ...projection, responseFormat: null })),
      ).not.toThrow();
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The host's terminal stop on the DRIVER path
//
// The adapter's outcome reply may carry a non-null `stopped` (an over-bound or
// missing-usage incident) while the frame's kind was `completed`. The DRIVER must
// not settle such an attempt as `complete`, and the payload must not be accepted.
// ---------------------------------------------------------------------------

const DRIVER_IDENTITY: CrqWireIdentity = {
  job: 'crq-run-20261014T120000Z-F1',
  sourceSha: 'a'.repeat(40),
  findingSha256: 'b'.repeat(64),
  authorizationSha256: 'c'.repeat(64),
  role: 'fixer',
  rung: 0,
  window: 'default',
};

/** A genuine runtime guard: the fixture never casts the sent envelope. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A transport whose outcome reply reports the host's terminal stop. */
class StoppingTransport implements CrqWireTransport {
  public outcomes = 0;
  private acks = 0;

  async attestHost(): Promise<boolean> {
    return true;
  }

  async hello(): Promise<{ sessionId: string; attemptRef: number; remainingMilliseconds: number }> {
    return { sessionId: 'stop-session', attemptRef: 3, remainingMilliseconds: 600_000 };
  }

  async reserve(
    message: Readonly<Record<string, unknown>>,
  ): Promise<CrqWireAck | { refused: string }> {
    const envelope = message['envelope'];
    if (!isRecord(envelope)) {
      throw new CrqWireRefusal('the fixture requires an envelope object');
    }
    const digest = envelope['digest'];
    if (typeof digest !== 'string' || digest.length === 0) {
      throw new CrqWireRefusal('the fixture requires an envelope digest');
    }
    this.acks += 1;
    return {
      method: 'reserved',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      ackSequence: this.acks,
      reservationSequence: this.acks,
      requestSha256: digest,
      inputTokens: 10,
      reservedOutputTokens: 4000,
      totalTokens: 4010,
      cumulativeTokens: 4010,
      remainingTokens: 100_000,
      remainingMilliseconds: 590_000,
      attemptRef: Number(message['attempt_ref']),
      wireOrdinal: `host-ordinal-${String(this.acks)}`,
    };
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<CrqWireOutcomeReply> {
    this.outcomes += 1;
    const kind = message['outcome'];
    if (kind !== 'completed' && kind !== 'refused' && kind !== 'unknown') {
      throw new CrqWireRefusal('the fixture requires a reported outcome kind');
    }
    const echoed: CrqWireOutcomeKind = kind;
    return {
      method: 'outcome',
      outcome: echoed,
      stopped: 'stop_over_bound',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      attemptRef: Number(message['attempt_ref']),
      ackSequence: Number(message['ack_sequence']),
    };
  }
}

describe('strict-JSON strategy: the host stop on the driver path', () => {
  test('a host-stopped completed wire never settles the run as complete', async () => {
    const transport = new StoppingTransport();
    const adapter = createCrqWireAdapter({
      identity: DRIVER_IDENTITY,
      provider: 'anthropic',
      model: 'claude-test',
      transport,
    });
    const fx = await fixture([textResult(JSON.stringify({ verdict: 'pass', note: 'ok' }))], {
      strict: true,
      adapter,
      capability: fakeCapability(),
    });
    try {
      const result = await fx.driver.run(invocation());
      // The host's terminal stop reached the caller: the run is NOT complete and no
      // payload was accepted, while the single wire was reported exactly once.
      expect(result.stopReason).not.toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(transport.outcomes).toBe(1);
      expect(fx.wire).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });
});
