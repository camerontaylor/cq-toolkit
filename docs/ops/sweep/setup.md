# Sweep worktree setup

The discovered sweep plan and unit dispatch default `worktreesDir` to
`<repo-parent>/worktrees/cq`, outside the repository. Authored plans can
supply an explicit directory.

The worktree provider locks each new checkout against Git pruning. To install
dependencies before the first probe, set the unit dispatch `install` hook:

```json
{"command":"npm","args":["ci","--ignore-scripts"],"timeoutMs":600000}
```

The argv command runs in the new worktree after it is locked and before its
baseline probe, and again in the detached checkout used for the final probe.
A successful install is recorded in the checkout's private Git directory, so
a reused worktree skips it; a failed install is retried on the next dispatch.
A nonzero exit or timeout (which kills the command's whole process group)
fails the unit before probing. A relative command resolves inside the
worktree. SDK callers may inject `installDeps(worktreePath)` in
`SweepUnitBindings`. Choose a command trusted by the project; omit
`--ignore-scripts` only when its lifecycle scripts are required and trusted.

The default sandbox request is `workspace-write`; the worker binary must
enforce it. Dispatched fixers require at least one `driver.budget` cap, such
as `maxUsd`, `maxTokens`, or `wallClockMs`. Enforcement is lane-specific: the
subprocess lane enforces only `maxTokens` (checked after the run), leaving
`maxUsd` to caller accounting and `wallClockMs` to the governor.
