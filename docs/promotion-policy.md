# Merge to main

Open PRs directly against `main` and merge with a merge commit. The merge bar is green `static` and `denylist` on the exact PR head, one independent review of that head, and no unaddressed review comments.

The independent review is an agent PASS posted with `cq-review-post`, a human’s PASS, or a crq review with the `crq-findings` marker, posted by crq under the queue host’s login, whose reviewed range ends at the head and whose findings are all addressed. A clean crq run posts nothing and does not count.

Every thread and finding, including Codex, CodeRabbit, bot and minor findings, must be fixed or answered with a reason, and every thread resolved before merge.

The reviewer comment names the reviewer agent, the full head SHA and `PASS`.
Reviewers post it with `cq-review-post` (agents repo), which posts as the
**cq-review** GitHub App (`cq-review[bot]`, Pull requests: write only), so
the PASS comes from an identity the PR author's lane did not use. When the App
path is unavailable it falls back to the owner account and reports
`unattested`. The App key is on every agent host, so this separates the
reviewer's posting path from an author's ordinary owner-account posts; it does
not stop an agent that deliberately runs the reviewer tool. An unattested PASS
still counts; no native approval, HTML marker, opt-in
or separate identity is required. Automation ignores Bot authors and logins
ending in `[bot]`, except `cq-review[bot]` review comments. The merging agent
reads the review and judges independence and the verdict, and prefers a
`cq-review[bot]` PASS when both exist.

Reviewers write every actionable finding, including minor and nonblocking ones,
as one ndjson `finding` event: `type: "finding"`, original `severity`, `title`,
and `comment` describing the failure scenario and fix guidance. Include
`fileName`, `startLine`, `endLine` only when the code was actually located.
Never invent a location. Start the summary file with this exact header form:

```markdown
**Independent review (<Name>): PASS|ITERATE for `<40-hex sha>`**
```

Choose `PASS` or `ITERATE`. The reviewer name starts with a letter, contains only
letters, digits, spaces or `.+-`, and is at most 40 characters. Keep the bold
markers and backticks around the full lowercase head SHA; the acceptance readout
requires this format. Follow it with the evidence line. From the reviewed
cq-toolkit worktree, run:

```sh
cq-review-post --repo OWNER/NAME --pr N --head SHA --base BASE_SHA \
  --reviewer NAME --findings findings.ndjson --body-file summary.md
```

Pass the base SHA actually reviewed. The default run ID is `N-head10-NAME`;
keep it stable across retries. Findings become native review threads, while
unanchored findings (including deleted code) are listed with their locations in
the body. The body carries verdict and coverage, even when there are no findings.
Findings mode prints JSON; fallback diagnostics go to stderr. Minor threads also require a disposition and resolution before merge. The merging agent still judges independence. Reply to or
resolve threads through the existing reply/resolve path after an explicit
disposition, never just because a later summary says PASS. Concurrent reviewers
produce separate reviews; the run marker prevents duplicates for each posting
account. A PASS for an older head does not count for the current head.

Use the ordinary merge command, pinned to the reviewed head:

```sh
gh pr merge <number> --merge --match-head-commit <sha>
```

`ci` is the workflow name; its required check-run name is `static`.
`denylist` is both the workflow and check-run name. The cq policy, acceptance
and ratchet reports are advisory. A ratchet drop opens or updates the single
`ratchet` issue. No review comment may be left unaddressed at merge, bot threads included:
fix each finding or answer it with a reason, then resolve the thread. Group
deferred work into one issue per PR and link it in the reply.

CRQ also discovers merged PRs it has not reviewed and reviews them after merge
as visible review debt. The `crq-findings` marker alone does not identify a crq
review: agent reviews posted with `cq-review-post --findings` also carry it.

**Implementation limit.** `src/shared/independent-review.ts` currently requires
an explicit `PASS` and full head SHA, rejects uppercase `HOLD` or `FAIL` words
and negated PASS, and does not recognize the crq findings-review alternative
above. Its bot-author filter accepts `cq-review[bot]` agent reviews without
requiring a `crq-findings` marker, and excludes other bot authors. These parser
limits do not redefine the owner's merge bar; the merging agent reads the
review and judges independence and disposition.

No promotion signer status, fast-forward promotion, label, settle-ledger
receipt or admin flag is part of the normal merge path. Keep the ordinary
history protections; never rewrite shared history or force-push `main`.

Run focused local checks under the [focused-checks contract](focused-checks-contract.md).
The full suite runs in CI. CodeRabbit is advisory
([guidance](coderabbit-review.md)); post-merge CRQ review does not
replace the independent pre-merge review.

The former branch-promotion workflows and their gate are retired. Branch and
ruleset retirement is a coordinator settings operation, not a workflow action.

Live settings after retirement: `cq-r0-history` (25287785) protects only `main`
against deletion and non-fast-forward updates. `cq-r1-main` (25287792) requires
a PR with merge commits, zero native approvals, no thread resolution, and
`static` plus `denylist` from GitHub Actions (15368), without strict checks
or an update restriction. RepositoryRole 5 and Integration 5230844 bypasses
remain `always`. `cq-r2-merge-queue` is deleted; `merge-queue` and `cq/promoted`
are deleted branches. `cq-c2-replay-marker` (24868640) still protects `cq/*`
except the retired `cq/promoted` ref; `cq/review-ledger` remains. Environment
deployment branch policies name only `main`. The saved target is
[github-settings.json](../policy/templates/github-settings.json).

The retained review-ledger rulesets (26246984 and 26246985) protect its
immutable history and restrict writes to Integration 5230901. These existing
protections and the live Actions allowed-events policy are also saved in the
settings template.
