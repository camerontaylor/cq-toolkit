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
- `--help` renders the subcommand's input schema; an unknown flag or
  subcommand exits 2.
- No-logic-in-CLI is enforced by the eslint boundary rule
  cq/no-cli-beyond-registry-kernel (src/cli may import only the registry,
  the kernel, intra-CLI modules, node: builtins, and zod in run-plan.ts).
