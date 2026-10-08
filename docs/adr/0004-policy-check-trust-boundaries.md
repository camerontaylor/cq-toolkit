# ADR-0004 — Policy-check trust boundaries (execution provenance)

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-24
- **Related:** [ADR-0002 Annex B](0002-annex-b-config.md) (secret keys and their environments)

Post-acceptance notes N7, N8 and N9 in the [ADR index](README.md#post-acceptance-notes) narrow parts of this record.

## Context

An evaluation on 2026-09-24 found that the toolkit's policy checks execute the definitions and code of the party they judge:

- `ratchet.yml` runs on `pull_request`, so the head's workflow file defines the metric.
- `merge-queue-gate.yml` runs on `push` to `merge-queue` holding the promote PAT, so a merged PR controls the next promotion. A live trial reproduced this: the attacker's gate ran with the real repository-level secret.
- **Any repository-level secret is readable by a workflow that a same-repo PR adds.**

cq-toolkit is a **user-owned public** repository. None of GitHub's native backstops are available to it: required workflows, push/file-path rulesets, the merge-queue rule, evaluate mode, classic push restrictions.

Two further platform gaps:

- A required check's "expected source" pins an _app_, not a workflow file, so any workflow can forge a GitHub-Actions-app status or check run. Statuses are latest-wins; forged check runs attach to real runs' suites and job lists; and when the real job never reports, the forged check is the **only** row and satisfies the requirement.
- An environment's **"protected branches only" policy admits unprotected branches** once rulesets are the only protection.

## Decision

### D-A. Carriers: where a deciding job's definition may come from

1. **Allowed carriers** for anything a policy decision depends on. All of them execute the **default-branch** workflow file:
   - `workflow_run`;
   - `schedule`;
   - `workflow_dispatch` honoured only when `github.ref == refs/heads/<default>`;
   - `push` to the default branch.

   `pull_request_target` also qualifies, but **this design uses it for no deciding or required check** (D-B).

2. **Rejected carriers for privileged or deciding jobs:** `pull_request` (including a job that "checks out base"); `push` to any non-default branch; `workflow_dispatch` on a non-default ref, including any _dispatch_ issued with a non-default `ref`. `sync-merge-queue.yml` therefore dispatches the gate with `ref=<default>`, not `ref=merge-queue`.
3. **A pinned published toolkit is a code source, not a carrier** (D-E).
4. **Head-defined legs are wake-ups and untrusted producers only.** `ci`, `cq-measure` and `cq-signal` run the head's definition. Their _absence_ must produce a blocked PR, never a pass. Required verdicts are therefore App-created (D-F), so a forgery can't paper over an absence.

### D-B. Mechanism per check

All deciding verifiers run under `workflow_run` from the default-branch definition. They post **check runs created by the verdict App** (D-D.3, D-F) on the subject SHA. Each check run encodes the trust-ref SHA it was computed against in `external_id` (`<trust-ref-sha>:<subject-sha>`).

**Compute and sign are separate jobs.** Every verifier that installs packages or runs a tool over head content (the typecheck recompute; any authorized tip-lockfile install) splits into a **compute** job (`permissions: {}`, no `environment:`, emits only numbers as a strict-schema artifact) and a **sign/push** job (the environment, consumes the numbers, holds the key). Environment secrets are loaded at job start and any process in the job can read them from runner memory, and a head `tsconfig` (`files`, `include`, `typeRoots`) can point `tsc` at arbitrary runner paths. So no credential-bearing job ever runs a head-selected install or a tool over head content. This is what makes D-D.3's "none of them runs head code" true.

| Check                                                          | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Native enforcement (merge-queue ruleset R2)                        | Gate                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Ratchet: coverage (head-executed)**                          | `cq-measure` (`pull_request` + `push: merge-queue`; `permissions: {}`; no `secrets.*`, no `environment`) runs head tests and uploads a coverage artifact. `cq-verify` (`workflow_run: [cq-measure]`, env `cq-verdict`) judges it against trust-ref baselines.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `cq/ratchet`, App-created check run, expected source = verdict App | the same check run, selected by verdict-App `app.id` and bound to the promoted `main` SHA   |
| **Ratchet: typecheck-count (trusted recompute)**               | **Computed in `cq-verify`'s compute job** with the **trust-ref toolchain**. `node_modules` is installed with `npm ci --ignore-scripts` from the lockfile chosen per D-C.3, and the trust-ref `tsc` runs over the head tree. The head tree is extracted as data **without attributes**: `git ls-tree -r -z <sha>` plus `git cat-file blob` per entry into a scratch dir with no `node_modules` of its own. Never `git archive`, which honours head-controlled `.gitattributes` (`export-ignore` silently drops files, `export-subst` rewrites content). The tsc CLI does not load `compilerOptions.plugins`, and tsc executes no project code. A timeout means failure. Diagnostics are not logged beyond counts. | part of `cq/ratchet`                                               | **consumed** from `cq/ratchet` (D-F.1); `decide` does not recompute typecheck itself        |
| **Monotonic guard + D11 base-ref policy diff + workflow lint** | `cq-policy` (`workflow_run: [cq-signal]`, env `cq-verdict`). Data only: the head is fetched as git objects, diffed with `--text --no-ext-diff --no-textconv --no-renames`, and parsed, never executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `cq/policy`, App-created                                           | **recomputed** over `main..tip`                                                             |
| **I2 acceptance**                                              | `cq-accept` (`workflow_run: [cq-signal]`, env `cq-verdict`) runs `classifyPr` over API reads only, against the reviewer trust set (D3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `cq/acceptance`, App-created                                       | **recomputed** per accepted PR in `main..tip`                                               |
| **Merge-queue gate (promotion)**                               | Two jobs (D-K). `wake` (any allowed carrier: `workflow_run: [ci, cq-measure]` on `merge-queue`, `schedule` sweep, dispatch-on-default) → `decide` (`needs: wake`, **sole member** of concurrency group `promote`, `environment: promote`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                  | resolves the tip itself, verifies the range and verdicts, then does the atomic fast-forward |
| **ratchet-propose**                                            | `ratchet-propose-measure` (`push: main`, `permissions: {}`) produces an artifact. `ratchet-propose` (`workflow_run`, env `automation`) opens the proposal PR **against `merge-queue`**, branched from the merge-queue tip, authored by the automation App (excluded from the trust set, D2).                                                                                                                                                                                                                                                                                                                                                                                                                     | normal PR checks                                                   | normal gate                                                                                 |

`cq-signal` (`pull_request` with `types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review, edited]`, plus `pull_request_review` and `pull_request_review_comment`; `permissions: {}`; empty body) is a **wake-up only**. Verifiers re-read everything from the API by `head_sha`, and a `schedule` sweep (default-branch definition, every 15 minutes in the automation window) re-evaluates open merge-queue PRs whose App verdicts are missing or stale. Label and review events therefore re-evaluate D11 records and acceptance.

`pull_request_target` is **not used for any required check.** A non-required, informational `pull_request_target` job is permitted but not shipped by default: it would add a secrets-bearing, default-branch-ref carrier that the lint must police, and it gives no signal `cq/policy` doesn't. If one is used, it must reference no `environment:` and no `secrets.*` other than `GITHUB_TOKEN` (enforced by the D-G.3 lint), and the repository Actions event policy must allow it (D-I).

### D-C. Verification every `workflow_run` verifier performs

1. `github.event.workflow_run.path` equals the expected workflow file. `event` is in the expected set. `head_repository.id == github.repository_id` (fork runs are refused).
2. **The subject is `head_sha`**, never `head_branch`. The PR is resolved with `GET /commits/{sha}/pulls` plus a base-branch check, never from `pull_requests[]`.

   > Narrowed: see post-acceptance note N7 in the [ADR index](README.md#post-acceptance-notes).

3. **Definition check.** The _definition set_ (D-C.4) is read as a **list** from the trust ref (`origin/<default>`). Whether the subject _changed_ a definition depends on the subject's kind:
   - **PR subject:** diff `merge-base(head, base)..head`, where `base` is the PR's base branch (normally `merge-queue`). Sibling PRs are therefore not flagged for already-queued, D11-authorized changes; the gate's closure rule (D-K.3) independently refuses any unauthorized content in `merge-queue`.
     - If the PR changes a definition **and** carries a valid D11 record (D-G.4), the verifier judges the artifact produced under the head's new definition. The lists (targets, the definition set itself) still come from the trust ref.
     - With no record, the result is failure with "needs-human (D11)".
     - **Typecheck toolchain.** The recompute installs from the lockfile at `merge-base(head, base)` when `main..merge-base` is authorized under the push-subject rule below, and from the **head's** lockfile when the PR carries a valid D11 record for its own lockfile change. Otherwise it uses the trust-ref lockfile. Every install uses `--ignore-scripts` inside the compute job. Without this rule a sibling PR would fail typecheck (TS2307) against a queued but unpromoted dependency change.
   - **Push subject (the merge-queue tip):** diff `main..tip`. A definition difference is _authorized_ iff every commit in `main..tip` that introduces it belongs to an accepted PR carrying a valid D11 record (D-H). When authorized, the verifier judges the artifact produced under the **new** definition. Where the lockfile changed with authorization, the typecheck recompute installs from the **tip's** lockfile with `--ignore-scripts`.
   - An unauthorized change → `cq/*` = failure with the reason "needs-human (D11)".
4. **The definition set** (read from the trust ref; its own path is in the set):
   - every workflow file that is a `workflow_run` source or produces a required check or verdict input: `ci.yml`, `denylist.yml`, `cq-measure.yml`, `cq-signal.yml`, and every privileged workflow;
   - measurement configs: **`vitest.config.*`, `vite.config.*`, `vitest.workspace.*`** (globbed, so a new higher-precedence config name can't escape the set), coverage config, `tsconfig*.json` **and every file reachable from their `extends`/`references` graph** (e.g. a `config/base.json` target), `package.json` (whole file, not just scripts);
   - **`**/.gitattributes`** (`export-ignore`/`export-subst` steer any attribute-honouring extraction, and attributes also change diff and merge behaviour);
   - **lockfiles** (`package-lock.json`, `npm-shrinkwrap.json`), `.npmrc`, `.nvmrc`/`.node-version`, `engines`; (pnpm equivalents: post-acceptance note N9);
   - the tool manifest (`.cq/tool/**`);
   - [`baselines/ratchets.json`](../../baselines/ratchets.json), the protected-path list and the required-check list.

   `referenced_workflows` must be empty or match pins held on the trust ref.

5. **Artifacts are data.** Download into a temp dir, cap the size, validate against a strict schema (numbers and enums only), and never execute, source or install them. Head files are read with `git show` or `git ls-tree`/`git cat-file` (attribute-free), never `git archive` (D-B). The head is never checked out into a workspace where anything runs, and the trust-ref toolchain lives outside the extracted head tree.
6. Targets, baselines, protected-path lists, the definition set and the required-check list are read from the trust ref (closes attack A5).
7. Deciding jobs set `cache: ''` on `setup-node` and use no `actions/cache` restore (a belt against cache poisoning).

### D-D. Credentials and identities (correctness rules under P8, no config key)

1. **No repository-level secrets at all**: no write credentials, no provider keys (e.g. `Z_AI_API_KEY`), nothing. Every secret lives in an **environment whose deployment-branch policy is `custom_branch_policies: true` with exactly one policy `{name: <default>, type: branch}`**. Never `protected_branches: true`: a trial showed it admits `merge-queue` **and an unprotected branch** on a ruleset-only repo. The D13 drift check compares the exact policy objects.
2. **No credential that authenticates as a human** (PAT, OAuth or user-to-server token) may exist in any workflow, environment or runner job of the repository **once W1.10 completes**. For the interim, see D-G.4. The end of the interim is machine-checkable only through the D-H.3 **C3** attestation.

   > Open: see post-acceptance note N8 in the [ADR index](README.md#post-acceptance-notes).

   **Open owner decision: this rule does not reach outside Actions.** Any non-Actions agent session holding the owner's GitHub credential can mint a D11 record: a fleet or delegation lane, a prompt-injected lane, a local `cq` run under `solo-maintainer` (`CQ_SANDBOX=off`, where `gh` reads the owner's keyring or `hosts.yml` regardless of env scrub), or any tool the owner runs. Such a session can apply `cq-override` after the head epoch, and that passes every D-G.4 check (`actor.id == owner.id`, `type == User`, `performed_via_github_app == null`; PAT-applied labels are indistinguishable from web-UI ones, Appendix C item 4). It can also push `.github/workflows/**` edits, because the push-time `workflows` refusal binds only the automation App. The review session that found this held the owner's classic PAT. The owner picks one:
   - **(a)** accept it as an explicit residual alongside D-J; the Consequences line then reads "only a holder of the owner's credential";
   - **(b) no owner credential in agent sessions.** Lanes, fleet agents and local toolkit runs authenticate as a non-owner identity (the automation App, or a dedicated lane App without `workflows`, `issues` or label rights); the owner's credential is used only interactively. This adds an A14 variant: a lane session applies `cq-override` → not authorized (the actor isn't the owner). It is the cheapest option and composes with D2;
   - **(c) a record form a bearer token can't produce**, e.g. an owner-signed authorization (an SSH- or hardware-key-signed tag or commit trailer naming the head SHA) verified against a key pinned on the trust ref. It is the strongest option.

3. **Three App identities.** None of them is in the reviewer trust set (D2/D3).

   | Identity                                                                  | Permissions                                                                                                      | Environment (default-branch-only) | Bypass                        | Jobs that may mint its token                                                                                                                                                                                                                 |
   | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **verdict App**                                                           | `checks: write`, `statuses: write`, `contents: read`, `pull_requests: read`, `actions: read`                     | `cq-verdict`                      | none                          | the **sign** jobs of `cq-verify`, `cq-policy` and `cq-accept` (D-B compute/sign split). None of them runs model-directed code or head code. The gate's `decide` runs in env `promote` and reads verdicts with the promoter's `checks: read`. |
   | **promoter App**                                                          | `contents: write`, **`workflows: write`**, `checks: read`, `actions: read`                                       | `promote`                         | ruleset R1 on **`main` only** | the gate's `decide` job only                                                                                                                                                                                                                 |
   | **automation App** (merger, sync, propose, worker pushes, review replies) | `contents: write`, `pull_requests: write`, `issues: write`; **no `workflows`**; **no `checks`/`statuses` write** | `automation`                      | none                          | automation jobs; worker jobs themselves still hold **no** token (P1)                                                                                                                                                                         |

   Without `workflows` permission the automation App cannot push commits that create or modify `.github/workflows/**`. GitHub refuses them: "refusing to allow a GitHub App to create or update workflow … without `workflows` permission" (shown for the Actions App installation token; to be confirmed for a custom App, Appendix C item 1). That blocks the realistic A14 author, worker-produced commits, at push time.

   **The live-merge drill's credential.** The drill must _create repositories_, which an App installation token can't do in a user account (to be confirmed, Appendix C item 2). Its credential therefore belongs to a **second test identity** that is **neither a collaborator on nor a member of the trust set of** the toolkit repository. Its reviews there have association `NONE` and it can't apply labels, so its token can't produce trust-set reviews or D11 records. It owns the drill scratch repositories, and its PAT lives only in the default-branch-only environment `drill`.

4. `pull_request_target` jobs, if any, must reference no `environment:` (they run in the default branch's context), enforced by the D-G.3 lint.
5. Worker and measurement jobs have `permissions: {}` and reference no `secrets.*`.

### D-E. Code source for the checks

- **cq-toolkit self-hosting.** Deciding jobs build and run the toolkit from a worktree of `origin/<default>` (`npm ci --ignore-scripts`, then build). The head's `dist/` and `node_modules` are never used.
- **Adopters.** An exact version pinned in a default-branch-owned tool manifest plus lockfile (`.cq/tool/`), installed with `npm ci --ignore-scripts`, then `npm audit signatures`. The release checklist records the expected attestation repo/workflow/commit, because the npm CLI doesn't assert them.

### D-F. Consuming verdicts (binds **every** consumer)

This binds every consumer: the gate, `self-merge-prs`/`classifyPr`, `self-review-loop`, and any toolkit op reading check state.

1. A verdict is valid only if **all** of these hold:
   - it is a **check run** whose `app.id` equals the verdict App's numeric id (never compared by login or slug string);
   - `head_sha` equals the subject;
   - `external_id` names the trust-ref SHA the consumer acts against (for the gate: the `main` SHA it promotes onto).

   Among valid rows, the **newest by the verdict App** wins. Rows from any other app are ignored, so a workflow with `statuses: write`/`checks: write` can neither satisfy a verdict nor displace one.

2. Results of head-defined jobs (`ci`'s `static`, `denylist`) are consumed **only through a verified run**, never by check-run name:
   - resolve `GET /actions/workflows/<file>/runs?head_sha=<sha>&event=push`;
   - check `path` and `event`;
   - then `GET /actions/runs/{id}/jobs` with `runner_id != null` and `steps > 0`.

   The job-shape tests are a belt, not the anchor. The anchor is that these results only _block_: the gate also requires the verdict App's `cq/policy`, `cq/ratchet` and `cq/acceptance`. A forged `ci` success can't satisfy those, and D11 covers edits to `ci.yml`/`denylist.yml`, which are in the definition set (D-C.4). `denylist` may instead be recomputed inside `cq-policy`, since it's a data-only scan; W1.10 chooses.

   > Narrowed: see post-acceptance note N7 in the [ADR index](README.md#post-acceptance-notes).

3. Verdicts are **check runs**, not commit statuses. Expected-source pinning for App check runs is documented; pinning for App _statuses_ is not, and the design doesn't depend on it.

### D-G. D11 approval path

1. **Protected paths:** `.github/**`; `policy/**`; `baselines/**` (loosening); the D-C.4 definition set, including **`**/.gitattributes`** and the tsconfig `extends`/`references` graph; `lint/**`; check-code paths; `.cq/tool/**`.
2. **Postures.**
   - **Blank (`human`):** any protected-path change needs the D11 record.
   - **Relaxed (`diff-check`):** the base-ref policy diff, computed by default-branch code in `cq-policy`, needs the record for any of these:
     - a loosened or removed baseline or target;
     - **adding or changing any privileged job**, meaning a job with any permission other than `read`/`none`, any `secrets.*` other than `GITHUB_TOKEN`, or any `environment:`;
     - a changed trigger (`on:`) of any workflow;
     - **any change to a definition-set file**, including required-check-producing workflows like `ci.yml`/`denylist.yml`, since neutering one isn't "removing" it;
     - a removed required check, protected-path entry or definition-set entry;
     - any **new workflow file**.
3. **Workflow lint (both postures; always failure, never needs-human):**
   - a `pull_request_target` workflow that references `environment:` or `secrets.*` other than `GITHUB_TOKEN`;
   - a `pull_request_target` or `workflow_run` workflow that checks out or executes head refs;
   - any `persist-credentials: true` in a job that runs repo code.
4. **The D11 record, and its validity window.**
   - **Forms:** an `APPROVED` review bound to `head_sha` from a trust-set human (D3), or the `cq-override` label event.
   - **Label checks:**
     - `actor.id == repository.owner.id` and `actor.type == "User"`;
     - `performed_via_github_app == null`;
     - the event is later than the head observation epoch of the current head, using the reviewer-trust design's durable observed-head tuple, not raw timestamps;
     - journalled and echoed in the gate's run report.
   - **Validity window.** The record forms are **valid only after D-D.2 holds**: no human-authenticating credential anywhere in the repository's Actions. Secret values can't be inspected, so the gate honours D11 records **only when the D-H.3 C3 attestation file is present on the trust ref**; nothing else machine-checkably ends the interim. Until then (the PAT interim, while `PROMOTE_TOKEN`/`GH_TOKEN` are owner PATs):
     - W1.9 does **not** ship override-by-label or approval as a trust anchor; the override label is dormant until C3;
     - any protected-path change is **promoted only by the owner's break-glass** (D-H.4), outside Actions.
   - **Why:** during the interim any job holding the owner PAT can forge both record forms, because GitHub records the action as the owner. Worker runs are in such jobs (at `5e52707`, `self-merge-prs.yml` runs the conflict agent in the step holding `GH_TOKEN`).
   - **A14 regression:** a job holding the automation App token applies `cq-override`, and the result is **not** authorized (`performed_via_github_app != null`, and the actor isn't the owner).
   - **Outside Actions** (open, D-D.2): even after the window opens, a non-Actions session holding the owner's credential produces a record these checks accept. These checks change only if the owner picks option (c).
5. Both postures are computed by `cq-policy` per PR and **recomputed by the gate** over `main..tip`. The gate is authoritative.

### D-H. Bootstrap and cutover

1. **Steady state (a definition or check-code change).**
   1. The PR is judged by the **old** default-branch verifiers, flagged by the definition check, and needs the D11 record (D-G.4).
   2. With the record, `cq/policy` passes. `cq/ratchet` passes because, once authorized, it is judged under the head's new definitions (D-C.3).
   3. It merges into `merge-queue`. **A PR that touches `.github/workflows/**` is owner-merged**: the automation App has no `workflows` permission, and GitHub refuses any App-token ref update that introduces workflow-file changes. At the tip, `cq-verify` sees an authorized `main..tip` definition difference (D-C.3, push subject) and judges the new measurement.
   4. The gate's closure rule finds the record and promotes.
   5. The new definitions run from the next PR or promotion.

   **A14 regression:** an authorized measurement-definition change promotes, and the **next unrelated PR is not needs-human**.

2. **Expand/contract for every interface** between a head-defined leg (`ci`, `cq-measure`, `cq-signal`) and a default-branch consumer: workflow names and paths, job and check names, artifact schema, the `cq-signal` event set and verdict names. Change it in two promotions: first the consumer accepts old and new, then the producer switches and the consumer drops the old.
3. **First cutover from `5e52707`.** The old gate is push-triggered and runs the pushed definition, so D-H.1 can't bootstrap it.
   1. **PR C1:** add the new two-job gate (`gate.yml`) _alongside_ `merge-queue-gate.yml`, plus the verifiers in **non-required** mode. The old gate promotes C1. Both use the atomic CAS, so concurrent promotion is race-safe. C1 also:
      - **re-wires every secret holder to its environment**: `environment: automation` (or `drill`) on `self-merge-prs`, `self-review-loop`, `sync-merge-queue`, `init-merge-queue` and `live-*`, so the owner-setup secret move breaks nothing (referencing a not-yet-existing environment is safe: GitHub creates it, and repository secrets stay visible until removed);
      - **re-measures the typecheck baselines** once under the recompute's counting environment (trust-ref toolchain, attribute-free extraction), since moving away from head-executed `tsc` changes what is counted.
   2. **Owner setup (wizard, outside Actions):**
      - create the three Apps and the environments;
      - move all secrets into environments (the old gate now fails closed: `PROMOTE_TOKEN` is unreachable from `push: merge-queue`);
      - apply rulesets R0–R2 (D-I) and the Actions event policy;
      - remove the repository-level secrets.
   3. **PR C2:** remove `merge-queue-gate.yml` and make `cq/*` required. C2 touches workflows, so it is owner-merged into `merge-queue` (by admin bypass during the D-G.4 interim) and promoted by break-glass (D-H.4).
   4. **C3 (ends the PAT interim):** the owner revokes the PATs (`GH_TOKEN`, `PROMOTE_TOKEN`) and deletes any environment secret holding one, then commits an attestation file on the trust ref by break-glass. D-G.4 records become valid only once it is present. The D13 drift check asserts `GET /repos/…/actions/secrets` `total_count == 0` and that environment secret _names_ are within a committed allowlist.

      > Open: see post-acceptance note N8 in the [ADR index](README.md#post-acceptance-notes).

4. **Break-glass:** the owner (admin role, ruleset bypass on R1 only) fast-forwards `main` locally with their own credential and records it in [SELF-HOSTING.md](../../SELF-HOSTING.md). It's the only ungated path, and during the PAT interim the only path for protected-path changes.

### D-I. GitHub settings as code

[`policy/templates/github-settings.json`](../../policy/templates/github-settings.json) implements owner decision D13. It captures only features that exist on a user-owned repo, and a drift check reads each one back. (It replaces the earlier `branch-protection.json` name, since it holds rulesets, environments, the event policy and Actions settings.)

- **Rulesets.** Bypass is per ruleset, so they're **split**:
  - **R0** (`main` + `merge-queue`): non-fast-forward + deletion. Bypass: **admin only**. Even the promoter can't rewrite history.
  - **R1** (`main`): restrict updates. Bypass: **promoter App**, admin (break-glass). **No required status checks on `main`**: the gate is the authority, and the promoted SHA's `cq/*` verdicts are already on it.
  - **R2** (`merge-queue`): required status checks `cq/policy`, `cq/ratchet` and `cq/acceptance`, each with expected source = verdict App, **plus "require a pull request"** (a cheap belt: a direct push of a commit already carrying verdicts would otherwise pass R2; the D-K.3 closure refuses it at the gate anyway). **No App bypass**; admin bypass only for break-glass.
- **sync-merge-queue** goes **through a PR** (the automation App opens `sync/main→merge-queue`), so its merge commit is judged like any PR and admitted by the closure rule.
- **Environments** `cq-verdict`, `promote`, `automation` and `drill`, each with the exact default-branch-only policy (D-D.1).
- **Repository Actions event policy** (`POST/GET /repos/{owner}/{repo}/actions/policies`, proven available and enforced on a user-owned public repo): an explicit `restrict_action_events` allow-list naming exactly the events the shipped workflows use:
  - `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `workflow_run`, `workflow_dispatch`, `schedule`;
  - plus `pull_request_target` only if an informational job is opted in.

  This removes any dependence on GitHub's 2026-11-02 default and narrows the event surface. The drift check compares the policy's rules.

- **Actions settings:** "Allow GitHub Actions to create and approve pull requests" = **off**, and the default `GITHUB_TOKEN` permission = read.
- **Tag ruleset** (W7): restrict creation of `v*` (bypass: admin), and the publish job in a default-branch-only environment.

### D-J. Measurement residual (accepted by the owner at G1)

- The measurement leg executes arbitrary head code, so **a PR can make `cq-measure` report an arbitrary coverage value**, not merely "raise coverage with real tests": for example a detached process that rewrites the summary after vitest, or an in-process monkeypatch of the provider.
- **Mitigations:** D11 on test-infra and definition paths; the W1.8 tamper heuristics and the default-deny of worker test/config edits; review; and the trusted typecheck recompute, which removes the _execution_ route to forging **typecheck-count** (D-B).
- **Typecheck residual.** Typecheck-count is computed **without executing head code**, over an attribute-free extraction, with every configuration file that can steer it (`.gitattributes`, the tsconfig graph, the test configs) in the definition set. It is **not** unforgeable: suppression pragmas and ambient declarations in head _source_ (`// @ts-nocheck`, `@ts-expect-error`, a `.d.ts` with `declare module '*'`) are content, not definition, and still lower the count. The W1.8 suppression-idiom scan, applied in `cq-policy` to **every** PR diff, flags this residual.
- The owner explicitly accepted both residuals at G1. They replace the earlier W1.7 position that the head could only raise coverage with real tests.

### D-K. The gate (promotion) in detail

1. **Wake-up is untrusted and cheap.**
   - The `wake` job checks only that the carrier is allowed (D-A.1): for `workflow_run`, `path ∈ {ci.yml, cq-measure.yml}`, `event == push`, and `head_repository.id == repository_id`.
   - It carries no data forward.
   - `decide` `needs: wake` and is the only job in concurrency group `promote` (`cancel-in-progress: false`). Junk triggers (an impostor `ci`, fork runs) fail `wake` and never enter the group, so they can't cancel a legitimate pending `decide`.
2. **`decide` resolves its own subject:** `tip :=` the `merge-queue` ref from the API; `base :=` the `main` ref. It never uses the payload `head_sha`.
3. **Closure over `main..tip`.** Every commit must be one of:
   - (a) a merge commit into `merge-queue` of an accepted PR (acceptance recomputed with `classifyPr`), or reachable from that PR's head;
   - (b) a sync merge from a sync PR, admitted under (a).

   Anything else refuses: direct pushes, admin pushes, unknown merges. **Merge commits on `merge-queue`'s first-parent chain within `main..tip` must be clean**: their tree must equal a recomputed `git merge-tree` of their parents, so no evil merge (into the queue or via the sync merge) can carry content no PR diff covers. A conflict-_resolving_ merge reachable from a PR head (the toolkit's conflict path, [`conflict.default.md`](../../src/ops/merge/prompts/conflict.default.md)) is not clean by definition and is judged by that PR's own diff (`merge-base(head, base)..head`), so the clean test does not apply to it. `merge-tree` uses the strategy GitHub uses (ort) and a pinned git version; a version skew is a false refusal, which fails closed.

4. **Recompute:** `cq/policy` logic (guard, D11 diff plus records, lint) over `main..tip`, and I2 per accepted PR.
5. **Verdicts:**
   - App-created `cq/ratchet` on the tip, with `external_id` naming `base`, waited for with a 20-minute deadline. **When the tip verdict is missing or bound to another base** (e.g. `main` moved by an earlier promotion or a break-glass fast-forward), `decide` or the gate sweep **dispatches `cq-verify` on the default ref with `(subject=tip, trust=main)`**, an allowed carrier (D-A.1), instead of refusing until an unrelated merge arrives;
   - `ci`/`denylist` via verified runs (D-F.2).
6. **Promote:** `git push --atomic origin tip:main tip:merge-queue` with the promoter App token.
   - In the normal case only `main` is sent, because the up-to-date refspec is omitted.
   - A concurrent queue advance turns it into a rejected rewind.
   - The queue side needs **no bypass**.
   - The server-side CAS covers only `main`'s old value. A queue advance between ref advertisement and receive can leave `main` at a no-longer-tip ancestor of the queue, which is safe.
7. **Liveness:**
   - a `schedule` sweep (default-branch definition) runs `decide` when `merge-queue` is ahead of `main`;
   - a missed wake-up delays promotion by at most one sweep interval. **The gate sweep's interval bounds promotion latency**; its value is not yet specified (open point O-7). The `cq-signal` sweep runs only in the automation window and does not bound promotion.
   - **Workflow-file refusals are needs-human, not retries.** The merge executor and the conflict agent classify GitHub's "refusing to allow a GitHub App to create or update workflow … without `workflows` permission" as needs-human. This covers `self-merge-prs` merging a D11-authorized workflow-touching PR, the conflict agent's `git merge FETCH_HEAD` push on a branch older than a queued workflow change, and a sync PR merge after a break-glass workflow change on `main`. All three fail closed; the W1.9/W1.10 executors must not loop on them.

## Named non-adoptions

- **Org "required workflows" / push file-path rulesets / the merge-queue rule / evaluate mode:** unavailable on a user-owned repo. Revisit if the repo moves to an org.
- **A `pull_request` job that checks out the base:** still head-controlled.
- **`pull_request_target` for required checks:** whenever the real job is absent (e.g. the repository event policy blocks the event, or policy drifts), a forged Actions-app check is the only row and satisfies the requirement. Replaced by App-created `workflow_run` verdicts.
- **`GITHUB_TOKEN`-created verdicts, and commit statuses, as trust anchors:** forgeable and latest-wins.
- **Environment "protected branches only":** admits unprotected branches on a ruleset-only repo.
- **Environment required reviewers as the D11 gate:** unavailable on private Pro repos, and "prevent self-review" locks out a solo owner.
- **One automation App for everything:** verdict forgery through the worker-reachable identity, and a bypass that covers required checks.
- **One `main` ruleset combining restrict-updates and non-fast-forward:** bypass is per ruleset, so the promoter's bypass would also let it force-push `main`. Hence the separate R0.

## Consequences

**Positive**

- A14 is closed on every privileged **Actions** path. Before promotion, an edited privileged workflow never executes with a credential. Worker-produced workflow edits made with the automation App are refused at push. Promotion of an edit needs a D11 record that, once D2 holds and C3 is attested, **only a holder of the owner's GitHub credential** can create. Whether that means only the human owner depends on the open owner decision in D-D.2.
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
- **Fork PRs never receive verdicts** (D-C.1 refuses fork runs, R2 requires App verdicts, I2 never trusts fork content), so external contributions merge only by admin bypass. This is a deliberate product decision on a public repo.
- Workflow-touching PRs are owner-merged (D-H.1).

**Accepted residual** (accepted by the owner at G1): a PR can report an arbitrary coverage value, and source-level suppression can lower typecheck-count (D-J). Otherwise, an inflated ratchet-propose measurement can only over-tighten a baseline, which is visible in review.

**Open owner decision** (D-D.2): the D11 record outside Actions: (a) accept as residual, (b) no owner credential in agent sessions, or (c) a signed record form.

**Supersedes:**

- verifying a check by its source app slug and workflow path (the earlier P1 and W1.10 wording): replaced by verdict-App check runs selected by numeric app id and bound to the trust-ref SHA (D-F), run and definition-set verification (D-C), and head-defined job results that only block (D-F.2);
- the earlier W1.7 residual wording (D-J);
- the single-App identity assumption (D-D.3).

For work item W1.10 this ADR fixes: the `wake`/`decide` gate with its closure rule, recompute and atomic CAS (D-K); the C1 → owner setup → C2 → C3 cutover (D-H.3); rulesets R0–R2, sync via PR with the dispatch ref on the default branch, the environments' exact branch policies, the event policy allow-list and Actions settings (D-I); the promoter App replacing `PROMOTE_TOKEN` alongside the verdict and automation Apps (D-D.3); and every secret, provider keys included, in a default-branch-only environment with none at repository level (D-D.1). For W1.9: the override label is dormant until C3 (D-G.4). For W1.7: the typecheck recompute's attribute-free extraction, definition set, compute/sign split and lockfile rule (D-B, D-C.3, D-C.4), and the baseline re-measure at C1 (D-H.3).

**A14 regression rows** this ADR adds: an authorized measurement-definition change promotes and the next unrelated PR is not needs-human (D-H.1); an automation-App-applied `cq-override` is not authorized (D-G.4); a forged `cq/*` from `GITHUB_TOKEN` alongside an absent real verdict does not merge (D-F.1); a worker commit touching `.github/workflows/**` is refused at push (D-D.3).

## Revisit triggers

- The repo moves to an org: add required workflows and push rulesets as belts.
- GitHub changes the `workflow_run` definition-source semantics or the Actions event-policy API.
- GitHub documents workflow-file-scoped expected sources.
- npm adds CLI assertion of the expected provenance source.
- A second human collaborator joins (D3), which makes the review form of the D11 record usable without the override label.

## Appendix C: identities and credentials — platform assumptions to confirm

The identity split (D-D.3) rests on GitHub behaviours that were trialled only in part. Each is to be confirmed on a scratch user-owned repository:

1. **Per App identity:**
   - (a) a custom App installed on a user-owned repo is accepted as a ruleset bypass actor (only the _GitHub Actions_ app has been shown to be refused);
   - (b) the verdict App's check runs can be pinned as the expected source in a ruleset on a user repo, and a `GITHUB_TOKEN` check run of the same name then does **not** satisfy it;
   - (c) App-created **commit statuses** can be pinned (recorded only; not relied on, D-F.3);
   - (d) a custom App **without `workflows` permission** is refused when pushing `.github/workflows/**` changes. This has been shown only for the Actions installation token, which uses the same enforcement path, so confidence is high;
   - (e) the minimal permission sets in D-D.3 suffice for each identity's jobs;
   - (f) the refusal in (d) also applies to (i) an API merge by the automation App of a PR touching `.github/workflows/**`, (ii) the conflict agent's merge-commit push carrying a base workflow delta, and (iii) a sync-PR merge after a break-glass workflow change.
2. **App repository creation:** an App installation token can't create repositories in a user account. If so, the live-merge drill uses the second test identity (D-D.3).
3. **Second test identity:** not a collaborator on cq-toolkit, so its reviews have association `NONE` and it can't apply labels. It owns the drill scratch repositories, and its PAT lives only in the default-branch-only environment `drill`.
4. **D11 record check fields:** the timeline `labeled` event exposes `actor.id`, `actor.type` and `performed_via_github_app` for App, PAT and web-UI actors, and PAT-applied labels are indistinguishable from web-UI ones. That indistinguishability is the premise of the D-G.4 validity window.

> Open: see post-acceptance note N8 in the [ADR index](README.md#post-acceptance-notes).
