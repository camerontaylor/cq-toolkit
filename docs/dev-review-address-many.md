# Bulk address executor: explicit PR selection

The first runtime slice exposes `makeReviewAddressMany` through the SDK and
`review.addressMany` through the registry-driven CLI:

```sh
cq review.addressMany --repoRoot=. --repo=owner/repo --owner=owner \
  '--pulls=[123,124]' --maxTokens=200000 --tokensPerPr=100000 --push=true --json
```

The explicit list is frozen before work starts. Only open, non-draft PRs by
`owner` are eligible. The checkout remote must match `repo`. Each selected PR's
head, branch, repository and eligibility are rechecked before dispatch. Existing
`review.address` owns worktree isolation, verified fixes, publication and replies.
Bulk dispatch forces agent review; it never starts inline CodeRabbit.

Execution is serial because the address engine holds a common-directory lock.
Each admitted PR reserves `tokensPerPr` from the shared `maxTokens` allocation.
Known usage settles the reservation; unknown usage retains it and stops further
admission. An overrun is reported and stops admission. This bounds allocations,
not actual provider spending. Reports retain the original individual results and
use the plan contract's aggregate taxonomy. Unattributed results cannot become
aggregate success. Publication stays `unknown` in the aggregate because the
single-address report has no structured publication witness.

This slice does not add query discovery, parallel execution, advisory enrollment
or live acceptance. Enrollment remains `not-requested`. These remain R5 follow-up
work; this executor's tests alone do not demonstrate M4.
