# W2.1 exit-path and HARD audit matrix (pricing lane, pre-S)

The W2.1 row in the 0.2 plan asks for an audit of **every driver exit** for
spend and usage: what is reported, what is priced, and what stands between the
lane and a HARD USD classification. ADR-0003 §2.4's six HARD criteria are the
yardstick; this matrix records what the CURRENT code (at the commit below) does
on each exit, so the gaps are named rather than discovered during a HARD flip.

This is an audit note, not a code change. It reads `src/driver/**` only; it edits
no lane, no seam type, no runner.

Audited tree: `cq-toolkit` `cq02/provider-pricing` at `dd247ca` (the base this
lane started from) plus this lane's own commits. Read-only audit; no lane was
modified to produce it.

## 1. How a lane reports cost today (the shared finding)

All four lanes derive cost the same way — and every one of them keys the price
lookup on the **raw observed served id**:

| Lane           | Code                                       | Behaviour on non-complete exits                                                                                                                                                         |
| -------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subprocess`   | `src/driver/subprocess/index.ts:874,890`   | `costField(this.costUSDOf, pricedModel, usage)`; unmeasured abort/spawn-failure verdicts carry NO `costUSD`                                                                             |
| `ai-sdk`       | `src/driver/ai-sdk/index.ts:511,544`       | success path derives cost over `{...modelSpec, model: servedModel ?? modelSpec.model}`; the mid-run catch keeps `usage` (folded per completed step) and deliberately claims **no** cost |
| `claude-agent` | `src/driver/claude-agent/index.ts:745,760` | cost only when a real usage measurement exists; priced on the observed served id, falling back to the requested id                                                                      |
| `acp`          | `src/driver/acp/index.ts:1684,1687`        | cost only when BOTH measured usage AND an observed served model exist; otherwise absent, which trips the governor's unpriced-usage check (DD-9)                                         |

**Consequence for W3.5 (the W2 blocker).** A wire that serves an id outside the
price table — the dated Anthropic id `claude-haiku-4-5-20251001`, or a wire alias
such as DeepSeek's `deepseek-flash` for a `deepseek-chat` request — produces
`priceOf(...) === undefined`, hence NO `costUSD` at all. That is the correct
fail-closed behaviour today (never fabricate), but it means **every served-id
remap is an unpriced invocation**, and an unpriced invocation can never settle
HARD. `./normalize.ts` resolves exactly this case (canonical key from the
declared alias set); wiring it into the four `costField` call sites is lane-owner
work under lease, not pricing-lane work.

**Consequence for the alias decision (O-2).** Even with the normalizer wired,
`worstCaseRates` is incomplete while an alias id is absent from `./data.ts`: the
anthropic dated-alias candidate is unbounded until the table gains the dated row
(see ./PROVENANCE.md §Drift). Until then that lane's reservation stays
unbounded ⇒ ADVISORY ⇒ no HARD row.

## 2. Exit-path matrix

`usage` = tokens reported on the verdict. `cost` = derived `costUSD`. "Priced
key" = which model id the lookup used.

| #   | Exit path                                                                               | Lanes                                              | usage                           | cost                                              | Priced key            | Spend accounted?         | HARD blocker                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------- | ------------------------------------------------- | --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `complete`                                                                              | all four                                           | yes                             | yes                                               | observed served id    | yes                      | undeclared remap ⇒ no cost (§1)                                                                                                                                              |
| 2   | `budget` (token cap / `finishReason: length` / vendor cap stop)                         | all four                                           | yes                             | yes                                               | observed served id    | yes                      | criterion 2: a lane-pinned `max_tokens` is only admissible if the proxy leg proves every request respects the pin                                                            |
| 3   | `error` — harness failure / oversized line                                              | `subprocess`, `claude-agent`                       | partial (whatever was observed) | yes when measured                                 | observed served id    | partially                | the run already spent; the residual after the failure is unmeasured — criterion 4 needs the proxy leg                                                                        |
| 4   | `error` — spawn / dispatch failure (nothing ran)                                        | `subprocess`                                       | zero (honest "not measured")    | none                                              | —                     | yes (nothing was spent)  | none; `zeroUsage` is documented as "not measured", not "nothing spent"                                                                                                       |
| 5   | `aborted` (governed signal fired)                                                       | all four                                           | partial                         | `subprocess`/`claude-agent`: none; `ai-sdk`: none | —                     | **NO**                   | criterion 6 proxy leg: money already sent is billed by the provider even though the lane never saw the usage                                                                 |
| 6   | `error` — structured-output miss                                                        | `ai-sdk`                                           | yes (full result usage)         | none by design                                    | —                     | **NO**                   | the run completed and billed; the lane refuses to derive cost from a usage it calls partial (never-fabricate)                                                                |
| 7   | `error` — provider/API failure mid-run                                                  | `ai-sdk`, `claude-agent`, `subprocess`             | partial                         | none                                              | —                     | **NO**                   | same as #6; needs the proxy-recorded billed usage to reconcile (criterion 4)                                                                                                 |
| 8   | retry inside the SDK (`RetryError` after exhausted retries)                             | `ai-sdk`                                           | folded                          | none                                              | —                     | **NO — billed-but-lost** | ADR-0003 N2: an `api_retry` the provider billed and the client never saw is spend with no usage record; the settlement must charge it explicitly                             |
| 9   | vendor settles the prompt `cancelled` (ACP)                                             | `acp`                                              | measured when reported          | only with an observed served model                | observed served model | yes, if reported         | ACP cannot observe a served model in every configuration ⇒ `requireObserved` interaction (ADR-0002 §2.6)                                                                     |
| 10  | wire-gate rejections (malformed reported usage, connection failed, ungated, denied-ran) | `acp`                                              | zero / flagged                  | none                                              | —                     | partly                   | `malformedUsage` is deliberately not zeros (PR #97) — the verdict must not read as "nothing spent"                                                                           |
| 11  | unobserved served model                                                                 | `acp` (and any lane with `requireObserved: false`) | yes                             | none                                              | —                     | **NO**                   | ADR-0003 m-d: a lane that may serve any model unobserved is ADVISORY for USD by definition                                                                                   |
| 12  | forward-then-drop (provider bills, response lost)                                       | `subprocess`, `claude-agent`, `ai-sdk`             | zero reported                   | none                                              | —                     | **NO**                   | ADR-0003 criterion 4 is one-sided for this exact reason: charged ≥ Σ proxy-billed in all three scenarios, and the `failedAttemptsObserved` term is what makes the bound hold |
| 13  | `error` — served-model mismatch (seam wrapper)                                          | all four                                           | kept by contract                | n/a                                               | —                     | yes                      | ADR-0002 §2.6 keeps `usage` on a mismatch precisely because the spend was real; the W3.5 normalizer supplies the price                                                       |

## 3. HARD criteria status per the current tree

| ADR-0003 §2.4 criterion                     | Status today                  | What is missing                                                                                                                                                  |
| ------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 in-process cap mechanism                  | not demonstrated in this lane | per-lane demonstration; owner J/S                                                                                                                                |
| 2 `W_max` from published limits             | partially sourced             | `W_max` needs the canonical-key resolution of §1 plus a vendor-published output cap per model (`glm-5.3-flash` output cap still unverified — ./PROVENANCE.md §3) |
| 3 per-rate dominance                        | not demonstrated              | recorded-run aggregates are only a spot check                                                                                                                    |
| 4 settle accuracy vs the recording proxy    | **blocked**                   | paths #5–#8 and #12 are unpriced today; W3.5 blocks settlement (ADR-0003 W2 blocker)                                                                             |
| 5 no parallel requests inside an invocation | not demonstrated              | needs a declared per-kind bound or a closed tool surface                                                                                                         |
| 6 proxy-observed gating                     | not started                   | requires the recording proxy leg and the harness pins                                                                                                            |

**Every lane is ADVISORY today**, exactly as ADR-0003 §2.4 states at `5e52707`.
Nothing in this matrix changes that, and nothing here should be read as
approving a HARD row.

## 4. The guard W2.1 asks for that does not yet exist

W2.1 also asks for a "static/conformance guard against unreported
`driver.run`". Today:

- `src/ops/**` constructs lanes directly (`src/ops/sweep/unit.ts:33` imports
  `SubprocessDriver` and builds it) and calls `driver.run(...)`, bypassing any
  governed wrapper — which ADR-0003 §2.6 says must be the ONE hook
  (`governDriverFactory`). Those call sites are INV/owner-SW/J territory, not
  pricing-lane territory, and are recorded here as a finding only.
- `test/driver/conformance.ts` pins derived-only cost (absent `costUSD` for the
  unpriced conformance model) but asserts nothing about the ERROR/ABORT exits'
  spend, which is why rows #5–#8 and #12 went unnoticed.

Recommended (owner decision, not implemented here): a conformance case per exit
path asserting the invariant "**usage is never silently dropped and cost is
never silently zero**" — i.e. every non-complete verdict either carries measured
usage or is explicitly marked unmeasured, and no exit returns `costUSD: 0` for a
run that reached the provider. That invariant is the cheapest static guard
against a future silent-zero regression, and it composes with the normalizer's
own never-zero rule.

## 5. Open items this audit hands to owners (no lane edits)

1. **Lane owners (S/J/INV):** replace the raw-served-id price key at the four
   `costField` call sites with the W3.5 canonical resolution, under lease. Until
   then every remap is an unpriced invocation.
2. **Owner/Sol (O-2):** decide whether any vendor remap ships built in. The
   evidence is in ./candidate-aliases.ts; note that admitting the anthropic
   dated alias without adding the dated row to the price table keeps that lane's
   worst case unbounded (ADVISORY).
3. **Owner (data):** `claude-opus-4-1`, `deepseek-chat` and `deepseek-reasoner`
   are no longer listed upstream (./PROVENANCE.md §2). Keep-or-retire is a
   pricing-data decision with a live consequence: retiring `deepseek-chat`
   changes what the eval-matrix lane prices.
4. **J:** the `api_retry` billed-but-lost charge (row #8) is settlement work that
   must land with the W2.2/W2.3 journal, not in the pricing lane.
