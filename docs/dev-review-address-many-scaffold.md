# Bulk address worktree scaffolding

This package proves only the existing PR worktree resolver's offline composition
boundary for the planned `review.addressMany` operation. It does not add that
operation or establish runtime acceptance.

The source baseline is `8fc58c222a6ef018e64427a4509c38f5d96ec8e4`, targeting
`main`. The fixtures in `test/ops/review/addressManyWorktree.test.ts` reuse
`makeTestRepo`, `resolvePrWorktree` and `fileWorktreeRegistry`. Forge metadata is
scripted; real temporary Git repositories and a local bare origin supply two
different pull-ref commits with the same advertised head branch. Resolver clocks
are injected. Git transport is restricted to local files. No provider, toolkit
CLI, queue service or CodeRabbit runs.

The two composed fixtures establish:

- Concurrent resolutions retain distinct checkout paths, branch labels and exact
  fetched commits. Separate registry handles preserve both entries, and fresh
  resolutions reuse the correct checkouts.
- A dirty stale checkout refuses refresh while its sibling resolution succeeds.
  Independent settled outcomes preserve the refused PR's original commit, dirty
  bytes and registry entry. Caller and foreign checkout heads, branches, staged
  changes, unstaged changes and untracked content remain unchanged.

Existing resolver tests already cover branch sanitization, fetch-first behavior,
foreign ownership, stale refresh and registry locking individually. These fixtures
add two-PR composition through real Git and the file-backed registry; they do not
replace those lower-level tests or exercise bulk dispatch.

The following bulk contracts remain unimplemented by this package:

- Query selection and the default repository/owner/current-user/bot, open,
  non-draft policy; observed head snapshots and admission/publication revalidation.
- Configured active-PR concurrency (planned default three), shared run token
  reservations, admission stop and bounded settlement of in-flight work.
- Agent review plus existing non-author threads, with zero inline CodeRabbit
  dispatch in the future composition.
- Per-head idempotent advisory enrollment through the existing `dev.review`
  transport, including unavailable enrollment and uncertain-delivery deduplication.
- Independent per-PR reports, one unclean-PR summary, published/withheld verified
  fix aggregation and truthful aggregate exits.

The existing single-address usage meter and per-invocation strict driver
reservation hook do not prove shared multi-PR token reservations. Existing
enrollment transport does not prove bulk enrollment deduplication. A two-PR Git
fixture does not prove a bulk scheduler or actual provider contention.

Integration must wait for the stable S7 address/report contract after R1 and
coordinated ownership of the shared budget, registry and CLI seams. O2's successful
S7 CLI publication/readiness evidence remains the live release gate. These offline
fixtures do not satisfy O2, prove fixes per run or establish live usability,
CodeRabbit credit, queue readiness or merge acceptance.
