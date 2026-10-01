# §7 adversarial suite

The `adversarial-suite` workflow is a manual dispatch. It targets only
[`camerontaylor/cq-scratch-v11-adversarial`](https://github.com/camerontaylor/cq-scratch-v11-adversarial)
and uses a separate test identity for attacker actions. Never point an attack
at `cq-toolkit`, its merge queue, or a release branch. The private scratch
repository and its [open fixture PR #1](https://github.com/camerontaylor/cq-scratch-v11-adversarial/pull/1)
were created for this suite and are retained for G2 audit. Add the scratch
repository to the owner's deletion list.

## Evidence contract

For each row and each profile, retain the attack input and its GitHub URL or
local process transcript, the observed rejection / needs-human / not-eligible
result, and a permanent regression test. A setup failure, unavailable identity,
missing App, absent ruleset, or an unexecuted attack is **BLOCKED**, never PASS.
The dispatch summary must identify the scratch repository, exact attack PR
head and workflow run, attacker identity, selected profile, row, attack action,
observed verdict, and evidence location. A fresh auditor at G2 independently
checks that the attack ran and that its target guard produced the claimed
result. A unit test alone does not establish a live row verdict.

The initial runner submits A1 and A15 review attacks when given a disposable
scratch PR number. It records those submissions as BLOCKED because it does
not yet observe the policy outcome independently. Other W1 live attack
drivers remain unimplemented. Local regressions document guard behavior but
do not make a live row green.

The profiles are `blank` (conservative defaults) and `solo-maintainer`
(configured relaxation). Every trust row runs under both. A10, A11, and A17
also require `CQ_SANDBOX=required` with a certified backend. If no certified
backend exists on the runner, those legs are BLOCKED. Do not interpret a
fail-closed missing-backend error as a completed confined-worker attack.
The dispatch matrix labels the two profiles but does not yet configure or
verify the scratch repository's policy variables for either profile. Its
evidence therefore cannot establish a profile verdict until that setup is
implemented and verified. The jobs run serially to avoid cross-profile
repository-setting races.

## Row inventory

| Rows             | Attack target                                                  | Live prerequisite                                                                                  | Status before dispatch                   |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A1, A3, A15, A20 | Foreign approval, opinion and skip marker                      | Second GitHub identity; scratch PRs; review-loop and merge checks                                  | BLOCKED until identity and scratch setup |
| A2, A4           | Stale approval and fake thread-resolution commit               | Scratch PRs; acceptance checks and state branch                                                    | BLOCKED until scratch setup              |
| A5, A6, A14      | Ratchet, baseline, coverage and protected workflow edits       | Scratch templates, live D11 ruleset and promotion gate; App identities for final provenance claims | BLOCKED until live controls are verified |
| A10, A11, A17    | Forbidden subprocess tools and worker credential/push attempts | Scratch worker job; second identity; certified backend for required-mode legs                      | BLOCKED until live worker setup          |
| A12, A12b, A12c  | Governed budget, crash/resume and advisory refusal             | W2.3 governed runner completion                                                                    | Dependency-blocked; no verdict           |
| A13              | Fixer workspace and fault isolation                            | W6.1/W6.3 eval completion                                                                          | Dependency-blocked; no verdict           |
| A18              | Peak/quota deferral                                            | W2.6 provider guard completion                                                                     | Dependency-blocked; no verdict           |
| A19              | Config precedence and provenance                               | W3.6 config completion                                                                             | Dependency-blocked; no verdict           |

The full §7 G2 suite also includes A7–A9 and A16. Their workstream owners
must contribute attack evidence and permanent regressions before G2; this
initial W1 lane does not claim them.

## Release-lane dependency

The release lane reports that the live rulesets API returned `[]` and #225/#226
remain open: `cq-state` job guards are merged, but its write restriction is
not live. Registration and installation of the `cq-verdict`, `cq-promoter`,
and `cq-automation` Apps and their real App IDs remain pending. Both self-host
workflows are `disabled_manually`. The new scratch repository's rulesets API
also returned an empty list. Its fixture PR is ready, but no second test
identity token has been reported. These are external blockers, not
passing attack outcomes. A14 cannot claim real App/token provenance or
protected promotion from template inspection alone. Record the actual GitHub
App and ruleset responses in scratch evidence after setup. Do not modify
release PRs #216, #228, or #229.

The dispatch environment `adversarial-scratch` needs a primary credential in
`CQ_ADVERSARIAL_TOKEN` scoped to the scratch repo and a **different account's**
credential in `CQ_ADVERSARIAL_SECOND_TOKEN` with permission to review its PRs.
The available owner credential created the private repository and PR,
but it is a broad owner credential and is not provisioned to the dispatch
environment. Neither required environment secret is currently confirmed.
