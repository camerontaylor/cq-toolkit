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

On Windows the hook is spawned without a shell, so a `.cmd` shim such as
`npm` does not resolve; route it through `cmd.exe` explicitly
(`{"command":"cmd.exe","args":["/d","/s","/c","npm ci --ignore-scripts"]}`).
A Windows timeout kills only the direct child, not lifecycle-script
descendants (the harness's documented v1 process-group limitation).

The default sandbox request is `workspace-write`; the worker binary must
enforce it. Dispatched fixers require at least one `driver.budget` cap:
`maxTokens`, `maxUsd`, or `wallClockMs`. The unit op enforces every cap it
accepts, whichever lane the driver factory resolves. `wallClockMs` aborts
the fixer when it elapses. `maxTokens` and `maxUsd` are checked against the
settled run's usage and cost. A breach fails the unit as `[INFRA]` before
anything is staged. Under `maxUsd`, a run that reports usage but no cost (an
unpriced model) is a breach: a USD cap cannot bind it. `maxAttempts` is
rejected, because each rescue redispatch is a separate job; bound attempts
with the plan's `rescue.maxRedispatch`.
