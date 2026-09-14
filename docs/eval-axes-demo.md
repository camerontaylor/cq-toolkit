# Eval-axes demo — LIVE run output

**Run date:** 2026-09-15 (the acp cell — the four-wide lane axis completes;
the cell's first run FAILED on a driver-side wire-schema transcription bug,
the retry after the fix is the recorded row — see the per-cell evidence
below) · 2026-09-14 (first coherent run; the glm × ai-sdk and
deepseek-chat × ai-sdk rows were each re-run live the same day under the
CURRENT script's identity guards — see the per-cell evidence notes below)
· **Script:** `scripts/demo-eval-axes.mjs`
(standalone; never part of `npm test`) · **Fixture prompt (identical in
every cell):** "Reply with exactly this text and nothing else: The quick
brown fox jumps over the lazy dog." · **Caps:** `Budget.maxUsd 2` on every
cell, `maxTokens 2000` on the raw lanes / `maxTokens 200_000` on the acp
cell (its harness's FIXED scaffolding alone dwarfs the raw-chat cap — see
below), `toolPolicy: 'none'` per run · **Model ids:**
`glm-4.6` (Z.AI raw lanes), `deepseek-chat` (DeepSeek), and
`glm-5.3-flash` — the acp lane's SERVED id, requested per the conductor
decision (2026-09-14) · **Routes:** Z.AI via the
anthropic-compat endpoint (`https://api.z.ai/api/anthropic`, auth vars
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` injected by the drivers from
`ZAI_API_KEY`); DeepSeek via its native API (`DEEPSEEK_API_KEY`); the acp
lane via the vendor harness `zcode-acp-server` (JSON-RPC over stdio; auth
is agent-side — the ZCode app's own credentials, no key env from the
script; `ZCODE_BIN` names the app-bundle CLI). The stale
host `ANTHROPIC_API_KEY` was neutralized (empty) before every run.

**THE AXIS IS THE DRIVER, NOT THE PROVIDER WIRE:** the glm × ai-sdk cell
runs through the standard `zai` provider construction, whose DEFAULT base
URL is now the GLM Coding Plan's OpenAI-compatible endpoint
(`https://api.z.ai/api/coding/paas/v4`, `ZAI_BASE_URL` overrides) — the
plan-funded wire. The four-wide lane axis {ai-sdk, claude-agent,
subprocess, acp} COMPLETES with the acp cell (2026-09-15): it rides
glm-5.3-flash — the id its wire actually serves — rather than glm-4.6,
exactly the conductor decision: eval wires REQUEST the served id so the
observed-model check passes green and cells compare what actually ran,
honestly labeled.

| lane | provider | model | served model | stopReason | input | output | cacheRead | cacheWrite | costUSD (modeled) | fold agrees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-agent | zai | glm-4.6 | glm-4.6 | complete | 382 | 95 | 0 | 0 | $0.00043820 | yes |
| subprocess | zai | glm-4.6 | glm-4.6 | complete | 1132 | 26 | 0 | 0 | $0.00073640 | yes |
| acp | zai | glm-5.3-flash | builtin:bigmodel\GLM-5.3 | complete | 15727 | 12 | 10368 | 0 | absent | yes |
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

> cell acp/glm-5.3-flash evidence (run live 2026-09-15; the row is the
> retry after ONE honest failure — full history in the note): the cell
> REQUESTS `glm-5.3-flash` — the model id this wire actually serves
> (conductor decision 2026-09-14) — with the harness's own materialized
> encoding `builtin:bigmodel\GLM-5.3` (probe-recorded 2026-09-15,
> strategy §5) PRE-DECLARED as the cell's expected served id
> (`expectedServed`); the identity guard demands the OBSERVED id equal
> that exact string, and it did. The vendor encoding means the row's
> requested and served ids differ in SPELLING while naming the same
> served model — a remap would have surfaced as any OTHER id and failed
> the cell, the same guard strength as every other lane.
>
> **The first run FAILED — a driver bug, not a wire fact.** stopReason
> 'error', zero usage: the driver's session/new schema transcribed
> `modes.availableModes` as bare STRINGS while the live wire sends
> `{id, name}` OBJECTS (probe-verbatim: `[{ id: 'plan', name: 'Plan' },
> …]`) — the handshake-failure narration in the session record carried
> the zod evidence. The in-repo fake fixture emitted strings too, which
> is why conformance stayed green while the live parse threw. The schema
> (`SessionModesSchema`) and the fixture were fixed to the recorded
> shape; the retry — the ONE honest retry — is the recorded row. NO
> retry followed the completed result.
>
> Reading the row: usage 15727/12/10368/0 — the vendor harness's FIXED
> scaffolding is ~26k tokens for the 16-word fixture, an order of
> magnitude above the claude-agent lane's 382 and the CLI lane's 1132;
> that fixed overhead IS the lane's shape, which is why the cell's token
> cap is 200_000 (the raw-chat 2k cap would post-hoc-classify every
> honest acp run 'budget' — the cap is a classification threshold, never
> a stop). costUSD is ABSENT on purpose: the vendored price map knows
> glm-4.6 but neither `glm-5.3-flash` nor the vendor encoding — the fold
> records the pricing gap (both driver and independent recompute absent
> → fold agrees) rather than fabricating a figure; the DD-2 discount
> record for this lane lives in `docs/dd-2-usd-normalization.md`.

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
- **The acp lane's identity is the served id, pre-declared (2026-09-15).**
  The conductor decision (eval wires REQUEST the model id the wire
  actually serves) meets this wire's encoding: the harness serves
  glm-5.3-flash and materializes it as `builtin:bigmodel\GLM-5.3` — so the
  cell requests the served model by name and pins the probe-recorded
  encoding as `expectedServed`; the guard (`served === expectedServed`)
  has exactly the remap-catching strength of the raw lanes'
  (`served === requested`), and the row honestly labels both spellings.
  The four-wide lane axis {ai-sdk, claude-agent, subprocess, acp} is
  complete; the lane axis is "the fixed GLM model each wire actually
  serves" (glm-4.6 on the raw lanes, glm-5.3-flash here), not one literal
  id — that IS the honest labeling the decision asks for.
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
