# ADR 0004: Policy-check trust boundaries (execution provenance)

> Publication note (W7.2): copied from `toolkit-research` branch `research/g1-adr-reconciliation` at `bf5f540`. The status above records the later owner G1 decision. References below to pending G1 approval or draft status describe the source text at its drafting date; accepted preconditions and residuals remain binding.

Status: **accepted** (owner G1 sign-off, 2026-09-26; binding work-item preconditions and residuals retained)
Date: 2026-09-24 (r0 `b917dcf`; r1 `efdfbbc`); G1 reconciliation 2026-09-25
**Reconciled (G1 prep): 2026-09-25.** Folds `adr-0004-critic-r2-verdict.md` (`research/adr-0004-critic-r2` @ `7d62e70`): R2-2 (the typecheck recompute's definition set) and the text-level minors R2-3…R2-10. R2-1 is an **owner decision** and is stated, not taken (D-D.2, D-G.4). Finding → section → change: `adr-reconciliation-log.md`. Reconciled with the paired ADR-0002/0003 drafts, with which this ADR shares no interface beyond the W1 plan items.
Scope of this draft: the **execution-provenance** part of ADR-0004 (plan §5), from RS-4. The overseer integrates the reviewer trust set and SHA binding (RS-3), automation identity and tokens (RS-11/D2) and I3-as-code (D13); their interface points are marked **[RS-3]**, **[RS-11]** and **[D13]**.
Evidence: `research/research-20260925-v11/rs4-policy-check-provenance.md`. It holds r0 trials T-1…T-14, **r1 trials T-15…T-21** (§8) and doc findings D-1…D-10.
Critic verdict: `research/adr-0004-critic` @ `928764b`. **Appendix A** has the disposition of all 12 findings, **Appendix B** the plan-wording deltas for G1, and **Appendix C** the RS-11 inputs.

## Context

The 2026-09-24 evaluation (T1, and the §4 correction) found two flaws in the toolkit's policy checks.

- They execute the definitions and code of the party they judge.
  - `ratchet.yml` runs on `pull_request`, so the head's workflow file defines the metric.
  - `merge-queue-gate.yml` runs on `push` to `merge-queue` holding the promote PAT, so a merged PR controls the next promotion.
- RS-4 reproduced the second flaw live: the attacker's gate ran with the real repo-level secret (T-9).
- **Any repo-level secret is readable by a workflow a same-repo PR adds** (T-S).

cq-toolkit is a **user-owned public** repository. It has none of these GitHub-native backstops (T-14, D-8):

- required workflows;
- push/file-path rulesets;
- a merge-queue rule;
- evaluate mode;
- classic push restrictions.

Two more gaps:

- Required-check "expected source" pins an _app_, not a workflow file. Any workflow can forge a GitHub-Actions-app status or check run:
  - latest-wins statuses (T-11/T-12);
  - check runs that attach to real runs' suites and job lists (T-13);
  - a forged check that is the **only** row when the real job never reports (T-16).
- **Environment "protected branches only" admits unprotected branches** once rulesets are the only protection (T-19).

## Decision

### D-A. Carriers: where a deciding job's definition may come from

1. **Allowed carriers** for anything a policy decision depends on, all of which execute the **default-branch** workflow file (D-1, D-4; T-2, T-7, T-10):
   - `workflow_run`;
   - `schedule`;
   - `workflow_dispatch` honoured only when `github.ref == refs/heads/<default>`;
   - `push` to the default branch.

   `pull_request_target` also qualifies as a carrier, but **this design uses it for no deciding or required check** (D-B, Appendix A #1).

2. **Rejected carriers for privileged or deciding jobs:**
   - `pull_request`, including a job that "checks out base" (T-1);
   - `push` to any non-default branch (T-9);
   - `workflow_dispatch` on a non-default ref.

   This includes any _dispatch_ issued with a non-default `ref`. `sync-merge-queue.yml`'s `ref=merge-queue` gate dispatch is changed to `ref=<default>`.

3. **A pinned published toolkit is a code source, not a carrier** (T-1; D-E).
4. **Head-defined legs are wake-ups and untrusted producers only.** `ci`, `cq-measure` and `cq-signal` run the head's definition. Their _absence_ must produce a blocked PR, never a pass. Required verdicts are therefore App-created (D-F), and absence can't be papered over by a forgery (T-16).

### D-B. Mechanism per check

All deciding verifiers run under `workflow_run` from the default-branch definition. They post **check runs created by the verdict App** (D-F, D-J) on the subject SHA. Each check run encodes the trust-ref SHA it was computed against in `external_id` (`<trust-ref-sha>:<subject-sha>`).

**Compute and sign are separate jobs (critic r2 R2-4).** Every verifier that installs packages or runs a tool over head content (the typecheck recompute; any authorized tip-lockfile install) splits into a **compute** job (`permissions: {}`, no `environment:`, emits only numbers as a strict-schema artifact) and a **sign/push** job (the environment, consumes the numbers, holds the key). Env secrets are loaded at job start and are readable from runner memory by any process in the job, and a head `tsconfig` (`files`, `include`, `typeRoots`) can point `tsc` at arbitrary runner paths. So no credential-bearing job ever runs a head-selected install or a tool over head content. This is what makes D-D.3's "none of them runs head code" true.

| Check                                                          | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Native enforcement (merge-queue ruleset R2)                        | Gate                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Ratchet: coverage (head-executed)**                          | `cq-measure` (`pull_request` + `push: merge-queue`; `permissions: {}`; no `secrets.*`, no `environment`) runs head tests and uploads a coverage artifact. `cq-verify` (`workflow_run: [cq-measure]`, env `cq-verdict`) judges it against trust-ref baselines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `cq/ratchet`, App-created check run, expected source = verdict App | the same check run, selected by verdict-App `app.id` and bound to the promoted `main` SHA   |
| **Ratchet: typecheck-count (trusted recompute)**               | **Computed in `cq-verify`'s compute job** (above) with the **trust-ref toolchain**. The `node_modules` is installed with `npm ci --ignore-scripts` from the lockfile chosen per D-C.3, and the trust-ref `tsc` runs over the head tree. The head tree is extracted as data **without attributes**: `git ls-tree -r -z <sha>` plus `git cat-file blob` per entry into a scratch dir that has no `node_modules` of its own. Never `git archive`, which honours head-controlled `.gitattributes` (`export-ignore` silently drops files, `export-subst` rewrites content; critic r2 R2-2, reproduced locally). The tsc CLI does not load `compilerOptions.plugins` (T-21), and tsc executes no project code. A timeout means failure. Diagnostics are not logged beyond counts (R2-4). | part of `cq/ratchet`                                               | **consumed** from `cq/ratchet` (D-F.1); `decide` does not recompute typecheck itself (R2-4) |
| **Monotonic guard + D11 base-ref policy diff + workflow lint** | `cq-policy` (`workflow_run: [cq-signal]`, env `cq-verdict`). Data only: the head is fetched as git objects, diffed with `--text --no-ext-diff --no-textconv --no-renames`, and parsed, never executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `cq/policy`, App-created                                           | **recomputed** over `main..tip`                                                             |
| **I2 acceptance**                                              | `cq-accept` (`workflow_run: [cq-signal]`, env `cq-verdict`) runs `classifyPr` over API reads only **[RS-3]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `cq/acceptance`, App-created                                       | **recomputed** per accepted PR in `main..tip`                                               |
| **Merge-queue gate (promotion)**                               | Two jobs (D-K). `wake` (any allowed carrier: `workflow_run: [ci, cq-measure]` on `merge-queue`, `schedule` sweep, dispatch-on-default) → `decide` (`needs: wake`, **sole member** of concurrency group `promote`, `environment: promote`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                  | resolves the tip itself, verifies the range and verdicts, then does the atomic fast-forward |
| **ratchet-propose**                                            | `ratchet-propose-measure` (`push: main`, `permissions: {}`) produces an artifact. `ratchet-propose` (`workflow_run`, env `automation`) opens the proposal PR **against `merge-queue`**, branched from the merge-queue tip, authored by the automation App (excluded from the trust set, D2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | normal PR checks                                                   | normal gate                                                                                 |

`cq-signal` (`pull_request` with `types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review, edited]`, plus `pull_request_review` and `pull_request_review_comment`; `permissions: {}`; empty body) is a **wake-up only**. Verifiers re-read everything from the API by `head_sha`, and a `schedule` sweep (default-branch definition, every 15 min in the automation window) re-evaluates open merge-queue PRs whose App verdicts are missing or stale. Label and review events therefore re-evaluate D11 records and acceptance (Appendix A #1).

`pull_request_target`: **not used for any required check.** A non-required, informational `pull_request_target` job is permitted but not shipped by default. If one is used, it must reference no `environment:` and no `secrets.*` other than `GITHUB_TOKEN` (enforced by the D-G lint), and the repository Actions event policy must allow it (T-15, D-I).

### D-C. Verification every `workflow_run` verifier performs

1. `github.event.workflow_run.path` equals the expected workflow file (T-3). `event` is in the expected set. `head_repository.id == github.repository_id` (fork runs are refused).
2. **The subject is `head_sha`**, never `head_branch`. The PR is resolved with `GET /commits/{sha}/pulls` plus a base-branch check, and never from `pull_requests[]`.
3. **Definition check.** The _definition set_ (D-C.4) is read as a **list** from the trust ref (`origin/<default>`). Whether the subject _changed_ a definition is decided by the subject's kind:
   - **PR subject:** diff `merge-base(head, base)..head`, where `base` is the PR's base branch (normally `merge-queue`). Sibling PRs are therefore not flagged for already-queued, D11-authorized changes (Appendix A #2). The gate's closure rule (D-K.3) independently refuses any unauthorized content in `merge-queue`.
     - If the PR changes a definition **and** carries a valid D11 record (D-G.4), the verifier judges the artifact produced under the head's new definition. The lists (targets, the definition set itself) still come from the trust ref.
     - If there's no record, the result is failure with "needs-human (D11)".
     - **Typecheck toolchain for PR subjects (critic r2 R2-6).** The recompute installs from the lockfile at `merge-base(head, base)` when `main..merge-base` is authorized under the push-subject rule below, and from the **head's** lockfile when the PR carries a valid D11 record for its own lockfile change. Otherwise it uses the trust-ref lockfile. Every install uses `--ignore-scripts` inside the compute job. This removes the sibling cost (TS2307 against a queued-but-unpromoted dependency change) that round-1 #2 removed for measurement definitions.
   - **Push subject (the merge-queue tip):** diff `main..tip`. A definition difference is _authorized_ iff every commit in `main..tip` that introduces it belongs to an accepted PR carrying a valid D11 record (D-H). When it's authorized, the verifier judges the artifact produced under the **new** definition. Where the lockfile changed with authorization, the trusted typecheck recompute installs from the **tip's** lockfile with `--ignore-scripts`.
   - An unauthorized change → `cq/*` = failure with the reason "needs-human (D11)".
4. **The definition set** (read from the trust ref; its own path is in the set):
   - every workflow file that is a `workflow_run` source or produces a required check or verdict input: `ci.yml`, `denylist.yml`, `cq-measure.yml`, `cq-signal.yml`, and every privileged workflow;
   - measurement configs: **`vitest.config.*`, `vite.config.*`, `vitest.workspace.*`** (globbed, so a new higher-precedence config name can't escape the set), coverage config, `tsconfig*.json` **and every file reachable from their `extends`/`references` graph** (e.g. a `config/base.json` target), `package.json` (whole file, not just scripts);
   - **`**/.gitattributes`** (critic r2 R2-2: `export-ignore`/`export-subst` steer any attribute-honouring extraction, and attributes also change diff and merge behaviour);
   - **lockfiles** (`package-lock.json`, `npm-shrinkwrap.json`), `.npmrc`, `.nvmrc`/`.node-version`, `engines`;
   - the tool manifest (`.cq/tool/**`);
   - `baselines/ratchets.json`, the protected-path list and the required-check list.

   `referenced_workflows` must be empty or match pins held on the trust ref.

5. **Artifacts are data** (D-3). Download into a temp dir, cap the size, validate against a strict schema (numbers and enums only), and never execute, source or install them. Head files are read with `git show` or `git ls-tree`/`git cat-file` (attribute-free); never `git archive` (D-B). The head is never checked out into a workspace where anything runs, and the trust-ref toolchain lives outside the extracted head tree.
6. Targets, baselines, protected-path lists, the definition set and the required-check list are read from the trust ref (A5; T-5/T-6).
7. Deciding jobs set `cache: ''` on `setup-node` and use no `actions/cache` restore (a belt against cache poisoning; critic out-of-scope note).

### D-D. Credentials and identities (correctness rules under P8, no config key)

1. **No repository-level secrets at all.** This covers write credentials, provider keys (e.g. `Z_AI_API_KEY`) and every other secret (T-S). Every secret lives in an **environment whose deployment-branch policy is `custom_branch_policies: true` with exactly one policy `{name: <default>, type: branch}`**. Never `protected_branches: true`: T-19 showed it admits `merge-queue` **and an unprotected branch** on a ruleset-only repo. The D13 drift check compares the exact policy objects.
2. **No credential that authenticates as a human** (PAT, OAuth or user-to-server token) may exist in any workflow, environment or runner job of the repository **once W1.10 completes**. During the interim, see D-G.4. The end of the interim is machine-checkable only through the D-H.3 **C3** attestation.

   **Outside Actions, this rule does not reach (critic r2 R2-1, major; OWNER DECISION, stated and not taken here).** Any non-Actions agent session holding the owner's GitHub credential can mint a D11 record: a fleet or delegation lane, a prompt-injected lane, a local `cq` run under `solo-maintainer` (`CQ_SANDBOX=off`, where `gh` reads the owner's keyring or `hosts.yml` regardless of env scrub), or any tool the owner runs. Such a session can apply `cq-override` after the head epoch, and that passes every D-G.4 check (`actor.id == owner.id`, `type == User`, `performed_via_github_app == null`; PAT-applied labels are indistinguishable from web-UI ones, Appendix C.4). It can also push `.github/workflows/**` edits, because the push-time `workflows` refusal binds only the automation App. The review session that found this held the owner's classic PAT. The owner picks one:
   - **(a) Accept it as an explicit G1 residual** next to D-J. The Consequences line then reads "only a holder of the owner's credential".
   - **(b) No owner credential in agent sessions.** Lanes, fleet agents and local toolkit runs authenticate as a non-owner identity (the automation App, or a dedicated lane App without `workflows`, `issues` or label rights); the owner's credential is used only interactively. Adds an A14 variant: a lane session applies `cq-override` → not authorized (actor isn't the owner). The critic calls this the cheapest, and it composes with D2.
   - **(c) A record form a bearer token can't produce**, e.g. an owner-signed authorization (an SSH- or hardware-key-signed tag or commit trailer naming the head SHA) verified against a key pinned on the trust ref. The critic calls this the strongest. The live-merge drill's repo-creating credential belongs to the **second test identity**, which must be **neither a collaborator on nor a member of the trust set of** the toolkit repo. Its token then cannot apply labels or produce trust-set reviews there **[RS-11]**.

3. **Three identities** (Appendix C has the RS-11 trials). None of them is in the reviewer trust set (D2/D3).

   | Identity                                                                  | Permissions                                                                                                      | Environment (default-branch-only) | Bypass                        | Jobs that may mint its token                                                                                                                                                                                                                                                                                                        |
   | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **verdict App**                                                           | `checks: write`, `statuses: write`, `contents: read`, `pull_requests: read`, `actions: read`                     | `cq-verdict`                      | none                          | the **sign** jobs of `cq-verify`, `cq-policy` and `cq-accept` (D-B compute/sign split). None of them runs model-directed code or head code. (r1 also listed "the gate's verdict read": dropped, R2-3. `decide` runs in env `promote`, a job has one `environment:`, and reading verdicts needs only the promoter's `checks: read`.) |
   | **promoter App**                                                          | `contents: write`, **`workflows: write`**, `checks: read`, `actions: read`                                       | `promote`                         | ruleset R1 on **`main` only** | the gate's `decide` job only                                                                                                                                                                                                                                                                                                        |
   | **automation App** (merger, sync, propose, worker pushes, review replies) | `contents: write`, `pull_requests: write`, `issues: write`; **no `workflows`**; **no `checks`/`statuses` write** | `automation`                      | none                          | automation jobs; worker jobs themselves still hold **no** token (P1)                                                                                                                                                                                                                                                                |

   Without `workflows` permission the automation App cannot push commits that create or modify `.github/workflows/**`. GitHub refuses them: "refusing to allow a GitHub App to create or update workflow … without `workflows` permission" (T-18, shown for the Actions App installation token; to be re-confirmed for a custom App by RS-11). That blocks the realistic A14 author, worker-produced commits, at push time.

4. `pull_request_target` jobs, if any, must reference no `environment:` (they run as the default branch, D-6), enforced by the D-G lint.
5. Worker and measurement jobs have `permissions: {}` and reference no `secrets.*`.

### D-E. Code source for the checks

- **cq-toolkit self-hosting.** Deciding jobs build and run the toolkit from a worktree of `origin/<default>` (`npm ci --ignore-scripts`, then build). The head's `dist/` and `node_modules` are never used.
- **Adopters.** An exact version pinned in a default-branch-owned tool manifest plus lockfile (`.cq/tool/`), installed with `npm ci --ignore-scripts`, then `npm audit signatures`. The release checklist records the expected attestation repo/workflow/commit, because the CLI doesn't assert them (D-10).

### D-F. Consuming verdicts (binds **every** consumer)

This binds every consumer: the gate, `self-merge-prs`/`classifyPr`, `self-review-loop`, and any toolkit op reading check state.

1. A verdict is valid only if **all** of these hold:
   - it is a **check run** whose `app.id` equals the verdict App's numeric id (never compared by login or slug string);
   - `head_sha` equals the subject;
   - `external_id` names the trust-ref SHA the consumer acts against (for the gate: the `main` SHA it promotes onto).
   - Among valid rows, the **newest by the verdict App** wins. Rows from any other app are ignored. So a `statuses: write`/`checks: write` workflow can neither satisfy a verdict nor displace one (Appendix A #10).
2. Results of head-defined jobs (`ci`'s `static`, `denylist`) are consumed **only through a verified run**, never by check-run name:
   - resolve `GET /actions/workflows/<file>/runs?head_sha=<sha>&event=push`;
   - check `path` and `event`;
   - then `GET /actions/runs/{id}/jobs` with `runner_id != null` and `steps > 0`.

   The job-shape tests are a belt (T-13), not the anchor. The anchor is that these results only _block_: the gate also requires the verdict App's `cq/policy`, `cq/ratchet` and `cq/acceptance`. A forged `ci` success can't satisfy those, and D11 covers edits to `ci.yml`/`denylist.yml`, which are in the definition set (D-C.4). `denylist` may alternatively be recomputed inside `cq-policy`, since it's a data-only scan; W1.10 chooses.

3. Verdicts are **check runs**, not commit statuses. Expected-source pinning for App check runs is documented. Pinning for App _statuses_ is not (Appendix A #10); RS-11 trials it, and the design doesn't depend on it.

### D-G. D11 approval path

1. **Protected paths:**
   - `.github/**`;
   - `policy/**`;
   - `baselines/**` (loosening);
   - the D-C.4 definition set, including **`**/.gitattributes`** and the tsconfig `extends`/`references` graph (R2-2);
   - `lint/**`;
   - check-code paths;
   - `.cq/tool/**`.
2. **Postures.**
   - **Blank (`human`):** any protected-path change needs the D11 record.
   - **Relaxed (`diff-check`):** the base-ref policy diff, computed by default-branch code in `cq-policy`, needs the record for any of these:
     - a loosened or removed baseline or target;
     - **adding or changing any privileged job**, meaning a job with any permission other than `read`/`none`, any `secrets.*` other than `GITHUB_TOKEN`, or any `environment:`;
     - a changed trigger (`on:`) of any workflow;
     - **any change to a definition-set file**, including required-check-producing workflows like `ci.yml`/`denylist.yml`, since neutering one isn't "removing" it;
     - a removed required check, protected-path entry or definition-set entry;
     - any **new workflow file**.
3. **Workflow lint (both postures, always failure, not needs-human):**
   - a `pull_request_target` workflow that references `environment:` or `secrets.*` other than `GITHUB_TOKEN`;
   - a `pull_request_target` or `workflow_run` workflow that checks out or executes head refs;
   - any `persist-credentials: true` in a job that runs repo code.
4. **The D11 record, and its validity window.**
   - **Forms:**
     - an `APPROVED` review bound to `head_sha` from a trust-set human **[RS-3]**;
     - or the `cq-override` label event.
   - **Label checks:**
     - `actor.id == repository.owner.id` and `actor.type == "User"`;
     - `performed_via_github_app == null`;
     - the event is later than the head observation epoch of the current head, using RS-3's durable observed-head tuple, not raw timestamps;
     - journalled and echoed in the gate's run report.
   - **Validity window.** The record forms are **valid only after D-D.2 holds**: no human-authenticating credential anywhere in the repo's Actions. The gate honours D11 records **only when the D-H.3 C3 attestation file is present on the trust ref** (critic r2 R2-8: secret values can't be inspected, so without it nothing machine-checkable ends the interim). Until then (the PAT interim, while `PROMOTE_TOKEN`/`GH_TOKEN` are owner PATs):
     - W1.9 does **not** ship override-by-label or approval as a trust anchor;
     - any protected-path change is **promoted only by the owner's break-glass** (D-H.4), outside Actions.
   - **Stated plainly:** during the interim, any job holding the owner PAT can forge both record forms, because GitHub records the action as the owner (Appendix A #4). Worker runs are in such jobs today (`self-merge-prs.yml@5e52707` runs the conflict agent in the step holding `GH_TOKEN`).
   - **A14 regression (added):** a job holding the automation App token applies `cq-override`, and the result is **not** authorized (`performed_via_github_app != null`, and the actor isn't the owner).
   - **Outside Actions (R2-1, owner decision pending):** even after the window opens, a non-Actions session holding the owner's credential produces a record these checks accept. The owner's choice among (a) accept as residual, (b) no owner credential in agent sessions, (c) a signed record form is stated at D-D.2; this section's checks change only under (c).
5. Both postures are computed by `cq-policy` per PR and **recomputed by the gate** over `main..tip`. The gate is authoritative.

### D-H. Bootstrap and cutover

1. **Steady state (a definition or check-code change).**
   1. The PR is judged by the **old** default-branch verifiers, flagged by the definition check, and needs the D11 record (D-G.4).
   2. With the record, `cq/policy` passes. `cq/ratchet` passes because it is judged under the head's (new) definitions once authorized (D-C.3).
   3. It merges into merge-queue. **A PR that touches `.github/workflows/**` is owner-merged** (the automation App has no `workflows` permission, and GitHub refuses any App-token ref update that introduces workflow-file changes; critic r2 R2-3). At the tip, `cq-verify` sees an authorized `main..tip` definition difference (D-C.3, push subject) and judges the new measurement.
   4. The gate's closure rule finds the record and promotes.
   5. The new definitions run from the next PR or promotion.

   **A14 regression row (added):** an authorized measurement-definition change promotes, and the **next unrelated PR is not needs-human**.

2. **Expand/contract for every interface** between a head-defined leg (`ci`, `cq-measure`, `cq-signal`) and a default-branch consumer. This covers workflow names and paths, job and check names, artifact schema, `cq-signal` event set and verdict names. Change it in two promotions: first the consumer accepts old and new, then the producer switches and the consumer drops the old.
3. **First cutover from `5e52707`.** The old gate is push-triggered and runs the pushed definition, so D-H.1 can't bootstrap it.
   1. **PR C1:** add the new two-job gate (`gate.yml`) _alongside_ `merge-queue-gate.yml`, plus the verifiers in **non-required** mode. The old gate promotes C1. Both use the atomic CAS, so concurrent promotion is race-safe (T-20). C1 also (R2-8, R2-6):
      - **re-wires every secret holder to its environment**: `environment: automation` (or `drill`) on `self-merge-prs`, `self-review-loop`, `sync-merge-queue`, `init-merge-queue` and `live-*`, so the owner-setup step's secret move breaks nothing (referencing a not-yet-existing environment is safe: GitHub creates it, and repo secrets stay visible until removed);
      - **re-measures the typecheck baselines** once under the recompute's counting environment (trust-ref toolchain, attribute-free extraction), since the move from head-executed `tsc` changes what is counted.
   2. **Owner setup (wizard, outside Actions):**
      - create the three Apps and the environments;
      - move all secrets into environments (the old gate now fails closed: `PROMOTE_TOKEN` is unreachable from `push: merge-queue`);
      - apply rulesets R0–R2 (D-I) and the Actions event policy;
      - remove the repo-level secrets.
   3. **PR C2:** remove `merge-queue-gate.yml` and make `cq/*` required. C2 touches workflows, so it is owner-merged into `merge-queue` (R2-3; by admin bypass during the D-G.4 interim) and promoted by break-glass (D-H.4).
   4. **C3 (ends the PAT interim; R2-8):** the owner revokes the PATs (`GH_TOKEN`, `PROMOTE_TOKEN`) and deletes any environment secret holding one, then commits an attestation file on the trust ref by break-glass. D-G.4 records become valid only once it is present. The D13 drift check asserts `GET /repos/…/actions/secrets` `total_count == 0` and that environment secret _names_ are within a committed allowlist.
4. **Break-glass:** the owner (admin role, ruleset bypass on R1 only) fast-forwards `main` locally with their own credential and records it in SELF-HOSTING.md. It's the only ungated path, and during the PAT interim the only path for protected-path changes.

### D-I. GitHub settings as code **[D13]**

`policy/templates/github-settings.json` captures only features that exist on a user-owned repo (T-14, T-15), and a drift check reads each one back. (Plan D13 names it `policy/templates/branch-protection.json`; the rename is an Appendix B delta, R2-10.)

- **Rulesets.** Bypass is per ruleset, so they're **split** (Appendix A #3):
  - **R0** (`main` + `merge-queue`): non-fast-forward + deletion. Bypass: **admin only**. Even the promoter can't rewrite history.
  - **R1** (`main`): restrict updates. Bypass: **promoter App**, admin (break-glass). **No required status checks on `main`**: the gate is the authority, and the promoted SHA's `cq/*` verdicts are already on it.
  - **R2** (`merge-queue`): required status checks `cq/policy`, `cq/ratchet` and `cq/acceptance`, each with expected source = verdict App, **plus "require a pull request"** (a cheap belt: a direct push of a commit already carrying verdicts would otherwise pass R2; the D-K.3 closure refuses it at the gate anyway; R2-10). **No App bypass**; admin bypass only for break-glass.
- **sync-merge-queue.** It goes **through a PR** (the automation App opens `sync/main→merge-queue`). Its merge commit is therefore judged like any PR and is admitted by the closure rule.
- **Environments** `cq-verdict`, `promote` and `automation`, each with the exact default-branch-only policy (D-D.1).
- **Repository Actions event policy** (`POST/GET /repos/{owner}/{repo}/actions/policies`, **proven available on a user-owned public repo**, T-15). An explicit `restrict_action_events` allow-list naming exactly the events the shipped workflows use:
  - `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `workflow_run`, `workflow_dispatch`, `schedule`;
  - plus `pull_request_target` only if an informational prt job is opted in.

  This removes any dependence on GitHub's 2026-11-02 default and narrows the event surface. The drift check compares the policy's rules.

- Actions settings: **"Allow GitHub Actions to create and approve pull requests" = off**, and the default `GITHUB_TOKEN` permission = read.
- **Tag ruleset** (W7): restrict creation of `v*` (bypass: admin), and the publish job in a default-branch-only environment (critic out-of-scope note).

### D-J. Measurement residual (owner-accepted at G1)

- The measurement leg executes arbitrary head code, so **a PR can make `cq-measure` report an arbitrary coverage value**, not merely "raise coverage with real tests". Two examples:
  - a detached process that rewrites the summary after vitest;
  - an in-process monkeypatch of the provider.
- **Mitigations:**
  - D11 on test-infra and definition paths;
  - the W1.8 tamper heuristics and the default-deny of worker test/config edits;
  - review;
  - the trusted typecheck recompute removes the _execution_ route to forging **typecheck-count** (D-B).
- **Typecheck residual, restated (critic r2 R2-2).** Typecheck-count is computed **without executing head code**, over an attribute-free extraction, with every configuration file that can steer it (`.gitattributes`, the tsconfig graph, the test configs) in the definition set. It is **not** "unforgeable": suppression pragmas and ambient declarations in head _source_ (`// @ts-nocheck`, `@ts-expect-error`, a `.d.ts` with `declare module '*'`) are content, not definition, and still lower the count. That residual is flagged by the RS-10/W1.8 idiom scan applied in `cq-policy` to **every** PR diff, and is part of what the owner accepts at G1.
- This supersedes the plan W1.7 wording (Appendix B). **This residual must be explicitly accepted by the owner at G1.** It is not a footnote.

### D-K. The gate (promotion) in detail

1. **Wake-up is untrusted and cheap.**
   - The `wake` job checks only that the carrier is allowed (D-A.1): for `workflow_run`, `path ∈ {ci.yml, cq-measure.yml}`, `event == push`, and `head_repository.id == repository_id`.
   - It carries no data forward.
   - `decide` `needs: wake` and is the only job in concurrency group `promote` (`cancel-in-progress: false`). Junk triggers (impostor `ci`, fork runs) fail `wake` and never enter the group, so they can't cancel a legitimate pending `decide` (Appendix A #6).
2. **`decide` resolves its own subject.**
   - `tip :=` the merge-queue ref from the API.
   - `base :=` the `main` ref.
   - It never uses the payload `head_sha`.
3. **Closure over `main..tip`.** Every commit must be one of:
   - (a) a merge commit into `merge-queue` of an accepted PR (acceptance recomputed with `classifyPr` per RS-3), or reachable from that PR's head;
   - (b) a sync merge from a sync PR, admitted under (a).

   Anything else refuses. This covers direct pushes, admin pushes and unknown merges. **Merge commits on `merge-queue`'s first-parent chain within `main..tip` must be clean:** their tree must equal a recomputed `git merge-tree` of their parents, so there are no evil merges into the queue (or via the sync merge), whose content no PR diff covers. **Scope (R2-7):** a conflict-_resolving_ merge reachable from a PR head (the toolkit's conflict path, `conflict.default.md:27-37`) is not clean by definition and is judged by that PR's own diff (`merge-base(head, base)..head`), so the clean test does not apply to it. `merge-tree` uses the strategy GitHub uses (ort) and a pinned git version; a version skew is a false refusal, which fails closed.

4. **Recompute:** `cq/policy` logic (guard, D11 diff plus records, lint) over `main..tip`, and I2 per accepted PR.
5. **Verdicts:**
   - App-created `cq/ratchet` on the tip, with `external_id` naming `base`, waited for with a 20-minute deadline (as today). **When the tip verdict is missing or bound to another base** (e.g. `main` moved by an earlier promotion or a break-glass fast-forward), `decide`, or the gate sweep, **dispatches `cq-verify` on the default ref with `(subject=tip, trust=main)`**, an allowed carrier (dispatch-on-default, D-A.1), instead of refusing until an unrelated merge (R2-5);
   - `ci`/`denylist` via verified runs (D-F.2).
6. **Promote:** `git push --atomic origin tip:main tip:merge-queue` with the promoter App token.
   - In the normal case only `main` is sent, because the up-to-date refspec is omitted (T-20).
   - A concurrent queue advance turns it into a rejected rewind.
   - The queue side needs **no bypass**.
   - The server-side CAS covers only `main`'s old value. A queue advance between ref advertisement and receive can leave `main` at a no-longer-tip ancestor of the queue, which is safe.
7. **Liveness:**
   - a `schedule` sweep (default-branch definition) runs `decide` when `merge-queue` is ahead of `main`;
   - a missed wake-up delays promotion by at most one sweep interval. **The gate sweep's interval is what bounds promotion latency**; its value is not yet specified (R2-10; open point O-7). The `cq-signal` sweep runs only in the automation window and does not bound promotion.
   - **Workflow-file refusals are needs-human, not retries (R2-3).** The merge executor and the conflict agent classify GitHub's "refusing to allow a GitHub App to create or update workflow … without `workflows` permission" as needs-human. This covers `self-merge-prs` merging a D11-authorized workflow-touching PR, the conflict agent's `git merge FETCH_HEAD` push on a branch older than a queued workflow change (`conflict.default.md:27`), and a sync PR merge after a break-glass workflow change on `main`. All three fail closed; W1.9/W1.10 executors must not loop on them.

## Named non-adoptions

- **Org "required workflows" / push file-path rulesets / the merge-queue rule / evaluate mode:** unavailable on a user-owned repo (T-14). Revisit if the repo moves to an org.
- **`pull_request` job that checks out the base:** head-controlled (T-1).
- **`pull_request_target` for required checks** (was r0's guard carrier): a forged Actions-app check is the only row when the real job is absent (T-16); the D-5 default and policy drift make it absent. Replaced by App-created `workflow_run` verdicts.
- **`GITHUB_TOKEN`-created verdicts, and commit statuses, as trust anchors:** forgeable, latest-wins (T-11/T-12/T-13/T-16).
- **Environment "protected branches only":** admits unprotected branches on a ruleset-only repo (T-19).
- **Environment required reviewers as the D11 gate:** unavailable on private Pro repos, and "prevent self-review" locks out a solo owner.
- **One automation App for everything** (r0): verdict forgery through the worker-reachable identity, and bypass that covers required checks (Appendix A #3).

## Consequences

**Positive**

- A14 is closed on every privileged **Actions** path. Before promotion, an edited privileged workflow never executes with a credential. Worker-produced workflow edits made with the automation App are refused at push. Promotion of an edit needs a D11 record that, once D2 holds and C3 is attested, **only a holder of the owner's GitHub credential** can create. Whether that means only the human owner depends on the R2-1 owner decision (D-D.2).
- A5 is closed.
- Verdict forgery is closed for every consumer, because App-created check runs are selected by app id and bound to the trust ref.
- Typecheck-count is computed without executing head code, over an attribute-free extraction, with its steering configuration in the definition set. Source-level suppression remains a flagged residual (D-J).
- The event surface is narrowed by an explicit Actions event policy.

**Negative / costs**

- Three GitHub Apps plus a non-collaborator second identity.
- `workflow_run` latency, plus a sweep for liveness.
- Every interface change takes two promotions (expand/contract).
- During the PAT interim, protected-path changes are owner break-glass only.
- The verifier installs the trust-ref toolchain per run, in a separate compute job (D-B).
- **Fork PRs never receive verdicts** (D-C.1 refuses fork runs, R2 requires App verdicts, I2 never trusts fork content), so external contributions merge only by admin bypass. This is a product decision on a public repo (R2-10).
- Workflow-touching PRs are owner-merged (D-H.1.3, R2-3).

**Accepted residual** (owner acceptance required at G1): a PR can report an arbitrary coverage value, and source-level suppression can lower typecheck-count (D-J). Otherwise, an inflated ratchet-propose measurement can only over-tighten a baseline, which is visible in review.

**Owner decision pending** (stated, not taken; D-D.2): R2-1, the D11 record outside Actions: (a) accept as residual, (b) no owner credential in agent sessions, or (c) a signed record form.

**Supersedes:**

- plan P1's "check source's app slug and path";
- W1.10's "gate filters check runs by app slug and workflow path";
- W1.7's residual wording;
- the RS-11 single-App assumption.

Appendix B has the replacement text.

## Revisit triggers

- The repo moves to an org: add required workflows and push rulesets as belts.
- GitHub changes the `workflow_run` definition-source semantics or the Actions event-policy API.
- GitHub documents workflow-file-scoped expected sources.
- npm adds CLI assertion of the expected provenance source.
- A second human collaborator joins (D3), which makes the review form of the D11 record usable without the override label.

---

## Appendix A: disposition of critic round 1 (ITERATE, 12 findings)

Legend: **Applied** = the fix is adopted as sketched (or strengthened). **Argued** = I disagree with part of the fix; the argument is given.

| #   | Sev   | Finding (short)                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                       | Evidence                                                                                                                                                                                                                                                                                                                                        |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | major | The `pull_request_target` leg reopens forged verdicts; the 2026-11-02 mitigation is untested; liveness after the D11 record (the critic's "pending real + forged success" sub-case, T-17, was **not run**: moot once no Actions-app check is required; T-16 covers the absent case) | **Applied (a)(b)(c)(d)**, with **one part argued**. The guard and policy diff move to App-created `workflow_run` verdicts (`cq/policy`). `cq-signal` gets the full activity-type list and a sweep. D-F binds every consumer. The event-policy API is proven live on the user repo (T-15) and adopted as an allow-list. **Argued:** the critic offers "keep prt as a non-required UX check" as an option. I don't ship it by default: it adds a secrets-bearing, default-branch-ref carrier that the lint must police, and it gives no signal `cq/policy` doesn't. It stays permitted as an opt-in, under the D-G.3 lint. | D-A.4, D-B, D-F, D-I        | **T-16**: with prt blocked by the repo event policy (`startup_failure`, no check run), a forged `prt-guard` success was the only row → PR #4 `mergeStateStatus: UNSTABLE` (required checks satisfied). **T-15**: `POST /repos/…/actions/policies` accepted on a user-owned public repo, read back by `GET`, enforced (prt → `startup_failure`). |
| 2   | major | Bootstrap deadlock at the tip; unbounded sibling cost                                                                                                                                                                                                                               | **Applied (a)(b)(c).** Push subjects: an authorized `main..tip` definition difference, where the verifier judges under the new definition. PR subjects: diff against `merge-base(head, base)` with the lists read from main. A14 regression row added.                                                                                                                                                                                                                                                                                                                                                                   | D-C.3, D-H.1                | design (no trial; the logic is a verifier rule)                                                                                                                                                                                                                                                                                                 |
| 3   | major | The single-App identity/ruleset system conflicts                                                                                                                                                                                                                                    | **Applied, strengthened.** Three identities as sketched. Rulesets split R1/R2 as sketched, **plus** R0 (non-ff + deletion on both branches, admin-only bypass), so the promoter bypassing R1 can't force-push `main` (bypass is per ruleset, so the critic's R1 = restrict-updates + non-ff would have let the promoter rewrite main). Bypass for the atomic push is `main` only (confirmed, T-20). Sync goes through a PR. Verdict App excluded from the trust set.                                                                                                                                                     | D-D.3, D-I, D-K.6           | **T-18**: an App installation token without `workflows` permission is refused on a push touching `.github/workflows/ci.yml`. **T-20**: the up-to-date refspec is not sent; the race is rejected.                                                                                                                                                |
| 4   | major | D11 record forgeable while an owner PAT exists                                                                                                                                                                                                                                      | **Applied**, plus one extension. The P8 rule "no human-authenticating credential" is added. Record forms are valid only after it holds. The interim is owner break-glass only. Exact record checks and the A14 variant row are specified. **Extension, not a disagreement:** the live-merge drill genuinely needs to _create repositories_ (an App installation token can't create user-account repos; RS-11 to confirm). So its credential moves to the non-collaborator second identity, which can't produce trust-set records on the toolkit repo.                                                                    | D-D.2, D-G.4, D-H.3/4       | `self-merge-prs.yml@5e52707` / `live-merge.yml@5e52707` (critic-verified)                                                                                                                                                                                                                                                                       |
| 5   | major | Measurement residual understated; lockfile missing                                                                                                                                                                                                                                  | **Applied (a)(b)(c).** Lockfiles, `.npmrc`, Node version files, `package.json` and the tool manifest are in the definition set. Typecheck-count is recomputed by the verifier with the trust-ref toolchain over the head tree as data. The coverage residual is restated and flagged for owner acceptance at G1.                                                                                                                                                                                                                                                                                                         | D-B, D-C.4, D-J             | **T-21**: the `tsc` CLI does not execute `compilerOptions.plugins` (marker plugin not loaded; diagnostics produced).                                                                                                                                                                                                                            |
| 6   | minor | Trigger shadowing via concurrency; no wait or sweep                                                                                                                                                                                                                                 | **Applied.** `wake`/`decide` split, with only `decide` in the group. `decide` resolves the tip itself. The 20-minute verdict wait and a schedule sweep are added.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | D-K.1/2/5/7                 | design; `concurrency` pending-replacement semantics per GitHub docs (critic)                                                                                                                                                                                                                                                                    |
| 7   | minor | First cutover not bootstrappable; generalise two-step                                                                                                                                                                                                                               | **Applied.** Cutover sequence C1 → owner setup → C2, plus expand/contract for every interface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | D-H.2/3                     | T-20 (two gates both CAS: race-safe)                                                                                                                                                                                                                                                                                                            |
| 8   | minor | `diff-check` misses privilege additions and neutered checks                                                                                                                                                                                                                         | **Applied.** "Privileged job" is defined; new workflow files and any definition-set change are flagged; the "Allow GitHub Actions to create and approve PRs" setting is off and drift-checked.                                                                                                                                                                                                                                                                                                                                                                                                                           | D-G.2, D-C.4, D-I           | —                                                                                                                                                                                                                                                                                                                                               |
| 9   | minor | Env policy form not pinned; not only write credentials                                                                                                                                                                                                                              | **Applied, with stronger evidence than the finding claimed.** The exact custom policy `{name: main, type: branch}` is pinned; no repo-level secrets at all; lint added.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | D-D.1, D-G.3                | **T-19**: env `protected_branches: true` admitted `refs/heads/merge-queue` (ruleset-protected) **and `refs/heads/unprot` (`protected=false`)**, canary_len=32 both.                                                                                                                                                                             |
| 10  | minor | Verdict carrier underspecified                                                                                                                                                                                                                                                      | **Applied.** App-created **check runs** selected by numeric `app.id`, newest-by-App wins, `external_id` binds the trust-ref SHA. App-_status_ pinning is not relied on (RS-11 trial listed).                                                                                                                                                                                                                                                                                                                                                                                                                             | D-B, D-F.1/3                | T-11/T-12 (status latest-wins)                                                                                                                                                                                                                                                                                                                  |
| 11  | minor | No closure rule over `main..tip`; `denylist`                                                                                                                                                                                                                                        | **Applied, strengthened.** Closure rule added, with the stricter clean-merge requirement (tree equals recomputed `merge-tree`) so a merge commit can't smuggle content. `ci`/`denylist` consumed via verified runs, and they only ever block.                                                                                                                                                                                                                                                                                                                                                                            | D-K.3, D-F.2                | —                                                                                                                                                                                                                                                                                                                                               |
| 12  | minor | Inventory and plan wording                                                                                                                                                                                                                                                          | **Applied.** `sync-merge-queue` dispatch ref → default, and sync via PR. `sync-merge-queue`/`init-merge-queue` added to the secret-holder inventory. P1 and W1.10 wording in Appendix B.                                                                                                                                                                                                                                                                                                                                                                                                                                 | D-A.2, D-I, provenance §5.2 | `sync-merge-queue.yml@5e52707` (critic-verified)                                                                                                                                                                                                                                                                                                |
| —   | note  | Tag ruleset for W7; `cache: ''` on privileged jobs                                                                                                                                                                                                                                  | **Applied** as D-I bullet and D-C.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | D-I, D-C.7                  | —                                                                                                                                                                                                                                                                                                                                               |

**Totals:** all 12 findings applied (majors 1–5, minors 6–12). **2 argued in part:** #1, not shipping the optional prt UX check; #3, R0 added because the critic's R1 composition would let the promoter force-push. #4's drill handling is an extension, not a disagreement.

## Appendix B: plan-wording deltas for G1 (overseer to carry)

**Findings → plan locations:**

- **W1.10:** #1 (verdict carrier), #3 (identities, rulesets), #6 (wake/decide, sweep), #7 (cutover), #9 (environment policy form, no repo secrets), #10 (App check runs), #11 (closure rule, `denylist`), #12 (sync dispatch ref, inventory).
- **P1:** #1, #10, #12.
- **W1.7:** #5.
- **W1.9:** #4, #8.
- **§7 A14 rows:** #1, #2, #3, #4.
- **§10 bootstrap risk:** #2, #7.
- **RS-11 row / D2:** #3, #4, #10 (Appendix C).

| Plan location                                                               | Current wording                                                                                                                 | Replace with                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2 P1, bullet 3                                                             | "verify the triggering run's event, ref, head SHA **and** workflow definition, as well as the check source's app slug and path" | "…verify the triggering run's event, workflow path, repository id and head SHA, **and that every definition-set file is unchanged or D11-authorized** (ADR-0004 D-C). Consume verdicts only as check runs created by the verdict App (numeric app id) bound to the trust-ref SHA; head-defined job results only block (D-F)."                       |
| §2 P1, add                                                                  | —                                                                                                                               | "No repository-level secrets. Environments are default-branch-only by an explicit branch policy. No human-authenticating credential in Actions once W1.10 lands (ADR-0004 D-D)."                                                                                                                                                                    |
| §4 RS-4 options                                                             | (i)–(iv) incl. `pull_request_target`                                                                                            | Record: (iii) is not used for required checks (T-16). The Actions event policy is a D13 item (T-15).                                                                                                                                                                                                                                                |
| §6 W1.7                                                                     | "the head can still raise coverage with real tests, which is acceptable"                                                        | "the head can make the measurement report an **arbitrary** coverage value (it executes head code); owner-accepted residual at G1 (ADR-0004 D-J). Typecheck-count is recomputed by the verifier with the trust-ref toolchain. Definition set includes lockfiles/`.npmrc`/Node version/`package.json`."                                               |
| §6 W1.9                                                                     | "override label logged in the run report"                                                                                       | "override label valid only per ADR-0004 D-G.4 (owner id, not via App, after the head epoch) and **only after D-D.2 holds**; until then, protected-path changes promote by owner break-glass only."                                                                                                                                                  |
| §6 W1.10 bullet "gate filters check runs by app slug **and** workflow path" | as quoted                                                                                                                       | "gate: `wake`/`decide` split; closure rule over `main..tip`; recompute of `cq/policy` + I2; `cq/ratchet` as a verdict-App check run bound to the `main` SHA; `ci`/`denylist` via verified runs (block-only); atomic CAS with promoter bypass on `main` only (ADR-0004 D-K)"                                                                         |
| §6 W1.10 bullet "promotion job per P1…"                                     | "default-branch definition, verification of the triggering run's event/ref/SHA/workflow, no PR artifacts"                       | add "; cutover per ADR-0004 D-H.3 (C1 alongside the old gate → owner setup → C2)"                                                                                                                                                                                                                                                                   |
| §6 W1.10 bullet "`enforce_admins` per the RS-11 branch matrix"              | as quoted                                                                                                                       | "rulesets R0/R1/R2 per ADR-0004 D-I (bypass is per ruleset; no App bypass on required checks); sync-merge-queue via PR with dispatch ref = default"                                                                                                                                                                                                 |
| §6 W1.10 bullet "PROMOTE_TOKEN re-scoped or replaced"                       | as quoted                                                                                                                       | "replaced by the promoter App (`contents`+`workflows` write) in env `promote`; verdict and automation Apps per ADR-0004 D-D.3"                                                                                                                                                                                                                      |
| §6 W1.10 bullet "branch protection as code plus a drift check (D13)"        | as quoted                                                                                                                       | add "including environments' exact branch policies, the repo Actions event policy (allow-list), and 'Allow Actions to create/approve PRs' = off"                                                                                                                                                                                                    |
| §6 W1.10 bullet "#170 secret moved into a protected environment"            | as quoted                                                                                                                       | "**all** secrets (incl. provider keys) moved to default-branch-only environments; none at repo level"                                                                                                                                                                                                                                               |
| §7 A14                                                                      | —                                                                                                                               | add variants: (a) an authorized measurement-definition change promotes and the next unrelated PR is not needs-human; (b) an automation-App-applied `cq-override` is not authorized; (c) a forged `cq/*` from `GITHUB_TOKEN` alongside an absent real verdict does not merge; (d) a worker commit touching `.github/workflows/**` is refused at push |
| §10 bootstrap risk                                                          | "check-code changes land through the D11 override, then take effect on the next PR"                                             | add "; interface changes need expand/contract across two promotions; first cutover per D-H.3"                                                                                                                                                                                                                                                       |
| §6 W1.9 (G1 reconciliation, R2-8)                                           | —                                                                                                                               | add "the override label is **dormant until after W1.10**: D11 records are honoured only once the D-H.3 C3 attestation is on the trust ref"                                                                                                                                                                                                          |
| §3 D13 (G1 reconciliation, R2-10)                                           | `policy/templates/branch-protection.json`                                                                                       | `policy/templates/github-settings.json` (it now holds rulesets, environments, the event policy and Actions settings)                                                                                                                                                                                                                                |
| §6 W1.7 (G1 reconciliation, R2-2/R2-4/R2-6)                                 | —                                                                                                                               | add "typecheck recompute: attribute-free head extraction (`ls-tree`/`cat-file`); `**/.gitattributes`, the tsconfig graph and globbed test configs in the definition set; compute/sign job split; PR-subject lockfile rule per ADR-0004 D-C.3; baseline re-measure at C1"                                                                            |

## Appendix C: RS-11 inputs (supersede the r0 single-App list)

1. **Three-identity split** (D-D.3) supersedes the r0 "one automation App" assumption. RS-11 trials, per identity, on a `cq-scratch-v11-*` user repo:
   - (a) a custom App **installed on a user-owned repo** is accepted as a ruleset bypass actor (T-14 showed only that the _GitHub Actions_ app is refused);
   - (b) the verdict App's check runs can be pinned as the expected source in a ruleset on a user repo, and a `GITHUB_TOKEN` check run of the same name then does **not** satisfy it;
   - (c) App-created **commit statuses** can be pinned (not relied on; record only);
   - (d) a custom App **without `workflows` permission** is refused when pushing `.github/workflows/**` changes. Shown here only for the Actions installation token (T-18), which is the same enforcement path, so confidence is high but it isn't yet shown for a custom App;
   - (e) the minimal permission sets in D-D.3 suffice for each identity's jobs;
   - (f) (G1 reconciliation, R2-3) the refusal T-18 showed for a push also applies to (i) an API merge by the automation App of a PR touching `.github/workflows/**`, (ii) the conflict agent's merge-commit push carrying a base workflow delta, and (iii) a sync-PR merge after a break-glass workflow change.
2. **App repository creation:** confirm that an App installation token can't create repositories in a user account. If it can't, the live-merge drill uses the second identity per D-D.2.
3. **Second test identity:** not a collaborator on cq-toolkit (so its reviews are association `NONE` and it can't label). It owns the drill scratch repos, and its PAT lives only in env `drill` (default-branch-only).
4. **D11 record check fields:** confirm that the timeline `labeled` event exposes `actor.id`, `actor.type` and `performed_via_github_app` for App versus PAT versus web-UI actors, and that PAT-applied labels are indistinguishable from web-UI ones. That indistinguishability is the premise of the D-G.4 validity window.
5. **Environments:** `cq-verdict`, `promote`, `automation` (and `drill`), each `custom_branch_policies` with the single `{name: main, type: branch}` policy (T-19 forbids `protected_branches`).
6. **Promoter bypass** is on R1 (`main`) only. R0 (non-ff/deletion) has admin-only bypass. No App bypasses R2.
