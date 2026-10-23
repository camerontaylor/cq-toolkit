# policy/templates/self-host — self-hosted automation templates

Adoptable templates for the self-hosting switch: the toolkit running on the
repository that ships it. Two scheduled workflows turn the toolkit's own
review loop and governed merge dispatch into standing automation against an
adopting repo's own open PRs — the same surfaces this repository instantiates
in its own `.github/workflows/`.

## Files

| file                   | what it is                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self-review-loop.yml` | opt-in review-loop automation (dispatch only, dry run by default): runs `runReviewLoop` from source over every open, same-repo, non-draft PR — fetch, classify, respond, resolve |
| `self-merge-prs.yml`   | scheduled merge-dispatch automation: classifies open PRs and executes eligible merges through the governed kernel (BudgetGovernor → runPlan → withBudgetStop)                    |
| `README.md`            | this guide                                                                                                                                                                       |

**Review loop is opt-in (development posture, 2026-10-20).** The
`self-review-loop.yml` template carries no schedule: it runs only by
`workflow_dispatch`, with `dry_run` defaulting to true. In the 2026-10-19
sprint review it posted 1,019 replies and landed 0 fixes, so it stays opt-in
until it shows a fixes-per-run rate above zero. The schedule, cadence and
slot notes below describe the loop as it ran before; they apply again only if
a cron is deliberately re-added.

## Wiring an adopting repo

1. Instantiate both templates (see "Placeholder tokens" below and each
   template's header), drop the results into `.github/workflows/`, and keep
   the `# instantiated from policy/templates/self-host/... — edit the
template, not this file` provenance header.
2. Build from source: both workflows run `pnpm install --frozen-lockfile`
   then `pnpm run build` and invoke the built entries — the adoption is the SOURCE, never a published
   tarball.
3. Configure the credentials (below): both workflows mint the `cq-automation`
   App's installation token per run — no stored GitHub credential. Confirm the two driver bindings in
   `src/selfhost/config.ts` name YOUR providers and their served model ids —
   `SelfhostDefaults.driver` is the OFF-PEAK binding and `SelfhostPeak.driver`
   the peak one, selected by `SelfhostPeak.window` (all three are frozen
   data). This repo's instantiation uses the ai-sdk route against the Z.AI
   GLM coding endpoint (served id `glm-5.3-flash`) off-peak and OpenCode Go
   (`deepseek-v4.1-flash`) inside the peak window.
4. Provision both provider keys and the OpenCode Go route variable (below),
   and edit
   `SelfhostPeak` in the toolkit if your provider's peak window differs. The
   schedule itself is all-hours; no cron or YAML window needs to move with it.
   If you re-point `SelfhostDefaults.driver` or `SelfhostPeak.driver` at
   another in-process provider (`openai`, `anthropic`), export THAT provider's
   key env in the run step from your own secret — the toolkit's `driverKeyEnv`
   names it, and `--print-driver-key-env` reports the one this clock requires.

## The two entry commands

The workflows invoke exactly these surfaces (flags per
`parseSelfhostArgs` in `src/selfhost/config.ts`):

```sh
node dist/selfhost/self-review-loop.js --repo <owner/name> --responder-login <login> [--max-usd <n>] [--dry-run]
node dist/selfhost/self-merge-prs.js --repo <owner/name> [--max-usd <n>] [--dry-run]
```

`--responder-login` is the review loop's OWN identity — in CI, the token's
user (the workflow resolves it at runtime with `gh api user -q .login`).
Both entries print their compact JSON summary on stdout (the workflows tee
it to the run summary) and exit 0 with honest outcomes — per-PR failures and
needs-human rows are results, not crashes; only a whole-run throw (bad args,
a failed listing) exits 1. The review-loop entry additionally reports its
sweep token usage (see "Budget caps" below): a `sweepUsage` JSON line on
stdout, a small markdown table appended to `$GITHUB_STEP_SUMMARY` when set,
and the same JSON written to `$SWEEP_USAGE_OUT` for the workflow's artifact
upload. The workflow uses the visible `${{ runner.temp }}/sweep-usage.json`
path so the upload action does not exclude it as hidden; missing files warn.

I2 acceptance normally requires a non-author review. When author and reviewer
agents must share one GitHub account, set repository variable
`CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW=true` in the adopting repo; blank or
false keeps author reviews ineligible. The independent reviewer must submit a
`COMMENTED` review containing exactly one marker in this form, with distinct
agent IDs and the exact reviewed head SHA:

```html
<!-- cq-agent-review: {"version":1,"reviewerAgentId":"reviewer-agent","authorAgentId":"author-agent","headSha":"0123456789abcdef0123456789abcdef01234567","verdict":"PASS","independent":true} -->
```

`HOLD`, `RETRACT`, malformed markers, stale heads, and later marked reviews
supersede earlier author-agent passes. An ordinary author comment does not
count. The marker records the independent review procedure; it does not
cryptographically authenticate the agent IDs.

## Required credentials

Names only in the templates — secret values live in the adopting repo's
`automation` environment (a main-only deployment branch policy, W1.10
Decision 8): the jobs that read them declare `environment: automation`, so a
dispatch from any other ref fails at job admission, before a secret is
exposed.

| credential                     | where it lives      | what it holds                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CQ_AUTOMATION_APP_KEY`        | `automation` SECRET | the `cq-automation` App's private key. BOTH privileged jobs mint an installation token from it per run, scoped to this repository only. LITERAL name (each mint step names it).                                                                                                                              |
| `CQ_AUTOMATION_APP_CLIENT_ID`  | repository VARIABLE | the `cq-automation` App's client id, paired with the key. Each mint step is variable-gated: with the variable unset the step is skipped and the workflow handles the missing credential honestly (the loop refuses, the merge dispatch skips). LITERAL name.                                                 |
| `{{SELFHOST_DRIVER_KEY}}`      | `automation` SECRET | the OFF-PEAK model provider API key driving review-loop fix workers through the ai-sdk route (read as `ZAI_API_KEY`). Used when the run's UTC start is outside the peak window. Self-host merge conflict resolution is disabled; DIRTY candidates are reported as needs-human.                               |
| `{{SELFHOST_PEAK_DRIVER_KEY}}` | `automation` SECRET | the PEAK model provider API key (read as `OPENCODE_GO_API_KEY` for this repo's OpenCode Go binding). Used when the run's UTC start is inside the peak window. Both provider credentials and the Go route are exported; the run step requires only the selected key, so the other window's key may be absent. |
| `OPENCODE_GO_BASE_URL`         | repository VARIABLE | the configured OpenCode Go route, passed to the ai-sdk provider. Required by a non-dry peak run when OpenCode Go is selected.                                                                                                                                                                                |

Every credential is step-scoped and never reaches `pnpm install`'s
lifecycle scripts: the App private key is provided only to the mint step
(via `private-key`), and the minted installation token is provided only to
the run step. The two failure modes are distinct and both fail closed. An
UNSET `CQ_AUTOMATION_APP_CLIENT_ID` variable skips the mint step, and the
workflow then takes its documented tokenless path — the review loop REFUSES
to start (exit 1), `self-merge-prs` SKIPS successfully (exit 0, a documented
no-op); required I4 checks are separate and never use this optional skip. A
SET variable with an absent, rotated or malformed `CQ_AUTOMATION_APP_KEY`
FAILS the mint step (`private-key` is required), so the job goes red loudly —
never a silent no-op. There is NO PAT fallback and no classic-token
last resort: the mint is the only credential source, so a failed or skipped
mint can never promote an interim human token into the automation identity.

### The review loop's identity: the App, minted per run

`self-review-loop` mints its GitHub credential per run. The privileged job
mints an installation token for the registered `cq-automation` App from
`CQ_AUTOMATION_APP_KEY` (environment secret) plus `CQ_AUTOMATION_APP_CLIENT_ID`
(repository variable), scoped to this repository only, requesting only Pull
requests write (review replies, thread resolves), Contents write (review-fix
pushes) and Issues write (top-level PR comments). This is the per-run-mint
pattern shipped for the adversarial drills in PR #307
(`policy/templates/adversarial-suite.yml`); it supersedes the PR #303 identity
note, which deferred per-run minting as a separately scoped behavior change.
An App identity keeps the loop's replies, fixes and pushes attributable and
review-independent (doctrine I2), revokes independently of every human
credential, and avoids a long-lived repo-scope secret — and minting per run
removes the static-token refresh problem (#303) outright.

There is no PAT fallback: the schedule has no second identity. With an empty
`CQ_AUTOMATION_APP_CLIENT_ID` variable the mint step is skipped and the loop
REFUSES to run — the loop step asserts the minted token with a message naming
both the variable and the secret — rather than posting as a human or the
runner; with the variable set but the App key absent, rotated or malformed the
mint step itself FAILS (a red run). The `GH_TOKEN` env
indirection still drives the same code, but its only source is the mint. The
mint also carries a fail-closed scope guard (`github.event.repository.name !=
''`): `owner` without `repositories` would mint an installation-wide token, so
the step never runs unless the repository name is present.

### The merge dispatch's identity: the App, minted per run

`self-merge-prs` mints the same `cq-automation` App's installation token per
run — the pattern shipped for the review loop — from `CQ_AUTOMATION_APP_KEY`
(environment secret) plus `CQ_AUTOMATION_APP_CLIENT_ID` (repository
variable), scoped to this repository only, requesting only Pull requests
write (list, read, merge), Contents write (the `cq-state` settle-state
branch) and Issues read (the PR's top-level conversation comments the
classifier reads). The per-run mint removes the static-token refresh problem
outright, so its identity is the App, never a human or role PAT: merges stay
attributable, revoke independently of every human credential, and no
long-lived repo-scope secret exists.

Unlike the review loop, the merge dispatch SKIPS HONESTLY (exit 0, a
documented no-op) when no token was minted — the non-required job is optional
and a repository without its automation configured is not broken. There is no
PAT fallback: the mint is the only credential source, and the `GH_TOKEN` env
indirection drives the same code with the minted token only.

## Standing requirements (Rule / Why / Enforcement)

Every standing requirement of the automation, with its enforcing artifact
named. A requirement no automation enforces is marked `manual:` — the
adopter owns it by hand.

### The peak window and the model switch

- Rule: the schedule runs all day; the MODEL changes at the peak boundary.
  Keep your provider's peak window, its pre-peak dispatch headroom and the
  two driver bindings in the toolkit (`SelfhostPeak` →
  `resolveSelfhostDriver` in `src/selfhost/config.ts`), not in cron. Resolve
  the driver from the run's own UTC start so delayed fires and manual
  dispatches behave like scheduled ones, and fail closed when the SELECTED
  window's key is absent.
- Why: this repo's review loop no longer stands down during the
  06:00–10:00 UTC Monday–Friday Z.ai GLM peak (14:00–18:00 Asia/Singapore,
  ~3x quota consumption). It runs every 15 minutes, every day
  (`*/15 * * * *`), and switches provider for the peak: off-peak
  `zai/glm-5.3-flash` (with `ZAI_API_KEY`), peak
  `opencode-go/deepseek-v4.1-flash` (with `OPENCODE_GO_API_KEY` and
  `OPENCODE_GO_BASE_URL`). The peak selection also covers the reserved
  **pre-peak headroom** (`SelfhostPeak.headroomMinutes`, 20 minutes — the
  documented ≤20-minute scheduled run): a run's driver is fixed when it
  starts, so a sweep starting at 05:41 could otherwise still be dispatching
  Z.ai GLM work after 06:00; starting in that band is dispatched through the
  peak provider instead. This reserves dispatch, never a start exclusion:
  the loop still runs all day. Peak and headroom runs therefore use the
  configured OpenCode Go route; the sweep token cap still bounds a run. The
  merge-dispatch sibling keeps the older, narrower 15:00–01:00 UTC window
  and is out of scope.
- Enforcement: the frozen `SelfhostPeak` window + headroom and
  `resolveSelfhostDriver` decide the driver inside the toolkit; the
  review-loop template's single all-hours cron removes the old start
  exclusion, and its run-step assert derives the required key name from the
  SAME function (`--print-driver-key-env`). `main()` also refuses to start
  when the selected key is missing, and the entry threads ONE clock read
  through both the preflight and the sweep, so a boundary-straddling run
  cannot check one window's key and dispatch through the other. A
  `--dry-run` posts and dispatches nothing, so neither the handshake nor
  `main()` demands a provider key for it. The run step also pins ONE run
  instant per step (`export CQ_SELFHOST_NOW_MS="$(date -u +%s000)"`), read
  by BOTH the `--print-driver-key-env` handshake process and the run, so the
  two cannot straddle a selection boundary and disagree about which key is
  required. Adopters move peak window, headroom, drivers and keys together
  — `manual:`.

### Budget caps and the wall-clock ladder (I9)

- Rule: every scheduled run carries a token cap (default
  `SelfhostDefaults.maxTokens`, 2,000,000 tokens; `--max-usd` is an optional
  USD opt-in for a priced model — the default model is unpriced, and a USD
  cap over unpriced usage fails the run loud, DD-9) as an honest stop — the
  governor halts the run when the rollup crosses it rather than pretending
  to have finished (a one-job merge plan shows the budget-exhausted job row —
  `stoppedEarly` stays false — and the loop path's per-PR governors surface
  the trip through the job row too); the merge path
  also arms the governor's wall-clock ladder
  (`SelfhostDefaults.perJobWallClockMs`, 5 minutes) so a wedged
  conflict-agent or fix-worker job is escalated instead of stalling the
  scheduled slot forever.
- Why: an uncapped scheduled dispatch spends without bound (I9), and a
  wedged job would eat the slot (review-debt #137's arming). The
  2,000,000-token default is a PLACEHOLDER pending real soak data: every
  review-loop run therefore reports its token bookkeeping — cap, per-PR
  consumption, remaining, exhausted yes/no — as a `sweepUsage` JSON line on
  stdout, a step-summary table, and a workflow artifact, so the cap can be
  tuned from evidence instead of guesses.
- Enforcement: the governor armed inside the entry modules —
  `src/selfhost/self-merge-prs.ts`'s `new BudgetGovernor(governorConfig(...))`
  construction over `runSelfMergePrs`'s runOptions (`buildRunInput` only
  prepares the plan input); the review loop's `runOptions` — from the frozen
  constants in `src/selfhost/config.ts`
  (`SelfhostDefaults.maxTokens`, `SelfhostDefaults.perJobWallClockMs`); and
  the usage report the review-loop entry emits and its workflow uploads as
  the `self-review-usage-<run id>` artifact.

### One ≤20-minute slot per schedule fire

- Rule: each scheduled slot gets ONE run of at most 20 minutes; the next
  scheduled slot re-enters with the persisted journal.
- Why: the journal (dispatch logs, the conflict session store) is the
  cross-run memory — a slot that could run unbounded would duplicate or
  starve the slots after it.
- Enforcement: `timeout-minutes: 20` on the job in each workflow YAML.

### SHA-bound acceptance and durable settle state (W1.2)

- Rule: immediately before every merge call, `self-merge-prs` re-fetches the
  PR (head, base, reviews, force-push timeline) and merges only when a
  trusted review's `commit.oid` equals the live head SHA and the identical
  `(head SHA, base SHA, force-push epoch)` tuple has two durable observations
  at least the settle window apart. Observations live in
  `.cq/settle-state.json` on the `cq-state` branch, written through the
  GitHub git-data API with a fast-forward-only (compare-and-swap) ref update.
- Why: commit timestamps are author-controlled and GitHub records no push
  time, so settle is measured from the automation's own observations. The
  Actions cache holding `.selfhost/journal` is evictable and writable by any
  job with the Actions token, so it never holds settle state.
- Enforcement: `gateMergeEffects` and `recheckBeforeMerge` in
  `src/selfhost/merge-recheck.ts` wrap the merge effect itself, so no
  classify→merge window remains; `src/selfhost/state-branch.ts` owns the
  store. A refusal shows as a `cq merge-time recheck refused pr N: …`
  needs-human row, and a later run merges the PR once it qualifies.
  `self-merge-prs`'s minted App token needs Contents write to update
  `cq-state` (the review loop's minted token requests Contents write for its
  review-fix pushes, not settle state).
  Restricting that branch to the automation identity is a MANUAL ruleset
  step today — no automation enforces it until W1.10 — so any Contents-write
  holder can back-date an anchor. That can only shorten settle; it can never
  forge SHA-bound acceptance.

### Honest outcomes

- Rule: the entries exit 0 with per-PR failures and needs-human rows
  printed (the stdout JSON summary plus the stderr echo); only a whole-run
  throw (bad args, a failed listing) exits 1.
- Why: a needs-human row is a result, not a crash — the two failure modes
  ruled out are a fabricated green run and a crash that orphans the
  remaining PRs.
- Enforcement: the entry modules' `main()` contract
  (`src/selfhost/self-review-loop.ts`, `src/selfhost/self-merge-prs.ts`)
  plus `set -euo pipefail` in each workflow run block, which turns that
  throw into a red step despite `tee`.

### The single-identity caveat (I2)

- Rule: the self-host conflict stage is disabled; DIRTY candidates are
  reported as `needs-human` rather than dispatched to a model. Reviews are
  counted under the trust rules landing in W1.1; there is no blanket
  `awaiting` premise. A human hand-merge after full gates is recorded as an
  intervention, not as automated processing. Adopt automation-authored-PR
  conventions (title prefix, distinguishing label) so shared-account work
  stays attributable.
- Why: a single identity does not make every review irrelevant, and the
  disabled conflict stage is a deliberate safety policy rather than a
  credential or configuration failure. The operator must judge the
  no-privileged-reviewer condition and record any intervention.
- Enforcement: `manual:` — the operator's review and hand-merge log in the
  evidence log (`SELF-HOSTING.md`, per "The evidence convention" below); no
  workflow can enforce a human's judgment.

### Secret step-scoping

- Rule: no credential reaches `pnpm install`'s lifecycle scripts; the App
  private key is confined to the mint step (`private-key`), each minted token
  to its run step — and each presence is handled honestly before any effect
  (the review loop's minted token asserts and refuses; `self-merge-prs`'s
  asserts and skips).
- Why: the run step executes repo code; a credential that rode an earlier
  step's lifecycle scripts could leak into execution the review never saw.
- Enforcement: the workflow YAML structure itself — each workflow mints in
  its own step and the minted token is a step-scoped `env:` key on the run
  step only, and each run block opens with its `test -n` presence check.

## The evidence convention

Record self-hosting evidence in an evidence log at the repo root (this
repository's instantiation: `SELF-HOSTING.md`): the soak counter and its
acceptance criterion, the queue-promotion table, ratchet self-evidence, the
automation-authored-PR table, and the hand-merge log. Every entry is two
links — the PR URL and the workflow run URL; an entry without both is a
claim, not evidence.
