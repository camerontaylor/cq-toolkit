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
