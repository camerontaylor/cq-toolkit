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
