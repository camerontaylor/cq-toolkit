# Composition kernel

The kernel owns the frozen contracts everything else composes: the atomic-op
contract, the result taxonomy, plans/journal/run types, and the registry
entry shapes. Source of truth (start reading here):

- `src/kernel/types.ts` — hand-written frozen types (single source of truth)
- `src/kernel/schema.ts` — zod mirrors for serializability tests and journal
  parsing (strict: unknown keys fail parsing)

## What the kernel owns

- **Op contract.** `Op<I, R>` is a typed async function
  `(input: I) => Promise<OpResult<R>>`. Inputs and outputs are
  JSON-serializable; ops never see drivers, processes, or exit codes. Exit
  codes {0,1,2,3} belong to the CLI layer (resolves design debt DD-7).
- **Result taxonomy.** `OpResult<R>` has exactly five frozen statuses:
  `'ok' | 'failed' | 'needs-human' | 'budget-exhausted' | 'indeterminate'`.
  - `ok` — produced `value`
  - `failed` — definitive failure; `error` says why
  - `needs-human` — stopped for a human decision (`reason`)
  - `budget-exhausted` — did not run, or halted, on a budget bound
  - `indeterminate` — no verdict possible (`detail` carries what is known);
    assume neither success nor failure
- **Plans, journal, runs.** `Plan`/`Job` (serializable plans-as-data),
  `RunOptions`, `RunReport` (with the honest-stop flag), `Limits` (dual
  caps: `inFlightCeiling` is separate from `runDispatchQuota`), the
  `JournalEvent` union (discriminated on `type`; `job-finished` carries the
  frozen replay record `opId + inputsHash + result`), `JobState`/`JobStatus`.
- **Registry entries.** `OpRegistryEntry` (`name`, `inputSchema`, lazy
  `importer`) and `PlanRegistryEntry` are runtime-only — function fields,
  never persisted, deliberately no schema mirror.

## The freeze rule

These types are the GLOBAL freeze point for the toolkit; the frozen surface
is tagged `types-freeze-v1`. After the tag, any change to a frozen name,
field, status value, or schema is a separate migration PR with its own
review — never an edit folded into a later goal. Serializability is pinned
by `test/kernel/types.test.ts`.

## Vendor neutrality (invariant I10)

No vendor SDK imports and no vendor vocabulary in kernel types or persisted
data — kernel code speaks only its own plain-data language. Enforced in CI
by the eslint rule `cq/no-vendor-sdk-in-kernel`, scoped to `src/kernel/**`
(the driver seam types file sits under the same ban).

## What lands next

Phase 1 (this phase): plan runner, NDJSON journal, budget governor — all
consuming these frozen types as-is. Later phases: op families under
`src/ops/`, the plan library under `src/plans/`, and the CLI layer (which
owns the {0,1,2,3} exit-code mapping) under `src/cli/`.
