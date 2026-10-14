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
// carries the model identity plus the sha256 of the exact prepared request
// (`token_guard.request_sha256`). The driver supplies NO hook by default, so
// cross-invocation whole-job enforcement remains a NAMED GAP, not a claim.
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
 * The deterministic serialization handed to a capability's `count`. It carries
 * every tokenizable field of the normalized request — prompt (system +
 * messages + history), tools, tool choice, response format, sampling/token
 * settings and providerOptions — in a fixed key order. `headers` is
 * DELIBERATELY EXCLUDED (credentials never enter the counted text or any log),
 * as is the non-serializable `abortSignal`. Throws
 * {@link UnrepresentableRequestError} on a shape JSON cannot represent.
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

/** Why a request was refused before the wire send. */
export type PreRequestCeilingRefusalReason =
  /** The counted input of this request exceeds `maxInputTokens`. */
  | 'input-ceiling'
  /** The request would carry an output ceiling above `reserveOutputTokens`. */
  | 'output-reserve'
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
  | 'reservation-not-written';

/**
 * A pre-wire refusal from the ceiling. A plain `Error` subclass so the SDK's
 * retry classifier (`shouldRetry` accepts only retryable APICallErrors /
 * GatewayErrors) never retries it; the driver maps it to stopReason `budget`.
 */
export class PreRequestCeilingRefusal extends Error {
  readonly reason: PreRequestCeilingRefusalReason;
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
    this.countedInput = evidence.countedInput;
    this.reserved = evidence.reserved;
    this.cumulativeReserved = evidence.cumulativeReserved;
  }
}

/** Narrowing guard for {@link PreRequestCeilingRefusal}. */
export function isPreRequestCeilingRefusal(value: unknown): value is PreRequestCeilingRefusal {
  return value instanceof PreRequestCeilingRefusal;
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
   * sha256 (hex) of the EXACT serialized prepared request the count was taken
   * over — the `token_guard.request_sha256` an external ledger binds its
   * reservation to. Computed after the output ceiling is applied.
   */
  readonly requestDigest: string;
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
   * refund the local charge. The driver exposes it through
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
    // An existing ceiling must be a valid, honored cap that fits the reserve:
    // NaN/negative/fractional/Infinity must not slip past a `>` comparison.
    const existingCeiling = params.maxOutputTokens;
    if (existingCeiling !== undefined) {
      if (!Number.isSafeInteger(existingCeiling) || existingCeiling < 1) {
        throw this.refuse(
          'output-reserve',
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
    // Count the exact prepared request; the digest binds the receipt to it.
    let serialized: string;
    let counted: number;
    try {
      serialized = serializeRequestForCounting(prepared);
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
    // the local charge is NOT refunded.
    if (onBeforeWireReserve !== undefined) {
      try {
        await onBeforeWireReserve({
          tokens: reserved,
          cumulativeTokens: cumulative,
          countedInput: counted,
          reserveOutputTokens: budget.reserveOutputTokens,
          provider: modelSpec?.provider ?? '',
          model: modelSpec?.model ?? '',
          requestDigest: createHash('sha256').update(serialized, 'utf8').digest('hex'),
        });
      } catch (err) {
        throw this.refuse(
          'reservation-not-written',
          `the durable reservation hook failed: ${errorText(err)}`,
          counted,
          reserved,
        );
      }
    }
    return prepared;
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
