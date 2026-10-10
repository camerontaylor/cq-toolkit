# policy/templates/self-host — self-hosted automation templates

Adoptable templates for the self-hosting switch: the toolkit running on the
repository that ships it. Two scheduled workflows turn the toolkit's own
review loop and governed merge dispatch into standing automation against an
adopting repo's own open PRs — the same surfaces this repository instantiates
in its own `.github/workflows/`.

## Files

| file                   | what it is                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self-review-loop.yml` | scheduled review-loop automation: runs `runReviewLoop` from source over every open, same-repo, non-draft PR — fetch, classify, respond, resolve               |
| `self-merge-prs.yml`   | scheduled merge-dispatch automation: classifies open PRs and executes eligible merges through the governed kernel (BudgetGovernor → runPlan → withBudgetStop) |
| `README.md`            | this guide                                                                                                                                                    |

## Wiring an adopting repo

1. Instantiate both templates (see "Placeholder tokens" below and each
   template's header), drop the results into `.github/workflows/`, and keep
   the `# instantiated from policy/templates/self-host/... — edit the
template, not this file` provenance header.
2. Build from source: both workflows run `pnpm install --frozen-lockfile`
   then `pnpm run build` and invoke the built entries — the adoption is the SOURCE, never a published
   tarball.
3. Configure the two secrets (below) and confirm the driver binding in
   `src/selfhost/config.ts` (`SelfhostDefaults`) names YOUR provider and its
   served model id — this repo's instantiation uses the ai-sdk route against
   the Z.AI GLM coding endpoint with the served id `glm-5.3-flash`.
4. Hand-replace the cron window (below) with your provider's off-peak window.

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

## Required secrets

Names only in the templates — values live in the adopting repo's
`automation` environment (a main-only deployment branch policy, W1.10
Decision 8): the jobs that read them declare `environment: automation`, so a
dispatch from any other ref fails at job admission, before a secret is
exposed.

| token                     | secret holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{{SELFHOST_TOKEN}}`      | the loop's GitHub credential. Recommended END STATE: the registered automation GitHub App's installation token (this repository's App: cq-automation) — but see the identity note below: a static installation-token secret does not support the schedule without a refresh path. Working identity until then: a fine-grained PAT scoped to the TARGET REPOSITORY ONLY, permissions limited to what the automation does — read PRs, post review replies + resolve threads, merge PRs (labels: Pull requests read/write; Contents write for the review-fix push path and the `cq-state` settle-state branch). Referenced by the workflows as `GH_TOKEN` (gh). |
| `{{SELFHOST_DRIVER_KEY}}` | the model provider API key driving review-loop fix workers through the ai-sdk route. Self-host merge conflict resolution is disabled; DIRTY candidates are reported as needs-human.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Both are step-scoped in the workflows: they reach only the run step, never
`pnpm install`'s lifecycle scripts. A missing `{{SELFHOST_TOKEN}}` makes these
non-required automation jobs skip successfully; required I4 checks are separate
and never use this optional skip. A classic PAT with the blanket `repo` scope is the
last-resort FALLBACK — it reaches every repo the account can touch, so grant
it only where fine-grained PATs are unavailable.

### The loop's identity: the App is the end state, the PAT is the working identity

The recommended END STATE for the `{{SELFHOST_TOKEN}}` value is the
registered automation GitHub App's installation token (this repository's
App: cq-automation), not a human or role PAT: an App identity keeps the
loop's replies, reviews and fix pushes attributable and review-independent
(doctrine I2), revokes independently of every human credential, and avoids
a long-lived repo-scope secret. But installation tokens are short-lived,
and the workflow consumes `GH_TOKEN` directly per run with nothing to
re-mint — a STATIC installation-token secret does NOT support ongoing
scheduled runs. The App identity therefore REQUIRES a refresh path:

- an external process (cron/hook) re-mints the installation token and
  updates the `automation` environment secret before each expiry, or
- the workflow mints its own token per run — a separately scoped BEHAVIOR
  change (new steps/permissions in the privileged job), explicitly out of
  scope for now.

Until one exists, the WORKING identity is the long-lived PAT — prefer the
fine-grained, target-repository-only PAT described in the table above; the
classic blanket-`repo` PAT stays the last-resort fallback. That trades the
I2/attribution and revocability benefits above, and the `GH_TOKEN` env
indirection is what lets either identity drive the same code.

## Standing requirements (Rule / Why / Enforcement)

Every standing requirement of the automation, with its enforcing artifact
named. A requirement no automation enforces is marked `manual:` — the
adopter owns it by hand.

### The cron window

- Rule: schedule starts only OUTSIDE your model provider's peak window
  **and the preceding run headroom**. Subtract the job timeout or documented
  maximum run duration from the peak start. Align the cron expressions and
  run-step guard to those bounds; refuse delayed or manual starts inside
  them, exiting 0 as an honest no-op.
- Why: this repo's review loop excludes the 06:00–10:00 UTC Monday–Friday
  Z.ai GLM peak (14:00–18:00 Asia/Singapore, ~3x quota consumption).
  Its documented ≤20-minute run reserves 20 minutes before 06:00, so starts
  from **05:40 inclusive to 10:00 exclusive** are refused on weekdays.
  The three crons are `*/15 0-4,10-23 * * 1-5`, `0,15,30 5 * * 1-5`, and
  `*/15 * * * 0,6`: the final pre-peak weekday slot is 05:30, weekdays resume
  at 10:00, and weekends run all day. The merge-dispatch sibling still
  carries the older, narrower 15:00–01:00 UTC window and is out of scope.
- Enforcement: the review-loop template's three literal cron expressions
  plus its fail-closed UTC weekday/time guard enforce the same start
  exclusion for scheduled, delayed, and manual fires. Adopters must change
  provider peak, run headroom, cron, and guard together — `manual:`.

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
  `{{SELFHOST_TOKEN}}` needs Contents write to update `cq-state`.
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

- Rule: both secrets reach ONLY the run step — never `pnpm install`'s lifecycle
  scripts — and their presence is asserted before any effect.
- Why: the run step executes repo code; a credential that rode an earlier
  step's lifecycle scripts could leak into execution the review never saw.
- Enforcement: the workflow YAML structure itself — secrets are step-scoped
  `env:` keys on the run step only, and each run block opens with its
  `test -n` presence asserts.

## The evidence convention

Record self-hosting evidence in an evidence log at the repo root (this
repository's instantiation: `SELF-HOSTING.md`): the soak counter and its
acceptance criterion, the queue-promotion table, ratchet self-evidence, the
automation-authored-PR table, and the hand-merge log. Every entry is two
links — the PR URL and the workflow run URL; an entry without both is a
claim, not evidence.
