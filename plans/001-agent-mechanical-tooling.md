# Mechanical tooling for agent-authored changes

Status: implementation authorized by the user and completed across the six units, 2026-09-16. Evidence and deviations are recorded in `lint/README.md`. No PR has been opened; required pre-PR CodeRabbit cycles remain a separate obligation.

## Objective

Make incorrect assumptions cheap to detect and style cheap to normalize. Use a small, reproducible set of deterministic commands whose failures point at correctness or architectural problems. Do not adopt rules that ask an agent to rewrite equivalent expressions. The supporting research is an engineering hypothesis, not a controlled demonstration that particular lint rules improve agent success rates.

## Target toolchain

| Concern                            | Decision                                                                                         | Why                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Type checking (gate)               | Oxlint integrated typeCheck (tsgolint / typescript-go), pinned                                   | One static invocation; reuse the Go type-analysis path           |
| JS/declaration emit (build)        | Stable TypeScript 7 from the released `typescript` package, not a native-preview nightly, pinned | Retain declaration and build validation                          |
| Lint                               | Oxlint plus the matching oxlint-tsgolint, pinned                                                 | Fast native syntactic and typed rules                            |
| Architecture rules                 | Oxlint JavaScript plugin with conformance tests                                                  | Keep the two custom policies; drop the ESLint toolchain entirely |
| Formatting                         | Oxfmt, pinned                                                                                    | Mechanical normalization, no model-driven style edits            |
| Dead files/dependencies            | Knip, calibrated before gating                                                                   | Catch forgotten wiring without misclassifying SDK exports        |
| Workflow lint (separate follow-up) | actionlint, pinned binary                                                                        | Not a prerequisite for the core migration                        |
| Tests                              | Existing Vitest                                                                                  | Lint cannot establish runtime correctness                        |

Non-goals: Biome, an ESLint fallback lane, another package manager, a task orchestrator, a monorepo affected-project graph, React configuration, and a public Oxlint diagnostic adapter (a follow-up). Keep `npm ci` and the existing lockfile. Upstream speed reports are motivation, not a measured claim about this repo.

## Verified starting point

Inspected main at `492e7faf3d0e32720066f7584eb57f35ed3c0800`.

- Single npm package: NodeNext/ES2023 TypeScript SDK plus CLI, published declarations, CI on Node 24. `@types/node` is major 26.
- `package.json`: build and typecheck use `tsc6`; lint is ESLint 10 with untyped typescript-eslint 8 recommendations; tests are Vitest 5.
- `tsconfig.json`: strict, noEmit, skipLibCheck; includes `src`, `test`, `eslint/rules` and `vitest.config.ts`. Scripts are not linted; the TS config file is outside the TS lint pattern.
- `node scripts/ratchet-typecheck.mjs` is the authoritative type gate. It spawns tsc6, counts `error TS` lines against a zero baseline, fails closed on missing executables, abnormal exit and unparsable output, and refuses baseline increases. CI runs it and `npm run lint` as separate steps.
- `eslint/rules/` holds two custom rules (vendor-neutral kernel, CLI import boundaries) whose Vitest tests use ESLint RuleTester and the typescript-eslint parser.
- `src/ops/gates/adapters/eslint.ts` and `src/ops/ratchet/adapters/typecheckCount.ts` are public SDK adapters. They, their exports and their tests stay unchanged; this migration changes local tooling only.
- `src/ops/gates/hackDetector.ts` detects added ESLint/TypeScript suppressions. Extend it to `oxlint-disable`; keep existing detection.
- Workflows are instantiated from `policy/templates/`; edit templates and reinstantiate. Preserve required job names, the unfiltered trigger policy (I4), build, from-source smoke, denylist/self-test and packaging checks.

## The static gate

One invocation, `oxlint --type-aware --type-check` (or the equivalent `options.typeAware` and `options.typeCheck` config with explicit full-gate flags), runs syntactic rules, the architecture plugin, typed rules and compiler diagnostics over one root config. Oxlint documents this as a supported replacement for a separate `tsc --noEmit`. The build still emits with the pinned TS7; an ordinary emit build also checks types, but it is not a second ratchet.

The ratchet contract is preserved while its diagnostic producer changes:

- Parse a documented structured Oxlint output format. Classify compiler diagnostics separately from lint diagnostics: only compiler diagnostics are compared with the type baseline, and any enabled lint error fails on its own. Do not reuse the `error TS` regex for the new format. The public tsc-format adapter is untouched.
- Missing executables, crashes, malformed or truncated output, unknown diagnostic categories and configuration or project-loading errors fail; they never count as zero. `--update` cannot raise the baseline or mask lint or tool failures.
- Keep the existing fake-tool failure tests and add real combined-tool fixtures. An isolated project with known compiler errors must produce the expected nonzero count and fail against a zero baseline; its repaired counterpart must pass. Fake-tool tests alone cannot validate a producer migration.

Tool identity: the gate's checker is tsgolint's bundled typescript-go, not the workspace `tsc`. Do not assume the two share a revision. Record the pinned checker revision and supported tsconfig options, and repeat the conformance evidence on relevant upgrades. A type-grounded build failure after a green gate is a checker-divergence signal: minimize the case and compare pinned versions and configuration before touching source, and never disable build checking. Both gate and build must pass. A green compiler does not invalidate a stricter lint finding; for genuinely contradictory type facts, fix the source bug or narrowly document a confirmed analyzer limitation rather than automatically preferring either tool.

Fallback: if preflight shows the integrated gate cannot meet this contract, keep the direct TS7 `--noEmit` ratchet and typed Oxlint as separate steps, with the demonstrated gap documented. That is one compiler ratchet plus lint, never two compiler ratchets, and not a default merely because the old command existed.

TypeScript 7: before switching, establish compatibility with Node 24, NodeNext resolution, declaration emit, Vitest and config tooling, the ratchet parser and any consumer of the programmatic TypeScript API. If a tool still needs the legacy JS compiler API, keep an isolated, documented TS6 dependency only if necessary; it must not become the authoritative compiler. Align the `@types/node` major with the supported runtime (CI Node 24) unless a documented multi-version policy says otherwise; the current mismatch can admit APIs unavailable at runtime.

## Compiler flags

Keep `strict`. Add `noImplicitOverride`, `noFallthroughCasesInSwitch` and `noImplicitReturns`, then `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `useUnknownInCatchVariables` already follows from strict. Keep `skipLibCheck` for now; dependency declaration validation is a separate concern.

These flags expose missing collection elements, absence versus explicit undefined, inheritance drift and incomplete control flow. Repair findings with narrowing, correct optional construction and complete branches. Do not use casts, postfix assertions, broad `undefined` unions or baseline growth to get green. Runtime validation stays at untrusted-input boundaries.

## Lint rule policy

Explicit reviewed rules, each `error` or `off`; no wholesale presets and no inherited warning category. Use the Oxlint correctness recommendations as an inventory, select the effective error rules, disable overlap the compiler or formatter handles better, and give each gate a one-line correctness rationale. Repair new findings before gating; warnings are not a permanent migration state.

Typed `typescript/` rules (confirm names and options against the pinned release):

- Async: `no-floating-promises` with `ignoreVoid: false`, `no-misused-promises`, `await-thenable`. `void promise` is not an escape hatch. Keep promise-returning callbacks checked; scope exceptions to demonstrated synchronous API contracts rather than a blanket `checksVoidReturn: false`. Deliberate background work needs an explicit rejection-handling contract: await, return to an accountable caller, or a rejection handler the rule recognizes. Do not replace bare `void` with disable comments; add a helper or custom rule only for a real recurring case. Lint acceptance does not prove the handler itself cannot fail.
- Type holes: `no-explicit-any`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`. Use `unknown` and validate at boundaries. Apply to tests too, after a one-time classification of test findings: fix accidental unsafe flows, keep intentional malformed-input construction at narrow documented fixture boundaries (a small helper only where it reduces duplication), and record any fixture-family exception before activation. No blanket test-directory exemption, no suppression spray.
- State space: `switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: false` and `allowDefaultCaseForExhaustiveSwitch: true`. A defensive default is allowed where runtime input can violate static types; it must not hide a missing union member. This covers `switch` only; use `never`-based compiler checks for if/else or lookup-table exhaustiveness.
- Suspicious logic: run `no-unnecessary-condition` as a one-time migration report after the runtime-type alignment and stricter flags. Classify findings as real assumption errors, legitimate trust-boundary checks or analyzer limitations. Enable it only for scopes where correct code stays naturally expressible without widespread suppressions or removed runtime validation; otherwise leave it off and record why. No finding-count ratio decides this.

Initially off: `strict-boolean-expressions`, `no-unsafe-type-assertion`, blanket postfix-non-null bans, explicit return and module-boundary types (public SDK contracts may have intentional signatures), `consistent-type-definitions`, member ordering, sorting, complexity/length/parameter limits, and any preference rule requiring an equivalent rewrite. Potentially semantic rewrites such as `||` to `??` are never unattended fixes.

Fixes and formatting are distinct. Oxfmt owns layout; only reviewed safe lint fixes belong in the fix command, never dangerous or suggestion fixes, and semantic checks run after any fix. Suppressions stay narrow with reasons; flag unused directives where supported. A suppression reason is review context, not proof that bypassing the rule is safe.

## Custom rule conversion

Create `.oxlintrc.json`, `lint/plugin.mjs` and `lint/rules/`; move the implementations, declarations and tests out of `eslint/rules/` and update tsconfig inclusion. Use the ESLint-compatible `create(context)` plugin API without an unrelated optimization rewrite. JavaScript plugin support is alpha: pin versions and use the conformance suite as the upgrade gate. If a required visitor or behavior cannot be made equivalent, stop and report the specific incompatibility; never drop an invariant silently or call the migration complete with an unplanned ESLint lane.

Port the complete valid/invalid corpus with `RuleTester` from `oxlint/plugins-dev`, wired to Vitest and TypeScript parsing via `languageOptions.parserOptions.lang`; remove the ESLint RuleTester and typescript-eslint parser imports. Oxlint columns are zero-based: assert message identity, count and line, and assert columns only where the location is material. Coordinate conversion must not hide a behavior change.

Preserve both policies exactly, with the existing corpus, options, scope and exclusions as the specification:

- Vendor SDK bans in `src/kernel/**` and `src/driver/types.ts` across static, dynamic-literal, re-export, import-equals and supported `require` forms. The current rule does not fail closed for all computed sources; do not claim otherwise. Strengthening that gap (for example a TS import-type case) is documented changed behavior.
- CLI boundaries: `src/cli.ts` may enter the CLI layer; CLI modules may import CLI, registry and kernel; Node builtins are allowed; zod only in the configured run-plan file. Keep path normalization (Windows separators, relative traversal, segment boundaries), rejection of computed sources and import-type handling. Include Windows-path unit cases and real supported-platform runs where available.

Add CLI-level fixture tests that run the pinned Oxlint with the real config and plugin in isolated temporary project roots: config and plugin at their original relative paths, mirrored `src/kernel`, `src/driver` and `src/cli` trees, the minimal project configuration the tested mode needs, and an explicitly resolved executable. Do not rewrite production scope patterns for the fixture. Cover an allowed import, each banned boundary, the zod exception, computed CLI imports, and plugin-load or config failure. This proves enforcement is active, which unit tests cannot.

Scope: lint maintained `src`, `test`, TS config files and maintained JS/MJS scripts with appropriate Node environments; exclude only generated outputs and intentional invalid fixture data. Do not apply typed rules to unprojected JS. Verify file discovery, not merely a green run.

Parity before removal: capture ESLint and Oxlint diagnostics plus an effective-rule mapping and adjudicate expected removals, additions and mismatches. Zero/zero on a clean repo is not parity; the negative corpus and CLI fixtures are. Inventory every active suppression and its disposition (comments versus literal test data) and check the pinned Oxlint's ESLint-comment compatibility. Record a residue scan of manifests, configs, executable imports and local rule tests, distinguishing legitimate public-adapter and documentation fixtures; do not add a permanent regex ban on the string "ESLint", which stays part of the product. Translate the `no-control-regex` suppression in `typecheckCount.ts` if that rule stays on. Then remove `eslint.config.js`, the eslint, @eslint/js and typescript-eslint dev dependencies, and obsolete paths.

Self-hosted consumers: preflight must check whether any self-hosted lint consumer requires eslint-json output. If so, that is a blocker until replaced. If they consume only exit status, document that local gating remains self-hosted and normalized Oxlint ingestion is a follow-up. Never feed Oxlint JSON to the ESLint adapter without verified format compatibility.

## Command contract

- `npm run check:static`: the authoritative read-only wrapper (the ratchet script) running the integrated Oxlint gate once and enforcing the type baseline.
- `npm run lint` and `npm run typecheck`: compatibility aliases for `check:static` once PR 3 lands; either one validates the whole static gate. Never invoke both in an aggregate or CI job.
- `npm run lint:fast -- <file...>`: syntactic lint over an explicit file list, using the same root config with CLI flags that disable typeAware and typeCheck. Verify those flags in preflight; if unsupported, redesign the command rather than duplicating policy. Paired fixtures must show a typed-only and a compiler-only violation failing the full gate but not fast lint, and a syntactic violation failing both. That proves diagnostic behavior only; verify that fast mode does not start the type checker with a temporary failing or counting shim at the tsgolint launch point, or equivalent process tracing.
- `npm run fix -- <file...>`: `scripts/fix.mjs` spawns approved safe lint fixes and then Oxfmt write over an explicit owned-file list passed as an argv array, since npm cannot forward one list to both halves of a compound script. Handle spaces and deletions; reject an empty list. Whole-repo formatting is a separate one-time operation, never an automatic per-turn rewrite or a rewrite in shared worker workspaces.
- `npm run format:check`: Oxfmt check, read-only.
- `npm run check`: format check, `check:static` once, tests, and calibrated Knip and actionlint once activated. Nonzero exits and actionable file/rule diagnostics; no truncation that could hide a failure.

Inner loop: fast lint and formatting over owned changed files, targeted tests, then the package typecheck when relevant. Linting only changed files never proves correctness because dependents can break; this is one package, so affected-package checking is the whole package. Pre-review loop: `check:static`, tests, format check, build, smoke, denylist/self-test and any activated gates, all non-mutating to tracked source (build and smoke may write their ignored outputs). Formatting happens before those checks, not by asking an agent to repair commas. No mandatory commit hooks; CI remains authoritative.

Record a simple before/after wall-clock comparison on one machine for the full gate and fast lint. Investigate a material regression; do not build a benchmark harness. The two-loop split is a workflow decision, not a speed claim.

## Secondary checks

Oxfmt: conservative existing-style options (single quotes and semicolons if confirmed against the source); no import, package or object reordering. Exclude `dist`, coverage, generated fixture artifacts and instantiated workflow YAML, since templates are the source. The one-time reflow is a separate commit from any semantic change.

Knip: model actual SDK/CLI entries, package exports, scripts, tests, dynamically loaded registry/provider paths and the lint plugin. Investigate before deleting; public exports are intentional entry points. Gate unused files, dependencies and unresolved imports only after a clean calibrated run; add export analysis only where internal usage is accurately modeled. Verify in an isolated fixture that an unreferenced file is reported, so entry configuration cannot quietly include everything. No broad ignore lists.

Actionlint (separate follow-up): pinned binary with per-platform checksums (local macOS, CI Linux), a documented installation path, and no unpinned download during a check; a missing tool fails with an installation instruction. Decide ShellCheck integration explicitly and provision it consistently, never by incidental PATH contents. Run on instantiated workflows; template placeholders are not valid input, so fix templates and reinstantiate, preserving required check names and triggers.

## Preflight

Before any implementation PR, record:

1. Current mandatory gate results.
2. TS7 compatibility: Node 24, NodeNext, declaration emit, Vitest and config tooling, the ratchet parser, programmatic API consumers, and whether any tool still needs the legacy compiler API.
3. Integrated typeCheck conformance: coverage of every tsconfig input, including files outside ordinary lint traversal, imported dependencies, config files and applicable declarations; compiler-option and module-resolution failures surfaced; suppressions cannot exempt compiler errors the old ratchet caught; output schema, diagnostic categories, known counts, zero-result success and process-failure behavior; diagnostics compared with standalone TS7 on a focused known-error corpus under this repo's settings. This is migration evidence, not a permanent second check. Decide integrated mode or the fallback here, before PR 3 review.
4. Declaration compatibility: emit gate-accepted public-API fixtures with the TS7 build, compare with the reviewed pre-migration contract, and compile consumer fixtures. Oxlint emits no declarations, so this compares against the intended contract, not an Oxlint-versus-tsc diff.
5. An isolated plugin spike proving the critical custom-rule AST visitors.
6. Oxfmt option verification and a review of the proposed reflow for semantic or ordering changes.
7. An inventory of every typecheck-command reference (plan fixtures, smoke plans, templates, docs), every active suppression, and every self-hosted lint adapter consumer.
8. In a disposable copy, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` individually and together: diagnostic and affected-file counts, then discard the probe.
9. Fast-mode flag support and the tsgolint startup check.

Use these facts to fix PR boundaries before any review begins. Record the rule mapping, tool pins, baseline evidence and scoped decisions in PR descriptions; no new reporting subsystem.

## Implementation sequence

Six default units, in order. Each is independently green, reviewed per docs/coderabbit-review.md, wired through canonical templates and reinstantiated workflows in the PR that introduces it, and a complete rollback unit: revert its source, config, dependency and template changes together, and never recover by weakening baselines or dropping architecture enforcement. If preflight shows PR 3 or PR 4 is too large, split runtime alignment or either high-volume flag into its own unit before reviews begin; do not split trivial flags merely to add process.

1. **Formatting foundation.** Add Oxfmt and `format:check`, then a separate mechanical reflow commit before semantic repairs begin. Verify a second run is idempotent and existing gates pass.
2. **Syntactic Oxlint conversion.** Port both custom rules, tests and CLI fixtures; cover scripts and configs; extend suppression detection; adjudicate the rule map and diagnostic deltas; supply the residue scan and enforcement evidence; remove local ESLint config and dependencies. Typed mode stays off. The public ESLint adapter stays.
3. **Runtime types and native compiler.** Commit 1: align `@types/node` with the runtime and fix real incompatibilities. Commit 2: switch the build compiler and the ratchet's diagnostic producer atomically, enable integrated typechecking after the conformance tests (or land the documented fallback), establish `check:static` and its aliases, update every typecheck reference and instruction including AGENTS.md, and remove the duplicate lint/typecheck steps from the instantiated CI job. No new strictness flags. Verify each commit independently, plus executable ownership after a fresh `npm ci`, emitted declarations, tests, build, smoke and real diagnostic counting.
4. **Compiler correctness flags.** `noImplicitOverride`, `noFallthroughCasesInSwitch` and `noImplicitReturns`, then `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, in separate commits with meaningful repairs. The last two carry the largest likely diff. Review absence-versus-undefined behavior and published declaration changes explicitly; repairs must reflect intended API semantics. Zero baseline throughout.
5. **Typed correctness and agent commands.** Enable the async, unsafe-flow and exhaustive-switch rules under the final compiler settings; classify test findings and `no-unnecessary-condition` as above. Add `fix`, `lint:fast` and `check`; validate representative negative cases and full-versus-fast differences. Finish the agent and docs command contract.
6. **Calibrated Knip.** Model entry points, fix genuine findings, add the negative fixture, and wire the clean check into the existing CI job. Record the final local/CI command mapping and the timing comparison.

Local `check` runs the same underlying scripts as CI, not necessarily the same aggregate entry. After template changes, inspect the instantiated static job to confirm the combined gate runs once with no second alias or direct noEmit step; this is focused migration acceptance, not a workflow-counting framework. Build, smoke, denylist and packaging keep their existing owners.

Likely paths: package.json and lockfile, tsconfig*.json, eslint.config.js (deleted), eslint/rules (moved to lint/), .oxlintrc.json, Oxfmt config, scripts/ratchet-typecheck.mjs, test/scripts/ratchet-baseline.test.ts, the suppression detector and its tests, script and config coverage fixtures, AGENTS.md, README.md, policy templates and generated workflows. Strictness repairs touch whatever the diagnostics name, not guessed files.

## Acceptance and stop conditions

Done means: all mandatory gates pass at a zero type baseline; both architecture policies demonstrably fire under the real Oxlint CLI; typed rules catch representative async, any and exhaustiveness mistakes; maintained files are discovered; formatting is deterministic; package exports, declarations and CLI still work; CI and local verification use the same pinned gate commands. Add focused negative fixtures for each new enforcement and ratchet failure, not tests mirroring every config line.

Stop and revise the plan on: unsupported plugin semantics, native compiler or API incompatibility, unexplained public declaration changes, or a gate that is green because files were omitted. Never raise baselines, disable established invariants, remove valid runtime validation or add broad suppressions to finish.

The review protocol in AGENTS.md and docs/coderabbit-review.md applies to every PR; the Opus consultation does not substitute for it. No PR or ready-to-merge claim is part of this planning task.

## Alternatives considered

- Keep ESLint for the custom rules: lower migration risk, but retains two engines and two test stacks and contradicts the requested complete conversion. Rejected.
- Biome plus ESLint or typed lint: overlapping ownership and the same custom-rule question. Rejected.
- Separate TS7 `--noEmit` plus Oxlint: the documented fallback only, since Oxlint supports integrated typechecking. The ratchet contract holds regardless of which executable supplies diagnostics.
- Maximal strict/stylistic presets: forces equivalent rewrites and unstable rule drift. Rejected in favor of a pinned explicit semantic policy.

Consequences: stricter settings will require real source repairs; Oxc plugin upgrades need the conformance suite; the native compiler needs the preflight. In return: one lint engine, automated style, executable architectural context and clear failure ownership.

## Sources

Official documentation, checked during planning:

- [TypeScript 7 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) and [compiler options](https://www.typescriptlang.org/tsconfig/).
- [Oxlint typed linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html), [JavaScript plugins and stability](https://oxc.rs/docs/guide/usage/linter/js-plugins.html), [plugin testing](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html).
- [Floating promises](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html), [exhaustive switches](https://oxc.rs/docs/guide/usage/linter/rules/typescript/switch-exhaustiveness-check), [unnecessary conditions](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition).
- [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html), [Knip setup](https://knip.dev/overview/getting-started), [actionlint](https://github.com/rhysd/actionlint).

## Consultation record

Paseo agent `891e4e11-ec1d-4927-bb14-05602288051e`, model `claude-opus-5`, thinking `max`, plan mode. Analysis-only from supplied facts and the official documentation above; no repository or web lookups.

- Round 1: ITERATE on sequencing and evidence; the tooling choice and the semantic-versus-stylistic policy were supported. Adopted: formatter first, syntactic migration before typed enforcement, a compiler/runtime compatibility stage, real-compiler negative tests, isolated production-config fixtures, a suppression inventory, explicit PR boundaries, missing-tool failures and simple measurements.
- Round 2: approved eight adjudications (ignoreVoid false; a green compiler does not overrule stricter lint; parity via the corpus, not empty snapshots; no ESLint-string denylist or assertion-count proxy; no numeric cutoffs for suspicious-condition or test findings; six default PRs with evidence-driven splitting), conditional on the isolated strict-flag probes and moving every typecheck-reference change atomically into PR 3. Both are incorporated.
- Round 3: approved integrated Oxlint typechecking as the ratchet's producer, requiring the build-divergence policy and declaration-comparison evidence. Both are incorporated, with the explicit preflight go/no-go and the single-CI-gate check.

Consensus: one Oxlint-backed compiler-and-lint gate, the zero baseline and fail-closed contract preserved, TS7 for builds, and separate compiler checking only for a demonstrated gap. This approves the plan, not unperformed tests, code changes or a merge-ready claim.

## Implementation record

- Formatting, syntactic Oxlint conversion, Node 24 declarations, native TS7,
  stricter compiler flags, typed lint/agent commands and calibrated Knip are
  implemented in separate commits; formatting has its own mechanical commit.
- The real integrated-checker fixture demonstrated omitted tsconfig inputs.
  Applied the explicitly authorized fallback: direct TS7 compiler ratchet plus
  typed Oxlint in one wrapper. The baseline remains zero. Gate and build use
  TS7; no legacy compiler lane remains.
- Fast mode opts into neither typed flag because this pinned CLI cannot negate
  `--type-aware` with `=false`. Real diagnostic pairs and a failing checker shim
  establish the mode separation without duplicating rule policy.
- Exact optional schemas intentionally reject explicit undefined where SDK
  interfaces require absence. JSON inputs are unchanged. Declaration differences
  include `ZodExactOptional` in kernel and ledger schemas and async cancellation
  return types in `JobCancelPort`; other observed barrel changes are formatting.
- `no-unnecessary-condition` stays off after classifying the report; trust-boundary
  and callback-state checks are retained. Narrow public-adapter preservation
  exceptions and test matcher boundaries are documented in the local policy.
- CI's static job runs static, format, test, Knip and build once each; its name
  and triggers, companion smoke job, denylist and packaging workflows remain.
- Architecture corpus, real CLI fixtures, fail-closed ratchet tests, typed/fast
  fixtures, owned-file command tests and the unwired-file Knip fixture provide
  enforcement evidence. Same-machine timing is recorded in `lint/README.md`.
- Actionlint remains the separate follow-up specified above. These commits are
  implementation evidence, not a claim of completed CodeRabbit review or merge
  readiness; the two-cycle protocol applies before any PR.
