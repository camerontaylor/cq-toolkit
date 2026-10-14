// Offline composition tests: the C2 GLM text-only capability composed with the
// composed CRQ per-wire adapter.
//
// Fakes only: a MockLanguageModelV4 counting dispatches, an in-memory transport and
// the real (pure) GLM capability. Nothing here opens a socket, spawns a process,
// reads a credential or reaches a provider.
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import {
  GLM_TEXT_PROFILE,
  UnboundedGlmRequestShape,
  createGlmTextCapability,
  renderGlmTextPrompt,
  type GlmCapabilityInput,
  type GlmHostedTransformAttestation,
} from '../../src/driver/ai-sdk/glm-capability.js';
import { createCrqWireAdapter } from '../../src/driver/ai-sdk/crq-wire-adapter.js';
import {
  CrqWireRefusal,
  type CrqWireAck,
  type CrqWireIdentity,
  type CrqWireOutcomeReply,
  type CrqWireTransport,
} from '../../src/driver/ai-sdk/crq-wire-wrapper.js';
import {
  CANONICAL_PROJECTION_PROTOCOL,
  canonicalProjectionBytes,
  canonicalProjectionDigestOf,
  buildCountedProjection,
} from '../../src/driver/ai-sdk/canonical-projection.js';
import type { WireReservation } from '../../src/driver/ai-sdk/pre-request-ceiling.js';

/** The minimal V4 call options both composed lanes accept. */
const PROMPT_CALL = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }] };

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

const IDENTITY: CrqWireIdentity = {
  job: 'crq-run-20261014T120000Z-F1',
  sourceSha: 'a'.repeat(40),
  findingSha256: 'b'.repeat(64),
  authorizationSha256: 'c'.repeat(64),
  role: 'fixer',
  rung: 0,
  window: 'default',
};

/** The counted projection the strict lane would serialize for one request. */
function projectionWith(responseFormat: unknown): unknown {
  return buildCountedProjection({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'fix the finding' }] }],
    tools: null,
    toolChoice: null,
    responseFormat,
    providerOptions: null,
    maxOutputTokens: 4000,
  });
}

function receiptFor(projection: unknown, reserveOutputTokens = 4000): WireReservation {
  const bytes = canonicalProjectionBytes(projection);
  return {
    tokens: 10,
    cumulativeTokens: 10,
    countedInput: 10,
    reserveOutputTokens,
    provider: 'zai',
    model: 'glm-5.3-flash',
    canonicalProjectionProtocol: CANONICAL_PROJECTION_PROTOCOL,
    canonicalProjectionBytesHex: bytes.toString('hex'),
    canonicalProjectionDigest: canonicalProjectionDigestOf(bytes),
  };
}

class FakeTransport implements CrqWireTransport {
  public attest = true;
  public hellos = 0;
  public reserved = 0;
  public lastReserve: Readonly<Record<string, unknown>> | null = null;

  async attestHost(): Promise<boolean> {
    return this.attest;
  }

  async hello(): Promise<{ sessionId: string; attemptRef: number; remainingMilliseconds: number }> {
    this.hellos += 1;
    return { sessionId: `session-${String(this.hellos)}`, attemptRef: this.hellos, remainingMilliseconds: 600_000 };
  }

  async reserve(message: Readonly<Record<string, unknown>>): Promise<CrqWireAck | { refused: string }> {
    this.reserved += 1;
    this.lastReserve = message;
    return {
      method: 'reserved',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      ackSequence: this.reserved,
      reservationSequence: this.reserved,
      requestSha256: 'e'.repeat(64),
      inputTokens: 10,
      reservedOutputTokens: 4000,
      totalTokens: 4010,
      cumulativeTokens: this.reserved * 4010,
      remainingTokens: 100_000 - this.reserved * 4010,
      remainingMilliseconds: 590_000,
      attemptRef: Number(message['attempt_ref']),
      wireOrdinal: String(message['wire_ordinal']),
    };
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<CrqWireOutcomeReply> {
    return {
      stopped: null,
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      attemptRef: Number(message['attempt_ref']),
      ackSequence: Number(message['ack_sequence']),
    };
  }
}

/** A model whose every ACTUAL dispatch is counted; the mock never throws. */
function countingModel(counter: { fetches: number }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'glm-5.3-flash',
    doGenerate: async () => {
      counter.fetches += 1;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

describe('composed strict lane + GLM text-only capability', () => {
  it('composes the real GLM capability with the CRQ adapter without an index', async () => {
    const capability = createGlmTextCapability(GLM_INPUT, GLM_ATTESTATION);
    expect(capability).toBeDefined();
    const adapter = createCrqWireAdapter({ identity: IDENTITY, provider: 'zai', model: 'glm-5.3-flash' });
    const transport = new FakeTransport();
    const composed = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });

    // The capability is the counting authority for the SAME projection the adapter
    // reserves: the counted bytes are the exact rendered prompt, not a guess.
    const accepted = projectionWith(null);
    const serialized = JSON.stringify(accepted);
    const rendered = renderGlmTextPrompt(accepted);
    expect(capability?.count(serialized)).toBe(Buffer.byteLength(rendered, 'utf8'));
    expect(capability?.withOutputCeiling(PROMPT_CALL, 64).maxOutputTokens).toBe(64);

    await composed.reserve(receiptFor(accepted));
    expect(transport.reserved).toBe(1);
    expect(transport.lastReserve?.['canonical_projection_digest']).toBe(
      receiptFor(accepted).canonicalProjectionDigest,
    );
    // The adapter without a transport still refuses every wire (fail closed).
    await expect(adapter.reserve(receiptFor(accepted))).rejects.toThrow(CrqWireRefusal);
    expect(transport.reserved).toBe(1);
  });

  it('REFUSES a non-null responseFormat before any dispatch, on both lanes', async () => {
    const capability = createGlmTextCapability(GLM_INPUT, GLM_ATTESTATION);
    const transport = new FakeTransport();
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    const counter = { fetches: 0 };
    const wrapped = adapter.wrapModel(countingModel(counter));

    // Positive control on the SAME composed object: a null responseFormat counts,
    // reserves and dispatches exactly once (so the negative leg is not accept-any).
    const accepted = projectionWith(null);
    expect(capability?.count(JSON.stringify(accepted))).toBeGreaterThan(0);
    await adapter.reserve(receiptFor(accepted));
    await wrapped.doGenerate(PROMPT_CALL);
    expect(counter.fetches).toBe(1);
    expect(transport.reserved).toBe(1);

    // The negative leg: the strict lane's count step runs BEFORE the wire reserve,
    // and a non-null responseFormat makes it refuse (the publisher template renders
    // no schema instruction and NO opaque transform is accepted).
    const refused = projectionWith({ type: 'json', schema: { type: 'object' } });
    expect(() => {
      capability?.count(JSON.stringify(refused));
      void adapter.reserve(receiptFor(refused));
    }).toThrow(UnboundedGlmRequestShape);
    // Nothing was reserved for the refused projection and no fetch happened.
    expect(transport.reserved).toBe(1);
    expect(counter.fetches).toBe(1);
  });

  it('refuses to dispatch with no acknowledged wire at all', async () => {
    const transport = new FakeTransport();
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    const counter = { fetches: 0 };
    const wrapped = adapter.wrapModel(countingModel(counter));
    await expect(wrapped.doGenerate(PROMPT_CALL)).rejects.toThrow(/no acknowledged wire is pending/);
    expect(counter.fetches).toBe(0);
    expect(transport.reserved).toBe(0);
  });

  it('stops the next send after an incomplete usage is reported as unknown', async () => {
    const transport = new FakeTransport();
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    const counter = { fetches: 0 };
    const model = new MockLanguageModelV4({
      modelId: 'glm-5.3-flash',
      doGenerate: async () => {
        counter.fetches += 1;
        return {
          content: [{ type: 'text', text: 'partial' }],
          finishReason: { unified: 'length', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const wrapped = adapter.wrapModel(model);
    await adapter.reserve(receiptFor(projectionWith(null)));
    await wrapped.doGenerate(PROMPT_CALL);
    expect(counter.fetches).toBe(1);
    // An incomplete measurement is NOT acceptance: no repair stage, no new send.
    expect(() => adapter.repairStage.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
    await expect(adapter.reserve(receiptFor(projectionWith(null)))).rejects.toThrow(
      /no accepted outcome/,
    );
    expect(transport.reserved).toBe(1);
  });
});
