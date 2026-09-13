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
