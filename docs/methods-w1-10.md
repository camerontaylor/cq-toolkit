# W1.10 methods note

W1.10 implements privileged-job provenance and rulesets-as-code: plan §6 row W1.10, as
superseded by [ADR-0004](adr/0004-policy-check-trust-boundaries.md) (D-D, D-H.3, D-I, D-K) and RS-11's Decision
(`d9e83ad`). The three GitHub Apps (`cq-verdict`, `cq-promoter`, `cq-automation`) are **not
installed** (owner-blocked, RS-11 B1–B6). This PR is therefore **cutover step C1** (ADR-0004
D-H.3.1), plus the C2 and owner-setup target state written as code. Every App-dependent path is
built but switches on only when its repository variable is set. Until then the interim PAT
paths stay in use, as ADR-0004 D-G.4 allows.

## What lands

| Plan bullet (as superseded)                                  | Where                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| I2 acceptance as a required status on merge-queue PRs        | `cq-accept.yml` posts `cq/acceptance`; ruleset R2 in `github-settings.json` requires it                                 |
| `enforce_admins` per the RS-11 branch matrix                 | rulesets R0/R1/R2 in `policy/templates/github-settings.json` (bypass lists per ruleset; classic protection absent)      |
| logged override label                                        | the gate's run report logs each promoted PR's `cq-override` record (W1.9 logs it per PR in `cq/policy`)                 |
| gate filters by app slug and workflow path (superseded, D-F) | `src/selfhost/promote-gate.ts` verdict selection: verdict App numeric id; interim slug + a default-branch cq-verify run |
| branch protection as code plus a drift check (D13)           | `github-settings.json` + `scripts/github-settings-drift.mjs` + `settings-drift.yml`                                     |
| promotion job per P1 (D-K)                                   | `gate.yml`: `wake` → `decide` (env `promote`, sole member of group `promote`), logic in `src/selfhost/promote-gate.ts`  |
| PROMOTE_TOKEN re-scoped or replaced                          | the promoter App token when `vars.CQ_PROMOTER_APP_CLIENT_ID` is set; otherwise the interim PAT, used only for the push  |
| #170 secret into a protected environment                     | `environment: drill` on `live-review`, `live-merge`, `live-drivers`; all secret holders moved to environments           |
| template render-diff test                                    | `policy/templates/instances.json` + `scripts/render-templates.mjs` + `test/workflows/template-render.test.ts`           |

## Decisions

1. **Scope is C1.** The new gate runs next to `merge-queue-gate.yml`. Both promote with an
   atomic compare-and-swap push, so running both is race-safe (RS-4 T-20). The new gate's
   push is leased on the refs it read (Decision 13). The new gate is
   stricter, so the old gate promotes this PR and everything else during C1. C2 (remove the old
   gate, make `cq/*` required) needs the verdict App and is the owner's cutover. Applying
   `github-settings.json` is the W7.3a wizard's job. Here the file is the target, and the drift
   check reports the distance to it.
2. **`github-settings.json`, not `branch-protection.json`.** This is ADR-0004's R2-10 rename. The
   file holds rulesets, environments, the Actions event policy and Actions settings, not only
   branch protection.
3. **`enforce_admins` is rulesets.** There is no classic `enforce_admins`. Rulesets always bind
   admins, and bypass is set per ruleset (RS-11 T-11-5):
   - **R0** (`main` + `merge-queue`: non-fast-forward, deletion): bypass is admin only
     (`RepositoryRole` 5, `always`).
   - **R1** (`main`: restrict updates): bypass is the promoter App (`Integration`, `always`,
     never `exempt`) and admin break-glass.
   - **R2** (`merge-queue`: require a PR, merge method `merge`, thread resolution, required
     checks): bypass is admin only. No App bypasses R2.

   The target state has no classic branch protection on either branch. The drift check reports
   today's classic protection as drift.

4. **R2's required checks.** `cq/policy`, `cq/ratchet` and `cq/acceptance` are pinned to the
   verdict App's `integration_id`. Today's classic contexts (`static`, `denylist`, `from-source`,
   `pack-audit`) are kept as belts pinned to the GitHub Actions app (15368). ADR-0004 lists only
   the three `cq/*` checks. Keeping the belts means a red CI run still blocks a PR merge into
   the queue. They are block-only: the gate never reads them by name (D-F.2).
5. **Verdict selection (D-F.1), with an interim form.** When `vars.CQ_VERDICT_APP_ID` is set, a
   verdict is a check run with that numeric `app.id`, `head_sha` equal to the subject, and
   `external_id` equal to `<trust-sha>:<subject>`. The newest such row wins, and rows from any
   other app are ignored. Until the App exists, the interim form is app slug `github-actions`,
   the same `external_id` binding, **and** a completed default-branch verifier run at the trust
   sha: `GET actions/workflows/cq-verify.yml/runs?head_sha=<main>&branch=<default>` must hold a
   run with path `.github/workflows/cq-verify.yml`, event `workflow_run` or
   `workflow_dispatch`, head branch the default branch and this repository as head repository.
   The row cannot be tied to that run through its check suite, as the plan's wording
   suggested: a `cq/ratchet` row that cq-verify posts on the queue tip lands in the check suite
   of the tip's `cq-signal` push run (path `.github/workflows/cq-signal.yml`, event `push`,
   `head_sha` = tip), observed live. A suite lookup therefore never matched, and the gate
   could never promote. The interim form is forgeable (RS-4 T-13): any Actions job can post
   a `github-actions` row with the binding once the verifier has run at `main`. It is no
   weaker than the old gate, which trusted check names alone. C2 ends it.
6. **All verdict posters switch together.** `cq-policy`, `cq-verify` and `cq-accept` sign in
   environment `cq-verdict`. They mint a verdict-App token when `vars.CQ_VERDICT_APP_CLIENT_ID`
   is set and fall back to `GITHUB_TOKEN` otherwise. The gate (and cq-accept's sweep dedupe)
   selects on `vars.CQ_VERDICT_APP_ID`. The two are a pair: every poster, the gate and the
   drift check refuse in a leading step when exactly one of them is set, so the gate's
   selection and the posters never disagree about which app is authoritative.
7. **PROMOTE_TOKEN is replaced by structure.** `decide` does every read with its own
   `GITHUB_TOKEN` (`contents`/`checks`/`pull-requests`/`issues`: read; `actions: write`, used
   only to dispatch `cq-verify` on the default ref when the tip's verdict is missing). The promotion
   credential reaches only the push. That credential is a promoter-App installation token when
   `vars.CQ_PROMOTER_APP_CLIENT_ID` is set, and otherwise the interim `PROMOTE_TOKEN`. The
   client id is paired with `vars.CQ_PROMOTER_APP_ID` (R1's bypass actor, rendered by the
   drift check): `gate.yml` and `settings-drift.yml` refuse when exactly one is set. The interim PAT
   is re-scoped to a fine-grained PAT with Contents read/write, Workflows write and Metadata read
   (RS-11 matrix row 2). The old gate keeps reading the repo-level `PROMOTE_TOKEN`. Once the
   owner moves that secret into `promote` (main-only), the old gate fails closed, and the new
   gate, which runs from `main`, still reaches it.
8. **Environments (ADR-0004 D-D.1, RS-11).** Each environment has exactly
   `custom_branch_policies: true` plus one `{name: main, type: branch}` policy.
   - `cq-verdict`: the three verdict sign jobs and the drift check.
   - `promote`: the gate's `decide`.
   - `automation`: `self-merge-prs`, `self-review-loop`, `sync-merge-queue`, `init-merge-queue`
     and `ratchet-propose`.
   - `drill`: `live-review`, `live-merge` and `live-drivers`. This closes #170: a dispatch from
     a non-default ref fails at job admission, before any secret is exposed (RS-11 T-11-1).

   Only `drill` may have the owner as a required reviewer, with self-review allowed. The drift
   check pins `can_admins_bypass`, `prevent_self_review` (false everywhere) and `wait_timer`
   (0 everywhere; a timer on `promote` would stall every gate run into its timeout). Any
   other protection rule type, such as a custom deployment protection rule, is drift. The target state has no repository-level secrets
   (`total_count == 0`). Environment secret names must be in a committed allowlist, and the
   interim PAT names are listed separately and reported until C3.

9. **Sync goes through a PR (D-I), and every dispatch uses the default ref (D-A.2).** In the
   behind and diverged cases, `sync-merge-queue` opens or reuses a `main → merge-queue` PR
   instead of patching refs, because R2's require-PR rule refuses a direct push by a non-admin
   identity. The resulting merge commit is admitted by the gate's closure rule like any accepted
   PR. Gate dispatches use `ref=main` and the job's own `GITHUB_TOKEN` (`actions: write`). The
   automation App has no `actions` permission.
10. **`cq/acceptance` judges I2 evidence, not merge timing.** The check fails on any of these:
    - the PR is a draft or not into `merge-queue`;
    - the head moved;
    - the snapshot is truncated;
    - the REST lag cross-check fails (I11);
    - there are unresolved external review threads;
    - a trusted objection is outstanding;
    - there is no trusted acceptance bound to the head.

    These are the RS-3 rules in `merge-recheck.ts`, composed read-only. The sweep's cost is
    bounded, not its coverage dropped: it sorts the eligible PRs by number and judges a
    rotating window of 25 (about 4 REST reads per PR at 4 sweeps an hour, so roughly 400 of
    the `GITHUB_TOKEN`'s 1000 requests an hour, whatever the queue's size). The window's
    cursor comes from the clock, not from state: `slot = floor(epoch_seconds / 900)` (the
    sweep's cron fires every 15 minutes) and the offset is `(slot × 25) mod count`, wrapping.
    A run count would not do: retention deletes old schedule runs, so it stalls or goes
    backwards, and `github.run_number` counts every run. The slot is monotonic without state,
    and a late or skipped schedule firing only shifts the window, so every eligible PR is
    judged within `ceil(count / 25)` consecutive 15-minute slots plus any skipped firings;
    per-PR events still judge each PR as it changes. The
    `judge` job is serialized per PR (`resolve` emits the lock `pr-<n>`, or `sweep` for the
    schedule). The sweep and a per-PR run hold different locks. Every row we post carries its
    snapshot time as both `started_at` and `completed_at`, so posted order is snapshot order
    for GitHub's "latest" row and for every consumer that orders by `completed_at`. Before
    posting, each run selects the head's same-app `cq/acceptance` row with the latest
    `started_at` (ties: the greater id) and skips when that snapshot is later than its own.
    The sweep's "unchanged" dedupe compares against the same row, and it re-posts anyway when
    the latest-`completed_at` row is a different row (a stale row is what GitHub shows).
    The clock bounding a row's date (its future bound) is read per PR. That guard is
    best-effort, so an older snapshot's post can still occasionally land after a newer one's
    (see Residuals). Settle stays in the
    merger's recheck, because the ledger write needs `contents: write`. A mergeability row
    would be circular, since a required `cq/acceptance` keeps GitHub's merge state `BLOCKED`
    until it posts, so it is not included.

11. **The trust set comes from P7 keys.** `CQ_MERGE_TRUSTED_BOTS`,
    `CQ_MERGE_ACCEPT_REVIEW_STATES` and `CQ_MERGE_TRUSTED_ASSOCIATIONS` are mapped from `vars.*`
    in the default-branch definitions. Blank means the conservative default: no bots, `APPROVED`
    only, `OWNER`/`MEMBER`/`COLLABORATOR`. The structural automation identities are always
    excluded (`trustPolicyFromConfig`). The gate uses the same resolver.
12. **The gate's closure and recompute (D-K.3/4).** The gate resolves `tip` and `main` itself.
    A tip already contained in `main` is a `noop`, decided from git objects alone. Otherwise it
    refuses unless the resolved `main` equals its trust ref (`github.sha`): a `decide` run
    queued behind an earlier promotion would otherwise judge the new `main` with the old
    code and definitions; the next sweep retries. Ordering the noop first keeps the second
    carrier's run after a promotion (ci and cq-measure both wake the gate) a green `noop`.
    Every commit in `main..tip` must be one of:
    - a first-parent merge commit on `merge-queue` of a merged PR into `merge-queue`, where the
      PR's recorded merge commit is that commit and its second parent is the PR head;
    - a commit reachable from such a PR's head.

    First-parent merge commits must be clean: their tree equals
    `git merge-tree --write-tree <p1> <p2>` (git ≥ 2.38, ort). I2's evidence rows are
    recomputed per PR at that PR's merged head: a head-bound trusted acceptance, no outstanding
    trusted objection, no unresolved external threads, and the lag cross-check. I2's settle
    half (≥10 minutes since the head, or an all-clear that postdates it) is not recomputed. Only
    the merger's recheck (`self-merge-prs`, `merge-recheck.ts`) enforces it, so a PR merged
    into `merge-queue` by hand skips settle (see Residuals). `gates.policyDiff` is recomputed
    over `main..tip` (push subject). The waits for verdicts and verified runs can take
    minutes, and a state change during them moves no ref, so the leases cannot catch it. After
    the waits, the gate re-judges every PR's evidence, then re-reads the verdicts and verified
    runs once without waiting, and only then pushes.
    With D11 records dormant until C3, a needs-human tip is refused and each PR's `cq-override`
    record is logged. Break-glass (D-H.4) is the only path for protected-path changes until C3.

13. **No-shell git for the gate (#221).** Every gate git call, including the push, goes through
    the hardened helpers in `src/ops/ratchet/git.ts`:
    - `execFile` with an argv array and `GIT_HARDEN`;
    - a scrubbed environment and validated revisions;
    - `--end-of-options`.

    The push credential travels in a step-scoped `GIT_CONFIG_*` extra-header, never in argv or
    `.git/config`. The push is a real compare-and-swap: `--atomic` with an explicit
    `--force-with-lease=refs/heads/main:<oid>` leased on the `main` the gate read at step 1, and
    never a plain force. Only `main` is sent (D-K.6 holds by construction, not by git's
    equal-OID skip): the merge-queue refspec the earlier form also sent could never update the
    queue — step 1 refuses unless the local mirror already held the tip, so it was either an
    equal-OID no-op or a lease that failed the push — and is omitted outright. A queue that
    advances during the waits is promoted by the next sweep; the tip pushed here is an ancestor
    of any queue that grew from it. A non-forced push would accept a ref that was rewound to an
    ancestor during the wait (break-glass dropping a merge) and quietly fast-forward it back.

14. **Protected paths (#220, W1.8).** `^src/ops/ratchet/` was already in the trust ref's
    `policy/protected-paths.json`. W1.10 adds the new check-code paths (`promote-gate.ts`,
    `acceptance.ts`, `state-branch.ts`, the settings scripts) and the review modules the gate
    and acceptance decide through (`src/ops/review/gh.ts`, `threads.ts`). A test walks the
    value-import closure of `acceptance.ts` and `promote-gate.ts` and requires every file in
    it to be protected. `.github/**` and `policy/**` are covered by the taxonomy.
15. **Render-diff test.** `policy/templates/instances.json` records, for each instantiated
    workflow, its template and token values. The test renders every template and compares the
    result byte for byte with `.github/workflows/`. Every workflow must be either instantiated
    or listed as non-templated with a reason, and every template must be either instantiated or
    listed as adopter-only. `scripts/render-templates.mjs --write` re-instantiates the
    workflows. It writes nothing while any table error stands other than a workflow listed
    only in `instances`, with a valid render, that does not exist yet (the file it creates);
    a missing `nonTemplated` workflow still blocks. Table names must be plain file names
    (no `..`).

## The C3 checklist (owner cutover: activate D11 records)

Until C3 the gate cannot honour a D11 override: `policyDiff` is called without
`settleRef`/`ownerId`, so every override record evaluates invalid, and
`logOverrides` hard-codes `attested: false`. C3 is done only when ALL of:

- [ ] the D11 attestation lands (the ledger epoch the checks arm against);
- [ ] `settleRef` and `ownerId` are wired into the gate's `policyDiff` call and
      into `logOverrides`, so **the gate honours a valid override record**
      (a record that today only logs as `invalid` becomes decisive — never
      merely "the label is active");
- [ ] the D-G.4 review-form record and the gate's per-PR authorization (the
      `M^1..M^2` range for a merged PR) evaluate;
- [ ] the promoter credential needs no `actions: write`: `decide`'s only
      dispatch (`cq-verify`) runs on its own `GITHUB_TOKEN`, restricted to the
      default ref (pinned by `test/workflows/default-ref-guards.test.ts`). If a
      future change ever moves that dispatch onto the promoter credential,
      minting that token with `permission-actions: write` is an owner-side
      action, recorded here.

## Residuals (recorded, not fixed here)

- **The sync/init interim fallback is opt-in, not silent (fix round).** `sync-merge-queue` and
  `init-merge-queue` require `CQ_AUTOMATION_TOKEN`; the `PROMOTE_TOKEN` fallback arms only while
  the repo variable `CQ_AUTOMATION_INTERIM_FALLBACK` is non-empty. An unset automation secret
  alone never silently makes the promoter PAT the automation identity (workflows:write). Remove
  the variable and the interim secret at C3.
- **W1.2b follow-up F1 (settle-tuple GraphQL-only lag) — open, owned by W1.2b.**
  `merge-recheck.ts`'s I11 lag cross-check (`checkReviewDataLag`, g0) refuses when a non-PENDING
  REST review or REST conversation root is missing from the GraphQL snapshot, but the settle
  tuple and its anchor remain GraphQL-derived: REST-only or REST-fresher review data is never
  folded into the tuple, and the check is skipped on the run-start `observeOpenPrs` pass.
  Recorded here because the W1.2b follow-up list is not in this PR's diff
  (`docs/methods-w1-2.md` "Review data lag", `src/selfhost/merge-recheck.ts` g0); deliberately
  not widened into this PR.
- **`protected-paths.json` `requiredChecks` versus ruleset R2 (supersession recorded before
  C2).** `requiredChecks: ["static", "denylist", "ratchet"]` is the C1 wait list;
  R2's required list replaces `ratchet` with the verdict-App `cq/ratchet` (plus `cq/policy`,
  `cq/acceptance`, `from-source`, `pack-audit`). Applying R2 without dropping the classic
  `ratchet` context would trip D11's "removed required check" rule. C2's order: drop the
  classic contexts as R2 lands. `test/ops/gates/protectedPaths.test.ts` pins the mapping so
  the two lists cannot drift apart silently again.
- **`live-review.yml` and `live-drivers.yml` are not render-enforced (r1 L5).** Both are
  repo-owned drill harnesses (this repo's scratch-repo convention, provider keys, demo
  scripts), so templating them would change their semantics rather than adopt a pattern —
  they stay in `instances.json`'s `nonTemplated`. Their security shape (`environment: drill`,
  the D-A.1 default-ref dispatch guard) is pinned by `test/workflows/default-ref-guards.test.ts`
  instead, so the three drill workflows are enforced identically even though only
  `live-merge.yml` is a rendered instance.
- **D-G.4 review-form record.** An `APPROVED` review bound to the head from a non-author
  trust-set human is a D11 record form. It is dormant until C3, like the label form, and cannot
  occur in a solo-owner repository (the owner authors every PR). Its evaluation in
  `gates.policyDiff` and the gate's per-PR authorization (the `M^1..M^2` range for a merged PR)
  land with C3.
- **Interim verdict forgery (T-13).** Decision 5. Interim `cq/acceptance` rows are
  forgeable the same way, but can no longer be made sticky: cq-accept's reference row
  ignores a row dated past its own clock plus 120 s, or whose `external_id` is not exactly
  `<40-hex>:<head>`, so a far-future row cannot suppress later posts.
- **Drift check arming.** It needs the verdict App (with read-only Administration,
  Environments, Secrets and Actions access) or an interim read-only fine-grained
  `CQ_SETTINGS_TOKEN` in `cq-verdict`. Without either, it fails closed on schedule.
- **Settle is not recomputed at the gate.** The gate and `cq/acceptance` judge I2's
  evidence rows only (Decisions 10, 12). The merger's recheck (`self-merge-prs`) is the only
  place settle is enforced. The legacy gate does not check settle either, so this is not a
  regression. After C2, though, a PR merged by hand into `merge-queue` a minute after its
  last push would be promoted without any settle check. Fix direction, owned by C2: a
  server-stamped settle anchor at the gate. That is either the earliest `pull_request`-event
  run `created_at` at the head compared with the PR's `merged_at`, or an all-clear that
  postdates the head.
- **`cq/acceptance` ordering is best-effort.** The stale-verdict guard (Decision 10) reads
  the latest-snapshot row in one call and posts in a later one. It compares snapshot times on
  both sides (each row's `started_at` and `completed_at` are its judge step's snapshot stamp,
  taken on that run's runner clock), at one-second resolution with a strict `>`. A stale
  snapshot can therefore occasionally be posted after a newer one; because its
  `completed_at` is its own (earlier) snapshot time, it is still not the latest-completed
  row. Rows posted before rows carried `completed_at` are stamped with their POST time, so
  one of them can be GitHub's latest row while older than the reference row. The sweep then
  re-posts even an unchanged verdict, because the latest-completed row is not the reference
  row. This heals itself on the next event on the PR, or at worst on the first sweep whose
  window holds the PR (within `ceil(count / 25)` consecutive 15-minute slots plus any
  skipped firings). It is bounded, not
  prevented: a row whose `completed_at` is later than the healing snapshot stays GitHub's
  latest until a later snapshot is posted. The gate never reads `cq/acceptance`; its per-PR
  recompute is authoritative for promotion.
- **The Actions event policy is checked only by the owner-run drift check.** GitHub gates its
  read behind Administration: write, and the CI drift credential is read-only by design, so
  the scheduled check reports it as unchecked (a `notice:`); the owner runs
  `--require-event-policy` with an admin credential to cover it.
- **Gate sweep interval (O-7).** It is every 15 minutes, which bounds promotion latency when a
  wake-up is missed.
