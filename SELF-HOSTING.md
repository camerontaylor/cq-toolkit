# SELF-HOSTING

DoD 2 evidence: this repository's own PR history showing queue promotion,
ratchet diffs, and automation-authored replies/resolutions — the toolkit
running on itself, recorded rather than claimed.

Link format: every entry in every table below is the PR URL plus the
workflow run URL. An entry without both is a claim, not evidence.

## Soak (ws-k stage-2 acceptance)

PRs processed end-to-end by the toolkit's own automation: 0

Criterion: at least 5 consecutive PRs processed end-to-end by the scheduled
automations, where a needs-human outcome exits fine and is logged — a silent
failure (a red or ghost run with no honest outcome in the log) is not a
processed PR and never counts toward the criterion. Hand-merge due to the
single-identity I2 deviation is the recorded form of processing, not an
intervention failure: it is logged below and counts.

## Queue promotions

| PR   | merged SHA  | promotion run URL                                                |
| ---- | ----------- | ---------------------------------------------------------------- |
| T4.1 | `<this PR>` | `<filled by the next landed PR — promotion postdates the merge>` |

Ordering note: the first entry proves T4.1 itself was promoted. The
promotion run URL lands in the FOLLOWING landed PR, because the promotion
run does not exist until after the merge — this is the recorded deviation
noted in the T4.1 PR body.

## Ratchet self-evidence

| evidence                                                     | link       |
| ------------------------------------------------------------ | ---------- |
| only-tightening baseline PR merged via proposeBaselineUpdate | TBD (T4.5) |
| monotonic-guard drill — a loosening PR rejected              | TBD (T4.5) |

## Automation-authored PRs (I2)

Convention: automation-authored PRs carry a `[automation]` title prefix and
the `cq-automation` label so they stay distinguishable under the single
shared account. They classify `awaiting` until a second identity exists; the
lane leader hand-merges each after full gates and logs it here.

Note: with `CQ_AUTOMATION_TOKEN` not yet provided, ratchet proposals
self-skip — the label convention lands with the first automation-authored PR
(recorded in T4.5's disposition).

| PR  | gates | hand-merge note |
| --- | ----- | --------------- |

## Hand-merge log

Every row's reason is the recorded deviation itself:
`single-identity I2 awaiting`.

| PR  | date | reason | gates evidence |
| --- | ---- | ------ | -------------- |

Empty for T4.1 itself: it is leader-authored and merged through the normal
protocol (two CodeRabbit cycles plus the gates), not by the automation.
