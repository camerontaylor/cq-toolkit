# Sweep worktree setup

The unit dispatch defaults `worktreesDir` to `<repo-parent>/worktrees/cq`,
outside the repository. The plan builder can supply an explicit directory.

The worktree provider locks each new checkout against Git pruning. To install
dependencies before the first probe, set the unit dispatch `install` hook:

```json
{"command":"npm","args":["ci","--ignore-scripts"],"timeoutMs":600000}
```

The argv command runs in the new worktree after it is locked and before its
baseline probe. It is skipped on reuse. A nonzero exit or timeout fails the
unit before probing. SDK callers may inject `installDeps(worktreePath)` in
`SweepUnitBindings`. Choose a command trusted by the project; omit
`--ignore-scripts` only when its lifecycle scripts are required and trusted.

The default sandbox request is `workspace-write`; the worker binary must
enforce it. Dispatched fixers require at least one `driver.budget` cap, such
as `maxUsd`, `maxTokens`, or `wallClockMs`.
