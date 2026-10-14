// The ai-sdk lane's STRICT pre-request token ceiling — the opt-in that makes
// `Budget.strictTokenBudget` real. It sits on the SDK's model-middleware seam
// (`wrapLanguageModel`).
//
// RETRY RE-ENTRY — VERIFIED, NOT ASSUMED. In the installed ai@7.0.99 source
// (`node_modules/ai/dist/index.js`), `generateText` runs its per-step call as
// `currentModelResponse = await retry(async () => … await stepModel.doGenerate(
// {…}))`, and `stepModel = resolveLanguageModel(prepareStepResult?.model ??
// model)`. The driver builds no `prepareStep.model`, so `stepModel` is exactly
// the model handed to `generateText` — i.e. the `wrapLanguageModel` wrapper.
// The SDK retry loop is therefore OUTSIDE the middleware and re-enters it once
// per attempt, before each wire send. This module adds no retry of its own, so
// no attempt escapes the wrapper and none is counted twice. The driver test
// suite pins this by observing `requestCount === 2` across one SDK retry.
//
// CAPABILITY — INJECTED, NEVER INFERRED. There is NO built-in provider list
// and NO auto-enable. The counting and the output-ceiling behavior come from
// a `StrictTokenCapability` the OPERATOR injects (AiSdkDriverOptions.
// strictTokenCapability). If none is configured, `Budget.strictTokenBudget`
// REFUSES the run before dispatch. The presence of operator-supplied metering
// code — not a provider name, string or boolean — is the trust anchor, so a
// self-asserted label can never activate the ceiling. `provenance` exists for
// logs only and is never emitted with request content.
//
// WHAT THE CAPABILITY RECEIVES. `count` gets a DETERMINISTIC serialization of
// the full normalized request: the prompt (system + messages + history), the
// tool surface, the response format, the sampling/token settings and
// `providerOptions` (provider-specific prompt/prediction/instructions). It
// EXCLUDES `headers` (credentials are never serialized or logged) and the
// non-serializable `abortSignal`. A shape JSON cannot represent (a cycle, a
// bigint/function/symbol, a non-finite number) REFUSES the request rather than
// under-counting it. The count is taken AFTER the output ceiling is applied,
// over the exact params that will be sent, so a capability that mutates
// tokenizable data in `withOutputCeiling` is still counted.
//
// INTEGER SAFETY. Counts, caps and the whole-job allowance must be SAFE
// integers (`Number.isSafeInteger`); a value beyond 2^53−1 fails closed at the
// boundary and at every addition, so a precision-drifted cap can never widen
// the bound silently. A capability that cannot faithfully bound a request
// shape must THROW, never under-count — the throw is refused before the wire.
//
// SHARED WHOLE-JOB ALLOWANCE — BRIDGE IS EXPLICIT, AND INCOMPLETE. When the
// governing gate supplies `RunOptions.reservation.tokens`, the cumulative
// reservation over this run must fit inside it. That cumulative is
// PER-INVOCATION: it is not reset mid-run, but a NEW invocation starts at zero,
// so without an external ledger the allowance is consumed locally only. The
// `onBeforeWireReserve` hook is the explicit, durable pre-wire reservation
// point an out-of-process ledger (CRQ) must implement; it is exposed through
// `AiSdkDriverOptions.strictTokenReservationHook` /
// `DriverFactoryConfig.lanes.aiSdk.strictTokenReservationHook`, and its receipt
// carries the model identity plus a TS-LOCAL `countableProjectionDigest`
// (sha256 over the countable projection only, excluding headers/abortSignal).
// That digest is NOT the Python `token_guard.request_sha256` canonical form
// and is NOT a whole-wire digest, so an external ledger CANNOT bind it. A
// shared cross-language canonical projection protocol does not exist and is an
// ACTIVATION BLOCKER for the external bridge. The driver supplies NO hook by
// default, so cross-invocation whole-job enforcement remains a NAMED GAP, not
// a claim.
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createHash } from 'node:crypto';
import type { ModelSpec, StrictTokenBudget } from '../types.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Injected capability
// ---------------------------------------------------------------------------

/**
 * An operator-supplied, trusted capability for the strict pre-request ceiling.
 * Supplied by a deployment that has proof for the served model's tokenizer and
 * output-cap wire behavior; there is no default and no built-in provider list.
 * The driver refuses `Budget.strictTokenBudget` when no capability is
 * configured for the run's model.
 */
export interface StrictTokenCapability {
  /** Display-only label. NEVER an activation gate and never logged with request content. */
  readonly provenance: string;
  /**
   * Count (or a proven conservative upper bound on) the tokens of one
   * serialized request. A shape the capability cannot bound must THROW, never
   * under-count.
   */
  count(serialized: string): number;
  /**
   * Apply the reserved output/reasoning ceiling to the request and return the
   * params to send. The returned params MUST carry `maxOutputTokens` at or
   * below the reserve; the ceiling counts the returned params and verifies the
   * ceiling before committing the reservation.
   */
  withOutputCeiling(
    params: LanguageModelV4CallOptions,
    reserveOutputTokens: number,
  ): LanguageModelV4CallOptions;
}

// ---------------------------------------------------------------------------
// Serialization + refusal
// ---------------------------------------------------------------------------

/** A request shape JSON cannot represent — refused rather than under-counted. */
export class UnrepresentableRequestError extends Error {
  constructor(detail: string) {
    super(`ai-sdk driver: strict token ceiling cannot represent this request — ${detail}`);
    this.name = 'UnrepresentableRequestError';
  }
}

/**
 * Recursively freeze a JSON-ish cloned value. Only the counted fields are run
 * through this; `abortSignal` and `headers` stay live references (see
 * {@link snapshotPreparedRequest}).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** The fields counted and therefore cloned + frozen into the snapshot. */
const COUNTED_FIELDS = [
  'prompt',
  'tools',
  'toolChoice',
  'responseFormat',
  'providerOptions',
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'reasoning',
] as const;

/**
 * A DETACHED, DEEP-FROZEN snapshot of the request that will be sent. The
 * counted fields are deep-cloned and deep-frozen, so a caller mutating the
 * original params (or the object `withOutputCeiling` returned) after `reserve`
 * starts — including during the durable-hook await — cannot change what the
 * wire receives under the already-taken count. `abortSignal` and `headers`
 * keep their live REFERENCES (an AbortSignal is an event source, and headers
 * are never counted or serialized — no credentials enter the digest); only the
 * counted fields are cloned. A value `structuredClone` cannot clone refuses the
 * request as unrepresentable.
 */
function snapshotPreparedRequest(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const source: Record<string, unknown> = {};
  for (const key of COUNTED_FIELDS) {
    const value = (params as unknown as Record<string, unknown>)[key];
    if (value !== undefined) source[key] = value;
  }
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(source);
  } catch (err) {
    throw new UnrepresentableRequestError(err instanceof Error ? err.message : String(err));
  }
  deepFreeze(cloned);
  // Spread the original first (keeps abortSignal/headers references and any
  // uncounted fields), then overwrite the counted fields with the frozen clone.
  return Object.freeze({ ...params, ...cloned }) as LanguageModelV4CallOptions;
}

/**
 * Replacer that fails closed on values JSON would silently drop (functions,
 * symbols) or cannot represent (bigint, non-finite numbers, cycles — cycles
 * make `JSON.stringify` throw anyway).
 */
function failClosedReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) return value;
  const kind = typeof value;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new UnrepresentableRequestError(`a ${kind} value is not representable`);
  }
  if (kind === 'number' && !Number.isFinite(value as number)) {
    throw new UnrepresentableRequestError('a non-finite number is not representable');
  }
  return value;
}

/**
 * The driver's COUNTABLE PROJECTION — the deterministic serialization handed
 * to a capability's `count` and the byte stream the
 * `countableProjectionDigest` is taken over. It carries every tokenizable
 * field of the normalized request — prompt (system + messages + history),
 * tools, tool choice, response format, sampling/token settings and
 * providerOptions — in a fixed key order. It DELIBERATELY EXCLUDES `headers`
 * (credentials never enter the counted text, the digest, or any log),
 * `abortSignal` (non-serializable) and `includeRawChunks`: it is NOT a
 * whole-wire serialization. Throws {@link UnrepresentableRequestError} on a
 * shape JSON cannot represent.
 */
export function serializeRequestForCounting(params: LanguageModelV4CallOptions): string {
  const countable = {
    prompt: params.prompt,
    tools: params.tools ?? null,
    toolChoice: params.toolChoice ?? null,
    responseFormat: params.responseFormat ?? null,
    providerOptions: params.providerOptions ?? null,
    maxOutputTokens: params.maxOutputTokens ?? null,
    temperature: params.temperature ?? null,
    topP: params.topP ?? null,
    topK: params.topK ?? null,
    presencePenalty: params.presencePenalty ?? null,
    frequencyPenalty: params.frequencyPenalty ?? null,
    stopSequences: params.stopSequences ?? null,
    seed: params.seed ?? null,
    reasoning: params.reasoning ?? null,
  };
  try {
    // A build-side cycle or bigint throws here; the replacer catches the rest.
    return JSON.stringify(countable, failClosedReplacer);
  } catch (err) {
    if (err instanceof UnrepresentableRequestError) throw err;
    throw new UnrepresentableRequestError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What a pre-wire refusal MEANS for the run's verdict:
 *   - `budget` — a REAL token cap was exceeded (the request would genuinely
 *     overspend the input ceiling, the output reserve, or the shared
 *     whole-job allowance). Settles `stopReason: 'budget'`.
 *   - `error`  — a local infrastructure/capability/serialization/durable-hook
 *     failure. This is NOT budget exhaustion; hiding it as `'budget'` (which
 *     ops surface as `budget-exhausted`) would misreport a broken hook or
 *     capability as a spender. Settles a diagnostic `stopReason: 'error'`.
 */
export type PreRequestCeilingRefusalKind = 'budget' | 'error';

/** Why a request was refused before the wire send. */
export type PreRequestCeilingRefusalReason =
  /** The counted input of this request exceeds `maxInputTokens`. */
  | 'input-ceiling'
  /** The request would carry an output ceiling above `reserveOutputTokens`. */
  | 'output-reserve'
  /** The request's own output ceiling is not a safe positive integer (a malformed request). */
  | 'output-ceiling-invalid'
  /** The capability did not apply a valid output ceiling at or below the reserve. */
  | 'output-ceiling-not-applied'
  /** The request or its serialization cannot be represented/counted. */
  | 'unrepresentable-request'
  /** The capability's count was not a safe non-negative integer. */
  | 'uncountable-request'
  /** An integer addition would exceed the safe range (precision drift). */
  | 'reservation-overflow'
  /** The cumulative reservation would exceed the shared whole-job allowance. */
  | 'whole-job-allowance'
  /** The durable external reservation hook refused or failed. */
  | 'reservation-not-written'
  /** The prepared request changed after the durable reservation (defense in depth). */
  | 'request-mutated';

/**
 * The ONLY reasons that mean a genuine token cap was exceeded. Every other
 * reason is a local infrastructure failure and MUST settle an error verdict,
 * never `budget` (V1Gf). Keep this the single source of truth: the class field
 * and any caller test derive from it.
 */
const BUDGET_REFUSAL_REASONS: ReadonlySet<PreRequestCeilingRefusalReason> = new Set([
  'input-ceiling',
  'output-reserve',
  'whole-job-allowance',
]);

/** The {@link PreRequestCeilingRefusalKind} a reason maps to. */
function refusalKindOf(reason: PreRequestCeilingRefusalReason): PreRequestCeilingRefusalKind {
  return BUDGET_REFUSAL_REASONS.has(reason) ? 'budget' : 'error';
}

/**
 * A pre-wire refusal from the ceiling. A plain `Error` subclass so the SDK's
 * retry classifier (`shouldRetry` accepts only retryable APICallErrors /
 * GatewayErrors) never retries it; the driver maps a genuine cap
 * ({@link kind} `'budget'`) to stopReason `budget`, and every local
 * infrastructure/capability/serialization/durable-hook failure
 * ({@link kind} `'error'`) to a diagnostic `stopReason: 'error'` — never
 * hidden as budget-exhausted (V1Gf).
 */
export class PreRequestCeilingRefusal extends Error {
  readonly reason: PreRequestCeilingRefusalReason;
  /** Whether this refusal is a real budget cap or a local infrastructure failure. */
  readonly kind: PreRequestCeilingRefusalKind;
  readonly countedInput: number;
  readonly reserved: number;
  readonly cumulativeReserved: number;

  constructor(
    reason: PreRequestCeilingRefusalReason,
    message: string,
    evidence: { countedInput: number; reserved: number; cumulativeReserved: number },
  ) {
    super(`ai-sdk driver: strict token ceiling refused the request (${reason}) — ${message}`);
    this.name = 'PreRequestCeilingRefusal';
    this.reason = reason;
    this.kind = refusalKindOf(reason);
    this.countedInput = evidence.countedInput;
    this.reserved = evidence.reserved;
    this.cumulativeReserved = evidence.cumulativeReserved;
  }
}

/** Narrowing guard for {@link PreRequestCeilingRefusal}. */
export function isPreRequestCeilingRefusal(value: unknown): value is PreRequestCeilingRefusal {
  return value instanceof PreRequestCeilingRefusal;
}

/**
 * An abort-shaped error (name `AbortError`) that the driver's cancellation
 * corridor (I8) settles as `stopReason: 'aborted'` — the ceiling never turns a
 * governed cancellation into a budget/infra refusal. The live `signal.reason`
 * is reused when it is an Error, so the caller's own abort cause survives.
 */
function abortRefusal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('ai-sdk driver: strict token ceiling cancelled before the wire send');
  err.name = 'AbortError';
  return err;
}

/**
 * Await `work`, but reject as soon as `signal` aborts (V1GX). The abort
 * listener is ALWAYS removed, and a LATE rejection/resolution of `work` is
 * consumed (never left unhandled, never returned to the wire): once the race
 * settles on abort, an orphaned hook can no longer produce params for send.
 */
function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // Consume any later rejection of the already-orphaned work.
    void work.catch(() => {});
    return Promise.reject(abortRefusal(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortRefusal(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

/**
 * The reservation a gate must durably record BEFORE the wire send. The hook is
 * the explicit bridge to an out-of-process whole-job ledger; the driver ships
 * none, so `cumulativeTokens` is per-invocation unless the operator supplies
 * one.
 */
export interface WireReservation {
  /** This request's reservation: counted input + reserved output. */
  readonly tokens: number;
  /** Cumulative reservation over this invocation, including this request. */
  readonly cumulativeTokens: number;
  /** The counted input of this request. */
  readonly countedInput: number;
  /** The output/reasoning reserve applied to this request. */
  readonly reserveOutputTokens: number;
  /** The provider handle the run resolved (from the run's ModelSpec). */
  readonly provider: string;
  /** The model id the run resolved (from the run's ModelSpec). */
  readonly model: string;
  /**
   * TS-LOCAL COUNTABLE-PROJECTION sha256 (hex): the digest of this driver's
   * countable projection only — the fixed-order JSON of prompt, tools,
   * toolChoice, responseFormat, providerOptions and the sampling/token
   * settings, UTF-8. It EXCLUDES headers, abortSignal and includeRawChunks:
   * it is NOT a digest of the whole wire request and carries no credentials.
   *
   * It is NOT the Python `token_guard.request_sha256` (canonical sorted-ASCII
   * JSON), NOT a whole-wire digest, and NOT interoperable with any external
   * ledger. A shared cross-language canonical projection protocol does not
   * exist yet, so an external bridge CANNOT bind this value as a
   * request_sha256 — that canonical protocol is an ACTIVATION BLOCKER for the
   * external bridge. Use it only as a TS-local identity for the frozen
   * snapshot the count was taken over.
   */
  readonly countableProjectionDigest: string;
}

/** Construction inputs for one run's ceiling. */
export interface PreRequestCeilingOptions {
  /** The invocation's opt-in capability (both fields required, both > 0). */
  readonly budget: StrictTokenBudget;
  /** The operator-injected trusted capability for the run's model. */
  readonly capability: StrictTokenCapability;
  /**
   * The run's resolved model identity, carried into every receipt. Optional on
   * the class so unit tests can omit it; the driver ALWAYS supplies it.
   */
  readonly modelSpec?: ModelSpec;
  /**
   * The shared whole-job token allowance from the governing gate's reservation
   * (`RunOptions.reservation.tokens`), when one was supplied. The cumulative
   * reservation over this run must fit inside it. Absent = no shared
   * allowance; the per-request ceiling still binds.
   */
  readonly wholeJobTokenAllowance?: number;
  /**
   * The explicit durable pre-wire reservation point. Called after every check
   * passes and AFTER the local charge is committed (so concurrent calls cannot
   * both pass the allowance check); a throw refuses the request but does NOT
   * refund the local charge. The hook is ABORT-AWARE: it races the run's live
   * signal (`params.abortSignal`), so a hung hook settles the cancellation
   * instead of wedging the run, the local charge is kept (no refund), and no
   * params reach the wire on abort. The driver exposes it through
   * `AiSdkDriverOptions.strictTokenReservationHook`/
   * `DriverFactoryConfig.lanes.aiSdk.strictTokenReservationHook`; when absent,
   * cross-invocation whole-job enforcement is a named gap (see the header).
   */
  readonly onBeforeWireReserve?: (reservation: WireReservation) => void | Promise<void>;
}

/**
 * The per-run ceiling: counts and reserves every request before its wire
 * send, cumulatively and without refunds. One instance per `Driver.run`; the
 * tool loop and the structured-output repair share it, so the loop is
 * cumulative.
 */
export class PreRequestCeiling {
  private cumulativeReservedN = 0;
  private requestCountN = 0;

  constructor(private readonly options: PreRequestCeilingOptions) {
    const { maxInputTokens, reserveOutputTokens } = options.budget;
    if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
      throw new Error(
        `ai-sdk driver: strictTokenBudget.maxInputTokens must be a safe positive integer, got ${String(maxInputTokens)}`,
      );
    }
    if (!Number.isSafeInteger(reserveOutputTokens) || reserveOutputTokens <= 0) {
      throw new Error(
        `ai-sdk driver: strictTokenBudget.reserveOutputTokens must be a safe positive integer, got ${String(reserveOutputTokens)}`,
      );
    }
    const allowance = options.wholeJobTokenAllowance;
    if (allowance !== undefined && (!Number.isSafeInteger(allowance) || allowance < 0)) {
      throw new Error(
        `ai-sdk driver: shared whole-job token allowance must be a safe non-negative integer, got ${String(allowance)}`,
      );
    }
  }

  /** Reserved tokens over every request so far (monotonic — never refunded). */
  get reservedTokens(): number {
    return this.cumulativeReservedN;
  }

  /** Wire attempts counted so far (each SDK retry and tool-loop step re-enters). */
  get requestCount(): number {
    return this.requestCountN;
  }

  /**
   * Count + reserve one request and return the params to send, with the
   * output wire ceiling applied. Throws {@link PreRequestCeilingRefusal}
   * BEFORE the underlying `doGenerate` (and therefore before the wire send).
   *
   * CONCURRENCY: every check and the final commit run synchronously, before
   * the first `await` (the optional durable hook). Two concurrent `reserve`
   * calls therefore cannot both observe stale totals — the second sees the
   * first's committed charge. The hook runs AFTER the local commit and its
   * failure is a conservative no-refund refusal.
   */
  async reserve(params: LanguageModelV4CallOptions): Promise<LanguageModelV4CallOptions> {
    const { capability, budget, wholeJobTokenAllowance, onBeforeWireReserve, modelSpec } =
      this.options;
    // CANCELLATION OUTRANKS THE CEILING (I8 / V1GX): an already-aborted run
    // signal never counts, charges or sends — no spurious charge for an attempt
    // the governor has already cancelled.
    const signal = params.abortSignal;
    if (signal !== undefined && signal.aborted) {
      throw abortRefusal(signal);
    }
    // An existing ceiling must be a valid, honored cap that fits the reserve:
    // NaN/negative/fractional/Infinity must not slip past a `>` comparison.
    const existingCeiling = params.maxOutputTokens;
    if (existingCeiling !== undefined) {
      if (!Number.isSafeInteger(existingCeiling) || existingCeiling < 1) {
        throw this.refuse(
          'output-ceiling-invalid',
          `request output ceiling must be a safe positive integer, got ${String(existingCeiling)}`,
          0,
          0,
        );
      }
      if (existingCeiling > budget.reserveOutputTokens) {
        throw this.refuse(
          'output-reserve',
          `request output ceiling ${existingCeiling} exceeds the reserved output ${budget.reserveOutputTokens}`,
          0,
          0,
        );
      }
    }
    // APPLY the output ceiling FIRST, then count the exact prepared params, so
    // a transformer that mutates tokenizable data is still counted.
    let prepared: LanguageModelV4CallOptions;
    try {
      prepared = capability.withOutputCeiling(params, budget.reserveOutputTokens);
    } catch (err) {
      throw this.refuse(
        'output-ceiling-not-applied',
        `the capability failed to apply the output ceiling: ${errorText(err)}`,
        0,
        0,
      );
    }
    // The applied ceiling must be a REAL honored cap: a safe positive integer
    // at or below the reserve. NaN/negative/fractional/Infinity are refused.
    const appliedCeiling = prepared.maxOutputTokens;
    if (
      !Number.isSafeInteger(appliedCeiling) ||
      (appliedCeiling as number) < 1 ||
      (appliedCeiling as number) > budget.reserveOutputTokens
    ) {
      throw this.refuse(
        'output-ceiling-not-applied',
        `the capability did not apply a safe positive output ceiling at or below the reserve ${budget.reserveOutputTokens} (got ${String(appliedCeiling)})`,
        0,
        0,
      );
    }
    // Freeze a DETACHED snapshot of the request that will actually be sent,
    // then count that exact snapshot. The snapshot is built and frozen BEFORE
    // the durable-hook await, and it is what `reserve` returns, so no mutation
    // of the original params (during the await or later) can change the wire
    // payload under the taken count.
    let wireRequest: LanguageModelV4CallOptions;
    let serialized: string;
    let counted: number;
    try {
      wireRequest = snapshotPreparedRequest(prepared);
      serialized = serializeRequestForCounting(wireRequest);
      counted = capability.count(serialized);
    } catch (err) {
      if (err instanceof UnrepresentableRequestError) {
        throw this.refuse('unrepresentable-request', err.message, 0, 0);
      }
      throw this.refuse(
        'uncountable-request',
        `the capability could not count the request: ${errorText(err)}`,
        0,
        0,
      );
    }
    if (!Number.isSafeInteger(counted) || counted < 0) {
      throw this.refuse(
        'uncountable-request',
        'the counted input is not a safe non-negative integer',
        0,
        0,
      );
    }
    if (counted > budget.maxInputTokens) {
      throw this.refuse(
        'input-ceiling',
        `counted input ${counted} exceeds maxInputTokens ${budget.maxInputTokens}`,
        counted,
        counted + budget.reserveOutputTokens,
      );
    }
    if (budget.reserveOutputTokens > MAX_SAFE - counted) {
      throw this.refuse(
        'reservation-overflow',
        'input + reserve exceeds the safe integer range',
        counted,
        0,
      );
    }
    const reserved = counted + budget.reserveOutputTokens;
    if (reserved > MAX_SAFE - this.cumulativeReservedN) {
      throw this.refuse(
        'reservation-overflow',
        'the cumulative reservation would exceed the safe integer range',
        counted,
        reserved,
      );
    }
    const cumulative = this.cumulativeReservedN + reserved;
    if (wholeJobTokenAllowance !== undefined && cumulative > wholeJobTokenAllowance) {
      throw this.refuse(
        'whole-job-allowance',
        `cumulative reservation ${cumulative} exceeds the shared whole-job allowance ${wholeJobTokenAllowance}`,
        counted,
        reserved,
      );
    }
    // COMMIT the local charge FIRST (no refunds past this point), so a
    // concurrent call cannot slip a second charge past the allowance check
    // while this one awaits the durable hook.
    this.cumulativeReservedN = cumulative;
    this.requestCountN += 1;
    // DURABLE PRE-WIRE RESERVATION (the shared-ledger bridge): after the local
    // charge, before the wire. Its failure refuses the request conservatively —
    // the local charge is NOT refunded. The hook is ABORT-AWARE (V1GX): it races
    // the run signal, so a hung hook cannot wedge the run after the governor has
    // aborted; on abort the charge stands (no refund) and no params are returned
    // to the wire. An orphaned late hook can never wire either.
    if (onBeforeWireReserve !== undefined) {
      const receipt: WireReservation = {
        tokens: reserved,
        cumulativeTokens: cumulative,
        countedInput: counted,
        reserveOutputTokens: budget.reserveOutputTokens,
        provider: modelSpec?.provider ?? '',
        model: modelSpec?.model ?? '',
        countableProjectionDigest: createHash('sha256').update(serialized, 'utf8').digest('hex'),
      };
      try {
        // Invoke the hook and race its settlement against the abort. A
        // SYNCHRONOUS throw becomes a rejected promise here, handled uniformly.
        await awaitWithAbort(Promise.resolve().then(() => onBeforeWireReserve(receipt)), signal);
      } catch (err) {
        // Cancellation outranks a hook failure: if the signal aborted, settle
        // the cancellation (the driver's I8 corridor), never a hook refusal.
        if (signal !== undefined && signal.aborted) {
          throw abortRefusal(signal);
        }
        throw this.refuse(
          'reservation-not-written',
          `the durable reservation hook failed: ${errorText(err)}`,
          counted,
          reserved,
        );
      }
    }
    // POST-AWAIT REVALIDATION — defense in depth over the deep freeze. The
    // object about to be returned must still serialize BYTE-IDENTICALLY to the
    // counted bytes and still carry a safe applied ceiling. Freeze should make
    // this always hold; if it ever does not, the request is refused WITHOUT a
    // refund (the local charge stays). There is no further await before return.
    let afterAwait: string;
    try {
      afterAwait = serializeRequestForCounting(wireRequest);
    } catch (err) {
      throw this.refuse(
        'request-mutated',
        `the prepared request became unserializable after the durable reservation: ${errorText(err)}`,
        counted,
        reserved,
      );
    }
    const finalCeiling = wireRequest.maxOutputTokens;
    if (
      afterAwait !== serialized ||
      !Number.isSafeInteger(finalCeiling) ||
      (finalCeiling as number) < 1 ||
      (finalCeiling as number) > budget.reserveOutputTokens
    ) {
      throw this.refuse(
        'request-mutated',
        'the prepared request changed after the durable reservation',
        counted,
        reserved,
      );
    }
    return wireRequest;
  }

  private refuse(
    reason: PreRequestCeilingRefusalReason,
    detail: string,
    countedInput: number,
    reserved: number,
  ): PreRequestCeilingRefusal {
    return new PreRequestCeilingRefusal(reason, detail, {
      countedInput,
      reserved,
      cumulativeReserved: this.cumulativeReservedN,
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The middleware body for a ceiling: transformParams reserves before each attempt. */
export function preRequestCeilingMiddleware(ceiling: PreRequestCeiling): LanguageModelMiddleware {
  return {
    transformParams: ({ params }) => ceiling.reserve(params),
  };
}

/**
 * Wrap a resolved model so every generate attempt (tool-loop step or SDK
 * retry) passes through the ceiling. The wrapped model is what `generateText`
 * receives; the verified retry loop is OUTSIDE the middleware, so it re-enters
 * per attempt and no attempt escapes uncounted.
 */
export function wrapWithPreRequestCeiling(
  model: LanguageModel,
  ceiling: PreRequestCeiling,
): LanguageModel {
  // `ProviderFactory` resolves to a live model instance, never a gateway
  // string; the runtime check makes that explicit (and narrows the type
  // without a cast) — a string here would make the ceiling meaningless.
  if (typeof model === 'string') {
    throw new Error(
      'ai-sdk driver: strict token ceiling requires a resolved language-model instance, got a gateway model id',
    );
  }
  return wrapLanguageModel({
    model,
    middleware: preRequestCeilingMiddleware(ceiling),
  });
}
