# Eval-axes demo — LIVE run output

**Run date:** 2026-09-14 (first coherent run; the glm × ai-sdk row was
re-run live the same day over the anthropic-compat wire — see the wire note
below) · **Script:** `scripts/demo-eval-axes.mjs`
(standalone; never part of `npm test`) · **Fixture prompt (identical in
every cell):** "Reply with exactly this text and nothing else: The quick
brown fox jumps over the lazy dog." · **Caps:** `Budget.maxUsd 2`,
`maxTokens 2000`, `toolPolicy: 'none'` per run · **Model ids:**
`glm-4.6` (Z.AI) and `deepseek-chat` (DeepSeek) · **Routes:** Z.AI via the
anthropic-compat endpoint (`https://api.z.ai/api/anthropic`, auth vars
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` injected by the drivers from
`ZAI_API_KEY`); DeepSeek via its native API (`DEEPSEEK_API_KEY`). The stale
host `ANTHROPIC_API_KEY` was neutralized (empty) before every run.

**THE AXIS IS THE DRIVER, NOT THE PROVIDER WIRE:** the glm × ai-sdk cell
rides the anthropic-compat wire — the driver instance is still `AiSdkDriver`
with a `providers` override constructing `@ai-sdk/anthropic` at Z.AI's
compat endpoint — because the plan key funds only that endpoint (the
OpenAI-compat API rejects it; full history below).

| lane | provider | model | served model | stopReason | input | output | cacheRead | cacheWrite | costUSD (modeled) | fold agrees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai-sdk | deepseek | deepseek-chat | **deepseek-flash** | complete | 93 | 10 | 0 | 0 | $0.00003024 | yes |
| claude-agent | zai | glm-4.6 | glm-4.6 | complete | 382 | 95 | 0 | 0 | $0.00043820 | yes |
| subprocess | zai | glm-4.6 | glm-4.6 | complete | 1132 | 26 | 0 | 0 | $0.00073640 | yes |
| ai-sdk | zai | glm-4.6 | glm-4.6 | complete | 99 | 76 | 0 | 0 | $0.00022660 | yes |

The glm × ai-sdk rate math: (99×$0.60 + 76×$2.20)/1e6 = **$0.00022660** —
the driver's derived figure equals the independent recompute exactly. The
endpoint served the requested id (`glm-4.6` — no remap on this wire); the
cell's larger output-token count (76 vs the agent lanes' 26/95) reflects
GLM's thinking blocks riding the output stream on the raw chat wire.

> **History of the glm × ai-sdk cell (all evidence live, kept for honesty):**
>
> 1. **First failure — wrong WIRE, not wrong key.** The cell originally ran
>    over Z.AI's OpenAI-compat API (`https://api.z.ai/api/paas/v4`), which
>    rejected the key with HTTP 429, code 1113 "Insufficient balance or no
>    resource package. Please recharge." — a spend/billing failure, recorded
>    and not retried past the attempt cap. This was NOT a key-name mixup:
>    the script maps the rendered `Z_AI_API_KEY` onto the drivers'
>    `ZAI_API_KEY` convention at startup (that mapping is load-bearing and
>    the deepseek/claude-agent/subprocess cells all ran live through it);
>    the same key completes runs on the anthropic-compat endpoint seconds
>    later. The plan key simply funds only the anthropic-compat route —
>    DD-9's modeled-vs-billed distinction observed live.
> 2. **The retry — same driver, compat wire.** Per the acceptance row (the
>    AXIS is the driver), the cell was re-run with the `providers` override
>    constructing `@ai-sdk/anthropic` at the compat endpoint. Two client-
>    side construction faults were found and fixed on the way, each costing
>    zero spend: the SDK rejects passing BOTH `apiKey` and `authToken`; and
>    `baseURL` must carry `/v1` — the SDK appends `/messages`, and Z.AI's
>    gateway answers the missing-`/v1` path with an HTTP-200-wrapped
>    `{"msg":"404 NOT_FOUND"}` envelope (invisible to status-only probing;
>    found by reading the body).
> 3. **The host network quirk.** node/undici resolves api.z.ai with IPv6
>    addresses first and this host's v6 route to it hangs (ETIMEDOUT);
>    curl and the agent CLI survive via happy-eyeballs/IPv4. The cell's
>    custom `fetch` pins `family: 4` over `node:https` (committed, in the
>    script).
> 4. **Final state:** complete, served glm-4.6, fold exact — the row above.

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
- **Env-name verification** (steer follow-up): every lane's key reading was
  re-checked — `Z_AI_API_KEY` is the rendered name and the script maps it
  onto `ZAI_API_KEY` (the ai-sdk driver's own convention) before any cell
  runs; `DEEPSEEK_API_KEY` is the rendered name and matches the driver
  convention directly. The mapping was correct everywhere; nothing to
  correct. Key VALUES are read from the environment and never printed.
