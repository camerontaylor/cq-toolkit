# ADR-0009 — Config contract v2

- **Status:** accepted by the owner on 2026-11-06
- **Date:** 2026-11-06
- **Supersedes in part:** [ADR-0002 Annex B](0002-annex-b-config.md): §B.2.5 strictness and reserved-key refusal, the "never workspace files" clause for non-trust keys, closed-domain enforcement, and the `optIn` relaxation machinery
- **Closes:** the Phase 1.7 "separate domain configurations" pointer in [ADR-0005](0005-architecture-revision.md)
- **Related:** [ADR-0004](0004-policy-check-trust-boundaries.md), [ADR-0008](0008-journal-v3-report-v2.md)

## Context

- ADR-0005-D-C deleted the Annex B resolver. Annex B's strictness, reserved-key, closed-domain and `optIn` rules
  described that resolver, and nothing in the code enforces them.
- `cq.json` v2 now carries roles (model choice), budgets, checks and review settings. Annex B's "never workspace
  files" clause no longer describes the project.
- The toolkit stamps identity names into child environments (`CQ_WORK_ID`, `CQ_ROLE`, `CQ_TASK`, `CQ_RUN_ID`,
  `CQ_PARENT_WORK_ID`) and reads operator names that Annex B's closed domain list lacks. A strict unknown-name
  check would break nested runs and version skew.
- The 2026-11-02 spec-conformance audit graded the code against the stale Annex B text, so several config rows
  report NOT MET where the contract, not the code, is out of date.

## Decision

**Names warn, values fail.**

- An unknown or reserved `CQ_*` name produces one stderr warning, with the nearest known name, and is recorded at
  run start. The run continues.
- A recognised key with an invalid value, or a denied name (`CQ_APPROVAL_KEY*`), fails before dispatch. All such
  errors are reported together, with exit 2.
- This is safe because of one invariant: **blank means conservative.** Every env-sourced key's blank value is its
  conservative value (for example `CQ_SANDBOX` blank means `required`). A mistyped name therefore falls back to
  stricter behaviour, never looser. A key whose blank is not conservative (a limit, such as a budget cap) must not
  be env-sourced; those live in `cq.json`, which is schema-strict.
- Near-miss exception: if such a key is ever env-sourced, an unknown name whose nearest match is that key fails
  instead of warning.

**Precedence.** built-in → `cq.json` (committed, schema-strict) → env (`CQ_*`) → per call (CLI flag or op
input). Trust-boundary keys (sandbox, merge trust set, protected branch and paths, approval) skip the `cq.json`
and per-call layers: they never come from `cq.json`, plan JSON or op input. The list is examples: the `trust`
flag in the registry (`src/config/env.ts`) is authoritative for which keys are trust-boundary keys.

`CQ_PROFILE` profile seeding (Annex B §B.4.1) is retired. Nothing in `src` reads `CQ_PROFILE`.

**Secrets** come from env only. A key is secret by name suffix, as in Annex B.

**`CQ_APPROVAL_KEY*` is denied.** Approval is the attended preview-digest authority, not an env key.

**Resolve once.** Each entry point (CLI, MCP harness, `runPlan`, selfhost entries, the driver-factory default)
reads the environment once into a deeply frozen snapshot of values, sources, warnings and errors, and passes it
down. Code below the entry point does not read `process.env` for `CQ_*` names.

**Run-start record.** The run-start record carries the resolved values, their source layers and the warnings.
Secrets are recorded as present or absent, never by value. This extends ADR-0008 provenance (`cqJsonHash`).

**Op-input mirrors of trust keys** (for example `protectedBranch`, `baseBranch`) are removed where the caller can
use the resolved value. Any that remain are compared with the resolved value, and a difference fails with `config`.
Neutral keys such as `sessionsDir` may be set per call and are recorded as the `call` layer.

**Key list.** The key list is generated from the code registry `src/config/env-registry.ts` into
[`docs/config.md`](../config.md); the static gate fails when that table is stale. Annex B's hand-written key
tables are retired; where they differ from the registry, the registry is current.

**Inspection.** `cq config` prints each resolved key, its source layer and the warnings. `cq config --strict`
exits 1 on any warning. It is opt-in, not a required check.

## What changes in Annex B

Superseded:

- §B.4.1 `CQ_PROFILE` profile seeding.
- §B.2.5 strictness and the reserved-key refusal (replaced by "names warn, values fail").
- §B.1 "never read from workspace files" for non-trust keys (replaced by the precedence above).
- Closed-domain enforcement, and the `optIn` relaxation machinery with its generated per-call union.
- The hand-written key tables.

Still in force: secret-by-suffix and env-only secrets (N4); the value grammar wherever code uses it; the CI
variable mapping (N15 and N21); the ADR-0004 trust boundaries; P8 (conservative by default).

## Consequences

- Typos in `CQ_*` names no longer fail runs but are always surfaced, once, with a suggestion.
- Config rows of the audit that depended on the stale text are re-graded against this ADR or marked superseded.
- Adding an env key means adding one registry entry that declares its kind, parser, `blank` class and trust flag.
- The implementation lands in follow-up slices; until then the code differs from this ADR in the ways the
  registry, snapshot and run-start record describe.
- Changing what `cq.json` trusts (for example a PR editing its own `checks`) is an ADR-0004 question and is not
  decided here.
