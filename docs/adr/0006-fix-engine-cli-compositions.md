# ADR-0006 — Fix engine and address-review as CLI compositions

- **Status:** accepted by the owner on 2026-10-24 (approval of `plans/cq-next-step-slice-plan.md` and `specs/cq-next-step-slice-spec.md` in the toolkit-research workspace)
- **Complements:** ADR-0003 (governed runner) and ADR-0005 (architecture revision); amends the kernel freeze rule only in the sense ADR-0005 already allows

## Context

The 2026-10-24 developer-loop step adds agent-driven commands — `fix.run`, `review.run`,
`review.address`, `review.addressMany` and `dev.cycle` — that own a loop: dispatch worker
fan-out, recheck failures, commit, escalate. Three earlier answers bound how they may be
built:

- The frozen job schema carries no dataflow (`src/plans/sweep.ts:7-11`), and plan
  subcommands can only run floors (`src/cli/plans.ts:15-20`), so a dataflow cannot be
  expressed as a plan.
- The 2026-10-23 clarification rejected an attended `analyze.*` loop as the vehicle, and
  the attended authority stays the only auto-apply path.
- The kernel is retry-free (I8), a freeze ADR-0005 amended but did not lift; a new kernel
  retry facility would reintroduce the governing-kernel coupling ADR-0005 removed.

## Decision

`fix.run`, `review.run`, `review.address`, `review.addressMany` and `dev.cycle` are
registered ops that own their dataflow in memory (the `merge.runPrs` pattern) and dispatch
worker fan-out through `runPlan`. Escalation is a pure policy module in the composition
layer. The kernel stays retry-free. Validation is one shared module. Policy comes from
`cq.json`.

## Alternatives considered

- **Attended `analyze.*` loop** — rejected by the 2026-10-23 clarification and the
  attended authority.
- **Configurable plan subcommands** — impossible without an op owning phase B; the plan
  schema is frozen.
- **A new kernel retry facility** — violates I8 and the kernel freeze amended by
  ADR-0005.

## Why chosen

Minimal new surface over tested ops; preserves I1/I5/I8/I9; each command is testable with
scripted drivers and fake forges.

## Consequences

- `sweep.unit` gains an optional task loop.
- The `review.fixItem` schema widens additively.
- `dev.ready` accepts any configured reviewer's terminal cycle.
- `cq.json` becomes the policy file for all commands (schemaVersion 2, migrated in
  `analyze.init`).
- The e2e runner's wiring moves into `src`.

## Follow-ups

- claude-code lane binding from `cq.json` (tracked as an issue).
- Session-resume continuation for the inner loop.
- Ruff/Knip adapters (#378 remainder) and the oxlint-json adapter (#396).
- crq enrolment becoming non-advisory after #376.
- Gating self-hosting on a positive fixes-per-run.
