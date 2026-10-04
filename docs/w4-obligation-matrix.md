# W4 — the required-check obligation matrix and the required-contexts reconciliation

Status: **proposal.** Nothing in this document is applied. Every change it
describes touches an outward-facing, owner-governed declaration site
(`policy/protected-paths.json`, `scripts/denylist-scan`,
`policy/templates/github-settings.json`, a workflow template or instance, or
the live rulesets / branch protection). Application is by the owner, in two
phases (§2.6: phase A reconciles `from-source` and lands the non-required macOS
pilot producer; phase B promotes `static-macos` after the pilot), preceded by
one scanner prerequisite that lands in its own PR (§2.4). Within a phase the
repo-side rows land as one atomic change set — never piecemeal — and the
owner's live steps are ordered by direction around that change (§2.6, §5.2).

Evidence base: `origin/main` = `origin/merge-queue` = `70de728` (read on
2026-10-02, the date the spec's review pass was taken), the live GitHub API
for this repository, and the superseded plan
`toolkit-research-validation-efficiency/plans/ralplan-agent-validation-efficiency.md`
§4 (`:133-141`). Every claim below carries a `file:line` or an API read.
Refreshed on 2026-10-03 against `origin/merge-queue` = `6dd2337` (PR #262,
npm→pnpm): every command spelling and line citation below is re-verified
against that tree. §1.3's measured timings remain the pre-pnpm `70de728`
readings, as marked there.

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
| S7  | successor promotion gate                             | `.github/workflows/gate.yml:268` (`--verifiedWorkflows=ci.yml,denylist.yml`), `:269` (`--timeoutMin=20`); template `policy/templates/gate.yml:38,42`; token `policy/templates/instances.json:33-34` | **workflow file path** + one verdict context | `ci.yml`, `denylist.yml`, plus the tip's `cq/ratchet` verdict (`src/selfhost/promote-gate.ts:980-996`)                                                      | the gate, running `trust/dist/selfhost/promote-gate.js`                                                                                                                                            |

Both promotion gates are `active` on GitHub today
(`actions/workflows/merge-queue-gate.yml` → `state: active`;
`actions/workflows/gate.yml` → `state: active`). Both are live, and they are
**alternative promoters, not an AND**: each fast-forwards `main` on its own
prerequisites with a compare-and-swap on the queue tip
(`policy/templates/README.md:175-176`), so the first gate whose own set is
green promotes. During C1 promotion is therefore an **OR of two complete
predicates** — `(all S3 requirements) OR (all S7 requirements)` — not a union
of the two sets and not merely their intersection. A check required by only one
gate is non-blocking only while the other gate's whole set is green: if the
shared `static`/`denylist` evidence is green but an S3-only obligation
(`ratchet`) and an S7-only obligation (`from-source`) both fail, neither
predicate holds and nothing promotes. The legacy gate fired on the
last candidate push (run `36952171986`,
`push`/`merge-queue`, `2026-10-02T01:41:55Z`) while the successor's
`workflow_run` leg has fired 4 times against 96 `schedule` sweeps in the
retained API window. `policy/templates/README.md:14` calls the legacy one
LEGACY (retires at C2) and `:15` the successor the P1 promotion job.

> **Batch promotion policy (2026-10-04,
> [docs/promotion-policy.md](promotion-policy.md)).** The OR above no longer
> holds while that policy is in force: S7 (`gate.yml`) runs report-only
> (no `--push`), and S3 (`merge-queue-gate.yml`) promotes only a
> merge-queue sha carrying a `crq/promotion-review` success from an allowed
> reviewer. Promotion is therefore `(all S3 requirements on the reviewed sha)
> AND (the promotion review)`, and S7-only obligations (`from-source`) do
> not block promotion until S7 learns the review signal and pushes again.

### 1.2 The disagreement, stated explicitly

The spec's framing is right and incomplete. Precisely:

1. **Three sites say `static`/`denylist`/`ratchet`** — S1, S2, S3. These three
   are consistent with each other and S1≡S3 is _machine-enforced_
   (`policyDiff.test.ts:1132-1137` parses the gate's `echo '…'` argument and
   asserts list equality).
2. **The ruleset template lists seven** — S4 — including `cq/*` and
   `from-source`, and it does **not** list the plain `ratchet` context: the
   recorded supersession is `ratchet` → `cq/ratchet`
   (`test/ops/gates/protectedPaths.test.ts:323-326`, documented at
   `docs/methods-w1-10.md:243`).
3. **`from-source` is deliberately not a required check** — `.github/workflows/ci.yml:73-81`
   and the template narrative at `policy/templates/required-check.md:115-124`
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
   So `ci.yml` and `denylist.yml` bind the successor gate **in full**,
   including `from-source`, while `ratchet.yml` is not in the list at all and
   is represented instead by the `cq/ratchet` verdict.

Consequence 5 is the one that matters most for the macOS work: **a job added to
`ci.yml` is binding on the successor gate the moment it exists**, under S7,
whether or not any list names it. While the legacy gate is also live it can
still promote without that job (§1.1: the gates are alternatives), so the job
becomes fully promotion-blocking only at C2, when S7 is the sole promoter.
"Initially non-required" is only true with respect to S1–S6, and only until C2.

### 1.3 What actually ran on the candidate SHA (measured, not asserted)

Check-runs on `70de728` (API, `filter=latest`, all pages), selected rows. The
sha carries **two surfaces**: "run 2" (started 01:41:57) is the `merge-queue`
candidate push the legacy gate fired on (`01:41:55Z`, §1.1); "run 1" (started
01:46:39–40, after run 2's `ratchet` finished at 01:46:32) is the `main` push
that the promotion itself triggered. Candidate timing is run 2 only.

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

Two timing facts the promotion decision needs: the candidate's binding leg
today is `ratchet` at 4m35s (run 2; `static` finished at 4m14s) against a
20-minute gate deadline (`merge-queue-gate.yml:100` and `gate.yml:269`), i.e.
**~4.4× headroom** (the slower post-promotion `main` run, `static` 5m04s, is
still ~3.9×), and two runs of the same job on the
same SHA differed by 16% (`static` 5m04s vs 4m14s) and 1.8% (`ratchet` 4m40s vs
4m35s) — the same order as the spec's own two-baseline comparison (19%). That
variance is larger than any saving consolidation could offer (§4).

These timings predate the pnpm migration: `70de728` installed with `npm ci`
and cached npm, while `6dd2337` installs with `pnpm install --frozen-lockfile`
and `cache: pnpm`. They remain the evidence for run-to-run variance and for
the max-vs-p90 discipline, not for absolute post-migration headroom — the
4.4× figure must be re-measured, not assumed, before any promotion decision
cites it.

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

- Anything in the legacy gate list must be push-produced. Putting a
  PR-head-only context — `pack-audit` or `cq/acceptance` — into
  `{{GATE_CHECKS}}` today would stall every promotion for the full 20 minutes
  and then refuse (`merge-queue-gate.yml:165-168`) — a total queue freeze, not
  a red PR. `from-source` is not in that class: `ci.yml:12-14` triggers on an
  unfiltered `push` and its job is defined at `:82-110`, so it is push-produced
  and satisfiable (§2.4).
- Anything in a verified workflow is implicitly required _for promotion_ whether
  or not a list says so.

### 2.2 The proposed set

Rows are keyed by check context — except the `pnpm setup` row, a
producer-level obligation introduced by the pnpm migration (`6dd2337`) that
names no context of its own: its failure is the host job's failure.

| context                                               | producer (file:job)                                                                                                                                     | what it obligates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | suite scope                                               | OS                          | subject / trust class                                                                                                                | venues                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`                                              | `ci.yml:26`                                                                                                                                             | pnpm setup + frozen-lockfile install (`:39-48`, the shared surface rowed separately below), then TS7 compiler ratchet + typed Oxlint (`:50-51`), format (`:52-53`), full suite plain (`:54-57`), Knip (`:58-59`), checked emit (`:63-64`), generated op-docs drift (`:70-71`)                                                                                                                                                                                                                                                                                                                                                                                                | `test:unit` + `test:e2e` = whole default discovery        | ubuntu-latest               | head-defined PR/push; app 15368; `contents: read`; subject runs its own code                                                         | S1 S2 S3 S4 S5 S6 S7 (via `ci.yml`)                                                                                                                                                                               |
| `denylist`                                            | `denylist.yml:20`                                                                                                                                       | denylist scan + gitleaks + the I4 self-test over `REQUIRED_WORKFLOW_CHECKS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                         | ubuntu-latest               | head-defined; app 15368; `contents: read`                                                                                            | S1 S2 S3 S4 S5 S6 S7 (via `denylist.yml`)                                                                                                                                                                         |
| `ratchet` (legacy)                                    | `ratchet.yml:69`                                                                                                                                        | typecheck-**count** ratchet (`:97-111`), coverage ratchet over the whole suite instrumented (`:112-127`), base-diff baseline monotonicity guard, PR legs only (`:128-144`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `pnpm exec vitest run --coverage` (whole suite incl. e2e) | ubuntu-latest               | head-defined; app 15368; `contents: read`; **verdict data produced by the head's own `dist/cli.js`**                                 | S1 S2 S3 S5 S6 — **not** S7                                                                                                                                                                                       |
| `cq/ratchet`                                          | `cq-verify.yml` `judge`                                                                                                                                 | trust-built recomputation of typecheck-count over the attribute-free head tree; **coverage accepted as untrusted head-executed data** (`cq-measure.yml:3,105-119`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | instrumented suite (as measurement)                       | ubuntu-latest               | default-branch verifier; verdict App at C2 (`github-settings.json:66-68`)                                                            | S4 (target), S7 (live, app 15368 interim)                                                                                                                                                                         |
| `cq/policy`                                           | `cq-policy.yml`                                                                                                                                         | D11 protected-path + required-check policy diff over the trust-ref lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                         | ubuntu-latest               | default-branch verifier                                                                                                              | S4 (target)                                                                                                                                                                                                       |
| `cq/acceptance`                                       | `cq-accept.yml`                                                                                                                                         | I2 independent-review acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                         | ubuntu-latest               | default-branch verifier                                                                                                              | S4 (target) — **PR heads only**, so never S3/S7                                                                                                                                                                   |
| `from-source`                                         | `ci.yml:82`                                                                                                                                             | build the CLI, drive a real governed plan through `dist/` (`scripts/smoke-run-plan.mjs`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2 governed jobs, not the suite                            | ubuntu-latest               | head-defined; app 15368                                                                                                              | S7 **de facto** (all-jobs aggregate); S4 and S6 name it; S1/S2/S3 do not                                                                                                                                          |
| `pack-audit`                                          | `pack-audit.yml`                                                                                                                                        | `pnpm pack` + `files` allowlist + denylist scan of the unpacked tree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                         | ubuntu-latest               | head-defined; app 15368; **`pull_request` only**                                                                                     | S4, S6 — **never S3/S7**                                                                                                                                                                                          |
| `pnpm setup` (no context — a shared producer surface) | every pnpm-using workflow; in `ci.yml` both jobs: `pnpm/action-setup` (`:39-41`, `:94-96`) then `pnpm install --frozen-lockfile` (`:47-48`, `:102-103`) | install pnpm from `packageManager` (`pnpm@12.8.1`), then a frozen-lockfile install; CI pins `PNPM_CONFIG_VIRTUAL_STORE_TYPE: project` (`ci.yml:22-23`). Guards two failure modes: **lockfile drift** (a `package.json` the lockfile does not record fails the install instead of being silently resolved) and **stale-store / resolve-hook leakage** (the opt-out keeps CI off the global virtual store, so no step inherits pnpm's `NODE_PATH`/`NODE_OPTIONS` hook). Mechanically pinned by `test/workflows/pnpm-setup.test.ts` over every workflow and template: opt-out present, setup step inert (no `cache:`/`run_install:`), trust checkouts read `trust/package.json` | —                                                         | ubuntu-latest (in `ci.yml`) | head-defined (the head's lockfile is what `--frozen-lockfile` judges); no check-run of its own — a failure is the host job's failure | S7 via `ci.yml` (all-jobs aggregate); indirectly every context whose producing job installs, since its failure is that context's failure; **not declarable in S1–S6**, which name contexts and this produces none |
| `static-macos` (proposed, §3)                         | lane M's job                                                                                                                                            | `test:unit` + `test:e2e` on macOS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | whole default discovery                                   | macos-latest                | head-defined; app 15368                                                                                                              | S7 if it lands inside `ci.yml`; otherwise nowhere until promotion                                                                                                                                                 |

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
`test/ops/gates/protectedPaths.test.ts:323-326`. The single recorded
supersession stays `ratchet` → `cq/ratchet`, and its documentation assertion
(`:348-352`, the methods-note Residuals text) is untouched by it.

### 2.4 `from-source` — resolved

**Recommendation: declare it required (make the de facto the de jure).** The
evidence says it is already binding for promotion: it lives in `ci.yml`, whose
run S7 requires job-by-job (`promote-gate.ts:520-527`), it reports on every
push and pull_request unfiltered (I4-clean), and it costs **12–13s** measured
(§1.3). It is not yet binding everywhere, though: S3 does not require it, and
while both promoters are live the legacy gate can promote a tip whose
`from-source` failed (§1.1). Registering it in S3 therefore **does** change an
enforcement outcome during C1 — it closes that legacy-gate path, a pure
tightening — and after C2 it only makes S7's existing obligation visible in the
places an operator reads.

Consequences of the recommendation, all owner-governed:

- `ci.yml:73-81` and `policy/templates/required-check.md:115-124` must be
  rewritten in the same change — their current text ("deliberately not a
  required check") becomes false the moment it lands, and a template that
  contradicts its own ruleset is exactly the drift this document exists to end.
- **Prerequisite — the pairing model must admit several checks per workflow
  file.** Today it cannot: `requiredWorkflowChecksProblems()`
  (`scripts/denylist-scan:1080-1110`) rejects a second pair for the same file
  (`:1100-1102`), and `workflowI4Checks()` looks up one pair per file with
  `.find()` (`:1042`), so even without that rejection it would police only the
  first of `ci.yml`'s two pairs. The scanner change: keep the duplicate-**check**
  -name rejection (`:1103-1105`); drop the duplicate-**workflow** rejection;
  make the I4 leg validate every pair for a file (`.filter()`, the job-id and
  `name:` checks once per pair) while the trigger checks still run once per
  file; and add a self-test fixture with two pairs in one workflow (both jobs
  present → pass; either renamed away → FAIL naming it) — the leg reads only
  the live `.github/workflows/` tree today (`:116`, `:1112-1165`), so nothing
  exercises a multi-pair file. `scripts/denylist-scan` is a protected path
  (`protected-paths.json:13`), so this lands in its **own PR**, before the
  change set below, and is not part of this docs-only plan.
- With the prerequisite merged, `REQUIRED_WORKFLOW_CHECKS` (`:165-173`) gains
  `{ workflow: 'ci.yml', check: 'from-source' }`. The I4 leg will then police
  it: the job exists, its id is `from-source`, it carries no `name:` override,
  and `ci.yml`'s `on:` block stays unfiltered. It already satisfies all four
  (`:82-86`), so beyond the scanner prerequisite no workflow edit other than
  the comment is needed. Registered before the prerequisite, the pair fails
  the denylist self-test outright.
- The legacy gate list becomes `static,from-source,denylist,ratchet`
  (S1 ≡ S3 by Rule R), and `from-source` is push-produced, so the gate's wait
  is satisfiable.
- Live classic protection on `main` must gain it before C2; `main` does not have
  it today (S5), a pure tightening. (At C2 the target state has no required-check
  rule on `main` at all — §2.6 item 7.)

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

Ordered. Row 0 is a prerequisite that merges first, in its own PR. The rest
splits into two phases. Within a phase, the repo-side rows (1–6) are applied
together or not at all, as one PR; the live rows (7a, 7b) are owner steps
outside that atomic set, ordered by direction around it (below, and §5.2):

- **Phase A — reconciliation + macOS pilot.** The `from-source` parts of
  every row, plus the standalone `ci-macos.yml` template, instance and
  checkout safeguard (rows 1, 1b, 1c), landed **non-required**: nothing in S1–S7
  names it, so the §3.3 10-candidate pilot runs in a window where a red or
  slow macOS leg blocks nothing.
- **Phase B — macOS promotion,** after the pilot: every "at promotion" part
  below. It is a separate change set and a separate owner decision.

Rows 1b, 1c and 5b are additions to the original list: 1b keeps the shipped
adopter instructions consistent with it, 1c keeps the checkout-token
assertion covering the new head-executing workflow, 5b wakes the successor
gate on the new workflow.

| order | site                                                                                                                                                                                                                   | change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | outward-facing?                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0     | `scripts/denylist-scan:1042`, `:1080-1110` (own PR, before phase A)                                                                                                                                                    | prerequisite for row 3's `from-source` pair: allow several pairs per workflow file, keep the duplicate-check-name rejection, validate every pair for a file in the I4 leg (filter, not find; triggers once per file), add a two-pairs-in-one-workflow self-test fixture (§2.4)                                                                                                                                                                                                                                                                                         | **yes** — protected path (`protected-paths.json:13`)                         |
| 1     | `policy/templates/required-check.md:115-124` (+ `:31-43` prose)                                                                                                                                                        | phase A: rewrite the "companion job, not a required check" narrative for `from-source`; add a standalone `ci-macos.yml` template carrying the macOS job body (§3.1), instantiated non-required                                                                                                                                                                                                                                                                                                                                                                         | no (template, then regenerate)                                               |
| 1b    | `policy/README.md:42-49` (adoption step 3) and `:94-95` (`ratchet` "three places above"); `policy/templates/README.md:88-111` (instantiation step 4), `:11-32` (Files table) and `:126-136` (bootstrap-rule inventory) | rewrite every "register in all three places" instruction: `GATE_WORKFLOWS` (successor gate) is a fourth place, a standalone workflow check is not enforced by the successor until it is added there, and C2 enforcement is R2 on `merge-queue` only, not classic protection on both branches (`github-settings.json:39-45`, `:80-83`). `policy/README.md:10-12` makes the template guide the source of truth, so its step 4 must change with the adoption path, not after it. Phase A also lists `ci-macos.yml` in the template guide's file and bootstrap inventories | no (shipped adopter docs)                                                    |
| 1c    | `test/workflows/action-pins.test.ts:109-125`                                                                                                                                                                           | phase A: add `ci-macos.yml` to the hard-coded list of workflows whose every checkout must set `persist-credentials: false`; the template's checkouts carry it (§3.1)                                                                                                                                                                                                                                                                                                                                                                                                   | no                                                                           |
| 2     | `.github/workflows/ci.yml`                                                                                                                                                                                             | refresh the `from-source` comment only — under the recommended placement (§3.2) no `static-macos` job lands in `ci.yml`                                                                                                                                                                                                                                                                                                                                                                                                                                                | no (generated instance)                                                      |
| 3     | `scripts/denylist-scan:165-173`                                                                                                                                                                                        | phase A: add `{ ci.yml: from-source }` — only after row 0 has merged, since a second `ci.yml` pair fails the self-test until then; at promotion add `{ ci-macos.yml: static-macos }` (its own file, so row 0 is not needed for it)                                                                                                                                                                                                                                                                                                                                     | **yes** — protected path (`protected-paths.json:13`)                         |
| 4     | `policy/protected-paths.json:15`                                                                                                                                                                                       | `["static","from-source","denylist","ratchet"]`; at promotion add `"static-macos"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **yes** — protected path                                                     |
| 5     | `policy/templates/merge-queue-gate.yml:92` + `policy/templates/instances.json:58`                                                                                                                                      | `GATE_CHECKS` gains `from-source`; at promotion gains `static-macos`; regenerate the instance                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no (repo) / **yes** (D11 judges the producer change)                         |
| 5b    | `policy/templates/gate.yml` (`workflow_run.workflows`, `wake` path whitelist) + instance                                                                                                                               | at promotion, recommended placement only: add `ci-macos` to the trigger list and `.github/workflows/ci-macos.yml` to the whitelist (today `ci` and `cq-measure` only: template `policy/templates/gate.yml:56-63`, `:117-120`; instance `.github/workflows/gate.yml:56-64`, `:118-121`); regenerate. `GATE_WORKFLOWS` alone makes the gate verify the run, not wake on it                                                                                                                                                                                               | no (repo) / **yes** (D11 judges the producer change)                         |
| 6     | `policy/templates/github-settings.json:65-73`                                                                                                                                                                          | already lists `from-source` and `pack-audit`; at promotion add `{ "context": "static-macos", "integration_id": 15368 }`. No other R2 edit is proposed: the `cq/*` pinning and the `ratchet` supersession stay as they are                                                                                                                                                                                                                                                                                                                                              | **yes** — target state of live settings                                      |
| 7a    | live classic protection (S5/S6), **pre-C2 only**                                                                                                                                                                       | add `from-source` to `main`; add `static-macos` to both branches at promotion if it precedes C2; decide the `main`/`pack-audit` asymmetry                                                                                                                                                                                                                                                                                                                                                                                                                              | **yes** — owner-only, via the API                                            |
| 7b    | live rulesets (S4), **at C2**                                                                                                                                                                                          | apply R0/R1/R2 as templated (item 6). The target has `classicBranchProtection: null` for both branches (`github-settings.json:80-83`), so the wizard _removes_ S5/S6 rather than updating them, and R2 targets only `merge-queue` (`:39-45`) — `main` keeps R1's `update` rule and no required-check rule                                                                                                                                                                                                                                                              | **yes** — owner-only, via the W7.3a wizard (`policy/templates/README.md:27`) |

Items 7a and 7b are the only genuinely outward-facing steps and the only ones
this lane cannot perform. They are separate passes: 7a edits the classic
protection that exists today, 7b replaces it at C2; applying 7a's `main` edits
after 7b would recreate exactly what the target reports as drift. Everything
above them is reviewable in a normal PR.

Phase B orders the live step **first** on `merge-queue`: add `static-macos` to
S6 (pre-C2) or apply R2 with it (at C2) **before** the phase-B repo change
merges. That is safe because phase A's producer already runs on every PR head,
so the requirement is satisfiable. It is needed because `cq-gate` runs the
default branch's copy of `gate.yml` (`gate.yml:8-10`): the new
`GATE_WORKFLOWS` value is not live for the promotion commit's own tip until
that commit reaches `main`. The legacy gate, which runs the pushed copy, would
wait for `static-macos` on that tip, but it is an alternative promoter, not
an AND (§1.1). So without the live requirement, the old successor could promote
the promotion commit with macOS red. Recorded residual: protection reads the PR
head, not the tip. The promotion commit's own tip is therefore the one candidate
whose `ci-macos.yml` push run no promoter is guaranteed to verify. During C1
the owner may close it by disabling `cq-gate` for that single promotion, so the
legacy gate decides it, and re-enabling it afterwards; after C2 it is an
accepted, recorded residual. Demotion inverts the order: the live requirement
is removed first (§3.4, §5.2).

**What must NOT change:** the legacy gate's 20-minute deadline unless §3.3's
evidence demands it; `strict_required_status_checks_policy` (`:63`) is
deliberately `false` — a PR head can be green while stale against its base, and
that is precisely why candidate evidence is read from the queue tip, not the PR
head (spec §C bullet 1); and `protected-paths.json:protectedPaths`, whose
entries are the D11 trust anchors.

## 3. The macOS insertion plan — `static-macos`, when it is promoted

### 3.1 Where the context goes, per site

| site                                                                                  | insertion                                                                                                                                                                                                                 | notes                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/templates/required-check.md`                                                  | a standalone `ci-macos.yml` template with its own job body, not a matrix                                                                                                                                                  | a matrix would rename the check runs (`static (ubuntu-latest)`), breaking the S1/S2 pairing and every `name:`-identity rule the I4 leg polices (`scripts/denylist-scan:150-157`); the template's `{{RUNNER}}` slot is single-valued (`:33-40`), so a macOS job needs its own body with `macos-latest`                                                                                           |
| `.github/workflows/ci.yml`                                                            | no `static-macos` job under the recommended placement; only the `from-source` comment refresh                                                                                                                             | a job added here is bound by S7 all-jobs aggregate from birth, before any list names it (§1.2 consequence 5, §3.2)                                                                                                                                                                                                                                                                              |
| `policy/templates/ci-macos.yml` + its instance `.github/workflows/ci-macos.yml` (new) | the `static-macos` job: `runs-on: macos-latest`, `test:unit` + `test:e2e`, unfiltered `on:`, no job-level `if:`, `persist-credentials: false` on every checkout; lands in phase A, non-required                           | its own file is what makes "initially non-required" true in every venue (§3.2); the price is that macOS and Linux legs can no longer be throttled by one workflow. It runs head-authored install and test code from birth, so `test/workflows/action-pins.test.ts:109-125` must gain it in the same change (§2.6 row 1c) — that list is hard-coded, so a new workflow is not covered by default |
| `scripts/denylist-scan:165-173`                                                       | `{ workflow: 'ci-macos.yml', check: 'static-macos' }`                                                                                                                                                                     | job id must equal the check name, no `name:` override, and the I4 leg then polices it forever                                                                                                                                                                                                                                                                                                   |
| `policy/protected-paths.json:15`                                                      | `"static-macos"`                                                                                                                                                                                                          | the list must stay equal to the gate's wait list (`policyDiff.test.ts:1132-1137`)                                                                                                                                                                                                                                                                                                               |
| `policy/templates/github-settings.json:65-73`                                         | `{ "context": "static-macos", "integration_id": 15368 }`                                                                                                                                                                  | Actions-pinned, plain name (§2.3)                                                                                                                                                                                                                                                                                                                                                               |
| legacy gate                                                                           | `GATE_CHECKS` in `policy/templates/instances.json:58`                                                                                                                                                                     | push-produced, so satisfiable (Rule R)                                                                                                                                                                                                                                                                                                                                                          |
| **successor gate**                                                                    | `GATE_WORKFLOWS` in `policy/templates/instances.json:33` gains `ci-macos.yml`                                                                                                                                             | required under the recommended placement; a no-op in the rejected single-file layout, where S7 already binds the job (§3.2)                                                                                                                                                                                                                                                                     |
| **successor gate wake path**                                                          | `policy/templates/gate.yml` `workflow_run.workflows` gains `ci-macos`, and the `wake` job's path whitelist gains `.github/workflows/ci-macos.yml` (`gate.yml:56-64`, `:118-121` in the instance); regenerate the instance | `GATE_WORKFLOWS` makes the gate _verify_ the run but not _wake_ on it. Without the trigger, a macOS run that finishes after a timeout, or is rerun green after a refusal, starts no promotion attempt until the next scheduled sweep (§3.2)                                                                                                                                                     |
| live rulesets + both branches' protection                                             | add the context                                                                                                                                                                                                           | owner-governed, phase B; on `merge-queue`, before the phase-B repo change merges (§2.6)                                                                                                                                                                                                                                                                                                         |

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
  then costs `GATE_WORKFLOWS` plus the successor gate's wake path (the
  `workflow_run` trigger and the `wake` path whitelist, which today name only
  `ci` and `cq-measure`, `gate.yml:56-64`, `:118-121`) plus the S1–S6 edits
  above. Demotion is then a clean inverse.

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

Each gate _attempt_ refuses after 20 minutes (`merge-queue-gate.yml:100`,
`:165-168`; `gate.yml:269` → `promote-gate.ts:1035-1038`). That bounds an
attempt, not the macOS run. Under the recommended layout, row 5b makes
`ci-macos` completion wake a fresh `cq-gate` attempt
(`workflow_run`, `types: completed`), and that attempt's deadline starts after
the run has already finished. The 15-minute `schedule` sweep (`gate.yml:65-66`)
also starts a fresh deciding attempt each time (§5.1). So the successor can
promote a tip whose macOS leg ran longer than 20 minutes. Only the legacy gate
is bound by **max < 20 min**, because it makes one attempt per candidate push
(`merge-queue-gate.yml:34-36`), and while both are live that bound decides
which promoter wins, not whether the tip promotes. A slow macOS leg costs
latency and refusal noise (a timed-out attempt per earlier wake), not
promotion. Measured headroom on the Linux legs today is ~4.4× (4m35s binding
leg on the candidate push). The spec expects an unmodified suite to exceed
15 min on a macOS runner if the trace's per-spawn hypothesis holds, which is
why the promotion clock starts only after E's top-10 reduction merges.

**Recommendation: do not pre-emptively raise the wait, and do not treat a
pilot max ≥ 15 min as a reason to raise it by itself.** Raise
`{{GATE_TIMEOUT_MIN}}` (both instances, `policy/templates/instances.json:34`
and `:59`, and therefore both templates) **in the same change** as the macOS
promotion, and only if the 10-candidate pilot shows a cost that the wake path
does not absorb. One example is decide-time spent waiting while the next wake
is already guaranteed. Another is the legacy gate's single attempt refusing
candidates that the successor then promotes only after a long delay. The
successor's fresh-deadline attempts already tolerate a slow run, and there
are two further reasons:
(i) a raised wait is a weaker gate for every other obligation, so paying for it
before the evidence is a pure cost; (ii) `gate.yml`'s `decide` job has a fixed
40-minute timeout (`gate.yml:135`) and `policy/templates/README.md:53` warns
that the wait plus checkout/install/build must stay inside it — raising the wait
without re-deriving that bound trades one fail-closed mode (a clear refusal) for
another (a killed job with no report). Both instances must move together while
both promoters are live; they are the same token in two files, and **nothing
enforces that**: the render test
(`test/workflows/template-render.test.ts:145-160`) reads only the `gate.yml`
instance and bounds it at ≤ 25, never comparing it with the
`merge-queue-gate.yml` instance. Equality is an unenforced operational
requirement of the promotion change set.

Queue time and run time must be recorded separately in the promotion decision
(spec §C bullet 4): a macOS pool is smaller, so a 15-minute run can arrive
inside 20 minutes or not at all depending on queueing.

### 3.4 Demotion

Demotion is the exact inverse of §2.6's table with the §3.2 caveat: remove
`static-macos` from S6/S4 first (outward-facing, owner), then from S1 and S3
together (they are machine-tied), then from S2, then from S7 — under the
recommended layout, remove `ci-macos.yml` from `GATE_WORKFLOWS`
(`policy/templates/instances.json:33`) and from the `gate.yml` wake path, and
regenerate `gate.yml`, otherwise the
successor gate keeps requiring the run and a slow or flaky macOS leg still
freezes promotion; if the job lives in `ci.yml` instead, **remove the job
itself**, because S7 keeps it binding until it is gone. Record the breach
reason in the PR. Never leave S7 binding an obligation
no list names: that is the "silent obligation" state this document was written
to eliminate.

## 4. Consolidation analysis — the "the suite runs twice per push" constraint

### 4.1 The duplication, measured

|                   | `static`                                                                                                                                                                                    | `ratchet`                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| workflow / job    | `ci.yml:26`                                                                                                                                                                                 | `ratchet.yml:69`                                                                                              |
| test legs         | `pnpm run test:unit` (`:55`) + `pnpm run test:e2e` (`:57`)                                                                                                                                  | `pnpm exec vitest run --coverage` (`:120`)                                                                    |
| selection         | `test:unit` = default discovery `--exclude test/e2e/** --exclude test/driver/acp.test.ts`; `test:e2e` = `test/e2e` + `test/driver/acp.test.ts` (`package.json`) → union = default discovery | default discovery (`vitest.config.ts:22` adds `**/dist/**` to the defaults) → **same file set**, instrumented |
| other obligations | `check:static`, `format:check`, `knip`, `build`, `gen:op-docs:check`                                                                                                                        | typecheck-count ratchet, coverage ratchet, base-diff monotonicity guard                                       |
| checkout          | shallow                                                                                                                                                                                     | `fetch-depth: 0` (guard needs the base diff, `:78-84`)                                                        |
| concurrency       | none                                                                                                                                                                                        | `cancel-in-progress: true` (`:58-60`)                                                                         |
| job timeout       | —                                                                                                                                                                                           | `timeout-minutes: 20` (`:72`)                                                                                 |
| measured          | 5m04s / 4m14s (pre-pnpm, §1.3)                                                                                                                                                              | 4m40s / 4m35s (pre-pnpm, §1.3)                                                                                |

So the two executions are the same 152-file suite, one plain and one under v8
coverage, in parallel, in the same ~5-minute window.

### 4.2 Subject/trust equivalence, dimension by dimension (superseded plan §4)

| dimension                         | `static`                                                                               | `ratchet`                                                                   | equivalent?                                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subject (PR head / push tip)      | head tree of the event's sha                                                           | head tree of the event's sha                                                | **yes**                                                                                                                                                                                                                               |
| trust ref                         | none (head-defined)                                                                    | none (head-defined), and `ratchet.yml:4-5` says so explicitly               | **yes**                                                                                                                                                                                                                               |
| producer permissions              | `contents: read`, no credential persistence                                            | `contents: read`, no credential persistence                                 | **yes**                                                                                                                                                                                                                               |
| toolchain                         | `ubuntu-latest`, node 24, `pnpm install --frozen-lockfile`, same immutable action pins | identical                                                                   | **yes**                                                                                                                                                                                                                               |
| triggers                          | unfiltered `push` + `pull_request`                                                     | unfiltered `push` + `pull_request` + `workflow_dispatch`                    | **no** — equal for automatic push/PR runs only; a dispatched `ratchet` on the tip adds a same-name suite that the legacy gate folds in (`merge-queue-gate.yml:104-136`), so a pending or failed dispatch can hold or refuse promotion |
| suite membership                  | default discovery, split in two invocations                                            | default discovery, one instrumented invocation                              | **yes**                                                                                                                                                                                                                               |
| test evidence class               | plain pass/fail over the suite                                                         | pass/fail **with instrumentation**, plus a metric derived from the same run | **no**                                                                                                                                                                                                                                |
| other obligations in the same job | 6 non-test gates                                                                       | 3 ratchet gates, one of which needs full history                            | **no**                                                                                                                                                                                                                                |

### 4.3 Why the equivalence does not license removal anyway

Two blockers, both structural:

1. **The carrier is scheduled to retire, and its successor downgrades the run to
   a measurement.** `ratchet.yml:4-12` is explicit: this is the LEGACY head-
   defined leg, kept only until W1.10's cutover makes `cq/ratchet` required.
   In the successor, `cq-measure` runs `pnpm exec vitest run --coverage` as an
   **untrusted head-executed measurement** (`cq-measure.yml:3,105-119`) and
   `cq-verify` _recomputes only the typecheck-count_ from the trust ref
   (`cq-verify.yml:269`), accepting coverage as data. Making the required
   **test** obligation depend on that leg would (a) bind tests to a carrier
   that is being deleted, and (b) bind them to a leg whose verdict is minted
   from untrusted head data — the direction superseded-plan §4 forbids
   ("Do not share executable PR artifacts into trusted signing/verifier jobs";
   "malicious producer artifacts cannot supply trusted verdicts").
2. **Instrumented ≠ plain as a test verdict, and coupling muddies triage.** The
   ratchet's coverage step deletes the stale summary first (`:119`) and asserts
   the metric with `jq -e` in the _same_ step (`:127`); a coverage-metric
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
`max(static, ratchet)`. On the merge-queue candidate push (§1.3 run 2) that is
`max(4m14s, 4m35s)` = 4m35s, and `ratchet` is already the binding leg — folding
the tests into it saves **0%** of candidate latency (it could only lengthen it).
Only on the post-promotion `main` push (run 1: `static` 5m04s vs `ratchet`
4m40s) would the binding leg move, by at most 24s (**≤ 8%**) — a cross-branch
worst case, and below the 16% run-to-run variance measured on `static` (§1.3).
The saving is real but is runner-minutes, not the candidate SLO the spec
actually governs.

**Reopen this decision only when** the successor trusted leg carries a required
**test verdict** (today it carries none — only a typecheck-count recomputation
and an accepted coverage measurement). At that point consolidation is a
separate task with its own expand/contract migration, an equivalence report,
and its own PR. It is not this one.

### 4.5 Equivalent executions removed — reported

**Zero.** Not one duplicate execution is removed by this proposal — whole-suite
or otherwise — and that is the recommendation, not an omission. The full
ledger of duplicates
examined:

| duplicate                                                                         | per push | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| whole suite, plain vs instrumented                                                | 2        | **retained** — different evidence class, carrier retiring, trust direction wrong (§4.3)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm run build` (`ci.yml:63-64` vs `ratchet.yml:95-96`)                          | 2        | **retained** — not equivalent: `static`'s `dist/` is consumed in-job by `gen:op-docs:check` (`:70-71`); `ratchet`'s `dist/` _is_ the judge binary (`dist/cli.js`). Removing either needs a cross-job artifact handoff, which forfeits the emit gate's independence                                                                                                                                                                                                                                      |
| `tsc` invocation (`check:static`'s compiler ratchet vs `ratchet.yml:105-109`)     | 2        | **equivalent, retained** — both are `checkRatchet` over the same `tsc --noEmit -p tsconfig.json --pretty false` (`scripts/ratchet-lib.mjs:207-216`) and the same `typecheck/typecheck-count` baseline, which is already `0` and can only tighten, so either pass implies type-clean. Retained because the `ratchet` carrier is retiring (§4.3) and `cq-verify` recomputes the same count from the trust ref; removing the `static` leg would leave the head-defined path with no compiler gate after C2 |
| `denylist-scan` over the worktree vs over the unpacked tarball (`pack-audit.yml`) | 2        | **not equivalent** — different trees, different `patterns.yml` (the tarball's own)                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

**Successor gate** (`.github/workflows/gate.yml:131-315` →
`trust/dist/selfhost/promote-gate.js`):

1. `wake` verifies the triggering run and that the ref is the default branch for
   a dispatch (`:78-129`); on a `schedule` sweep or a dispatch the verify step
   exits 0 (`:102-105`) and `decide` resolves its own subject, so every sweep
   is a fresh promotion attempt with its own deadline (§3.3).
2. `decide` runs from the **trust ref**, in `environment: promote`, as the sole
   member of concurrency group `promote` with `cancel-in-progress: false`
   (`:136-141`) — a promotion is never cancelled mid-push — and refuses a
   half-registered App pair (`:160-177`).
3. It requires the tip's newest valid `cq/ratchet` verdict to be `success`
   (`promote-gate.ts:980-996`; failure → `refuse`, missing → dispatch
   `cq-verify` and keep polling).
4. For each file in `--verifiedWorkflows` it requires the newest
   `head_sha=tip&event=push&branch=merge-queue` run to have
   `conclusion === 'success'` **and every job in it `completed`/`success` with
   a runner and steps** (`:999-1024`, `:487-536`).
5. A failed `cq/ratchet` verdict or a failed verified run → `refuse`
   immediately (`:987-990`, `:1019-1022`); only missing or pending evidence is
   polled to `--timeoutMin` (20), then `refuse('timeout: …')` (`:1035-1038`);
   a recheck pass that is no longer green also refuses immediately
   (`:1031-1034`).

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
- Therefore: **promotion needs a human, and demotion is louder.** Adding
  `static-macos` raises no `required-check` or `entry-removed` finding, because
  at judgement time the trust list does not contain it and the `static` job is
  untouched — but it is not quiet: a new `.github/workflows/ci-macos.yml` always
  draws `workflow-new` (`src/ops/gates/workflowScan.ts:1365-1369`), a
  `needs-human` verdict (`test/ops/gates/policyDiff.test.ts:651-660`), and the
  `scripts/denylist-scan` edit draws `protected-path`. The change set that
  introduces the workflow must budget for and record that adjudication.
  Retiring it — job, context, or list entry — trips D11 and requires a human to
  accept a `cq/policy` finding with the reason recorded. That asymmetry is
  correct doctrine (weakening the required set must be visible) and it means a
  rollback is never an unattended operation.
- Ordering: trust-list and producer changes travel in the **same** change. A PR
  that removed only the producer, or only the list entry, would either fail D11
  outright or leave the aggregate reading an obligation with no producer.
- Outward-facing steps (S4 rulesets, S5/S6 protection) are applied by the owner
  in the same pass, ordered by direction. A live requirement may name a
  context only while its producer runs on every PR head. On promotion it is
  added after the producer exists (for macOS, after phase A and before the
  phase-B change merges, §2.6). On demotion or rollback it is removed
  **first**, before the change that removes or renames the producer (§3.4).
  Otherwise the rollback PR itself waits on a required context it no longer
  produces and hangs with no failing check. Afterwards the render check
  (`scripts/github-settings-drift.mjs:162-176`, which reads both the rulesets and
  each branch's protection) must be re-run to confirm the applied
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
4. Both promotion gates are simultaneously active with different required sets,
   and each promotes on its own; today promotion is `(all S3) OR (all S7)`. A
   check only one gate requires (e.g. `from-source`, S7 only) does not block
   promotion while the other gate's set is fully green, but it does block it
   once an obligation unique to the other gate is also red — rollback and
   reconciliation analysis must evaluate both predicates, never the
   intersection of the sets.
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
