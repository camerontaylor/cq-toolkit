# Driver seam

The seam between the toolkit and any worker that can run a prompt. One
method: `Driver.run(opInvocation) → Promise<WorkerResult>`. Source of
truth: `src/driver/types.ts` (types); zod mirrors of the serializable
parts live in `src/kernel/schema.ts`.

## The contract

`OpInvocation` — everything a driver needs to run one prompt:

- `prompt: string`
- `modelSpec: ModelSpec` — `{ model: string; provider: string }`
- `toolPolicy: ToolPolicy` — `{ allow: readonly string[]; mode?: 'allowlist' | 'unrestricted' | 'none' }`
- `sandboxPolicy: SandboxPolicy` — `{ level: 'none' | 'workspace-write' | 'read-only' }`
- `sessionRef?: string` — opaque session handle for multi-turn continuation
- `budget: Budget` — `{ maxUsd?, maxTokens?, wallClockMs?, maxAttempts? }`

`WorkerResult` — the plain-data outcome:

- `structuredOutput?: unknown`
- `usage: Usage` — `{ input, output, cacheRead, cacheWrite, reasoning? }` (tokens)
- `costUSD?: number`
- `sessionId?: string`
- `denials: ToolDenial[]` — `{ tool, reason }` per denied tool use
- `stopReason: DriverStopReason` — `'complete' | 'aborted' | 'budget' | 'error'`

## Seam rules

- Tokens are the source of truth. `costUSD` is OPTIONAL and derived-only:
  callers compute it from a price map over `usage`; drivers never report
  trusted USD.
- Model identity is plain data: a model string plus a provider handle
  resolved per driver. Never an SDK model object.
- Anything persisted uses our own vocabulary — no vendor message shapes in
  `WorkerResult` or anywhere else; the strict zod mirrors reject
  unknown-key pollution.

## Freeze rule

Frozen under tag `types-freeze-v1`. After the tag, any change to a frozen
name or field is a separate migration PR with its own review — never an
edit inside a later goal.

## I10 boundary

`src/driver/types.ts` sits INSIDE the vendor-import ban (eslint rule
`cq/no-vendor-sdk-in-kernel`, same scope as `src/kernel/**`). The three
driver implementations under `src/driver/drivers/` (in-process SDK,
agent-SDK, subprocess CLI) adopt vendors deliberately and are NOT covered.

## First-party driver: `ai-sdk` (T1.4)

`src/driver/ai-sdk/index.ts` — the toolkit's in-process driver on the
frozen seam (`AiSdkDriver implements Driver`). In-process execution per R2:
per-op isolation comes from the kernel process model plus a fresh workspace
per fresh invocation; no daemon, no pooling.

Constructor options:

- `providers?` — registry override, name → `(modelId) => language-model`
  instance. The production default builds real provider instances lazily at
  `run()` time over { anthropic, openai, zai, deepseek } with API keys read
  from the environment AT CALL TIME (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `ZAI_API_KEY`, `DEEPSEEK_API_KEY`); unknown provider or missing key
  throws BEFORE dispatch. The conformance suite injects mocks here.
- `outputSchema?` — a zod schema; when set, the SDK structured-output path
  (`Output.object`) runs and the parsed value lands in
  `WorkerResult.structuredOutput`. Data-driven; per-op schema registries
  are a later-lane concern.
- `harnessConfig?` — harness tool surface + prompt budget
  (default: `defaultHarnessConfig`).
- `sessionsDir?` — backing `SessionStore` directory.
- `pricing?` — price-lookup override for the derived-only `costUSD` rule
  (default: `priceOf` over the vendored models.dev table). Tests and
  per-deployment price tables inject here; an `undefined` lookup keeps
  `costUSD` absent.

Isolation contract (I6): no `sessionRef` → fresh temp workspace +
fresh empty session record (`harness.tempWorkspace` + `SessionStore.create`);
`sessionRef` → `SessionStore.load` resumes the recorded messages AND
workspace; unknown sessionRef throws. Session turns persist in our
`SessionMessage` vocabulary only — never vendor message shapes.

Tool loop: harness `buildTools` descriptors adapted to the SDK tool format;
the frozen `ToolPolicy` filters the surface per-op (allowlist default /
unrestricted / none); every harness denial is both the tool's output text
and a verbatim `{ tool, reason }` entry in `WorkerResult.denials`.

Boundary caveat (named in the harness tools header): the harness containment
is lexical and the `run` tool is the SYMLINK-PLANTING VECTOR — an allowlisted
command can plant a symlink pointing outside the workspace. read/edit
realpath-recheck existing paths (pre-existing symlinks are denied), but a
symlink planted after the check is a documented TOCTOU window; the mitigation
is keeping run command allowlists tight (never allowlist `ln`).

Budget mapping (I8): the driver owns NO wall clock — it forwards the
governor's `currentJobContext()?.signal` as the SDK `abortSignal` and
ignores `Budget.wallClockMs` (the governor's ladder decides when to abort);
`Budget.maxTokens` becomes a timer-free `stopWhen` condition over
accumulated step usage; `maxAttempts` is the runner/governor's retry
business (one attempt per run); `maxUsd` is caller-side derived accounting.

Stop reasons: governed abort or abort-shaped failure → `aborted`; token
budget tripped or SDK `length` → `budget`; SDK `error`/`content-filter` or
a mid-run throw → `error`; otherwise `complete`.

Pricing attribution: `costUSD` is derived via
`src/driver/pricing/index.ts` (`computeCostUSD`) over the vendored
models.dev table (`src/driver/pricing/data.ts` — MIT, verified in
docs/reverify-2026-09.md with the copyright notice preserved there;
values as-of 2026-09). `costUSD` is absent when the map does not know the
model — the driver never fabricates USD.
