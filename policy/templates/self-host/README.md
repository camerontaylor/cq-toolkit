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
2. Build from source: both workflows run `npm ci` then `npm run build` and
   invoke the built entries — the adoption is the SOURCE, never a published
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
Both entries print one compact JSON summary on stdout (the workflows tee it
to the run summary) and exit 0 with honest outcomes — per-PR failures and
needs-human rows are results, not crashes; only a whole-run throw (bad args,
a failed listing) exits 1.

## Required secrets

Names only in the templates — values live in the adopting repo's Actions
secrets.

| token                     | secret holds                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{{SELFHOST_TOKEN}}`      | a fine-grained PAT scoped to the TARGET REPOSITORY ONLY, permissions limited to what the automation does — read PRs, post review replies + resolve threads, merge PRs (labels: Pull requests read/write; Contents write for the review-fix push path). Referenced by the workflows as `GH_TOKEN` (gh). |
| `{{SELFHOST_DRIVER_KEY}}` | the model provider API key driving review-loop fix workers through the ai-sdk route. Self-host merge conflict resolution is disabled; DIRTY candidates are reported as needs-human.                                                                                                                    |

Both are step-scoped in the workflows: they reach only the run step, never
`npm ci`'s lifecycle scripts. A missing `{{SELFHOST_TOKEN}}` makes these
non-required automation jobs skip successfully; required I4 checks are separate
and never use this optional skip. A classic PAT with the blanket `repo` scope is the documented
FALLBACK, not the recommendation — it reaches every repo the account can
touch, so grant it only where fine-grained PATs are unavailable.

## Standing requirements (Rule / Why / Enforcement)

Every standing requirement of the automation, with its enforcing artifact
named. A requirement no automation enforces is marked `manual:` — the
adopter owns it by hand.

### The cron window

- Rule: schedule automation only inside your model provider's off-peak
  window, keep the two-cron shape — one cron for the window's full hours,
  one for its final partial hour — and keep the last fire strictly BEFORE
  the window's end: the window end is a hard stop and no operation may be
  initiated at or after it.
- Why: this repo's instantiation uses 15:00–01:00 UTC (23:00–09:00
  Asia/Singapore), which idles across the Z.AI GLM peak-hour window
  (14:00–18:00 Asia/Singapore), where quota consumption multiplies ~3x.
- Enforcement: the two literal cron expressions committed in each workflow
  (this repo's instantiations). Hand-replacing the window for an adopting
  provider is the adopter's own act and nothing checks it — `manual:`.

### Budget caps and the wall-clock ladder (I9)

- Rule: every scheduled run carries `--max-usd` (default
  `SelfhostDefaults.maxUsd`, 1 USD) as an honest stop — the governor halts
  the run when the derived cost rollup crosses it rather than pretending to
  have finished (a one-job merge plan shows the budget-exhausted job row —
  `stoppedEarly` stays false — and the loop path's per-PR governors surface
  the trip through the job row too); the merge path
  also arms the governor's wall-clock ladder
  (`SelfhostDefaults.perJobWallClockMs`, 5 minutes) so a wedged
  conflict-agent or fix-worker job is escalated instead of stalling the
  scheduled slot forever.
- Why: an uncapped scheduled dispatch spends without bound (I9), and a
  wedged job would eat the slot (review-debt #137's arming).
- Enforcement: the governor armed inside the entry modules —
  `src/selfhost/self-merge-prs.ts`'s `new BudgetGovernor(governorConfig(...))`
  construction over `runSelfMergePrs`'s runOptions (`buildRunInput` only
  prepares the plan input); the review loop's `runOptions` — from the frozen
  constants in `src/selfhost/config.ts`
  (`SelfhostDefaults.maxUsd`, `SelfhostDefaults.perJobWallClockMs`).

### One ≤20-minute slot per schedule fire

- Rule: each scheduled slot gets ONE run of at most 20 minutes; the next
  scheduled slot re-enters with the persisted journal.
- Why: the journal (dispatch logs, the conflict session store) is the
  cross-run memory — a slot that could run unbounded would duplicate or
  starve the slots after it.
- Enforcement: `timeout-minutes: 20` on the job in each workflow YAML.

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

- Rule: both secrets reach ONLY the run step — never `npm ci`'s lifecycle
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
