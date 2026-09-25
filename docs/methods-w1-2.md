# W1.2 methods note (run=v11, tier O)

SHA-bound acceptance at merge time and durable settle state, per the RS-3
Decision (`rs3-github-signals.md` §9) and ADR-0004 (reconciled).

## Approach

- **Merge-time recheck.** `gateMergeEffects` wraps the `mergePr` effect, so
  the PR is re-fetched right before each merge call and there is no
  classify→merge window for the head, base, reviews, or threads.
  `recheckBeforeMerge` reads the live `headRefOid`/`baseRefOid`/
  `baseRefName`, every review with its `commit.oid`, every review thread
  (resolution and root author), and the `HeadRefForcePushedEvent`
  timeline. Reviews, threads and timeline page with independent cursors
  (`reviewsAfter`/`threadsAfter`/`timelineAfter`, sent only when a real
  cursor exists), capped at 10 pages each. It reads the clock after the
  fetch, so a new anchor is never stamped before what it records. It
  refuses when:
  - the head is unpinned or has moved;
  - the base is unverified, changed, or the protected branch (below);
  - the data is truncated: past the page cap, a missing connection, or a
    head, base oid or base name that changed between pages;
  - the settle ledger cannot be read;
  - an unresolved external review thread remains (below);
  - a trusted reviewer's latest opinionated review is CHANGES_REQUESTED;
  - no trusted actor's current opinion accepts the live head;
  - the tuple has not settled;
  - the observation could not be written just before an ok answer.

  Refusals after the ledger read append
  `(state discarded: <n> record(s); first: <reason>)` when the read
  discarded records; an ok answer carries them as `discarded`.

- **Base pin (I3).** The gate remembers, per PR, the `baseRefName` from the
  most recent successful `readBaseRef(pr)` it delegated. `executeMerges`
  calls it right before every merge attempt and every retry. A failed read
  forgets the pin, and each `mergePr` consumes it. The recheck refuses
  "base unverified" with no pin, "base changed" when the live
  `baseRefName` differs from it, and refuses outright when the live base
  is `SelfhostDefaults.protectedBranch` (`main`).
- **Unresolved threads (I2).** Unresolved review threads whose root author
  is external to the PR author are counted with `countUnresolvedThreads`,
  the same rule as classify row 5. A null root author counts as external,
  and a non-boolean `isResolved` counts as unresolved. Any such thread
  refuses "unresolved external threads: <n>" before reviews are judged.
- **Fold.** The latest opinionated review per actor is folded over all
  reviews. Acceptance comes from each trusted actor's current opinion:
  its latest review whose state is an accept state, CHANGES_REQUESTED, or
  DISMISSED. The actor accepts only when that review is in an accept state
  and bound to the live head. A dismissed approval never counts, whether
  GitHub rewrote its state or a later DISMISSED review landed. `latestOpinionatedReviews(writersOnly:true)` and `reviewDecision`
  are never read. Both CodeRabbit identity forms (`coderabbitai`/Bot and
  `coderabbitai[bot]`/User) fold to one actor. Bots grant acceptance only
  when allowlisted. Authors that are neither Bot nor User (null,
  Organization) never count, and an acceptance needs a parseable
  `submittedAt`.
- **Trust config.** `trustPolicyFromConfig` maps the W1.1 config fields
  structurally, without importing W1.1 types. It can only narrow the
  blanks. Bot logins are normalized to the bare name.
  `trustedAssociations` intersects {OWNER, MEMBER, COLLABORATOR}.
  `acceptReviewStates` keeps only APPROVED/COMMENTED, and a blank list
  means APPROVED. `automationLogin` is excluded. The structural bots
  (`github-actions[bot]`, `cq-automation[bot]`, `cq-verdict[bot]`,
  `cq-promoter[bot]`) are always excluded, and a `trustedBots` entry naming
  an excluded identity is dropped. `CONSERVATIVE_TRUST_POLICY` is
  `trustPolicyFromConfig({})`.
- **Automation identity.** A real run resolves the token's login with
  `gh api user` and excludes it from trust. An integration token's 403
  ("Resource not accessible by integration") proceeds ONLY when no
  `trustedBots` entry is configured, because the App's own bot login is
  unknowable. Otherwise every recheck refuses with "automation identity
  unresolved: integration token with trustedBots configured". Any other failure makes every recheck refuse
  with "automation identity unresolved". The status rides the result and
  the payload as `automationIdentity`. Dry runs skip this.
- **Settle.** Settle needs two observations of the identical
  `(head, base, force-push epoch)` tuple, at least `settleMs` apart. The
  epoch is the client-side count of force-push nodes, never `totalCount`.
  Any change to the tuple resets its observations.
- **Store.** Observations are kept in `.cq/settle-state.json` on the
  `cq-state` branch, written through the git-data API. The ref update is
  fast-forward only, which makes it a compare-and-swap. The Actions cache is
  never used, and dry runs never write.
- **Minimal writes.** Writes scale with activity, not with cron fires. The
  run-start pass writes only when a record is created or reset, or a
  record is pruned. A same-tuple observation is not appended, because the
  first observation anchors settle and the recheck supplies the second.
  The recheck writes before answering ok (the audit record), or best
  effort when a refusal created or reset the record. A refusal on an
  unchanged tuple writes nothing. Ledger `discarded` reasons ride the
  result and the payload.

## Credential (ADR-0004 D-D)

The state write runs inside the merger process, using its `GH_TOKEN`.
ADR-0004 assigns that token to the automation App, which has
`contents: write`. No worker job holds it, and the self-host conflict stage
stays disabled. There is no conflict with the identity rules, so the write is
not delegated to a separate privileged job.

## Residuals

- Until W1.10 adds branch rulesets, any holder of Contents write can push
  `cq-state`. A forged, back-dated observation could shorten settle, but it
  cannot forge SHA-bound acceptance.
- Pushes to `cq-state` trigger the unfiltered `push:` workflows (ci,
  denylist, ratchet) on that branch. Writes are kept to material changes.
  The doctrine-sanctioned fix is a job-level
  `if: github.ref != 'refs/heads/cq-state'` in the required-check template
  and in those workflows. It is deferred to the workflow/ruleset owner
  (W1.10), because this lane does not edit workflows.
- A refusal surfaces as a failed-merge needs-human row. `executeMerges` has
  no "deferred" outcome yet.
- Including the base SHA in the tuple follows RS-3. Each merge into
  `merge-queue` therefore restarts settle for its siblings, so at most one
  merge per base lands per settle window (10 min). That throughput cost is
  accepted per RS-3.
- W1.1's classify fold differs: it keys on the raw login and takes the
  latest review in any state. The recheck is the binding, stricter gate.
  Unify both into one shared module after W1.1 merges.
