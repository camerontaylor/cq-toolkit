# DD-2 result — cross-lane USD normalization (the T1.6 live check)

**Run date:** 2026-09-14 · **Script:** `scripts/demo-eval-axes.mjs` ·
**Raw output:** `docs/eval-axes-demo.md` · **Related:** DD-9
(`docs/dd-9-api-equivalent-budget.md`) — this doc is that distinction
observed live.

## Method

The SAME tiny deterministic fixture prompt ran on every lane (one run per
cell, `Budget.maxUsd 2` / `maxTokens 2000` / no tools):

1. **ai-sdk lane** (`AiSdkDriver`) — provider-native SDK wires: `zai` via
   Z.AI's OpenAI-compat API, `deepseek` via DeepSeek's native API.
2. **claude-agent lane** (`ClaudeAgentDriver`) — the agent SDK pointed at
   Z.AI's anthropic-compat endpoint (`https://api.z.ai/api/anthropic`;
   the drivers inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/
   `ANTHROPIC_API_KEY` from the `ZAI_API_KEY` env name; model id rides
   unchecked).
3. **subprocess lane** (`SubprocessDriver`) — the real `claude` CLI
   (v2.1.270) against the same endpoint over the same route.

`costUSD` in every cell is DERIVED, never reported by a driver or vendor:
`usage × vendored per-million rates` (`src/driver/pricing/data.ts` —
models.dev, MIT, as-of 2026-09, re-verified in `docs/reverify-2026-09.md`).

## The rates used (and their sources)

| model | input | output | cacheRead | source |
| --- | --- | --- | --- | --- |
| glm-4.6 | $0.60 | $2.20 | $0.11 | models.dev/zai (vendored); matches Z.AI's official GLM-4.6 API pricing ($0.60 in / $2.20 out / $0.11 cached input per Mtok — re-checked against Z.AI's published pricing today) |
| deepseek-chat | $0.28 | $0.42 | $0.028 | models.dev/deepseek (vendored); matches DeepSeek's official pricing page (api-docs.deepseek.com) |

## Measured (usage in tokens; the glm × ai-sdk row re-run live over the compat wire — see below)

| lane | model (served) | input | output | cacheRead | cacheWrite | rate math | costUSD (modeled) | inside tolerance? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-agent | glm-4.6 (glm-4.6) | 382 | 95 | 0 | 0 | (382×0.6 + 95×2.2)/1e6 = $0.00043820 | $0.00043820 | YES — exact |
| subprocess | glm-4.6 (glm-4.6) | 1132 | 26 | 0 | 0 | (1132×0.6 + 26×2.2)/1e6 = $0.00073640 | $0.00073640 | YES — exact |
| ai-sdk | glm-4.6 (glm-4.6) | 99 | 76 | 0 | 0 | (99×0.6 + 76×2.2)/1e6 = $0.00022660 | $0.00022660 | YES — exact |
| ai-sdk | deepseek-chat (served: deepseek-flash) | 93 | 10 | 0 | 0 | (93×0.28 + 10×0.42)/1e6 = $0.00003024 | $0.00003024 | YES — exact |

**Tolerance, stated precisely — three different claims:**

1. **Driver fold vs independent recompute** (the normalization check that
   CAN be exact): every completed cell's `costUSD` equals a recompute of the
   same fold from the reported usage and the published rates, within 1e-9
   USD. Observed: equality in all four completed cells. Every lane lands
   inside this tolerance.
2. **Vendored table vs provider pages**: the GLM-4.6 and deepseek-chat rows
   match Z.AI's and DeepSeek's official per-million rates as re-checked
   today — the modeled figure is the api-equivalent list-price math, not an
   approximation of it.
3. **Cross-lane usage comparability** (the check that CANNOT be exact):
   usage is deliberately NOT expected to agree across lanes — the identical
   user prompt rides different harness scaffolding. For ~16 prompt tokens,
   the raw chat lane sent 93–99 input tokens (chat framing); the agent SDK
   lane sent 382 (agent system prompt + tool-surface description); the CLI
   lane sent 1132 (the CLI's full system prompt). The modeled cost
   differences across lanes for the same model ($0.00023 → $0.00074 on
   glm-4.6, ~3×) are almost entirely that fixed scaffolding overhead, not
   model behavior — which is exactly the fact a per-lane costUSD makes
   visible, and the reason eval budgets must be compared WITHIN a lane or
   normalized through this same fold.

## The glm × ai-sdk wire history (why the axis is the driver, not the wire)

The ai-sdk × glm-4.6 cell originally failed on Z.AI's OpenAI-compat API
(`https://api.z.ai/api/paas/v4`): HTTP 429, code 1113 "Insufficient balance
or no resource package. Please recharge." — while the SAME key completed
runs over the anthropic-compat endpoint in the same minute. This was NOT a
key-name mixup (the demo script maps the rendered `Z_AI_API_KEY` onto the
drivers' `ZAI_API_KEY` convention at startup; that mapping is load-bearing
and every other live cell ran through it): the plan key funds only the
anthropic-compat route, and the pay-as-you-go API it does not cover is the
wire the ai-sdk lane's default zai provider speaks.

Per the acceptance row (the AXIS is the driver), the cell was re-run with
the driver instance still `AiSdkDriver` but a `providers` override
constructing `@ai-sdk/anthropic` at the compat endpoint. Two client-side
construction faults were found and fixed en route (zero spend each): the
SDK rejects passing both `apiKey` and `authToken`; and `baseURL` must carry
`/v1` — the SDK appends `/messages`, and Z.AI's gateway answers the
missing-`/v1` path with an HTTP-200-wrapped `{"msg":"404 NOT_FOUND"}`
envelope (invisible to status-only probing). One host network quirk needed
a committed fix: node/undici hangs on its IPv6 route to api.z.ai
(ETIMEDOUT; curl and the agent CLI survive via happy-eyeballs/IPv4), so the
cell's custom `fetch` pins `family: 4` over `node:https`. Final result:
complete, served `glm-4.6`, fold exact — the row above. Full history:
`docs/eval-axes-demo.md`.

## Modeled vs billed — DD-9 observed live

This run is the DD-9 distinction in the flesh
(`docs/dd-9-api-equivalent-budget.md`):

- What the lanes REPORT (`costUSD`, `costBasis: 'modeled'`) is the
  api-equivalent list-price figure for the tokens consumed — $0.00043820 and
  $0.00073640 for the two claude-lane runs.
- What the endpoint actually BILLS for those runs is ~$0 marginal: the key's
  coding plan covers the anthropic-compat route subscription-style (the
  plan's own credit multipliers, not per-token list price), and the
  insufficient-balance rejection on the pay-as-you-go API proves the key is
  not per-token funded at all. A per-token invoice for these runs does not
  exist.
- Both facts are true at once, and the seam keeps them separate: `costUSD`
  is a comparable modeled proxy (the same list-price math across every lane,
  which is what makes cross-lane and cross-model comparison possible);
  `costBasis: 'billed'` remains reserved for a lane whose provider reports
  actual invoiced cost — none does, and this run shows why the distinction
  matters rather than being pedantry.
- Corollary recorded for the eval lane: per-token budget caps (`maxUsd`
  tripping through modeled cost) BIND subscription-routed runs — a plan with
  "unlimited"-tier routing still produces a modeled costUSD the governor can
  compare against a cap, which is the DD-9 design working as specified.
