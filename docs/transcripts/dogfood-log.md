# Developer-loop dogfood log

These are authorized production exercises, separate from hermetic tests.
`dev.cycle` is sequenced after S6 and was unavailable for this exercise.

## S6 attempt A — PR #435

Run on triton at implementation head
`05a7740e4585ccf06ef9941377c8407016769714`, using the configured `cq.json`
worker/rescue/reviewer roles, real forge/git adapters and production scanners.
Provider credentials were loaded locally; no credential values are recorded.
Machine-specific paths below are redacted; the exact command and artifacts
remain in the local run capture.
The genuine open findings included the independently identified candidate
mutex contention defect and dispatch wiring feedback. No defect was seeded.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:435 --maxTokens=60000 --wallMs=1200000 --rounds=1 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-a --push
```

Observed CLI exit: **3**, `needs-human`. `fixesPerRun`: **0**. Reported usage:
input 0, output 0, cache read 0, cache write 0; USD cost absent. There were no
provider attempts or verified commits. All attempted PR findings stopped at
`findings admission head/branch changed`, before worker dispatch. The final
agent re-review also returned incomplete: its 204445-character full-PR
prompt exceeded the existing 20000-character harness limit, so the driver
refused without upload or truncation. This separate limitation is tracked in
[#438](https://github.com/camerontaylor/cq-toolkit/issues/438). This is a blocked zero-fix run,
not positive acceptance evidence.

Full retained artifact:
`<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-a/review-address-report.json`.
The stdout artifact and local stderr/exit capture are retained under
`/tmp/s6-dogfood-a.*` on triton. The real adapter creates both
`refs/cq-review/pr-435` and `refs/heads/cq-review/pr-435`; Git's `--short`
renders the latter as `heads/cq-review/pr-435`. Comparing that display name
with the adapter's branch label caused the refusal. A real-git, real PR
worktree adapter regression covers admission and fresh re-review identity.

The metric counts distinct verified commit SHAs, not model claims or review
rows. The existing #419 failure-count accounting follow-up remains scoped
separately; this zero result is unambiguous under either interpretation.

## S6 attempt B — PR #435

Same explicit token/wall/round bounds, roles, production scanners and PR source
as attempt A, at implementation head
`13c9a27eb2d20d1cee32eaee02c65e9c1de51e37`. No prompt truncation, policy bypass,
or budget expansion was used.

```sh
node dist/cli.js review.address --repoRoot=<checkout> --source=pr:435 --maxTokens=60000 --wallMs=1200000 --rounds=1 --journalDir=<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-b --push
```

Observed CLI exit: **3**, `needs-human`. `fixesPerRun`: **0**, verified commits:
**0**. Reported usage: input **18861**, output **8110**, cache read **448**,
cache write **0**. The report recorded **USD 0.00689759**, with wall time
**111698 ms** across four provider edit invocations. The remote
feature head remained `13c9a27eb2d20d1cee32eaee02c65e9c1de51e37`.

The model's first mutex response requested further inspection instead of an
edit. The duplicate mutex response declined a concurrency-control change:
it described a proposed shared-mutex file outside the assigned one-file scope
and could not run commands under the worker policy. Those are model refusals,
not proof that the engine rejected a candidate for those reasons. The registry
feedback correctly found that the earlier claimed fix had made no edit and
left the finding open. No verified mutation or passing commit resulted.
Separately, the engine's disposition step failed with `unknown finding` because
it still read an ambiguous short branch name; the regression now requires a
durable disposition on the canonical admission ledger. Final full-PR re-review
remained incomplete, including the existing prompt-size limitation in #438.

Full retained artifact:
`<local-state>/cq-toolkit/dogfood/s6-pr435-20261024-b/review-address-report.json`;
stdout/stderr/exit captures: `/tmp/s6-dogfood-b.*` on triton. Both attempts are
zero-fix runs. Positive measured acceptance remains unmet; no third live attempt
has been authorized. Hermetic fixtures do not substitute for that acceptance.

## Direct repair after attempt B

The candidate mutex contention defect is repaired directly by the implementation
owner, tracked in [#439](https://github.com/camerontaylor/cq-toolkit/issues/439).
Initialization, candidate gates and restoration join one in-process FIFO before
acquiring the existing cross-process git mutex. A healthy sibling's long gate
therefore consumes no cross-process acquisition retries. Admission checks
parent cancellation and remaining unit/run budgets; cleanup still serializes
and retains owned failure evidence. Deterministic regressions explicitly hold
the first validation, exercise a simulated exhausted retry seam without minute
sleeps, and verify queued cancellation/budget cleanup and exact commit scope.
This direct repair is not a positive dogfood fix and does not change either
recorded zero-fix result.
