# Bulk address executor

The runtime exposes `makeReviewAddressMany` through the SDK and
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

Candidate checks use a private copy of dependency-directory metadata, preserving
absolute links to installed packages. With a global virtual store this copies
only the small link/metadata directory. Installs containing real package files
copy those files for each candidate; copy admission is cancellable but has no
byte budget.

Use `--query='is:open label:fix'` instead of `--pulls` for GitHub search discovery.
The executor pages through the search results and checks the reported total,
repository identities, duplicate numbers and incomplete-results flag. Truncation
(including GitHub's 1,000-result ceiling), failed pages or changing totals refuse
the run with `needs-human` before any leg starts. Search is not a transactional
snapshot; every admitted head and its eligibility are revalidated before dispatch.

`--concurrency=3` is the default. Each production leg uses an independent local
clone with a separate Git common directory, preserving the address ownership
lock. Linked worktrees alone cannot provide this isolation. Clones under the
system temporary directory (`cq-address-many-<PR>-*`) are retained with their
reports and unpublished work for inspection. Dependencies link to the caller's
installed packages; the address engine still creates private candidate metadata.
The clone's origin points to the caller's origin for fetching and publication.
Dirty caller files are not copied; use a committed configuration.

Each admitted PR reserves `tokensPerPr` from the shared `maxTokens` allocation.
Known usage settles the reservation; unknown usage retains it and stops further
admission. An overrun is reported and stops admission. This bounds allocations,
not actual provider spending. Reports retain the original individual results and
use the plan contract's aggregate taxonomy. Unattributed results cannot become
aggregate success. Publication stays `unknown` in the aggregate because the
single-address report has no structured publication witness.

Optional `enrollments` is a JSON array of `{number, request}` rows. Each request
uses the existing `review.enqueue` input (`requestId` and deferred-author
`binding`); only enqueue actions with a matching repository and admitted head
are accepted. Queue configuration uses `CQ_QUEUE_SSH_ALIAS`. Missing capability,
rejection or transport failure records `unavailable` on that row and the address
leg continues. Enrollment never establishes fixing or review completion. Rows
without a request remain `not-requested`. No inline vendor review is started.

A head or eligibility change before dispatch records `needs-human` and returns
the unused reservation. Live acceptance remains a separate post-merge step.
