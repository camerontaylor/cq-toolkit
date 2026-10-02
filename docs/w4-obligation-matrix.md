# W4 — the required-check obligation matrix and the required-contexts reconciliation

Status: **proposal.** Nothing in this document is applied. Every change it
describes touches an outward-facing, owner-governed declaration site
(`policy/protected-paths.json`, `scripts/denylist-scan`,
`policy/templates/github-settings.json`, a workflow template or instance, or
the live rulesets / branch protection). Application happens at promotion time,
by the owner, as one atomic change set — never piecemeal.

Evidence base: `origin/main` = `origin/merge-queue` = `70de728` (read on
2026-10-02, the date the spec's review pass was taken), the live GitHub API
for this repository, and the superseded plan
`toolkit-research-validation-efficiency/plans/ralplan-agent-validation-efficiency.md`
§4 (`:133-141`). Every claim below carries a `file:line` or an API read.

Normative inputs: the execution-policy spec
(§Constraints required-contexts paragraph and the W4 safeguards; §Acceptance
Criteria "C — Gate venue" bullet 4; §Topology component C), and
`policy/DOCTRINE.md` invariants I4 (required triggers never filter; missing or
skipped = failing) and I5 (missing evidence is non-passing).

## 1. The obligation matrix — every declaration site × every context, today

### 1.1 The declaration sites

There are **seven** live declaration sites, not four. The four named in the
spec are the in-repo policy ones; three more are enforced by GitHub itself and
by the _successor_ promotion gate, and the two GitHub-side surfaces differ
from each other.

| #   | Declaration site                                     | Evidence                                                                                                                                                                                            | Unit                                         | Declares today                                                                                                                                              | Enforced by                                                                                                                                                                                        |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `policy/protected-paths.json` → `requiredChecks`     | `:15`                                                                                                                                                                                               | context name                                 | `static`, `denylist`, `ratchet`                                                                                                                             | D11 `cq/policy` (`src/ops/gates/policyDiff.ts:606`); mechanically tied to S3 by `test/ops/gates/policyDiff.test.ts:1132-1137`                                                                      |
| S2  | `scripts/denylist-scan` → `REQUIRED_WORKFLOW_CHECKS` | `:165-173`                                                                                                                                                                                          | (workflow file, check) pair                  | `denylist.yml:denylist`, `ci.yml:static`, `ratchet.yml:ratchet`                                                                                             | the I4 self-test: file exists, declares a job of exactly that id at first indent with no `name:` override, both triggers unfiltered (`:150-164`, `:174-179`)                                       |
| S3  | legacy promotion gate wait list                      | `.github/workflows/merge-queue-gate.yml:93`; template `policy/templates/merge-queue-gate.yml:92`; token `policy/templates/instances.json:58`                                                        | context name                                 | `static,denylist,ratchet`                                                                                                                                   | the gate itself: fail-closed on empty (`:94-99`), 20-min deadline (`:100`, `:165-168`), per-name verdict fold (`:119-157`)                                                                         |
| S4  | ruleset template `R2`                                | `policy/templates/github-settings.json:61-75` (contexts `:65-73`, `strict_required_status_checks_policy: false` at `:63`); ruleset target `merge-queue` at `:39-44`                                 | (context, `integration_id`)                  | `cq/policy`, `cq/ratchet`, `cq/acceptance` (pinned `{{VERDICT_APP_ID}}`); `static`, `denylist`, `from-source`, `pack-audit` (pinned 15368 = GitHub Actions) | GitHub, **at C2 only** — `classicBranchProtection` is `null` for both branches (`:80-83`) and the repository has **zero live rulesets** (API `repos/camerontaylor/cq-toolkit/rulesets` → length 0) |
| S5  | live classic protection, `main`                      | API `branches/main/protection`                                                                                                                                                                      | (context, app)                               | `static`, `denylist`, `ratchet`, all app 15368; `strict` unset                                                                                              | GitHub, on PRs into `main`                                                                                                                                                                         |
| S6  | live classic protection, `merge-queue`               | API `branches/merge-queue/protection`                                                                                                                                                               | (context, app)                               | `static`, `denylist`, `from-source`, `pack-audit` (app 15368) **+ `ratchet` with `app_id: null`**                                                           | GitHub, on PRs into `merge-queue` (this is what blocks a queue merge, per `policy/templates/README.md:108`)                                                                                        |
| S7  | successor promotion gate                             | `.github/workflows/gate.yml:257` (`--verifiedWorkflows=ci.yml,denylist.yml`), `:258` (`--timeoutMin=20`); template `policy/templates/gate.yml:38,42`; token `policy/templates/instances.json:33-34` | **workflow file path** + one verdict context | `ci.yml`, `denylist.yml`, plus the tip's `cq/ratchet` verdict (`src/selfhost/promote-gate.ts:980-996`)                                                      | the gate, running `trust/dist/selfhost/promote-gate.js`                                                                                                                                            |

Both promotion gates are `active` on GitHub today
(`actions/workflows/merge-queue-gate.yml` → `state: active`;
`actions/workflows/gate.yml` → `state: active`). They are not alternatives: the
legacy gate fired on the last candidate push (run `36952171986`,
`push`/`merge-queue`, `2026-10-02T01:41:55Z`) while the successor's
`workflow_run` leg has fired 4 times against 96 `schedule` sweeps in the
retained API window. `policy/templates/README.md:14` calls the legacy one
LEGACY (retires at C2) and `:15` the successor the P1 promotion job.

### 1.2 The disagreement, stated explicitly

The spec's framing is right and incomplete. Precisely:

1. **Three sites say `static`/`denylist`/`ratchet`** — S1, S2, S3. These three
   are consistent with each other and S1≡S3 is _machine-enforced_
   (`policyDiff.test.ts:1132-1137` parses the gate's `echo '…'` argument and
   asserts list equality).
2. **The ruleset template lists seven** — S4 — including `cq/*` and
   `from-source`, and it does **not** list the plain `ratchet` context: the
   recorded supersession is `ratchet` → `cq/ratchet`
   (`test/ops/gates/protectedPaths.test.ts:317-319`, documented at
   `docs/methods-w1-10.md:243`).
3. **`from-source` is deliberately not a required check** — `.github/workflows/ci.yml:64-72`
   and the template narrative at `policy/templates/required-check.md:105-113`
   ("A companion job, not a required check … so this job's presence cannot
   dangle a branch-protection wait"), with `REQUIRED_WORKFLOW_CHECKS` named as
   the enumeration that stays `{denylist, static, ratchet}`. Yet S4 _requires_
   `from-source` and S6 _requires_ it. The narrative and the ruleset template
   contradict each other inside one repository.
4. **Live `main` and live `merge-queue` protection disagree with each other**
   (S5 vs S6): `from-source` and `pack-audit` are required on `merge-queue` and
   absent on `main`, and `ratchet` is app-unpinned (`app_id: null`) on
   `merge-queue`. The spec's "four lists" counts none of this, because the
   rulesets it imagines do not exist yet.
5. **The successor gate declares a fourth kind of thing** — workflow _paths_,
   not contexts (S7) — and its aggregate is stronger than any list in the
   repository: `checkVerifiedRun` (`src/selfhost/promote-gate.ts:487-536`)
   requires `conclusion === 'success'` on the newest `push` run for that file
   on the tip **and every job in that run `completed`/`success`** (`:520-527`).
   So `ci.yml` and `denylist.yml` are promotion-blocking **in full**,
   including `from-source`, while `ratchet.yml` is not in the list at all and
   is represented instead by the `cq/ratchet` verdict.

Consequence 5 is the one that matters most for the macOS work: **a job added to
`ci.yml` is promotion-blocking the moment it exists**, under S7, whether or not
any list names it. "Initially non-required" is only true with respect to S1–S6.

### 1.3 What actually ran on the candidate SHA (measured, not asserted)

Check-runs on `70de728` (API, `filter=latest`, all pages), selected rows:

| context               | app                      | started  | completed | duration |
| --------------------- | ------------------------ | -------- | --------- | -------- |
| `static` (run 1)      | github-actions           | 01:46:40 | 01:51:44  | 5m04s    |
| `ratchet` (run 1)     | github-actions           | 01:46:39 | 01:51:19  | 4m40s    |
| `from-source`         | github-actions           | 01:46:39 | 01:46:51  | 12s      |
| `denylist`            | github-actions           | 01:46:40 | 01:46:53  | 13s      |
| `static` (run 2)      | github-actions           | 01:41:57 | 01:46:11  | 4m14s    |
| `ratchet` (run 2)     | github-actions           | 01:41:57 | 01:46:32  | 4m35s    |
| `from-source` (run 2) | github-actions           | 01:41:57 | 01:42:10  | 13s      |
| `denylist` (run 2)    | github-actions           | 01:41:57 | 01:42:04  | 7s       |
| `cq/ratchet`          | github-actions (interim) | 01:47:54 | 01:47:54  | ~0s      |
| `cq/policy`           | github-actions (interim) | 01:42:30 | 01:42:30  | ~0s      |

Also present on that SHA: `measure`, `gate`, `wake`, `decide`, `sync`,
`signal`, `propose`, `drift`. **Absent: `pack-audit` and `cq/acceptance`.**
Both absences are structural, not incidental:

- `pack-audit.yml:25-27` triggers on `pull_request` + `workflow_dispatch`
  only — **no `push`**. It therefore never produces a check run on a
  merge-queue _push_ commit, which is the surface S3 and S7 read.
- `cq-accept.yml:57-65` is `workflow_run` on `cq-signal` + a 15-minute
  `schedule` + `workflow_dispatch`: it posts on **PR heads**, never on a push
  tip.

Two timing facts the promotion decision needs: the binding leg today is
`static` at 5m04s against a 20-minute gate deadline (`merge-queue-gate.yml:100`
and `gate.yml:258`), i.e. **~4× headroom**, and two runs of the same job on the
same SHA differed by 16% (`static` 5m04s vs 4m14s) and 1.8% (`ratchet` 4m40s vs
4m35s) — the same order as the spec's own two-baseline comparison (19%). That
variance is larger than any saving consolidation could offer (§4).

## 2. The reconciled required set

### 2.1 One set, two venues — the reconciliation rule

The lists cannot all be made equal, because they answer different questions.
The rule that makes them agree _where they must_:

> **Rule R.** `protected-paths.json:requiredChecks` ≡ the legacy gate's
> `{{GATE_CHECKS}}` (already machine-enforced) ≡ _exactly the contexts a push to
> `merge-queue` produces on the tip_. Branch protection (S4/S5/S6) is a
> **superset**: it may add contexts that are produced on _PR heads_ instead
> (`pack-audit`, `cq/acceptance`). The successor gate (S7) is a **different
> projection**: workflow paths whose runs must be wholly green on the tip.

Two invariants fall out, and both are already the live behaviour:

- Anything in the legacy gate list must be push-produced. Putting
  `from-source` or `pack-audit` into `{{GATE_CHECKS}}` today would stall every
  promotion for the full 20 minutes and then refuse
  (`merge-queue-gate.yml:165-168`) — a total queue freeze, not a red PR.
- Anything in a verified workflow is implicitly required _for promotion_ whether
  or not a list says so.

### 2.2 The proposed set

| context                       | producer (file:job)     | what it obligates                                                                                                                                                            | suite scope                                         | OS            | subject / trust class                                                                                | venues                                                                   |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `static`                      | `ci.yml:20`             | TS7 compiler ratchet + typed Oxlint (`:41-42`), format (`:43-44`), full suite plain (`:45-48`), Knip (`:49-50`), checked emit (`:54-55`), generated op-docs drift (`:61-62`) | `test:unit` + `test:e2e` = whole default discovery  | ubuntu-latest | head-defined PR/push; app 15368; `contents: read`; subject runs its own code                         | S1 S2 S3 S4 S5 S6 S7 (via `ci.yml`)                                      |
| `denylist`                    | `denylist.yml:20`       | denylist scan + gitleaks + the I4 self-test over `REQUIRED_WORKFLOW_CHECKS`                                                                                                  | —                                                   | ubuntu-latest | head-defined; app 15368; `contents: read`                                                            | S1 S2 S3 S4 S5 S6 S7 (via `denylist.yml`)                                |
| `ratchet` (legacy)            | `ratchet.yml:63`        | typecheck-**count** ratchet (`:88-102`), coverage ratchet over the whole suite instrumented (`:103-118`), base-diff baseline monotonicity guard, PR legs only (`:119-135`)   | `npx vitest run --coverage` (whole suite incl. e2e) | ubuntu-latest | head-defined; app 15368; `contents: read`; **verdict data produced by the head's own `dist/cli.js`** | S1 S2 S3 S5 S6 — **not** S7                                              |
| `cq/ratchet`                  | `cq-verify.yml` `judge` | trust-built recomputation of typecheck-count over the attribute-free head tree; **coverage accepted as untrusted head-executed data** (`cq-measure.yml:3,96-101`)            | instrumented suite (as measurement)                 | ubuntu-latest | default-branch verifier; verdict App at C2 (`github-settings.json:66-68`)                            | S4 (target), S7 (live, app 15368 interim)                                |
| `cq/policy`                   | `cq-policy.yml`         | D11 protected-path + required-check policy diff over the trust-ref lists                                                                                                     | —                                                   | ubuntu-latest | default-branch verifier                                                                              | S4 (target)                                                              |
| `cq/acceptance`               | `cq-accept.yml`         | I2 independent-review acceptance                                                                                                                                             | —                                                   | ubuntu-latest | default-branch verifier                                                                              | S4 (target) — **PR heads only**, so never S3/S7                          |
| `from-source`                 | `ci.yml:73`             | build the CLI, drive a real governed plan through `dist/` (`scripts/smoke-run-plan.mjs`)                                                                                     | 2 governed jobs, not the suite                      | ubuntu-latest | head-defined; app 15368                                                                              | S7 **de facto** (all-jobs aggregate); S4 and S6 name it; S1/S2/S3 do not |
| `pack-audit`                  | `pack-audit.yml`        | `npm pack` + `files` allowlist + denylist scan of the unpacked tree                                                                                                          | —                                                   | ubuntu-latest | head-defined; app 15368; **`pull_request` only**                                                     | S4, S6 — **never S3/S7**                                                 |
| `static-macos` (proposed, §3) | lane M's job            | `test:unit` + `test:e2e` on macOS                                                                                                                                            | whole default discovery                             | macos-latest  | head-defined; app 15368                                                                              | S7 if it lands inside `ci.yml`; otherwise nowhere until promotion        |

### 2.3 The `cq/*` versus plain-name question — resolved

**Recommendation: keep the namespace split as the trust discriminator. Plain
names are GitHub-Actions-produced contexts; `cq/*` are verdict-App-produced
contexts.** `static-macos` therefore joins the plain group, pinned to 15368 in
R2 and unnamed in the legacy gate list until promotion. Do **not** mint a
`cq/macos`, and do **not** pin any workflow-produced context to
`{{VERDICT_APP_ID}}`.

Consequence, and it is the reason this is not cosmetic: the template's own
`_doc` (S4) records the failure mode — "R2 pins `cq/policy`, `cq/ratchet` and
`cq/acceptance` to the verdict App's numeric id, but until the App is
registered and minting tokens … Applying R2 in that state requires check runs
the queue cannot produce, so every merge-queue PR becomes unsatisfiable."
A `cq/*` name is a claim that an App minted the verdict; a workflow job cannot
honour it. Conversely, renaming `static` to `cq/static` would move a
head-defined obligation into the App-pinned group — a trust _upgrade_ nobody
authorised, and unsatisfiable while the App is absent.

Corollary for this change set: `static-macos` adds **no new supersession** to
`test/ops/gates/protectedPaths.test.ts:317-319`. The single recorded
supersession stays `ratchet` → `cq/ratchet`, and its documentation assertion
(`:341-345`, the methods-note Residuals text) is untouched by it.

### 2.4 `from-source` — resolved

**Recommendation: declare it required (make the de facto the de jure).** The
evidence says it is already binding for promotion: it lives in `ci.yml`, whose
run S7 requires job-by-job (`promote-gate.ts:520-527`), it reports on every
push and pull_request unfiltered (I4-clean), and it costs **12–13s** measured
(§1.3). Registering it changes no enforcement outcome; it only makes an
invisible obligation visible in the places an operator reads.

Consequences of the recommendation, all owner-governed:

- `ci.yml:64-72` and `policy/templates/required-check.md:105-113` must be
  rewritten in the same change — their current text ("deliberately not a
  required check") becomes false the moment it lands, and a template that
  contradicts its own ruleset is exactly the drift this document exists to end.
- `REQUIRED_WORKFLOW_CHECKS` gains `{ workflow: 'ci.yml', check: 'from-source' }`.
  The I4 leg will then police it: the job exists, its id is `from-source`, it
  carries no `name:` override, and `ci.yml`'s `on:` block stays unfiltered. It
  already satisfies all four (`:73-77`), so the leg passes without a workflow
  edit beyond the comment.
- The legacy gate list becomes `static,from-source,denylist,ratchet`
  (S1 ≡ S3 by Rule R), and `from-source` is push-produced, so the gate's wait
  is satisfiable.
- Live protection on **both** branches must gain it; `main` does not have it
  today (S5), which is the one place where adding a requirement is a pure
  tightening.

The rejected alternative — make it genuinely advisory — requires moving it out
of `ci.yml` into its own workflow file, which _weakens_ promotion protection
(S7 would no longer see it). Rejected.

### 2.5 `pack-audit` — the transfer hazard, named

`pack-audit` is required by S4 and S6 and cannot be required by S3 or S7,
because it is `pull_request`-only (`pack-audit.yml:25-27`) and never appears on
a push tip (§1.3). It is the proof that Rule R's "superset" clause is load-
bearing rather than cosmetic.

**Recommendation: leave `pack-audit` exactly where it is** — branch-protection
only, PR-head venue — and never add it to `{{GATE_CHECKS}}` or
`{{GATE_WORKFLOWS}}`. Its existing `on:` block is already the right shape for
its venue: unfiltered `pull_request` so every queue PR is audited (its own
comment at `:19-22` says so). Adding a `push` leg to make it gate-eligible
would be a _new_ obligation on every main and queue push, not a reconciliation,
and is out of scope here.

Open question for the owner (recorded, not decided here): `main` (S5) does not
require `pack-audit` while `merge-queue` (S6) does, even though both are
`pull_request`-produced and could require it symmetrically. This document does
not change that asymmetry; it flags it as a divergence to close (in either
direction) in the same owner-governed pass that applies R2.

### 2.6 Which declaration sites must change, to make them agree

Ordered; every row is applied together or not at all.

| order | site                                                                              | change                                                                                                                                                                                                                    | outward-facing?                                                                         |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1     | `policy/templates/required-check.md:105-113` (+ `:31-42` prose)                   | rewrite the "companion job, not a required check" narrative for `from-source`; add a standalone `ci-macos.yml` template carrying the macOS job body (§3.1)                                                                | no (template, then regenerate)                                                          |
| 2     | `.github/workflows/ci.yml`                                                        | refresh the `from-source` comment only — under the recommended placement (§3.2) no `static-macos` job lands in `ci.yml`                                                                                                   | no (generated instance)                                                                 |
| 3     | `scripts/denylist-scan:165-173`                                                   | add `{ ci.yml: from-source }`; at promotion add `{ ci-macos.yml: static-macos }`                                                                                                                                          | **yes** — protected path (`protected-paths.json:13`)                                    |
| 4     | `policy/protected-paths.json:15`                                                  | `["static","from-source","denylist","ratchet"]`; at promotion add `"static-macos"`                                                                                                                                        | **yes** — protected path                                                                |
| 5     | `policy/templates/merge-queue-gate.yml:92` + `policy/templates/instances.json:58` | `GATE_CHECKS` gains `from-source`; at promotion gains `static-macos`; regenerate the instance                                                                                                                             | no (repo) / **yes** (D11 judges the producer change)                                    |
| 6     | `policy/templates/github-settings.json:65-73`                                     | already lists `from-source` and `pack-audit`; at promotion add `{ "context": "static-macos", "integration_id": 15368 }`. No other R2 edit is proposed: the `cq/*` pinning and the `ratchet` supersession stay as they are | **yes** — target state of live settings                                                 |
| 7     | live rulesets on both branches + classic protection on both branches              | add `from-source` to `main`; add `static-macos` at promotion; decide the `main`/`pack-audit` asymmetry                                                                                                                    | **yes** — owner-only, via the W7.3a wizard (`policy/templates/README.md:27`) or the API |

Item 7 is the only genuinely outward-facing step and the only one this lane
cannot perform. Everything above it is reviewable in a normal PR.

**What must NOT change:** the legacy gate's 20-minute deadline unless §3.3's
evidence demands it; `strict_required_status_checks_policy` (`:63`) is
deliberately `false` — a PR head can be green while stale against its base, and
that is precisely why candidate evidence is read from the queue tip, not the PR
head (spec §C bullet 1); and `protected-paths.json:protectedPaths`, whose
entries are the D11 trust anchors.

## 3. The macOS insertion plan — `static-macos`, when it is promoted

### 3.1 Where the context goes, per site

| site                                                                                  | insertion                                                                                                       | notes                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/templates/required-check.md`                                                  | a standalone `ci-macos.yml` template with its own job body, not a matrix                                        | a matrix would rename the check runs (`static (ubuntu-latest)`), breaking the S1/S2 pairing and every `name:`-identity rule the I4 leg polices (`scripts/denylist-scan:150-157`); the template's `{{RUNNER}}` slot is single-valued (`:33-39`), so a macOS job needs its own body with `macos-latest` |
| `.github/workflows/ci.yml`                                                            | no `static-macos` job under the recommended placement; only the `from-source` comment refresh                   | a job added here is bound by S7 all-jobs aggregate from birth, before any list names it (§1.2 consequence 5, §3.2)                                                                                                                                                                                    |
| `policy/templates/ci-macos.yml` + its instance `.github/workflows/ci-macos.yml` (new) | the `static-macos` job: `runs-on: macos-latest`, `test:unit` + `test:e2e`, unfiltered `on:`, no job-level `if:` | its own file is what makes "initially non-required" true in every venue (§3.2); the price is that macOS and Linux legs can no longer be throttled by one workflow                                                                                                                                     |
| `scripts/denylist-scan:165-173`                                                       | `{ workflow: 'ci-macos.yml', check: 'static-macos' }`                                                           | job id must equal the check name, no `name:` override, and the I4 leg then polices it forever                                                                                                                                                                                                         |
| `policy/protected-paths.json:15`                                                      | `"static-macos"`                                                                                                | the list must stay equal to the gate's wait list (`policyDiff.test.ts:1132-1137`)                                                                                                                                                                                                                     |
| `policy/templates/github-settings.json:65-73`                                         | `{ "context": "static-macos", "integration_id": 15368 }`                                                        | Actions-pinned, plain name (§2.3)                                                                                                                                                                                                                                                                     |
| legacy gate                                                                           | `GATE_CHECKS` in `policy/templates/instances.json:58`                                                           | push-produced, so satisfiable (Rule R)                                                                                                                                                                                                                                                                |
| **successor gate**                                                                    | `GATE_WORKFLOWS` in `policy/templates/instances.json:33` gains `ci-macos.yml`                                   | required under the recommended placement; a no-op in the rejected single-file layout, where S7 already binds the job (§3.2)                                                                                                                                                                           |
| live rulesets + both branches' protection                                             | add the context                                                                                                 | owner-governed, last, same pass                                                                                                                                                                                                                                                                       |

### 3.2 The placement decision (this is the part the spec's list omits)

The spec's promotion list names the template, `protected-paths.json`,
`REQUIRED_WORKFLOW_CHECKS`, `github-settings.json`, the legacy gate's check list
and the live rulesets. It does not name `gate.yml` — because `gate.yml` does not
read contexts. But `gate.yml` enforces `ci.yml` **in full**
(`promote-gate.ts:520-527`), which produces a decision with two outcomes:

- **`static-macos` inside `ci.yml`** (with `static`): promotion needs **no**
  `gate.yml` change — the all-jobs aggregate already binds it. The cost is that
  the job is promotion-blocking from the moment it is added, in the successor
  gate, with **no demotion path except deleting the job**: un-requiring it in
  S1–S6 would leave S7 binding it anyway. The spec's "initially non-required"
  phase is therefore notional in this placement.
- **`static-macos` in its own workflow file** (say `ci-macos.yml`): genuinely
  non-blocking while non-required, because nothing in S1–S7 names it. Promotion
  then costs exactly one token — `GATE_WORKFLOWS` — plus the S1–S6 edits above.
  Demotion is then a clean inverse.

**Recommendation: its own workflow file**, with `ci.yml` untouched. The price is
one more instance in `policy/templates/instances.json` and one more I4 pairing;
the benefit is that "non-required" is true in every venue, that promotion and
demotion are symmetric, and that the W4 promotion set stops depending on a
side effect of S7's aggregate. If the owner prefers the single-file layout for
its runner-pool reasons, the promotion change set must additionally record the
S7 binding as _deliberate_ and the rollback must be "remove the job", not
"un-require the context".

Whichever is chosen, the job must carry **no job-level `if:`**. S7 treats a
skipped job as non-green (`promote-gate.ts:523-527`), and the same skip is what
the `cq-state` ledger uses in `static`/`denylist`/`ratchet`; on
`merge-queue` pushes that guard never fires, but a future guard added to the
macOS job would convert an infrastructure skip into a queue freeze.

### 3.3 The 20-minute interaction

The gate refuses after 20 minutes (`merge-queue-gate.yml:100`, `:165-168`;
`gate.yml:258` → `promote-gate.ts:1036-1039`). Promotion therefore requires
**max < 20 min**, not only p90 ≤ 15 min. Measured headroom today is 4×
(5m04s binding leg). The macOS leg has no such headroom in advance: the spec
expects an unmodified suite to exceed 15 min on a macOS runner if the trace's
per-spawn hypothesis holds, which is why the promotion clock starts only after
E's top-10 reduction merges.

**Recommendation: do not pre-emptively raise the wait.** Raise
`{{GATE_TIMEOUT_MIN}}` (both instances, `policy/templates/instances.json:34`
and `:59`, and therefore both templates) **in the same change** as the macOS
promotion, and only if the 10-candidate pilot shows max ≥ 15 min. Two reasons:
(i) a raised wait is a weaker gate for every other obligation, so paying for it
before the evidence is a pure cost; (ii) `gate.yml`'s `decide` job has a fixed
40-minute timeout (`gate.yml:129`) and `policy/templates/README.md:53` warns
that the wait plus checkout/install/build must stay inside it — raising the wait
without re-deriving that bound trades one fail-closed mode (a clear refusal) for
another (a killed job with no report). Both instances must move together; they
are the same token in two files and the render test compares them.

Queue time and run time must be recorded separately in the promotion decision
(spec §C bullet 4): a macOS pool is smaller, so a 15-minute run can arrive
inside 20 minutes or not at all depending on queueing.

### 3.4 Demotion

Demotion is the exact inverse of §2.6's table with the §3.2 caveat: remove
`static-macos` from S6/S4 first (outward-facing, owner), then from S1 and S3
together (they are machine-tied), then from S2, and — if the job lives in
`ci.yml` — **remove the job itself**, because S7 keeps it binding until it is
gone. Record the breach reason in the PR. Never leave S7 binding an obligation
no list names: that is the "silent obligation" state this document was written
to eliminate.

## 4. Consolidation analysis — the "the suite runs twice per push" constraint

### 4.1 The duplication, measured

|                   | `static`                                                                                                                                                                                    | `ratchet`                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| workflow / job    | `ci.yml:20`                                                                                                                                                                                 | `ratchet.yml:63`                                                                                              |
| test legs         | `npm run test:unit` (`:46`) + `npm run test:e2e` (`:48`)                                                                                                                                    | `npx vitest run --coverage` (`:111`)                                                                          |
| selection         | `test:unit` = default discovery `--exclude test/e2e/** --exclude test/driver/acp.test.ts`; `test:e2e` = `test/e2e` + `test/driver/acp.test.ts` (`package.json`) → union = default discovery | default discovery (`vitest.config.ts:22` adds `**/dist/**` to the defaults) → **same file set**, instrumented |
| other obligations | `check:static`, `format:check`, `knip`, `build`, `gen:op-docs:check`                                                                                                                        | typecheck-count ratchet, coverage ratchet, base-diff monotonicity guard                                       |
| checkout          | shallow                                                                                                                                                                                     | `fetch-depth: 0` (guard needs the base diff, `:72-76`)                                                        |
| concurrency       | none                                                                                                                                                                                        | `cancel-in-progress: true` (`:58-60`)                                                                         |
| job timeout       | —                                                                                                                                                                                           | `timeout-minutes: 20` (`:66`)                                                                                 |
| measured          | 5m04s / 4m14s                                                                                                                                                                               | 4m40s / 4m35s                                                                                                 |

So the two executions are the same 152-file suite, one plain and one under v8
coverage, in parallel, in the same ~5-minute window.

### 4.2 Subject/trust equivalence, dimension by dimension (superseded plan §4)

| dimension                         | `static`                                                       | `ratchet`                                                                   | equivalent? |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| subject (PR head / push tip)      | head tree of the event's sha                                   | head tree of the event's sha                                                | **yes**     |
| trust ref                         | none (head-defined)                                            | none (head-defined), and `ratchet.yml:4-5` says so explicitly               | **yes**     |
| producer permissions              | `contents: read`, no credential persistence                    | `contents: read`, no credential persistence                                 | **yes**     |
| toolchain                         | `ubuntu-latest`, node 24, `npm ci`, same immutable action pins | identical                                                                   | **yes**     |
| triggers                          | unfiltered `push` + `pull_request`                             | unfiltered `push` + `pull_request` + dispatch                               | **yes**     |
| suite membership                  | default discovery, split in two invocations                    | default discovery, one instrumented invocation                              | **yes**     |
| test evidence class               | plain pass/fail over the suite                                 | pass/fail **with instrumentation**, plus a metric derived from the same run | **no**      |
| other obligations in the same job | 6 non-test gates                                               | 3 ratchet gates, one of which needs full history                            | **no**      |

### 4.3 Why the equivalence does not license removal anyway

Two blockers, both structural:

1. **The carrier is scheduled to retire, and its successor downgrades the run to
   a measurement.** `ratchet.yml:4-12` is explicit: this is the LEGACY head-
   defined leg, kept only until W1.10's cutover makes `cq/ratchet` required.
   In the successor, `cq-measure` runs `npx vitest run --coverage` as an
   **untrusted head-executed measurement** (`cq-measure.yml:3,96-101`) and
   `cq-verify` _recomputes only the typecheck-count_ from the trust ref
   (`cq-verify.yml:251`), accepting coverage as data. Making the required
   **test** obligation depend on that leg would (a) bind tests to a carrier
   that is being deleted, and (b) bind them to a leg whose verdict is minted
   from untrusted head data — the direction superseded-plan §4 forbids
   ("Do not share executable PR artifacts into trusted signing/verifier jobs";
   "malicious producer artifacts cannot supply trusted verdicts").
2. **Instrumented ≠ plain as a test verdict, and coupling muddies triage.** The
   ratchet's coverage step deletes the stale summary first (`:110`) and asserts
   the metric with `jq -e` in the _same_ step (`:117-118`); a coverage-metric
   failure would then report the test obligation red for a non-test reason.
   Fail-closed, yes — but it merges two obligations into one context and makes
   "did the tests pass?" unanswerable from the check alone.

A third, smaller factor: `ratchet.yml` sets `cancel-in-progress: true`
(`:58-60`). If the plain legs were folded into it, a new push would cancel the
test obligation for the previous push, leaving the gate with zero evidence
rather than two rows. That is fail-closed by design, but it converts ordinary
force-push churn into refusals.

### 4.4 Recommendation: **keep both**, and report what consolidation would be worth

Keep `static`'s plain full-suite run as the **test obligation** and `ratchet`'s
instrumented run as the **coverage-measurement obligation**. They are not
redundant in the only sense that matters — what a green `ratchet` does and does
not say about the tests.

The arithmetic that settles it: candidate time-to-verdict is
`max(static, ratchet)`, currently 5m04s. Folding the tests into `ratchet` would
move the binding leg to 4m40s — a **≤ 8% ceiling, below the 16% run-to-run
variance measured on that binding leg** (§1.3). The saving is real but is
runner-minutes, not the SLO the spec actually governs.

**Reopen this decision only when** the successor trusted leg carries a required
**test verdict** (today it carries none — only a typecheck-count recomputation
and an accepted coverage measurement). At that point consolidation is a
separate task with its own expand/contract migration, an equivalence report,
and its own PR. It is not this one.

### 4.5 Equivalent executions removed — reported

**Zero.** Not one duplicate whole-suite execution is removed by this proposal,
and that is the recommendation, not an omission. The full ledger of duplicates
examined:

| duplicate                                                                         | per push | verdict                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| whole suite, plain vs instrumented                                                | 2        | **retained** — different evidence class, carrier retiring, trust direction wrong (§4.3)                                                                                                                                                                            |
| `npm run build` (`ci.yml:54-55` vs `ratchet.yml:87`)                              | 2        | **retained** — not equivalent: `static`'s `dist/` is consumed in-job by `gen:op-docs:check` (`:61-62`); `ratchet`'s `dist/` _is_ the judge binary (`dist/cli.js`). Removing either needs a cross-job artifact handoff, which forfeits the emit gate's independence |
| `tsc` invocation (`check:static`'s compiler ratchet vs `ratchet.yml:96-100`)      | 2        | **not equivalent** — pass/fail-on-any-error vs a count that must not increase. A count-ratchet pass does not imply type-clean                                                                                                                                      |
| `denylist-scan` over the worktree vs over the unpacked tarball (`pack-audit.yml`) | 2        | **not equivalent** — different trees, different `patterns.yml` (the tarball's own)                                                                                                                                                                                 |

## 5. The fail-closed aggregate, and rollback

### 5.1 How a candidate's required set is read, fail-closed, today

Two aggregates, both reading the **merge-queue SHA**, never a PR head.

**Legacy gate** (`.github/workflows/merge-queue-gate.yml:70-170`):

1. Resolve the gated sha: explicit input, else `GITHUB_SHA` on push, else the
   `merge-queue` ref tip from the API (`:70-84`).
2. Refuse on an empty wait list (`:94-99`) — an empty list would validate
   nothing.
3. `deadline = now + 20 min` (`:100`).
4. Read `commits/${SHA}/check-runs?filter=latest`, all pages (`:116-118`).
5. Fold **every** row per check name (`:119-136`): missing → wait; any
   incomplete → wait; `skipped` → **fail**; any non-success conclusion →
   **fail**; all rows success → pass. One verdict per name, never per row.
6. Any failure → exit 1 immediately (`:158-160`); all pass → promote (`:161-164`);
   deadline reached → exit 1 (`:165-168`). `sleep 30` between polls.

**Successor gate** (`.github/workflows/gate.yml:125-303` →
`trust/dist/selfhost/promote-gate.js`):

1. `wake` verifies the triggering run and that the ref is the default branch for
   a dispatch (`:72-120`); on a schedule sweep it exits without deciding.
2. `decide` runs from the **trust ref**, in `environment: promote`, as the sole
   member of concurrency group `promote` with `cancel-in-progress: false`
   (`:130-135`) — a promotion is never cancelled mid-push — and refuses a
   half-registered App pair (`:157-171`).
3. It requires the tip's newest valid `cq/ratchet` verdict to be `success`
   (`promote-gate.ts:980-996`; failure → `refuse`, missing → dispatch
   `cq-verify` and keep polling).
4. For each file in `--verifiedWorkflows` it requires the newest
   `head_sha=tip&event=push&branch=merge-queue` run to have
   `conclusion === 'success'` **and every job in it `completed`/`success` with
   a runner and steps** (`:999-1024`, `:487-536`).
5. Anything not green → poll to `--timeoutMin` (20) → `refuse('timeout: …')`
   (`:1035-1039`); a recheck pass that loses green → `refuse` (`:1031-1034`).

Fail-closed properties worth stating because they are the reason the reconciled
set can be trusted: missing ≠ pass, skipped ≠ pass, cancelled ≠ pass, at both
venues; an empty list refuses rather than vacuously passes; and the promotion
aggregate is an **AND over jobs**, so an obligation nobody declared can still be
binding (§1.2 consequence 5).

### 5.2 Rollback that restores protection through the same sites

Rollback is the recorded inverse of §2.6 / §3.4, and it is **not** quiet:

- D11 judges the required-check list from the **trust ref only** — "LISTS come
  from the TRUST REF only … A subject cannot edit the lists that judge it"
  (`policyDiff.ts:7-11`) — and a subject that _removes_ an entry the base had
  gets an `entry-removed` finding (`:532-535`); a subject that _changes_ a
  required check's producer gets a `required-check` finding (`:654-658`), and a
  subject that removes the producer outright gets `removed required check X`
  (`:659-660`).
- Therefore: **promotion is quiet and demotion is loud.** Adding
  `static-macos` (new context + new job) trips nothing, because at judgement
  time the trust list does not contain it and the `static` job is untouched.
  Retiring it — job, context, or list entry — trips D11 and requires a human to
  accept a `cq/policy` finding with the reason recorded. That asymmetry is
  correct doctrine (weakening the required set must be visible) and it means a
  rollback is never an unattended operation.
- Ordering: trust-list and producer changes travel in the **same** change. A PR
  that removed only the producer, or only the list entry, would either fail D11
  outright or leave the aggregate reading an obligation with no producer.
- Outward-facing steps (S4 rulesets, S5/S6 protection) are applied by the owner,
  last, in the same pass — and the render check
  (`scripts/github-settings-drift.mjs:162-176`, which reads both the rulesets and
  each branch's protection) must be re-run afterwards to confirm the applied
  state matches the template.
- After any rollback, the next promotion must re-establish the full aggregate
  before it can promote: with `static-macos` demoted, nothing in S1–S6 names it,
  and if it lived in `ci.yml`, S7 keeps it binding until the job is deleted.

### 5.3 Known gaps in the aggregate, recorded not fixed

1. `strict_required_status_checks_policy: false` (S4 `:63`) — a PR head may be
   green while stale against its base. Deliberate; it is the reason candidate
   evidence is the queue tip, not the PR head.
2. `main` and `merge-queue` protection differ today (§1.2 item 4).
3. `ratchet` is app-unpinned on `merge-queue` (S6, `app_id: null`) — any App can
   report that context there.
4. Both promotion gates are simultaneously active with different required sets;
   today the effective obligation is their union.
5. `bypass_actors` include `actor_id: 5` with `bypass_mode: always`
   (S4 `:77`) — repository admins always bypass every required check.

Items 1, 3 and 5 are existing, recorded doctrine choices. Items 2 and 4 are the
reconciliation this document proposes and the owner applies.

---

### Appendix — evidence commands

```bash
# live surfaces (read-only)
gh api repos/camerontaylor/cq-toolkit/rulesets --jq 'length'                      # 0
gh api repos/camerontaylor/cq-toolkit/branches/main/protection        --jq '.required_status_checks.contexts'
gh api repos/camerontaylor/cq-toolkit/branches/merge-queue/protection --jq '.required_status_checks.checks'
gh api repos/camerontaylor/cq-toolkit/actions/workflows/merge-queue-gate.yml --jq '.state'   # active
gh api repos/camerontaylor/cq-toolkit/actions/workflows/gate.yml            --jq '.state'   # active
# what ran on the candidate sha, with timings
gh api "repos/camerontaylor/cq-toolkit/commits/70de728/check-runs?filter=latest&per_page=100" --paginate \
  --jq '.check_runs[] | [.name, .app.slug, .started_at, .completed_at] | @tsv'
```

```bash
# who enforces the reconciled lists
rg -n "static,denylist,ratchet" policy/templates/instances.json .github/workflows/merge-queue-gate.yml
rg -n 'requiredChecks' policy/protected-paths.json src/ops/gates/policyDiff.ts test/ops/gates/policyDiff.test.ts
rg -n 'verifiedWorkflows|checkVerifiedRun' .github/workflows/gate.yml src/selfhost/promote-gate.ts
```
