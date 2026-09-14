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
- `costBasis?: 'modeled' | 'billed'` — what `costUSD` is, when it is present (DD-9)
- `sessionId?: string`
- `denials: ToolDenial[]` — `{ tool, reason }` per denied tool use
- `stopReason: DriverStopReason` — `'complete' | 'aborted' | 'budget' | 'error'`

## Seam rules

- Tokens are the source of truth. `costUSD` is OPTIONAL and derived-only:
  callers compute it from a price map over `usage`; drivers never report
  trusted USD. A present `costUSD` is labeled `costBasis: 'modeled'` — the
  api-equivalent list-price proxy for the tokens consumed, never presented
  as billed (`billed` is reserved for a lane whose provider reports actual
  invoiced cost; none exists in v1) — and a result with no `costUSD`
  carries no basis either.
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

## First-party driver: `subprocess` (T1.5)

`src/driver/subprocess/` — the null-hypothesis floor: drive an existing
agent CLI headless (`claude -p …` by default) as a worker on the frozen
seam. One spawn per run, no daemon, no pooling; if a stock CLI can be a
worker, the toolkit's value is not "you can run Claude headless".

Files:

- `index.ts` — `SubprocessDriver implements Driver` (constructor options:
  `binary?` default `'claude'`, `outputSchema?` → `--json-schema`,
  `routingTable?`, `termGraceMs?`/`killGraceMs?`, `sessionsDir?`,
  `harnessConfig?`, `pricing?`, and a `spawn?` override hook for tests).
- `routing.ts` — env-based model routing as CONFIG (`RoutingTable`,
  `defaultRoutingTable()`, `routeFor`). Endpoints are anthropic-compat
  (zai / deepseek / anthropic, values from provider docs, as-of
  2026-09); the endpoint is injected purely through env
  (`ANTHROPIC_BASE_URL` + auth-token vars), the model rides `--model`.
  THE FOOTGUN RULE: an unknown model name THROWS before dispatch —
  DeepSeek-style gateways silently remap unknown names to their default
  model, and a silently-wrong model poisons every downstream fact.
  Routes carry env var NAMES only, never key values.
- `process.ts` — child-process mechanics, and the ONE file under
  `src/driver/**` exempt from the I8 hygiene scan
  (`driver/<name>/process.ts`): `spawnManaged` (shell-less spawn,
  line-streamed stdout, prompt via stdin, spawn failures surfaced as
  data) and `terminateGracefully` — the SIGTERM→SIGKILL grace ladder
  that EXECUTES an already-decided kill (rungs observable via `onRung`
  markers; grace delays injectable for tests). The governor decides
  WHEN (rung 1 signal via `currentJobContext()`); this file only obeys.

Argv surface (headless reference): `-p` (prompt rides stdin),
`--output-format stream-json`, `--json-schema <schema>` when
`outputSchema` is set, `--allowedTools <names>` (ALWAYS present — the
harness tool surface ∩ the frozen ToolPolicy; an empty value with
`--permission-prompts none` is exactly mode `none`), `--permission-prompts
none`, `--bare`, `--model <route.model>`, and `--resume <cli-session-id>`
on sessionRef resume.

Event mapping (stream-json → seam): init `session_id` → CLI session id
(persisted post-settle to the workspace sidecar file `.cq-cli-session`
(`CLI_SESSION_FILE` in `index.ts`) — the resume handle passed as
`--resume` on the next run over the same sessionRef; a missing or
unreadable sidecar means an honest workspace-only continuation); assistant text
→ transcript; errored `tool_result` events → frozen
`{tool, reason}` denials; the terminal `result` event → frozen Usage
(`input_tokens`/`output_tokens`/`cache_read_input_tokens`/
`cache_creation_input_tokens`), `structured_output` →
`structuredOutput`, status → stopReason. Non-JSON lines become narration
(`toolName:'cli-narration'`), never a crash.

Budget mapping (I8, the honest floor): a headless CLI has no mid-run
token hook — `Budget.maxTokens` is checked only against the folded
result usage (it can classify a finished run `budget`; stopping early on
tokens is governor/admission business). `wallClockMs` is the governor's
ladder (the driver forwards its signal to the kill ladder only);
`maxAttempts` means one spawn; `maxUsd` is caller-side derived
accounting. Stop reasons: governed abort → `aborted`; folded usage ≥
`maxTokens` → `budget`; result `success` → `complete`; any other result
status, no result event, or a spawn failure → `error`. Once spawned,
`run()` never throws past the seam.

Isolation (I6): no `sessionRef` → fresh temp workspace +
`SessionStore.create` (cwd = workspace); `sessionRef` →
`SessionStore.load` resumes the SAME workspace and passes `--resume`
when the workspace carries the CLI session sidecar (a sidecar-less
workspace resumes the workspace only — an honest partial continuation); unknown
sessionRef throws. Session turns persist in our `SessionMessage`
vocabulary only.
