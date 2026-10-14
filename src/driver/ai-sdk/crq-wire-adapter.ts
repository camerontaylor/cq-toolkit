// The composed CRQ per-wire adapter for the CQ ai-sdk lane — C2 composition.
//
// ONE operator-injected object owns the three seams the driver needs, so the SAME
// per-role-attempt state drives the ceiling hook, the bounded repair stage and the
// per-attempt outcome reporting:
//
//   reserve(receipt)      the ceiling's `onBeforeWireReserve` hook: validate the
//                         C1 canonical protocol/bytes/digest carried by the
//                         receipt, then durably reserve on the host BEFORE the
//                         wire. The host ack is authoritative; the diagnostic
//                         token fields are never meter authority.
//   enterRepairStage()/   the approved one-bounded-repair-stage seam (the public
//   exitRepairStage()     StrictTokenRepairStage shape).
//   wrapModel(model)      wrap the resolved model BELOW the pre-request ceiling so
//                         only ACTUAL acked provider attempts are observed.
//
// CONTRACT NOTES (80e adjudication, corrected):
//  * The reserve/outcome frames use the LOCKED host shape: the envelope's EXACT 11
//    fields, a positive incremented `message_id`, `supersedes_ack_sequence = 0`
//    for the first wire. The client NEVER manufactures `wire_ordinal` — the host
//    owns it. Canonical bytes/digest/protocol come VERBATIM from the receipt with
//    `projection: null`; the sender's token claims are diagnostics, not authority.
//  * ACK binding uses ONLY the typed transport contract (no narrowing casts
//    inventing fields): echoed `message_id`/`session_id`, the echoed canonical
//    `request_sha256`, and monotonic `ack_sequence`/`reservation_sequence`.
//  * Usage is NEVER invented: every field is null unless it is a measured safe
//    non-negative integer; `total` is null unless BOTH input and completion are
//    measured. Complete output is reasoning-inclusive and is not summed twice.
//    An incomplete/over-bound usage reports `unknown` (which stops the next send).
//  * Each acknowledged wire is reported EXACTLY ONCE. A provider failure and an
//    outcome-write failure are separated: the pending ack is closed BEFORE the
//    outcome await, so a failed write leaves the wire terminal (no second report).
//  * STREAMING IS REFUSED BEFORE DISPATCH (this surface has no finish-time usage
//    observation yet), so a still-running stream is never returned after declaring
//    its outcome done.
//  * `wrapModel` refuses unless an authoritative ack is pending, and concurrent
//    reserve/send is refused rather than overwriting session/lastAck across awaits.
//
// FAIL CLOSED: no injected transport -> refuse; un-attested peer -> refuse; wrong
// protocol / digest mismatch / oversized canonical document -> refuse; host
// refusal, a stale/unbound ack, or an abort -> refuse (no refund).
//
// 210 owns the index-side `StrictTokenWireAdapter` / `StrictTokenRepairStage`
// declarations (built on the existing WireReservation/LanguageModel); this module
// imports them TYPE-ONLY so the driver and the adapter cannot drift.
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { StrictTokenRepairStage, StrictTokenWireAdapter } from './index.js';
import { canonicalProjectionDigestOf, CANONICAL_PROJECTION_PROTOCOL } from './canonical-projection.js';
import type { WireReservation } from './pre-request-ceiling.js';
import {
  CrqWireRefusal,
  type CrqWireAck,
  type CrqWireIdentity,
  type CrqWireOutcomeKind,
  type CrqWireTransport,
  type CrqWireUsage,
} from './crq-wire-wrapper.js';

const HEX_LOWER_EVEN = /^(?:[0-9a-f]{2})+$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
/**
 * A conservative LOCAL bound on the canonical document length, applied to the hex
 * string BEFORE any Buffer allocation. C1 exports no max-document-bytes constant
 * yet; when it does, this is replaced by that exact value (flagged to the lead).
 */
const MAX_CANONICAL_DOCUMENT_HEX = 2 * 8 * 1024 * 1024;

export interface CrqWireAdapterOptions {
  readonly identity: CrqWireIdentity;
  readonly provider: string;
  readonly model: string;
  /** The authenticated transport. ABSENT -> every wire refuses (fail closed). */
  readonly transport?: CrqWireTransport;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Map one provider attempt's usage; nothing is invented. `total` is null unless
 * BOTH input and completion are measured. `completion` already includes reasoning
 * (the provider's output total), so it is never added twice.
 */
function usageOf(result: LanguageModelV4GenerateResult): CrqWireUsage {
  const input = result.usage.inputTokens;
  const output = result.usage.outputTokens;
  const actualInput = input?.total;
  const cacheHit = input?.cacheRead;
  const cacheMiss = input?.noCache;
  const completion = output?.total;
  const visible = output?.text;
  const reasoning = output?.reasoning;
  const total =
    isSafeNonNegativeInteger(actualInput) && isSafeNonNegativeInteger(completion)
      ? actualInput + completion
      : null;
  return {
    actualInput: isSafeNonNegativeInteger(actualInput) ? actualInput : null,
    cacheHit: isSafeNonNegativeInteger(cacheHit) ? cacheHit : null,
    cacheMiss: isSafeNonNegativeInteger(cacheMiss) ? cacheMiss : null,
    completion: isSafeNonNegativeInteger(completion) ? completion : null,
    visible: isSafeNonNegativeInteger(visible) ? visible : null,
    reasoning: isSafeNonNegativeInteger(reasoning) ? reasoning : null,
    total,
  };
}

/** Build the composed adapter. One instance per role attempt. */
export function createCrqWireAdapter(options: CrqWireAdapterOptions): StrictTokenWireAdapter {
  const { identity, provider, model } = options;

  let sessionId: string | null = null;
  let messageId = 0;
  let lastAck: CrqWireAck | null = null;
  /** The one ack whose outcome is pending; null when no wire is un-reported. */
  let pendingAck: number | null = null;
  /** The PRIOR ack a pending repair supersedes (immutable per-wire context). */
  let pendingRepairOf: number | null = null;
  /** True while a provider attempt is in flight (serialize online wire calls). */
  let sendInFlight = false;
  const outcomeStatus = new Map<number, CrqWireOutcomeKind>();
  let repairStageActive = false;
  let repairStageCompleted = false;

  function requireTransport(): CrqWireTransport {
    if (options.transport === undefined) {
      throw new CrqWireRefusal('the CRQ wire requires an injected authenticated transport');
    }
    return options.transport;
  }

  function validateReceiptCanonical(receipt: WireReservation): {
    protocol: string;
    bytesHex: string;
    digest: string;
  } {
    const protocol = receipt.canonicalProjectionProtocol;
    const bytesHex = receipt.canonicalProjectionBytesHex;
    const digest = receipt.canonicalProjectionDigest;
    if (protocol !== CANONICAL_PROJECTION_PROTOCOL) {
      throw new CrqWireRefusal('the receipt does not carry the C1 canonical protocol');
    }
    if (typeof bytesHex !== 'string' || bytesHex.length > MAX_CANONICAL_DOCUMENT_HEX) {
      throw new CrqWireRefusal('the receipt canonical bytes exceed the bounded document size');
    }
    if (!HEX_LOWER_EVEN.test(bytesHex) || !DIGEST_HEX.test(digest)) {
      throw new CrqWireRefusal('the receipt canonical bytes/digest are not a bounded lowercase hex document');
    }
    // The digest is verified over the BYTES; the host's strict canonical decode
    // remains the domain authority — no parallel TS decoder is added here.
    if (canonicalProjectionDigestOf(Buffer.from(bytesHex, 'hex')) !== digest) {
      throw new CrqWireRefusal('the receipt canonical bytes do not re-hash to its own digest');
    }
    return { protocol, bytesHex, digest };
  }

  async function ensureSession(): Promise<string> {
    const transport = requireTransport();
    if (sessionId !== null) return sessionId;
    const attested = await transport.attestHost();
    if (attested !== true) {
      throw new CrqWireRefusal('the transport could not independently attest the host peer; refusing');
    }
    const ready = await transport.hello(identity, provider, model);
    if (typeof ready.sessionId !== 'string' || ready.sessionId.length === 0) {
      throw new CrqWireRefusal('the host returned no session id');
    }
    if (!Number.isSafeInteger(ready.remainingMilliseconds) || ready.remainingMilliseconds <= 0) {
      throw new CrqWireRefusal('the host returned no usable remaining time');
    }
    sessionId = ready.sessionId;
    return sessionId;
  }

  const reserve = async (receipt: WireReservation): Promise<void> => {
    const transport = requireTransport();
    if (sendInFlight) {
      throw new CrqWireRefusal('a provider send is already in flight; refusing a concurrent reserve');
    }
    const canonical = validateReceiptCanonical(receipt);
    if (!Number.isSafeInteger(receipt.reserveOutputTokens) || receipt.reserveOutputTokens < 1) {
      throw new CrqWireRefusal('the receipt carries no usable reserved output ceiling');
    }
    const session = await ensureSession();
    // LOCAL GATE: a new send requires the PRIOR wire's ACCEPTED (completed) outcome.
    if (lastAck !== null && outcomeStatus.get(lastAck.ackSequence) !== 'completed') {
      throw new CrqWireRefusal('the prior wire has no accepted outcome; refusing a new send');
    }
    if (pendingAck !== null) {
      throw new CrqWireRefusal('the previous acknowledged wire has not reported its outcome');
    }
    const nextMessageId = messageId + 1;
    const priorAck = lastAck === null ? null : lastAck.ackSequence;
    const repairing = repairStageActive && priorAck !== null;
    const message = {
      method: 'reserve',
      session_id: session,
      message_id: nextMessageId,
      job: identity.job,
      source_sha: identity.sourceSha,
      finding_sha256: identity.findingSha256,
      authorization_sha256: identity.authorizationSha256,
      role: identity.role,
      rung: identity.rung,
      window: identity.window,
      driver: 'cq',
      provider,
      model,
      // The canonical document is the receipt's, VERBATIM (receiver strict decode
      // + independent meter authority); diagnostics carry no authority.
      envelope: {
        protocol: canonical.protocol,
        version: 1,
        digest: canonical.digest,
        bytes: canonical.bytesHex,
        projection: null,
        provider,
        model,
        countedInput: 0,
        reserveOutputTokens: 0,
        tokens: 0,
        cumulativeTokens: 0,
      },
      wire_output_ceiling: receipt.reserveOutputTokens,
      supersedes_ack_sequence: priorAck === null ? 0 : priorAck,
      kind: repairing ? 'repair' : identity.role.startsWith('judge') ? 'judge' : 'fixer',
      repair_of_ack_sequence: repairing ? priorAck : null,
    };
    const reply = await transport.reserve(message);
    if (!('ackSequence' in reply)) {
      throw new CrqWireRefusal(`the host refused the wire: ${String((reply as { refused: string }).refused)}`);
    }
    // Bind ONLY the typed ack contract (no invented fields, no casts).
    if (reply.messageId !== nextMessageId) {
      throw new CrqWireRefusal('the host acknowledgement does not echo this message id');
    }
    if (reply.sessionId !== session) {
      throw new CrqWireRefusal('the host acknowledgement does not bind this session');
    }
    if (reply.requestSha256 !== canonical.digest) {
      throw new CrqWireRefusal('the host acknowledgement does not echo the canonical request digest');
    }
    if (!Number.isSafeInteger(reply.ackSequence) || reply.ackSequence < 1) {
      throw new CrqWireRefusal('the host acknowledgement carries no positive ack sequence');
    }
    if (lastAck !== null && reply.ackSequence <= lastAck.ackSequence) {
      throw new CrqWireRefusal('the host ack sequence is not monotonic');
    }
    if (!Number.isSafeInteger(reply.reservationSequence) || reply.reservationSequence < 1) {
      throw new CrqWireRefusal('the host acknowledgement carries no positive reservation sequence');
    }
    if (lastAck !== null && reply.reservationSequence <= lastAck.reservationSequence) {
      throw new CrqWireRefusal('the host reservation sequence is not monotonic');
    }
    if (!Number.isSafeInteger(reply.remainingMilliseconds) || reply.remainingMilliseconds <= 0) {
      throw new CrqWireRefusal('the host acknowledgement carries no usable remaining time');
    }
    messageId = nextMessageId;
    lastAck = reply;
    pendingAck = reply.ackSequence;
    pendingRepairOf = repairing ? priorAck : null;
  };

  /**
   * Report the outcome of the acknowledged wire EXACTLY ONCE. The pending ack is
   * closed BEFORE the outcome await, so a failed outcome write leaves the wire
   * terminal (no second report) and never re-uses the ack.
   */
  async function reportOutcomeOnce(
    kind: CrqWireOutcomeKind,
    usage: CrqWireUsage | null,
    stopReason: string | null,
    errorClass: string | null,
  ): Promise<void> {
    const transport = requireTransport();
    if (pendingAck === null) {
      throw new CrqWireRefusal('no acknowledged wire call to report an outcome for');
    }
    const ack = pendingAck;
    const repairOf = pendingRepairOf;
    pendingAck = null;
    pendingRepairOf = null;
    messageId += 1;
    await transport.outcome({
      method: 'outcome',
      session_id: sessionId,
      message_id: messageId,
      job: identity.job,
      source_sha: identity.sourceSha,
      finding_sha256: identity.findingSha256,
      authorization_sha256: identity.authorizationSha256,
      role: identity.role,
      rung: identity.rung,
      window: identity.window,
      driver: 'cq',
      provider,
      model,
      ack_sequence: ack,
      outcome: kind,
      usage,
      stop_reason: stopReason,
      error_class: errorClass,
      repair_of_ack_sequence: repairOf,
    });
    outcomeStatus.set(ack, kind);
  }

  const repairStage: StrictTokenRepairStage = {
    enterRepairStage(): void {
      if (repairStageActive) return;
      if (repairStageCompleted) {
        throw new CrqWireRefusal('a second completed repair stage is not permitted for this role attempt');
      }
      if (lastAck === null) {
        throw new CrqWireRefusal('no authoritative prior ack to repair; refusing the repair stage');
      }
      const status = outcomeStatus.get(lastAck.ackSequence);
      if (status === undefined) {
        throw new CrqWireRefusal('the prior ack has no recorded outcome (pending or unaudited)');
      }
      if (status !== 'completed') {
        throw new CrqWireRefusal(`the prior wire outcome is ${status}; a repair stage requires an ACCEPTED outcome`);
      }
      repairStageActive = true;
    },
    exitRepairStage(): void {
      if (repairStageActive) {
        repairStageActive = false;
        repairStageCompleted = true;
      }
    },
  };

  function wrapModel(inner: LanguageModel): LanguageModel {
    const middleware: LanguageModelMiddleware = {
      // BELOW the ceiling: invoked only for an ACTUAL provider attempt.
      wrapGenerate: async ({ doGenerate }) => {
        if (pendingAck === null) {
          throw new CrqWireRefusal('no acknowledged wire is pending; refusing to call the provider');
        }
        if (sendInFlight) {
          throw new CrqWireRefusal('a provider send is already in flight');
        }
        sendInFlight = true;
        let result: LanguageModelV4GenerateResult;
        try {
          result = await doGenerate();
        } catch (err) {
          sendInFlight = false;
          // Provider failure: one explicit unknown outcome; a failure of THIS write
          // propagates with the pending ack already closed (no second report).
          await reportOutcomeOnce('unknown', null, null, err instanceof Error ? err.name : 'unknown');
          throw err;
        }
        sendInFlight = false;
        const usage = usageOf(result);
        // A fully measured usage is `completed`; an incomplete one is `unknown`, so
        // the local gate stops the next send rather than inventing acceptance.
        const kind: CrqWireOutcomeKind = usage.total === null ? 'unknown' : 'completed';
        await reportOutcomeOnce(kind, usage, result.finishReason?.unified ?? null, null);
        return result;
      },
      // Streaming has no finish-time usage observation on this surface yet: refuse
      // BEFORE dispatch so a still-running stream is never returned after its
      // outcome was declared done. (Local charge known, no send, no refund.)
      wrapStream: () => {
        throw new CrqWireRefusal('the CRQ wire adapter does not support streaming; refusing before dispatch');
      },
    };
    return wrapLanguageModel({ model: inner, middleware });
  }

  return {
    reserve,
    repairStage,
    wrapModel,
  };
}
