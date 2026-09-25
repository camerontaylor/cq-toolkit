# W1.2 methods note (run=v11, tier O)

SHA-bound acceptance at merge time and durable settle state, per the RS-3
Decision (`rs3-github-signals.md` §9) and ADR-0004 (reconciled).

## Approach

- **Merge-time recheck.** `gateMergeEffects` wraps the `mergePr` effect, so
  the PR is re-fetched right before each merge call and there is no
  classify→merge window. `recheckBeforeMerge` reads the live
  `headRefOid`/`baseRefOid`, every review with its `commit.oid`, and the
  `HeadRefForcePushedEvent` timeline. It refuses when:
  - the head is unpinned or has moved;
  - the data is truncated;
  - no durable observation could be written;
  - a trusted reviewer's latest opinionated review is CHANGES_REQUESTED;
  - no trusted review is bound to the live head;
  - the tuple has not settled.
- **Fold.** The latest opinionated review per actor is folded over all
  reviews. `latestOpinionatedReviews(writersOnly:true)` and `reviewDecision`
  are never read. Both CodeRabbit identity forms (`coderabbitai`/Bot and
  `coderabbitai[bot]`/User) fold to one actor. Bots grant acceptance only
  when allowlisted.
- **Settle.** Settle needs two observations of the identical
  `(head, base, force-push epoch)` tuple, at least `settleMs` apart. The
  epoch is the client-side count of force-push nodes, never `totalCount`.
  Any change to the tuple resets its observations.
- **Store.** Observations are kept in `.cq/settle-state.json` on the
  `cq-state` branch, written through the git-data API. The ref update is
  fast-forward only, which makes it a compare-and-swap. The Actions cache is
  never used, and dry runs never write.

## Credential (ADR-0004 D-D)

The state write runs inside the merger process, using its `GH_TOKEN`.
ADR-0004 assigns that token to the automation App, which has
`contents: write`. No worker job holds it, and the self-host conflict stage
stays disabled. There is no conflict with the identity rules, so the write is
not delegated to a separate privileged job.

## Residuals

- Until W1.10 adds branch rulesets, any holder of Contents write can push
  `cq-state`. A forged observation could shorten settle, but it cannot forge
  SHA-bound acceptance.
- A refusal surfaces as a failed-merge needs-human row. `executeMerges` has
  no "deferred" outcome yet.
- Including the base SHA in the tuple follows RS-3. Each merge into
  `merge-queue` therefore restarts settle for its siblings, which is
  conservative.
