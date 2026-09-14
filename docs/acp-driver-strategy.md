# T1.8 strategy — the ACP driver lane (strategy before implementation)

> **Plan identifier:** `T1.8` comes from the toolkit's development plan,
> maintained outside this repo (private research notes). This file is the
> STEP-1 artifact: the design is settled here, BEFORE any driver code
> exists. The implementation must conform to this document or amend it
> first — this doc is reviewable on its own and every protocol claim about
> the reference carries a `file:line` citation.
>
> **Sources of truth, and which one backs what:**
> - **Reference implementation** — paseo's generic ACP client, READ-ONLY,
>   at commit `b86df6ce6` (2026-09-14). Cited below as `generic-acp-agent.ts:NN`
>   and `acp-agent.ts:NN` (both under
>   `packages/server/src/server/agent/providers/`; `package.json:NN` is
>   `packages/server/package.json`). The reference is evidence, never code
>   to copy, and the toolkit takes NO dependency on paseo.
> - **ACP spec** — https://agentclientprotocol.com `/protocol/v1/*` pages
>   (initialization, authentication, session-setup, prompt-turn,
>   tool-calls, schema), fetched 2026-09-15. The spec is the protocol
>   source of truth wherever the reference and the spec disagree; the
>   disagreement itself is recorded.
> - **Host probes** — this machine, 2026-09-15 (§3).

## 0. What this lane is

A FOURTH driver lane (`acp`) speaking the Agent Client Protocol over stdio
to vendor harness binaries — `zcode-acp-server` (Z.AI) and `dsh-acp` from
`@openma/deepseek-harness-acp` (DeepSeek). Commercial basis: Z.AI discounts
work done through its own binary, so routing a run through the vendor's
harness is a cheaper wire for the same model. This is a protocol
implementation (JSON-RPC 2.0 over stdio against the vendor's process), not
a config entry — the largest single item in WS-B. One spawn per run, no
daemon, no pooling, no retries: the same R2 posture as every other lane.

The architectural difference from the three existing lanes: the ai-sdk and
claude-agent lanes execute OUR harness tools (read/edit/run,
`src/harness/tools.ts`) inside OUR workspace. An ACP run executes the
VENDOR harness's own tools in ITS process; our role is the ACP *client*
(and the permission authority). The vendor's tool surface, sandbox, and
model wiring are the vendor's — the seam mapping below is honest about
what that leaves us unable to enforce.

## 1. The protocol subset the seam actually needs

### 1.1 What the reference actually speaks (evidence, not aspiration)

The reference client (`GenericACPAgentClient extends ACPAgentClient`,
generic-acp-agent.ts:57) speaks ACP through `@agentclientprotocol/sdk`
(paseo `package.json:71` pins `^0.17.1`; imports at acp-agent.ts:14-70).
Its live message flow, in order:

1. **Spawn + initialize.** `initializeTransport` calls
   `connection.initialize({ protocolVersion: PROTOCOL_VERSION,
   clientCapabilities, clientInfo: { name: "Paseo", version: "dev" } })`,
   raced against a spawn-error channel and a caller-supplied timeout
   ("ACP initialize timed out after …ms", acp-agent.ts:1394-1425). Client
   capabilities baseline: `fs: { readTextFile: false, writeTextFile:
   false }, terminal: true` (acp-agent.ts:249-256), mergeable per provider
   (acp-agent.ts:260-274). Spec: the client sends the latest version it
   supports; the agent MUST answer with the same version if supported,
   else its own latest; a client that cannot live with the agent's answer
   SHOULD close the connection and inform the user. The version is a
   single integer, incremented only on breaking changes (spec
   initialization page; example value `1`).
2. **session/new.** `newSession({ cwd, mcpServers })` — one session per
   spawned process, sessionId captured (acp-agent.ts:1907-1929, call at
   1915). Spec baseline: every agent MUST support `session/new`,
   `session/prompt`, `session/cancel`, `session/update` (spec
   initialization page, "Baseline").
3. **session/prompt.** `connection.prompt({ sessionId, messageId, prompt
   })`, fire-and-settle: the response resolves through
   `handlePromptResponse`, a rejection finishes the turn as failed
   (acp-agent.ts:2076-2096). Spec: params are `sessionId` + a
   ContentBlock[] `prompt`; the response carries a `stopReason` of
   `end_turn | max_tokens | max_turn_requests | refusal | cancelled`
   (spec prompt-turn page).
4. **session/update notifications** (agent → client), filtered to the
   session's own id (acp-agent.ts:3251-3253) and dispatched over the
   documented union: `user_message_chunk` (handled before the switch,
   acp-agent.ts:3630-3632), `agent_message_chunk`,
   `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
   `current_mode_update`, `config_option_update`,
   `session_info_update`, `usage_update`, `available_commands_update`
   (acp-agent.ts:3630-3683).
5. **session/request_permission** (agent → client REQUEST): the real
   handler either auto-accepts (see §2.1) or surfaces the request and
   parks a promise on the UI's answer (acp-agent.ts:3195-3238).
   **STEP-2 SHAPE PIN (live wire):** `session/update` payloads are
   NESTED — the discriminating kind lives at
   `params.update.sessionUpdate` and text at `params.update.content`,
   NOT at `params.sessionUpdate.*` as a flat reading of the union would
   suggest. The driver's fold reads the nested shape exclusively.
6. **session/cancel** (client → agent NOTIFICATION): the stop path writes
   `connection.cancel({ sessionId })` through a per-stop ledger that
   tracks each cancel write's delivery (acp-agent.ts:2493-2530; also
   issued on the close path, acp-agent.ts:3163).
7. **Usage.** The reference folds usage ONLY from the prompt response:
   `mapACPUsage(response.usage)` → `{ inputTokens, outputTokens,
   cachedInputTokens: cachedReadTokens }` (acp-agent.ts:3846, mapper at
   677-684). The `usage_update` session update is consumed and dropped:
   `handleUsageUpdate` is literally `void update;` (acp-agent.ts:3841-3843).
8. **Resume (sessionRef), capability-gated.** `loadSession` when
   `agentCapabilities.loadSession` (history replayed via session/update
   before the response), else `unstable_resumeSession` when
   `sessionCapabilities.resume` (no replay), else a hard throw "does not
   support ACP session resume" (acp-agent.ts:1931-1985, gates at
   1951/1966, throw at 1973-1974). A recorded provider quirk worth
   keeping: Devin requires ALL THREE of sessionId/cwd/mcpServers on
   load/resume even when the list is empty (comment at acp-agent.ts:1929-1934).
9. **Client-side fs/terminal serving** — the agent can call the CLIENT to
   read/write files and run terminals; the reference implements
   readTextFile/writeTextFile locally (acp-agent.ts:3330-3346) and a full
   terminal spawn/poll/kill surface (acp-agent.ts:3347-3435); the
   diagnostic probe client stubs permission to `cancelled` and throws on
   terminal (acp-agent.ts:1433-1448).

**Authenticate: the reference NEVER calls it.** A tree-grep for
`authenticate` across the reference providers finds no ACP call site; the
client does not even advertise `auth.terminal`. Spec: agents advertise
`authMethods` in the initialize response and may gate requests with an
`auth_required` error until the client calls `authenticate { methodId }`;
terminal-type methods run the binary interactively OUTSIDE the protocol
(spec authentication page). Paseo's posture is therefore: the harness
binary is expected to arrive pre-authenticated (env/config at spawn;
`runtimeSettings.env`, generic-acp-agent.ts:69-70), and a protocol-driven
`authenticate` is simply not implemented.

### 1.2 The subset v1 implements

Exactly: `initialize` (with integer protocol-version negotiation and a
loud mismatch error, §3) → `session/new` → `session/set_config_option`
(THE MODE PIN — added by the step-2 amendment, below) → `session/prompt`
→ consume `session/update` (a FILTER: fold `usage_update`-independent
facts only — see §1.3 — and keep `agent_message_chunk` text for the
structured-output attempt, §4) → answer `session/request_permission`
declaratively (§2.1) → `session/cancel` on the governed abort signal
(§2.3). `authenticate` is NOT implemented — and now KNOWN-UNNEEDED, not
merely unproven: OQ-1 is ANSWERED (no gate; one authMethod,
`zcode-credentials`, agent self-handles; `session/new` succeeds with no
authenticate call). The pass-through-unless-demanded posture stands: if a
harness ever answers `auth_required` anyway, the run fails loud NAMING
the advertised authMethods — never a silent retry with credentials we do
not hold. The conformance fixture (§7) is a fake ACP server speaking
exactly this subset over stdio.

**THE MODE PIN (step-2 amendment — the live probes made this subset
member mandatory, OQ-4):** sessions are created in mode `yolo` (available
modes `plan/build/edit/yolo/auto` on the reference vendor), and `yolo`
NEVER ASKS — tools execute ungated. The permission boundary (§2.1) is
the ONLY gate this lane owns, and it exists only in a client-chosen mode,
so BEFORE ANY PROMPT the driver pins the gating mode with ONE
`session/set_config_option { configId: 'mode', value: 'build' }` request
(live-verified: in `build`, every gated tool call produced exactly one
`session/request_permission`, honored on both the allow and the deny
side). A failed pin is a pre-prompt error verdict — an unpinned session
is a policy void, not a degraded run — and the never-asks tripwire (§2.1)
remains the backstop for a harness that accepts the pin and still does
not ask.

### 1.3 The will-NOT-implement-in-v1 list (each against the frozen seam)

The frozen seam is one method — `run(OpInvocation) → Promise<WorkerResult>`
(`src/driver/types.ts:145-147`). Anything the result cannot express, or
the invocation cannot ask for, is out of scope, not deferred detail:

- **Filesystem API (`fs/read_text_file`, `fs/write_text_file`).** The
  CLIENT advertises these (spec initialization page); the vendor agent
  would use them to read/write OUR disk through OUR process. The frozen
  seam gives `run()` no channel to serve per-call file requests, and our
  enforcement story for vendor-initiated reads/writes would be weaker
  than the harness tools' workspace containment (symlink re-checks,
  allowlists — `src/harness/tools.ts:25-58`). v1 advertises
  `fs: { readTextFile: false, writeTextFile: false }` — the same
  false/false baseline the reference ships by default
  (acp-agent.ts:249-256) — so a conforming agent never sends them.
- **The terminal API.** Same reasoning, stronger: `terminal: false` (the
  reference default advertises `true` and implements real spawns,
  acp-agent.ts:254, 3347-3435 — a vendor-hosting feature the seam has no
  use for; our `run` story is the vendor's own tools, not client-hosted
  terminals).
- **The MCP subprotocol (`mcpServers`, both directions).** NOT passing our
  harness tools as an MCP server is the honest consequence of §0: the
  commercial value of this lane is the VENDOR harness doing the work with
  ITS tools; re-importing our tool surface over MCP would rebuild the
  claude-agent lane's architecture on a second wire and double the
  permission-mapping surface. We pass `mcpServers: []` (never omit it —
  the recorded Devin quirk, acp-agent.ts:1929-1934, generalizes to
  "keep the param present").
- **Session modes / config options / model selection over
  `unstable_setSessionModel`.** The reference gates this behind an
  unstable API and degrades to "does not expose ACP model selection"
  (acp-agent.ts:2864-2872, 3615-3619). The frozen `OpInvocation` carries
  `modelSpec.model`; how a model id reaches the vendor harness (a config
  option? a CLI flag? nothing?) is per-vendor and unknown-until-spike
  (OQ-2). v1: request nothing beyond the default session state, observe
  what the harness reports (§5), and fail loud on the observed-model leg
  rather than paper over it.
- **Multi-session multiplexing.** One spawn, one session, one prompt turn
  per run — the seam has no concurrent-turn concept, and the reference
  needs a whole admission/foreground-slot apparatus to serialize turns on
  ONE session (acp-agent.ts:1643, 2040-2110) that `run(opInvocation)`
  simply does not need at one-turn-per-process.
- **Session listing / import (`session/list`, probe-driven catalog
  refresh).** Reference-only plumbing for a long-lived IDE client
  (acp-agent.ts:1041-1290); a one-shot worker never lists.
- **`usage_update` as a usage source.** Spec: it reports CURRENT SESSION
  CONTEXT occupancy and cumulative cost state, with `cost` optional in a
  vendor-chosen currency (spec prompt-turn page) — context-window
  telemetry plus a vendor cost figure, not turn token counts. The frozen
  `Usage` is turn tokens, and a vendor-reported cost figure would bypass
  the derived-only rule (DD-2/DD-9) — the reference drops it too
  (acp-agent.ts:3841-3843). v1 consumes `PromptResponse.usage` (§2.3)
  and records the schema-level uncertainty about that field (OQ-3).
- **`session/load` / `unstable_resumeSession` beyond the sidecar
  discipline of §6** — implemented ONLY in the shape §6 requires
  (capability-gated, best-effort, honest partial continuation), nothing
  more.
- **Elicitation, slash commands, agent plans, content beyond text.** No
  frozen field can carry a plan, a command palette, or an elicitation
  round-trip; prompt content is text-only in v1 (spec: text blocks are
  the baseline every agent MUST support; image/audio/embeddedContext are
  capability-gated extras).

## 2. The seam mapping (written before code)

### 2.1 `toolPolicy` → `session/request_permission` (declarative answers to an interactive ask)

ACP asks INTERACTIVELY per tool call: the agent sends
`session/request_permission { sessionId, toolCall, options }`, the client
picks an option (`kind`: `allow_once | allow_always | reject_once |
reject_always`) or answers `cancelled` ("the prompt turn was cancelled");
spec, tool-calls page. The spec explicitly allows our shape: "Clients MAY
automatically allow or reject permission requests according to the user
settings." The frozen `ToolPolicy` is DECLARATIVE
(`src/driver/types.ts:61-71`). The mapping, exactly:

- **mode `allowlist` (the default):** on each request, the driver matches
  the request's tool identity against `policy.allow` and answers per the
  FULL answer table below. The user is never prompted — a headless
  worker cannot be an interactive authority. This is the reference's own
  auto-accept mechanic pointed at a policy instead of a toggle:
  `selectPermissionOption(options, { behavior: 'allow' })` picks
  allow_once before allow_always (acp-agent.ts:4617-4640), and the
  auto-accept gate short-circuits before any UI event
  (acp-agent.ts:3195-3211).
- **mode `none`:** every permission request is auto-rejected — the deny
  side of the answer table below. (Note the asymmetry with the other
  lanes: they also REMOVE the tool surface; over ACP the vendor's tools
  exist whether we like them or not, and the permission boundary is the
  ONLY gate we own. That is why a deny answer must be cheap and total.)
- **mode `unrestricted`:** every request takes the allow side of the
  answer table below.

**The answer table, exactly (both sides, all modes):** an ALLOW decision
(an allowlist match, or any request under mode `unrestricted`) selects
the `allow_once` option when one is offered, else the `allow_always`
option (`{ outcome: 'selected', optionId }` of the chosen option;
`allow_always` is harmless per-run — the session dies with the process,
so there is no cross-run memory to honor). A DENY decision (an allowlist
miss, or any request under mode `none`) selects the `reject_once` option
when one is offered, else the `reject_always` option; a deny with NO
reject option offered FAILS THE RUN with an error naming the vendor's
offered options. The driver NEVER answers `cancelled` — that outcome is
only legal on a real cancellation (spec tool-calls page; §2.3).

**The matching gap, named:** ACP's `RequestPermissionRequest` carries a
`ToolCallUpdate` — toolCallId, title, kind (read/edit/delete/move/
search/execute/think/fetch/other), content, locations, rawInput — and NO
canonical tool name (spec tool-calls page). Our allowlists are authored
against tool NAMES. v1 defines the matched identity as the request's
`title` string (the vendor's own tool label, e.g. a shell-command title),
with `kind` recorded alongside in the denial reason; conformance
exercises the mapping through the fake server (§7), and the LIVE spike
records what zcode-acp-server actually puts in `title`/`kind`/`rawInput`
(OQ-4). If the spike shows the vendor's titles are unstable
free-text, the honest fallback is documented here FIRST: treat any
unmatched title as a deny (fail-closed is always available), never as an
allow.

**The deny path lands in `WorkerResult.denials`:** the permission
boundary is where the driver KNOWS both facts, so the frozen
`{ tool, reason }` record (`src/driver/types.ts:106-110`) is synthesized
AT THE ANSWER — `tool` = the matched title (or `kind` when the title is
empty), `reason` = `tool policy: not allowlisted (kind <kind>)` for
allowlist misses, `tool policy: mode none` for mode none. This is the
same two-channel posture as the other lanes (the denial is also the
model-visible outcome — the agent observes a rejected permission and can
adapt), and it does not depend on waiting for a `tool_call_update`
status that may never clarify WHY. A permission request answered
`cancelled` (only legal when the turn itself is cancelled, spec
tool-calls page) records no denial — the run verdict is `aborted`
already (§2.3).

**The never-asks failure mode, named:** everything above stakes
enforcement on `session/request_permission` ARRIVING — but the spec
makes asking the AGENT's decision, not a client-enforceable MUST, so a
protocol-legal vendor that executes tools WITHOUT asking is possible.
The driver does not assume it away: it OBSERVES the `tool_call` stream
inside the session/update filter (§1.1 item 4), and a `tool_call`
arriving with NO preceding permission request for that tool call is
recorded as evidence of UNGATED EXECUTION and the run verdict is
`error` — fail loud, because a policy that cannot be enforced is not
silently soft. That is what keeps the "only gate we own" claim above
honest: if the gate never fires, the run record says so instead of
passing a policy-void run as green.

### 2.2 `sandboxPolicy` → nothing, and that is the answer, stated plainly

ACP v1 has NO sandbox concept: no sandbox field or capability exists in
`InitializeRequest`/`Response`, `NewSessionRequest`/`Response`, or any
capability object (spec schema page — the nearest things are `cwd`,
`mcpServers`, and `additionalDirectories`, which is extra workspace
ROOTS, i.e. more reach, not less). The fs/terminal client capabilities
advertise what the CLIENT will serve (§1.3), not what the agent may
touch. Therefore:

- `SandboxPolicy.level` maps onto NO protocol carrier in v1. It is
  recorded on the run record and enforced NOWHERE over the wire.
- What actually constrains the vendor harness: (i) `cwd` — session/new
  points the agent's working directory at OUR fresh per-run temp
  workspace (§6), the same advisory-rooting the subprocess lane gets;
  (ii) whatever sandboxing the VENDOR ships in its own binary — for
  zcode, an app-side `~/.zcode/acp/sandbox.json` exists on this host
  (§3 probe) whose semantics are UNDOCUMENTED from our side and are not
  assumed here; (iii) the permission boundary (§2.1), which gates the
  vendor's tool EXECUTIONS, not their reach.
- The gap is real and shipped visible: a `read-only` run on this lane is
  a run whose TOOL CALLS we denied where we could — not a run whose
  filesystem the vendor cannot write. If a vendor exposes a sandbox
  config option through session configOptions (per-vendor, spike
  territory), mapping `level` onto it is an additive later change;
  claiming containment today would be a lie with a type on it.

### 2.3 `budget`/abort → `session/cancel`, and DD-1 re-asked on this lane

- **wallClockMs / abort:** the driver owns NO wall clock — the governed
  `currentJobContext()?.signal` (the governor's ladder decides WHEN) is
  forwarded, and on fire the driver sends the `session/cancel`
  notification and then AWAITS the `session/prompt` response. This is
  STRONGER cooperative-settle semantics than the claude-agent lane has:
  the spec REQUIRES the agent to reply to the original prompt with
  `stopReason: 'cancelled'`, to stop LM requests and tool invocations
  "as soon as possible" (SHOULD — not MUST), and to catch abort
  exceptions so the client can reliably confirm cancellation (spec
  prompt-turn page, "Cancellation"). The reference treats cancel
  delivery as unproven-until-observed and tracks each cancel write in a
  per-stop ledger (acp-agent.ts:2493-2530) — v1 keeps the ledger lesson
  (settle on the cancelled PROMPT RESPONSE, not on the cancel write
  resolving). Verdict mapping: governed abort → `aborted`
  (`src/driver/types.ts:24`).
- **Does cancelling stop SPEND? — DD-1 re-asked, NOT assumed from T1.6.**
  The T1.6 answer (≈2.0 s cooperative settle, no post-abort transcript
  growth, no surviving worker — docs/dd-1-abort-spike.md) measured the
  agent SDK killing ITS OWN CLI child. This lane's worker is a vendor
  binary making its own provider calls; the spec's "SHOULD stop … as
  soon as possible" is explicitly weaker than MUST, and NOTHING in the
  spec or the reference proves the vendor stops metering in-flight
  generation after the cancel. **Unknown-until-a-live-spike**: the
  implementation MUST include a dd-1-shaped spike on this lane (long
  fixture run, governed cancel at N s, then observe post-cancel
  `session/update` traffic, process liveness, and settle latency).
  Client-observable verdict only — provider-side metering stays
  unobservable, exactly as dd-1 scoped it.
- **maxTokens:** ACP has NO mid-run token stop — no client→agent cap
  exists in the protocol, and the prompt is the only lever. Same honest
  floor as the subprocess and claude-agent lanes: folded
  `PromptResponse.usage` ≥ `maxTokens` classifies a FINISHED run
  `budget` (never a mid-run stop; early stopping is governor/admission
  business).
- **maxUsd:** caller-side derived accounting, as on every lane.
- **Usage mapping:** `PromptResponse.usage` → frozen `Usage`:
  `outputTokens → output`, `cachedReadTokens → cacheRead` (the reference
  mapper, acp-agent.ts:677-684), `cachedWriteTokens → cacheWrite` —
  **step-2 CORRECTION from the live wire**: the carried usage DOES have a
  cache-write field on this vendor (OQ-3, verbatim on the wire), so the
  earlier "`cacheWrite` is 0-by-protocol" claim is wrong on this lane and
  the field FOLDS instead of hardcoding 0 — and **round-3 CORRECTION**:
  `input` is DERIVED, never mapped straight — `input = inputTokens −
  cachedReadTokens − cachedWriteTokens`, floored at 0. The wire's
  `inputTokens` is INCLUSIVE of the cached tokens (the live sample:
  `totalTokens 15722 = inputTokens 15719 + outputTokens 3`, with
  `cachedReadTokens 11648` inside the 15719), so the old
  `inputTokens → input` mapping double-counted cache in every total that
  sums the frozen fields — it totals **27370** against the wire's own
  15722, while the derived fold `4071 + 3 + 11648 + 0 = 15722` sums to
  the wire's totalTokens exactly (the ai-sdk lane's noCacheTokens
  reasoning). **`reasoning` is OMITTED** —
  the same live probe shows `thoughtTokens` EXISTS on the wire, but its
  ADDITIVITY is unknown (whether the vendor counts thought tokens inside
  `outputTokens` or outside it; the sample turn reported
  `thoughtTokens: 0`, so the wire itself cannot say), and the frozen
  field is additive-only-when-reported-outside-output
  (`src/driver/types.ts:36-41`) — folding it on a guess would
  double-count every total that sums the frozen Usage fields (the
  Budget.maxTokens classification). Same rule as the claude-agent lane:
  an unproven-additive count stays unlifted. Thought CONTENT
  (`agent_thought_chunk`) is not a token count and must not be converted
  into one. On `aborted`/`error` verdicts the driver folds
  whatever the final response actually carried and never invents the
  rest — cost is never reported on an unmeasured verdict (the live
  cancel probe: the cancelled response carried `usage: null`; that fold
  is zeros, no cost).
- **costUSD:** OUR modeled figure, never vendor-reported USD — the
  T1.6b posture unchanged on a new lane (`docs/dd-9-api-equivalent-budget.md`
  §3): derived from the folded usage through the vendored models.dev
  table keyed by the OBSERVED model (§5), labeled
  `costBasis: 'modeled'`, ABSENT when the model is unpriced. The
  optional `cost` object on `usage_update` (a vendor-cumulative figure
  in a vendor currency, spec prompt-turn page) is exactly the vendor
  cost channel DD-9 refuses to surface, and is dropped with
  `usage_update` (§1.3).

## 3. Binary discovery and version policy

- **Discovery: explicit argv first, PATH fallback.** The constructor
  takes `command?: readonly [string, ...string[]]` — the full launch
  argv, default `['zcode-acp-server']` — because the reference is right
  to make the WHOLE argv config: harness launch shapes differ
  (`zcode-acp-server`, `dsh-acp`, or a package-runner prefix; paseo's
  diagnostic even special-cases npx/bunx/pnpm/uvx `--version` probes,
  generic-acp-agent.ts:196-242). Auth and endpoint env rides as env var
  NAMES in the constructor (never values — the routing discipline every
  lane shares), injected into the child's env at spawn. No registry of
  vendors, no per-vendor code paths beyond the argv default: v1's second
  vendor is a different default argv, which is the point of the lane.
- **Absent binary: pre-dispatch throw.** If the argv's binary does not
  resolve on PATH (and is not absolute), `run()` throws BEFORE any
  spawn, naming the binary and the install hint (e.g. `npm install -g
  zcode-acp-server`) — the same posture as the claude-agent lane's
  absent optional peer: fail loudly before any session exists, never a
  crash mid-run (src/driver/README.md, "Optional-peer semantics"). Once
  spawned, `run()` never throws past the seam.
- **Wrong-version / protocol mismatch: loud, naming both numbers.**
  `initialize` sends the protocol version our client speaks; if the
  agent answers a DIFFERENT integer that our client cannot speak, the
  run fails pre-prompt with BOTH versions in the error ("ACP protocol
  mismatch: requested <ours>, agent answered <theirs>"). Spec procedure:
  the agent never declines initialize, it answers with its latest; the
  client that cannot support the answer closes and informs (spec
  initialization page) — our "inform" is the thrown error, our "close"
  is killing the spawned child. A binary `--version` probe (reference
  prior art, generic-acp-agent.ts:196-209) is NOT implemented: the
  wire-negotiated integer is the only version that binds.
- **Never bundled, never a dependency.** No npm dependency, no optional
  peer, nothing vendored — stricter than the claude-agent lane (which at
  least declares an optional peer): the harness binary is an EXTERNAL
  program the operator installs, full stop. The repo builds and the
  whole suite passes with NO harness binary present (the conformance
  fixture is in-repo code, §7).

**This host, probed 2026-09-15 (local-discovery evidence):**

- `which zcode-acp-server` → not found; `which dsh-acp` → not found;
  `which zcode` → not found on the shell PATH.
- The ZCode desktop app IS installed (`/Applications/ZCode.app`), and
  bundles a CLI (`Contents/Resources/glm/zcode.cjs`, bundle meta:
  source `apps/zcode-cli/packages/cli/dist/zcode.cjs`) — but the bundle
  contains NO ACP server: no `zcode-acp-server` /
  `agentclientprotocol` strings in `zcode.cjs` or `app.asar`, and
  `~/.zcode/acp/` holds only an app-side `sandbox.json`, no server
  binary.
- npm registry metadata (fetched 2026-09-15, metadata only — nothing
  installed): `zcode-acp-server@0.37.3` — "Agent Client Protocol (ACP)
  server bridging headless ZCode to editors like Zed and JetBrains";
  bins `zcode-acp` AND `zcode-acp-server` (both → `dist/cli.js`);
  `engines: node >=22`; depends on `@agentclientprotocol/sdk@^1.3.0`.
  `@openma/deepseek-harness-acp@0.4.31`; bin `dsh-acp` → `dist/bin.js`.
- **Conclusions recorded:** BOTH harness binaries are ABSENT on this
  host — the absent-binary evidence for §3's posture, and the live-spike
  prerequisite (the implementation step must install `zcode-acp-server`
  first; host node is 24.21.0 via mise, satisfying `engines >= 22`).
  The zcode CLI does NOT expose its ACP server as a subcommand or
  bundled binary on this host — the server is a SEPARATE npm package
  that bridges to a headless ZCode. The package's SDK dependency major
  (`^1.3.0` vs the reference's `^0.17.1`) is a visible generational
  gap: whether the negotiated integer is still `1` is unknown-until-
  spike (OQ-5).

## 4. Structured output vs DD-4

ACP has NO `outputFormat`/`json_schema` equivalent — the prompt is a
ContentBlock[] and the response is stopReason (+usage, §2.3); the
reference implements no structured output at all. The claude-agent lane's
native path (src/driver/README.md) has NO analog here. Strategy, same
posture as the weakest existing lane, stated without cosmetics:

- When `outputSchema` is constructed in, the driver APPENDS the JSON
  schema and a reply-with-only-JSON instruction to the prompt
  (prompt-directed JSON), assembles the final assistant text from the
  `agent_message_chunk` stream, and post-settle validates it with zod
  against the constructor schema. Parse/validation success →
  `WorkerResult.structuredOutput`.
- **The honest gap:** the model may refuse, prepend prose, or malform —
  identical to every prompt-directed scheme. A failing payload is
  DROPPED to narration (the raw text never lands in
  `structuredOutput`), `structuredOutput` stays absent, and the run
  verdict stays what the wire said — the claude-agent lane's
  dropped-to-narration rule, without even a native fallback to hide
  behind. Conformance exercises the scripted-JSON path through the fake
  server; the LIVE harness's fidelity is a model+vendor fact.
- **DD-4 (GLM/DeepSeek schema fidelity) is RECORDED, not solved:** this
  lane adds a THIRD wire shape for exactly the two vendors DD-4 is
  about, with strictly weaker output machinery than the ai-sdk lane's
  native structured-output path. The recorded expectation: eval cells
  that need structured output on this lane must expect a nonzero
  malformation rate, and DD-4's tracking belongs to the eval lane, not
  to a protocol that cannot carry a schema.

## 5. The observed-model check and eval posture

- **`WorkerResult.model` (leg m binds):** the driver surfaces whatever
  model id the HARNESS reports as served. **STEP-2 SHAPE PINS (OQ-2,
  answered live):** the id is reported in TWO places — `session/new`
  result `configOptions[]` (entry `id: 'model'`, category `'model'`,
  `currentValue` in `providerId\modelId` format, backslash separator —
  the vendor's own encoding) and AGAIN as a `config_option_update`
  session update once the session materializes on first use. The two
  DISAGREE by design: the session/new entry is the LAZY default
  (`builtin:zai\GLM-5.3` on the probe); the update carries the
  MATERIALIZED truth (`builtin:bigmodel\GLM-5.3` — the providerId
  CHANGES between the two). `WorkerResult.model` therefore reads the
  POST-MATERIALIZATION `config_option_update` value ONLY — the
  session/new default is never surfaced (surfacing it would be the exact
  misobservation leg m exists to catch). A harness that reports NOTHING
  materialized fails the conformance suite — that failure is
  INTENDED PRESSURE, the same silent-remap defence as every lane
  (conformance leg m, test/driver/conformance.ts:509; "a driver that
  hides the served id … fails"), and the driver will NOT substitute the
  requested `ModelSpec.model` to pass it (that would manufacture the
  exact fact leg m exists to catch).
- **Eval wires request what the wire serves (conductor decision
  2026-09-14):** eval cells on this lane request the model id the
  zcode/deepseek harness actually serves (observed in the spike, as
  done for the DD-2 re-runs, docs/dd-2-usd-normalization.md), so evals
  compare what actually ran — not what a route table wished for. The
  modeled-cost fold then keys off the OBSERVED id, which keeps the
  silent-remap pricing hazard (4× mispricing, DD-2 §"glm × ai-sdk
  wire history") out of this lane too.

## 6. Session mapping and I6 isolation

- **Fresh run (no `sessionRef`):** fresh temp workspace + a fresh ACP
  session — spawn the harness binary with cwd = workspace,
  initialize, `session/new`, `SessionStore.create` (I6, identical
  architecture to the other lanes; a fresh run never touches a prior
  session's state, and the vendor's in-process session dies with the
  child we terminate at settle).
- **sessionRef resume:** the ACP sessionId is persisted post-settle to
  the workspace sidecar (`.cq-cli-session`, the SAME sidecar discipline
  as the claude-agent lane, `AGENT_SESSION_FILE`). Resuming a
  sessionRef spawns a FRESH binary (no daemon — the vendor's session
  state lives in its process, so continuation is only possible through
  the protocol): initialize, then `session/load` when the agent
  advertises `loadSession` (history replays via session/update before
  the response — which v1 consumes and DISCARDS, keeping only the fact
  of continuity), else `unstable_resumeSession` when advertised, else
  an honest partial continuation (workspace-only, sidecar recorded but
  unusable — the same honesty as a sidecar-less workspace in the other
  lanes). Unknown sessionRef throws (I6). This gate order is the
  reference's own (acp-agent.ts:1931-1985) and is cited as evidence,
  not copied as code.
- Session turns persist in OUR `SessionMessage` vocabulary only — no
  vendor message shapes cross the seam (the ACP update union dies at
  the driver boundary).

## 7. The cut line

**What could overrun T1.8:** (i) protocol breadth creep — the reference
is 4,700+ lines because it serves IDE needs (fs/terminal hosting, model
catalogs, session import, admission serialization); our subset is ~1/10
of that, but every "small" addition (config options, modes) reopens the
surface; (ii) harness quirks — permission payloads (`title` stability,
OQ-4), model reporting (OQ-2), auth gating (OQ-1), protocol-version
generation gap (OQ-5); (iii) live-spike surprises — cancel-spend
behavior (§2.3) and any vendor hang that forces transport-level
escalation (kill ladder) beyond the cooperative path.

**The pre-agreed cut, in order:**

1. v1 ships: the frozen subset (§1.2) + the fake-ACP-server conformance
   fixture (in-repo, stdio JSON-RPC, scripted initialize/new/prompt/
   permission/cancel/usage — the `fake-agent-cli.mjs` pattern the
   subprocess lane already uses) + the zcode endpoint LIVE
   (spike → install → conformance-checked driver run).
2. If the zcode live spike eats the budget: ship subset + fixture +
   driver with the deepseek endpoint as FAST-FOLLOW (same driver, a
   different default argv — nothing in the design is zcode-specific),
   and record the live-spike evidence as zcode-only.
3. NEVER cut: the permission mapping (§2.1 — without it the lane is a
   policy hole), the pre-dispatch absent-binary throw and version
   mismatch error (§3), the observed-model posture (§5 — a lane that
   fakes `model` is worse than a lane that fails).

**Checkpoint-blocked triggers** (any one stops the goal, per plan §6's
"unresolved is fine, unreviewed is not"): (a) NO protocol-version
overlap — our client and the shipping zcode-acp-server cannot agree on
an initialize version (unbuildable as specced); (b) the vendor ignores
or hangs on REJECTED permission outcomes, or STRUCTURALLY NEVER ASKS —
executes gated tools with no `session/request_permission` at all (the
never-asks failure mode, §2.1, detected by the tool_call observation) —
in either case making the declarative toolPolicy unenforceable on the
lane; (c) the harness reports NEITHER
model NOR usage on complete runs — no conforming `WorkerResult` is
possible without fabrication, which the seam forbids.

**DoD relief:** spec DoD 4 (working drivers) is already satisfied by
the ai-sdk, subprocess, and claude-agent lanes — a checkpoint-blocked
T1.8 costs the Z.AI-discount wire, not the phase.

## Open questions (unknown-until-X — each is a review/audit input)

- **OQ-1 (auth):** do the harnesses gate `session/new` behind
  `auth_required`, and with which authMethod types? Unknown until the
  live initialize probe. v1: fail loud naming the advertised methods;
  implement `authenticate` only if a harness actually gates.
- **OQ-2 (model reporting):** WHERE a harness reports the served model
  id (session/new response vs config_option_update vs nowhere).
  Unknown until the live session probe; leg m fails the lane until
  answered.
- **OQ-3 (usage on the wire):** the reference's SDK carries
  `PromptResponse.usage` (acp-agent.ts:3846) but the published v1
  schema page shows `PromptResponse = { _meta?, stopReason }` with no
  usage field. Whether current harness SDKs ship usage on the prompt
  response is unknown until the live probe; if absent, the usage
  contract fails conformantly (the fixture still proves the fold).
- **OQ-4 (permission identity, and whether the ask happens at all):**
  what zcode-acp-server/dsh-acp put in `request_permission`'s
  `toolCall.title`/`kind`/`rawInput`, whether titles are stable enough
  to match an allowlist, AND whether the harness actually ISSUES
  `request_permission` for the gated tool classes — the live permission
  probe must confirm the ask itself, because a harness that never asks
  is the never-asks failure mode (§2.1) and trips checkpoint trigger
  (§7b). Unknown until the live permission probe; fail-closed (deny
  unmatched) is the standing fallback.
- **OQ-5 (protocol generation):** the negotiated `protocolVersion`
  integer against `zcode-acp-server@0.37.3` (SDK `^1.3.0` vs the
  reference's `^0.17.1`). Unknown until first initialize; the mismatch
  error (§3) is the designed answer either way.
- **OQ-6 (cancel-spend):** whether a cancelled turn stops vendor-side
  spend — the §2.3 spike; client-observable verdict only.

## Live-probe evidence — the OQ register answered (step-2 slice 1, 2026-09-15)

Recorded from the wire by `scripts/probe-acp.mjs` (committed; every frame of
every run captured verbatim to ndjson logs outside the repo). Environment:
`zcode-acp-server@0.37.3` installed via `npm install -g` (its dependency
resolved to `@agentclientprotocol/sdk@1.4.0`; `engines: node >=22` satisfied
by host node 24.21.0 via mise), spawning the app-bundle CLI through
`ZCODE_BIN=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
(backend reports itself as 0.16.5). Transport confirmed: newline-delimited
JSON-RPC 2.0 (the SDK's own `LineBuffer`; the v1 spec transports page agrees
— "Messages are delimited by newlines"). One amendment input already
visible: **session/update payloads are NESTED** — `params.update.
sessionUpdate`, `params.update.content`, not `params.sessionUpdate.*`.

**OQ-5 (protocol generation) — ANSWERED, trigger (a) CLEARED.**
`initialize { protocolVersion: 1, clientCapabilities: { fs: { readTextFile:
false, writeTextFile: false }, terminal: false }, clientInfo }` → negotiated
`protocolVersion: 1` (agentInfo `{ name: "zcode-acp-server", title: "ZCode",
version: "0.37.3" }`). Mismatch leg: requesting `protocolVersion: 99` gets
`protocolVersion: 1` back — the agent never declines, it answers its latest,
exactly the spec procedure §3's mismatch error is built on.

**OQ-1 (auth) — ANSWERED: NO gate.** The initialize response advertises one
authMethod: `[{ id: "zcode-credentials", name: "ZCode built-in credentials",
description: "Reads the GLM API key from ~/.zcode/v2/config.json managed by
the ZCode desktop app. No editor-side credentials required." }]` (no `type`
field — agent self-handles auth). `session/new` issued WITHOUT any
`authenticate` call succeeds in ~5 ms; no `auth_required` error ever appears.
v1's "harness arrives pre-authenticated" posture holds; `authenticate` stays
unimplemented.

**OQ-2 (model reporting) — ANSWERED, trigger (c) CLEARED on the model leg.**
The model id is reported in TWO places, both verbatim on the wire:
1. `session/new` response: `result.configOptions[]` entry
   `{ id: "model", name: "Model", category: "model", type: "select",
   currentValue: "builtin:zai\\GLM-5.3", options: [...] }` — but sessions are
   LAZY: these are defaults, not the materialized session's state.
2. `session/update` → `params.update.configOptions` (a
   `config_option_update`), emitted once the session materializes on first
   use, carrying the REAL served model: `currentValue:
   "builtin:bigmodel\\GLM-5.3"`. Note the providerId CHANGES between the lazy
   default (`builtin:zai`) and the materialized value (`builtin:bigmodel`) —
   the observed-model check (§5, leg m) must read the POST-materialization
   value, never the session/new defaults. Value format is
   `providerId\modelId` (backslash separator; vendor's own encoding). A
   mechanical key sweep (every key path matching /model/i across EVERY inbound
   frame) finds no other model reporting anywhere.

**OQ-3 (usage on the wire) — ANSWERED, trigger (c) CLEARED on the usage leg.**
`PromptResponse.usage` EXISTS on this wire (the SDK 1.4 type marks it
UNSTABLE/experimental; the published v1 schema page omits it). Verbatim, a
tiny no-tool prompt (`stopReason: "end_turn"`):
`usage: { totalTokens: 15722, inputTokens: 15719, outputTokens: 3,
thoughtTokens: 0, cachedReadTokens: 11648, cachedWriteTokens: 0 }` plus
`_meta: { zcode: { usage: { source: "provider", modelRequestCount: 1,
webFetchRequests: 0, webSearchRequests: 0 } } }`. TWO §2.3 claims are
CONTRADICTED by the live wire, both in the additive direction: the carried
usage is NOT limited to the reference mapper's three fields —
`cachedWriteTokens` EXISTS (§2.3's "`cacheWrite` is 0-by-protocol" is wrong
on this vendor: the field is present; it can be folded instead of hardcoded
0), and `thoughtTokens` EXISTS (§2.3's "`reasoning` is OMITTED — ACP reports
no reasoning token count" is likewise wrong here; the additive-only-when-
reported rule can now fold it). The `_meta.zcode.usage.source: "provider"`
provenance marker is recorded as evidence of vendor-side metering.

**OQ-4 (permission identity; does the ask happen) — ANSWERED, trigger (b)
CLEARED on both legs.** Mode fact first: sessions are created in mode
`yolo` (availableModes `plan/build/edit/yolo/auto` per `session/new
result.modes`), and **yolo does NOT ask** — tools execute ungated. Switching
`session/set_config_option { configId: "mode", value: "build" }` arms the
gate; in `build`, a file-writing prompt produced exactly one
`session/request_permission`, verbatim:
`toolCall: { toolCallId: "call_…", rawInput: { file_path: "…/probe-hello.txt",
content: "hello" }, title: "Write: /…/probe-hello.txt", content: [full
pretty-printed input as text], locations: [{ path: "…/probe-hello.txt" }] }`
— **`kind` is ABSENT** from the request's toolCall (the §2.1 matching gap is
real but narrower than feared: the tool NAME leads the `title` as
"`<toolName>: <summary>`", capped at 80 chars, and the sibling `tool_call`
update carries the canonical name at `_meta.claudeCode.toolName` = "Write"
with `kind` mapped via the vendor's TOOL_KIND_MAP — Write→"edit"). Offered
options, verbatim: `[{ optionId: "allow_once", kind: "allow_once" },
{ optionId: "allow_project", kind: "allow_always" }, { optionId: "deny",
kind: "reject_once" }]` — optionIds are VENDOR STRINGS ("deny", not
"reject_once"), so the driver must select by `kind` and echo the chosen
option's own optionId, never assume spec-shaped ids. ALLOW leg: answering
`{ outcome: { outcome: "selected", optionId: "allow_once" } }` → Write
executes (`tool_call_update` → `status: "completed"`, file created on disk).
DENY leg: answering `{ outcome: { outcome: "selected", optionId: "deny" } }`
(kind `reject_once`) → tool ends `status: "failed"`, `rawOutput: "rejected
(deny)"`, file NOT created, the turn SETTLES `end_turn` normally (~17 s), and
the model verbalizes the denial and adapts. No hang, no ignore — the reject
side of the answer table is honored. Never-asks check: in `build` mode every
toolCallId seen on the tool_call stream was preceded by a request_permission
for the same id; the structural never-asks failure mode does NOT occur. The
§2.1 design consequence recorded for the amendment before driver code: the
gate only exists in a client-chosen mode, so the v1 driver MUST pin the
mode (one `session/set_config_option` added to the §1.2 subset) — a driver
that leaves the `yolo` default would sail through its own never-asks tripwire
on every tool run.

**OQ-6 (cancel-spend) — ANSWERED (client-observable scope per §2.3).**
Mid-turn `session/cancel` on a generation prompt: `session/prompt` resolves
`stopReason: "cancelled"` **327 ms** after the cancel notification; the
cancelled response carries `usage: null` (the fold-what-it-carried rule applies
— no invented tokens on `aborted`). Post-settle observation window (20 s):
exactly ONE further frame, the vendor extension `$/zcode/turnState`
(`params.running: false`), ZERO `agent_message_chunk`s, zero text growth.
Client-observable verdict: the stream goes silent at cancel; whether the
backend's model stream "runs to its natural end" internally (the bridge's own
comment claims the backend ignores stop, verified 0.16.5) is NOT
client-observable at 0.37.3 — unobservable, exactly as DD-1 scoped it. The
§2.3 posture (settle on the cancelled PROMPT RESPONSE, never on the cancel
write) is confirmed by the wire.

**Also observed (recorded for the conformance fixture):** update kinds seen
on a plain turn, in order: `available_commands_update` ×3,
`session_info_update`, `config_option_update` ×4, `current_mode_update` ×2,
`agent_thought_chunk`, `agent_message_chunk`, `usage_update` ×3, `plan`.
`usage_update` verbatim: `{ sessionUpdate: "usage_update", used: 15719,
size: 1000000 }` — context occupancy, not turn tokens (§1.3's drop ruling
stands). The bridge emits a placeholder `tool_call` card titled
`"tool permission (Write)"` (`status: "pending"`, `kind: "other"`) while a
permission popup is pending — a driver must not treat that card as the tool
execution. `agentCapabilities` verbatim: `{ loadSession: true,
promptCapabilities: { image: true, audio: false, embeddedContext: false },
mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {},
resume: {}, fork: {} }, _meta: { zcode: { fs: true } } }` — the §6 gate order
(loadSession → resume) is exercisable, and `fork` is additionally advertised
(out of scope per §1.3). Unprobed, recorded for later: whether mode `plan`
(read-only) could serve as the §2.2 sandbox `level` carrier.

**Checkpoint status: NO trigger fired.** (a) versions agree at 1; (b) the ask
fires in a gating mode and the rejected outcome is honored with a clean
settle; (c) both model AND usage are reported on complete runs. The goal is
READY-FOR-DRIVER-CODE, conditional on the §1.2 subset amendment recorded
under OQ-4 (mode pinning via `session/set_config_option`) being made in this
document BEFORE driver code lands.

## Complexity verdict

**ACHIEVABLE WITHIN BUDGET AS SCOPED — conditional on the live spike
answering OQ-2/OQ-5 without hitting a checkpoint-blocked trigger.** The
subset is five methods, one notification, and one client callback
(§1.2; the fifth — the mode pin — was ADDED by the step-2 amendment
after the probes showed the unpinned default is a policy void); every
hard design question (declarative permissions, sandbox
honesty, cancel semantics, usage provenance, session mapping) has a
settled answer above, most of them pre-answered by the reference's own
mechanics, which are cited and deliberately re-derived rather than
imported. The conformance fixture de-risks the suite (288 tests stay
green with no binary present), and the lane's real unknowns are
concentrated in exactly two live probes (model reporting, protocol
version) that the implementation step MUST run FIRST — before any
driver code — because both sit on the checkpoint-blocked boundary.
Materially larger only if we let the protocol surface creep past §1.3's
will-NOT list; that list is the budget guardrail, and this doc is where
it gets enforced.
