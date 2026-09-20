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

Criterion: at least 5 consecutive PRs processed end-to-end by the scheduled
automations, where a needs-human outcome exits fine and is logged — a silent
failure (a red or ghost run with no honest outcome in the log) is not a
processed PR and never counts toward the criterion. A lane-leader hand-merge
counts as the recorded processing path only when the automation actually
classified the PR `awaiting` under the single-identity I2 deviation; with the
automation red and never classifying a PR, nothing was processed and the
criterion is not met.

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

Convention: automation-authored PRs carry a `[automation]` title prefix and
the `cq-automation` label so they stay distinguishable under the single
shared account. They classify `awaiting` until a second identity exists; the
lane leader hand-merges each after full gates and logs it here.

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
assert and never classified any PR, so the lane leader merged each PR by hand.
A hand-merge counts as the recorded processing path only when the automation
actually classified the PR `awaiting` under the single-identity I2 deviation;
with the automation red, none of these count toward the soak criterion.

| PR                                                                  | merged SHA                                 | date       | reason                                                                                   | gates evidence                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#192 (T4.2)](https://github.com/camerontaylor/cq-toolkit/pull/192) | `3b3775633c461ecd6391969a023505a64d71e85d` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `0ba2753` green — `static` ×2, `denylist` ×2, `ratchet` ×2, `from-source` ×2, `pack-audit`, `build+test` ×2 |
| [#194 (T4.3)](https://github.com/camerontaylor/cq-toolkit/pull/194) | `a6011346f2cc4ad4370acf45f964ba8a30e5a046` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `cf00699` green — same required-check set                                                                   |
| [#196 (#193)](https://github.com/camerontaylor/cq-toolkit/pull/196) | `ed2f8fb889f0f0a612088401419cf424d556bcf1` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `0987343` green — same required-check set                                                                   |
| [#197 (T4.4)](https://github.com/camerontaylor/cq-toolkit/pull/197) | `51c81eb068f43e3c890f874cd90e57a9d966e428` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | PR body §Verification: CI on final head `3ab3db2` green — same required-check set                                                                   |
| [#198](https://github.com/camerontaylor/cq-toolkit/pull/198)        | `0d76ed5b410b413309d33e4d4e11eaee146db099` | 2026-09-20 | lane-leader merge; scheduled automation red at `GH_TOKEN` (no `awaiting` classification) | `gh pr checks 198`: all required checks green; fresh review + audit PASS                                                                            |

Empty for T4.1 itself: it is leader-authored and merged through the normal
protocol (two CodeRabbit cycles plus the gates), not by the automation.
