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
| ai-sdk | deepseek-chat (served: **deepseek-flash** — mismatch guard FAILED the cell) | — | — | — | — | — | absent | FAILED — served-model mismatch |
| ai-sdk | glm-4.6 (served: **glm-5.3-flash** — coding wire) | — | — | — | — | — | absent | FAILED — served-model mismatch |

**Tolerance, stated precisely — three different claims:**

1. **Driver fold vs independent recompute** (the normalization check that
   CAN be exact): every completed cell's `costUSD` equals a recompute of the
   same fold from the reported usage and the published rates, within 1e-9
   USD. Observed: equality in the TWO completed cells (the agent lanes —
   both raw-chat cells were failed by the identity guards, below). Every
   lane lands inside this tolerance.
2. **Vendored table vs provider pages**: the GLM-4.6 and deepseek-chat rows
   match Z.AI's and DeepSeek's official per-million rates as re-checked
   today — the modeled figure is the api-equivalent list-price math, not an
   approximation of it.
3. **Cross-lane usage comparability** (the check that CANNOT be exact):
   usage is deliberately NOT expected to agree across lanes — the identical
   user prompt rides different harness scaffolding. For ~16 prompt tokens,
   the raw chat lane sent 93 input tokens (chat framing, PRE-GUARD
   deepseek run — historical, see below); the agent SDK lane sent 382
   (agent system prompt + tool-surface description); the CLI lane sent
   1132 (the CLI's full system prompt). The modeled cost differences across
   lanes for the same model ($0.00044 → $0.00074 on glm-4.6) are almost
   entirely that fixed scaffolding overhead, not model behavior — which is
   exactly the fact a per-lane costUSD makes visible, and the reason eval
   budgets must be compared WITHIN a lane or normalized through this same
   fold.

## The glm × ai-sdk wire history (owner-verified endpoint facts)

OWNER-VERIFIED (2026-09-14, same key, this host): the GLM Coding Plan funds
exactly TWO wires — the coding OpenAI-compatible endpoint
(`https://api.z.ai/api/coding/paas/v4` → 200) and the anthropic-compat
endpoint (`/api/anthropic/v1/messages` → 200). The pay-as-you-go wire
(`/api/paas/v4`) rejects the plan key with HTTP 429, code 1113
"Insufficient balance or no resource package" — by design, not a fault.
The ai-sdk driver's `zai` handle now DEFAULTS to the coding endpoint
(`ZAI_BASE_URL` overrides), so the lane runs on plan-funded infrastructure.

Current cell outcome: over the coding wire the run CONNECTED and COMPLETED,
but the endpoint silently served `glm-5.3-flash` for the requested
`glm-4.6` — the served-model-mismatch guard failed the cell with that
evidence (no retry; a remap is endpoint configuration). This is the
silent-remap footgun observed live on Z.AI's coding wire, and it has a
pricing consequence the guard exists to prevent: glm-5.3-flash lists at
$0.15/$0.50 per Mtok vs glm-4.6's $0.60/$2.20, so accepting the row would
have priced glm-5.3-flash tokens at glm-4.6 rates (~4× overstated). The
interim anthropic-compat-wire measurement (99/76 tokens → $0.00022660,
endpoint served glm-4.6 truthfully) remains a recorded historical datum
from the superseded workaround — the same fixture over that wire did NOT
remap, so the remap is a property of the coding wire, not of the driver.
Full history: `docs/eval-axes-demo.md`.

The DEEPSEEK cell was reconciled the same way (re-run live under the
current script): the endpoint still REPORTS serving `deepseek-flash` for
the requested `deepseek-chat`, so the identity guard fails that cell too.
Its earlier passing row (93/10 tokens → $0.00003024, priced at
deepseek-chat rates) is PRE-GUARD history — a genuine measurement of its
moment, kept for the record; under the current script the cell fails
exactly this way, so the recorded evidence and the script now agree.

Host network note: this host's IPv6 route to api.z.ai hangs (node fetch →
ETIMEDOUT; curl and the agent CLI survive via happy-eyeballs/IPv4). The
demo script pins its OWN process to IPv4-first with family autoselection
off — the driver and kernel set no process-global network policy.

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
