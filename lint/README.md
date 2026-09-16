# Local static policy

The pinned configuration in `.oxlintrc.json` uses explicit error rules, with the
correctness category disabled. No preset can silently add warnings on upgrade.
`lint/plugin.mjs` supplies the existing CLI and vendor boundary implementations.
Their complete RuleTester corpus and `test/scripts/oxlint-boundaries.test.ts`
are the plugin upgrade gate; JavaScript plugins remain upstream alpha software.

## Syntactic rule mapping

The former ESLint recommendations were an inventory, not a policy to inherit.
These groups explain the enabled rules in the root configuration:

| Rules                                                                                                                                                                                                                         | Correctness purpose                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `for-direction`, `no-constant-condition`, `no-constant-binary-expression`, `no-cond-assign`                                                                                                                                   | Detect accidental loops and conditions that cannot behave as written. |
| `no-async-promise-executor`                                                                                                                                                                                                   | Prevent promise executors from losing async rejections.               |
| `no-case-declarations`, `no-fallthrough`, `no-dupe-else-if`, `no-duplicate-case`                                                                                                                                              | Detect ambiguous or unreachable branch behavior.                      |
| `no-compare-neg-zero`, `use-isnan`, `valid-typeof`, `no-loss-of-precision`                                                                                                                                                    | Reject comparisons and numeric literals with misleading semantics.    |
| `no-control-regex`, `no-invalid-regexp`, `no-empty-character-class`, `no-misleading-character-class`, `no-regex-spaces`, `no-useless-backreference`                                                                           | Catch regular expressions that cannot match as intended.              |
| `no-empty`, `no-empty-pattern`, `no-empty-static-block`, `no-debugger`                                                                                                                                                        | Catch unfinished code and accidentally discarded values.              |
| `no-ex-assign`, `no-global-assign`, `no-self-assign`, `no-shadow-restricted-names`                                                                                                                                            | Prevent destructive or ineffective assignments.                       |
| `no-irregular-whitespace`, `no-nonoctal-decimal-escape`, `no-unexpected-multiline`                                                                                                                                            | Detect misleading source parsing.                                     |
| `no-prototype-builtins`, `no-sparse-arrays`, `no-unsafe-finally`, `no-unsafe-optional-chaining`                                                                                                                               | Catch unsafe runtime assumptions and masked failures.                 |
| `no-unused-labels`, `no-unused-private-class-members`, `no-unused-vars`, `no-useless-catch`, `require-yield`                                                                                                                  | Detect disconnected work and misleading control flow.                 |
| `typescript/ban-ts-comment`, `typescript/no-explicit-any`                                                                                                                                                                     | Protect the compiler's evidence from unaccountable bypasses.          |
| `typescript/no-duplicate-enum-values`, `typescript/no-empty-object-type`, `typescript/no-misused-new`, `typescript/no-unsafe-declaration-merging`, `typescript/no-unsafe-function-type`, `typescript/no-wrapper-object-types` | Reject misleading type contracts.                                     |
| `typescript/no-extra-non-null-assertion`, `typescript/no-non-null-asserted-optional-chain`, `typescript/no-unnecessary-type-constraint`                                                                                       | Catch assertions or constraints that provide false confidence.        |
| `typescript/no-this-alias`, `typescript/no-unused-expressions`                                                                                                                                                                | Catch disconnected expressions and confusing object context.          |
| `cq/no-vendor-sdk-in-kernel`, `cq/no-cli-beyond-registry-kernel`                                                                                                                                                              | Preserve doctrine I10 and I1 at their original production scopes.     |

Compiler-owned errors (duplicate bindings, invalid constructors, undefined names
in TypeScript, illegal assignments, and unreachable statements) stay with the
compiler. `no-octal` is unsupported by Oxlint; module parsing rejects legacy octal
syntax. Equivalent-expression preferences (`prefer-const`, spread/rest,
`prefer-as-const`, namespace spelling, extra boolean casts and useless escapes)
are intentionally absent, as are blanket namespace/require prohibitions.
The compiler and Oxfmt own TypeScript syntax and layout. Unprojected JS/MJS keeps the available compiler-equivalent checks in a separate file override (undefined names, illegal assignments, duplicate members, constructor order and unreachable code). Maintained MJS files newly receive
the syntactic policy; typed rules apply only to projected TypeScript files.

Parity evidence on Node 24/macOS: all original 42 architecture cases pass after
porting. The malformed import-type fixture alone allows parser recovery; valid
production code does not. Four Windows-filename cases and real CLI fixtures test
normalization, scope, the zod exception, computed sources and plugin failures.
Oxlint's extra optional-chain findings exposed unchecked fixture dereferences;
these now assert the intended result or explicitly establish the target exists.
One unused probe timestamp was removed. No boundary was weakened.

The existing ESLint `no-control-regex` directive in the public tsc-output adapter
is recognized by Oxlint and retained; all other ESLint suppression mentions are
literal fixtures or documentation. The hack detector recognizes both directive
families. Public ESLint JSON and tsc-output adapters and their exports remain
supported. No local lint consumer depends on ESLint JSON: the self-hosted gate
uses exit status, and normalized Oxlint ingestion remains a separate feature.

## Compiler fallback and upgrade evidence

`check:static` runs the pinned TS7 `tsc --noEmit` ratchet and then Oxlint
`--type-aware`, once each. `lint` and `typecheck` are aliases. CI invokes only
`check:static`; checked declaration emit remains `build`.

On 2026-09-16, Oxlint 1.83.0 with oxlint-tsgolint 7.0.2001 reported green when
an erroneous `tsconfig` input was excluded from lint traversal, while TS7 7.0.2
reported TS2322. `static-conformance.test.ts` retains that counterexample and
proves the wrapper catches projected sources, imported files, the TS config
module, and included files outside traversal. This is why integrated
`--type-check` is not the authoritative compiler. Suppressions cannot remove
compiler evidence. Fake process failures and real module/configuration errors
also fail closed, including under `--update`.

The standalone compiler is TypeScript 7.0.2 (package gitHead
`2bd066d87f5bafd315be9f40889d0a60b9e58e0b`). The typed linter is
oxlint-tsgolint 7.0.2001; its [release go.mod](https://github.com/oxc-project/tsgolint/blob/v7.0.2001/go.mod)
references typescript-go `v0.0.0-20260708042240-2bd066d87f5b` and uses local
shim replacements. Matching source revisions do not establish identical
file discovery or configuration behavior. Repeat conformance on upgrades.
The gate exercises strict, NodeNext module/resolution, ES2023, noEmit and
skipLibCheck; build exercises checked JS and declaration emit. A type-grounded
build failure after a green gate is a divergence to minimize, never a reason
to disable build checking.

Compatibility preflight used Node 24.21.0 on macOS. TS7 checked the existing
project and emitted the complete package. Comparing its emit with TS6 found
identical JavaScript and three declaration files differing only in quote
style/member order. Vitest and its config work without a legacy compiler API;
no repository source, test or maintained script imports that API. A fresh `npm ci` confirmed the `tsc` executable belongs to TypeScript 7.0.2; the emitted SDK compiled in an external strict NodeNext consumer fixture. Runtime types
are pinned to Node 24.13.5. The public ESLint and tsc adapters retain their
formats and exports.

Before strictness repairs, disposable TS7 probes found:

| Flag                         | Diagnostics | Affected files |
| ---------------------------- | ----------: | -------------: |
| `noUncheckedIndexedAccess`   |          58 |             19 |
| `exactOptionalPropertyTypes` |          80 |             26 |
| both                         |         137 |             40 |

Each high-volume flag is its own implementation commit. Baselines remain zero.

## Exact optional properties

The indexed-access and exact-optional stages preserve the zero baseline. Optional
values are now omitted when absent instead of constructing present `undefined`
properties. Schemas annotated with SDK interfaces use Zod `exactOptional()` to
match those interfaces: omission is accepted, explicit `undefined` is rejected.
This tightens the JavaScript schema boundary; JSON inputs are unchanged because
JSON has no undefined value. The intentionally unknown structured output retains
its original optional semantics. Budget and plan tests pin omission, undefined
and valid falsy values. Malformed ledger fixtures cross the JavaScript boundary
with Reflect.apply instead of pretending invalid input satisfies the interface.

Validation: 1,378 tests passed (four skipped, one todo), using one Vitest worker;
static gate, formatting, declaration emit and an external strict NodeNext consumer
passed. Published declarations are compared with the native-compiler snapshot.

## Typed policy and fixture classification

| Rule                                                                                                          | Correctness purpose                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `no-floating-promises` (`ignoreVoid: false`)                                                                  | Every promise has an accountable caller or rejection handler.                       |
| `no-misused-promises`                                                                                         | A synchronous callback contract cannot silently discard async failures.             |
| `await-thenable`                                                                                              | Awaited values actually represent asynchronous work.                                |
| `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return` | Prevent `any` from bypassing validation and typed contracts.                        |
| `switch-exhaustiveness-check`                                                                                 | All known union cases appear explicitly; a defensive default cannot hide omissions. |

The one-time probe found 161 typed diagnostics. Most test assignments were Vitest
asymmetric expectation data: `test/helpers/matchers.ts` exposes those values as
`unknown`, without weakening application types or exempting tests. Typed mock
signatures replace erased mock call contracts. The standalone selection helper
has a `.d.mts` contract instead of a TS7016 suppression. A promise-returning
`finally` fixture now uses explicit awaited try/finally cleanup (the pinned
standard library declares that callback as returning void).

Two preservation exceptions apply to newly enabled rules only:

- `src/ops/gates/adapters/eslint.ts`: unsafe assignment/member access remain off.
  The plan freezes this public compatibility adapter; its existing JSON shape,
  severity and field validation and its negative corpus remain unchanged.
  `Array.isArray` introduces the `any[]` that triggers these two rules.
- `test/ops/gates/adapters.test.ts`: unsafe assignment remains off for its Vitest
  asymmetric matcher, preserving the frozen public-adapter test corpus.

Other typed rules still apply to these files. There is no test-directory waiver.
The governor's private worker guard now exposes only the usage/cost projection
it validates and consumes, retaining its existing denial-array and stop-reason
checks. `JobCancelPort` declares `void | Promise<void>`, matching its documented,
already-tested async rejection handling. ACP exit processing and cancellation
termination now attach rejection handlers with connection/narration evidence.

The one-time `no-unnecessary-condition` report produced 47 findings:

- Runtime trust checks: CLI status fallback and schema shapes; registry entries;
  JSON serialization/constructors; SDK usage and ACP wire/process inputs;
  adapter directions and ratchet inputs/upsert results. Keep these checks.
- Callback-sensitive state: governor re-marking, subprocess termination, ACP
  abort/handshake/prompt flags, and the virtual-clock fixture. Removing these
  conditions would break concurrency behavior the analyzer cannot establish.
- Harmless redundancy: governor usage checks, the single-member exhaustive
  responder switch, direction presence after narrowing, optional test probes
  and spawned-output fallbacks. These do not represent assumption bugs and
  do not justify equivalent-expression cleanup.

Leave the rule off: current scopes mix runtime boundaries and mutable callback
state with ordinary code. No runtime validation was removed to satisfy it.
Unused disable directives are errors in the full gate; fast mode omits that
check because typed rules intentionally do not run there.

## Agent command contract

`lint:fast -- <file...>` uses the root config without type analysis. The pinned
CLI cannot negate `--type-aware` with `=false`, so typed mode is opt-in in the
full wrapper, never enabled in config. Both modes disable nested configs.
Real fixtures demonstrate compiler-only, typed-only and shared syntactic
failures. An executable failing shim at `OXLINT_TSGOLINT_PATH` is started by full
mode and untouched by fast mode (POSIX fixture; Windows not exercised locally).

`fix -- <file...>` validates the complete list before writes, runs safe Oxlint
`--fix` (no suggestions/dangerous fixes), formats the same files with Oxfmt,
then runs the whole static gate. Paths are argv entries, never shell fragments;
spaces and metacharacters remain literal. Empty lists, directories, file symlinks,
repository escapes and tooling metadata are rejected; deleted files are skipped.
An all-deleted fix still checks the package. Checks never format tracked files.
`check` runs format, the static gate once, tests and Knip; CI uses the same scripts.

## Calibrated unused-code gate

Knip 6.35.1 checks files, dependencies, unlisted dependencies and unresolved
imports; export analysis is intentionally not gated. The SDK barrel and CLI are
entries, as are the documented registry type seam, discovered operation
registries, operator scripts and dynamically loaded CLI test fixtures. The
selection helper's companion declaration is an explicit entry. Knip's built-in
Vitest and Oxlint integrations discover test/config entries and the lint plugin;
we avoid redundant patterns that could hide an unwired source file.

The only ignored dependency is the optional Claude Agent SDK peer: the driver
loads it through a constant module specifier at runtime. Removed `@ast-grep/napi`
after confirming no source imports or executable consumers. Declared the tests'
direct `@ai-sdk/provider` type dependency instead of relying on a transitive
installation. A real isolated fixture fails for an unreferenced source file and
passes after the SDK imports it.

Local `check` runs format, static, tests and Knip once each. CI's existing static
job runs the same scripts plus build. The from-source companion owns its build
and smoke; the denylist and package-audit workflows retain their scan, self-test
and packaging checks. Required job names and unfiltered triggers are unchanged.

### Local timing sample

Same macOS machine, Node 24.21.0, original revision
`85dc1ebf1a580ee2bdda1d63ddb873b85ca4b12a` installed with `npm ci` in a disposable
copy. One first run and three subsequent runs, sequentially with no test suite
running. Times are seconds; the first run is not a controlled cold-cache result.

| Command                                          |  First | Subsequent median |
| ------------------------------------------------ | -----: | ----------------: |
| Before: ratchet script then `npm run lint`       | 10.546 |             8.962 |
| After: ratchet script (compiler plus typed lint) |  1.866 |             1.901 |
| Before: ESLint on `src/kernel/schema.ts`         |  1.046 |             0.760 |
| After: fast-lint script on the same file         |  0.249 |             0.256 |

The full gate now checks a broader policy, so these are workflow measurements,
not an engine-only benchmark or a general performance guarantee. Build, tests,
formatting and Knip are excluded from this static-gate comparison.

## Final validation (2026-09-16)

After a fresh `npm ci`: static gate (zero type baseline), formatting and Knip
passed. The full suite with `--maxWorkers 1` passed 1,389 tests in 55 files
(four skipped, one todo); build, the external strict NodeNext declaration
consumer and the governed from-source smoke also passed. The instantiated CI
matches the canonical template byte-for-byte after token substitution.

The default-concurrency `npm run check` did not pass on this machine: five
existing timing-sensitive tests failed (ACP timeout, subprocess session timeout,
SIGTERM/SIGKILL startup race, missing grandchild PID after the one-second startup
budget, and review pagination timeout). The serial run passes those same
assertions. No timeout, assertion or type baseline was weakened to mask them.

The tracked candidate passes the nine-class denylist and all 13 self-tests.
The 157-file package tarball passes its path allowlist and denylist scan with
build-output exemptions disabled.
The working-tree scan still rejects the pre-existing ignored ACP sandbox file
under the agent scratch directory. That local state was not deleted or
allowlisted. This is not an all-gates-green or ready-to-merge claim. Required
CodeRabbit review cycles remain outstanding before a PR; none was opened.
