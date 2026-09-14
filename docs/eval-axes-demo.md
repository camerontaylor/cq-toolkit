# Eval-axes demo — LIVE run output

**Run date:** 2026-09-14 · **Script:** `scripts/demo-eval-axes.mjs`
(standalone; never part of `npm test`) · **Fixture prompt (identical in
every cell):** "Reply with exactly this text and nothing else: The quick
brown fox jumps over the lazy dog." · **Caps:** `Budget.maxUsd 2`,
`maxTokens 2000`, `toolPolicy: 'none'` per run · **Model ids:**
`glm-4.6` (Z.AI) and `deepseek-chat` (DeepSeek) · **Routes:** Z.AI via the
anthropic-compat endpoint (`https://api.z.ai/api/anthropic`, auth vars
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` injected by the drivers from
`ZAI_API_KEY`); DeepSeek via its native API (`DEEPSEEK_API_KEY`). The stale
host `ANTHROPIC_API_KEY` was neutralized (empty) before every run.

| lane | provider | model | served model | stopReason | input | output | cacheRead | cacheWrite | costUSD (modeled) | fold agrees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai-sdk | deepseek | deepseek-chat | **deepseek-flash** | complete | 93 | 10 | 0 | 0 | $0.00003024 | yes |
| claude-agent | zai | glm-4.6 | glm-4.6 | complete | 382 | 95 | 0 | 0 | $0.00043820 | yes |
| subprocess | zai | glm-4.6 | glm-4.6 | complete | 1132 | 26 | 0 | 0 | $0.00073640 | yes |
| ai-sdk | zai | glm-4.6 | — | FAILED after 3 attempts | — | — | — | — | absent | — |

> cell ai-sdk/glm-4.6 failure evidence: Z.AI's OpenAI-compat API
> (`https://api.z.ai/api/paas/v4`) rejected the key with HTTP 429, code 1113
> "Insufficient balance or no resource package. Please recharge." — a
> spend/billing failure, so per protocol it was NOT retried further. The SAME
> key completed runs over Z.AI's anthropic-compat endpoint (the two claude
> lanes above) seconds earlier: the key rides a Z.AI coding PLAN that covers
> the anthropic-compat route, and the pay-as-you-go API it does not cover is
> exactly the wire protocol the ai-sdk lane speaks (see
> `docs/dd-2-usd-normalization.md` — the DD-9 modeled-vs-billed distinction
> observed live).

Notes:

- **The observed-model defence fired for real**: the DeepSeek endpoint was
  asked for `deepseek-chat` and REPORTED serving `deepseek-flash` —
  `WorkerResult.model` surfaces the served id, so the rename is visible
  instead of silent (the pre-dispatch-allowlist lane would have refused the
  run; the observation lane surfaces the fact — both defences, chosen per
  lane). Pricing consequence: the modeled figure used the vendored
  `deepseek-chat` rates; if `deepseek-flash`'s list price differs, the
  modeled number inherits that gap — stated, not hidden.
- **Run-to-run variance** (claude-agent × glm-4.6, an earlier demo run the
  same minute): usage {395, 88} → $0.00043060 — same fixture, ±3% cost;
  agents are not deterministic and per-run costUSD varies with the sampled
  generation.
- **fold agrees** = the driver's derived `costUSD` equals an independent
  recompute of the same fold (usage × vendored rates) within 1e-9 USD —
  observed: exact equality in every completed cell.
