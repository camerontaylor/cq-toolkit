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
