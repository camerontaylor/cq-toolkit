// The CRQ per-wire host wrapper for the CQ ai-sdk lane.
//
// The CQ SDK makes every provider call from inside the contained worker process. This
// module is the WORKER side of `crq-cq-sdk-wire/1`: it turns each pre-wire SDK
// reservation into an authenticated RPC to the CRQ host, which durably debits the
// ledger, fsyncs a pre-send attestation and returns a host-assigned `ack_sequence`.
// The SDK may send ONLY after a valid ack for that exact message. There is no CLI
// fallback and no local token accounting: the durable authority is the host.
//
// Fail closed by construction:
//  * no injected canonical encoder (C1) -> refuse; the TS-LOCAL `countableProjectionDigest`
//    is NOT the canonical protocol digest and is never sent as one;
//  * no injected authenticated transport -> refuse;
//  * a transport that cannot independently attest the host peer -> refuse (the host's
//    `ready.host_identity` is informational only and is never trusted on its own);
//  * a missing/short/odd/non-lowercase-hex canonical document, a foreign protocol or a
//    digest mismatch -> refuse before any RPC;
//  * any host refusal, a missing ack, a stale ack (wrong message id) or an abort ->
//    refuse the wire (the local conservative charge is NOT refunded).
//
// Every call gets its own acknowledgement, including each SDK retry (a new message id
// that supersedes the previous ack) and each structured-output / JSON repair. Usage is
// reported back through `outcome(...)` for EVERY actual model call; a missing or
// unknown usage stops continuation at the host.

/** The canonical counted projection, encoded by C1. Never re-implemented here. */
export interface CrqCanonicalEncoder {
  /** The canonical protocol tag (C1: `crq/request-projection/v1`). */
  readonly protocol: string;
  /** The canonical protocol version (C1: integer 1). */
  readonly version: number;
  /** The canonical projection hex of the counted projection (lowercase, even length). */
  projectionHex(projection: Readonly<Record<string, unknown>>): string;
  /** The canonical projection digest (64-hex sha256). */
  projectionDigest(projection: Readonly<Record<string, unknown>>): string;
}

/** The five identity fields the host binds at `hello` and re-requires per frame. */
export interface CrqWireIdentity {
  readonly job: string;
  readonly sourceSha: string;
  readonly findingSha256: string;
  readonly authorizationSha256: string;
  readonly role: string;
  readonly rung: number;
  readonly window: string;
}

/** A host-assigned acknowledgement. `ackSequence` is AUTHORITATIVE; the sender sets none. */
export interface CrqWireAck {
  readonly method: 'reserved';
  readonly sessionId: string;
  readonly messageId: number;
  readonly ackSequence: number;
  readonly reservationSequence: number;
  readonly requestSha256: string;
  readonly inputTokens: number;
  readonly reservedOutputTokens: number;
  readonly totalTokens: number;
  readonly cumulativeTokens: number;
  readonly remainingTokens: number;
  readonly remainingMilliseconds: number;
}

/** The outcome of one actual model call, reported for EVERY wire. */
export interface CrqWireUsage {
  readonly actualInput: number | null;
  readonly cacheHit: number | null;
  readonly cacheMiss: number | null;
  readonly completion: number | null;
  readonly visible: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
}

export type CrqWireOutcomeKind = 'completed' | 'refused' | 'unknown';

/** The authenticated transport callback. C4 owns its native implementation. */
export interface CrqWireTransport {
  /**
   * Independently attest, read-only, that the peer really is the host of THIS released
   * activation (peer credentials + start time + cgroup + custody). Returning anything
   * but `true` refuses the wire. The host's own `hostIdentity` is informational.
   */
  attestHost(): Promise<boolean>;
  /** `hello`: bind this activation's identity and learn the session id. */
  hello(identity: CrqWireIdentity, provider: string, model: string): Promise<{ sessionId: string; remainingMilliseconds: number }>;
  /** `reserve`: durably reserve one wire and return the host's acknowledgement. */
  reserve(message: Readonly<Record<string, unknown>>): Promise<CrqWireAck | { refused: string }>;
  /** `outcome`: report the outcome of one acked wire call. */
  outcome(message: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface CrqWireWrapperOptions {
  /** C1's canonical encoder. ABSENT -> the wrapper refuses (fail closed). */
  readonly encoder?: CrqCanonicalEncoder;
  /** The authenticated transport. ABSENT -> the wrapper refuses (fail closed). */
  readonly transport?: CrqWireTransport;
  /** The activation identity this wrapper is bound to. */
  readonly identity: CrqWireIdentity;
  /** The provider/model the run resolved (validated by the host against the role). */
  readonly provider: string;
  readonly model: string;
  /** The projection builder: the counted projection for the imminent wire. */
  readonly projection: () => Readonly<Record<string, unknown>>;
}

/** The locked C1 bridge envelope, nested verbatim. Sender token claims are ignored. */
export interface CrqBridgeEnvelope {
  readonly protocol: string;
  readonly version: number;
  readonly digest: string;
  readonly bytes: string;
  readonly projection: null;
  readonly provider: string;
  readonly model: string;
  readonly countedInput: number;
  readonly reserveOutputTokens: number;
  readonly tokens: number;
  readonly cumulativeTokens: number;
}

export class CrqWireRefusal extends Error {}

const HEX = /^[0-9a-f]*$/;

/** Build the LOCKED 11-field C1 envelope, or refuse. The token claims are zeros. */
export function bridgeEnvelope(encoder: CrqCanonicalEncoder, projection: Readonly<Record<string, unknown>>, provider: string, model: string): CrqBridgeEnvelope {
  if (encoder.protocol !== 'crq/request-projection/v1') {
    throw new CrqWireRefusal('the canonical encoder does not carry the request-projection protocol');
  }
  if (encoder.version !== 1) {
    throw new CrqWireRefusal('the canonical encoder is not protocol version 1');
  }
  const bytes = encoder.projectionHex(projection);
  const digest = encoder.projectionDigest(projection);
  if (typeof bytes !== 'string' || bytes.length === 0 || bytes.length % 2 !== 0 || !HEX.test(bytes)) {
    throw new CrqWireRefusal('the canonical projection bytes are not a bounded lowercase hex document');
  }
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new CrqWireRefusal('the canonical projection digest is not a 64-hex sha256');
  }
  return {
    protocol: encoder.protocol, version: encoder.version, digest, bytes, projection: null, provider, model,
    // The sender's token numbers are NOT authority; they are zeros, never the local count.
    countedInput: 0, reserveOutputTokens: 0, tokens: 0, cumulativeTokens: 0,
  };
}

/**
 * The per-activation wrapper. One instance per role attempt: each `reserve()` is a new
 * message that supersedes the previous ack, so a retry never reuses a debit, and every
 * call (including a JSON repair) is acknowledged before it can reach the wire.
 */
export class CrqWireWrapper {
  private readonly options: CrqWireWrapperOptions;
  private sessionId: string | null = null;
  private messageId = 0;
  private lastAck: CrqWireAck | null = null;

  constructor(options: CrqWireWrapperOptions) {
    this.options = options;
  }

  /** The most recent host acknowledgement, or null when no wire has been reserved. */
  get acknowledgement(): CrqWireAck | null {
    return this.lastAck;
  }

  private async session(): Promise<string> {
    const { encoder, transport, identity, provider, model } = this.options;
    if (encoder === undefined || transport === undefined) {
      throw new CrqWireRefusal('the CRQ wire requires an injected canonical encoder and an authenticated transport');
    }
    if (this.sessionId !== null) return this.sessionId;
    const attested = await transport.attestHost();
    if (attested !== true) {
      throw new CrqWireRefusal('the transport could not independently attest the host peer; refusing the wire');
    }
    const ready = await transport.hello(identity, provider, model);
    if (typeof ready.sessionId !== 'string' || ready.sessionId.length === 0) {
      throw new CrqWireRefusal('the host returned no session id');
    }
    this.sessionId = ready.sessionId;
    return this.sessionId;
  }

  /**
   * The pre-wire hook: the SDK calls this after its local conservative charge and
   * BEFORE the wire. A throw refuses the request with no refund, which is the required
   * behavior for a missing, refused or unauthenticated acknowledgement.
   */
  reserve(): Promise<CrqWireAck> {
    return this.reserveOnce();
  }

  private async reserveOnce(): Promise<CrqWireAck> {
    const { encoder, transport, identity, provider, model, projection } = this.options;
    if (encoder === undefined || transport === undefined) {
      throw new CrqWireRefusal('the CRQ wire requires an injected canonical encoder and an authenticated transport');
    }
    const sessionId = await this.session();
    const envelope = bridgeEnvelope(encoder, projection(), provider, model);
    const messageId = this.messageId + 1;
    const supersedes = this.lastAck === null ? 0 : this.lastAck.ackSequence;
    const message = {
      method: 'reserve', session_id: sessionId, message_id: messageId,
      job: identity.job, source_sha: identity.sourceSha, finding_sha256: identity.findingSha256,
      authorization_sha256: identity.authorizationSha256, role: identity.role, rung: identity.rung,
      window: identity.window, driver: 'cq', provider, model,
      // The logical attempt identity is IMMUTABLE across retries of this wrapper.
      logical_attempt_id: `${identity.job}:${identity.role}:${String(identity.rung)}:${identity.window}`,
      supersedes_ack_sequence: supersedes, kind: identity.role.startsWith('judge') ? 'judge' : 'fixer',
      envelope, wire_output_ceiling: envelope.countedInput + 1, repair_of_ack_sequence: null,
    };
    const reply = await transport.reserve(message);
    if (!('ackSequence' in reply)) {
      throw new CrqWireRefusal(`the host refused the wire: ${String((reply as { refused: string }).refused)}`);
    }
    if (reply.messageId !== messageId || typeof reply.ackSequence !== 'number' || reply.ackSequence < 1) {
      throw new CrqWireRefusal('the host acknowledgement does not bind this message');
    }
    if (typeof reply.remainingMilliseconds !== 'number' || !Number.isInteger(reply.remainingMilliseconds) || reply.remainingMilliseconds <= 0) {
      throw new CrqWireRefusal('the host acknowledgement carries no usable remaining time');
    }
    this.messageId = messageId;
    this.lastAck = reply;
    return reply;
  }

  /**
   * Report the outcome of the acknowledged wire call. EVERY actual model call must be
   * reported: a retry reports its own ack, a JSON repair reports its own ack, and a
   * missing/unknown usage is reported as null so the host stops continuation.
   */
  async outcome(kind: CrqWireOutcomeKind, usage: CrqWireUsage | null, stopReason: string | null, errorClass: string | null, repairOf: number | null = null): Promise<void> {
    const { transport } = this.options;
    if (transport === undefined) {
      throw new CrqWireRefusal('no authenticated transport is injected');
    }
    if (this.lastAck === null) {
      throw new CrqWireRefusal('no acknowledged wire call to report an outcome for');
    }
    const identity = this.options.identity;
    this.messageId += 1;
    await transport.outcome({
      method: 'outcome', session_id: this.sessionId, message_id: this.messageId,
      job: identity.job, source_sha: identity.sourceSha, finding_sha256: identity.findingSha256,
      authorization_sha256: identity.authorizationSha256, ack_sequence: this.lastAck.ackSequence,
      outcome: kind, usage, stop_reason: stopReason, error_class: errorClass,
      repair_of_ack_sequence: repairOf,
    });
  }
}
