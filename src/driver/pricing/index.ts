// Price-map lookup + derived-only cost — T1.4 (DD-2: costUSD is DERIVED).
//
// Vendor-neutral by construction: the inputs are the FROZEN driver-seam
// types (ModelSpec, Usage) and the plain-data table in ./data.js. No vendor
// SDK types here — any driver (or the caller, or the governor via
// reportCost) can derive cost from tokens + this map.
//
// Rules:
//   - priceOf: EXACT match on ModelSpec.provider (lowercase handle) then
//     ModelSpec.model (the exact id string). Unknown model → `undefined` —
//     the map never fabricates a price.
//   - computeCostUSD: `undefined` when the model is unknown to the map;
//     otherwise Σ(tokens / 1e6 × rate) over input, output, and — when the
//     table carries the rate — cacheRead/cacheWrite. A missing per-field
//     RATE is a zero-priced term (the provider charges nothing for that
//     direction, e.g. DeepSeek cache writes); a missing MODEL is the only
//     `undefined`. Rates are per million tokens (data.ts).
import { PRICE_TABLE } from './data.js';
import type { PerMillionRates } from './data.js';
import type { ModelSpec, Usage } from '../types.js';

export type { PerMillionRates, PriceTable } from './data.js';

/**
 * Per-million-token rates for one model, or `undefined` when the map does
 * not know it (exact provider-handle + model-id match).
 */
export function priceOf(modelSpec: ModelSpec): PerMillionRates | undefined {
  return PRICE_TABLE[modelSpec.provider]?.[modelSpec.model];
}

/**
 * Derived-only USD cost of one usage observation: Σ(tokens / 1e6 × rate).
 * `undefined` when the model is unknown to the map (never fabricate);
 * missing cache rates contribute a zero term.
 */
export function computeCostUSD(modelSpec: ModelSpec, usage: Usage): number | undefined {
  const rates = priceOf(modelSpec);
  if (rates === undefined) {
    return undefined;
  }
  const perMillion = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens / 1_000_000) * rate;
  return (
    perMillion(usage.input, rates.input) +
    perMillion(usage.output, rates.output) +
    perMillion(usage.cacheRead, rates.cacheRead) +
    perMillion(usage.cacheWrite, rates.cacheWrite)
  );
}
