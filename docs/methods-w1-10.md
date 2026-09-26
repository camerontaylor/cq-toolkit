# W1.10 methods note

W1.10 implements privileged-job provenance and rulesets-as-code: plan §6 row W1.10, as
superseded by ADR-0004 Appendix B (reconciled at G1, `bf5f540`) and RS-11's Decision
(`d9e83ad`). The three GitHub Apps (`cq-verdict`, `cq-promoter`, `cq-automation`) are **not
installed** (owner-blocked, RS-11 B1–B6). This PR is therefore **cutover step C1** (ADR-0004
D-H.3.1), plus the C2 and owner-setup target state written as code. Every App-dependent path is
built but switches on only when its repository variable is set. Until then the interim PAT
paths stay in use, as ADR-0004 D-G.4 allows.

## What lands

| Plan bullet (as superseded)                                  | Where                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| I2 acceptance as a required status on merge-queue PRs        | `cq-accept.yml` posts `cq/acceptance`; ruleset R2 in `github-settings.json` requires it                                |
| `enforce_admins` per the RS-11 branch matrix                 | rulesets R0/R1/R2 in `policy/templates/github-settings.json` (bypass lists per ruleset; classic protection absent)     |
| logged override label                                        | the gate's run report logs each promoted PR's `cq-override` record (W1.9 logs it per PR in `cq/policy`)                |
| gate filters by app slug and workflow path (superseded, D-F) | `src/selfhost/promote-gate.ts` verdict selection: verdict App numeric id; interim slug + workflow path                 |
| branch protection as code plus a drift check (D13)           | `github-settings.json` + `scripts/github-settings-drift.mjs` + `settings-drift.yml`                                    |
| promotion job per P1 (D-K)                                   | `gate.yml`: `wake` → `decide` (env `promote`, sole member of group `promote`), logic in `src/selfhost/promote-gate.ts` |
| PROMOTE_TOKEN re-scoped or replaced                          | the promoter App token when `vars.CQ_PROMOTER_APP_ID` is set; otherwise the interim PAT, used only for the push        |
| #170 secret into a protected environment                     | `environment: drill` on `live-review`, `live-merge`, `live-drivers`; all secret holders moved to environments          |
| template render-diff test                                    | `policy/templates/instances.json` + `scripts/render-templates.mjs` + `test/workflows/template-render.test.ts`          |

## Decisions

1. **Scope is C1.** The new gate runs next to `merge-queue-gate.yml`. Both promote with an
   atomic compare-and-swap push, so running both is race-safe (RS-4 T-20). The new gate is
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
   other app are ignored. Until the App exists, the interim form is the plan's literal wording:
   app slug `github-actions` **and** the posting run's workflow path, event and branch, read
   through the check suite. The interim form is forgeable (RS-4 T-13: an Actions check run can
   attach to a real run's suite). It is no weaker than the old gate, which trusted check names
   alone. C2 ends it.
6. **All verdict posters switch together.** `cq-policy`, `cq-verify` and `cq-accept` sign in
   environment `cq-verdict`. They mint a verdict-App token when `vars.CQ_VERDICT_APP_ID` is set
   and fall back to `GITHUB_TOKEN` otherwise, so the gate's selection and the posters never
   disagree about which app is authoritative.
7. **PROMOTE_TOKEN is replaced by structure.** `decide` does every read with its own
   `GITHUB_TOKEN` (`contents`/`checks`/`actions`/`pull-requests`/`issues`: read). The promotion
   credential reaches only the push. That credential is a promoter-App installation token when
   `vars.CQ_PROMOTER_APP_ID` is set, and otherwise the interim `PROMOTE_TOKEN`. The interim PAT
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
   check pins `can_admins_bypass`. The target state has no repository-level secrets
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

    These are the RS-3 rules in `merge-recheck.ts`, composed read-only. Settle stays in the
    merger's recheck, because the ledger write needs `contents: write`. A mergeability row
    would be circular, since a required `cq/acceptance` keeps GitHub's merge state `BLOCKED`
    until it posts, so it is not included.

11. **The trust set comes from P7 keys.** `CQ_MERGE_TRUSTED_BOTS`,
    `CQ_MERGE_ACCEPT_REVIEW_STATES` and `CQ_MERGE_TRUSTED_ASSOCIATIONS` are mapped from `vars.*`
    in the default-branch definitions. Blank means the conservative default: no bots, `APPROVED`
    only, `OWNER`/`MEMBER`/`COLLABORATOR`. The structural automation identities are always
    excluded (`trustPolicyFromConfig`). The gate uses the same resolver.
12. **The gate's closure and recompute (D-K.3/4).** The gate resolves `tip` and `main` itself.
    Every commit in `main..tip` must be one of:
    - a first-parent merge commit on `merge-queue` of a merged PR into `merge-queue`, where the
      PR's recorded merge commit is that commit and its second parent is the PR head;
    - a commit reachable from such a PR's head.

    First-parent merge commits must be clean: their tree equals
    `git merge-tree --write-tree <p1> <p2>` (git ≥ 2.38, ort). Acceptance is recomputed per PR
    at that PR's merged head. `gates.policyDiff` is recomputed over `main..tip` (push subject).
    With D11 records dormant until C3, a needs-human tip is refused and each PR's `cq-override`
    record is logged. Break-glass (D-H.4) is the only path for protected-path changes until C3.

13. **No-shell git for the gate (#221).** Every gate git call, including the push, goes through
    the hardened helpers in `src/ops/ratchet/git.ts`:
    - `execFile` with an argv array and `GIT_HARDEN`;
    - a scrubbed environment and validated revisions;
    - `--end-of-options`.

    The push credential travels in a step-scoped `GIT_CONFIG_*` extra-header, never in argv or
    `.git/config`.

14. **Protected paths (#220, W1.8).** `^src/ops/ratchet/` was already in the trust ref's
    `policy/protected-paths.json`. W1.10 adds the new check-code paths (`promote-gate.ts`,
    `acceptance.ts`, the settings scripts). `.github/**` and `policy/**` are covered by the
    taxonomy.
15. **Render-diff test.** `policy/templates/instances.json` records, for each instantiated
    workflow, its template and token values. The test renders every template and compares the
    result byte for byte with `.github/workflows/`. Every workflow must be either instantiated
    or listed as non-templated with a reason, and every template must be either instantiated or
    listed as adopter-only. `scripts/render-templates.mjs --write` re-instantiates the
    workflows.

## Residuals (recorded, not fixed here)

- **D-G.4 review-form record.** An `APPROVED` review bound to the head from a non-author
  trust-set human is a D11 record form. It is dormant until C3, like the label form, and cannot
  occur in a solo-owner repository (the owner authors every PR). Its evaluation in
  `gates.policyDiff` and the gate's per-PR authorization (the `M^1..M^2` range for a merged PR)
  land with C3.
- **Interim verdict forgery (T-13).** Decision 5.
- **Drift check arming.** It needs the verdict App (with read-only Administration,
  Environments, Secrets and Actions access) or an interim read-only fine-grained
  `CQ_SETTINGS_TOKEN` in `cq-verdict`. Without either, it fails closed on schedule.
- **Gate sweep interval (O-7).** It is every 15 minutes, which bounds promotion latency when a
  wake-up is missed.
