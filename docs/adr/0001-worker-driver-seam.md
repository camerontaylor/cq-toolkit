# ADR-0001 — Worker/driver seam: substrate choice and seam contract

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-12
- **Amended by:** [ADR-0002](0002-worker-driver-seam-v2.md) §2.6 (the served-model rule)
- **Related:** [ADR-0002](0002-worker-driver-seam-v2.md) (seam v2)

## Context

The toolkit's v1 definition of done requires a pluggable worker seam: agentic ops call AI workers through a driver
interface, at least two drivers work at v1, and the kernel has no single-vendor lock-in. A survey of the TypeScript field (Claude Agent SDK, OpenAI Agents SDK, pi, Vercel AI SDK v7, Mastra, LangGraph.js,
opencode, subprocess CLIs and others) found that **the seam has two halves, and no substrate covers both.** The
model-execution half (multi-vendor calls, structured output, usage) is best in the thin libraries. The harness half
(file and exec tools, sandbox, sessions) is complete only in the coding agents, which are proprietary or
server-shaped. The driver interface sits at that boundary.

The Claude Agent SDK is **not viable as the substrate core**: it is proprietary-licensed, so it cannot sit inside an
MIT kernel, and non-Claude routing is officially unsupported.

## Decision

Four driver lanes behind one owned seam.

1. **First-party lane (`ai-sdk` driver): Vercel AI SDK v7 (`ai`, Apache-2.0) as the in-process execution core, plus
   a toolkit-owned minimal harness** (read/edit/run tools, JSONL session records, a price map derived from
   models.dev). It has official providers for all four eval-matrix vendors (Anthropic, OpenAI, Z.AI, DeepSeek) and is
   the field's de facto interchange layer, so provider code survives a core swap. Owning the tool surface is a
   feature: a minimal surface per op is a quality lever. Provider instances are imported directly (`anthropic(...)`,
   `zai(...)`), never as string model ids, which route through Vercel's gateway.

2. **Second lane (`claude-agent` driver): `@anthropic-ai/claude-agent-sdk` as an optional peer dependency, in a
   subprocess.** It has the richest structured output, restriction surface (`allowedTools`, `canUseTool`, OS sandbox)
   and token accounting, plus session resume and per-process isolation. It is never a required dependency, and its
   vocabulary (tool names, permission modes, price table, `SDKMessage`) must not leak through the seam. The SDK ships
   breaking changes in patch releases, so the driver uses capability and feature detection, never version checks.
   `modelPricing` overrides correct its USD, which is wrong off Anthropic. **Non-Claude models may route through this
   driver** via `ANTHROPIC_BASE_URL`; Z.AI's Anthropic-compatible endpoint is the v1 test route. Anthropic does not
   support this routing, but the owner judged that not a bar: orchestrators built on the Agent SDK (Paseo, for
   example) serve Z.AI GLM ids this way in production. The served-model rule below covers the residual risk.

3. **Null-hypothesis floor (`subprocess` driver): spawn any agent CLI.** Claude Code headless is the reference
   surface (`-p --output-format stream-json --json-schema --allowedTools`). The lane is kept permanently as the eval
   baseline and the crash-isolated fallback.

4. **Vendor-native harness lane (`acp` driver): the Agent Client Protocol over stdio** (added 2026-09-14). Vendors
   such as Z.AI favour work done through their own binary, and the toolkit should not hand-build support for each
   vendor CLI. ACP is the open protocol those binaries speak: `zcode-acp-server` (pinned `^0.31.0`) and
   `@openma/deepseek-harness-acp` (bin `dsh-acp`) reach Z.AI's and DeepSeek's harnesses, and the same driver can
   later reach others. It is deliberately **not** a Paseo driver: Paseo is an orchestrator that _runs_ this toolkit,
   so wrapping it would invert the layering.

**Eval-matrix axes.** Models vary on the `ai-sdk` driver. Drivers vary on a **fixed GLM model** across all four
lanes, because the owner reaches Claude only through a subscription, never an API key. GLM needs no Anthropic key:
`ai-sdk` reaches Z.AI natively, `subprocess` and `claude-agent` use its Anthropic-compatible endpoint, and `acp` uses
`zcode-acp-server`. v1 evaluation runs on Z.AI only. **This is a testing choice, not a capability limit:**
`@ai-sdk/anthropic` ships in the provider registry ([src/driver/ai-sdk/index.ts](../../src/driver/ai-sdk/index.ts))
and works for any user with a key.

**Seam contract** (the kernel's only worker-facing type surface):

```ts
Driver.run(opInvocation) → WorkerResult
// opInvocation = { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef?, budget }
// WorkerResult = { structuredOutput?, usage{ input, output, cacheRead, cacheWrite, reasoning? },
//                 costUSD?, sessionId?, denials[], stopReason }
```

**Rules.**

- **Tokens are the source of truth; USD is always derived** from the toolkit's own price map. Few substrates compute
  cross-provider USD, and Claude Code's is wrong off Anthropic.
- **The toolkit's own message and session vocabulary.** `BaseMessage`, `RunState` and `SDKMessage` never appear in
  persisted data.
- **Model identity is a string plus a provider handle resolved per driver**, never an SDK model object.
- **The model that answered must equal the model requested.** Every driver reports the model id observed on the
  response, and the seam asserts it against `modelSpec.model`. A mismatch fails the invocation loudly. A pre-dispatch
  allowlist cannot catch a server-side remap (DeepSeek silently remaps unknown names); observation can, and bars
  nothing.

  > Amended: [ADR-0002](0002-worker-driver-seam-v2.md) §2.6 makes this one shared factory-applied wrapper with
  > lane-declared normalisation and two declared, lane-scoped relaxations.

- **Rescue and escalation policy lives in the plan runner, never in the driver.** The seam carries the mechanism
  (a per-invocation model and a `sessionRef` resume token); the runner carries the policy.

**Designated fallback core: pi** (`@earendil-works/pi-ai` plus `pi-agent-core`, MIT), if AI SDK v7's major-version
churn or ESM-only stance becomes a problem. Its plain-data `Context` is the reference model for the seam types.
Adopt it only with exact pinning, because pi makes no semver guarantees.

## Alternatives not adopted

- **Mastra as core:** commercial `ee/` subtrees in an Apache-2.0 package, telemetry dependencies, framework coupling.
- **LangGraph.js as core:** no harness and no GLM; its checkpointer is the reference for the runner's journal replay.
- **opencode as the first driver:** a Bun server per worker; an easy later driver if a warm shared server is wanted.
- **`@openai/codex-sdk`:** deferred; two drivers meet v1, and `claude-agent` is the more dissimilar lane.
- **`@openai/agents` as core:** it reaches other vendors through the same AI SDK the toolkit uses directly.
- **Ruled out:** Amp SDK (commercial licence), Codebuff (executes in the cloud), Cloudflare Agents (bound to its
  runtime), LlamaIndex.TS (archived), BeeAI (stalled), Google ADK (no coding harness).

## Consequences

- The toolkit builds and owns the minimal harness, per-op tool allowlists, the JSONL session format, the price map
  and per-op process isolation.
- The kernel stays vendor-neutral and MIT-clean; the proprietary Agent SDK is quarantined as an optional peer.
- AI SDK v7 is pinned exactly, with a driver contact surface of about a dozen symbols or fewer; expect a breaking
  major every six to nine months.
- Design debts carried forward: per-query timeout enforcement (DD-1, [results](../dd-1-abort-spike.md)),
  cross-driver USD normalisation (DD-2, [results](../dd-2-usd-normalization.md)), the models.dev data licence
  (DD-3), and GLM and DeepSeek structured-output fidelity (DD-4).

## Revisit triggers

1. AI SDK `HarnessAgent` stabilises: re-evaluate before building any further driver.
2. pi publishes a stability or semver statement: promote it from fallback consideration.
3. The models.dev licence is verified: vendor the price map; otherwise derive it from provider pricing pages.
4. The non-Claude Agent SDK route _breaks_: a conformance run on the Z.AI endpoint is the canary.
5. codex-sdk matures: add it as the OpenAI-column harness-fidelity driver.
6. Staleness: the survey is current as of 2026-09-12; re-verify versions and licences before building from it.
