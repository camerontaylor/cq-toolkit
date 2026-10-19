# Protected scope: the deployed system, not the codebase

Owner principle, 2026-10-16: _"It makes sense to have the deployed quality
system protected. It does not make sense to have every iteration on an
in-development codebase protected. Batching gets most of the way there."_
The owner approved four measures: C3 soon, so the gate honours `cq-override`;
the D-P revision window; protection narrowed to the deployed system; and
batching the remaining protected changes.

## The rule

A path is protected (D11, [ADR-0004](adr/0004-policy-check-trust-boundaries.md)
D-G) when a **deployed consumer reads it, or executes it with privilege**:

- a trusted job runs it (`trust/dist/...` in a rendered workflow) to post a
  verdict or move `main`;
- a job holding a secret or environment executes it, unless what it produces
  is judged again by a protected judge (the named residual below);
- it renders the workflows or is policy data the gate, the signer or crq reads;
- it defines what a ratchet measures;
- it is the signer's code, its custody files, or crq's deploy contract.

In-development library code and its tests are not protected when nothing
deployed executes them. Every change still needs I2 acceptance on its way to
`merge-queue`. The protected judges then check whatever it produces.

Three lists feed D11, and this note changes only the third:

1. The built-in taxonomy (`isProtectedPolicyPath`, `src/ops/gates/protectedPaths.ts`).
   It covers `.github/**`, `policy/**`, `lint/**`, `baselines/**`, lockfiles,
   `package.json`, tsconfig, `*.config.*`, rc files, `.gitignore` (oxlint and
   knip honour it), `.gitattributes` (`git archive`, which the signer deploy
   uses), `.cq/tool/**`, and the build and ratchet scripts. Every entry is
   policy, a workflow, a ratchet definition or a build input, so all of it
   stays. The sweep worker gate shares this taxonomy, and narrowing it would
   weaken that control too.
2. The ratchet definition set (`baselines/ratchets.json`). Unchanged.
3. The project list (`policy/protected-paths.json`). Rewritten here.

## Project list: kept

| Entry                                                                                                                                                                                                                                                                                          | Deployed consumer                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ops/gates/{policyDiff,policyDiffInput,policyConfig,overrideRecord,d11Authorization,workflowScan,protectedPaths,checkRunner,registry}.ts`, `adapters/{eslint,tsc,vitest}.ts`                                                                                                               | `cq-policy` runs `policyDiff` in-process (`trust/dist/selfhost/policy-diff.js`), and `gate.yml` recomputes it in-process. `policyDiffInput.ts` is the input schema both share with the CLI binding in `registry.ts`, which no trusted job loads since R1 closed                                                                                                                                                                        |
| `src/ops/ratchet/**` plus `src/shared/gitHarden.ts` (Phase 1.3 extracted hardened argv), `src/adapters/git/ratchetGit.ts` and `src/adapters/forge-github/ratchetEffects.ts` (Phase 1.4 moved the git plumbing and the baseline PR effects out of `ops/ratchet/`; the regexes follow the files) | `cq-verify`'s judge runs `verifyRatchet` in-process (`trust/dist/selfhost/verify-ratchet.js`) and posts the `cq/ratchet` verdict the gate requires; its compute job runs `recomputeTypecheck` in-process too (`trust/dist/selfhost/recompute-typecheck.js`). `ratchet-propose` (environment `automation`) loads the engine (`scripts/ratchet-lib.mjs` `loadEngine`). Only the `index`/`effects` barrels are not executed by those jobs |
| `src/adapters/forge-github/gh.ts`, `src/ops/review/threads.ts`, `src/shared/independent-review.ts` (Phase 1.4 moved `gh.ts`; the regex follows the file)                                                                                                                                       | the I2 evidence that `cq-accept` (`trust/dist/selfhost/acceptance.js`) and the gate compute                                                                                                                                                                                                                                                                                                                                            |
| `src/selfhost/{promote-gate,acceptance,merge-recheck,config,state-branch,verify-ratchet,policy-diff,recompute-typecheck,trusted-entry}.ts`                                                                                                                                                     | `gate.yml` `decide` (environment `promote`), `cq-accept`, and the `cq-verify` and `cq-policy` entries. `trusted-entry.ts` is the argv and I1 output contract those entries share                                                                                                                                                                                                                                                       |
| `policy/promotion-reviewer.json`                                                                                                                                                                                                                                                               | the gate's reviewer pin. The signer test pins it as well (also covered by the built-in `policy/**`)                                                                                                                                                                                                                                                                                                                                    |
| `scripts/ratchet-*.mjs`                                                                                                                                                                                                                                                                        | `pnpm run build` (which builds the trusted dist) and `check:static`, which produces the required `static` check                                                                                                                                                                                                                                                                                                                        |
| `scripts/github-settings-drift.mjs`, `scripts/lib/github-settings.mjs`                                                                                                                                                                                                                         | `settings-drift` (environment `cq-verdict`, App token with admin read), whose output is the C3/T5 evidence                                                                                                                                                                                                                                                                                                                             |
| `scripts/adversarial-suite.mjs`                                                                                                                                                                                                                                                                | `adversarial-suite` (environment `adversarial-scratch`, scratch App secrets)                                                                                                                                                                                                                                                                                                                                                           |
| `scripts/denylist-scan`                                                                                                                                                                                                                                                                        | the required `denylist` check. Also in the definition set                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/crq-python/signer/**`                                                                                                                                                                                                                                                                    | the queue-host signer: the reviewer App key, the identity pins, `spool-shell`, the root-owned unit, `DEPLOY.md`                                                                                                                                                                                                                                                                                                                        |
| `apps/crq-python/ops/systemd/**`, `ops/prepare-*.py`                                                                                                                                                                                                                                           | crq's deploy contract: what runs, when, and from which root                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/crq-python/config.json`                                                                                                                                                                                                                                                                  | crq's live config, which carries its reviewer identity pin (`app_login`, `reviewer_bot_id`)                                                                                                                                                                                                                                                                                                                                            |

## Project list: dropped

| Entry (was)                                                                                                          | Why nothing deployed needs it protected                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| rest of `src/ops/gates/**` (`hackDetector`, `commitGate`, `regressionGate`, `baselineProbe`, `fingerprint`, `index`) | only the sweep (library code) calls them. No trusted job runs them                                                                   |
| `src/ops/merge/classify*`                                                                                            | the merger's admission. `promote-gate` re-judges I2 for every PR it admits, so a bad admission blocks promotion and cannot cause one |
| `src/selfhost/candidates.ts`                                                                                         | the merger's candidate fetch (wire mapping only), re-judged the same way                                                             |
| `scripts/render-templates.mjs`, `scripts/lib/render-templates.mjs`                                                   | no job executes them. What they produce (`.github/workflows/**`, from `policy/templates/**`) is itself protected and diff-checked    |
| `apps/crq-python/` except the entries above                                                                          | see below                                                                                                                            |

**`crq.py` is not protected.** It runs on the queue host as `operator`, an
agent-reachable user. It requests promotion reviews but cannot forge one: the
signer works out every decision again itself. It validates the request,
secret-scans the diff, reviews in its own clone with configuration from
`base_sha`, and checks its own ledger (`signer/README.md`). The worst a bad
`crq.py` can do is withhold reviews or spend the review budget. That shows up
as a stall, not a false promotion. Deploys to the queue host already need the owner's
go-ahead, from a SHA reachable from `main` with recorded hashes
(crq-into-monorepo amendment §2). That is the owner's checkpoint for crq.
Protecting it at merge time would add a second one for code that cannot judge.

## Accepted residuals (named, with their fixes)

These are open owner decisions. R1 is not new: none of its files was
protected before this change. R2 is mostly not new, with one exception.
Before this change, `src/ops/merge/classify*` and `src/selfhost/candidates.ts`
were protected as admission logic, and this change drops them because the gate
re-judges every PR they admit. That is a deliberate narrowing, and **owner
acceptance is needed**. It also widens R2 by those three files: they run in
the `self-merge-prs` and `self-review-loop` jobs. Those protections never
covered those jobs' credentials, though. The other ~60 files in the same
closures, including the drivers and harness, were already unprotected.

**R1: the CLI dispatch shell in the trusted verifier jobs.** Two trusted
calls still dispatch through `dist/cli.js`: `cq-policy`'s `gates.policyDiff`,
and `cq-verify`'s compute job, which runs `ratchet.recomputeTypecheck` to
produce the typecheck count. On every dispatch, `src/registry/index.ts`
imports every `src/ops/*/registry.ts`. So the CLI shell (`src/cli/**`,
`src/kernel/**`, `src/registry/**`) and the static imports of each op
registry run in those jobs. That is about 85 files, mostly in-development
code, and they are not protected. A malicious change there needs I2
acceptance, then promotion. Once deployed, it could forge the PR-level
`cq/policy` check, or the typecheck count that feeds `cq/ratchet`, so a
**typecheck regression could promote**. It cannot get a protected-path or
definition change past the gate: the gate is authoritative (D-G.5) and
recomputes `policyDiff` in-process, without the CLI, including the monotonic
baseline guard.

**Narrowed in this PR:** the `cq/ratchet` verdict itself (`judge`) now runs
in-process (`dist/selfhost/verify-ratchet.js`, readiness T2), so coverage and
baseline judgement no longer load the registry.

**Fix (the next protected batch):** give `recomputeTypecheck` and the PR-level
`policyDiff` their own `dist/selfhost/` entry points too. The alternative is
to protect `src/cli/**`, `src/kernel/**` and `src/registry/**` now. That only
narrows R1, because the registry closures still load, and it protects the
kernel exactly while Phase 1 is revising it.

**R2: privileged jobs that run unprotected code.**

| Job                         | What it runs                                                                                        | Credentials                                                        | What bounds it                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `self-review-loop`          | `dist/selfhost/self-review-loop.js`, about 68 files (drivers, harness, review ops, `candidates.ts`) | automation App token (per run), `Z_AI_API_KEY`, `DEEPSEEK_API_KEY` | pushes go only to PR heads, and `cq/acceptance` and the gate judge them again           |
| `self-merge-prs`            | `dist/selfhost/self-merge-prs.js`, about 60 files (merge ops, `classify*`)                          | automation App token (per run)                                     | merges go only into `merge-queue`; the gate re-judges closure, I2 and policy            |
| `live-drivers`              | `scripts/{dd1-abort-spike,demo-eval-axes}.mjs`, the drivers                                         | `drill` model keys                                                 | a dispatch-only drill (`workflow_dispatch`, `main` branch policy, no required reviewer) |
| `live-merge`, `live-review` | drill tests                                                                                         | drill PATs (absent from the repository today)                      | disabled until the drill App exists                                                     |

A merged change to this code can read the job's credentials. The worst case
is a spent model key or a short-lived automation token. Neither can move
`main` or post a trusted verdict. Protecting these closures would protect the
drivers and harness, the core of the in-development code.
**Fix:** run model workers without the automation token. The sandbox
launcher already strips runner credentials from run children
(`test/adversarial/boundary-rows.test.ts` A11/A17); the remaining gap is the
in-process code.

`test/ops/gates/protectedPaths.test.ts` pins this table. Every script or
selfhost entry that a privileged job runs must be protected or appear in its
residual list, and every listed entry must still be in use. Adding a
privileged executor therefore fails CI until someone classifies it.

## How the scope stays honest

`test/ops/gates/protectedPaths.test.ts` follows the value-import closure of
the judging entry points and fails when a file is unprotected. The entry
points include the ratchet engine that `loadEngine` imports, parsed from the
script. It also pins which `trust/dist/...` calls the workflows contain.
`test/ops/gates/policyDiff.test.ts` fails if a protected entry matches no
tracked file. A pending entry, one whose tree has not landed yet, must be
named in that test, and none is pending today.

## The D-P revision window

`revisionWindow` in `policy/protected-paths.json`:

| Field     | Value                                |
| --------- | ------------------------------------ |
| `posture` | `diff-check`, the only allowed value |
| `opens`   | `2026-10-17T00:00:00Z` (inclusive)   |
| `expires` | `2026-10-31T00:00:00Z` (exclusive)   |
| `ruling`  | D-P (owner, 2026-10-16)              |

- `policyDiff` reads it **from the trust ref only**, both in `cq-policy` and
  in the gate's recompute. A PR cannot open a window for itself, and editing
  the window is a change to `policy/protected-paths.json`, which is a
  definition-set file. That is needs-human in every posture.
- It only relaxes the **default** layer. An explicit `vars.CQ_MERGE_PROTECTED_PATHS`
  or per-call opt-in wins.
- Inside the window, a plain protected-path edit passes. Everything else
  diff-check flags still needs the D11 record: privileged-job changes,
  definition-set changes, loosened baselines, removed entries or checks,
  trigger changes and new workflows.
- A changed verified workflow that no longer names one of the trust ref's
  `requiredJobs` is a `required-check` finding, which the window never
  clears.
- **Fail closed.** Before `opens` (`not open yet`), at or after `expires`
  (`EXPIRED`), or with an unusable clock (`clock unusable`), the posture is
  `human`, and the run report ends that line with `— posture human (fail closed)`.
  An invalid window fails the policy check: a bad date, `expires` not after
  `opens`, or a span over 31 days (`MAX_REVISION_WINDOW_DAYS`). Extending the
  window takes a new protected edit.
- **Promote before `expires`.** The gate judges `main..tip` when it
  promotes. A protected edit merged into `merge-queue` inside the window but
  not promoted by `expires` makes the whole batch needs-human, and until C3
  that means owner break-glass. A promotion whose policy pass relied on the
  window is judged again just before the push (`promote-gate` step 10c), so
  a gate run that waits past `expires` refuses.

This amends ADR-0002 Annex B §B.1 ("only the project env and the per-call
opt-in") for this one shape. See [ADR index](adr/README.md#post-acceptance-notes) N23.

## Required jobs as policy data

`requiredJobs` in `policy/protected-paths.json` names, by display name, the
jobs the promotion gate requires in each verified workflow's run. A green run
is not enough when someone could delete a job. Today the list is
`ci.yml: static, crq-python, from-source` and `denylist.yml: denylist`. #327
added the `crq-python` requirement as a hard-coded check in
`promote-gate.ts`, and that check is now this data. Removing an entry is an
`entry-removed` finding. Dropping a required job from its workflow is a
`required-check` finding. A file the gate does not verify
(`--verifiedWorkflows`) causes a refusal.

## Required checks: enforce at promotion, not at merge

Owner, 2026-10-16: _"Why would I want more required checks? This repo is
already crippled by them."_ The same principle applies here: enforce at the
deployed boundary. A merge into `merge-queue` deploys nothing; promotion to
`main` does. A merge-time requirement stays only where the gate cannot
enforce the same thing later.

| Check                                                   | What it prevents                                                 | Gate enforces it at promotion?                                                                                           | Merge-time requirement                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cq/policy`                                             | an unauthorized protected or definition change (D11)             | it recomputes `policyDiff` over `main..tip`, but until #322 it cannot read a PR's `cq-override` label for a push subject | **keep**: the PR check is where the owner's D11 record is honoured, and it keeps an unauthorized protected change out of the batch                                                                                                             |
| `cq/acceptance`                                         | admitting code without independent review of its exact head (I2) | it recomputes the I2 evidence per admitted PR                                                                            | **keep**: I2 is the queue's admission rule. One unaccepted hand-merge blocks promotion of the whole batch until it is reverted. It is a verdict, not a CI run                                                                                  |
| `denylist`                                              | denylisted content (secrets, internal names) in the merged tree  | `denylist.yml` must be green on the tip                                                                                  | **keep**: R0 makes `merge-queue` history append-only, so the gate can refuse to promote a leak but cannot un-merge it. Runs in seconds. It scans the tree, not history (`--no-git`), so a secret added and deleted within one PR is a residual |
| `cq/ratchet`                                            | baseline or coverage regressions (I5)                            | the verdict is required on the tip, bound to `main`                                                                      | drop                                                                                                                                                                                                                                           |
| `static`                                                | type, lint and test failures                                     | every `ci.yml` job must be green on the tip (`requiredJobs`)                                                             | drop                                                                                                                                                                                                                                           |
| `crq-python`                                            | crq Python test failures                                         | the same, by name                                                                                                        | drop (never applied live)                                                                                                                                                                                                                      |
| `from-source`                                           | a from-source smoke failure                                      | the same, by name                                                                                                        | drop                                                                                                                                                                                                                                           |
| `pack-audit`                                            | a bad npm tarball                                                | no; it runs on PRs only, not on the queue tip                                                                            | drop: the deployed boundary is publication, and the release runbook dispatches `pack-audit.yml` on the release SHA                                                                                                                             |
| `ratchet` (classic, live)                               | the head-defined ratchet check                                   | superseded by `cq/ratchet`                                                                                               | drop (R2 already omitted it)                                                                                                                                                                                                                   |
| `main`: `static`, `denylist`, `ratchet` (classic, live) | an unchecked commit on `main`                                    | `main` moves only through the gate's fast-forward (R1: promoter App only)                                                | drop (R1 carries no status checks)                                                                                                                                                                                                             |

|               | Before (live classic)                                        | Before (settings-as-code R2)                                                                                | After (R2 here)                          |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `merge-queue` | `static`, `denylist`, `from-source`, `pack-audit`, `ratchet` | `cq/policy`, `cq/ratchet`, `cq/acceptance`, `static`, `crq-python`, `denylist`, `from-source`, `pack-audit` | `cq/policy`, `cq/acceptance`, `denylist` |
| `main`        | `static`, `denylist`, `ratchet`                              | none (R1: promoter-only updates)                                                                            | none                                     |

Bot merges usually wait for green CI, but only as best-effort screening.
The merger considers only `CLEAN`, `BEHIND` and `HAS_HOOKS` PRs
(`classifyPrs.ts`). GitHub reports failing or pending non-required checks as
`unstable`, and the merger treats that as `UNKNOWN`, so the PR waits. But a
candidate can turn `unstable` between screening and the merge, and the
merge-time recheck reads no CI evidence. **The gate is the CI enforcement
boundary.** What this change removes is the hard block on merges, mostly
hand-merges and stuck checks. The cost is that a red merge stalls its batch
at the gate until a fix lands. It cannot reach `main`.

The live settings change when the owner applies R2 and deletes the classic
protections (C3 readiness, T6). The payload is `cq-r2-merge-queue.json` in
the ARCH research `strategy/rulesets/`. This PR changes only the
settings-as-code.

Migration 1.2 keeps the former `src/selfhost/settle-state.ts` protection and adds
exact protection for `src/policy/queue/settle-state.ts`. The composition-owned
ledger path now lives in `src/selfhost/config.ts`; that module and its runtime
dependency `src/shared/deepFreeze.ts` are protected with exact patterns too.
The existing gates protections remain unchanged.
