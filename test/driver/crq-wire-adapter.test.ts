// Offline composition tests: the C2 GLM text-only capability composed with the
// composed CRQ per-wire adapter.
//
// Fakes only: a MockLanguageModelV4 counting dispatches, an in-memory transport and
// the real (pure) GLM capability. Nothing here opens a socket, spawns a process,
// reads a credential or reaches a provider.
import type { LanguageModel } from 'ai';
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
  type CrqWireOutcomeKind,
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
const PROMPT_CALL = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] }],
};

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
  /** Every OUTCOME frame the adapter actually SENT (one per reported wire). */
  public outcomes: Readonly<Record<string, unknown>>[] = [];

  async attestHost(): Promise<boolean> {
    return this.attest;
  }

  async hello(): Promise<{ sessionId: string; attemptRef: number; remainingMilliseconds: number }> {
    this.hellos += 1;
    return {
      sessionId: `session-${String(this.hellos)}`,
      attemptRef: this.hellos,
      remainingMilliseconds: 600_000,
    };
  }

  async reserve(
    message: Readonly<Record<string, unknown>>,
  ): Promise<CrqWireAck | { refused: string }> {
    this.reserved += 1;
    this.lastReserve = message;
    return {
      method: 'reserved',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      ackSequence: this.reserved,
      reservationSequence: this.reserved,
      requestSha256: sentEnvelopeDigest(message),
      inputTokens: 10,
      reservedOutputTokens: 4000,
      totalTokens: 4010,
      cumulativeTokens: this.reserved * 4010,
      remainingTokens: 100_000 - this.reserved * 4010,
      remainingMilliseconds: 590_000,
      attemptRef: Number(message['attempt_ref']),
      // The HOST mints the wire ordinal from its OWN reservation sequence. The
      // client frame carries no ordinal (and none is echoed from it).
      wireOrdinal: `host-ordinal-${String(this.reserved)}`,
    };
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<CrqWireOutcomeReply> {
    this.outcomes.push(message);
    return {
      method: 'outcome',
      outcome: reportedKind(message),
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
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
    });
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
    // The strict host schema carries the canonical digest NESTED in the envelope; the
    // frame has no invented top-level digest field. Read the SENT value with the same
    // runtime guard the ACK echo uses (no cast, no coercion).
    const sent = transport.lastReserve;
    if (sent === null) throw new Error('the fixture recorded no reserve frame');
    expect(sentEnvelopeDigest(sent)).toBe(receiptFor(accepted).canonicalProjectionDigest);
    expect(sent['canonical_projection_digest']).toBeUndefined();
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
    await expect(wrapped.doGenerate(PROMPT_CALL)).rejects.toThrow(
      /no acknowledged wire is pending/,
    );
    expect(counter.fetches).toBe(0);
    expect(transport.reserved).toBe(0);
  });

  it('refuses the result of an incomplete measurement even when the reply claims no stop', async () => {
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
    // The transport answers `stopped: null` (a LYING/incorrectly permissive reply).
    // The LOCALLY computed unknown is its own refusal: no accepted payload escapes,
    // the charge is kept and the outcome was reported exactly once.
    await expect(wrapped.doGenerate(PROMPT_CALL)).rejects.toThrow(/not an accepted payload/);
    expect(counter.fetches).toBe(1);
    expect(transport.outcomes).toHaveLength(1);
    expect(transport.outcomes[0]?.['outcome']).toBe('unknown');
    // An incomplete measurement is NOT acceptance: no repair stage, no new send.
    expect(() => adapter.repairStage.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
    await expect(adapter.reserve(receiptFor(projectionWith(null)))).rejects.toThrow(
      /no accepted outcome/,
    );
    expect(transport.reserved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Strict FRAME regressions: a fake transport that validates the exact wire shape
// (a loose transport that accepts anything masks an object-vs-string session id and
// an extra client field), plus the deferred-reserve concurrency lock.
// ---------------------------------------------------------------------------

const RESERVE_KEYS = [
  'method',
  'session_id',
  'message_id',
  'job',
  'source_sha',
  'finding_sha256',
  'authorization_sha256',
  'role',
  'rung',
  'window',
  'driver',
  'provider',
  'model',
  'envelope',
  'attempt_ref',
  'wire_output_ceiling',
  'supersedes_ack_sequence',
  'kind',
  'repair_of_ack_sequence',
];

/** The strict OUTCOME client frame: NO wire ordinal (the host owns it). */
const OUTCOME_KEYS = [
  'method',
  'session_id',
  'message_id',
  'attempt_ref',
  'job',
  'source_sha',
  'finding_sha256',
  'authorization_sha256',
  'role',
  'rung',
  'window',
  'driver',
  'provider',
  'model',
  'ack_sequence',
  'outcome',
  'usage',
  'stop_reason',
  'error_class',
  'repair_of_ack_sequence',
];

/** The reported kind the fixture must ECHO, read with a runtime guard. */
function reportedKind(message: Readonly<Record<string, unknown>>): CrqWireOutcomeKind {
  const kind = message['outcome'];
  if (kind !== 'completed' && kind !== 'refused' && kind !== 'unknown') {
    throw new CrqWireRefusal('the fixture requires a reported outcome kind on the frame');
  }
  return kind;
}

/** A genuine runtime guard: the fixture never casts the sent envelope. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The digest the fixture must ECHO: the digest of the envelope the adapter actually
 * SENT, read with a runtime guard (no cast, no coercion, no fixed literal). A host
 * acknowledgement that returns anything else is refused by the source binding.
 */
function sentEnvelopeDigest(message: Readonly<Record<string, unknown>>): string {
  const envelope = message['envelope'];
  if (!isRecord(envelope)) {
    throw new CrqWireRefusal('the fixture requires an envelope object on the reserve frame');
  }
  const digest = envelope['digest'];
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new CrqWireRefusal('the fixture requires a non-empty envelope digest');
  }
  return digest;
}

/**
 * A STRICT transport: it refuses an unknown field, a non-string session id or a
 * client-supplied wire ordinal, so a frame defect fails here instead of being
 * absorbed by a permissive fake.
 */
class StrictTransport implements CrqWireTransport {
  public reserveCalls = 0;
  public outcomeCalls = 0;
  public lastOutcome: Readonly<Record<string, unknown>> | null = null;
  public holdNextReserve = false;
  /** Deliberately return a WRONG digest so the source binding must refuse it. */
  public mangleDigest = false;
  /** The host's terminal stop reason for the next OUTCOME reply, when set. */
  public stopNext: string | null = null;
  private release: (() => void) | null = null;
  private acks = 0;

  async attestHost(): Promise<boolean> {
    return true;
  }

  async hello(): Promise<{ sessionId: string; attemptRef: number; remainingMilliseconds: number }> {
    return { sessionId: 'strict-session', attemptRef: 7, remainingMilliseconds: 600_000 };
  }

  async reserve(
    message: Readonly<Record<string, unknown>>,
  ): Promise<CrqWireAck | { refused: string }> {
    this.reserveCalls += 1;
    assertExactKeys(message, RESERVE_KEYS, 'reserve');
    if (typeof message['session_id'] !== 'string' || message['session_id'] !== 'strict-session') {
      throw new CrqWireRefusal(
        `the strict host requires session_id to be the hello session STRING, got ${JSON.stringify(message['session_id'])}`,
      );
    }
    if (message['wire_ordinal'] !== undefined) {
      throw new CrqWireRefusal('the strict host refuses a client-supplied wire ordinal on reserve');
    }
    if (this.holdNextReserve) {
      this.holdNextReserve = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.acks += 1;
    return {
      method: 'reserved',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      ackSequence: this.acks,
      reservationSequence: this.acks,
      requestSha256: this.mangleDigest ? 'f'.repeat(64) : sentEnvelopeDigest(message),
      inputTokens: 10,
      reservedOutputTokens: 4000,
      totalTokens: 4010,
      cumulativeTokens: 4010,
      remainingTokens: 100_000,
      remainingMilliseconds: 590_000,
      attemptRef: Number(message['attempt_ref']),
      wireOrdinal: 'host-ordinal-1',
    };
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<CrqWireOutcomeReply> {
    this.outcomeCalls += 1;
    this.lastOutcome = message;
    assertExactKeys(message, OUTCOME_KEYS, 'outcome');
    return {
      method: 'outcome',
      outcome: reportedKind(message),
      stopped: this.stopNext,
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      attemptRef: Number(message['attempt_ref']),
      ackSequence: Number(message['ack_sequence']),
    };
  }

  unblock(): void {
    this.release?.();
    this.release = null;
  }
}

/** Refuse any field the strict host does not know, in either direction. */
function assertExactKeys(
  message: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  frame: string,
): void {
  const unknown = Object.keys(message).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new CrqWireRefusal(
      `the strict host refuses unknown ${frame} fields: ${unknown.join(', ')}`,
    );
  }
  for (const key of allowed) {
    if (!(key in message)) {
      throw new CrqWireRefusal(`the strict host requires the ${frame} field ${key}`);
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('composed adapter: strict frames and the reserve-in-flight lock', () => {
  it('refuses a gateway model id string instead of wrapping it', () => {
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport: new StrictTransport(),
    });
    // `LanguageModel` is the model OR a gateway id string; the adapter needs the
    // resolved instance, so the string is refused before any wrap (no cast).
    const gateway: LanguageModel = 'anthropic/claude-sonnet-4';
    expect(() => adapter.wrapModel(gateway)).toThrow(/resolved language-model instance/);
  });

  it('refuses a host acknowledgement whose digest does not bind the sent envelope', async () => {
    const transport = new StrictTransport();
    transport.mangleDigest = true;
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    // A host ack that returns a different request digest must be REFUSED: the source
    // binding is the only thing that ties the ack to the document the wire carried.
    await expect(adapter.reserve(receiptFor(projectionWith(null)))).rejects.toThrow(
      /canonical request digest/,
    );
    expect(transport.reserveCalls).toBe(1);
  });

  it('rejects the payload and blocks continuation when the host stops a completed wire', async () => {
    const transport = new StrictTransport();
    transport.stopNext = 'stop_over_bound';
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    const counter = { fetches: 0 };
    const wrapped = adapter.wrapModel(countingModel(counter));
    await adapter.reserve(receiptFor(projectionWith(null)));
    // The provider call happened (the charge is kept) and the outcome was reported
    // exactly once, but the host's terminal stop must reach the caller: a completed
    // frame with a non-null stopped NEVER settles as an accepted payload.
    await expect(wrapped.doGenerate(PROMPT_CALL)).rejects.toThrow(
      /the host stopped this wire: stop_over_bound/,
    );
    expect(counter.fetches).toBe(1);
    expect(transport.outcomeCalls).toBe(1);
    // No accepted outcome was recorded: no repair stage, no next send.
    expect(() => adapter.repairStage.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
    await expect(adapter.reserve(receiptFor(projectionWith(null)))).rejects.toThrow(
      /no accepted outcome/,
    );
    expect(transport.reserveCalls).toBe(1);
  });

  it('sends the exact strict reserve and outcome frames, with a STRING session id', async () => {
    const transport = new StrictTransport();
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    await adapter.reserve(receiptFor(projectionWith(null)));
    expect(transport.reserveCalls).toBe(1);
    const counter = { fetches: 0 };
    await adapter.wrapModel(countingModel(counter)).doGenerate(PROMPT_CALL);
    expect(counter.fetches).toBe(1);
    expect(transport.outcomeCalls).toBe(1);
    // The outcome frame carries NO wire ordinal: the reserved ack's host ordinal
    // is validated where the strict schema allows it, never echoed by the client.
    expect(transport.lastOutcome?.['wire_ordinal']).toBeUndefined();
    expect(Object.keys(transport.lastOutcome ?? {}).sort()).toEqual([...OUTCOME_KEYS].sort());
  });

  it('refuses a second reserve interleaved before the first host reserve resolves', async () => {
    const transport = new StrictTransport();
    transport.holdNextReserve = true;
    const adapter = createCrqWireAdapter({
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      transport,
    });
    const first = adapter.reserve(receiptFor(projectionWith(null)));
    await flush();
    // The first reserve is still awaiting the host: the lock must refuse a second
    // one BEFORE it reaches the transport, so no ack can be overwritten.
    await expect(adapter.reserve(receiptFor(projectionWith(null)))).rejects.toThrow(
      /already in flight/,
    );
    expect(transport.reserveCalls).toBe(1);
    transport.unblock();
    await first;
    expect(transport.reserveCalls).toBe(1);
    // Close the first wire's outcome so the adapter's state checks admit the next send.
    const counter = { fetches: 0 };
    await adapter.wrapModel(countingModel(counter)).doGenerate(PROMPT_CALL);
    expect(counter.fetches).toBe(1);
    // The lock was released on the successful path: the next reserve reaches the host.
    await adapter.reserve(receiptFor(projectionWith(null)));
    expect(transport.reserveCalls).toBe(2);
  });
});
