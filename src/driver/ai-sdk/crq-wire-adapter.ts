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
  toWireUsage,
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
  /** The POSITIVE host-issued attempt reference (never client-manufactured). */
  let attemptRef: number | null = null;
  let messageId = 0;
  let lastAck: CrqWireAck | null = null;
  /** The one ack whose outcome is pending; null when no wire is un-reported. */
  let pendingAck: number | null = null;
  /** The OPAQUE host wire ordinal (never client-made) is validated on the reserved
   * ack only: the strict OUTCOME client frame carries NO ordinal field. */
  /** The PRIOR ack a pending repair supersedes (immutable per-wire context). */
  let pendingRepairOf: number | null = null;
  /** True while a durable reserve is in flight; no second reserve may interleave. */
  let reserving = false;
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

  async function ensureSession(): Promise<{ sessionId: string; attemptRef: number }> {
    const transport = requireTransport();
    if (sessionId !== null && attemptRef !== null) return { sessionId, attemptRef };
    const attested = await transport.attestHost();
    if (attested !== true) {
      throw new CrqWireRefusal('the transport could not independently attest the host peer; refusing');
    }
    const ready = await transport.hello(identity, provider, model);
    if (typeof ready.sessionId !== 'string' || ready.sessionId.length === 0) {
      throw new CrqWireRefusal('the host returned no session id');
    }
    if (!Number.isSafeInteger(ready.attemptRef) || ready.attemptRef < 1) {
      throw new CrqWireRefusal('the host returned no positive attempt reference');
    }
    if (!Number.isSafeInteger(ready.remainingMilliseconds) || ready.remainingMilliseconds <= 0) {
      throw new CrqWireRefusal('the host returned no usable remaining time');
    }
    // The hello ready MAY announce the first wire ordinal; it is informational only
    // (the host ordinal is validated on each reserved ack) and is never echoed by
    // the client in an OUTCOME frame.
    if (
      ready.wireOrdinal !== undefined &&
      (typeof ready.wireOrdinal !== 'string' || ready.wireOrdinal.length === 0)
    ) {
      throw new CrqWireRefusal('the host session ready carries no usable wire ordinal');
    }
    sessionId = ready.sessionId;
    attemptRef = ready.attemptRef;
    return { sessionId, attemptRef };
  }

  const reserve = async (receipt: WireReservation): Promise<void> => {
    const transport = requireTransport();
    // The lock is taken BEFORE the first await: session establishment and the
    // durable reserve are one critical section, so two interleaved reserves can
    // never both pass the state checks and overwrite each other's ack.
    if (reserving) {
      throw new CrqWireRefusal('a durable reservation is already in flight; refusing a concurrent reserve');
    }
    if (sendInFlight) {
      throw new CrqWireRefusal('a provider send is already in flight; refusing a concurrent reserve');
    }
    const canonical = validateReceiptCanonical(receipt);
    if (!Number.isSafeInteger(receipt.reserveOutputTokens) || receipt.reserveOutputTokens < 1) {
      throw new CrqWireRefusal('the receipt carries no usable reserved output ceiling');
    }
    reserving = true;
    try {
      const session = await ensureSession();
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
        session_id: session.sessionId,
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
        // The positive HOST-issued attempt reference; the host owns the wire ordinal.
        attempt_ref: session.attemptRef,
        wire_output_ceiling: receipt.reserveOutputTokens,
        supersedes_ack_sequence: priorAck === null ? 0 : priorAck,
        kind: repairing ? 'repair' : identity.role.startsWith('judge') ? 'judge' : 'fixer',
        repair_of_ack_sequence: repairing ? priorAck : null,
      };
      const reply = await transport.reserve(message);
      if (!('ackSequence' in reply)) {
        throw new CrqWireRefusal(`the host refused the wire: ${reply.refused}`);
      }
      // Bind ONLY the typed ack contract (no invented fields, no casts).
      if (reply.messageId !== nextMessageId) {
        throw new CrqWireRefusal('the host acknowledgement does not echo this message id');
      }
      if (reply.sessionId !== session.sessionId) {
        throw new CrqWireRefusal('the host acknowledgement does not bind this session');
      }
      if (reply.attemptRef !== session.attemptRef) {
        throw new CrqWireRefusal('the host acknowledgement does not echo the attempt reference');
      }
      if (typeof reply.wireOrdinal !== 'string' || reply.wireOrdinal.length === 0) {
        throw new CrqWireRefusal('the host acknowledgement carries no host wire ordinal');
      }
      if (reply.requestSha256 !== canonical.digest) {
        throw new CrqWireRefusal(
          'the host acknowledgement does not echo the canonical request digest',
        );
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
    } finally {
      reserving = false;
    }
  };

  /**
   * Report the outcome of the acknowledged wire EXACTLY ONCE and return the host's
   * terminal `stopped` reason. The pending ack is closed BEFORE the outcome await,
   * so a failed outcome write leaves the wire terminal (no second report) and never
   * re-uses the ack. A non-null `stopped` is the host's stop incident: the caller
   * MUST surface it instead of settling the attempt.
   */
  async function reportOutcomeOnce(
    kind: CrqWireOutcomeKind,
    usage: CrqWireUsage | null,
    stopReason: string | null,
    errorClass: string | null,
  ): Promise<string | null> {
    const transport = requireTransport();
    if (pendingAck === null) {
      throw new CrqWireRefusal('no acknowledged wire call to report an outcome for');
    }
    const ack = pendingAck;
    const repairOf = pendingRepairOf;
    pendingAck = null;
    pendingRepairOf = null;
    messageId += 1;
    const outcomeMessageId = messageId;
    const reply = await transport.outcome({
      method: 'outcome',
      session_id: sessionId,
      message_id: outcomeMessageId,
      attempt_ref: attemptRef,
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
      // The EXACT snake_case host usage shape at the wire boundary.
      usage: usage === null ? null : toWireUsage(usage),
      stop_reason: stopReason,
      error_class: errorClass,
      repair_of_ack_sequence: repairOf,
    });
    // Mandatory terminal-reply validation: the reply must BE an outcome frame, echo
    // the reported kind, bind THIS wire, and a non-null `stopped` is terminal even for
    // a `completed` frame, so it can never confer a locally accepted status.
    if (reply.method !== 'outcome') {
      throw new CrqWireRefusal('the host outcome reply is not an outcome frame');
    }
    if (reply.outcome !== kind) {
      throw new CrqWireRefusal(
        'the host outcome reply does not echo the reported outcome kind',
      );
    }
    if (
      reply.sessionId !== sessionId ||
      reply.messageId !== outcomeMessageId ||
      reply.attemptRef !== attemptRef ||
      reply.ackSequence !== ack
    ) {
      throw new CrqWireRefusal('the host outcome reply does not bind this wire');
    }
    outcomeStatus.set(ack, reply.stopped === null ? kind : 'unknown');
    return reply.stopped;
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

  function wrapModel(model: LanguageModel): LanguageModel {
    // `ProviderFactory` resolves to a live model instance, never a gateway
    // string; the runtime check makes that explicit (and narrows the type without
    // a cast) — a string here would make the strict wire meaningless.
    if (typeof model === 'string') {
      throw new CrqWireRefusal(
        'the strict wire adapter wraps a resolved language-model instance, not a gateway model id',
      );
    }
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
          // propagates with the pending ack already closed (no second report). The
          // ORIGINAL provider error is preserved: a host stop reported alongside a
          // provider failure never replaces the provider's own error here.
          await reportOutcomeOnce('unknown', null, null, err instanceof Error ? err.name : 'unknown');
          throw err;
        }
        sendInFlight = false;
        const usage = usageOf(result);
        // A fully measured usage is `completed`; an incomplete one is `unknown`, so
        // the local gate stops the next send rather than inventing acceptance.
        const kind: CrqWireOutcomeKind = usage.total === null ? 'unknown' : 'completed';
        const stopped = await reportOutcomeOnce(
          kind,
          usage,
          result.finishReason?.unified ?? null,
          null,
        );
        // A LOCALLY computed `unknown` (an incomplete measurement) is its own refusal:
        // the attempt must NOT return an accepted payload, even when the injected
        // transport wrongly answers `stopped: null`. The outcome was already reported
        // exactly once and the charge is kept; no second outcome is sent.
        if (kind !== 'completed') {
          throw new CrqWireRefusal(
            'the wire outcome is unknown: the attempt is not an accepted payload',
          );
        }
        // The host's terminal stop incident OUTRANKS the provider's own successful
        // reply: the charge is kept and the outcome is already closed, but the
        // attempt must NOT settle as an accepted payload. No second outcome is sent.
        if (stopped !== null) {
          throw new CrqWireRefusal(`the host stopped this wire: ${stopped}`);
        }
        return result;
      },
      // Streaming has no finish-time usage observation on this surface yet. The wire
      // was already reserved (charged); report an explicit OUTCOME=refused with a
      // no-send stop_reason — the host outcome enum has NO extra kind, and the C5
      // known_no_send fact is host-side evidence, not a new wire enum. doStream is
      // NEVER called and a still-running stream is never returned.
      wrapStream: async () => {
        if (pendingAck !== null) {
          await reportOutcomeOnce('refused', null, 'no-send', null);
        }
        throw new CrqWireRefusal('the CRQ wire adapter does not support streaming; refusing before dispatch');
      },
    };
    return wrapLanguageModel({ model, middleware });
  }

  return {
    reserve,
    repairStage,
    wrapModel,
  };
}
