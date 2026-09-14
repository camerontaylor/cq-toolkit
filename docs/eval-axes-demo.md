# Eval-axes demo — LIVE run output

**Run date:** 2026-09-14 (first coherent run; the glm × ai-sdk and
deepseek-chat × ai-sdk rows were each re-run live the same day under the
CURRENT script's identity guards — see the per-cell evidence notes below)
· **Script:** `scripts/demo-eval-axes.mjs`
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
runs through the standard `zai` provider construction, whose DEFAULT base
URL is now the GLM Coding Plan's OpenAI-compatible endpoint
(`https://api.z.ai/api/coding/paas/v4`, `ZAI_BASE_URL` overrides) — the
plan-funded wire.

| lane | provider | model | served model | stopReason | input | output | cacheRead | cacheWrite | costUSD (modeled) | fold agrees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-agent | zai | glm-4.6 | glm-4.6 | complete | 382 | 95 | 0 | 0 | $0.00043820 | yes |
| subprocess | zai | glm-4.6 | glm-4.6 | complete | 1132 | 26 | 0 | 0 | $0.00073640 | yes |
| ai-sdk | deepseek | deepseek-chat | **deepseek-flash** | FAILED (served-model mismatch) | — | — | — | — | absent | — |
| ai-sdk | zai | glm-4.6 | **glm-5.3-flash** | FAILED (served-model mismatch) | — | — | — | — | absent | — |

> cell ai-sdk/deepseek-chat evidence (re-run live 2026-09-14 under the
> current script): the run completed, but the endpoint REPORTED serving
> `deepseek-flash` for the requested `deepseek-chat` — the
> served-model-mismatch guard rejected the cell. The earlier PASSING
> deepseek row (93/10 tokens → $0.00003024) predates the guard and is kept
> as PRE-GUARD HISTORY below — under the current script that cell fails
> exactly this way, so the table now matches the script.
>
> cell ai-sdk/glm-4.6 evidence: the coding-plan OpenAI-compat wire
> CONNECTED (after pinning node to IPv4-first — see below) and the run
> COMPLETED, but the endpoint REPORTED serving `glm-5.3-flash` for the
> requested `glm-4.6` — the served-model-mismatch guard rejected the cell.
> A silent remap, observed live on Z.AI's coding wire: glm-5.3-flash lists
> at $0.15/$0.50 per Mtok vs glm-4.6's $0.60/$2.20, so honoring the row
> would have priced glm-5.3-flash tokens at glm-4.6 rates (~4× overstated).
> The guard exists for exactly this; no retry was issued (a remap is
> endpoint configuration, not transient).

> **History of the glm × ai-sdk cell (all evidence live, kept for honesty):**
>
> 1. **First failure — the pay-as-you-go wire.** The cell originally ran
>    over Z.AI's OpenAI-compat API (`https://api.z.ai/api/paas/v4`), which
>    rejected the key with HTTP 429, code 1113 "Insufficient balance or no
>    resource package. Please recharge." OWNER-VERIFIED ENDPOINT FACTS
>    (2026-09-14, same key, this host): `/api/paas/v4` → 429 — the
>    pay-as-you-go wire, unfunded by design; `/api/coding/paas/v4` → 200 —
>    the GLM Coding Plan's OpenAI-compatible endpoint; `/api/anthropic/
>    v1/messages` → 200 — the plan's anthropic-compat endpoint. The plan
>    funds exactly TWO wires; the pay-as-you-go wire is not one of them.
> 2. **The interim workaround (superseded).** The cell was briefly run
>    through an `@ai-sdk/anthropic` override at the anthropic-compat
>    endpoint (99/76 tokens → $0.00022660, served glm-4.6 truthfully —
>    a genuine measurement of that wire, recorded for the record). The
>    owner corrected the approach: the coding wire is the funded
>    OpenAI-compat one, so the workaround was reverted and the DRIVER now
>    defaults there (previous commit history carries the details).
> 3. **The coding-wire run (current row).** Over `/api/coding/paas/v4` the
>    run connected and completed — and the endpoint silently served
>    `glm-5.3-flash` for `glm-4.6`. The served-model-mismatch guard failed
>    the cell with that evidence. The same fixture over the
>    anthropic-compat wire had served `glm-4.6` truthfully — the remap is
>    a property of the coding wire, not of the driver.
> 4. **Host network note.** This host's IPv6 route to api.z.ai hangs
>    (node fetch → ETIMEDOUT; curl/CLI survive via happy-eyeballs). The
>    demo script pins its own process to IPv4-first with family
>    autoselection off (verified live: default → ETIMEDOUT, pinned → 200).
>    The driver and kernel set no process-global network policy.

Notes:

- **The observed-model defence fired for real — twice.** BOTH raw-chat
  cells were rejected by the identity guards: DeepSeek reported serving
  `deepseek-flash` for `deepseek-chat`, and Z.AI's coding wire reported
  `glm-5.3-flash` for `glm-4.6`. `WorkerResult.model` surfaces the served
  id, so both remaps are visible facts instead of silent price
  attributions. (The pre-guard deepseek run's passing row — 93/10 tokens →
  $0.00003024, priced at deepseek-chat rates — is PRE-GUARD HISTORY: had
  the remap existed with different list prices, that row would have
  inherited the pricing gap silently; the guard now fails such a row
  instead. The agent lanes' rows pass identity because their endpoints
  served the requested ids truthfully.)
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
