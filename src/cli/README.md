Secondary interface: one subcommand per op + per shipped plan.
Land: phase 3 (WS-I).

THE I1 CLI CONTRACT (landed):
- bin = dist/cli.js — the src/cli.ts shim; all behavior lives in src/cli/.
- One subcommand per registry entry, plus the built-in 'run-plan'.
- stdout = exactly ONE JSON artifact per invocation (an OpResult, or a
  RunReport for run-plan); the plain-text `--help` surface is the one
  sanctioned exception.
- stderr = `cq:`-prefixed narration, failures-only by default; `--json`
  suppresses narration entirely (machine mode).
- Exit codes {0 clean, 1 thrown/definitive failure, 2 arg/usage error,
  3 needs-human/budget-exhausted} — derived in src/cli/exit.ts, mechanically
  from the frozen taxonomy; 2 is never derived from a taxonomy value.
- Flags are a thin JSON-flag mapping onto the op's input schema (values
  JSON-parsed when they parse): ops take EXACT schema keys; run-plan takes
  kebab-case aliases (--ops-root, --journal-dir, --max-usd, --max-tokens,
  --stop-on-error).
- `json`, `help`, and `h` are CLI-reserved keys on every subcommand (narration
  mode / help surface): op input schemas must not declare them. Bare
  `--json`/`--help`/`-h` keep their mode/help behavior and never reach op
  input; a VALUED reserved flag on an op subcommand (`--json=…`) is a usage
  error (exit 2).
- `--help` renders the subcommand's input schema; an unknown subcommand
  exits 2.
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
