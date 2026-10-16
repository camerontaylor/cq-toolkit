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

| Entry                                                                                                                                           | Deployed consumer                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ops/gates/{policyDiff,policyConfig,overrideRecord,workflowScan,protectedPaths,checkRunner,registry}.ts`, `adapters/{eslint,tsc,vitest}.ts` | `cq-policy` runs `trust/dist/cli.js gates.policyDiff`, and `gate.yml` recomputes it in-process. `registry.ts` resolves the posture                                                                                                                                                                                          |
| `src/ops/ratchet/**` (unchanged)                                                                                                                | `cq-verify` runs `trust/dist/cli.js ratchet.verifyRatchet` and `ratchet.recomputeTypecheck` and posts the `cq/ratchet` verdict the gate requires. `ratchet-propose` (environment `automation`) loads the engine (`scripts/ratchet-lib.mjs` `loadEngine`). Only the `index`/`effects` barrels are not executed by those jobs |
| `src/ops/review/{gh,threads}.ts`, `src/shared/independent-review.ts`                                                                            | the I2 evidence that `cq-accept` (`trust/dist/selfhost/acceptance.js`) and the gate compute                                                                                                                                                                                                                                 |
| `src/selfhost/{promote-gate,acceptance,merge-recheck,settle-state,state-branch}.ts`                                                             | `gate.yml` `decide` (environment `promote`) and `cq-accept`                                                                                                                                                                                                                                                                 |
| `policy/promotion-reviewer.json`                                                                                                                | the gate's reviewer pin. The signer test pins it as well (also covered by the built-in `policy/**`)                                                                                                                                                                                                                         |
| `scripts/ratchet-*.mjs`                                                                                                                         | `pnpm run build` (which builds the trusted dist) and `check:static`, which produces the required `static` check                                                                                                                                                                                                             |
| `scripts/github-settings-drift.mjs`, `scripts/lib/github-settings.mjs`                                                                          | `settings-drift` (environment `cq-verdict`, App token with admin read), whose output is the C3/T5 evidence                                                                                                                                                                                                                  |
| `scripts/adversarial-suite.mjs`                                                                                                                 | `adversarial-suite` (environment `adversarial-scratch`, scratch App secrets)                                                                                                                                                                                                                                                |
| `scripts/denylist-scan`                                                                                                                         | the required `denylist` check. Also in the definition set                                                                                                                                                                                                                                                                   |
| `apps/crq-python/signer/**`                                                                                                                     | the queue-host signer: the reviewer App key, the identity pins, `spool-shell`, the root-owned unit, `DEPLOY.md`                                                                                                                                                                                                             |
| `apps/crq-python/ops/systemd/**`, `ops/prepare-*.py`                                                                                            | crq's deploy contract: what runs, when, and from which root                                                                                                                                                                                                                                                                 |
| `apps/crq-python/config.json`                                                                                                                   | crq's live config, which carries its reviewer identity pin (`app_login`, `reviewer_bot_id`)                                                                                                                                                                                                                                 |

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

**R1: the CLI dispatch shell in the trusted verifier jobs.** The trusted
verifiers dispatch through `dist/cli.js`. On every dispatch,
`src/registry/index.ts` imports every `src/ops/*/registry.ts`. So the CLI
shell (`src/cli/**`, `src/kernel/**`, `src/registry/**`) and the static
imports of each op registry run in the trusted `cq-policy` and `cq-verify`
jobs. That is about 85 files, mostly in-development code, and they are not
protected. A malicious change there needs I2 acceptance, then promotion.
Once deployed, it can forge the `cq/policy` check at PR level and the
`cq/ratchet` verdict. The gate consumes `cq/ratchet` as decisive, so **a
forged measurement verdict could promote a ratchet regression**: a coverage
or typecheck loss. It cannot get a protected-path or definition change past
the gate. The gate is authoritative (D-G.5) and recomputes `policyDiff`
in-process, without the CLI, including the monotonic baseline guard.
**Fix (the next protected batch):** give each verifier its own
`dist/selfhost/verify-*.js` entry point, the way `promote-gate.js` already
works, so that no trusted job loads the registry. Until then, the
`cq/ratchet` verdict is not covered by protection. The alternative is to
protect `src/cli/**`, `src/kernel/**` and `src/registry/**` now. That only
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
tracked file. The only exception is a named pending entry: the crq entry
until #327 lands.

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
jobs the promotion gate requires in each verified workflow's run. Before
this change no job names existed at all; #327 would have added the first one
as code. A green run is not enough when
someone could delete a job. Today the list is `ci.yml: static, from-source`
and `denylist.yml: denylist`. PR #327 adds `crq-python` to this data instead
of hard-coding it in `promote-gate.ts`. Removing an entry is an
`entry-removed` finding. Dropping a required job from its workflow is a
`required-check` finding. A file the gate does not verify (`--verifiedWorkflows`)
causes a refusal.
