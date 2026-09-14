# DD-2 result — cross-lane USD normalization (the T1.6 live check)

**Run date:** 2026-09-15 (the acp lane row + the Z.AI discount record —
§"The acp lane: the discount record" below) · 2026-09-14 · **Script:**
`scripts/demo-eval-axes.mjs` ·
**Raw output:** `docs/eval-axes-demo.md` · **Related:** DD-9
(`docs/dd-9-api-equivalent-budget.md`) — this doc is that distinction
observed live.

## Method

The SAME tiny deterministic fixture prompt ran on every lane (one run per
cell, `Budget.maxUsd 2` / `maxTokens 2000` / no tools — the acp cell
rides `maxTokens 200_000`; see below):

1. **ai-sdk lane** (`AiSdkDriver`) — provider-native SDK wires: `zai` via
   Z.AI's OpenAI-compat API, `deepseek` via DeepSeek's native API.
2. **claude-agent lane** (`ClaudeAgentDriver`) — the agent SDK pointed at
   Z.AI's anthropic-compat endpoint (`https://api.z.ai/api/anthropic`;
   the drivers inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/
   `ANTHROPIC_API_KEY` from the `ZAI_API_KEY` env name; model id rides
   unchecked).
3. **subprocess lane** (`SubprocessDriver`) — the real `claude` CLI
   (v2.1.270) against the same endpoint over the same route.
4. **acp lane** (`AcpDriver`, T1.8) — the vendor harness `zcode-acp-server`
   (0.37.3) over newline-delimited JSON-RPC on stdio; requests
   `glm-5.3-flash` — the model id the wire ACTUALLY serves (conductor
   decision 2026-09-14), materialized and observed as
   `builtin:bigmodel\GLM-5.3` — with auth agent-side (the ZCode app's own
   credentials) and the spend riding the vendor harness. Its token cap is
   200_000 because the harness's fixed scaffolding alone is ~26k tokens
   (the raw-chat 2k cap would misclassify every honest run 'budget').

`costUSD` in every cell is DERIVED, never reported by a driver or vendor:
`usage × vendored per-million rates` (`src/driver/pricing/data.ts` —
models.dev, MIT, as-of 2026-09, re-verified in `docs/reverify-2026-09.md`).

## The rates used (and their sources)

| model | input | output | cacheRead | source |
| --- | --- | --- | --- | --- |
| glm-4.6 | $0.60 | $2.20 | $0.11 | models.dev/zai (vendored); matches Z.AI's official GLM-4.6 API pricing ($0.60 in / $2.20 out / $0.11 cached input per Mtok — re-checked against Z.AI's published pricing today) |
| deepseek-chat | $0.28 | $0.42 | $0.028 | models.dev/deepseek (vendored); matches DeepSeek's official pricing page (api-docs.deepseek.com) |
| glm-5.3-flash (the acp lane's served model) | — | — | — | UNPRICED — the vendored table (models.dev as-of 2026-09) knows glm-4.5-air and glm-4.6 under zai but neither glm-5.3-flash nor the vendor's materialized encoding `builtin:bigmodel\GLM-5.3`; the fold records the gap (costUSD absent on both sides) rather than fabricating rates. GLM-5.3-flash list pricing observed elsewhere on Z.AI's wires ($0.15/$0.50 per Mtok) is NOT vendored and NOT applied here. |

## Measured (usage in tokens; the glm × ai-sdk row re-run live over the compat wire — see below)

| lane | model (served) | input | output | cacheRead | cacheWrite | rate math | costUSD (modeled) | inside tolerance? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-agent | glm-4.6 (glm-4.6) | 382 | 95 | 0 | 0 | (382×0.6 + 95×2.2)/1e6 = $0.00043820 | $0.00043820 | YES — exact |
| subprocess | glm-4.6 (glm-4.6) | 1132 | 26 | 0 | 0 | (1132×0.6 + 26×2.2)/1e6 = $0.00073640 | $0.00073640 | YES — exact |
| acp | glm-5.3-flash (served: builtin:bigmodel\GLM-5.3 — the vendor's materialized encoding of it) | 15727 | 12 | 10368 | 0 | unpriced — no vendored rates for the served id | absent | YES — fold agrees (both sides absent) |
| ai-sdk | deepseek-chat (served: **deepseek-flash** — mismatch guard FAILED the cell) | — | — | — | — | — | absent | FAILED — served-model mismatch |
| ai-sdk | glm-4.6 (served: **glm-5.3-flash** — coding wire) | — | — | — | — | — | absent | FAILED — served-model mismatch |

**Tolerance, stated precisely — three different claims:**

1. **Driver fold vs independent recompute** (the normalization check that
   CAN be exact): the fold-agreement claim is scoped to the cells that
   completed — the two completed agent-lane cells show exact fold
   agreement (≤1e-9 USD); the acp cell (2026-09-15) agrees the honest
   other way (served model unpriced → costUSD absent on BOTH the driver
   and the independent recompute — the gap recorded, never fabricated);
   the two raw-chat cells failed the identity guards and establish no
   fold claim.
2. **Vendored table vs provider pages**: the GLM-4.6 and deepseek-chat rows
   match Z.AI's and DeepSeek's official per-million rates as re-checked
   today — the modeled figure is the api-equivalent list-price math, not an
   approximation of it. The acp lane's served model is unpriced (see the
   rates table) and makes no such claim.
3. **Cross-lane usage comparability** (the check that CANNOT be exact):
   usage is deliberately NOT expected to agree across lanes — the identical
   user prompt rides different harness scaffolding. For ~16 prompt tokens,
   the raw chat lane sent 93 input tokens (chat framing, PRE-GUARD
   deepseek run — historical, see below); the agent SDK lane sent 382
   (agent system prompt + tool-surface description); the CLI lane sent
   1132 (the CLI's full system prompt); the acp lane (2026-09-15) sent
   15727 input + 10368 cached-read (the vendor harness's full agent
   scaffolding — an order of magnitude above the CLI lane, which is
   exactly why the cell's token cap is 200_000). The modeled cost
   differences across lanes for the same model ($0.00044 → $0.00074 on
   glm-4.6) are almost
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

## The acp lane: the Z.AI discount record (2026-09-15)

The acp lane's spend RIDES THE VENDOR HARNESS: `zcode-acp-server` speaks to
the model through the ZCode app's own credentials (authMethod
`zcode-credentials` — the app reads the GLM key from its own config), so
the commercial basis is whatever subscription or pricing the vendor's
harness sits on, and the client sees only what the wire reports. What the
eval cell's live run shows:

- **Usage, yes; cost, no.** The verdict carries usage (15727/12/10368/0)
  and NO costUSD: the served id (`builtin:bigmodel\GLM-5.3`, the vendor's
  materialized encoding of glm-5.3-flash) is unpriced in the vendored
  table, so the derived-only fold records absence rather than fabricating
  a figure. The driver also drops the vendor's own usage_update cost
  objects with the frame that carries them (DD-9) — a vendor-reported cost
  would bypass the derived-only rule.
- **The discount signal is not client-observable.** The one wire place
  discount-shaped context could ride is the prompt response's `_meta` —
  the probe captured it verbatim: `_meta.zcode.usage = { source:
  "provider", modelRequestCount: 1, webFetchRequests: 0,
  webSearchRequests: 0 }`. Provenance and request counts; NOTHING
  plan-, subscription-, or discount-shaped. THE RECORD: discount not
  client-observable; the commercial basis is the vendor's published
  harness pricing. Whether the app's GLM Coding Plan subscription
  discounts these tokens is a vendor-side commercial fact the ACP wire
  does not surface, and no client-side fold may invent it.
- **Net DD-2 posture for this lane:** both sides of the seam are honest
  absences today — the modeled side blocked at the pricing table (the
  DD-8 refresh cadence is the path to a modeled figure for
  glm-5.3-flash), the billed side a subscription the harness meters only
  as request counts. A cross-lane USD comparison involving the acp cell
  is therefore NOT possible yet, and the record says so instead of
  printing a number.
- **Cell history (one honest retry):** the cell's first live run FAILED
  with stopReason 'error' and zero usage — a driver-side transcription
  bug (the session/new schema pinned `modes.availableModes` as bare
  strings; the live wire sends `{id, name}` objects, probe-verbatim), not
  a wire or pricing fact. The schema and the fake fixture were fixed to
  the recorded shape; the retry is the recorded row. Full evidence:
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
