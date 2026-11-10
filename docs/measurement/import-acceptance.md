# Acceptance import recipe (M4b1)

A **recorded snapshot** of one PR's comments and reviews is captured by hand, read-only,
with the recipe below (always `env -u GITHUB_TOKEN gh api`). The importer
(`importAcceptance` in `scripts/measurement-acceptance.mjs`) is a pure
function over the recorded JSON: no `gh`, no network, no journal writes.
Rows are reader artifacts for M10e's `acceptances` input, never runtime
engine inputs; a re-capture is not byte-for-byte reproducible.

## Independence is self-declared

Most agents post to GitHub as the same account, so the comment author
cannot tell a reviewer from a PR author. The importer believes the comment's
own header and records that the header is the only basis (the
`/independent` availability). That is accepted for the measurement readout
only: nothing in the engine, the merge bar or any check may use these rows.

The exception is a review posted by the **cq-review** GitHub App
(`user.login` exactly `cq-review[bot]`), which reviewers do with the agents
repo's `cq-review-post`. Its identity is separate from the owner account, so
its row is **attested**: `reviewerId` is `app:cq-review:<reviewer>` and
`/independent` records the App as the basis. The reviewer name in the header
is still self-declared, and the App key is on every agent host, so this
attests the posting path rather than proving a different agent. Counting `app:` against `self-declared:` review rows
gives the attested share of PASSes. Carry-overs stay self-declared.

Two counting notes. `app:` reflects the snapshot's recorded `user.login`,
captured by the recipe from GitHub's REST API; like every other field, the
importer trusts the recording rather than re-reading GitHub. And a reviewer
who posts the same verdict both ways (an `unattested` fallback, then an
attested repost) yields two rows with different `reviewerId`s, so count the
attested share per head (attested when any `app:` row exists), not per row.

## Recipe

```bash
# 1. the PR — record number, user.login, head.sha, base.ref, merged_at,
#    merge_commit_sha
env -u GITHUB_TOKEN gh api repos/{owner}/{repo}/pulls/{n}
# 2. the issue comments, --paginate --slurp, flattened to one list — record
#    id, html_url, created_at, updated_at, user.login, body
env -u GITHUB_TOKEN gh api "repos/{owner}/{repo}/issues/{n}/comments?per_page=100" --paginate --slurp
# 2b. the PR reviews (cq-review-post findings mode posts its verdict as one),
#    --paginate --slurp, flattened to one list as `reviews` — record id,
#    html_url, submitted_at, user.login, body
env -u GITHUB_TOKEN gh api "repos/{owner}/{repo}/pulls/{n}/reviews?per_page=100" --paginate --slurp
# 3. per head named by an acceptance header, at capture time —
#    bases[headSha] = merge_base_commit.sha, null when compare fails
env -u GITHUB_TOKEN gh api repos/{owner}/{repo}/compare/{base.ref}...{headSha}
```

## What counts as an acceptance

Only the header line of each comment or review is read, anchored exact: the
first line, one trailing `\r` trimmed, after skipping leading lines that are
a whole HTML comment (a publisher's run marker such as
`<!-- crq-findings run=… -->`, which findings-mode review bodies start with).

- **Review** — ``**Independent review (<reviewer>): PASS|ITERATE for
`<40-hex sha>`**``: `reviewerId` is `self-declared:<reviewer>`, or
  `app:cq-review:<reviewer>` when posted by `cq-review[bot]`; ITERATE
  maps to HOLD.
- **Coordinator carry-over** — ``**Independent PASS carried to [rebased ]
head `<40-hex sha>`.**``: `self-declared:coordinator`, PASS; any
  `issuecomment-<id>` URLs in the body join the evidence, in body order.

A first line starting `**Independent` that matches neither form is a
malformed-header unknown, not a row; every other comment is simply not an
acceptance.

## Snapshot shape and unknowns

Snake_case: `repo`, `pr_number`, `fetched_at` (ISO 8601 UTC); `pr` and
`comments` and `reviews` as above (a review's time is `submitted_at`); `bases`; `pagination`/`complete`/`failed_step` as in
the M10a2 CI snapshot recipe (`export-ci-snapshot.md`). Unknown is never
zero: `complete: false` still yields its rows plus one partial unknown
naming `failed_step`; an absent or malformed snapshot (not an object,
missing `pr`, `comments` not an array) yields no rows plus one corrupt
unknown; a snapshot without `reviews` (recorded before step 2b existed)
yields one `PR reviews not recorded` unknown and a non-array `reviews` one
corrupt unknown; a head with no recorded base is an unknown, never a row; identical
duplicates under the head+base+reviewer key dedupe while disagreeing copies
conflict out — and the output never depends on comment order.
