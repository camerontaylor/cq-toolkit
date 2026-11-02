# Policy — PR checks and quality ratchets

PRs target `main`. Required check-run names are `static` and `denylist`, with
one independent exact-head review comment read by the merging agent. CRQ reviews
after merge. See [merge policy](../docs/promotion-policy.md).

[Doctrine](DOCTRINE.md) describes the behavioral invariants. The
[templates](templates/) provide advisory cq reports, ratchet measurement and
proposals, and scheduled review/merge automation. There is no branch-promotion
gate, queue bootstrap or queue synchronization workflow.

## Adoption

1. Configure repository checks and merge-commit settings for your main branch.
   Repository rules and credentials are owner-managed, outside the templates.
2. Use `templates/instances.json` and the [template guide](templates/README.md)
   to instantiate workflows. Keep the generated provenance headers.
3. Required workflows report on every PR: no path or branch trigger filters.
4. Keep check tokens out of head-authored code: checkout without persisted
   credentials, and run privileged advisory verifiers from trusted code.

## Ratchets

Metrics and baseline guards remain available as standalone SDK/CLI operations.
Committed baselines only tighten; missing measurements never mean a pass.
On main PRs the ratchet workflow reports a drop in a single `ratchet` issue;
it is advisory. CI's `static` job catches test failures. Baseline proposals
open PRs against `main`; they do not silently rewrite the current baseline.

## Review

A plain human comment with the reviewer agent identity, exact head SHA and
`PASS` records independent review. Shared GitHub accounts are supported. Bot
authors (Bot type or `[bot]` suffix) do not count as that signal. No HTML
marker, opt-in or native approval is needed. Fix accepted cheap findings and
group deferred work into one issue per PR; bot threads do not block merge.
