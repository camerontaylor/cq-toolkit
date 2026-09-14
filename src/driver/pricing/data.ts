// Vendored price map data — T1.4 (DD-3 RESOLVED: vendoring allowed).
//
// SOURCE = models.dev — the community-maintained open-source database of AI
// model pricing. Site: https://models.dev/ (provider pages:
// https://models.dev/anthropic, https://models.dev/openai,
// https://models.dev/zai, https://models.dev/deepseek). Data repository:
// https://github.com/anomalyco/models.dev.
//
// LICENSE (DD-3; verified in docs/reverify-2026-09.md — checks dated
// 2026-09-13): the upstream data repository is MIT-licensed (spdx_id MIT).
// VERDICT (recorded): vendoring-allowed for the scope vendored here — the
// eval-matrix pricing entries. The upstream notice travels with this table,
// as the MIT grant conditions copying on it:
//
//   models.dev — Copyright (c) 2025 models.dev
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions:
//
//   The above copyright notice and this permission notice shall be included
//   in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
//   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
//   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Record pointer: docs/reverify-2026-09.md. Header comments here are synced
// with that record when it changes.
//
// VALUES AS-OF: 2026-09. Rates are USD per MILLION tokens
// (PerMillionRates). Precision is not load-bearing here: structure and
// attribution are. Numbers are plausible snapshot values for the eval-matrix
// models, transcribed from the provider pages above.
//
// REFRESH CADENCE: re-verify on (a) the DD-8 six-week staleness cycle,
// (b) any eval-matrix model change, or (c) any driver work that depends on a
// price for admission/governance decisions. Refresh = re-transcribe the
// provider pages into this table and update the as-of line + this header —
// the table stays plain serializable data; lookup/cost logic never changes.
//
// SHAPE RULES: keyed `provider` (the frozen ModelSpec.provider handle) →
// `model` (the exact ModelSpec.model string) → rates. `cacheRead`/
// `cacheWrite` are optional: a provider that charges nothing for a cache
// direction (e.g. DeepSeek has no cache-write fee) simply omits the key —
// computeCostUSD treats a missing rate as a zero-priced term, never an
// error (only a missing MODEL yields undefined; see ./index.ts).
export interface PerMillionRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The whole table: provider handle → model id → per-million-token rates. Plain serializable data. */
export type PriceTable = Readonly<Record<string, Readonly<Record<string, PerMillionRates>>>>;

export const PRICE_TABLE: PriceTable = {
  // https://models.dev/anthropic — Claude family (current small + large).
  anthropic: {
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-opus-4-1': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  // https://models.dev/openai — GPT family (small + large).
  openai: {
    'gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.025 },
    'gpt-5': { input: 1.25, output: 10.0, cacheRead: 0.125 },
  },
  // https://models.dev/zai — GLM family.
  zai: {
    'glm-4.5-air': { input: 0.2, output: 1.1, cacheRead: 0.03 },
    'glm-4.6': { input: 0.6, output: 2.2, cacheRead: 0.11 },
  },
  // https://models.dev/deepseek — chat/reasoner unified pricing; no cache-write fee.
  deepseek: {
    'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028 },
    'deepseek-reasoner': { input: 0.28, output: 0.42, cacheRead: 0.028 },
  },
};
