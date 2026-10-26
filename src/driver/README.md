# Driver seam

The seam between the toolkit and any worker that can run a prompt. One
method: `Driver.run(opInvocation) → Promise<WorkerResult>`. Source of
truth: `src/driver/types.ts` (types); zod mirrors of the serializable
parts live in `src/driver/schema.ts` and are re-exported by
`src/kernel/schema.ts`.

## The contract

`OpInvocation` — everything a driver needs to run one prompt:

- `prompt: string`
- `modelSpec: ModelSpec` — `{ model: string; provider: string }`
- `toolPolicy: ToolPolicy` — `{ allow: readonly string[]; mode?: 'allowlist' | 'unrestricted' | 'none' }`
- `sandboxPolicy: SandboxPolicy` — `{ level: 'none' | 'workspace-write' | 'read-only' }`
- `sessionRef?: string` — opaque session handle for multi-turn continuation
- `budget: Budget` — `{ maxUsd?, maxTokens?, maxSteps?, wallClockMs?, maxAttempts? }`

`WorkerResult` — the plain-data outcome:

- `structuredOutput?: unknown`
- `usage: Usage` — `{ input, output, cacheRead, cacheWrite, reasoning? }`
  (tokens; `reasoning` is additive only when the lane's SDK reports
  reasoning OUTSIDE output — a lane whose SDK counts thinking inside
  output must not emit it)
- `steps?: number` — completed SDK steps, only when observed by the lane
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

## Step budget support

`Budget.maxSteps` is an optional positive integer. Support is lane-specific:

| Lane              | Enforces `maxSteps`                                                                                                                                                              | Reports `WorkerResult.steps`                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ai-sdk`          | Yes. Main-loop cap is `min(maxSteps, 40)`; absent means 40. A structured-output repair remains its existing single bounded step and can make the total exceed the main-loop cap. | Yes. Counts each completed main and repair SDK step via `onStepFinish`, including partial/error verdicts. |
| `claude-code` CLI | No. No direct invocation-level CLI turn-limit mapping is used.                                                                                                                   | No. The stream does not expose a reliable completed SDK-step count.                                       |
| `claude-code` SDK | Yes. Maps `maxSteps` directly to the pinned Agent SDK `Options.maxTurns` (0.3.270).                                                                                              | No. Result usage aggregates worker activity, not completed SDK turns.                                     |
| `acp`             | No. ACP has no direct supported turn-limit mapping in this driver.                                                                                                               | No. Protocol observations do not provide a reliable completed SDK-step count.                             |

The existing `maxTokens` token-guard and governed wall-clock cancellation
semantics are independent of `maxSteps` and unchanged. In particular,
`maxTokens` remains a post-step usage check on `ai-sdk`, not a strict
pre-request guarantee. Unenforced lanes do not imply enforcement or
synthesize a `steps` value.

## Freeze rule

Frozen under tag `types-freeze-v1`. After the tag, any change to a frozen
name or field is a separate migration PR with its own review — never an
edit inside a later goal.

## I10 boundary

`src/driver/types.ts` sits INSIDE the vendor-import ban (eslint rule
`cq/no-vendor-sdk-in-kernel`, same scope as `src/kernel/**`). The three
driver implementations under `src/driver/drivers/` (in-process SDK,
the Claude Code CLI/SDK transports, ACP) adopt vendors deliberately and are NOT covered.

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
- `harnessConfig?` — harness tool surface + prompt budget
  (default: `defaultHarnessConfig`).
- `beforeRequest?` — ai-sdk-only upload gate. It receives serialized text,
  decoded content leaves, and an optional `{ kind }` context: `model-request`
  before each SDK model send (including forced-final and repair requests), or
  `tool-output` before a successful tool result is exposed to the model. The
  metadata is additive; existing two-argument callbacks remain compatible.

Structured output (seam v2, ADR-0002 section 2.3): there is NO
construction-time schema — the request rides `OpInvocation.outputSchema`
(built with `toOutputSchema(name, zodSchema)` from
`../common/structured.js`); when set, the SDK structured-output path
(`Output.object`) runs and the parsed value lands in
`WorkerResult.structuredOutput`.

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

Prompt placement: the system message contains only the driver-owned,
tool-aware preamble. The caller's operation prompt is admitted against the
harness prompt budget and sent once as a user turn; persisted session history
continues to replay through the transcript, including same-prompt retry reuse.
Prompted-schema requests may add a separate schema-contract user turn.

rg capability seam (per-lane): the ai-sdk lane is the ONLY lane that
populates `WorkerResult.capabilities.rg` and `WorkerResult.advisories` —
every other lane leaves both undefined (the conformance suite accepts the
absent fields). The probe is injected via the runtime-only constructor
option `resolveRg` (async, bounded `rg --version` child, cancellation
honored; NEVER HarnessConfig/Zod data, and the resolved binary path is
never reported). One probe per RUN — memoized on the run's promise, shared
by search-tool withholding and the result record, never per selection:

- `rg` present at >= the documented minimum (`RG_MINIMUM_VERSION`, 15.2.0):
  `capabilities.rg = { available: true, version, minimum, probe: 'ok' }`;
  grep/glob stay on the surface; no advisory.
- `rg` absent or too old: `capabilities.rg = { available: false, minimum,
probe: 'absent' | 'old', found? (the too-old version) }`; grep/glob are
  WITHHELD from the surface and `advisories` carries exactly
  `"search tools unavailable: ripgrep not found"` or
  `"search tools unavailable: ripgrep older than minimum 15.2.0"`.
- A run whose ToolPolicy does not request grep never probes and records
  nothing (the distinguishable not-configured state).

Boundary caveat (named in the harness tools header): the harness containment
is lexical and the `run` tool is the SYMLINK-PLANTING VECTOR — an allowlisted
command can plant a symlink pointing outside the workspace. read/edit
realpath-recheck existing paths (pre-existing symlinks are denied), but a
symlink planted after the check is a documented TOCTOU window; the mitigation
is keeping run command allowlists tight (never allowlist `ln`).

Budget mapping (I8): the driver owns NO wall clock — it forwards the
run's `RunOptions.signal` (seam v2 — the caller passes the governed rung-1
signal explicitly) as the SDK `abortSignal` and
ignores `Budget.wallClockMs` (the governor's ladder decides when to abort);
`Budget.maxTokens` becomes a timer-free `stopWhen` condition over
accumulated step usage; `Budget.maxSteps` lowers the main-loop cap from its
default of 40 (never raises it), and completed main plus repair steps are
reported via `WorkerResult.steps`; `maxAttempts` is the runner/governor's retry
business (one attempt per run); `maxUsd` is caller-side derived accounting.
`Budget.strictTokenBudget` (opt-in, separate — it does NOT redefine
`maxTokens`) wraps the resolved model so every wire attempt counts the full
request and reserves input + reserved output BEFORE the send. It requires an
operator-injected `AiSdkDriverOptions.strictTokenCapability` (metering +
output-ceiling code); there is NO built-in or provider-list capability, so a
strict budget REFUSES pre-dispatch in production until a deployment injects a
proven one (`pre-request-ceiling.ts` documents what a capability must
account for). A refusal that means a REAL token cap (input ceiling, output
reserve, shared whole-job allowance) settles as `stopReason: 'budget'`; a
capability/serialization/durable-hook failure settles a diagnostic
`stopReason: 'error'` (never misreported as budget-exhausted), and a governed
abort settles `'aborted'`.
`AiSdkDriverOptions.strictTokenReservationHook` (also
`DriverFactoryConfig.lanes.aiSdk.strictTokenReservationHook`) is the durable
pre-wire reservation point for an external ledger: it receives the resolved
model identity and a TS-LOCAL `countableProjectionDigest` — sha256 over the
countable projection only, EXCLUDING headers/abortSignal/includeRawChunks, so
it is not a whole-wire digest. The hook is ABORT-AWARE: it races the run's live
signal, so a hung hook settles the cancellation (keeping the local charge — no
refund) instead of wedging the run, and no params reach the wire on abort. It
is NOT the Python
`token_guard.request_sha256` canonical sorted-ASCII form and is not
interoperable with an external ledger; a shared cross-language canonical
projection protocol does not exist and is an activation blocker for that
bridge. With no hook the shared token allowance is enforced per-invocation
only — a named gap, not a whole-job claim.
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

Failure classes (seam v2, RS-14): every `error` verdict carries the
STRUCTURED `WorkerResult.errorClass` — classified from SDK status codes and
error names per the ADR section-2.2 cut rules (`output-invalid` for a
structured-output miss: the required object was not produced / did not
validate; `auth`/`quota`/`rate-limit`/`transient`/`provider-error`/`harness`
from the provider signals; `unknown` at worst) — so consumers read the
class, never narration-text tokens. The verdict stays `error` and
`structuredOutput` is never fabricated on a miss. A token cap or a
governed abort that leaves the final step on tool-calls is the honest
`budget`/`aborted` verdict instead — the missing object is its consequence,
not a driver failure — and `structuredOutput` is likewise never fabricated
on those paths. The remaining `errorClass` values come from the structured
cuts: `'transient'` for the SDK-retryable class (endpoint header timeout,
network error) AND the non-retryable step-timeout abort (its `TimeoutError`
name), `'rate-limit'`/`'quota'`/`'auth'`/`'provider-error'` per the limit
rules, and `'unknown'` for anything message-only (a bare message regex is
never a class). The classification lives in the exported pure
`classifyRunFailure(err)`.

Pricing attribution: `costUSD` is derived via
`src/driver/pricing/index.ts` (`computeCostUSD`) over the vendored
models.dev table (`src/driver/pricing/data.ts` — MIT, verified in
docs/reverify-2026-09.md with the copyright notice preserved there;
values as-of 2026-09). `costUSD` is absent when the map does not know the
model — the driver never fabricates USD.

## First-party driver: `claude-code` (Phase 1.9 — the D-E′ consolidation)

`src/driver/claude-code/` — ONE cq-owned lane for the Claude Code substrate
(owner ruling D-E′, option A), merging the former `subprocess` (T1.5) and
`claude-agent` (T1.6) lanes. CLI PRIMARY, Agent SDK OPTIONAL: the substrate
path is CONFIGURATION (`transport: 'cli' | 'sdk'`, default `'cli'`), never
a src literal. One spawn/query per run, no daemon, no pooling, no retries.

Files (what the merge SHARES — one implementation each):

- `index.ts` — `ClaudeCodeDriver implements Driver`: the transport
  selection over the shared knobs (`routingTable?`, `sessionsDir?`,
  `harnessConfig?`, `pricing?`, `envAllowlist?`) plus per-transport knobs
  (CLI: `binary?`, `termGraceMs?`/`killGraceMs?`, `toolSurface?` — default
  `'harness'`, `'stock'` is the D6 null-hypothesis EVAL mode, reachable
  only by constructing the class directly — and a `spawn?` test seam;
  SDK: `sdkLoader?`). An unknown transport value throws at construction.
- `routing.ts` — THE ONE env-based routing table as CONFIG
  (`RoutingTable`, `defaultRoutingTable()`, `resolveRoute`): zai /
  deepseek / anthropic anthropic-compat endpoints (provider docs,
  as-of 2026-09); the endpoint is injected purely through env
  (`ANTHROPIC_BASE_URL` + auth-token vars); the model id rides through
  UNCHECKED (the model allowlist is retired, ADR-0002 §2.6 + owner
  override 2026-09-14 — the historical `models` rows are accepted table
  data, never enforced). The SILENT-REMAP DEFENCE is the OBSERVED-MODEL
  check: the lane surfaces the id the substrate reports as served into
  `WorkerResult.model` and the shared served-model assertion fails a
  remap post-hoc. Routes carry env var NAMES only, never key values.
- `process.ts` — the I8-exempt SDK cancellation-root wiring
  (`abortRootFollowing`). The CLI process ladder (`spawnManaged` and
  `terminateGracefully`) and single env scrub remain in `shared/proc.ts`
  after migration 1.1. The governor decides WHEN to abort; both helpers
  only execute that decision.
- `usage.ts` — THE ONE worker-accounting fold: the result frame's
  `modelUsage` per-model token aggregates when well-shaped (the SDK's
  camelCase aggregate vocabulary; subagent spend INCLUDED; tokens only —
  cost stays derived), else the flat main-loop `usage`, else the Σ
  assistant-frame usage. `usage-provenance` narration markers record the
  surprising folds only (assistant fallback; an aggregate that includes
  spend beyond the flat usage, naming the contributing models — absence
  is the documented default-channel baseline, and the record's role-'tool'
  shape stays "a tool ran"). `resumed-usage-semantics` markers record the
  version-gated per-call-vs-cumulative boundary on resumed sessions (the
  reported figure is recorded verbatim, never a fabricated delta —
  session-cumulative on CLI ≥2.1.277-shaped pins, per-call before).
  Lying numerics fold to the honest zero (#19-3); unmeasured verdicts
  report the zero fold and NEVER a cost.
- `failures.ts` — THE ONE error-class classifier (ADR-0002 §2.2 cut
  order): oversized line → `harness`; `enforced_spend_limit_reached`, the
  structured assistant `error:'rate_limit'` field, the CLI
  "You've hit your … limit · resets …" result and the funded-allowance
  prose rows → `quota` (+ the extractable reset instant in
  `providerSignals.windows[*].resetAt`); `rate_limit_error` and the
  throttle rows → `rate-limit` (retry-after in
  `providerSignals.retryAfterMs` when the vendor states one); a
  result-frame error → `provider-error`; the codex row (real usage folded,
  non-zero exit, no result event) → `provider-error`; spawn/exit/crash
  surfaces → `harness`. Anchored patterns only, never a numeric-status
  scan.
- `sessions.ts` — the ONE substrate-session sidecar protocol
  (`CLI_SESSION_FILE` = `.cq-cli-session`), shared by both transports so
  a record created by one resumes honestly on the other.
- `verdict.ts` — the ONE stop-reason map and the ONE structured-output
  judge. THE REFUSAL VOID (D-E′ F2): `stop_reason: 'refusal'` observed on
  any assistant/result frame voids any structured payload outright —
  error/`output-invalid`, the payload never reaches the seam, whatever
  its shape (the pre-0.3.302 defect delivered refused responses THROUGH
  `structured_output`); recorded, version-labelled fixtures pin the
  behavior for both transports (`test/fixtures/claude-code/`). A refusal
  on a schema-less run is a normal model outcome (the transcript carries
  it) with the `model-refusal` narration marker as the observable fact.
  The cap subtypes (`error_max_turns` / `error_max_budget_usd`) classify
  `budget` on BOTH transports (one stop-reason map).
- `cli.ts` — the CLI transport (PRIMARY): the headless
  `claude -p …` stream-json path.
- `sdk.ts` — the SDK transport (OPTIONAL): the agent-SDK host
  (`query({ prompt, options })` of `@anthropic-ai/claude-agent-sdk`).

Child environment is DEFAULT-DENY (issue #183) for the CLI, the SDK child,
the ACP vendor process, and every harness `run` child. All use the shared
`buildChildEnv` policy in `shared/proc.ts`. The policy copies ONLY `DEFAULT_CHILD_ENV_ALLOWLIST`
(PATH/HOME/SHELL/USER/temp dirs, terminal + locale basics, XDG dirs,
network-egress/TLS config (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, proxy
vars), Windows equivalents) from the entry process env. By default it
excludes `GH_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, `NPM_TOKEN`,
`SSH_AUTH_SOCK`, and `NODE_OPTIONS`/`NODE_PATH` — and nothing `CQ_*` ever
reaches a worker (the sandbox policy knobs are launcher-side only). Per-
route endpoint/auth vars are composed explicitly into the substrate
child's environment and always win over the allowlist; these credential
overrides are not passed to harness `run` children. A deployment extends
the copied names with `ClaudeCodeDriverOptions.envAllowlist` (names only,
never values). TWO CAVEATS (issue #183 r1/r2): proxy vars are inherited
because egress needs them and their URL MAY embed credentials a worker can
read (leave them unset to avoid that); and `HOME` stays inherited because
the CLI reads its own config there, so a worker with file-read tools can
still reach `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.npmrc`, …
— that boundary is the `ToolPolicy`/sandbox surface, not this env
allowlist.

The lane carries its explicit `envAllowlist` through the harness
manifest's `envNames`. The manifest also captures names from the
deployment variable `CQ_RUN_ENV_PASSTHROUGH` (comma- or
whitespace-separated names). The shared core filters the environment at
every `run` execution, including in-process SDK tools and direct
`buildTools` calls; the stdio server's startup scrub is an additional
boundary.

CLI argv surface (headless reference, harness mode — the default): `-p`
(prompt rides stdin), `--output-format stream-json`, `--verbose` (the real
CLI refuses stream-json print mode without it — found live, CLI 2.1.270),
`--json-schema <schema>` when the invocation carries `outputSchema`, then
the CLOSED SURFACE (W1.4): `--tools ""` (builtins absent, not denied),
`--setting-sources ""` (no ambient settings), `--strict-mcp-config` (no
ambient MCP servers), `--mcp-config
<sessionsDir>/<sessionId>.<run-uuid>.cq-harness-mcp.json` (unique per run,
created `O_EXCL` 0600; a name collision is a hard error) when the selected
surface is non-empty, and `--allowedTools` — ALWAYS present, ONE
space-joined argv element holding the qualified spellings
`mcp__cq-harness__<name>` of harness ∩ the frozen ToolPolicy (empty = mode
`none`). Then `--model <route.model>` and `--resume <cli-session-id>` on
sessionRef resume. No undocumented flags: `--permission-prompts none` and
`--bare` were removed (issue #19). Stock mode keeps the legacy argv (no
closed-surface flags; harness names in `--allowedTools`, inert) — eval
only, never a factory or plan key, not admissible in production.

The SDK transport's closed-surface counterpart: `tools: []` (built-ins
off), `settingSources: []` + `strictMcpConfig: true` — ambient workspace
settings (`.claude/settings.json`, `.mcp.json`) and the account's
claude.ai connectors are structurally EXCLUDED (W1.4 live leg A.5j);
`permissionMode: 'default'` headless (un-pre-approved tools auto-denied,
the result's `permission_denials` map into `WorkerResult.denials`);
`env` = the default-deny child env + the route credentials;
`outputFormat: { type: 'json_schema' }` when the invocation carries a
schema (schema stripped of meta-URIs first, same as the CLI transport);
`Options.resume` from the shared sidecar on resume.

Closed tool surface (W1.4 — RS-12 design, ADR-0002 Annex A) — BOTH
transports serve the SAME shared core `src/harness/surface.ts`:
`buildManifest` (workspace realpath, sandbox level, harness ∩ policy,
harness config, env names) → CLI over stdio (`cq-harness-mcp`,
`src/harness/mcp/`, launched as `process.execPath` + the module-relative
`dist/harness/mcp/bin.js` — never PATH/npx/plan data; the server
re-validates the manifest, chdirs, scrubs its env, or exits 78 before
`initialize`), SDK in-process (`createSdkMcpServer` + `tool(...)`, handler
`surface.call` — byte-identical CallToolResults; the two-level parity test
`test/driver/harness-parity.test.ts` pins it). The driver asserts the
FIRST `system/init` fail-closed (exactly `cq-harness`/connected and
exactly the qualified selected tools, plus `StructuredOutput` when
structured output is requested), classifies `is_error` harness results
three ways (harness denial by prefix / permission denial / anything else
= transport failure, CLI transport), and settles every harness failure as
stopReason `error` with a `HARNESS_ERROR_PREFIX` cause and an
`errorClass: 'harness'` narration marker. Named limitations: a same-uid
`run` command can still read an ancestor's environment (OS confinement);
a server killed without SIGTERM orphans an in-flight command group until
it exits on its own. The SDK transport's sandbox option
(`sandbox: { enabled: true, failIfUnavailable: false }`) is
DEFENSE-IN-DEPTH only — enforcement stays in the harness tools.

The shared `run` tool accepts six closed-form `git diff` commands and
three closed-form `git log` commands, each still requiring an allowlist
grant. They select constant argv with `shell: false`; path and revision
arguments are unavailable. Both transports use the same process lifecycle
for these commands and ordinary shell commands: bounded output, timeout,
cancellation, and POSIX process-group termination. See the exact forms and
config pins in [the harness README](../harness/README.md).

TRUST STATEMENT (issue #28): in harness mode the harness enforces the
TOOL-level sandbox mapping on this lane (read-only denials, workspace
containment, path/command allowlists); OS confinement stays unenforced,
so a requested level with a non-empty surface records
`{cq: 'sandbox-level-unenforced', level, layer: 'os'}` (CLI transport).
`run` commands keep host privileges (the harness trust boundary). In
stock mode the CLI's own permission model governs and the legacy marker
(no `layer`) records that nothing was enforced by the harness.

Budget mapping (I8, the honest floor): the lane owns NO wall clock — the
governed `RunOptions.signal` is forwarded to exactly one cancellation
mechanism per transport (the CLI kill ladder / the SDK query's
`abortController`); `Budget.wallClockMs` is the governor's ladder's
business. The DD-1 spike MEASURED the SDK transport's cooperative abort
settle live: ≈2.0 s after the signal, no post-abort transcript growth, no
surviving worker (docs/dd-1-abort-spike.md). `Budget.maxTokens` is
enforced POST-HOC over the shared usage fold on both transports (it
classifies a finished run `budget`; stopping early on tokens is
governor/admission business). `maxAttempts` means one spawn/query;
`maxUsd` is caller-side derived accounting. Stop reasons (the ONE map):
governed abort → `aborted`; harness failure → `error`; folded usage ≥
`maxTokens` or a cap subtype → `budget`; result `success` → `complete`;
anything else → `error`. Once dispatched, `run()` never throws past the
seam — and a SYNCHRONOUS spawn failure is a verdict too (CLI transport).
Every `error` verdict populates `WorkerResult.error` (bounded,
secret-redacted; #208).

Isolation (I6): no `sessionRef` → fresh temp workspace +
`SessionStore.create` (cwd = workspace; a workspace binding creates the
fresh record IN realpath(workspace.path) and a resume/workspace mismatch
throws pre-dispatch); `sessionRef` → `SessionStore.load` resumes the SAME
workspace and passes the substrate resume handle when the sessions store
carries the sidecar (`<sessionsDir>/<sessionId>.cq-cli-session`, issue #26
design (b) — RELOCATED out of the model-visible workspace, whose earlier
sidecar placement let the model read or alter its own resume handle
through the very tools the policy hands it); a sidecar-less session
resumes the workspace only — an honest partial continuation; unknown
sessionRef throws. Session turns persist in our `SessionMessage`
vocabulary only (`cli-narration` / `agent-narration` are the two
transports' narration toolNames).

Process groups (#19): on POSIX the CLI child is spawned `detached` (its
own process-group leader) and the kill signals the WHOLE group, so
agent-spawned descendants die with the CLI; Windows has no Job Object in
v1 (descendants can survive there — recorded limitation in
`src/shared/proc.ts`; the supported descendant-cleanup
guarantee is POSIX-only until independently proven on Windows).
Stdout/stderr retention is bounded to a 1 MiB tail
(`DEFAULT_MAX_RETAINED_BYTES`, `SpawnOptions.maxRetainedBytes`) with the
dropped byte count on `ProcessClose.droppedBytes`.

Optional-peer semantics (sdk transport): `@anthropic-ai/claude-agent-sdk`
is an optional peerDependency, NEVER a dependency. The SDK is loaded
lazily by dynamic import at run() time via the `sdkLoader` seam (tests
inject a plain-object mock) and feature-detected against the driven
surface (query / tool / createSdkMcpServer) — capability detection, never
version checks. A peer that is absent (or misshaped) is a PRE-DISPATCH
throw naming the peer and the install command. The repo builds and the
whole suite passes with the peer ABSENT; the `install-matrix` workflow
proves both halves on every PR. Refusal detection is the D-E′ F2
alternative to a pin bump: the lane detects `stop_reason: 'refusal'`
structurally (available in the vendor vocabulary since the 0.3.162-era
frames) instead of requiring ≥0.3.302 pins — the recorded fixtures pin
both the detection and the void.

Pricing attribution: `costUSD` is derived over the OBSERVED served model
id (the provider handle stays `ModelSpec.provider`); a served/reported
mismatch is recorded as a `served-model-mismatch` narration marker and
the conformance suite fails it loudly (leg m). `costUSD` is NEVER
reported on unmeasured error/abort verdicts, and the SDK's own
`total_cost_usd` estimate is deliberately not surfaced — a vendor-side
cost figure would bypass the derived-only rule.

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
  `envNames?`/`modelEnv?` (env var NAMES — never values),
  `workspaceRoot?`, `sessionsDir?`, `pricing?`,
  `termGraceMs?`/`killGraceMs?`, `spawn?` test seam. The structured-output
  schema rides the INVOCATION (`OpInvocation.outputSchema`, seam v2) and
  drives prompt-directed JSON.)
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
