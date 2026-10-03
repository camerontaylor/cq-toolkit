# ADR 0001 — Worker/driver seam: substrate choice and seam contract

> Publication note (W7.2): copied from `toolkit-research` branch `research/g1-adr-reconciliation` at `bf5f540`. The status above records the later owner G1 decision. References below to pending G1 approval or draft status describe the source text at its drafting date; accepted preconditions and residuals remain binding.

Status: **accepted** (owner G1 sign-off, 2026-09-26; binding work-item preconditions and residuals retained)
Date: 2026-09-12
Evidence: `research/research-20260912-r1-substrate/digest.md` (the substrate survey — 9 candidates,
fetch-cited 2026-09-12); reconciled with `research/research-20260912-r2-orchestration/digest.md` §5
(driver ordering). Satisfies the spec's mandate: "an ADR from the 'Claude Agent SDK vs other SDK
bases' investigation" (spec, Acceptance Criteria item 4).

## Context

The spec (Constraints: "Pluggable worker seam") requires that agentic ops invoke AI workers through
a driver interface, with ≥2 working drivers at v1, no single-vendor lock-in in the kernel, and the
substrate chosen by an explicit research step. R1 surveyed the credible TypeScript field (Claude
Agent SDK, OpenAI Agents SDK, pi, Vercel AI SDK v7, Mastra, LangGraph.js, opencode, subprocess CLIs,
plus codex-sdk/ADK/others) against seven criteria (embed, model pluggability, tool restriction,
sessions, cost accounting, license/velocity, lock-in).

R1's structural finding: **the seam has two halves, and no surveyed substrate covers both** (R1
"Recommendation"). The model-execution half (multi-vendor calls, structured output, usage) is best
in the thin libraries; the harness half (file/exec tools, sandbox, sessions) is complete only in the
coding agents — which are either proprietary (Claude Agent SDK, Amp) or server-shaped (opencode).
The driver interface must sit exactly at that boundary.

The spec's named candidate, the Claude Agent SDK, is **not viable as the substrate core**: it is
proprietary-licensed (Anthropic Commercial Terms — cannot sit inside an MIT kernel), and non-Claude
routing is officially unsupported (Claude-only request fields 400 on other vendors; DeepSeek
silently remaps unknown model names) (R1 §1, §8).

## Decision

Four driver lanes, one owned seam (lane 4 added 2026-09-14 by owner):

1. **First-party lane (`ai-sdk` driver): Vercel AI SDK v7 (`ai`, Apache-2.0) as the in-process
   execution core, plus a toolkit-owned minimal harness** — our own file/read/edit/run tool set,
   our JSONL session records, our models.dev-derived price map. Rationale (R1 "Proposed decision"
   §1): official current providers for all four eval-matrix vendors (`@ai-sdk/anthropic`, `-openai`,
   `-zai`, `-deepseek`); it is the field's de-facto interchange layer (OpenAI Agents SDK, opencode,
   Mastra, VoltAgent all build on it), so provider code survives a core swap; the stateless core +
   `stopWhen` budgets + `prepareStep` per-step model switching + stable typed structured output
   match the SDK-first anti-monolith constraint. Owning the tool surface is a feature: R4's signal
   (mini-swe-agent; per-model tool sensitivity) says the per-op minimal tool surface is a quality
   lever. Provider instances are imported directly (`anthropic(...)`, `zai(...)`) — never string
   model ids, which route through Vercel's gateway (R1 risk table).

2. **Second lane (`claude-agent` driver): `@anthropic-ai/claude-agent-sdk` as an optional peer
   dependency, subprocess lane.** Richest structured output (json-schema with validation retries),
   richest restriction surface (allowedTools/canUseTool/OS sandbox), richest token accounting,
   session resume/fork, free per-process isolation (R1 §1). Never a required dependency; its
   vocabulary (tool names, permission modes, price table, `SDKMessage`) must not leak through the
   seam. `modelPricing` overrides correct its wrong-by-construction USD off-Anthropic. **Non-Claude
   models may route through this driver** via `ANTHROPIC_BASE_URL` (Z.AI's anthropic-compat
   endpoint is the v1 test route). R1 recorded Anthropic's statement that it "doesn't support
   routing Claude Code to non-Claude models through any gateway" and inferred a hard bar; that
   inference is **overridden by the owner (2026-09-14)** on contrary production evidence — paseo's
   own Agent-SDK-backed provider treats it as routine (`paseo/packages/server/src/server/agent/
providers/claude/models.ts:167-169`: "Claude Code is an Anthropic-compatible client, so
   subagents routinely report models that are not Anthropic's — Z.AI GLM ids via
   `ANTHROPIC_BASE_URL`"). A vendor declining to _support_ a path is not evidence the path fails.
   The residual risk (DeepSeek's silent remap) is handled by observation, not prohibition — see
   "Rules the evidence forces".

3. **Null-hypothesis floor (`subprocess` driver): spawn any agent CLI** (Claude Code headless is
   the reference surface: `-p --output-format stream-json --json-schema --allowedTools`), kept
   forever as the eval baseline and crash-isolated fallback (R1 §8; R2 §5 "kept forever as the
   null-hypothesis floor"). Env-based model routing on this lane is provider-documented for
   Z.AI/DeepSeek/MiniMax/Kimi.

4. **Vendor-native harness lane (`acp` driver): speak the Agent Client Protocol over stdio.**
   Added 2026-09-14 (owner). Rationale is commercial before architectural: Z.AI discounts work
   done through its own binary, and we do not want to hand-build and maintain support for each
   vendor CLI. ACP is the open protocol those binaries already speak — `zcode-acp-server` (npm,
   pinned `^0.31.0`) and `@openma/deepseek-harness-acp` (bin `dsh-acp`) reach Z.AI's and
   DeepSeek's first-party harnesses, and the same driver later reaches cursor/kimi/gjc/copilot/
   trae. Deliberately **not** a `paseo` driver: paseo is the orchestrator that _runs_ this toolkit,
   so wrapping it would invert the layering and would only exercise paseo's own wrapper around
   lane #2 — and a public MIT npm package cannot depend on a locally-forked `paseo@0.1.0`. Paseo's
   `generic-acp-agent.ts` is the implementation reference to _read_, never a dependency. Distinct
   substrate on the merits: JSON-RPC over stdio with session negotiation and permission callbacks,
   versus lane #2's bundled binary and lane #3's argv+stdout.

**Eval-matrix axes** (feeds fixtures/eval repo design): models vary on driver #1; drivers vary on
a **fixed GLM model** across all four lanes. Revised 2026-09-14 (owner): the model axis fixed on
Claude was the original choice, but a Claude-fixed driver axis is only reachable with a raw
Anthropic API key, which the owner's operating rule excludes — Claude is reached through the
coding-plan subscription (`claude -p`, the Agent SDK, or paseo), never a key. Fixing GLM instead
makes the driver axis four-wide with no Anthropic key at all: `ai-sdk` reaches Z.AI natively
(`@ai-sdk/zai`), `subprocess` and `claude-agent` via the anthropic-compat endpoint, `acp` via
`zcode-acp-server`. v1 evaluation runs on Z.AI only. **This is a testing choice, not a capability
limit** — `@ai-sdk/anthropic` ships and works for any user with a key (`src/driver/ai-sdk/
index.ts` provider registry); we simply do not exercise it.

**Seam contract** (the kernel's only worker-facing type surface):

```ts
Driver.run(opInvocation) → WorkerResult
// opInvocation = { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef?, budget }
// WorkerResult = { structuredOutput?, usage{ input, output, cacheRead, cacheWrite, reasoning? },
//                 costUSD?, sessionId?, denials[], stopReason }
```

Rules the evidence forces (R1 "Proposed decision" §3):

- **Tokens are the source of truth; USD is always derived** from our own price map (only pi,
  Mastra, opencode compute cross-provider USD natively; Claude Code's USD is wrong off-Anthropic;
  Codex/Gemini emit none).
- **Our own message/session vocabulary** — never `BaseMessage`, `RunState`, or `SDKMessage` in
  persisted data.
- **Model identity is a string + provider handle resolved per driver** — never an SDK model object.
- **The model that answered must equal the model requested.** Every driver reports the model id
  observed on the response, and the seam asserts it against `modelSpec.model`; a mismatch fails
  the invocation loudly. This is what defends against DeepSeek's silent remap. Note that a
  _pre-dispatch_ allowlist — the original defence — is structurally incapable of catching it: the
  remap happens server-side, so a valid-looking name passes the check and a different model
  answers anyway. Observation catches it, needs no allowlist, and bars nothing. Pattern borrowed
  from paseo's `resolveObservedClaudeModelId` (`providers/claude/models.ts:177`), which reads the
  model id off the assistant frame rather than trusting the request.
- **Rescue/escalation policy lives in the plan runner, never in the driver** (R2 §5). The seam
  carries the mechanism (per-invocation model + `sessionRef` resume token); the runner carries the
  policy.

**Designated fallback core: pi** (`@earendil-works/pi-ai` + `pi-agent-core`) if AI SDK v7's major
churn or ESM-only stance bites — MIT, 30 native providers, plain-data Context (the reference model
for our seam types), native per-run USD. Accept only with exact pinning; pi ships no semver
guarantees (R1 "Proposed decision" §4).

## Named non-adoptions (for the record — R1 "Proposed decision" §5)

- **Mastra as core**: closest one-stop answer, but Apache-2.0 with `ee/` commercial subtrees inside
  `@mastra/core`, 31 runtime deps incl. telemetry, framework coupling. Its per-model JSON-mode
  strategy and models.dev cost sourcing are techniques to copy.
- **LangGraph.js as core**: best durability engine, zero harness, no GLM. Its checkpointer model is
  the durability reference for the runner's journal-replay design, not a worker substrate.
- **opencode as driver #1**: best permission globs + public OpenAPI contract, but a Bun server per
  worker; easy third driver later if fleet sweep wants a warm shared server (`--attach`).
- **@openai/codex-sdk**: natural cheap third driver for the OpenAI column at harness fidelity;
  deferred — two drivers satisfy DoD 4 and claude-agent proves the more dissimilar lane.
- **@openai/agents as core**: reaches other vendors through the same AI SDK we'd use directly.
- Amp SDK (commercial license), Codebuff (cloud-executed), Cloudflare Agents (runtime-bound),
  LlamaIndex.TS (archived), BeeAI (stalled), Google ADK (no coding harness): ruled out.

## Consequences

- We build and own: the minimal harness (file/edit/run tools), per-op tool allowlists, JSONL
  session format, the price map, and per-op process isolation (the ai-sdk driver runs inside our
  worker process — R2's fan-out isolation is our process model).
- Kernel stays vendor-neutral and MIT-clean; the proprietary Claude Agent SDK is quarantined behind
  an optional peer dep.
- Pin AI SDK v7 exactly; keep the driver contact surface ≤ a dozen symbols; expect a breaking major
  every ~6–9 months (v5→v6→v7 in 23 months; majors are patched in lockstep, so migration has
  runway).
- Claude Agent SDK ships breaking changes in patches (0.2.69, 0.2.113) — use capability/feature
  detection, never version checks.
- Design debts carried (tracked in `plans/toolkit-v1-plan.md` §10): per-query timeout enforcement
  (DD-1), cross-driver USD normalization (DD-2), models.dev license (DD-3), GLM/DeepSeek
  structured-output fidelity (DD-4).

## Revisit triggers (from R1 "Open questions"; mirrored on the watchlist)

1. AI SDK `HarnessAgent` stabilizes → re-evaluate before building any driver #3+ (it wraps Claude
   Code/Codex/Pi/OpenCode already).
2. pi publishes a stability statement/semver → promote from fallback consideration.
3. models.dev license verified → vendor the price map; otherwise derive from provider pricing pages.
4. ~~Anthropic blesses non-Claude routing through the Agent SDK~~ — **resolved 2026-09-14 by owner
   override**: the route works in production regardless of vendor blessing (see Decision §2), and
   the claude-agent lane now serves the GLM eval column. Watch instead for the route _breaking_:
   the Agent SDK ships breaking changes in patch releases, so a conformance run on the Z.AI
   endpoint is the canary.
5. codex-sdk matures → OpenAI-column harness-fidelity driver.
6. Staleness: R1 is current as of 2026-09-12; the watchlist's 6-week rule applies — **re-verify
   versions and licenses before implementation starts from this ADR.**
