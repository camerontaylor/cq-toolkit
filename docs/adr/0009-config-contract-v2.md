# ADR-0009 — Config contract v2

- **Status:** accepted by the owner on 2026-11-06
- **Date:** 2026-11-06
- **Supersedes in part:** [ADR-0002 Annex B](0002-annex-b-config.md): §B.2.5 strictness and reserved-key refusal, §B.4.1 `CQ_PROFILE` profile seeding, the "never workspace files" clause for non-trust keys, closed-domain enforcement, and the `optIn` relaxation machinery
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
  run start. In machine mode (`--json`) stderr stays empty (I1) and the warning rides the run-start record
  instead. The run continues.
- A recognised key with an invalid value, or a denied name (`CQ_APPROVAL_KEY*`), fails before dispatch. All such
  errors are reported together, with exit 2. The one exception is the MCP harness (`src/harness/mcp/bin.ts`): it
  keeps its documented startup protocol and exits 78 (`EX_CONFIG`, sysexits) with one stderr line, which the
  driver's init-surface assertion relies on.
- This is safe because of one invariant: **blank means conservative.** Every env-sourced key's blank value is its
  conservative value (for example `CQ_SANDBOX` blank means `required`). A mistyped name therefore falls back to
  stricter behaviour, never looser. A key whose blank is not conservative (a limit, such as a budget cap) must not
  be env-sourced; those live in `cq.json`, which is schema-strict.
- Near-miss exception: if such a key is ever env-sourced, an unknown name whose nearest match is that key fails
  instead of warning.

**Precedence.** built-in → `cq.json` (committed, schema-strict) → env (`CQ_*`) → per call (CLI flag or op
input). Trust-boundary keys (sandbox, merge trust set, protected branch and paths, approval) skip the `cq.json`
and per-call layers: they never come from `cq.json`, plan JSON, op input or workspace files: an op-input field that restates one must equal the resolved value and supplies nothing. The list is examples: the `trust`
flag in the registry (`src/config/env-registry.ts`) is authoritative for which keys are trust-boundary keys.

**The one per-call route for a trust key** is an explicit in-process SDK `optIn` (ADR-0003 named authorization),
built with `trustedOptIn()` (`src/config/optin.ts`). It must never be fed from plan JSON, op input or the CLI: the
brand is a module-private `WeakSet` entry, so a JSON-derived object cannot carry it. The resolvers
(`resolveSandboxConfig`, `resolveProtectedPathsConfig`) call `assertOptInAuthority`, which consults the `trust`
flag: a per-call value for a `trust: true` key from anything but a `trustedOptIn()` object is refused with a
`config` error. Keys with `trust: false` are unaffected.

`CQ_PROFILE` profile seeding (Annex B §B.4.1) is retired. Nothing in `src` reads `CQ_PROFILE`.

**Secrets** come from env only. A key is secret by name suffix. The list is `SECRET_ENV_SUFFIXES` in
`src/config/secret.ts`, matched case-insensitively by `isSecretEnvName`, and the registry derives each entry's
`secret` flag from it. Today the list includes `_URL`, which Annex B's own list omits, so vendor `*_BASE_URL` names
(for example `ANTHROPIC_BASE_URL`) are classified secret and recorded as present or absent only. Whether `_URL`
should stay a secret suffix is pending an owner decision and is not decided here.

**`CQ_APPROVAL_KEY*` is denied.** Approval is the attended preview-digest authority, not an env key.

**Resolve once.** Each entry point (CLI, MCP harness, `runPlan`, selfhost entries, the driver-factory default)
reads the environment once into a deeply frozen snapshot of values, sources, warnings and errors, and passes it
down. Code below the entry point does not read `process.env` for `CQ_*` names.

**Run-start record.** The run-start record carries the resolved values of the configuration names the
environment set (source `env`), every value as text, and the warnings. A configuration name that is absent from the
record means the built-in default applied. Identity names (`CQ_WORK_ID` and the like) are excluded by design: they
have no built-in default and the correlation record carries them. Secrets are recorded as present or absent, never
by value. Defaults and other layers are not recorded. A snapshot that carries an error is refused, never recorded.
This extends ADR-0008 provenance (`cqJsonHash`).

**Op-input mirrors of trust keys** (`protectedBranch`, `baseBranch`, and the classification trust fields
`config.trustedBots`, `config.trustedAssociations` and `config.acceptReviewStates`) are removed where the caller can
use the resolved value. Any that remain are compared with the resolved value (`src/ops/merge/trustMirrors.ts`), and
a difference fails with `config` before any effect; the error names the field and never echoes a plan-supplied trust
list. A mirror that equals the resolved value is accepted, because it supplies nothing: the effective value always
comes from the registry key (`CQ_MERGE_PROTECTED_BRANCH`, `CQ_MERGE_BASE_BRANCH`, `CQ_MERGE_TRUSTED_BOTS`,
`CQ_MERGE_TRUSTED_ASSOCIATIONS`, `CQ_MERGE_ACCEPT_REVIEW_STATES`), and an invalid snapshot value fails rather than
defaulting. Branch values are normalised exactly once, by stripping a single leading `refs/heads/`.
When any reviewer-trust key is set, each unset one independently takes its documented default (bots: none;
associations: OWNER, MEMBER, COLLABORATOR; states: APPROVED). Neutral keys such as `sessionsDir` may be set per call;
a per-call value is not recorded in the run-start config (call-layer recording is out of scope for C5 and would need
a schema and ADR change).

**Key list.** The key list is generated from the code registry `src/config/env-registry.ts` into
[`docs/config.md`](../config.md); the static gate fails when that table is stale. Annex B's hand-written key
tables are retired; where they differ from the registry, the registry is current.

**Inspection.** `cq config` prints each resolved key, its source layer, the warnings and the errors. It exits 2
when the environment has errors (after printing the report), like every other subcommand. `cq config --strict`
exits 1 on any warning when there are no errors. It is opt-in, not a required check.

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

## Appendix: process.env confinement (C7)

The lint rule `cq/no-process-env` bans `process.env` in `src/**`. The rule is also switched off for `src/config/**` (the snapshot and entry helpers and the shared accessor may read
`process.env`; code below an entry point must not, see "Resolve once"). The files below are switched off in
`.oxlintrc.json`, each for one reason:

- `src/adapters/forge-github/gh.ts`: gh child env composition
- `src/adapters/forge-github/ghEffects.ts`: gh child env composition
- `src/adapters/forge-github/ratchetEffects.ts`: gh child env composition; CQ_AUTOMATION_TOKEN becomes GH_TOKEN there
- `src/adapters/git/ratchetGit.ts`: git child env composition
- `src/driver/acp/index.ts`: ACP child env builder (foreign names)
- `src/driver/ai-sdk/index.ts`: provider key and base-URL lookup (foreign names)
- `src/driver/claude-code/cli.ts`: claude child env builder (foreign host vars)
- `src/driver/claude-code/sdk.ts`: claude SDK child env builder and provider key lookup
- `src/driver/error-text.ts`: redacts ambient secret values from error text (whole-env scan)
- `src/harness/mcp/startup.ts`: MCP startup env scrub; replaces process.env in place
- `src/harness/tools.ts`: tool child env builders
- `src/kernel/runner.ts`: C5 in flight; migrate after
- `src/ops/analyze/approval.ts`: git child env composition
- `src/ops/analyze/fix.ts`: git child env composition
- `src/ops/dev/effects.ts`: git child env composition
- `src/ops/dev/internal/snapshot.ts`: git child env composition (strips GIT_*)
- `src/ops/sweep/unit.ts`: redacts ambient secret values from sweep output (whole-env scan)
- `src/sandbox/launcher.ts`: PATH lookup for the sandbox launcher binary
- `src/selfhost/self-merge-prs.ts`: C6 in flight; migrate after
- `src/shared/proc.ts`: the shared child env builder

The rule `cq/no-process-env-accessor` bans importing or calling `processEnv()` (`src/config/process-env.ts`) outside `src/config/**` and the debt list below. These readers have no `CqEnv` snapshot from their caller yet (debt: thread CqEnv; see issue #1185). Remove a file from the list in `.oxlintrc.json` as it is migrated; when the list is empty, delete `processEnv()` and the rule.

- `src/config/process-env.ts`
- `src/driver/acp/binaries.ts`
- `src/driver/claude-code/routing.ts`
- `src/driver/factory.ts`
- `src/driver/sessions-dir.ts`
- `src/harness/surface.ts`
- `src/ops/config/show.ts`
- `src/ops/dev/review-transport.ts`
- `src/ops/fix/runFix.ts`
- `src/ops/gates/policyConfig.ts`
- `src/ops/gates/registry.ts`
- `src/ops/review/internal/addressEvidence.ts`
- `src/ops/review/internal/queueClient.ts`
- `src/ops/review/queue.ts`
- `src/sandbox/config.ts`
- `src/sandbox/index.ts`
- `src/sandbox/launcher.ts`
- `src/selfhost/acceptance.ts`
- `src/selfhost/config.ts`
- `src/selfhost/observe-prs.ts`
- `src/selfhost/policy-diff.ts`
- `src/selfhost/self-review-loop.ts`
- `src/selfhost/verify-ratchet.ts`
