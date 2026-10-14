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

  async attestHost(): Promise<boolean> {
    this.calls.push('attest');
    return this.attestation;
  }

  async hello(): Promise<{ sessionId: string; remainingMilliseconds: number }> {
    this.calls.push('hello');
    this.sessions += 1;
    return { sessionId: `session-${String(this.sessions)}`, remainingMilliseconds: 600_000 };
  }

  async reserve(message: Readonly<Record<string, unknown>>): Promise<CrqWireAck | { refused: string }> {
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
    };
    this.nextAck += 1;
    return this.mutateAck === null ? base : this.mutateAck(base);
  }

  async outcome(message: Readonly<Record<string, unknown>>): Promise<void> {
    this.calls.push('outcome');
    this.outcomes.push(message);
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

function wrapper(transport: FakeTransport, over: Partial<{ encoder: CrqCanonicalEncoder }> = {}): CrqWireWrapper {
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
      'bytes', 'countedInput', 'cumulativeTokens', 'digest', 'model', 'projection',
      'protocol', 'provider', 'reserveOutputTokens', 'tokens', 'version',
    ]);
    expect(value.countedInput).toBe(0);
    expect(value.tokens).toBe(0);
    expect(value.cumulativeTokens).toBe(0);
    expect(value.reserveOutputTokens).toBe(0);
  });

  it('refuses a foreign protocol or version', () => {
    expect(() => bridgeEnvelope({ ...encoder, protocol: 'crq/other/v1' }, PROJECTION, 'p', 'm'))
      .toThrow(CrqWireRefusal);
    expect(() => bridgeEnvelope({ ...encoder, version: 2 }, PROJECTION, 'p', 'm'))
      .toThrow(CrqWireRefusal);
  });

  it('refuses non-hex bytes or a malformed digest', () => {
    expect(() => bridgeEnvelope({ ...encoder, projectionHex: () => 'zz' }, PROJECTION, 'p', 'm'))
      .toThrow(CrqWireRefusal);
    expect(() => bridgeEnvelope({ ...encoder, projectionHex: () => 'abc' }, PROJECTION, 'p', 'm'))
      .toThrow(CrqWireRefusal);
    expect(() => bridgeEnvelope({ ...encoder, projectionDigest: () => 'short' }, PROJECTION, 'p', 'm'))
      .toThrow(CrqWireRefusal);
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
    expect(transport.lastReserve?.['envelope']).toMatchObject({ protocol: 'crq/request-projection/v1' });
  });

  it('reuses one session across wires but supersedes the previous ack on a retry', async () => {
    const transport = new FakeTransport();
    const wire = wrapper(transport);
    const first = await wire.reserve();
    const retry = await wire.reserve();
    expect(transport.sessions).toBe(1);
    expect(retry.ackSequence).toBe(first.ackSequence + 1);
    expect(transport.lastReserve?.['message_id']).toBe(2);
    expect(transport.lastReserve?.['supersedes_ack_sequence']).toBe(first.ackSequence);
    expect(String(transport.lastReserve?.['logical_attempt_id'])).toContain('fixer');
  });

  it('refuses without an injected encoder or transport', async () => {
    const transport = new FakeTransport();
    const noEncoder = new CrqWireWrapper({
      transport, identity: IDENTITY, provider: 'zai', model: 'glm-5.3-flash',
      projection: () => PROJECTION,
    });
    await expect(noEncoder.reserve()).rejects.toThrow(CrqWireRefusal);
    const noTransport = new CrqWireWrapper({
      encoder, identity: IDENTITY, provider: 'zai', model: 'glm-5.3-flash',
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
    await expect(wire.outcome('completed', usage, 'end_turn', null)).rejects.toThrow(CrqWireRefusal);
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

  it('marks a judge role as the judge kind', async () => {
    const transport = new FakeTransport();
    const wire = new CrqWireWrapper({
      encoder, transport, identity: { ...IDENTITY, role: 'judge' }, provider: 'zai',
      model: 'glm-5.3-flash', projection: () => PROJECTION,
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
});
