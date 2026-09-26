# SELF-HOSTING

DoD 2 evidence: this repository's own PR history showing queue promotion,
ratchet diffs, and automation-authored replies/resolutions — the toolkit
running on itself, recorded rather than claimed.

Link format: every entry in every table below is the PR URL plus the
workflow run URL. An entry without both is a claim, not evidence.

## Soak (ws-k stage-2 acceptance)

PRs processed end-to-end by the scheduled automation: **0**

**ws-k Stage-2 soak acceptance: NOT MET.** The scheduled `self-review-loop`
and `self-merge-prs` automations are red at their `GH_TOKEN` assert, so they
processed ZERO PRs end-to-end. This is recorded as a phase-4 deviation to
carry into phase 5 (owner: phase-5 release follow-up — configure
`secrets.GH_TOKEN`); the queue itself ran, and every PR in the window below
was merged through `merge-queue` and ff-promoted to `main` with a green
promotion run.

The scheduled automations are optional non-required jobs: a missing `GH_TOKEN`
makes them skip honestly, while required CI checks remain mandatory. W0.6
also disables the self-host conflict stage, so DIRTY candidates are reported
as needs-human rather than model-dispatched. Reviews are counted according to
the trust rules; the former blanket `awaiting` premise was incorrect.

Automation run note (T4.5): the scheduled `self-review-loop` and
`self-merge-prs` runs currently exit red at their `GH_TOKEN` assert —
`secrets.GH_TOKEN` is not configured on this repository (the configured
secrets are `DEEPSEEK_API_KEY`, `PROMOTE_TOKEN`, `Z_AI_API_KEY`). The run log
records the honest outcome (`GH_TOKEN not set`) rather than a silent stall,
but a red run is not processing: no PR was classified, replied to, resolved,
or merged by the automations. Every PR in the window was merged by the lane
leader. Configuring `GH_TOKEN` (owner: phase 5) is the follow-up that lets
the scheduled automations process PRs directly; it is recorded here rather
than hidden.

## Queue promotions

The stage-2 window's **consecutive** promoted run, #182 → #198 (11 PRs; no
other PR landed on `main` in the window), plus T4.5. Every row was merged by
the lane leader through the `merge-queue` + ff-promotion path; the scheduled
automations processed none of them (they are red — see the run note above).
T4.1 (#182) is leader-authored and was merged through the normal protocol,
before the automation existed.

| PR                                                                  | merged SHA                                 | promotion run URL                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [#182 (T4.1)](https://github.com/camerontaylor/cq-toolkit/pull/182) | `c28c0555be969f83866bbdacca5dea0015aa75c9` | [35512532004](https://github.com/camerontaylor/cq-toolkit/actions/runs/35512532004) |
| [#188](https://github.com/camerontaylor/cq-toolkit/pull/188)        | `0badcdb27718e6a01744731ea437bf96624c4ff0` | [35512944322](https://github.com/camerontaylor/cq-toolkit/actions/runs/35512944322) |
| [#190](https://github.com/camerontaylor/cq-toolkit/pull/190)        | `42922b8adf2a14c09288961f254646def55ad138` | [35513616030](https://github.com/camerontaylor/cq-toolkit/actions/runs/35513616030) |
| [#189](https://github.com/camerontaylor/cq-toolkit/pull/189)        | `ecae6cdf8bfa872e4b6864b4e55761b90f5cda9a` | [35515182318](https://github.com/camerontaylor/cq-toolkit/actions/runs/35515182318) |
| [#191](https://github.com/camerontaylor/cq-toolkit/pull/191)        | `3719dfbef81c9e80260ad35742b8f376a5ae7ee6` | [35516616505](https://github.com/camerontaylor/cq-toolkit/actions/runs/35516616505) |
| [#192 (T4.2)](https://github.com/camerontaylor/cq-toolkit/pull/192) | `3b3775633c461ecd6391969a023505a64d71e85d` | [35518211437](https://github.com/camerontaylor/cq-toolkit/actions/runs/35518211437) |
| [#194 (T4.3)](https://github.com/camerontaylor/cq-toolkit/pull/194) | `a6011346f2cc4ad4370acf45f964ba8a30e5a046` | [35521532118](https://github.com/camerontaylor/cq-toolkit/actions/runs/35521532118) |
| [#196 (#193)](https://github.com/camerontaylor/cq-toolkit/pull/196) | `ed2f8fb889f0f0a612088401419cf424d556bcf1` | [35524615344](https://github.com/camerontaylor/cq-toolkit/actions/runs/35524615344) |
| [#197 (T4.4)](https://github.com/camerontaylor/cq-toolkit/pull/197) | `51c81eb068f43e3c890f874cd90e57a9d966e428` | [35526586515](https://github.com/camerontaylor/cq-toolkit/actions/runs/35526586515) |
| [#195](https://github.com/camerontaylor/cq-toolkit/pull/195)        | `bc8ac42a6f7c563f463388a978d76ba1148e3111` | [35527461277](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527461277) |
| [#198](https://github.com/camerontaylor/cq-toolkit/pull/198)        | `0d76ed5b410b413309d33e4d4e11eaee146db099` | [35527938976](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527938976) |
| T4.5 (this PR)                                                      | `<this PR>`                                | `<promotion postdates merge>`                                                       |

Ordering note: the T4.1 row proves T4.1 itself was promoted. A promotion run
URL always lands in the FOLLOWING landed PR, because the promotion run does
not exist until after the merge — this is the recorded deviation noted in the
T4.1 PR body. The T4.5 row's promotion URL lands in the PR that merges after
this one.

## Ratchet self-evidence

| evidence                                                                 | link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| only-tightening baseline PR opened via `proposeBaselineUpdate` (93 → 94) | [PR #198](https://github.com/camerontaylor/cq-toolkit/pull/198) · [ratchet run 35527034882](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527034882) (all required checks green) — merged after the green required checks and the recorded single-identity fresh review (CodeRabbit CLI rate-limited, not a completed CLI cycle) → `0d76ed5b410b413309d33e4d4e11eaee146db099`, ff-promoted to `main` ([promotion run 35527938976](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527938976)) |
| monotonic-guard drill — a loosening PR rejected (93 → 92)                | [PR #199](https://github.com/camerontaylor/cq-toolkit/pull/199) (closed unmerged; branch deleted) · [failing ratchet run 35527069990](https://github.com/camerontaylor/cq-toolkit/actions/runs/35527069990) — step `Baseline monotonicity guard`, `ok:false`, violation `coverage` oldValue 93 → newValue 92                                                                                                                                                                                                          |

The only-tightening proposal was created by the shipped
`ratchet.proposeBaselineUpdate` op from the built CLI against
`baselines/coverage--coverage--a8ceec8f7024.json` (`value` 93,
`direction: higher-is-better`); the latest ratchet CI reading was
`currentValue: 94`, so 93 → 94 is a real tightening. The drill loosened the
same baseline (93 → 92) and the required `ratchet` check rejected it at the
monotonicity guard, then the PR was closed without merging.

## Automation-authored PRs (I2)

Automation-authored PRs carry a `[automation]` title prefix and the
`cq-automation` label so they stay distinguishable under the shared account.
W0.6 does not permanently classify them `awaiting`: trusted reviews count
under the current trust rules, while DIRTY merge candidates are withheld as
needs-human for a human. The lane leader hand-merges only after full gates and
records the evidence here.

Disposition (T4.5): the shipped `ratchet.proposeBaselineUpdate` op creates its
proposal PR with a plain `chore(ratchet): …` title and no label — it does NOT
yet implement the `[automation]` prefix / `cq-automation` label convention.
The first automation-authored PR is therefore recorded below as a convention
gap, not as a conforming row. Adding the prefix/label (owner: phase 5,
release follow-up) is a follow-up in the op's effects layer.

| PR                                                           | gates                                                                                                                 | convention note                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#198](https://github.com/camerontaylor/cq-toolkit/pull/198) | all required checks green (`static` ×2, `denylist` ×2, `ratchet` ×2, `from-source` ×2, `pack-audit`, `build+test` ×2) | no `[automation]` prefix / `cq-automation` label — the shipped op does not set the convention yet; merged after the green required checks + the recorded single-identity fresh review → `0d76ed5b410b413309d33e4d4e11eaee146db099` |

## Hand-merge log

Every row's reason: the scheduled automations are red at their `GH_TOKEN`
assert and never classified any PR, so the lane leader merged each T4.x PR in
the window by hand (the rd3 PRs #188–#191 and #195 were merged by their own
lanes).
A hand-merge is recorded only after the full gates and an explicit I2
review disposition. The old blanket `awaiting` premise was incorrect: trusted
reviews are counted under the trust rules, and W0.6's disabled conflict stage
routes DIRTY candidates to needs-human instead of claiming an automated
resolution.

| PR                                                                  | merged SHA                                 | date       | reason                                                                                   | gates evidence                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#192 (T4.2)](https://github.com/camerontaylor/cq-toolkit/pull/192) | `3b3775633c461ecd6391969a023505a64d71e85d` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `0ba2753` green — `static` ×2, `denylist` ×2, `ratchet` ×2, `from-source` ×2, `pack-audit`, `build+test` ×2 |
| [#194 (T4.3)](https://github.com/camerontaylor/cq-toolkit/pull/194) | `a6011346f2cc4ad4370acf45f964ba8a30e5a046` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `cf00699` green — same required-check set                                                                   |
| [#196 (#193)](https://github.com/camerontaylor/cq-toolkit/pull/196) | `ed2f8fb889f0f0a612088401419cf424d556bcf1` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `0987343` green — same required-check set                                                                   |
| [#197 (T4.4)](https://github.com/camerontaylor/cq-toolkit/pull/197) | `51c81eb068f43e3c890f874cd90e57a9d966e428` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `3ab3db2` green — same required-check set                                                                   |
| [#198](https://github.com/camerontaylor/cq-toolkit/pull/198)        | `0d76ed5b410b413309d33e4d4e11eaee146db099` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | `gh pr checks 198`: all required checks green; fresh review + audit PASS                                                                            |

Empty for T4.1 itself: it is leader-authored and merged through the normal
protocol (two CodeRabbit cycles plus the gates), not by the automation.

## W1.10 cutover (C1 → owner setup → C2 → C3)

W1.10 lands cutover step **C1** (ADR-0004 D-H.3.1; `docs/methods-w1-10.md`).
Every App path is built but switches on only when its repository variable
is set; until then the interim credentials below stay in use. The target
state is `policy/templates/github-settings.json`, and `settings-drift`
reports the distance to it.

Environments (each: custom branch policy, exactly `main`):

| environment  | jobs                                                                                                         | secrets (interim in brackets)                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `cq-verdict` | `cq-policy` judge, `cq-verify` judge, `cq-accept` judge, `settings-drift`                                    | `CQ_VERDICT_APP_KEY` [`CQ_SETTINGS_TOKEN`]                                  |
| `promote`    | `cq-gate` decide                                                                                             | `CQ_PROMOTER_APP_KEY` [`PROMOTE_TOKEN`]                                     |
| `automation` | `self-merge-prs`, `self-review-loop` (privileged), `sync-merge-queue`, `init-merge-queue`, `ratchet-propose` | `CQ_AUTOMATION_APP_KEY`, `Z_AI_API_KEY` [`CQ_AUTOMATION_TOKEN`, `GH_TOKEN`] |
| `drill`      | `live-review`, `live-merge`, `live-drivers`                                                                  | `CQ_DRILL_MERGE_TOKEN`, `GH_TOKEN`, `Z_AI_API_KEY`, `DEEPSEEK_API_KEY`      |

Only `drill` may have the owner as a required reviewer. The target state has
no repository-level secrets. The two `drill` GitHub tokens have different
scopes: `CQ_DRILL_MERGE_TOKEN` (`live-merge`) is a classic token with `repo`
plus `read:org`; `GH_TOKEN` (`live-review`) is a fine-grained PAT scoped to
its scratch repositories.

Repository variables: `CQ_VERDICT_APP_ID` and `CQ_VERDICT_APP_CLIENT_ID`
(verdict App: the client id mints the posting token, the numeric id drives
the gate's verdict selection, cq-accept's sweep dedupe and the drift
check); `CQ_PROMOTER_APP_ID` and `CQ_PROMOTER_APP_CLIENT_ID` (promoter App:
the client id mints the gate's push token, the numeric id is R1's bypass
actor). Each pair is set together or not at all: every verdict poster,
`cq-gate` and `settings-drift` refuse when exactly one of a pair is set.
Then the trust set `CQ_MERGE_TRUSTED_BOTS`,
`CQ_MERGE_ACCEPT_REVIEW_STATES`, `CQ_MERGE_TRUSTED_ASSOCIATIONS` and the
posture `CQ_MERGE_PROTECTED_PATHS` (blank = the conservative default).

Interim credentials (reported by the drift check until C3):

- `PROMOTE_TOKEN` — the promotion PAT. Read by the legacy
  `merge-queue-gate` (repository-level during C1) and by `cq-gate` only at
  its push. While `CQ_AUTOMATION_TOKEN` is absent it is also the sync/init
  fallback, and opening the sync PR then needs Pull requests read/write.
  Re-scope it to a fine-grained PAT with only Contents read/write, Workflows
  write and Metadata read once `CQ_AUTOMATION_TOKEN` exists (owner step 2),
  never before.
- `CQ_AUTOMATION_TOKEN` — the sync PR, the init bootstrap and the baseline
  proposals (Pull requests read/write, Contents write).
- `CQ_SETTINGS_TOKEN` — read-only fine-grained PAT (Administration,
  Environments, Secrets, Actions: read) for the drift check.

The scheduled drift check does not cover the Actions event policy: GitHub
serves `actions/policies` only to Administration: **write**, and the drift
credentials stay read-only by design (a verdict identity that could rewrite
the rulesets pinning its own checks would collapse the ADR-0004 identity
split). It reports the policy as unchecked (a `notice:` line). The owner
covers it by running the check locally with an owner/admin credential in
`GH_TOKEN`:

```sh
node scripts/github-settings-drift.mjs --repository=<owner>/<name> \
  --verdict-app-id=<n> --promoter-app-id=<n> --require-event-policy
```

`--require-event-policy` makes a refused event-policy read an error
(exit 2) instead of a notice.

Owner steps, in order (the RS-11 wizard outline):

1. Register the three Apps (`cq-verdict`, `cq-promoter`, `cq-automation`),
   install them on this repository only, and set the four App variables
   (each id together with its client id).
2. Create the four environments with the `main`-only branch policy; put
   each App key and interim secret into its environment above. In
   particular, provision `CQ_AUTOMATION_TOKEN` in `automation` now, before
   step 3: `sync-merge-queue` and `init-merge-queue` fall back to
   `PROMOTE_TOKEN` only while it is a repository-level secret (an
   `automation` job cannot read a secret held in `promote`). Skip this and
   step 3 disarms sync (the behind/diverged sync PR fails with "sync not
   armed"), and init fails with no checkout credential.
3. **Prerequisite: arm the trust set.** With the blank conservative default
   (no bots, `APPROVED` only, human `OWNER`/`MEMBER`/`COLLABORATOR`) no PR in
   this solo-identity repository reaches acceptance, because the owner
   authors every PR. Set `CQ_MERGE_TRUSTED_BOTS` (the solo-maintainer
   profile: `coderabbitai[bot]`) and `CQ_MERGE_ACCEPT_REVIEW_STATES` as
   needed. Then confirm that a `cq-gate` run reported `would-promote` or
   `promoted`, or at least that its per-PR `acceptance PR #<n>` lines
   pass. Only then move `PROMOTE_TOKEN` from the repository into `promote`.
   From there the legacy gate fails closed and `cq-gate` carries every
   promotion. Skip the prerequisite and every promotion except break-glass
   stops.
4. Delete the remaining repository-level secrets; run `settings-drift` until
   the only drift left is the rulesets.
5. **C2:** apply the rulesets from `github-settings.json` (R2 requires
   `cq/policy`, `cq/ratchet`, `cq/acceptance` from the verdict App), remove
   classic branch protection, delete `merge-queue-gate.yml`.
6. **C3:** land the D11 attestation, then retire the interim PATs.

Fails closed, and when: the legacy gate once `PROMOTE_TOKEN` leaves the
repository level (step 3); `cq-gate` whenever neither the promoter App nor
`PROMOTE_TOKEN` is reachable; `settings-drift` until armed (the verdict App
or `CQ_SETTINGS_TOKEN`) and while the App variables are unset; the sync PR
path without an automation credential.

Break-glass (ADR-0004 D-H.4): an admin push to `main` under R0/R1's admin
bypass, recorded in the ruleset audit log. Until C3 it is also the only
path for a protected-path change that the gate refuses as needs-human.
