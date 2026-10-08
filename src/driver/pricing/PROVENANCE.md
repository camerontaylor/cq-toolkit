# Provider-fact provenance for the pricing lane (W3.5 / RS-14 inputs)

Every provider fact this lane relies on, with its primary source, the fetch
date, how it was obtained, and its verification status. Facts are either
**documented** (a vendor's own documentation, fetched here) or **observed** (a
live response capture, attributed to the lane that captured it — this lane made
no model calls and spent $0). Nothing here is inferred from a vendor's absence
of a row unless the text says "docs-silent".

Fetch date for everything in this file: **2026-10-01 (UTC)** unless a row says
otherwise. Requests were unauthenticated documentation GETs; no API key, no
credential, no model call, no spend.

## 1. Served-id aliases (inputs to the W3.5 normalizer)

| Fact                                                                                                                                                                              | Primary source                                                                        | Obtained                                              | Status                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `claude-haiku-4-5` is an ALIAS; the API ID is `claude-haiku-4-5-20251001`                                                                                                         | <https://platform.claude.com/docs/en/docs/about-claude/models/overview.md> (HTTP 200) | model table rows "Claude API ID" / "Claude API alias" | documented                                     |
| "For models before the 4.6 generation, the alias is a convenience pointer that resolves to the dated ID. Dateless IDs are their own pinned snapshot; the alias row repeats them." | same page                                                                             | footnote under the model table                        | documented                                     |
| Claude Haiku 4.5: context 200K, max output 64K                                                                                                                                    | same page (context-window / max-output rows)                                          | model table                                           | documented                                     |
| `deepseek-chat` requests are served `deepseek-flash`                                                                                                                              | live 200 capture, 2026-09-24 15:54 UTC: research `rs14` evidence `ds_body.json`       | body `"model": "deepseek-flash"`                      | observed (one capture)                         |
| `deepseek-chat` is no longer documented; the rate-limit page lists only `deepseek-flash` and `deepseek-v4-pro`                                                                    | <https://api-docs.deepseek.com/quick_start/rate_limit> (HTTP 200)                     | model table                                           | docs-silent                                    |
| `deepseek-chat` / `deepseek-reasoner` are absent from models.dev; `deepseek-flash` present at input 0.15 / output 0.6 / cache_read 0.003                                          | <https://models.dev/api.json> (HTTP 200)                                              | `providers.deepseek.models`                           | documented (community DB, not a vendor source) |
| "Requests for GLM-5.2/GLM-5.1 will be automatically routed to GLM-5.3, requests for GLM-4.7 will automatically be routed to GLM-5.3-Flash"                                        | <https://docs.z.ai/devpack/overview.md> (HTTP 200)                                    | §"Supported Models"                                   | documented                                     |
| GLM-5.3-Flash context length 1M                                                                                                                                                   | <https://docs.z.ai/guides/llm/glm-5.3-flash.md> (HTTP 200)                            | §"Context Length"                                     | documented                                     |
| OpenCode Go exposes the UPSTREAM provider id in `x-opencode-upstream-model-id` (not a served id)                                                                                  | live capture 2026-09-24: research `rs14` evidence `oc_headers.txt`                    | response headers                                      | observed — **recorded as NOT an alias**        |

Not recorded, deliberately: `deepseek-reasoner`'s served id (no capture, no
docs), and any ACP `builtin:<provider>\` entry (ADR-0002 §2.6 defines that as
lane normalisation, and records a normalised ACP mismatch as a finding rather
than something to alias away). The reasoning is recorded in
`candidate-aliases.ts` so the omissions read as findings, not gaps.

## 2. Rate-table verification against the vendored source

`./data.ts` is vendored from models.dev with a `FETCHED: 2026-09-21` line and a
six-week refresh cadence (DD-8). Re-fetched <https://models.dev/api.json> on
2026-10-01 to check the vendored rows for drift (six weeks is not yet up, so a
clean result is the expected one):

| Table row                                              | Upstream 2026-10-01                                                                                                    | Verdict                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `anthropic/claude-haiku-4-5` 1.0 / 5.0 / 0.1 / 1.25    | identical                                                                                                              | no drift                |
| `anthropic/claude-sonnet-4-5` 3.0 / 15.0 / 0.3 / 3.75  | identical                                                                                                              | no drift                |
| `openai/gpt-5-mini`, `openai/gpt-5`                    | identical                                                                                                              | no drift                |
| `zai/glm-4.5-air`, `zai/glm-4.6`, `zai/glm-5.3-flash`  | identical (upstream also lists `cache_write: 0`, i.e. no cache-write fee — consistent with the table omitting the key) | no drift                |
| `deepseek/deepseek-flash` 0.15 / 0.6 / 0.003           | identical                                                                                                              | no drift                |
| `anthropic/claude-opus-4-1`                            | **ABSENT upstream**                                                                                                    | drift to report (below) |
| `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner` | **ABSENT upstream**                                                                                                    | drift to report (below) |

### Drift findings (reported, not silently "fixed")

1. **`claude-opus-4-1` is no longer listed upstream.** The vendored row may be
   historically correct for a retired model, and dropping a key would silently
   turn a priced invocation into an unpriced ADVISORY one, so this lane changes
   no data. Owner input: keep the historical row, or retire it with a recorded
   reason.
2. **`deepseek-chat` / `deepseek-reasoner` are no longer listed upstream.** Both
   remain table keys. `deepseek-chat` is the id the eval-matrix wire actually
   serves (the RS-14 capture shows it served as `deepseek-flash`), and it is the
   id that makes the `chat → flash` alias necessary at all. Keep-or-retire is an
   owner decision; until it is made, the normalizer prices `deepseek-chat`
   requests through the declared alias set and never through a fabricated rate.
3. **Upstream is a community database, not a vendor.** It is acceptable as the
   vendoring source of record for `data.ts` (DD-3), but ADR-0003 §2.4 criterion 2
   requires `W_max` token limits from the PROVIDER's own Models API or model
   card. models.dev limits are therefore NOT used as `W_max` inputs here.

## 3. Published limits (`W_max` inputs) — what is verified and what is not

ADR-0003 §2.4 criterion 2: both token limits come from the provider's published
model limits, never a client default. Unknown limits stay ADVISORY, so an absent
entry below is a deliberate refusal, not a missing field.

| Model                                | max input (context) | max output     | Source                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-haiku-4-5`                   | 200,000             | 64,000         | vendor model table, fetched 2026-10-01 (documented)                                                                                                                                                                                                      |
| `glm-5.3-flash`                      | 1,000,000           | **unverified** | context documented (vendor page, 2026-10-01); a 131,072 output figure circulates in the community DB and in RS-14, but was NOT confirmed against a vendor page in this lane, so it is left absent and the lane stays ADVISORY for output-bounded `W_max` |
| `gpt-5`, `gpt-5-mini` (OpenAI)       | absent              | absent         | no OpenAI vendor page was fetched for per-model token limits in this lane, so `admissionVerdict` returns ADVISORY `model-limits-unverified` for these models instead of borrowing the community DB's numbers                                             |
| `deepseek-flash`, OpenCode Go models | absent              | absent         | same: absent from the profile data, so those lanes fail closed to ADVISORY                                                                                                                                                                               |

## 4. Plan-quota and rate-limit surfaces (RS-14 input to the admission helpers)

Re-confirmed from the vendor page fetched 2026-10-01 (HTTP 200),
<https://docs.z.ai/devpack/overview.md>:

- Quota windows: a 5-hour allowance and a weekly allowance; Lite 2,000 / 10,000,
  Pro 12,000 / 60,000, Max 28,000 / 140,000 credits. "5-hour credits:
  dynamically refreshed; credit quota resets 5 hours after consumption.
  Weekly credits: activated upon subscription; resets every 7 days."
- Credit formula: "(Input tokens × Input multiplier + Cached Input tokens ×
  Cached Input multiplier + Output tokens × Output multiplier) / 10,000", plus
  MCP calls × output multiplier. The multipliers multiply RAW TOKEN COUNTS —
  there is no other scaling factor in the published formula. The vendor's own
  "Estimated Token Allowance" table is the regression source that pins the scale:
  at these multipliers a Lite weekly allowance of 10,000 credits buys ≈59M cached
  GLM-5.3 tokens and ≈179M cached GLM-5.3-Flash tokens, inside the documented
  bands of 48–97M and 146–292M (and off-peak they reach or exceed the band
  maxima, which is exactly the documented 0.5× discount). Per-model rows:
  GLM-5.3 6.9 / 1.7 / 24; GLM-5.3-Flash 2.3 / 0.56 / 8.
- Peak pricing: "**During off-peak hours, model usage is charged at 50% of the
  standard credit rate**. **Peak hours**: Monday to Friday, 14:00–18:00
  Singapore Standard Time (UTC+8)." This is the documented basis for the
  peak/off-peak multiplier stored in the profile data, and it matches the
  repo-wide GLM blackout note (peak costs more; the docs express the gap as 2×,
  the note as "~3× consumption").
- Dated promotion, deliberately NOT modelled: "From September 25 to October 7,
  2026, all-day usage will be charged at the **off-peak rate**", plus a
  GLM-5.3-Flash campaign announced for the same dates. The profile stores the
  standing peak window only; a dated campaign is a fact with an expiry, and
  encoding one would make the multiplier wrong after 2026-10-07.

RS-14's remaining per-provider surfaces (Anthropic/OpenAI headers, DeepSeek
balance endpoint, OpenCode usage endpoint, Claude unified-quota headers, and the
live error shapes behind the `quota` vs `rate-limit` classification) are
transcribed in `provider-profiles.ts` with the RS-14 evidence paths, because
they were captured with credentials this lane does not hold and must not
re-capture. Every such field is marked `verifiedBy: 'rs14-capture'` with its
capture date, so a reader can tell a documented fact from a captured one.

### OpenAI 429 body codes (re-fetched 2026-10-01, HTTP 200)

From <https://developers.openai.com/api/docs/guides/spend-limits> and
<https://platform.openai.com/docs/guides/rate-limits>:

- "When tracked spend reaches an applicable hard limit, affected API requests
  return a 429 error with the `organization_spend_limit_exceeded` or
  `project_spend_limit_exceeded` code." Both are **quota** (raise or remove the
  limit before the monthly reset), and "enforcement is not instantaneous, so
  recorded spend can slightly exceed the configured amount".
- `organization_usage_limit_exceeded` — "request a higher approved usage
  limit". Not a throttle under any reading.
- `credit_balance_exhausted` / `insufficient_quota` — add credits (the former is
  also the RS-14 live capture).
- The vendor's own routing sentence: "If the error reports a request or token
  rate limit, follow the rate limit guide." `Retry-After` is documented as "the
  minimum number of seconds to wait before retrying a temporary rate-limit error,
  **when present**".

Consequence recorded in the profile data: there is deliberately **no bare
`429 → rate-limit` rule** on the OpenAI or Anthropic API profiles, because every
documented 429 body code on those surfaces is a quota condition and a
status-only rule would classify an exhausted allowance as retryable, busy-retry
it for an hour, and hide the reset time. Anthropic's documented shape is the same
(`retry-after` on a rate-limit 429, absent on the spend-cap 429). DeepSeek and
Z.AI keep their status rules because theirs ARE documented status conditions — a
concurrency 429 and a plan-window 429 respectively.

## 5. What this lane did NOT do

- No model calls, no credentials, no spend ($0). No API-keyed endpoint touched.
- No change to `./data.ts` prices, no change to any baseline.
- No change to `src/driver/served-model.ts`, the driver factory, kernel types,
  the runner or any live provider API: the alias table is injected, not owned.
