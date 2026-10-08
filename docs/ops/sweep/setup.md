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
enforce it. Every dispatched fixer budget must set `driver.budget.wallClockMs`.
It is the enforced spend bound: the unit op aborts the fixer when it elapses,
whichever lane the driver factory resolves, and it is the only cap that stops
a fixer while it runs. `maxTokens` and `maxUsd` are optional post-run landing
gates, not spend limits. They are checked against the settled run's usage and
cost, and a breach refuses to stage, commit, or push the work, but a runaway
fixer spends up to the wall clock first. Under `maxUsd`, a run that reports
usage but no cost (an unpriced model) is a breach: a USD cap cannot bind it.
Any breach fails the unit as `[INFRA]` before anything is staged.
`maxAttempts` is rejected, because each rescue redispatch is a separate job;
bound attempts with the plan's `rescue.maxRedispatch`. Fixer spend is not yet
reported to the run governor, so run-level caps do not see it (follow-up:
report it through `currentJobContext().reportResult`, as `review.fixItem`
does).
