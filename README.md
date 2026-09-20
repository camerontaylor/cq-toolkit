@camerontaylor/cq-toolkit is a portable code-quality toolkit: a TypeScript SDK of atomic code-quality operations, a deterministic plan runner that composes those operations into reproducible execution plans, and adoptable merge-queue and doctrine policy templates that other repositories can take in whole or in part. It is greenfield and self-hosting — the toolkit's own quality gates run on the toolkit itself — and it is a work in progress.

The SDK is the primary interface; the CLI is a secondary interface over the same ops and plans, and no logic lives only in the CLI. Doctrine: see [policy/DOCTRINE.md](policy/DOCTRINE.md). Review protocol (two CodeRabbit CLI cycles before every PR): see [docs/coderabbit-review.md](docs/coderabbit-review.md). Generated per-op reference: see [docs/ops/](docs/ops/) (regenerate with `npm run gen:op-docs`).

## Install

The v1 library is not published to npm yet: `@camerontaylor/cq-toolkit@0.0.0` on the registry is a name reservation whose payload is LICENSE + README only. Until v1, install and build from source:

```sh
git clone https://github.com/camerontaylor/cq-toolkit
cd cq-toolkit
npm ci
npm run build
```

Once v1 ships, the install is the usual one:

```sh
npm install @camerontaylor/cq-toolkit
```

The package is ESM-only (`"type": "module"`); the CI matrix runs Node 24.

## SDK first

Every op is reachable from the package root, and the plan runner composes ops through the frozen kernel contracts. Discover the registry, then invoke an op through its entry:

```ts
import { getOp, listOps } from '@camerontaylor/cq-toolkit';

const names = (await listOps()).map((entry) => entry.name); // every registered op

const entry = await getOp('analyze.collectFailures');
if (entry === undefined) throw new Error('op not registered');

const op = await entry.importer(); // lazy: no op module loads before this
const result = await op({ sets: [] }); // OpResult — a status-tagged union
```

The runner is exported too: `runPlan(plan, opts, registry)` returns a
serializable `RunReport` (per-job outcomes, usage rollup, honest-stop counts);
its third argument is an `OpRegistryView`, and budget governance comes from
wrapping the run with `withBudgetStop`. See [`src/kernel/README.md`](src/kernel/README.md)
for the composition contract and `scripts/smoke-run-plan.mjs` for a worked
governed run.

## CLI (secondary)

One subcommand per registry entry, plus one per shipped plan, plus the built-in `run-plan`. Flags map onto the op's schema keys; output honors invariant I1 (`stdout` = one JSON artifact, `stderr` = `cq:` narration, machine mode with `--json`):

```sh
cq analyze.collectFailures --sets='[]' --json   # one op (schema-key flags; bare --json = machine mode)
cq --help                                        # global help
cq analyze.collectFailures --help                # per-op input schema
cq run-plan --plan=plan.json --json              # a governed plan
```

Exit codes: `0` clean, `1` thrown/definitive failure, `2` usage error, `3` needs-human or budget-exhausted. See [`src/cli/README.md`](src/cli/README.md) for the full CLI contract.

## Drivers

Drivers implement one seam (`Driver.run(opInvocation)`), so plans are transport-independent: each worker is a fresh isolated invocation, and vendor vocabulary never reaches the kernel or persisted data (I6, I10).

- `AiSdkDriver` — in-process provider drivers over the AI SDK (anthropic, openai, zai, deepseek), keys read from the environment at call time.
- `SubprocessDriver` — runs an operator-installed agent CLI headless over stdio, with env-based model routing.
- `ClaudeAgentDriver` — the `@anthropic-ai/claude-agent-sdk` lane. That package is an **optional peer dependency**: importing or building the toolkit never requires it, and the driver loads it lazily at `run()` time. Install it only if you use this lane:

```sh
npm install @anthropic-ai/claude-agent-sdk
```

- `AcpDriver` — the Agent Client Protocol lane for operator-installed vendor harness binaries; no vendor package is bundled.

See [`src/driver/README.md`](src/driver/README.md) for the seam rules and the `.github/workflows/install-matrix.yml` workflow for the with-peer/without-peer proof.

## Doctrine (I1–I11)

The eleven behavioral invariants are canonical in
[policy/DOCTRINE.md](policy/DOCTRINE.md), each with its Rule, Why, and
Enforcement. In brief:

| #   | Invariant                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | stdout is JSON, stderr is narration; exit codes 0 clean, 1 thrown, 2 arg error, 3 needs-human/budget-exhausted                                                                         |
| I2  | No-privileged-reviewer acceptance: a non-author review of the exact head, plus a ≥10-minute settle or a postdating all-clear; unresolved threads block and truncated data fails closed |
| I3  | Merge commits only; `merge-queue`→`main` promotion is a pure fast-forward behind merge-base guards — never squash, rewrite, or force-push                                              |
| I4  | Required checks never filter triggers; the only sanctioned skip is a job-level `if:`                                                                                                   |
| I5  | Baselines only tighten; a missing metrics summary is non-passing evidence, never a pass                                                                                                |
| I6  | Every per-file/per-job worker is a fresh isolated invocation; context never leaks                                                                                                      |
| I7  | A reused clean worktree re-probes its baselines from scratch; baseline values are never cached                                                                                         |
| I8  | Rescue and escalation policy live in the plan runner, never in a driver                                                                                                                |
| I9  | Fleet runs collect everything and never bail mid-fleet; budget stops are honest (`budget-exhausted`, never fabricated)                                                                 |
| I10 | The kernel stays vendor-neutral — no vendor SDK vocabulary in kernel types or persisted data                                                                                           |
| I11 | GitHub-API facts are carried as named tests beside the ops that rely on them                                                                                                           |

## Adopting the policy

The merge-queue and doctrine templates under [`policy/templates/`](policy/templates/)
are parameterized and adoptable by any repository: bootstrap the `merge-queue`
branch, gate promotion to `main`, keep the branches level, and ratchet
typecheck/coverage baselines. The adoption guide — placeholder tokens,
instantiation steps, and the three places a new required check must be
registered — is [policy/README.md](policy/README.md).

## Self-hosting

Stage 1 reached: CI runs the toolkit from source. The `from-source` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the package and drives a real governed plan through the built barrel (`scripts/smoke-run-plan.mjs` — two jobs, subprocess driver, journal + report + I1 output contract asserted), and the [pack audit](.github/workflows/pack-audit.yml) tarballs the package, asserts every shipped path hangs off the `files` allowlist, and denylist-scans the unpacked tree. The required `static` job regenerates the op reference and fails on drift, so `docs/ops/` cannot diverge from the registry. Run URLs: visible on the Actions tab after this merge.

## Local verification

Run `npm run check:static` for the TS7 compiler ratchet and typed Oxlint.
`npm run lint` and `npm run typecheck` are compatibility aliases; run only one.
Formatting is `npm run format:check`, runtime tests are `npm run test`, and
checked declaration emit is `npm run build`. See [the local static policy](lint/README.md)
for tool pins, architecture conformance and the integrated-checker fallback.

### Mechanical checks

Use `npm run check` for read-only formatting, static checks, tests and Knip. `lint` and
`typecheck` are compatibility aliases of `check:static`; run only one.
For an inner loop, pass explicit owned files to `npm run lint:fast -- <file...>`
or `npm run fix -- <file...>`. The latter applies safe lint fixes and formatting,
then checks the whole package. Build, smoke and denylist remain separate gates.
See [local static policy](lint/README.md) for pins, compiler fallback evidence,
rule decisions and compatibility changes.
