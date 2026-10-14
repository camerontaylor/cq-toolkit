// Offline tests for the CRQ per-wire wrapper (worker side of crq-cq-sdk-wire/1).
//
// Fakes only: an in-memory canonical encoder and an in-memory transport. Nothing here
// opens a socket, spawns a process, reads a credential or reaches a provider.
import { describe, expect, it } from 'vitest';

import {
  CrqWireRefusal,
  CrqWireWrapper,
  bridgeEnvelope,
  type CrqCanonicalEncoder,
  type CrqWireAck,
  type CrqWireIdentity,
  type CrqWireOutcomeReply,
  type CrqWireTransport,
  type CrqWireUsage,
} from '../../src/driver/ai-sdk/crq-wire-wrapper.js';

const IDENTITY: CrqWireIdentity = {
  job: 'crq-run-20261014T120000Z-F1',
  sourceSha: 'a'.repeat(40),
  findingSha256: 'b'.repeat(64),
  authorizationSha256: 'c'.repeat(64),
  role: 'fixer',
  rung: 0,
  window: 'default',
};

const PROJECTION = { prompt: 'fix the finding', tools: [], maxOutputTokens: 4000 };

/** A fake C1 encoder: deterministic, canonical-looking hex and digest. */
const encoder: CrqCanonicalEncoder = {
  protocol: 'crq/request-projection/v1',
  version: 1,
  projectionHex: () => '00112233',
  projectionDigest: () => 'd'.repeat(64),
};

class FakeTransport implements CrqWireTransport {
  public readonly calls: string[] = [];
  public sessions = 0;
  public attestation = true;
  private nextAck = 1;
  public refuseNext = false;
  public mutateAck: ((ack: CrqWireAck) => CrqWireAck) | null = null;
  public lastReserve: Readonly<Record<string, unknown>> | null = null;
  public outcomes: Readonly<Record<string, unknown>>[] = [];
  private attempts = 0;
  public stopNext: string | null = null;

  async attestHost(): Promise<boolean> {
    this.calls.push('attest');
    return this.attestation;
  }

  async hello(): Promise<{ sessionId: string; attemptRef: number; remainingMilliseconds: number }> {
    this.calls.push('hello');
    this.sessions += 1;
    this.attempts += 1;
    return {
      sessionId: `session-${String(this.sessions)}`,
      attemptRef: this.attempts,
      remainingMilliseconds: 600_000,
    };
  }

  async reserve(
    message: Readonly<Record<string, unknown>>,
  ): Promise<CrqWireAck | { refused: string }> {
    this.calls.push('reserve');
    this.lastReserve = message;
    if (this.refuseNext) return { refused: 'the host refused the durable reservation' };
    const base: CrqWireAck = {
      method: 'reserved',
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      ackSequence: this.nextAck,
      reservationSequence: this.nextAck,
      requestSha256: 'e'.repeat(64),
      inputTokens: 1000,
      reservedOutputTokens: 8000,
      totalTokens: 9000,
      cumulativeTokens: this.nextAck * 9000,
      remainingTokens: 32000 - this.nextAck * 9000,
      remainingMilliseconds: 590_000,
      attemptRef: Number(message['attempt_ref']),
      wireOrdinal: String(message['wire_ordinal']),
    };
    this.nextAck += 1;
    return this.mutateAck === null ? base : this.mutateAck(base);
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<CrqWireOutcomeReply> {
    this.calls.push('outcome');
    this.outcomes.push(message);
    return {
      stopped: this.stopNext,
      sessionId: String(message['session_id']),
      messageId: Number(message['message_id']),
      attemptRef: Number(message['attempt_ref']),
      ackSequence: Number(message['ack_sequence']),
    };
  }
}

const usage: CrqWireUsage = {
  actualInput: 900,
  cacheHit: 0,
  cacheMiss: 900,
  completion: 50,
  visible: 40,
  reasoning: 10,
  total: 950,
};

function wrapper(
  transport: FakeTransport,
  over: Partial<{ encoder: CrqCanonicalEncoder }> = {},
): CrqWireWrapper {
  return new CrqWireWrapper({
    encoder: over.encoder ?? encoder,
    transport,
    identity: IDENTITY,
    provider: 'zai',
    model: 'glm-5.3-flash',
    projection: () => PROJECTION,
  });
}

describe('bridgeEnvelope', () => {
  it('nests the locked 11-field envelope with zeroed sender claims', () => {
    const value = bridgeEnvelope(encoder, PROJECTION, 'zai', 'glm-5.3-flash');
    expect(Object.keys(value).sort()).toEqual([
      'bytes',
      'countedInput',
      'cumulativeTokens',
      'digest',
      'model',
      'projection',
      'protocol',
      'provider',
      'reserveOutputTokens',
      'tokens',
      'version',
    ]);
    expect(value.countedInput).toBe(0);
    expect(value.tokens).toBe(0);
    expect(value.cumulativeTokens).toBe(0);
    expect(value.reserveOutputTokens).toBe(0);
  });

  it('refuses a foreign protocol or version', () => {
    expect(() =>
      bridgeEnvelope({ ...encoder, protocol: 'crq/other/v1' }, PROJECTION, 'p', 'm'),
    ).toThrow(CrqWireRefusal);
    expect(() => bridgeEnvelope({ ...encoder, version: 2 }, PROJECTION, 'p', 'm')).toThrow(
      CrqWireRefusal,
    );
  });

  it('refuses non-hex bytes or a malformed digest', () => {
    expect(() =>
      bridgeEnvelope({ ...encoder, projectionHex: () => 'zz' }, PROJECTION, 'p', 'm'),
    ).toThrow(CrqWireRefusal);
    expect(() =>
      bridgeEnvelope({ ...encoder, projectionHex: () => 'abc' }, PROJECTION, 'p', 'm'),
    ).toThrow(CrqWireRefusal);
    expect(() =>
      bridgeEnvelope({ ...encoder, projectionDigest: () => 'short' }, PROJECTION, 'p', 'm'),
    ).toThrow(CrqWireRefusal);
  });
});

describe('CrqWireWrapper', () => {
  it('attests the peer, opens a session, then reserves before returning', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const ack = await wire.reserve();
    expect(transport.calls).toEqual(['attest', 'hello', 'reserve']);
    expect(ack.ackSequence).toBe(1);
    expect(wire.acknowledgement).toBe(ack);
    expect(transport.lastReserve?.['method']).toBe('reserve');
    expect(transport.lastReserve?.['job']).toBe(IDENTITY.job);
    expect(transport.lastReserve?.['supersedes_ack_sequence']).toBe(0);
    expect(transport.lastReserve?.['envelope']).toMatchObject({
      protocol: 'crq/request-projection/v1',
    });
  });

  it('reuses one session across wires but supersedes the previous ack on a retry', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const first = await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    const retry = await wire.reserve();
    expect(transport.sessions).toBe(1);
    expect(retry.ackSequence).toBe(first.ackSequence + 1);
    expect(transport.lastReserve?.['message_id']).toBe(3);
    expect(transport.lastReserve?.['supersedes_ack_sequence']).toBe(first.ackSequence);
    expect(Number(transport.lastReserve?.['attempt_ref'])).toBeGreaterThan(0);
  });

  it('refuses without an injected encoder or transport', async () => {
    const transport = new FakeTransport();
    const noEncoder = new CrqWireWrapper({
      transport,
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      projection: () => PROJECTION,
    });
    await expect(noEncoder.reserve()).rejects.toThrow(CrqWireRefusal);
    const noTransport = new CrqWireWrapper({
      encoder,
      identity: IDENTITY,
      provider: 'zai',
      model: 'glm-5.3-flash',
      projection: () => PROJECTION,
    });
    await expect(noTransport.reserve()).rejects.toThrow(CrqWireRefusal);
  });

  it('refuses when the transport cannot attest the host peer', async () => {
    const transport = new FakeTransport();
    transport.attestation = false;
    const wire = wrapper(transport);
    await expect(wire.reserve()).rejects.toThrow(/attest/);
    expect(transport.calls).not.toContain('reserve');
  });

  it('refuses when the host refuses the reservation', async () => {
    const transport = new FakeTransport();
    transport.refuseNext = true;
    const wire = wrapper(transport);
    await expect(wire.reserve()).rejects.toThrow(CrqWireRefusal);
    expect(wire.acknowledgement).toBeNull();
  });

  it('refuses an acknowledgement that does not bind the message', async () => {
    const transport = new FakeTransport();
    transport.mutateAck = (ack) => ({ ...ack, messageId: 99 });
    const wire = wrapper(transport);
    await expect(wire.reserve()).rejects.toThrow(/does not bind/);
  });

  it('refuses an acknowledgement without usable remaining time', async () => {
    const transport = new FakeTransport();
    transport.mutateAck = (ack) => ({ ...ack, remainingMilliseconds: 0 });
    const wire = wrapper(transport);
    await expect(wire.reserve()).rejects.toThrow(/remaining time/);
  });

  it('reports usage for the acked wire and refuses an unreported outcome', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await expect(wire.outcome('completed', usage, 'end_turn', null)).rejects.toThrow(
      CrqWireRefusal,
    );
    const ack = await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    expect(transport.outcomes).toHaveLength(1);
    expect(transport.outcomes[0]?.['ack_sequence']).toBe(ack.ackSequence);
    expect(transport.outcomes[0]?.['outcome']).toBe('completed');
  });

  it('reports a missing usage as null so the host can stop continuation', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    await wire.outcome('completed', null, 'end_turn', null);
    expect(transport.outcomes[0]?.['usage']).toBeNull();
  });

  it('sends the EXACT snake_case usage shape the strict host schema requires', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    // Regression for the strict Python usage schema: camelCase keys on the wire
    // would make the host refuse every outcome, so assert the exact key set and
    // every value, and that no camelCase key survives.
    const sent = transport.outcomes[0]?.['usage'];
    expect(sent).toEqual({
      actual_input: 900,
      cache_hit: 0,
      cache_miss: 900,
      completion: 50,
      visible: 40,
      reasoning: 10,
      total: 950,
    });
    expect(Object.keys(sent as object).sort()).toEqual([
      'actual_input',
      'cache_hit',
      'cache_miss',
      'completion',
      'reasoning',
      'total',
      'visible',
    ]);
    for (const camel of ['actualInput', 'cacheHit', 'cacheMiss']) {
      expect(Object.keys(sent as object)).not.toContain(camel);
    }
  });

  it('treats a non-null stopped terminal reply as NOT accepted even for completed', async () => {
    const transport = new FakeTransport();
    transport.stopNext = 'stop_budget_exhausted';
    const wire = wrapper(transport);
    await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    // The frame claimed completed, but the host's terminal reply stopped the attempt,
    // so no locally accepted stage and no new send may be conferred.
    expect(() => wire.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
    await expect(wire.reserve()).rejects.toThrow(/no accepted outcome/);
  });

  it('refuses a terminal reply that does not bind this wire', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    const original = transport.outcome.bind(transport);
    transport.outcome = async (message) => ({
      ...(await original(message)),
      ackSequence: 999_999,
    });
    await expect(wire.outcome('completed', usage, 'end_turn', null)).rejects.toThrow(
      /does not bind this wire/,
    );
  });

  it('marks a judge role as the judge kind', async () => {
    const transport = new FakeTransport();
    const wire = new CrqWireWrapper({
      encoder,
      transport,
      identity: { ...IDENTITY, role: 'judge' },
      provider: 'zai',
      model: 'glm-5.3-flash',
      projection: () => PROJECTION,
    });
    await wire.reserve();
    expect(transport.lastReserve?.['kind']).toBe('judge');
  });

  it('links a repair wire to the ack it repairs', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const ack = await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null, ack.ackSequence);
    expect(transport.outcomes[1]?.['repair_of_ack_sequence']).toBe(ack.ackSequence);
  });

  it('refuses to enter the repair stage with no prior authoritative ack', () => {
    const wire = wrapper(new FakeTransport());
    expect(() => wire.enterRepairStage()).toThrow(/no authoritative prior ack/);
  });

  it('refuses to enter the repair stage while the prior wire is unaudited', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    expect(() => wire.enterRepairStage()).toThrow(/no recorded outcome/);
  });

  it("links the repair wire to the wrapper's own prior ack and refuses a second stage", async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const first = await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    wire.enterRepairStage();
    wire.enterRepairStage(); // idempotent ONLY while the same stage is active
    const repair = await wire.reserve();
    wire.exitRepairStage();
    expect(transport.lastReserve?.['kind']).toBe('repair');
    expect(transport.lastReserve?.['repair_of_ack_sequence']).toBe(first.ackSequence);
    expect(transport.lastReserve?.['supersedes_ack_sequence']).toBe(first.ackSequence);
    expect(repair.ackSequence).not.toBe(first.ackSequence);
    expect(() => wire.enterRepairStage()).toThrow(/second completed repair stage/);
  });

  it('refuses local repair entry AND a new send after an UNKNOWN outcome', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    await wire.outcome('unknown', null, null, null);
    expect(() => wire.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
    await expect(wire.reserve()).rejects.toThrow(/no accepted outcome/);
  });

  it('refuses local repair entry after a REFUSED outcome', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    await wire.reserve();
    await wire.outcome('refused', usage, 'stop', null);
    expect(() => wire.enterRepairStage()).toThrow(/requires an ACCEPTED outcome/);
  });

  it('records the status against the ack captured BEFORE the outcome await', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const first = await wire.reserve();
    await wire.outcome('completed', usage, 'end_turn', null);
    const second = await wire.reserve();
    // The status belongs to ack 1; the NEW ack 2 is pending, so the stage must refuse it.
    expect(second.ackSequence).toBe(first.ackSequence + 1);
    expect(() => wire.enterRepairStage()).toThrow(/no recorded outcome/);
  });
});
