# The `acp` driver (T1.8)

The fourth driver lane: speak the **Agent Client Protocol** —
newline-delimited JSON-RPC 2.0 over stdio — to a vendor **harness binary**
as a governed worker on the frozen seam
(`run(opInvocation) → Promise<WorkerResult>`, `src/driver/types.ts`).
Commercial basis: Z.AI discounts work done through its own harness, so
routing a run through the vendor's binary is a cheaper wire for the same
model. One spawn per run, no daemon, no pooling, no retries.

- **Strategy + live-probe evidence:** `docs/acp-driver-strategy.md` (the
  governing document — every protocol claim carries a citation; the
  wire shapes were transcribed from live probes against
  `zcode-acp-server@0.37.3`).
- **Wire vocabulary:** `src/driver/acp/protocol.ts` — OURS, zero imports
  of `@agentclientprotocol/sdk` or any vendor package.
- **Fixture:** `test/fixtures/fake-acp-server.mjs` — the whole suite
  passes with NO harness binary present.

## Binaries, and how they are discovered

Endpoints live in a plain-data registry (`src/driver/acp/binaries.ts`):

| endpoint            | default argv         | install                              |
| ------------------- | -------------------- | ------------------------------------ |
| `zcode-acp-server`  | `zcode-acp-server`   | `npm install -g zcode-acp-server`    |
| `dsh-acp`           | `dsh-acp`            | `npm install -g @openma/deepseek-harness-acp` |

Resolution order (strategy §3):

1. **Explicit constructor argv first** — `new AcpDriver({ command:
   ['zcode-acp-server', '--some-flag'] })`. The WHOLE argv is config,
   because harness launch shapes differ (a package-runner prefix, flags).
2. **PATH fallback** — a bare binary name is resolved like `which`
   (every `PATH` entry probed for an executable); an absolute or
   path-carrying argv element is used as-is.
3. **Absent binary = pre-dispatch throw** naming the binary, the install
   hint, and the searched PATH — before any session exists, never a crash
   mid-run. The harness is **never bundled, never a dependency** — not
   even an optional peer.

The child process is spawned with `cwd` = the invocation's workspace and
the driver's process env (the vendor reads its own credentials app-side —
OQ-1: no auth gate, `authenticate` is never called; an `auth_required`
error fails the run naming the advertised authMethods). Config channels:

- `envNames: ['ZCODE_BIN', …]` — host env var **NAMES** copied into the
  child env at run() time (never values in config; a missing value throws
  pre-dispatch). For zcode, `ZCODE_BIN` points at the desktop-app CLI
  (e.g. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`) when
  the `zcode` binary is not on PATH.
- `modelEnv: 'FAKE_ACP_MODEL'` (name chosen by the deployment) — hands the
  **requested** model id to the harness through its spawn env. This is the
  vendor-specific REQUEST channel; the OBSERVED model (below) is what
  binds, and it is never substituted into the result.

## Adding an endpoint

```ts
import { AcpDriver, AcpEndpointTableSchema, defaultAcpEndpointTable } from 'cq-toolkit';

const driver = new AcpDriver({
  endpointTable: AcpEndpointTableSchema.parse({
    endpoints: {
      ...defaultAcpEndpointTable().endpoints,
      'my-harness': {
        command: ['my-harness-acp'],           // default launch argv
        installHint: 'npm install -g my-harness-acp',
        notes: 'env var NAMES the harness reads — never values',
      },
    },
  }),
  endpoint: 'my-harness', // or just pass `command` explicitly
});
```

Anything the ACP subset carries works through the same driver — the lane
is deliberately not zcode-specific.

## THE MODE PIN — required before every prompt

ACP sessions open in mode `yolo`, and **`yolo` never asks permission** —
tools execute ungated (live-verified, strategy §1.2/OQ-4). The permission
boundary is the ONLY gate this lane owns, so before ANY prompt the driver
pins the gating mode:

```
session/set_config_option { configId: 'mode', value: 'build' }
```

A failed pin is a pre-prompt **error verdict** — an unpinned session is a
policy void, not a degraded run. The pin is **verified, not just sent**,
against EITHER of the two surfaces the wire actually offers: the
response's echoed `modes.currentModeId`, or a `current_mode_update`
notification naming `build` (the live vendor's shape — probe 2026-09-14:
its set_config_option answer carries no modes member; the switch rides a
notification in the same flush, before the response line). Neither surface
naming `build` is a failed pin (review-debt #39). The never-asks tripwire
(below) is the backstop for a harness that accepts the pin and still does
not ask.

## Tool permissions: the answer table, and the tripwire

The frozen `ToolPolicy` is answered declaratively per
`session/request_permission` (the user is never prompted):

- mode `none` → deny everything (`tool policy: mode none`);
- sandbox `read-only` → deny everything (fail-closed: the wire carries no
  read/write classification it can trust — `kind` is ABSENT on the
  reference vendor's request; this is the permission boundary pointed at
  maximum caution, NOT filesystem containment);
- mode `unrestricted` → allow everything;
- mode `allowlist` (the default) → the request's matched tool identity
  (the leading token of the vendor's `<toolName>: <summary>` title,
  case-insensitive) against `policy.allow`.

Answers are selected **by `kind`, never by optionId** — optionIds are
vendor strings (`allow_once` / `allow_project` / `deny` on zcode): ALLOW
→ `allow_once`, else `allow_always`; DENY → `reject_once`, else
`reject_always`. A deny with NO reject option offered **fails the run**,
naming the offered options. The driver NEVER answers `cancelled` — that
outcome is only legal on a real cancellation. Every deny lands in
`WorkerResult.denials` at the answer; a tool that executed and then
failed is a second denial channel (reason = the vendor's `rawOutput`),
deduped per toolCallId.

**The never-asks tripwire:** the spec makes asking the AGENT's decision,
so a vendor that executes tools without asking is protocol-legal. The
driver watches the `tool_call` stream: a tool call whose id was never
preceded by a `session/request_permission` is recorded as evidence of
UNGATED EXECUTION (session narration, `cq: 'never-asks'`) and the run
verdict is **`error`** — a policy that cannot be enforced is never
silently soft.

The mirror failure through the answer channel — a DENIED tool that
nevertheless reports a completed execution (the harness asked, was told
no, and ran the tool anyway) — is the same verdict: `error`, with the
bypass recorded as narration evidence and never as a governed tool
message (review-debt #45).

## The observed model (leg m), usage, and cost

- `WorkerResult.model` is the **post-materialization**
  `config_option_update` model value ONLY — in `providerId\modelId`
  format, the vendor's own encoding. The `session/new` `configOptions`
  entry is the LAZY default and is never surfaced (the providerId
  CHANGES between the two on the reference vendor: `builtin:zai\…` →
  `builtin:bigmodel\…`). A harness that materializes nothing omits the
  field, and the conformance suite fails that lane — by design.
- Usage folds ONLY from `PromptResponse.usage` (`usage_update` frames are
  context telemetry, dropped): `outputTokens → output`, `cachedReadTokens
  → cacheRead`, `cachedWriteTokens → cacheWrite`, and DERIVED input —
  `input = inputTokens − cachedReadTokens − cachedWriteTokens`, floored
  at 0. The wire's `inputTokens` is INCLUSIVE of the cached tokens (the
  live sample: totalTokens 15722 = 4071 + 3 + 11648 + 0 — the derived
  fold sums to the wire's own total, while the old straight
  `inputTokens → input` mapping totals 27370, double-counting cache).
  `reasoning` is never emitted — `thoughtTokens` exists on the wire but
  its additivity vs `outputTokens` is unproven.
- `costUSD` is derived-only (`pricing` lookup over the folded usage,
  keyed by the OBSERVED model), labeled `costBasis: 'modeled'`, absent
  for unpriced models, and absent on every unmeasured verdict (the
  cancelled response carries `usage: null`). Vendor cost figures are
  dropped with the frame that carries them (DD-9).

## Sessions, budget, structured output

- **I6 isolation:** no `sessionRef` → fresh temp workspace + fresh
  record + a fresh ACP session. `sessionRef` → the SAME workspace
  continues; the vendor conversation continues through the resume gate
  (strategy §6, the reference's own order): `session/load` when the
  harness advertises `loadSession`, else `unstable_resumeSession` when
  `sessionCapabilities.resume` is advertised, else an honest
  workspace-only continuation — using the ACP session id in the
  workspace sidecar `.cq-cli-session`. The sidecar is written whenever a
  run established an ACP session; the advertised capabilities gate only
  its USE on the next run (a sidecar-less workspace, or an agent
  advertising neither capability, is that honest partial continuation).
  Unknown `sessionRef` throws pre-dispatch.
- **I8 budget:** the driver owns NO wall clock — the governed
  `currentJobContext()?.signal` fires `session/cancel`, and the run
  settles on the cancelled PROMPT RESPONSE (stopReason `cancelled` →
  `aborted`), never on the cancel write. `maxTokens` is post-hoc
  classification over the folded usage; no request timeouts, no retries.
- **Structured output** (no ACP carrier exists): the constructor's
  `outputSchema` appends the JSON schema + a reply-with-only-JSON
  instruction to the prompt; the assembled text is validated post-settle;
  a failing payload is dropped to narration, never trusted (DD-4's
  malformation rate is recorded, not solved).
