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
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import type { AiSdkDriverOptions } from '../../src/driver/ai-sdk/index.js';
import {
  serializeRequestForCounting,
  type StrictTokenCapability,
  type WireReservation,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  buildCountedProjection,
  canonicalProjectionDigest,
} from '../../src/driver/ai-sdk/canonical-projection.js';
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
  replies: readonly LanguageModelV4GenerateResult[],
  options: { strict: boolean },
): Promise<Fixture & { cleanup: () => Promise<void> }> {
  const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-json-'));
  const wire: LanguageModelV4CallOptions[] = [];
  const receipts: WireReservation[] = [];
  let served = 0;
  const model = new MockLanguageModelV4({
    modelId: 'claude-test',
    doGenerate: async (params) => {
      wire.push(params);
      const reply = replies[Math.min(served, replies.length - 1)] ?? textResult('');
      served += 1;
      return reply;
    },
  });
  const strictOptions: Partial<AiSdkDriverOptions> = options.strict
    ? {
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: (receipt) => {
          receipts.push(receipt);
        },
      }
    : {};
  const driver = new AiSdkDriver({
    providers: { anthropic: () => model },
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
