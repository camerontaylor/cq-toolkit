# Scripted offline agent fallback fixture transcript

This is an annotated expectation transcript of named automated fixtures, not
captured CLI output or a live acceptance run. Provider/model, scanner results,
lock behavior and green checks are scripted. No provider, network, credential,
CodeRabbit completion or deployment claim follows from these examples.

Fixture source baseline: `8fc58c222a6ef018e64427a4509c38f5d96ec8e4`.
The R7 docs/test checkpoint adds these fixtures without changing production
behavior. Temporary Git fixture commits determine the actual identity values;
`<base>`, `<head>` and `<dirty>` below refer to values read before the review,
not literal test constants.

## Composed terminal agent evidence

Named fixture in `test/ops/dev/review.test.ts`:
`configured agent composes the scripted engine, shared lock and terminal author evidence`.

```text
input reviewer: agent:reviewer
configured provider: scripted
configured model: fixture-reviewer
common scan: clean (scripted)
lock boundary: entered (instrumented, no contention claim)
config read and driver resolution: inside lock
modelSpec: configured scripted / fixture-reviewer
session: read-only; allowlist read, grep, glob
serialized request: scanned before scripted response
engine response: complete; findings=[]; matching complete v2 coverage
lock boundary: exited
result: ok
ledger reviewer: agent:reviewer
ledger target: merge-queue
ledger base/head/dirtySha256: <base>/<head>/<dirty>
ledger completion: terminal
log: reviewer/base/head/dirtySha256/scope/completion/coverage retained
separate check: scripted green record, no gate executed
readiness: author; reviewer=agent:reviewer; same cycle/check and identity
caveat: not verification
CodeRabbit commands: none
```

## Composed blocked agent evidence

The same parameterized fixture with outcome `blocked` returns a scripted
engine error, `scripted provider unavailable`. It still exercises config
resolution, request scanning and the instrumented lock boundary.

```text
result: needs-human
ledger reviewer: agent:reviewer
ledger base/head/dirtySha256: <base>/<head>/<dirty>
ledger completion: blocked; reason includes scripted provider unavailable
log completion: blocked
readiness: needs-human; latest-review-blocked
CodeRabbit commands: none
```

`test/ops/dev/ready.test.ts` additionally names
`a later blocked agent attempt prevents readiness over an older terminal CodeRabbit cycle`:
both records share the current identity; the later blocked `agent:reviewer`
attempt prevents readiness, while the older `coderabbit` identity is preserved.

## Refusal before dispatch

`unavailable agent config (%s) records blocked identity without dispatch`
covers missing configuration, malformed configuration and a missing reviewer
role. Each records a blocked `agent:reviewer` cycle and a blocked log; the
session engine is never called. These cases use in-memory unavailable-config
fixtures, not the user's configuration.

`agent safety refusal (%s) precedes dispatch and records no cycle` covers a
scanner hit, scanner fault, untracked symlink and oversized untracked file.
Each returns `needs-human`, makes zero agent dispatches and zero CodeRabbit
calls, and leaves the ledger empty. Lower-level file containment is reused
from the repository effects; these are explicit-agent admission assertions.

These scripted expectations establish neither a counted CodeRabbit cycle nor
runtime acceptance. See the [guide](../dev-review-agent-fallback.md) for the
policy and evidence boundary.
