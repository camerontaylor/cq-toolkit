// The composed CRQ per-wire adapter for the CQ ai-sdk lane — C2 composition.
//
// ONE operator-injected object owns all three seams the driver needs, so the SAME
// per-role-attempt state drives the ceiling hook, the bounded repair stage and the
// per-attempt outcome reporting:
//
//   reserve(receipt)      the ceiling's `onBeforeWireReserve` hook: validate the
//                         C1 canonical protocol/bytes/digest carried by the
//                         receipt, then durably reserve on the concerned host
//                         BEFORE the wire. The host ack is authoritative; the
//                         sender's token numbers are never authority.
//   repairStage           the ONE bounded repair stage (sync enter/exit).
//   wrapModel(model)      wrap the resolved model BELOW the pre-request ceiling,
//                         so wrapGenerate/wrapStream observe ONLY actual acked
//                         provider attempts — never a ceiling-refused no-send.
//
// FAIL CLOSED: no injected authenticated transport -> refuse; a transport that
// cannot independently attest the host peer -> refuse; a receipt whose canonical
// document does not re-hash to its own digest, or whose protocol/domain is not the
// C1 one -> refuse; a host refusal, a missing/stale/unbound ack, or an abort ->
// refuse (the local conservative charge is NOT refunded). No ack/sequence/ordinal
// is ever supplied by the driver.
//
// FIELD NAMES: the CRQ host (author 723) owns the reserve/outcome wire shape. The
// names below are the modularly-ruled ones (`attempt_ref` positive host-issued int,
// opaque `wire_ordinal`, no `logical_attempt_id`); a single relay of the full shape
// finalizes them without touching the logic.
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { canonicalProjectionDigestOf, CANONICAL_PROJECTION_PROTOCOL } from './canonical-projection.js';
import type { WireReservation } from './pre-request-ceiling.js';
import {
  CrqWireRefusal,
  type CrqCanonicalEncoder,
  type CrqWireAck,
  type CrqWireIdentity,
  type CrqWireOutcomeKind,
  type CrqWireTransport,
  type CrqWireUsage,
} from './crq-wire-wrapper.js';

const HEX_LOWER_EVEN = /^(?:[0-9a-f]{2})+$/;

/** The bounded repair stage, owned by the adapter (sync enter/exit). */
export interface StrictTokenWireRepairStage {
  enter(): void;
  exit(): void;
}

/**
 * The single operator-injected per-wire adapter. The SAME instance backs the hook,
 * the stage and the model wrapping, so its per-role-attempt state is shared.
 */
export interface StrictTokenWireAdapter {
  /** The ceiling's `onBeforeWireReserve` hook (fail closed; no refund on refusal). */
  readonly reserve: (reservation: WireReservation) => Promise<void>;
  /** The ONE bounded repair stage for this role attempt. */
  readonly repairStage: StrictTokenWireRepairStage;
  /** Wrap the resolved model BELOW the pre-request ceiling. */
  wrapModel(model: LanguageModel): LanguageModel;
}

export interface CrqWireAdapterOptions {
  /** The activation identity this adapter is bound to. */
  readonly identity: CrqWireIdentity;
  /** The provider/model the run resolved (host-validated against the role). */
  readonly provider: string;
  readonly model: string;
  /** The authenticated transport. ABSENT -> every wire refuses (fail closed). */
  readonly transport?: CrqWireTransport;
  /**
   * An optional C1 canonical encoder. It is NOT required to re-encode a projection
   * (the receipt carries no projection object): when present its protocol/version
   * are cross-checked; the canonical bytes/digest themselves always come from the
   * RECEIPT and are validated with `canonicalProjectionDigestOf` here.
   */
  readonly encoder?: CrqCanonicalEncoder;
}

/** Map one provider attempt's usage to the host usage shape; unmeasured -> null. */
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
    actualInput === undefined && completion === undefined
      ? null
      : (actualInput ?? 0) + (completion ?? 0);
  return {
    actualInput: typeof actualInput === 'number' ? actualInput : null,
    cacheHit: typeof cacheHit === 'number' ? cacheHit : null,
    cacheMiss: typeof cacheMiss === 'number' ? cacheMiss : null,
    completion: typeof completion === 'number' ? completion : null,
    visible: typeof visible === 'number' ? visible : null,
    reasoning: typeof reasoning === 'number' ? reasoning : null,
    total,
  };
}

/**
 * Build the composed adapter. One instance per role attempt.
 */
export function createCrqWireAdapter(options: CrqWireAdapterOptions): StrictTokenWireAdapter {
  const { identity, provider, model } = options;

  let sessionId: string | null = null;
  /** The POSITIVE host-issued attempt reference (never a client invention). */
  let attemptRef: number | null = null;
  /** An opaque per-attempt wire label the sender may set; never an authority. */
  let wireOrdinal = 0;
  let lastAck: CrqWireAck | null = null;
  /** The ack whose outcome is still pending (exactly one in flight). */
  let pendingAck: number | null = null;
  const outcomeStatus = new Map<number, CrqWireOutcomeKind>();
  let repairStageActive = false;
  let repairStageCompleted = false;

  function transportOrRefuse(): CrqWireTransport {
    if (options.transport === undefined) {
      throw new CrqWireRefusal('the CRQ wire requires an injected authenticated transport');
    }
    if (options.encoder !== undefined) {
      if (
        options.encoder.protocol !== CANONICAL_PROJECTION_PROTOCOL ||
        options.encoder.version !== 1
      ) {
        throw new CrqWireRefusal('the injected canonical encoder is not the C1 protocol');
      }
    }
    return options.transport;
  }

  /** Validate the C1 canonical document carried by a receipt; return its hex bytes. */
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
    if (typeof bytesHex !== 'string' || !HEX_LOWER_EVEN.test(bytesHex)) {
      throw new CrqWireRefusal('the receipt canonical bytes are not a bounded lowercase hex document');
    }
    const actual = canonicalProjectionDigestOf(Buffer.from(bytesHex, 'hex'));
    if (actual !== digest) {
      throw new CrqWireRefusal('the receipt canonical bytes do not re-hash to its own digest');
    }
    return { protocol, bytesHex, digest };
  }

  async function ensureSession(): Promise<{ sessionId: string; attemptRef: number }> {
    const transport = transportOrRefuse();
    if (sessionId !== null && attemptRef !== null) return { sessionId, attemptRef };
    const attested = await transport.attestHost();
    if (attested !== true) {
      throw new CrqWireRefusal('the transport could not independently attest the host peer; refusing');
    }
    const ready = (await transport.hello(identity, provider, model)) as {
      sessionId?: unknown;
      attemptRef?: unknown;
    };
    if (typeof ready.sessionId !== 'string' || ready.sessionId.length === 0) {
      throw new CrqWireRefusal('the host returned no session id');
    }
    if (!Number.isSafeInteger(ready.attemptRef) || (ready.attemptRef as number) < 1) {
      throw new CrqWireRefusal('the host returned no positive attempt reference');
    }
    sessionId = ready.sessionId;
    attemptRef = ready.attemptRef as number;
    return { sessionId, attemptRef };
  }

  const reserve = async (receipt: WireReservation): Promise<void> => {
    const transport = transportOrRefuse();
    const canonical = validateReceiptCanonical(receipt);
    // The REAL reserved output comes from the receipt, never a placeholder.
    if (!Number.isSafeInteger(receipt.reserveOutputTokens) || receipt.reserveOutputTokens < 1) {
      throw new CrqWireRefusal('the receipt carries no usable reserved output ceiling');
    }
    const { sessionId: session, attemptRef: attempt } = await ensureSession();
    // LOCAL GATE: continuation requires the prior wire's ACCEPTED outcome.
    if (lastAck !== null && outcomeStatus.get(lastAck.ackSequence) !== 'completed') {
      throw new CrqWireRefusal('the prior wire has no accepted outcome; refusing a new send');
    }
    const ordinal = `w${(wireOrdinal += 1)}`;
    const repairing = repairStageActive && lastAck !== null;
    const message: Record<string, unknown> = {
      method: 'reserve',
      session_id: session,
      attempt_ref: attempt,
      wire_ordinal: ordinal,
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
      // The canonical document is sent VERBATIM from the receipt (receiver strict
      // decode + independent meter authority); no re-encoding, no token claims.
      canonical: { protocol: canonical.protocol, version: 1, digest: canonical.digest, bytes: canonical.bytesHex },
      wire_output_ceiling: receipt.reserveOutputTokens,
      supersedes_ack_sequence: lastAck === null ? null : lastAck.ackSequence,
      kind: repairing ? 'repair' : identity.role.startsWith('judge') ? 'judge' : 'fixer',
      repair_of_ack_sequence: repairing ? (lastAck?.ackSequence ?? null) : null,
    };
    const reply = (await transport.reserve(message)) as CrqWireAck | { refused: string };
    if (!('ackSequence' in reply)) {
      throw new CrqWireRefusal(`the host refused the wire: ${String((reply as { refused: string }).refused)}`);
    }
    if (
      reply.ackSequence === undefined ||
      !Number.isSafeInteger(reply.ackSequence) ||
      reply.ackSequence < 1
    ) {
      throw new CrqWireRefusal('the host acknowledgement carries no positive ack sequence');
    }
    if (
      typeof reply.remainingMilliseconds !== 'number' ||
      !Number.isSafeInteger(reply.remainingMilliseconds) ||
      reply.remainingMilliseconds <= 0
    ) {
      throw new CrqWireRefusal('the host acknowledgement carries no usable remaining time');
    }
    lastAck = reply;
    pendingAck = reply.ackSequence;
  };

  const reportOutcome = async (
    kind: CrqWireOutcomeKind,
    usage: CrqWireUsage | null,
    stopReason: string | null,
    errorClass: string | null,
  ): Promise<void> => {
    const transport = options.transport;
    if (transport === undefined) throw new CrqWireRefusal('no authenticated transport is injected');
    if (pendingAck === null) throw new CrqWireRefusal('no acknowledged wire call to report an outcome for');
    const ack = pendingAck;
    const repairing = repairStageActive;
    await transport.outcome({
      method: 'outcome',
      session_id: sessionId,
      attempt_ref: attemptRef,
      wire_ordinal: `w${wireOrdinal}`,
      ack_sequence: ack,
      outcome: kind,
      usage,
      stop_reason: stopReason,
      error_class: errorClass,
      repair_of_ack_sequence: repairing ? ack : null,
    });
    outcomeStatus.set(ack, kind);
    pendingAck = null;
  };

  const repairStage: StrictTokenWireRepairStage = {
    enter(): void {
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
    exit(): void {
      if (repairStageActive) {
        repairStageActive = false;
        repairStageCompleted = true;
      }
    },
  };

  function wrapModel(inner: LanguageModel): LanguageModel {
    if (typeof inner === 'string') {
      throw new CrqWireRefusal('the CRQ wire adapter requires a resolved language-model instance');
    }
    const middleware: LanguageModelMiddleware = {
      // BELOW the ceiling: this runs only for an ACTUAL provider attempt, after the
      // ceiling's transformParams has reserved (or refused). No transformParams here.
      wrapGenerate: async ({ doGenerate }) => {
        try {
          const result = await doGenerate();
          await reportOutcome('completed', usageOf(result), result.finishReason?.unified ?? null, null);
          return result;
        } catch (err) {
          // An errored/aborted attempt reports an EXPLICIT outcome (unknown usage),
          // never a guessed zero, and never blocks the next send silently.
          await reportOutcome('unknown', null, null, err instanceof Error ? err.name : 'unknown');
          throw err;
        }
      },
      wrapStream: async ({ doStream }) => {
        try {
          const result = await doStream();
          // Streaming settles usage only at the end of the stream; report the
          // attempt as completed-unknown-usage so the host can decide.
          await reportOutcome('unknown', null, null, null);
          return result;
        } catch (err) {
          await reportOutcome('unknown', null, null, err instanceof Error ? err.name : 'unknown');
          throw err;
        }
      },
    };
    return wrapLanguageModel({ model: inner, middleware });
  }

  return { reserve, repairStage, wrapModel };
}
