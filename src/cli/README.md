Secondary interface: one subcommand per op + per shipped plan.
Land: phase 3 (WS-I).

THE I1 CLI CONTRACT (landed):

- bin = dist/cli.js — the src/cli.ts shim; all behavior lives in src/cli/.
- One subcommand per registry entry, plus the built-in 'run-plan'.
- One subcommand per SHIPPED PLAN, generated from the plan registry
  (src/cli/plans.ts): every name the plan registry discovers is a
  subcommand, so a new src/plans/<name>.ts registers itself with no CLI edit.
  A plan subcommand takes run-plan's governed-run flags MINUS --plan AND the
  run-plan-reserved --ops-root (RunPlanCommandSchema) and runs the registry
  entry's discoverable floor plan through the same governed composition
  (runPlan under a Governance handle when the operator set a cap); the floor
  is validated with PlanSchema before
  the run, so malformed plan data is a usage error (exit 2).
  `run-plan --plan=<file>` remains the way to run an arbitrary plan JSON, and
  --ops-root remains a run-plan flag (a plan subcommand rejects it with exit
  2; embedders inject an ops root through the runCli DI).
  Op names win on a name collision (the op registry is consulted first).
- stdout = exactly ONE JSON artifact per invocation (an OpResult, or a
  RunReport for run-plan); the plain-text `--help` surface is the one
  sanctioned exception. In human mode an invocation that fails before any
  result exists (usage error, invalid input, thrown) leaves stdout empty.
- stderr = `cq:`-prefixed narration, failures-only by default; `--json`
  suppresses narration entirely (machine mode): stderr stays empty on every
  path, and an error that has no result artifact writes ONE error artifact
  to stdout instead:
  `{ "error": { "kind": "usage" | "invalid-input" | "invalid-result" |
"thrown", "subcommand": "<name>" | null, "message": "<text>",
"exitCode": <n> } }`. It replaces the empty stream and never accompanies a
  result artifact; the shapes are told apart by `status` (a result) vs an
  object-valued `error` (this artifact; a `failed` result's `error` is a
  string). Kinds: `usage` = arg-shaped (unknown/missing subcommand, flag
  syntax, positional, valued reserved flag, `--ops-root` misuse);
  `invalid-input` = schema/plan-file defects (exit 2); `invalid-result` = the
  result gates (exit 1); `thrown` = an op/run-plan throw or the last-resort
  catch (exit 1; the transient plan-lock refusal is `thrown` with exit 3).
- Exit codes {0 clean, 1 thrown/definitive failure, 2 arg/usage error,
  3 needs-human/budget-exhausted} — derived in src/cli/exit.ts, mechanically
  from the frozen taxonomy; 2 is never derived from a taxonomy value.
  `--fail-on-verdict` (opt-in, bare only; only the exact own-property value `"fail"` counts) additionally maps an `ok` result
  whose value is an object with `verdict: 'fail'` — for run-plan and plan
  subcommands, any ok row with such a value — to 1; every other result maps
  unchanged and stdout is identical with or without the flag (so
  `cq ratchet.checkRatchet … --json --fail-on-verdict` is a one-line CI gate).
- Flags are a thin JSON-flag mapping onto the op's input schema (values
  JSON-parsed when they parse): ops take EXACT schema keys; run-plan takes
  kebab-case aliases (--ops-root, --journal-dir, --max-usd, --max-tokens,
  --stop-on-error, --opt-in — the governance opt-ins, comma-separated keys
  from the kernel's GovernanceOptIn union; an opt-in alone constructs the
  governance handle, so `budget.ungovernedOverGoverned` marks an uncapped
  run ungoverned).
- `json`, `help`, `h`, and `fail-on-verdict` are CLI-reserved keys on every
  subcommand (narration mode / help surface / verdict exit code): op input
  schemas must not declare them. VALUED
  reserved flags (`--json=x`, `--help=x`, `--h=x`, `--fail-on-verdict=x`) are rejected with exit 2
  on EVERY subcommand — ops and run-plan alike — by a raw-token gate that
  runs before the help/mode branches (so `cq echo --help --json=yes` and
  `cq run-plan --plan=p --json=yes` are usage errors, never a silently
  ignored flag or a silent human-mode downgrade). Bare `--json`/`--help`/`-h`
  keep their mode/help behavior and never reach op input.
- `--help` renders the subcommand's input schema, listing each object
  alternative separately for union schemas; an unknown subcommand exits 2.
- Unknown-flag enforcement is two-tier: unknown flag SYNTAX (positional
  tokens, duplicate flags) and unknown KEYS for run-plan are rejected by
  the CLI (exit 2); for op subcommands, unknown KEYS are rejected by the
  op's own `.strict()` zod schema — the family convention REQUIRES
  `.strict()` (see src/ops/README.md) — so key enforcement is
  schema-delegated there.
- `--ops-root` is reserved for run-plan (op subcommands reject it with
  exit 2), and op help lists `--json`.
- No-logic-in-CLI is enforced by the eslint boundary rule
  cq/no-cli-beyond-registry-kernel (src/cli may import only the registry,
  the kernel, intra-CLI modules, node: builtins, and zod in run-plan.ts).
