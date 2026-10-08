// W3.5 — served→canonical pricing normalizer (0.2 plan §4, row W3.5; ADR-0002
// §2.6; ADR-0003 §2.2 step 1, §2.4 criteria 2–3, and the W2 blocker note).
//
// What it does: a driver reports the model id the wire SERVED. Pricing must key
// on a CANONICAL id, because a served dated id (`claude-haiku-4-5-20251001`) or
// a wire alias (`deepseek-chat` served as `deepseek-flash`) misses the
// exact-key price table in ./data.js. This module resolves the observed served
// id to the canonical price key and computes the WORST-CASE rates over the whole
// declared alias set, which is what ADR-0003 §2.2 step 1 requires `W_max` to use.
//
// One alias source of truth (ADR-0002 §2.6): this module READS the seam's
// lane-scoped `ServedModelPolicy.aliases` table — lane → provider → requested →
// admitted served ids — and keeps no alias table of its own. The table is passed
// in by the seam owner (`src/driver/served-model.ts`, W3.3/#238); the structural
// type below is identical, so the seam object is passed without conversion. The
// BUILT-IN alias layer is deliberately EMPTY while reconciliation open point
// O-2 is undecided (ADR-0002 §2.6); ./candidate-aliases.ts carries the RS-14
// evidence as non-wired candidate data, not as a second source of truth.
//
// Fail-closed rules (each has a direct test):
//   - An observed id outside the declared alias set resolves to NO price
//     (`undeclared-remap`). It is never priced 0 and never guessed; an unknown
//     canonical model is ADVISORY (ADR-0003 §2.4).
//   - A missing per-direction RATE in the worst case is UNBOUNDED, not zero:
//     `WorstCaseRates.complete` goes false and a reservation returns `undefined`
//     rather than an undercounted sum (ADR-0003 criterion 2: `W_max` inputs are
//     published limits, never a client default).
//   - A candidate id the price table does not know makes the worst case
//     incomplete — an alias whose price is unknown cannot be bounded.
//   - The alias-set maximum only bounds the served model while the lane's
//     served-model check is on with `requireObserved: true`; `requireObserved:
//     false` makes the lane ADVISORY for USD (ADR-0002 §2.6, ADR-0003 m-d).
import { normaliseModelId } from '../served-model.js';
import type { LaneId } from '../served-model.js';
import { priceOf } from './index.js';
import { ownEntry } from './provider-profiles.js';
import type { PerMillionRates } from './data.js';
import type { ModelSpec } from '../types.js';

/** One lane's slice of the alias table: provider → requested id → served ids. */
export type ServedAliasEntry = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/**
 * The lane-scoped alias table, structurally identical to ADR-0002 §2.6's
 * `ServedModelPolicy['aliases']` (lane → provider → requested → served ids).
 */
export type ServedAliasTable = Readonly<Record<string, ServedAliasEntry>>;

/** The per-million rate directions a reservation must bound (ADR-0003 §2.4 c3). */
export type RateDirection = keyof PerMillionRates;

const RATE_DIRECTIONS: readonly RateDirection[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** Served ids declared admissible for `requested` on `lane`, or an empty list. */
export function servedAliasIds(
  table: ServedAliasTable | undefined,
  lane: string,
  provider: string,
  requested: string,
): readonly string[] {
  // Own keys only: a lane, provider or model id such as `constructor` would
  // otherwise resolve to an `Object.prototype` member, and spreading that as an
  // alias list throws instead of answering "nothing declared".
  //
  // The requested key is read in the LANE's normalised form, exactly as the
  // served-model seam reads it (`servedModelCheck` looks the policy up by
  // `normaliseModelId(lane, requested)`): a request the seam admitted as an alias
  // must not come back here with an empty alias set and be reclassified as an
  // undeclared remap, nor lose its declared aliases from the reserved set.
  const byProvider = ownEntry(table, lane);
  const byRequested = byProvider === undefined ? undefined : ownEntry(byProvider, provider);
  const key = normaliseModelId(lane as LaneId, requested);
  return (byRequested === undefined ? undefined : ownEntry(byRequested, key)) ?? [];
}

/** How the observed served id was reconciled with the requested (canonical) id. */
export type PricingResolutionVia = 'exact' | 'alias' | 'unobserved' | 'undeclared-remap';

/**
 * The outcome of normalizing one invocation's served model for pricing.
 * `rates` is present only when `canonicalModel` is a model the price table
 * knows; `undefined` means ADVISORY, never a zero price.
 */
export interface PricedModel {
  /** Canonical price key — the requested `ModelSpec.model`. Absent only on `undeclared-remap`. */
  readonly canonicalModel?: string;
  /** Per-million rates for the canonical model, or `undefined` when unknown. */
  readonly rates?: PerMillionRates;
  /** The raw served id when one was observed (never rewritten). */
  readonly servedModel?: string;
  readonly via: PricingResolutionVia;
  /** Requested id first, then every declared served alias — the priced set. */
  readonly candidates: readonly string[];
}

/**
 * The ids that must be priced for one invocation: the requested id first, then
 * every DECLARED served alias, with the requested id filtered out of its own
 * alias list and exact duplicates removed.
 *
 * Both `resolvePricedModel` and `worstCaseRates` derive their candidate set from
 * here. They used to filter independently and drifted apart, which double-counted
 * a candidate whenever a policy declared the requested id inside its own alias
 * list — harmless for the maximum, but it reported the same id twice in
 * `unpricedCandidates` and made the two functions disagree about what they cover.
 */
function pricedCandidates(
  modelSpec: ModelSpec,
  aliases: ServedAliasTable | undefined,
  lane: string,
): readonly string[] {
  const requested = modelSpec.model;
  const declared = servedAliasIds(aliases, lane, modelSpec.provider, requested);
  // First occurrence wins, so the requested id keeps position 0 and a repeated
  // alias is reported once. Filtering only `id !== requested` was not enough: an
  // alias list that repeats an id (a provider policy that lists the same served
  // model twice) reported that candidate twice, which double-counted it in
  // `unpricedCandidates`.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const id of [requested, ...declared]) {
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push(id);
  }
  return Object.freeze(candidates);
}

/**
 * Normalize one invocation's served model to its canonical price key.
 *
 * - observed id equals the requested id → `exact`;
 * - observed id is a declared alias for this lane/provider/requested → `alias`;
 * - nothing observed → `unobserved` (the lane's `requireObserved` decision is the
 *   seam wrapper's; this module only prices what was asked for);
 * - observed id outside the declared set → `undeclared-remap`, NO price.
 */
export function resolvePricedModel(args: {
  readonly lane: string;
  readonly modelSpec: ModelSpec;
  readonly servedModel?: string;
  readonly aliases?: ServedAliasTable;
}): PricedModel {
  const requested = args.modelSpec.model;
  const aliases = servedAliasIds(args.aliases, args.lane, args.modelSpec.provider, requested);
  const candidates = pricedCandidates(args.modelSpec, args.aliases, args.lane);
  const served = args.servedModel;
  // Compare under the LANE's normalisation (acp strips `builtin:<provider>\` and
  // case-folds), exactly as the served-model seam did, so an observation it
  // accepted as exact/alias is not reclassified here as a remap. The raw id is
  // kept for reporting.
  const normalise = (id: string): string => normaliseModelId(args.lane as LaneId, id);
  const normalisedServed = served === undefined ? undefined : normalise(served);
  const matchedAlias =
    normalisedServed === undefined
      ? undefined
      : aliases.find((alias) => normalise(alias) === normalisedServed);
  const isRequested = normalisedServed !== undefined && normalisedServed === normalise(requested);
  if (served !== undefined && !isRequested && matchedAlias === undefined) {
    return { servedModel: served, via: 'undeclared-remap', candidates };
  }
  const via: PricingResolutionVia =
    served === undefined ? 'unobserved' : isRequested ? 'exact' : 'alias';
  // An observed alias is billed at ITS OWN rates (a `deepseek-chat` request served
  // as `deepseek-flash` costs the flash row). An alias with no table entry of its
  // own leaves the rates ABSENT — a `glm-5.3-flash` request served as `glm-5.3`
  // must not be billed at the cheaper flash row. A declaration only says a remap
  // is ADMISSIBLE, never that its rate is the same, so the spelling of an alias
  // (`model-x` -> `model-x-20261001`) proves nothing about its price. The one
  // exception is a documented equivalence: Anthropic's dateless id is a
  // convenience alias that resolves to the dated API id of the same model
  // (`claude-haiku-4-5` -> `claude-haiku-4-5-20251001`, ./candidate-aliases.ts),
  // so the dated snapshot is the same model on that provider and no other.
  const isDatedSnapshot = (alias: string): boolean => {
    if (args.modelSpec.provider !== 'anthropic') return false;
    const base = `${normalise(requested)}-`;
    const rest = normalise(alias).slice(base.length);
    return normalise(alias).startsWith(base) && /^\d{8}$/.test(rest);
  };
  // The exact/unobserved lookup prices the requested id under the LANE's
  // normalised form — the same key `servedAliasIds` reads the policy by and the
  // seam used to admit the observation. A request the seam classified `exact`
  // (`builtin:bigmodel\GLM-5.3-FLASH` served as `glm-5.3-flash`) must not miss
  // its own price row because its raw spelling is case- or namespace-qualified.
  // Declared alias members keep their DECLARED spelling in the alias branch —
  // the same raw-values/normalised-key split `servedAliasIds` uses.
  const requestedPriceKey = normalise(requested);
  const rates =
    via === 'alias' && matchedAlias !== undefined
      ? (priceOf({ ...args.modelSpec, model: matchedAlias }) ??
        (isDatedSnapshot(matchedAlias)
          ? priceOf({ ...args.modelSpec, model: requestedPriceKey })
          : undefined))
      : priceOf({ ...args.modelSpec, model: requestedPriceKey });
  return {
    canonicalModel: requested,
    ...(rates === undefined ? {} : { rates }),
    ...(served === undefined ? {} : { servedModel: served }),
    via,
    candidates,
  };
}

/**
 * Worst-case per-direction rates over the requested id AND every declared served
 * alias (ADR-0003 §2.2 step 1: "`W_max` and the rate table are the maximum over
 * `inv.modelSpec.model` and every served-model alias declared for it").
 *
 * `complete` is false when any candidate is unknown to the price table, or when
 * candidates DISAGREE about a direction (one candidate prices it, another omits
 * it) — then the omitted direction is left ABSENT from `rates`, never zeroed,
 * because "nobody charges for it" and "this vendor's price is unknown" are not
 * the same claim. A direction no candidate prices is a zero term, as
 * ./index.ts already defines. An incomplete worst case must not size a HARD
 * reservation.
 */
export function worstCaseRates(
  modelSpec: ModelSpec,
  aliases: ServedAliasTable | undefined,
  lane: string,
  /** The price-table lookup; injectable so the disagreement rule is testable
   *  without mutating the vendored table. Defaults to the vendored lookup. */
  lookup: (candidate: string) => PerMillionRates | undefined = (candidate) =>
    priceOf({ provider: modelSpec.provider, model: candidate }),
): {
  readonly rates?: PerMillionRates;
  readonly complete: boolean;
  readonly unpricedCandidates: readonly string[];
  readonly missingDirections: readonly RateDirection[];
  readonly candidates: readonly string[];
} {
  const candidates = pricedCandidates(modelSpec, aliases, lane);
  // The requested candidate prices under the lane-normalised key, exactly as in
  // `resolvePricedModel`; declared alias members price at their declared
  // spelling. Reporting (`candidates`, `unpricedCandidates`) stays raw.
  const requestedKey = normaliseModelId(lane as LaneId, modelSpec.model);
  const unpricedCandidates: string[] = [];
  const perCandidate: PerMillionRates[] = [];
  for (const candidate of candidates) {
    const rates = lookup(candidate === modelSpec.model ? requestedKey : candidate);
    if (rates === undefined) unpricedCandidates.push(candidate);
    else perCandidate.push(rates);
  }
  const missingDirections = RATE_DIRECTIONS.filter(
    (direction) =>
      perCandidate.some((rates) => rates[direction] !== undefined) &&
      perCandidate.some((rates) => rates[direction] === undefined),
  );
  const maximum = (direction: RateDirection): number | undefined => {
    const values = perCandidate
      .map((rates) => rates[direction])
      .filter((rate): rate is number => rate !== undefined);
    return values.length === 0 ? undefined : Math.max(...values);
  };
  const complete = unpricedCandidates.length === 0 && missingDirections.length === 0;
  // NO candidate priced anything: there is no worst case to report. Emitting a
  // `rates` object here would put explicit ZEROS in front of a caller — an
  // "input 0, output 0" figure reads as "this model is free", which is the exact
  // fabrication the price map refuses to make. The completeness metadata still
  // travels, so a caller can tell an unknown model from a priced one.
  if (perCandidate.length === 0) {
    return { complete, unpricedCandidates, missingDirections, candidates };
  }
  // A direction no candidate prices stays ABSENT (a zero term at cost time), never
  // an explicit 0 that would read as a known price. A DISPUTED direction is absent
  // too, even though some candidate prices it: taking that maximum would price the
  // direction as if the silent candidate charged it, which is precisely the
  // claim this module refuses to make.
  const bounded = (direction: RateDirection): number | undefined =>
    missingDirections.includes(direction) ? undefined : maximum(direction);
  const input = bounded('input') ?? 0;
  const output = bounded('output') ?? 0;
  const cacheRead = bounded('cacheRead');
  const cacheWrite = bounded('cacheWrite');
  const rates: PerMillionRates = {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
  return {
    rates,
    complete,
    unpricedCandidates,
    missingDirections,
    candidates,
  };
}

/** A token envelope to size a reservation against (published `W_max` inputs). */
export interface TokenEnvelope {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * Worst-case USD reservation over the declared alias set. Returns `undefined`
 * when the worst case is incomplete (an unpriced alias, or an unbounded
 * direction) — an undercounted reservation is worse than none.
 */
export function worstCaseReservationUsd(args: {
  readonly lane: string;
  readonly modelSpec: ModelSpec;
  readonly aliases?: ServedAliasTable;
  readonly envelope: TokenEnvelope;
}): { readonly usd?: number; readonly complete: boolean } {
  const worst = worstCaseRates(args.modelSpec, args.aliases, args.lane);
  if (!worst.complete || worst.rates === undefined) return { complete: false };
  const perMillion = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens / 1_000_000) * rate;
  const { rates } = worst;
  const usd =
    perMillion(args.envelope.input, rates.input) +
    perMillion(args.envelope.output, rates.output) +
    perMillion(args.envelope.cacheRead ?? 0, rates.cacheRead) +
    perMillion(args.envelope.cacheWrite ?? 0, rates.cacheWrite);
  return { usd, complete: true };
}

/**
 * Whether the alias-set maximum bounds what the wire may serve.
 *
 * Both halves are required, and this predicate ENFORCES the conjunction rather
 * than leaving it to the caller:
 *   - `requireObserved: true`, so an observed id must be the requested id or a
 *     declared alias. A lane configured `requireObserved: false` may serve ANY
 *     model unobserved, so its USD classification is ADVISORY (ADR-0002 §2.6;
 *     ADR-0003 critic r2 m-d);
 *   - the priced resolution must not be an `undeclared-remap`, i.e. the observed
 *     id really was inside the declared set.
 *
 * This previously took only the boolean and returned it unchanged, which let a
 * caller obtain `true` and claim a USD bound without ever checking the remap —
 * a footgun aimed at the W3.3/J integration step.
 */
export function servedModelIsBounded(args: {
  readonly requireObserved: boolean;
  readonly priced: Pick<PricedModel, 'via'>;
}): boolean {
  return args.requireObserved && args.priced.via !== 'undeclared-remap';
}
