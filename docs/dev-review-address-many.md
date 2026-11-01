# Bulk address executor

The runtime exposes `makeReviewAddressMany` through the SDK and
`review.addressMany` through the registry-driven CLI. Node 24 is the toolkit’s
supported/tested runtime floor, matching CI. Workspace dependency inspection
uses [`fs.promises.glob` with pattern exclusions](https://nodejs.org/api/fs.html#fspromisesglobpattern-options),
stable since Node 22.17. On Node 21 or earlier, importing the package fails at
link time: the root export reaches the static `glob` import.

Example:

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

Before a paid repair attempt, a clean-parent preflight checks dependency
availability and leg-wide baseline checks. Only deterministic, leg-wide
prerequisite failures stop the leg. Transient baseline exits (including low
memory, timeout and signal exits) get one bounded check retry without another
model dispatch; exhausted transient checks and finding-specific refusals stay
local to their finding. Reports expose typed `preconditions` with kind, scope,
stage and cause, including a separate cleanup error when present.
Successful leg-wide baselines are reused while the parent head is unchanged.
Finding-scoped checks run only for fixed candidates, so a mapping refusal does
not block recording a verified rejection. Deterministic leg-wide preflight
failures stop with zero semantic attempts. A finding-scoped baseline refusal
occurs after the model returns `fixed`, so it costs one semantic attempt for that
finding and starts no worker retry or rescue. Recognized
pre-existing check findings remain baseline evidence.
For non-fixed dispositions, the candidate has no prepared `node_modules`.
The rejection reviewer must verify source evidence in that checkout;
commands requiring installed dependencies are unavailable. This avoids dependency
preparation or a finding-scoped mapping refusal blocking a source-only rejection.
Installed dependency reuse compares lockfiles and workspace configuration
exactly, and compares dependency-relevant package settings (including package
manager and overrides), package-manager rc files and declared workspace-member
dependency/lifecycle metadata. Workspace discovery is bounded and fails closed
on ambiguous configuration or an incomplete enumeration. Descriptive metadata
and scripts may differ when no
install lifecycle hooks exist. If hooks exist, the full script map is compared,
including indirect script calls. Unfamiliar settings remain compared
conservatively. Neither plain nor bulk addressing
automatically installs dependencies.

When a PR predates a dependency change in the caller checkout, provide a
separately prepared checkout whose metadata matches that PR. Plain
`review.address` accepts `--dependencyRoot=/path/to/prepared-checkout`;
bulk addressing accepts
`'--dependencyRoots={"123":"/path/to/prepared-123","124":"/path/to/prepared-124"}'`.
Paths resolve relative to the original `repoRoot`, before bulk isolation.
Unmapped PRs keep the caller dependency default. A map entry outside the selected
PR list refuses before dispatch. Each leg report records its selected
`dependencySource` kind (`caller` or `prepared`) and resolved root. The prepared root supplies
`node_modules` and matching manifests, locks and package-manager configuration;
all existing metadata and link-isolation checks still apply. Candidate metadata
is copied privately, and the prepared tree is never installed into or modified.
A mismatch remains a typed deterministic dependency prerequisite refusal. This
option launches no installer and introduces no network or install retry path.

Use `--query='is:open label:fix'` instead of `--pulls` for GitHub search discovery.
The executor pages through the search results and checks the reported total,
repository identities, duplicate numbers and incomplete-results flag. Truncation
(including GitHub's 1,000-result ceiling), failed pages or changing totals refuse
the run with `needs-human` before any leg starts. Search is not a transactional
snapshot; PR facts reads are capped at eight, and a failed read refuses the run.
Every admitted head and its eligibility are revalidated after isolation and
enrollment, immediately before dispatch. The fetched PR head is then checked
against the admitted head inside the address loop before any action or worker.

`--concurrency=3` is the default. Each production leg uses an independent local
clone with a separate Git common directory. Each checkout retains its ownership
lock; plain and bulk calls additionally share a per-PR lock under the caller's
common directory, preventing overlapping writers to that PR. Linked worktrees
alone cannot provide concurrent checkout isolation. Durable dispatch receipts,
pending re-requests and run journals stay under the caller's common directory
across bulk invocations. Checkout-bound bookkeeping stays in each checkout
common directory, so an isolated leg cannot overwrite another worktree’s receipt.

Clones default to `<caller-common-dir>/cq-address-many-clones`; `--cloneRoot`
sets another disk location. Clone setup failures remove their partial directory.
Successful legs with no fixes remove their clone after the report is written;
legs with fixes or post-dispatch non-success results retain it for inspection
and recovery. Clean clones refused before dispatch are removed. The aggregate
`preservedClones` array names every retained checkout by PR number and path.
Dependencies link to the caller's installed packages; the address engine still creates private candidate metadata.
The clone's origin points to the caller's origin for fetching and publication.
Its remote target ref is freshly fetched, and its resolved GitHub repository
must match `repo` before dispatch. The caller’s effective Git author and
committer identities are copied into the clone, including repository-local
identity settings. Repository-local or worktree credential-helper, HTTP
extraheader or signing configuration
causes an explicit `needs-human` refusal directing the caller to plain
`review.address`; bulk isolation inspects key names only and does not copy
helper commands, keys or other potentially sensitive values.
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
without a request remain `not-requested`. Duplicate enrollment rows and rows
outside the requested listing are refused. Ineligible PRs stay
in the aggregate `excluded` rows with advisory `unavailable` enrollment; they
do not prevent eligible sibling legs from running. A requested row that cannot
dispatch records `unavailable` rather than `not-requested`. No inline vendor review is started.

A head or eligibility change before dispatch records `needs-human` and returns
the unused reservation. Live acceptance remains a separate post-merge step.
