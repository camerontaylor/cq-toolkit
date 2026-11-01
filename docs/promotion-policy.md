# Merge to main

Open PRs directly against `main`. Merge with a merge commit when `static` and
`denylist` are green on the exact PR head and one independent reviewer has
posted a PASS comment for that head, with no unresolved P0/P1 findings.

The reviewer comment names the reviewer agent, the full head SHA and `PASS`.
Author and reviewer agents may share the owner's GitHub account; no native
approval, HTML marker, opt-in or separate GitHub identity is required.
Automation ignores Bot authors and logins ending in `[bot]`. The merging agent
reads the review and judges independence and the verdict.

Use the ordinary merge command, pinned to the reviewed head:

```sh
gh pr merge <number> --merge --match-head-commit <sha>
```

`ci` is the workflow name; its required check-run name is `static`.
`denylist` is both the workflow and check-run name. The cq policy, acceptance
and ratchet reports are advisory. A ratchet drop opens or updates the single
`ratchet` issue. Bot threads are reported, not a merge condition: fix accepted
cheap findings and group deferred work into one issue per PR.

CRQ discovers merged PRs and reviews them after merge as visible review debt.
No promotion signer status, fast-forward promotion, label, settle-ledger
receipt or admin flag is part of the normal merge path. Keep the ordinary
history protections; never rewrite shared history or force-push `main`.

Run focused local checks under the [focused-checks contract](focused-checks-contract.md).
The full suite runs in CI. Author-side review follows the
[CodeRabbit protocol](coderabbit-review.md); post-merge CRQ review does not
replace the independent pre-merge review.

The former branch-promotion workflows and their gate are retired. Branch and
ruleset retirement is a coordinator settings operation, not a workflow action.
