@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript SDK of atomic code-quality operations, a deterministic plan runner that composes those operations into reproducible execution plans, and adoptable merge-queue and doctrine policy templates that other repositories can take in whole or in part. It is greenfield and self-hosting — the toolkit's own quality gates run on the toolkit itself — and it is a work in progress. See the [documentation index](docs/README.md) for the canonical reading set.

The SDK is the primary interface; the CLI is a secondary interface over the same ops and plans, and no logic lives only in the CLI. Doctrine: see [policy/DOCTRINE.md](policy/DOCTRINE.md). Review protocol (one CodeRabbit CLI cycle before every PR, then one independent head-bound review): see [docs/coderabbit-review.md](docs/coderabbit-review.md). Generated per-op reference: see [docs/ops/](docs/ops/) (regenerate with `pnpm run gen:op-docs`).

## Install

The first npm release is `0.2.0` (no `1.x` will be published). Until `@camerontaylor/cq-toolkit@0.2.0` is on the registry — the `0.0.0` version there is a name reservation whose payload is LICENSE + README only — install and build from source:

```sh
git clone https://github.com/camerontaylor/cq-toolkit
cd cq-toolkit
pnpm install --frozen-lockfile
pnpm run build
```

Once `0.2.0` is published, the install is the usual one:

```sh
npm install @camerontaylor/cq-toolkit
```

The package is ESM-only (`"type": "module"`); the CI matrix runs Node 24.

## SDK first

Every op is reachable from the package root, and the plan runner composes ops through the frozen kernel contracts. Discover the registry, then invoke an op through its entry:

```ts
import { getOp, listOps } from '@camerontaylor/cq-toolkit';

const names = (await listOps()).map((entry) => entry.name); // every registered op

const entry = await getOp('analyze.run');
if (entry === undefined) throw new Error('op not registered');

const op = await entry.importer(); // lazy: no op module loads before this
const result = await op({ dir: '.' }); // OpResult — a status-tagged union
if (result.status === 'ok') {
  // probe → collect → cluster → report: reads ./cq.json (`cq analyze.init` writes one)
  console.log(result.value.failureCount, result.value.clusters, result.value.markdownPath);
}
```

The same op is composable directly — `makeAnalyzeRun(subprocessRunCheck)` — with your
own check runner injected; `analyze.fix` previews a remediation for one cluster and applies
it only through an attended approval (`makeAttendedApprovalAuthority`, ADR-0003).

The runner is exported too: `runPlan(plan, opts, registry, gov?)` returns a
serializable `RunReport` (per-job outcomes, usage rollup, honest-stop counts);
its third argument is an `OpRegistryView`, and budget governance rides the
optional fourth — a `Governance` handle (`{ governor, signal?, attended?,
optIn? }`); inject a clock through `createGovernor(config, clock?)` when
constructing its governor. Caps in `opts` without a handle throw. See
[`src/kernel/README.md`](src/kernel/README.md)
for the composition contract and `scripts/smoke-run-plan.mjs` for a worked
governed run.

## CLI (secondary)

One subcommand per registry entry, plus one per shipped plan, plus the built-in `run-plan`. Flags map onto the op's schema keys; output honors invariant I1 (`stdout` = one JSON artifact, `stderr` = `cq:` narration, machine mode with `--json`):

For direct ops, stdout = one JSON artifact: the OpResult, optionally with a `report` field carrying the op's run report on any status. Reports must be JSON-lossless; exit codes follow the result's status.

```sh
cq analyze.init --dir=.                   # writes cq.json
cq analyze.run --dir=. --json             # probe → collect → cluster → report
cq analyze.fix --dir=. --clusterId=<id>   # preview
cq analyze.fix --dir=. --clusterId=<id> --apply   # attended apply + recheck
```

`analyze.init` detects `tsc` (a `tsconfig.json`) and ESLint (a config file) checks. `analyze.run`
writes a Markdown report and its JSON sidecar under `.cq/analysis/` and returns the clusters.
`analyze.fix` needs the remediation: an ast-grep rule (`--rule='{"id":…,"language":"TypeScript","rule":{…},"fix":"…"}'`),
or `--model='{"provider":…,"model":…}'` to ask an agent for a patch; `--rule` with `--files='["src/a.ts"]'`
works without a cluster. Without `--apply` no project file is written (the report directory
`.cq/analysis/` may be created, and a `--model` preview stores its proposal there). An agent patch
is applied only in a second call that names its digest (`--previewDigest=<digest> --apply`). With `--apply` the work tree must be a
committed, clean git tree (only `.cq/` may differ — commit or stash anything else); the edit is
applied exactly as previewed (pass `--previewDigest=<digest>` from the preview to pin it), and the
configured checks are re-run to report the failure count before and after. The commands in
`cq.json` run with your privileges, like package.json scripts (as argv, never through a shell),
so review the file like code.

`cq.json` uses `schemaVersion: 2`. Upgrade a v1 file with
`cq analyze.init --dir=. --migrate`; this preserves its checks and argv and changes only
the version. Migration validates the result and replaces the file atomically; running
`--migrate` on a valid v2 file is a no-op. Reading v1 otherwise fails with the migration hint. `--force` regenerates
checks from detection; `--migrate` upgrades the existing file.
Policy options cannot accompany `--migrate`; a usage error names any supplied policy keys.

The v2 config also accepts `packages` (`name`, `path`), check `kind` (`tests` or `static`),
check `relatedArgs`, `roles` (`worker`, `rescue`, `reviewer`, each with `provider` and
`model`), `budgets`, `review`, and `escalation`. Unknown keys fail, including nested keys.
`relatedArgs` is the complete replacement argument vector for a related check: each
standalone `{files}` argument expands into individual file arguments; omitted means append
files to the configured command's args. The command executable stays the same.

`cq fix.run --source=static` groups diagnostics by repository-relative file and rule.
`--checks=tsc` selects a configured adapter family; `--checks='["tsc","eslint"]'`
selects several. Aliases are `tsc`, `eslint`, and `vitest`; unknown or unavailable
aliases refuse. Omit `--checks` to select every check of the requested source.
Static ESLint requires an explicit `relatedArgs` template with standalone `{files}`
before any worker runs. For `eslint . --format=json`, use
`["{files}","--format=json"]`; for `node scripts/lint.cjs .`, use
`["scripts/lint.cjs","{files}"]`. The replacement must name only task files,
while broader validation retains the full configured argv. Existing config remains
parseable without the template; invoking static ESLint reports an actionable refusal.
Templates retaining literal `.` or `./` operands also refuse before worker dispatch.
Other wrapper arguments and option semantics remain trusted configuration: the engine
does not parse arbitrary command grammars or prove that every configured target is scoped.
Static tsc always runs the full project check, allowing existing sibling clusters
while requiring the assigned cluster to disappear and failure fingerprints to improve.
When final related and broader commands are identical, both gates share one fresh
base-owned staged-tree probe. The stateless feedback invocation still runs per task.

`fix.run` retries a task with `roles.worker` up to `escalation.workerAttempts`
(default 2), then uses `roles.rescue`. A broader regression routes directly to rescue.
Each round uses separate stateless edit and related-check feedback invocations; feedback
is mandatory even when it only confirms the edit. Failed edits are pinned under unique
refs and restored before retrying. Protected-path, tamper, cancellation and budget refusals
retain their gates; retries never bypass validation. Exhausted or unavailable rescue sends
that task to human review while siblings continue committing verified fixes.

Every fresh run starts with `initialFixedFailures = 0` and the configured `rescueBase`
(default 20). It earns `floor(distinct newly verified failure reductions / rescuePerFixed)`
additional rescue attempts (default one per 10). Unresolved baseline failures earn nothing;
repeated sibling rows and feedback calls earn nothing. Fingerprint occurrence reductions
are credited once, only after commit verification. The pure SDK allocator can accept an
explicit initial fixed-failure count for deterministic allocation math; fix.run has no
historical state or input for that count. Run and per-package rescue reservations are
shared atomically across units; the package cap defaults to 10. Run tokens and wall time
are shared across every tier. Token limits remain landing gates for concurrently in-flight
calls: their usage is reported when they settle, and no new invocation starts after exhaustion.
Explicit parent cancellation prevents publication; a local budget stop may still publish
previously verified commits with `--push`. Reports retain decisions, reasons, model identity,
per-invocation tokens, wall time and available cost with its modeled/billed basis. Unknown
cost stays absent. Full JSON evidence is persisted on every exit.

`analyze.init` writes only the version and detected checks unless optional fields are
explicitly supplied as flags (for example `--budgets='{"run":{"maxTokens":100000}}'`).
No model is selected by the generated starter config. New agentic compositions use the
pure SDK helper `resolveCqConfigDefaults(config, { packageName, ...flags })`, with the
actual `package.json` name supplied by the caller. Flags override config field by field;
packages default to that name at `.` and check kinds default by adapter (`vitest-json`
means tests, the other adapters mean static).

Effective defaults are run/step wall budgets of 20 minutes, a unit wall budget of 60
minutes, 3 review rounds, blocking critical/major findings, agent high→major and
medium→minor, CodeRabbit then agent reviewers, address concurrency 2, bulk concurrency 3,
review session input of 60,000 characters and 15 reviewer steps, size tiers of 200 changed
lines/5 files (small) and 800 changed lines/20 files (medium, never below small), no review
exclusions, prior findings included on re-review, and escalation worker attempts 2, rescue
base 20, one rescue earned per 10 fixed failures,
per-package rescue cap 10. There is no token budget default:
`requireAgenticTokenBudget(policy)` returns a `needs-human` result naming
`budgets.run.maxTokens` when absent. Bulk query defaults are computed by the forge consumer
from the current user and repository at run time.

This repository's root config declares the compiler check as argv.
Lint is omitted: Oxlint 1.83 has no ESLint-format output; an `oxlint-json` adapter is a follow-up.
Tests are omitted until a config check can honour the `test:narrow` host-wide lock and file selection.
Consequently `cq analyze` / `analyze.run --dir=.`
here runs the compiler; local development still follows `pnpm test:narrow`
and the focused-check policy below. The root role choices are experiment configuration,
with no token budget baked in.

```sh
cq --help                                        # global help
cq analyze.run --help                            # per-op input schema
cq run-plan --plan=plan.json --json              # a governed plan
```

Exit codes: `0` clean, `1` thrown/definitive failure, `2` usage error, `3` needs-human or budget-exhausted. An `ok` result can still carry a failing verdict in its value (`{ "status": "ok", "value": { "verdict": "fail", … } }`), which exits `0` by default; pass `--fail-on-verdict` to turn that into exit `1` (stdout is unchanged; only the exact string `"fail"` counts — a `needs-human` or `failing` verdict vocabulary is not mapped). In `--json` mode an error writes one `{ "error": { "kind", "subcommand", "message", "exitCode" } }` object to stdout (stderr stays empty). CI gate: `cq ratchet.checkRatchet … --json --fail-on-verdict`. See [`src/cli/README.md`](src/cli/README.md) for the full CLI contract.

## Drivers

Drivers implement one seam (`Driver.run(opInvocation)`), so plans are transport-independent: each worker is a fresh isolated invocation, and vendor vocabulary never reaches the kernel or persisted data (I6, I10).

- `AiSdkDriver` — in-process provider drivers over the AI SDK (anthropic, openai, zai, deepseek), keys read from the environment at call time.
- `ClaudeCodeDriver` — runs the Claude Code substrate on the frozen seam with env-based model routing: the headless CLI over stdio (the primary transport) or the agent-SDK host (the optional `sdk` transport). The SDK package (`@anthropic-ai/claude-agent-sdk`) is an **optional peer dependency**: importing or building the toolkit never requires it, and the sdk transport loads it lazily at `run()` time. Install it only if you use that transport:

```sh
npm install @anthropic-ai/claude-agent-sdk
```

- `AcpDriver` — the Agent Client Protocol lane for operator-installed vendor harness binaries; no vendor package is bundled.

See [`src/driver/README.md`](src/driver/README.md) for the seam rules and the `.github/workflows/install-matrix.yml` workflow for the with-peer/without-peer proof.

## Doctrine (I1–I11)

The eleven behavioral invariants are canonical in
[policy/DOCTRINE.md](policy/DOCTRINE.md), each with its Rule, Why, and
Enforcement. In brief:

| #   | Invariant                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | stdout is JSON, stderr is narration; exit codes 0 clean, 1 thrown, 2 arg error, 3 needs-human/budget-exhausted                                                                                               |
| I2  | No-privileged-reviewer acceptance: a non-author review of the exact head, plus a ≥10-minute settle or a postdating all-clear; unresolved threads are reported (not blocking) and truncated data fails closed |
| I3  | Merge commits only; `merge-queue`→`main` promotion is a pure fast-forward behind merge-base guards — never squash, rewrite, or force-push                                                                    |
| I4  | Required checks never filter triggers; the only sanctioned skip is a job-level `if:`                                                                                                                         |
| I5  | Baselines only tighten; a missing metrics summary is non-passing evidence, never a pass                                                                                                                      |
| I6  | Every per-file/per-job worker is a fresh isolated invocation; context never leaks                                                                                                                            |
| I7  | A reused clean worktree re-probes its baselines from scratch; baseline values are never cached                                                                                                               |
| I8  | Rescue and escalation policy live in the plan runner, never in a driver                                                                                                                                      |
| I9  | Fleet runs collect everything and never bail mid-fleet; budget stops are honest (`budget-exhausted`, never fabricated)                                                                                       |
| I10 | The kernel stays vendor-neutral — no vendor SDK vocabulary in kernel types or persisted data                                                                                                                 |
| I11 | GitHub-API facts are carried as named tests beside the ops that rely on them                                                                                                                                 |

## Adopting the policy

The merge-queue and doctrine templates under [`policy/templates/`](policy/templates/)
are parameterized and adoptable by any repository: bootstrap the `merge-queue`
branch, gate promotion to `main`, keep the branches level, and ratchet
typecheck/coverage baselines. The adoption guide — placeholder tokens,
instantiation steps, and the three places a new required check must be
registered — is [policy/README.md](policy/README.md).

## Self-hosting

Stage 1 reached: CI runs the toolkit from source. The `from-source` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the package and drives a real governed plan through the built barrel (`scripts/smoke-run-plan.mjs` — two jobs, claude-code driver (CLI transport), journal + report + I1 output contract asserted), and the [pack audit](.github/workflows/pack-audit.yml) tarballs the package, asserts every shipped path hangs off the `files` allowlist, and denylist-scans the unpacked tree. The required `static` job regenerates the op reference and fails on drift, so `docs/ops/` cannot diverge from the registry.

## Local verification

The repository uses pnpm (pinned by `packageManager`). Its
`pnpm-workspace.yaml` turns on pnpm's global virtual store, so every
worktree links one shared, already-materialized dependency graph. CI opts
out with `PNPM_CONFIG_VIRTUAL_STORE_TYPE=project`.

Run `pnpm run check:static` for the TS7 compiler ratchet and typed Oxlint.
`pnpm run lint` and `pnpm run typecheck` are compatibility aliases; run only one.
Formatting is `pnpm run format:check`, the tests you need are the ones your diff
affects (`pnpm test:narrow`, the only local test command). **The full suite and
the build are not local gates**: `pnpm run build` (checked declaration emit) and
`pnpm run test` / `test:unit` run in CI, and green required CI on the exact candidate SHA is the
sole full-gate authority — see
[docs/focused-checks-contract.md](docs/focused-checks-contract.md). See
[the local static policy](lint/README.md)
for tool pins, architecture conformance and the integrated-checker fallback.

### Mechanical checks

`pnpm run check` is a composite of the whole-tree obligations (format check,
static gate, the full suite, Knip). **It is not a local verification route** —
its full-suite leg is CI's obligation, so it is CI-only. For local work use
the focused set in [docs/focused-checks-contract.md](docs/focused-checks-contract.md).
`lint` and
`typecheck` are compatibility aliases of `check:static`; run only one.
For an inner loop, pass explicit owned files to `pnpm lint:fast <file...>`
or `pnpm fix <file...>`. The latter applies safe lint fixes and formatting
of those files only; it runs no static gate, so run `pnpm run check:static` for
dependents. Build, smoke and denylist remain separate gates.
See [local static policy](lint/README.md) for pins, compiler fallback evidence,
rule decisions and compatibility changes.
