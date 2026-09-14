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

## Runner, manifest, journal (T1.2)

`runPlan(plan, opts, registry)` interprets a plan to a `RunReport` (R2 §5:
a deterministic interpreter — no daemon, no workflow engine; rescue is
T1.3's governor, never the runner).

- **Registry is dependency-injected** (`OpRegistryView.get`): the frozen
  `RunOptions` cannot carry it, and the runner stays DI-clean — phase-2
  lane I's `src/plans/registry.ts` will own the global registry. Unknown op
  names fail that job at execution time; the manifest still builds
  (op-agnostic).
- **Committed manifest**: `makeManifest` freezes a plan into plain rows,
  each with `inputsHash = sha256(canonicalJson({op, input}))` — key-order
  independent, array-order sensitive. That hash is what makes replay
  provable.
- **NDJSON journal** (`<journalDir>/<runId>.ndjson`): append-only,
  schema-validated facts; a torn tail (crash mid-append) is ignored only as
  the LAST line, corrupt middle lines throw; `statusOf` is derived at read
  by folding events.
- **Replay/resume** (`resume: true`): the latest prior run for the planId;
  a job skips only on terminal-`ok` + equal `inputsHash` (zero op
  invocation, outcome reconstructed from the journal); everything else
  re-runs — continue-from-first-failure falls out naturally.
- **stopOnError**: after the first non-ok result nothing new starts
  (in-flight jobs complete and are recorded); downstream jobs are `blocked`,
  never-dispatched jobs with healthy dependencies are `queued`.

Recorded freeze-friction workarounds (the ws-a "deviations need a recorded
reason" clause):

- `JobState` has no needs-human/indeterminate values, so report COUNTS map
  needs-human→blocked and indeterminate→failed; `JobOutcome.result` rows
  keep the true taxonomy statuses (and resume re-runs both).
- Blocked jobs emit NO journal events — no frozen event type can express
  blocking — so they exist only in the run report.
- Replay re-attests skipped jobs with a `job-finished` event and no
  preceding `job-started` (no dispatch happened; the verified inputsHash
  makes the attestation sound). This keeps each run's journal
  self-contained so the latest-run rule survives chained resumes.
