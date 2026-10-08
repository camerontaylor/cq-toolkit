# Price map — the DD-3 record (T1.4)

The toolkit's price map (`data.ts` + `index.ts`) vendors model pricing data
so `costUSD` can be DERIVED from tokens (DD-2: tokens are the source of
truth; drivers never report trusted USD).

## Data license — DD-3 resolved

- Source: **models.dev** — the community-maintained open-source database of
  AI model pricing.
  - Site: https://models.dev/ (provider pages:
    https://models.dev/anthropic, https://models.dev/openai,
    https://models.dev/zai, https://models.dev/deepseek)
  - Data repository: https://github.com/anomalyco/models.dev
- License verdict (verified in `docs/reverify-2026-09.md`, checks dated
  2026-09-13): the upstream data repository is MIT-licensed, "Copyright
  (c) 2025 models.dev" (GitHub's license metadata agrees, `spdx_id` MIT).
- **Verdict (from the re-verification): vendoring-allowed for the scope
  vendored here — the eval-matrix pricing entries.** The complete models.dev
  MIT notice travels in `data.ts`'s header (which compiles into the
  published `dist`), so it accompanies the distributed data.

## As-of date and refresh rule

- Values in `data.ts` are a snapshot **as-of 2026-09**, USD per million
  tokens, for the eval-matrix models (claude, gpt, glm, deepseek families).
- The eval-matrix entries `deepseek-flash` and `glm-5.3-flash` were
  transcribed from models.dev on **2026-09-21** (the fetch date is recorded
  literally in `data.ts`'s `FETCHED:` line).
- Refresh cadence (DD-8, the six-week staleness rule): re-verify on (a) the
  DD-8 cycle, (b) any eval-matrix model change, or (c) any work that depends
  on a price for admission/governance decisions. Refresh = re-transcribe the
  provider pages into `data.ts` and update its as-of line; lookup and cost
  math never change.

## Derived-only rule (DD-2)

- `priceOf(modelSpec)` → per-million rates, or `undefined` when the map
  does not know the model — **the map never fabricates a price**.
- `computeCostUSD(modelSpec, usage)` → `Σ(tokens / 1e6 × rate)` over input,
  output, and (when the table carries the rate) cacheRead/cacheWrite.
  `undefined` for an unknown model. A missing per-field rate is a
  zero-priced term (the provider charges nothing for that direction — e.g.
  DeepSeek has no cache-write fee).
- `WorkerResult.costUSD` stays OPTIONAL and derived-only (frozen seam):
  drivers report tokens; cost is computed here, downstream, never
  driver-trusted.
