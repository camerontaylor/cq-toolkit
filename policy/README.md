# Policy — PR checks and quality ratchets

PRs target `main`. The merge bar is green `static` and `denylist` on the exact PR head, one independent review of that head, and no unaddressed review comments.

The independent review is an agent PASS posted with `cq-review-post`, a human’s PASS, or a crq review with the `crq-findings` marker, posted by crq under the queue host’s login, whose reviewed range ends at the head and whose findings are all addressed. A clean crq run posts nothing and does not count. CRQ also reviews merged PRs after merge. See [merge policy](../docs/promotion-policy.md).

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

The independent review is an agent PASS posted with `cq-review-post`, a human’s PASS, or a crq review with the `crq-findings` marker, posted by crq under the queue host’s login, whose reviewed range ends at the head and whose findings are all addressed. A clean crq run posts nothing and does not count.

Shared GitHub accounts are supported; the merging agent judges independence.
Agent PASS reviews posted as `cq-review[bot]` count without a `crq-findings`
marker; other bot authors do not count as agent PASS evidence.
Every thread and finding, including Codex, CodeRabbit, bot and minor findings, must be fixed or answered with a reason, and every thread resolved before merge. Group deferred work into one issue per PR and link it in the reply.
See the merge policy for the current parser’s limits.
