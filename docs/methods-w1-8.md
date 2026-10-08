# W1.8 methods note

W1.8 applies a default-deny boundary at the point where a sweep worker changes become a
commit. The worker still runs in its worktree, and the normal baseline/final regression gate
still executes, but the staged set is first enumerated with a null-delimited name-status diff.
Test files, snapshots, `.gitattributes`, runner/measurement configuration, and `package.json`
are protected paths: a worker cannot redefine the evidence used to judge its own result. Such a
unit is left staged but uncommitted and is classified as needs-human evidence. The test-fix plan
therefore no longer supplies a test-file allowlist that would make test edits committable; the
normal package scope is retained, while the protected-path guard remains unconditional.

Every diff consumed by the tamper and commit-verification gates is text, not binary, and is
immune to repository-configured external drivers and text conversion: the argv includes
`--text --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ --`. `--no-renames`
also makes a renamed-away test an ordinary delete, so the path gate sees both sides of a rename.
The same argv is used for the staged scan and the push-time re-scan.

The hack detector is defence in depth, not the primary boundary. Its default additions cover
`todo`, `fails`, `concurrent`, `skipIf`/`runIf`, x/focus aliases, node:test option-object forms,
`@ts-nocheck`, and `biome-ignore`. A net removal of test declarations is detected from removed
hunk lines, including deletion of a whole `describe` or a failing `it`, despite the scanner's
otherwise added-lines-only policy. Config/snapshot paths are reported as protected findings so a
future caller that scans without the stage gate still fails closed.

Vitest totals are carried on `FailureSet` (`numTotalTests`, `numPassedTests`, pending/skipped,
and TODO counts). The regression gate treats a lower executed-test total or a higher skipped/TODO
total as a regression, closing the `--passWithNoTests` shape where exit code 0 and no failures
would otherwise look clean. Totals are optional so non-test adapters retain their existing JSON
contract; a test adapter that supplies them is gated on every run.

The fixture corpus is consumed as a table of minimal unified diffs. Each entry has two expected
verdicts: `default-deny` for the worker commit path and `base-owned` for the human-owned
verification path. The corpus covers the 29 RS-10 additions and ten inherited git-plumbing
cases. The consuming test reads the manifest in both modes, checks that every listed fixture is
present, and asserts that the default-deny verdict is rejection/needs-human for the protected
classes. This makes the corpus a contract rather than an unconsumed pile of examples.

A7/A8/A9 are covered respectively by the protected-path gate and exact diff argv (A7), the
seven static detector additions plus removed-line heuristic (A8), and the `FailureSet` totals
regression check (A9). The corpus's two modes document why git-plumbing attacks are neutralised
by the argv while test idiom attacks require the static checks and the human routing decision.
