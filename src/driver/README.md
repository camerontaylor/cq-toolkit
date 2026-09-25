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
- `usage: Usage` — `{ input, output, cacheRead, cacheWrite, reasoning? }`
  (tokens; `reasoning` is additive only when the lane's SDK reports
  reasoning OUTSIDE output — a lane whose SDK counts thinking inside
  output must not emit it)
- `costUSD?: number`
- `costBasis?: 'modeled' | 'billed'` — what `costUSD` is, when it is present (DD-9)
- `sessionId?: string`
- `denials: ToolDenial[]` — `{ tool, reason }` per denied tool use
- `error?: string` — the caught underlying cause on a driver-level failure (present only with `stopReason: 'error'`); never scored
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
  throws BEFORE dispatch. The `zai` handle defaults to the GLM Coding
  Plan's OpenAI-compatible endpoint
  (`https://api.z.ai/api/coding/paas/v4` — the plan-funded wire;
  `ZAI_BASE_URL` overrides, e.g. for the pay-as-you-go
  `https://api.z.ai/api/paas/v4`). The conformance suite injects mocks here.
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
The one driver-side temporal bound is the SDK call's per-request
`timeout: { stepMs: DEFAULT_STEP_TIMEOUT_MS }` (120 s) — NOT a run deadline,
but a bound on each step of the tool loop so a hung HTTP request cannot
stall the loop.

Transient retry (#210): the SDK call runs `maxRetries: 1` — ONE retry per
step request (bounded; ≤ DEFAULT_MAX_STEPS per run) for the SDK's own
retryable transient class (endpoint header timeout / network). The SDK
classifies retryability itself and its
exhausted-retry error names the attempt count and the last error
(`Failed after N attempts. Last error: …`), so the cause still reaches
`WorkerResult.error`. This is a deliberate, recorded deviation from the
earlier "no driver-side retries" note: the same endpoint is healthy on the
classifier cell, so one retry recovers the hiccup; a governed abort still
surfaces immediately.

Stop reasons: governed abort or abort-shaped failure → `aborted`; token
budget tripped or SDK `length` → `budget`; SDK `error`/`content-filter` or
a mid-run throw → `error`; otherwise `complete`.

Failure classes (#210): every `error` verdict's `WorkerResult.error` starts
with `ai-sdk driver: [<token>]` — the class token is the second component,
after the lane prefix — so the fixtures runner can tell an honest
structured-output miss from a loud endpoint absence without the frozen seam
carrying a new field. `[structured-output-miss]` — the required structured
object was not produced / did not parse (the `result.output` getter threw
`NoOutputGeneratedError` / `NoObjectGeneratedError`); the verdict stays
`error` and `structuredOutput` is never fabricated. A token cap or a
governed abort that leaves the final step on tool-calls is the honest
`budget`/`aborted` verdict instead — the missing object is its consequence,
not a driver failure — and `structuredOutput` is likewise never fabricated
on those paths. `[endpoint-timeout]` —
the SDK-retryable transient class (endpoint header timeout, network error,
rate limit / 429, 5xx), plus the non-retryable step-timeout abort (classified
via its `TimeoutError` name). `[provider-error]` —
anything else. The classification lives in
the exported pure `classifyRunFailure(err)`.

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
  `harnessConfig?`, `pricing?`, `envAllowlist?`, `toolSurface?` (default
  `'harness'`; `'stock'` is the D6 null-hypothesis mode, reachable only by
  constructing the class directly), and a `spawn?` override hook for
  tests). Before the CLI receives the JSON Schema, the driver
  removes `$schema` properties and absolute `http(s)://json-schema.org/`
  values under `$ref`, `$dynamicRef`, and `$recursiveRef` (`stripMetaSchema`).
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

Child environment is DEFAULT-DENY (issue #183) for the subprocess CLI,
the claude-agent SDK child, the ACP vendor process, and every harness `run`
child. All use the shared `buildChildEnv` policy. ACP configures its vendor
process with `envNames`; its tools run in that vendor process, separately
from the shared harness tool core.
The policy copies ONLY `DEFAULT_CHILD_ENV_ALLOWLIST` (PATH/HOME/SHELL/USER/temp dirs,
terminal + locale basics, XDG dirs, network-egress/TLS config
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, proxy vars), Windows equivalents)
from the entry process env. By default it excludes `GH_TOKEN`, `*_API_KEY`,
`*_SECRET`, `AWS_*`, `NPM_TOKEN`, `SSH_AUTH_SOCK`, and `NODE_OPTIONS`/`NODE_PATH`.
Per-route endpoint/auth vars are composed explicitly into the agent CLI
or SDK child's environment and always win over the allowlist, so configured
driver keys still reach that worker. These credential overrides are not
passed to harness `run` children. A deployment extends the copied names
with `SubprocessDriverOptions.envAllowlist` or
`ClaudeAgentDriverOptions.envAllowlist` (names only, never values) —
e.g. for a corporate `SSH_AUTH_SOCK` or `NPM_CONFIG_*`. A marker secret in
the entry process env therefore cannot reach a `spawnManaged` worker,
where prompt-injected PR content could exfiltrate it. TWO CAVEATS (issue
#183 r1/r2): proxy vars are inherited because egress needs them and their
URL MAY embed credentials a worker can read (leave them unset to avoid
that); and `HOME` stays inherited because the CLI reads its own config
there, so a worker with file-read tools can still reach
`~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.npmrc`, … — that
boundary is the `ToolPolicy`/sandbox surface, not this env allowlist.

Both drivers carry their explicit `envAllowlist` through the harness
manifest's `envNames`. The manifest also captures names from the deployment
variable `CQ_RUN_ENV_PASSTHROUGH` (comma- or whitespace-separated names),
so those opt-ins survive the stdio startup scrub. The shared core filters
the environment at every `run` execution, including in-process SDK tools and direct `buildTools`
calls; the stdio server's startup scrub is an additional boundary. Both
closed-form git commands and shell commands receive the filtered env.

Argv surface (headless reference, harness mode — the default): `-p` (prompt
rides stdin), `--output-format stream-json`, `--verbose` (the real CLI
refuses stream-json print mode without it — found live, CLI 2.1.270, T1.6
slice 4), `--json-schema <schema>` when `outputSchema` is set, then the
CLOSED SURFACE (W1.4): `--tools ""` (builtins absent, not denied),
`--setting-sources ""` (no ambient settings), `--strict-mcp-config` (no
ambient MCP servers), `--mcp-config <sessionsDir>/<sessionId>.<run-uuid>.cq-harness-mcp.json`
(unique per run, created `O_EXCL` 0600; a name collision is a hard error)
when the selected surface is non-empty, and `--allowedTools` — ALWAYS
present, ONE space-joined argv element (comma-joining silently pre-approves
only the first entry) holding the qualified spellings
`mcp__cq-harness__<name>` of harness ∩ the frozen ToolPolicy (empty = mode
`none`). Then `--model <route.model>` and `--resume <cli-session-id>` on
sessionRef resume. No undocumented flags: `--permission-prompts none` and
`--bare` were removed (issue #19). Stock mode keeps the legacy argv
(no closed-surface flags; harness names in `--allowedTools`, inert).

Closed tool surface (W1.4 — RS-12 design, ADR-0002 Annex A):

- The shared core `src/harness/surface.ts` (vendor-free) owns naming
  (`cq-harness`, `mcp__cq-harness__<name>`), selection, the strict
  driver-authored manifest (`buildManifest` — the only constructor:
  workspace realpath, sandbox level, harness ∩ policy, harness config, env
  names), the bound serialized surface (`createHarnessSurface`), the MCP
  `CallToolResult` mapping, the stable harness denial prefixes
  (`isHarnessDenial`) and the init-surface comparator. BOTH lanes serve it:
  claude-agent in-process, subprocess over stdio; a two-level parity test
  (`test/driver/harness-parity.test.ts`) pins identical CallToolResults and
  identical `WorkerResult.denials`.
- The stdio server `src/harness/mcp/` (bin `cq-harness-mcp`) is a
  hand-rolled closed subset of JSON-RPC 2.0 (initialize / initialized /
  cancelled / ping / tools/list / tools/call; version negotiation; 1 MiB
  line cap) — ZERO runtime dependencies; `@modelcontextprotocol/sdk` is a
  devDependency conformance client only. Toolkit dispatch launches it as
  `process.execPath` + the module-relative `dist/harness/mcp/bin.js` —
  never through PATH, npx or plan data. It re-validates the manifest at
  startup (strict schema, realpath identity, surface equality), chdirs to
  the workspace and scrubs its env to the default child-env allowlist plus
  the lane's `envAllowlist` names, or exits 78 before `initialize`.
- The driver asserts the FIRST `system/init` fail-closed (exactly
  `cq-harness`/connected and exactly the qualified selected tools, plus the
  CLI's `StructuredOutput` under `--json-schema`), classifies `is_error`
  harness results three ways (harness denial by prefix / CLI permission
  denial / anything else = transport failure), and settles every harness
  failure as stopReason `error` with a `HARNESS_ERROR_PREFIX` cause and an
  `errorClass: 'harness'` narration marker (the ADR-0002 §2.2 enum field
  lands with the W3.3 types bump).
- Named limitations: a same-uid `run` command can still read an
  ancestor's environment (OS confinement, T1.8); a server killed without
  SIGTERM orphans an in-flight command group until it exits on its own.

The shared `run` tool accepts six closed-form `git diff` commands and
three closed-form `git log` commands, each still requiring an allowlist
grant. They select constant argv with `shell: false`; path and revision
arguments are unavailable. Both transports use the same process lifecycle
for these commands and ordinary shell commands: bounded output, timeout,
cancellation, and POSIX process-group termination. See the exact forms and
config pins in [the harness README](../harness/README.md).

TRUST STATEMENT (issue #28's subprocess half): in harness mode the harness
enforces the TOOL-level sandbox mapping on this lane (read-only denials,
workspace containment, path/command allowlists); OS confinement stays
unenforced, so a requested level with a non-empty surface records
`{cq: 'sandbox-level-unenforced', level, layer: 'os'}`. `run` commands keep
host privileges (the harness trust boundary). In stock mode the CLI's own
permission model governs and the legacy marker (no `layer`) records that
nothing was enforced by the harness.

Event mapping (stream-json → seam): init `session_id` → CLI session id
(persisted post-settle to the sessions-store sidecar
`<sessionsDir>/<sessionId>.cq-cli-session` (`CLI_SESSION_FILE` in
`index.ts`) — see the isolation paragraph for why it no longer lives in the
workspace); init/result `model` → the OBSERVED served model id, surfaced as
`WorkerResult.model`; assistant text → transcript; errored `tool_result`
events → frozen `{tool, reason}` denials; the terminal `result` event →
frozen Usage (`input_tokens`/`output_tokens`/`cache_read_input_tokens`/
`cache_creation_input_tokens`), `structured_output` →
`structuredOutput`, status → stopReason. Non-JSON lines become narration
(`toolName:'cli-narration'`), never a crash.

Pricing attribution: `costUSD` is derived over the OBSERVED served model id
(`{ ...modelSpec, model: servedModel ?? modelSpec.model }`; the provider
handle stays `modelSpec.provider`) — a gateway that silently remaps is
priced off the id the CLI actually reported, and pricing the requested id
would attribute the wrong rates. A served/reported mismatch with the
requested id is recorded as a `served-model-mismatch` narration marker
(issue #19): the conformance suite fails a mismatching run loudly (leg m);
production runs record the mismatch and price off the served id. Absent
when the map does not know the served id — the driver never fabricates USD.

Budget mapping (I8, the honest floor): a headless CLI has no mid-run
token hook — `Budget.maxTokens` is checked only against the folded
result usage (it can classify a finished run `budget`; stopping early on
tokens is governor/admission business). `wallClockMs` is the governor's
ladder (the driver forwards its signal to the kill ladder only);
`maxAttempts` means one spawn; `maxUsd` is caller-side derived
accounting. Stop reasons: governed abort → `aborted`; folded usage ≥
`maxTokens` → `budget`; result `success` → `complete`; any other result
status, no result event, or a spawn failure → `error`. Once spawned,
`run()` never throws past the seam — and a SYNCHRONOUS spawn failure is a
verdict too: it returns stopReason `error` with the failure narrated,
never a rejection. Every `error` verdict also populates
`WorkerResult.error` (bounded, secret-redacted): the cause from the CLI
result event when it carries one, else the child's exit code/signal or
spawn error, plus the retained stderr tail — so a 0-token failure is
diagnosable from the journal (#208).

Isolation (I6): no `sessionRef` → fresh temp workspace +
`SessionStore.create` (cwd = workspace); `sessionRef` →
`SessionStore.load` resumes the SAME workspace and passes `--resume`
when the sessions store carries the CLI session sidecar for that
sessionId (`<sessionsDir>/<sessionId>.cq-cli-session`, issue #26 design
(b) — RELOCATED out of the model-visible workspace, whose earlier
sidecar placement let the model read or alter its own resume handle
through the very tools the policy hands it; keyed by sessionId it is
exactly as precise and out of reach); a sidecar-less session resumes the
workspace only — an honest partial continuation; unknown
sessionRef throws. Session turns persist in our `SessionMessage`
vocabulary only.

Process groups (#19): on POSIX the child is spawned `detached` (its own
process-group leader) and the driver's kill signals the WHOLE group
(`process.kill(-pid)`), so agent-spawned descendants die with the CLI;
Windows has no Job Object in v1 (descendants can survive there —
recorded limitation in `src/driver/subprocess/process.ts`). Stdout/stderr
retention is bounded to a 1 MiB tail (`DEFAULT_MAX_RETAINED_BYTES`,
`SpawnOptions.maxRetainedBytes`) with the dropped byte count on
`ProcessClose.droppedBytes` — the verdict path folds evidence from the
line callbacks, so the cap bounds the buffer, never the evidence.

## First-party driver: `claude-agent` (T1.6)

`src/driver/claude-agent/` — the THIRD lane: drive the agent-SDK host
(`query({ prompt, options })` of `@anthropic-ai/claude-agent-sdk`) as a
governed worker on the frozen seam. One query per run, no daemon, no
pooling, no retries.

Files:

- `index.ts` — `ClaudeAgentDriver implements Driver` (constructor options:
  `sdkLoader?`, `endpointTable?`, `outputSchema?` → the SDK's native
  `outputFormat: { type: 'json_schema' }`, `harnessConfig?`,
  `sessionsDir?`, `pricing?`, `envAllowlist?`). The env option contains
  additional host variable names exposed to the SDK child and harness
  `run` children through the manifest; invalid names are rejected at
  construction. Before the CLI receives the schema, the
  driver removes `$schema` properties and absolute
  `http(s)://json-schema.org/` values under `$ref`, `$dynamicRef`, and
  `$recursiveRef` (`stripMetaSchema`).
- `routing.ts` — PROVIDER-only endpoint routing as CONFIG
  (`EndpointTable`, `defaultEndpointTable()` — zai / deepseek / anthropic,
  values from provider docs, as-of 2026-09; `resolveEndpoint`). Resolves
  base URL + auth env NAME for the provider handle; unknown provider
  throws pre-dispatch. Env var NAMES only, never key values.
- `process.ts` — the I8 scan's exempt file for this lane: construction of
  the SDK query's cancellation root (`Options.abortController`), wired
  from the governed signal. The driver decides nothing about WHEN to
  abort; the helper only obeys.

Optional-peer semantics: `@anthropic-ai/claude-agent-sdk` is an optional
peerDependency (`"peerDependenciesMeta": { "optional": true }`), NEVER a
dependency. The SDK is loaded lazily by dynamic import at run() time via
the `sdkLoader` constructor seam (tests inject a plain-object mock; the
conformance suite never touches the network or a real CLI) and
feature-detected against the driven surface (query / tool /
createSdkMcpServer) — capability detection, never version checks. A peer
that is absent (or misshaped) is a PRE-DISPATCH throw naming the peer and
the install command — the same posture as a missing API key: fail loudly
before any session exists, never a crash mid-run. Install the peer with:

```
npm install --save-optional @anthropic-ai/claude-agent-sdk@0.3.270
```

The repo builds and the whole suite passes with the peer ABSENT; the
`install-matrix` workflow proves both halves on every PR.

NO MODEL ALLOWLIST (owner override 2026-09-14): any model id reachable
over an anthropic-compat endpoint is permitted. Routing is by PROVIDER
only; the model id rides `Options.model` UNCHECKED — there is no
routeFor-style throw on model names. The silent-remap defence is the
OBSERVED-MODEL CHECK (conformance leg m): the driver surfaces the model
id the agent reports as served (init frame `model`, overwritten per
assistant frame by the response-carried `message.model`) into
`WorkerResult.model`, and the suite fails a lane that remaps silently or
cannot observe. A pre-dispatch allowlist (the subprocess lane's choice)
and post-dispatch observation are alternative defences; this lane
deliberately takes the second.

Tool policy mapping (the governed surface, exact): built-in agent tools
are disabled wholesale (`tools: []`), and `settingSources: []` +
`strictMcpConfig: true` keep the account's claude.ai connectors off the
surface under subscription auth (W1.4 live leg A.5j); the FIRST init frame
is asserted fail-closed against the expected surface. The ONLY surface is
the harness read/edit/run surface — the shared core's bound surface
(`src/harness/surface.ts`), registered as the SDK's in-process custom tools
(`createSdkMcpServer` + `tool(...)` under one server name, addressable as
`mcp__<server>__<name>` in `allowedTools`). Mode `allowlist` (default) →
harness ∩ `policy.allow`; `unrestricted` → the whole harness surface;
`none` → no server at all + empty `allowedTools`. `permissionMode` stays
`default` in every mode — the surface restriction IS the policy: headless,
an un-pre-approved tool is auto-denied (never prompted), and those
SDK-side refusals (the result's `permission_denials`) map into
`WorkerResult.denials` next to the harness denials observed at the
execute boundary (each denial is also the tool's error output text, so
the model can adapt).

Sandbox mapping (honest): `none` → no sandbox option; `workspace-write` /
`read-only` → `sandbox: { enabled: true, failIfUnavailable: false }` —
the agent's OS sandbox is DEFENSE-IN-DEPTH only. Enforcement stays in the
harness tools (workspace containment, allowlists, the read-only denial
reasons); a platform without sandbox support degrades to that documented
enforcement instead of failing the run on a capability we do not rely on.

Budget mapping (I8): the driver owns NO wall clock — the governed
`currentJobContext()?.signal` is forwarded to the SDK query's
cancellation root and `Budget.wallClockMs` is ignored (the governor's
ladder decides when). The DD-1 spike MEASURED this lane's cooperative
abort settle live: ≈2.0 s after the signal, with no post-abort transcript
growth and no surviving worker process (docs/dd-1-abort-spike.md).
`Budget.maxTokens` has NO native SDK stop (the SDK's caps are turns, USD,
and an alpha pacing budget — none is a token stop), so it is enforced the
subprocess lane's way: post-hoc verdict classification over the folded
result usage — it classifies a finished run `budget` but cannot stop one
early. `maxAttempts` means one query; `maxUsd` is caller-side derived
accounting.

Stop reasons: governed abort (or abort-shaped failure) → `aborted`;
folded usage ≥ `maxTokens`, or the SDK's own cap subtypes
(`error_max_turns` / `error_max_budget_usd`) → `budget`; result `success`
with `is_error` ≠ true → `complete`; any other result status, or no
result event → `error`. Once dispatched, `run()` never throws past the
seam.

Isolation (I6): no `sessionRef` → fresh temp workspace +
`SessionStore.create`; `sessionRef` → `SessionStore.load` resumes the
SAME workspace and passes `Options.resume` when the sessions store
carries the agent session sidecar for that sessionId
(`<sessionsDir>/<sessionId>.cq-cli-session`, `AGENT_SESSION_FILE` —
issue #26 design (b), matching the subprocess lane: RELOCATED out of the
model-visible workspace, where the harness edit tool's `**/*` glob
includes dotfiles and the earlier placement let the model read or alter
its own resume handle; keyed by sessionId beside the session records the
handle is exactly as precise and out of its reach; a sidecar-less
session resumes the workspace only, an honest partial continuation);
unknown sessionRef throws. Session turns persist in our
`SessionMessage` vocabulary only. Structured output rides the SDK's
NATIVE `outputFormat: { type: 'json_schema' }` path; the result's
`structured_output` is validated against the configured zod schema
post-settle — a payload that fails is dropped to narration, never
trusted. Usage maps the result vocabulary (`input_tokens` /
`output_tokens` / `cache_read_input_tokens` /
`cache_creation_input_tokens`); `reasoning` is deliberately OMITTED —
the SDK's `thinkingTokens` are already counted inside `output_tokens`,
so a separate field would double-count every total (Budget.maxTokens
classification). Invariant across the seam: `reasoning` is an `output`
breakdown and must already be included in `output` — the frozen field
stays optional for lanes that REPORT the breakdown, never for additive
accounting. `costUSD` is
NEVER reported on unmeasured error/abort verdicts — the SDK's own
`total_cost_usd` estimate is deliberately not surfaced (a vendor-side
cost figure would bypass the derived-only rule).

## First-party driver: `acp` (T1.8)

`src/driver/acp/` — the FOURTH lane: speak the Agent Client Protocol
(newline-delimited JSON-RPC 2.0 over stdio) to a vendor HARNESS binary
(`zcode-acp-server` by default; `dsh-acp` as the fast-follow endpoint) as
a governed worker on the frozen seam. One spawn per run, no daemon, no
pooling, no retries. The vendor's tools execute in the VENDOR's process;
our role is the ACP client and the permission authority. Full operator
docs: **`docs/acp-driver.md`**; the governing strategy + live-probe
evidence: `docs/acp-driver-strategy.md`.

Files:

- `index.ts` — `AcpDriver implements Driver` (constructor options:
  `command?`/`endpoint?`/`endpointTable?` (binary discovery, §3 posture),
  `envNames?`/`modelEnv?` (env var NAMES — never values), `outputSchema?`
  (prompt-directed JSON), `workspaceRoot?`, `sessionsDir?`, `pricing?`,
  `termGraceMs?`/`killGraceMs?`, `spawn?` test seam).
- `protocol.ts` — OUR wire vocabulary: zero vendor imports (I10); the
  shapes were transcribed from live probes (nested `session/update`
  payloads, `configOptions` model reporting, kind-based permission
  options) and include the FULL permission answer table as helpers.
- `binaries.ts` — the endpoint registry (discovery only — never bundled,
  never a dependency): explicit argv first, which-like PATH fallback, an
  absent binary is a PRE-DISPATCH throw naming the binary + install hint.
- `process.ts` — the I8 scan's exempt file for this lane: the shell-less
  spawn and the SIGTERM→SIGKILL settle-time termination ladder.

ACP permission allowlists use the request's authoritative `kind`, mapping
`execute` to the toolkit's `run` identity. Titles and call IDs never authorize
a tool. Vendors that omit `kind` cannot satisfy an allowlist: requests are
rejected with an explicit missing-kind denial, even if the title or call ID
matches a grant. Such vendors need kind reporting to support allowlists;
`unrestricted` retains its explicit allow-all behavior, while `none` and
read-only sandbox policies still deny execution.

ACP environment migration: the vendor process no longer inherits the full
host environment. It receives the default child-env allowlist plus
`envNames` and deployment `CQ_RUN_ENV_PASSTHROUGH` names (comma- or
whitespace-separated). Operators using environment-based vendor
authentication must include the credential variable names in `envNames`.
Configure names only; values are read at `run()` time, and a missing or
empty explicitly named value throws before dispatch or session creation.
`modelEnv`, when configured, explicitly sets its variable to the requested
model id. These options govern the ACP vendor process and its tools;
they do not bind a shared harness manifest or configure harness `run`
children.

Lane specifics (all cited in the strategy doc): THE MODE PIN — sessions
open in `yolo`, which never asks, so the driver pins
`session/set_config_option { configId: 'mode', value: 'build' }` before
ANY prompt (a failed pin is a pre-prompt error verdict); the permission
answer table selects by option KIND (optionIds are vendor strings) and
never answers `cancelled`; the NEVER-ASKS TRIPWIRE records a
`tool_call` with no preceding permission request as ungated-execution
evidence and fails the run; `WorkerResult.model` reads the
POST-MATERIALIZATION `config_option_update` value only (the `session/new`
entry is the lazy default); usage folds only `PromptResponse.usage`
(`cachedWriteTokens` folds; `reasoning` is never emitted — thoughtTokens
additivity is unproven); cancel settles `aborted` on the cancelled prompt
response. `authenticate` is never called (OQ-1: no auth gate; an
`auth_required` error fails the run naming the advertised authMethods).
