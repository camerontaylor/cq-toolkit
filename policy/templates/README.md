# policy/templates — merge-queue workflow templates

Adoptable, parameterized templates for the cq-toolkit merge-queue doctrine:
everything a repository needs to run the queue mechanics (bootstrap the
branch, gate promotions, keep the branches level) plus the two check
patterns (required-check, affected-tests). The templates are the single
source of truth — see "The bootstrap rule" for what that commits you to.

## Files

| file                          | what it is                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init-merge-queue.yml`        | dispatch-only, idempotent bootstrap of the `merge-queue` branch at `origin/main` HEAD (env `automation`)                                                                                                                                                                                                                                           |
| `merge-queue-gate.yml`        | RETIRED at C2 (2026-10-11), adopter-only (docs/promotion-policy.md): the former batch promoter — on a `crq/promotion-review` status or a dispatch, verified the review and I4 on the reviewed sha, then fast-forwarded `main` to it behind queue, base and review guards                                                                           |
| `gate.yml`                    | `cq-gate`, the promotion job (ADR-0004 D-K), armed and the SOLE promoter since C2: `wake` verifies the trigger, `decide` (env `promote`, group `promote`) runs `promote-gate` from the trust ref WITH `--push`                                                                                                                                     |
| `sync-merge-queue.yml`        | on push to `main`: API-only triage (zero clone) that opens or reuses a `main → merge-queue` sync PR when `main` has commits the queue lacks, and dispatches `gate.yml` on `main` when the queue is ahead (env `automation`)                                                                                                                        |
| `adversarial-suite.yml`       | dispatch-only §7 live probes against the dedicated `cq-scratch-v11-adversarial` repository; requires two distinct test identities in environment `adversarial-scratch`, whose scratch-administration credential mints per run from the dedicated cq-adversarial-scratch App (ADR-0004 note N19), and runs both trust profiles                      |
| `live-merge.yml`              | dispatch-only live drill: runs the F5 merge-prs integration test against a fresh private scratch repo on github.com (records its runs in `docs/drills/2026-09-f5.md`; env `drill`)                                                                                                                                                                 |
| `required-check.md`           | the I4 pattern — required checks never filter triggers — with this repo's static job as the worked example                                                                                                                                                                                                                                         |
| `affected-tests.md`           | the per-PR reduced-test-selection pattern, its documented blind spot, and its I4 interplay                                                                                                                                                                                                                                                         |
| `ratchet.yml`                 | LEGACY required type and coverage baseline checks on pushes and pull requests (head-defined; retired at the ADR-0004 cutover)                                                                                                                                                                                                                      |
| `cq-measure.yml`              | credential-free head measurement leg (`permissions: {}`): runs the suite, uploads a numbers-only coverage artifact                                                                                                                                                                                                                                 |
| `cq-verify.yml`               | default-branch `workflow_run` ratchet verifier: definitions and baselines from the trust ref's `baselines/ratchets.json`, typecheck recomputed over the attribute-free head tree, posts `cq/ratchet` (env `cq-verdict`)                                                                                                                            |
| `cq-signal.yml`               | head-defined wake-up (`permissions: {}`, no checkout, no-op body): PR head, review and merge-queue push events fire the default-branch verifiers (debounced 2026-10-20: no comment, edit or label events; `cq-accept`'s sweep reconciles)                                                                                                          |
| `cq-policy.yml`               | default-branch `workflow_run` D11 verifier: trust-ref `gates.policyDiff` over the head's git objects, posture from `vars.CQ_MERGE_PROTECTED_PATHS` (`human` default, `diff-check`, or `advisory`: only privileged paths, loosened baselines and removed targets/entries need a human), posts `cq/policy` (env `cq-verdict`; not required at merge) |
| `cq-accept.yml`               | default-branch I2 acceptance verifier (`workflow_run` on `cq-signal`, a 15-minute sweep, dispatch by PR): posts `cq/acceptance` on merge-queue PR heads (env `cq-verdict`; not yet required)                                                                                                                                                       |
| `settings-drift.yml`          | daily D13 drift check: live rulesets, environments, secret names and Actions settings against `github-settings.json` (env `cq-verdict`; fails closed until armed)                                                                                                                                                                                  |
| `github-settings.json`        | the D13 target state as code: rulesets R0/R1/R2 plus the C2 `cq-c2-replay-marker` marker ruleset (owner-applied at cutover step 5) with their bypass lists, the five environments and their secret allowlists, no repository secrets, Actions settings (applied by the W7.3a wizard; read by the drift check)                                      |
| `instances.json`              | this repo's instantiation table: each workflow's template and token values, plus the non-templated and adopter-only lists (`scripts/render-templates.mjs --check`/`--write`)                                                                                                                                                                       |
| `ratchet-propose-measure.yml` | credential-free post-promotion measurement for baseline proposals                                                                                                                                                                                                                                                                                  |
| `ratchet-propose.yml`         | `workflow_run` proposer: opens baseline-tightening PRs against `merge-queue` from the measure artifact, token behind `environment: automation`                                                                                                                                                                                                     |
| `self-host/`                  | the stage-2 self-hosting automation (scheduled review-loop + merge-prs run from source) as adoptable workflows — `self-host/README.md` carries its files, tokens, and wiring guide                                                                                                                                                                 |
| `README.md`                   | this guide                                                                                                                                                                                                                                                                                                                                         |

The adversarial workflow serializes its two profile jobs because live profile setup may change scratch repository variables or rulesets. Live setup for both profiles remains unverified until the separate identity credentials, policy controls and verdict probe are provisioned and a dispatch completes.

## Placeholder tokens

Every literal `{{TOKEN}}` in a template file is replaced by its literal
value at instantiation time, and nothing else in the file changes — with
one deliberate exception: `{{COMMANDS...}}` (last table row) names a
HAND-REPLACED slot, not a token. No literal `{{COMMANDS...}}` placeholder
appears in `required-check.md` — the worked example carries this repo's
real run steps — so an adopter swaps those steps by hand rather than by
substitution.

| token                            | used by                                                                             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{PROMOTE_SECRET}}`             | merge-queue-gate (retired, adopter-only)                                            | NAME of the secret holding the INTERIM promotion PAT (this repo: `PROMOTE_TOKEN`) — a fine-grained PAT with Contents read/write, Workflows write and Metadata read, interim only until the promoter App is installed (RS-11 matrix row 2). The legacy gate uses it for its checkout remote, the check wait and the ff-push (a `GITHUB_TOKEN` push would not fire the `on: push: main` sync). `gate.yml` names the same secret literally and reaches it only in the push step, as the fallback when no promoter-App token is minted. Environment: repository-level during C1; the owner moves it into `promote` (main-only), after which the legacy gate fails closed. Instantiated files reference it as `${{ secrets.<name> }}` — a name, never a value; a template or instantiation that embeds a token value is a denylist-class bug. |
| `{{DRILL_SECRET}}`               | live-merge                                                                          | NAME of the `drill` environment secret holding the drill credential (this repo: `CQ_DRILL_MERGE_TOKEN`): a classic token with `repo` plus `read:org` (see the template header). Never the promotion credential, and never `GH_TOKEN`, which in `drill` is live-review's fine-grained scratch-repo PAT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `{{GATE_CHECKS}}`                | merge-queue-gate (retired, adopter-only)                                            | comma list of required check names the gate waits for, e.g. `static,denylist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `policy/promotion-reviewer.json` | merge-queue-gate (retired, adopter-only); `gate.yml` reads the same identity source | the sole reviewer identity source, committed from the owner's registration record. Crq and the signer activate only when this file on main is valid and matches their configured identity. The gate-consumption guarantee is enforced separately by this protected per-step lockstep test: it parses the retired template and verifies each trust step fetches this file at `GITHUB_SHA`, extracts login/id, and passes them to the trust jq. The test runs in required `static` CI. Do not copy the identity into workflow literals or repo variables.                                                                                                                                                                                                                                                                                  |
| `{{GATE_WORKFLOWS}}`             | gate                                                                                | comma list of workflow FILE names whose merge-queue push runs must have succeeded on the tip, read by workflow path (never by check name), e.g. `ci.yml,denylist.yml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{{GATE_TIMEOUT_MIN}}`           | merge-queue-gate (retired, adopter-only), gate                                      | minutes a gate waits for its checks (legacy) or its verdicts and workflow runs (`gate.yml`) before refusing to promote (default 20; never promote unchecked). For `gate.yml` keep it ≤ 25: the wait plus checkout, install and build must stay under `decide`'s fixed 40-minute job timeout, or the runner may kill `decide` mid-wait (it still fails closed, but the report is lost); the render test enforces this for this repo's instance                                                                                                                                                                                                                                                                                                                                                                                            |
| `{{RUNNER}}`                     | required-check.md, affected-tests.md                                                | `runs-on` label, e.g. `ubuntu-latest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{{NODE_VERSION}}`               | required-check.md, affected-tests.md                                                | Node version for `setup-node`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `{{INSTALL_CMD}}`                | required-check.md, affected-tests.md                                                | dependency install command, e.g. `pnpm install --frozen-lockfile`; the templates' `pnpm/action-setup` step and `cache: pnpm` assume pnpm, so swap them with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `{{COMMANDS...}}`                | required-check.md                                                                   | HAND-REPLACED slot (see above): the variadic ordered run-steps of the static job. The template carries this repo's filling: one `uses: ./.github/actions/static-gate` step, the repo-owned composite action holding the seven steps — static gate, format check, `test:unit`, `test:e2e`, Knip, build, generated-op-docs drift — that the macOS venue shares. An adopter replaces that step by hand with their own commands; no placeholder text is substituted.                                                                                                                                                                                                                                                                                                                                                                         |
| `{{SELFHOST_DRIVER_KEY}}`        | self-host workflows                                                                 | NAME of the `automation` environment secret holding the model-provider API key the review-fix workers' driver reads (`ZAI_API_KEY` at run time) — instantiated files reference it as `${{ secrets.<name> }}`; a name, never a value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The automation App's per-run mint carries NO placeholder: `self-merge-prs`,
`self-review-loop`, `sync-merge-queue`, `init-merge-queue` and
`ratchet-propose` all name the `automation` environment secret
`CQ_AUTOMATION_APP_KEY` and the `CQ_AUTOMATION_APP_CLIENT_ID` repository
variable literally, so each adopter sets them under those names. The interim
`{{AUTOMATION_SECRET}}`/`{{INTERIM_SECRET}}`/`{{INTERIM_FALLBACK}}` and
`{{SELFHOST_TOKEN}}` placeholders are retired — no template uses them any
more (the automation credential is never a stored PAT).

Literal names (no token; the same in every instantiation): the verdict
posters (`cq-policy`, `cq-verify`, `cq-accept`) and `settings-drift` read
`CQ_VERDICT_APP_KEY` from environment `cq-verdict`; `settings-drift` falls
back to the interim read-only fine-grained PAT `CQ_SETTINGS_TOKEN` there
(Administration, Environments, Secrets and Actions: read; the Actions event
policy, which GitHub serves only to Administration: write, is reported
unchecked and covered by the owner-run `--require-event-policy` check).
`gate.yml` reads
`CQ_PROMOTER_APP_KEY` from environment `promote`. Each App's token is minted
only when its `vars.CQ_*_APP_CLIENT_ID` repository variable is set; the
gate's verdict selection keys on `vars.CQ_VERDICT_APP_ID`. The trust set is
`vars.CQ_MERGE_TRUSTED_BOTS`, `vars.CQ_MERGE_ACCEPT_REVIEW_STATES`,
`vars.CQ_MERGE_TRUSTED_ASSOCIATIONS` and the posture
`vars.CQ_MERGE_PROTECTED_PATHS` (blank = the conservative default). Set
`vars.CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW=true` only when the project
uses separate author and reviewer agents under one GitHub account; it defaults
to false and both the acceptance check and merge-time recheck require a valid
head-bound `cq-agent-review` marker.

**Advisory posture (development).** `vars.CQ_MERGE_PROTECTED_PATHS=advisory`
is this repository's development posture (2026-10-20; see
[docs/protected-scope.md](../../docs/protected-scope.md#advisory-posture-development-2026-10-20)).
Only a path the trust ref's `policy/protected-paths.json` names (the
privileged list), a loosened baseline, or a removed ratchet target or
definition/policy-list entry still needs a human; `lint` still fails; every
other finding is an `advisory:` line in the run report. An adopter that wants
the conservative behaviour leaves the variable blank (`human`).

## How instantiation works

1. Replace every `{{TOKEN}}` in the template with its literal value (the
   tables above and each template's header say which tokens it takes).
2. Drop the result, otherwise unchanged, into `.github/workflows/`.
3. Keep the provenance header the instantiator adds
   (`# instantiated from policy/templates/... — edit the template, not this
file`); it is what makes template drift visible in diffs.
4. When a NEW required check lands, remember that "required" is defined in
   THREE unlinked places, and all three must learn it:
   - `REQUIRED_WORKFLOW_CHECKS` in `scripts/denylist-scan` — the I4 policy
     data, pairing each required workflow FILE with the CHECK NAME of the
     job that must produce it (GitHub reports a job's check run under the
     job id); the self-test fail-closes on an empty or malformed list, a
     missing file, or a job renamed away from its paired name. Updated
     alone, the check's workflow shape is policed but nothing in the
     merge path requires it to pass — the check is advisory.
   - the gate's wait list — `{{GATE_CHECKS}}` in the retired template (adopter-only;
     this repo no longer instantiates it). The retired gate ff-promoted past a required check
     that never succeeded on the queue sha unless the wait list was updated — I4 defeated at
     exactly the promotion boundary it exists to guard;
     updated alone, the gate waits for a check branch protection does not
     require on PRs, so an unchecked PR can still merge into the queue
     ahead of it (the gate still stops it before promotion — belt, not
     buckle). `gate.yml` has no check-name list: it reads the `cq/*`
     verdicts by app and the `{{GATE_WORKFLOWS}}` runs by workflow path
     (ADR-0004 D-F.2).
   - branch protection required status-check contexts, on BOTH branches —
     `merge-queue` (this is what actually blocks PR merges into the queue)
     and `main` (the promotion backstop). Updated alone, PRs hang unmergeable
     waiting for a check the rest of the system ignores, with no failing red
     check to point at — the exact I4 failure mode.

## The bootstrap rule

Every hand-carried workflow is the same template that ships in `policy/` —
nothing is throwaway. The placeholder ratchet script was replaced (H4) by the
engine-based runners `scripts/ratchet-typecheck.mjs` and
`scripts/ratchet-check.mjs` (kept as local drivers), and the required ratchet
workflow (`ratchet.yml`) drives the shipped CLI subcommands
(`ratchet.checkRatchet`, `ratchet.monotonicGuard`); their committed baselines
live in `baselines/`
(one schemaVersion-1 file per (target, metric), written by
`createCaptureBaseline`), and the ratchet definitions (the ratchet list and
the ADR-0004 definition set) live in `baselines/ratchets.json`, which the
trusted verifier (`cq-verify.yml`, `ratchet.verifyRatchet`) reads at the
default-branch ref, never from the PR head. Concretely, in this repo: `.github/workflows/ci.yml`
is `required-check.md` instantiated, the three queue workflows are the three
queue `.yml` templates instantiated (`init-merge-queue`,
`gate`, `sync-merge-queue`) — `merge-queue-gate` retired at C2 and is no longer
instantiated here (adopter-only) —, the live-merge drill workflow is
`live-merge.yml` instantiated, the dispatch-only adversarial suite is
`adversarial-suite.yml` instantiated, the five ratchet workflows (`ratchet`,
`cq-measure`, `cq-verify`, `ratchet-propose-measure`, `ratchet-propose`) are their matching
`.yml` templates instantiated, the two D11 policy workflows (`cq-signal`,
`cq-policy`), the acceptance verifier (`cq-accept`) and the drift check
(`settings-drift`) are theirs, and `denylist.yml` (which predates the
templates) carries the required-check trigger shape with the denylist job
body and a provenance comment pointing back at `required-check.md`. If you
find yourself editing a file under `.github/workflows/`, stop: edit the
template here and re-instantiate (`node scripts/render-templates.mjs
--write`; `instances.json` records each instance's template and tokens, and
the render-diff test fails on any drift), or the repo drifts from its own
policy.

## THE ENTITLEMENT FACTS

- Personal GitHub accounts get HTTP 422 from the native merge-queue API
  (verified 2026-09): the documented merge-queue endpoints are effectively
  organization-plan features for these accounts. That failure is why this
  queue is branch-based — `merge-queue` is an ordinary branch, PRs target
  it, and promotion is a push.
- A non-forced push is the server-side fast-forward invariant: the server
  itself rejects any non-fast-forward update. An ff-only queue therefore
  needs no client-side trust — even a buggy workflow cannot move a ref
  backwards or sideways, because the server refuses. No template forces a
  push or a ref update.
- Ruleset R2 (`github-settings.json`) requires a pull request for every
  `merge-queue` update by a non-admin identity, so sync never writes
  `merge-queue` directly: when `main` has commits the queue lacks, it opens
  (or reuses) a `main → merge-queue` sync PR, judged and merged like any
  other.
- Related mechanics fact: `GITHUB_TOKEN` pushes and pull requests do not
  trigger other workflows (a `workflow_dispatch` does). The only pushes to
  `main` these templates make are the gates' promotions, and they use the
  promotion credential (promoter App or interim PAT) so the downstream
  `on: push: main` sync actually fires; the sync PR is opened with the
  automation credential so its checks run; sync itself never advances
  `main` (ahead → dispatch the gates on `main` with its own
  `GITHUB_TOKEN`).

## I3 — promotion is a pure fast-forward

Merge commits only. PRs merge into `merge-queue` with merge commits, the
queue advances only by merging, and `main` advances only by fast-forward
promotion of a fully checked, promotion-REVIEWED `merge-queue` commit
([docs/promotion-policy.md](../../docs/promotion-policy.md)). `cq-gate` (`gate.yml`, armed)
is the ONLY component that advances `main` — the old `merge-queue-gate` retired at C2
(2026-10-11) and survives only as an adopter-only template. Sync's ahead case never writes
`main` itself — it dispatches the gate, and an unreviewed tip just ends "awaiting promotion
review". Never squash, never rewrite history, never force-push, never touch
`main` by any other path. `cq-gate` admits `main..tip` only through its
closure rule (every commit a clean first-parent merge of a merged PR into
`merge-queue`, or reachable from such a PR's head) and recomputes I2's
evidence rows (not its settle, which only the merger's recheck enforces) and
`gates.policyDiff` (methods-w1-10 Decision 12).

The retired `merge-queue-gate` template (adopter-only) promotes only on a REVIEW: the newest
`crq/promotion-review` commit status on the sha posted by the pinned
reviewer bot — creator type `Bot`, login `cq-promotion-reviewer[bot]` AND its numeric
bot user id, all three (a commit status carries no app id, so the bot user
is the identity; the `[bot]` suffix is reserved for Apps and the id survives
a slug reuse). The values live only in `policy/promotion-reviewer.json`, from
the owner's registration record (`app-registration-session-20261004.md`). Each
trust-filter step fetches that file at `GITHUB_SHA`, validates its schema and
Bot identity fields, and passes the id as a JSON number
(`--argjson`; a `--arg` string compare would fail closed on every status).
Any other creator — the repository owner's own login, GITHUB_TOKEN, every App
— never counts, and a promotion-review status from one is a red refusal when
no trusted review exists. A review is `success` and binds its
reviewed base as `main=<sha>` in the description. An unreviewed, pending or
blocked sha, or one already in `main`, ends green with no promotion: waiting
is not failing. With a review it waits until every required check on its
list succeeded on the sha (I4: skipped, cancelled or missing is never a
pass), then guards, in order: already an ancestor of `main` is a logged
no-op; a sha off `merge-queue` (not on the first-parent line of the tip — the tip
itself or a commit reached by following first parents) refuses;
`main` not an ancestor of the sha (diverged) refuses and a human merges
`main` into `merge-queue`; a review base `main` does not contain refuses
(`main..sha` would hold unreviewed commits). Only then does it push
`<sha>:refs/heads/main` without force, so the server rejects anything but a
fast-forward. The REVIEWED sha promotes, even when newer merges have moved
the queue tip past it.

## Action pinning

Every `uses:` in these templates and their instantiations is pinned to an
immutable commit SHA (never a mutable `@v5` tag — tags can be retargeted
after review). Required-check jobs additionally set
`persist-credentials: false` on checkout: they run repo code, and the
checkout token must not survive into it. The two queue-mechanics checkouts
that push with a checkout credential (the legacy gate's promotion checkout
and the init bootstrap) deliberately KEEP the persisted credential — they
run no repo code — and say so in a comment beside the pin. The
default-branch verifiers and `cq-gate` never persist one: their fetches and
the gate's push carry a step-scoped `GIT_CONFIG_*` extra-header.
