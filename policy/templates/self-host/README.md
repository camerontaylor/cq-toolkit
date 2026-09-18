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

| token                     | secret holds                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{SELFHOST_TOKEN}}`      | a PAT with repo scope on the target repo: read PRs, post review replies, resolve threads, merge. Referenced by the workflows as `GH_TOKEN` (gh).   |
| `{{SELFHOST_DRIVER_KEY}}` | the model provider API key driving every agent dispatch (the review loop's fix workers; the merge path's conflict agent) through the ai-sdk route. |

Both are step-scoped in the workflows: they reach only the run step, never
`npm ci`'s lifecycle scripts, and their presence is asserted before any
effect. Prefer the least-privileged PAT that still covers the four abilities
above.

## The cron window rule

Schedule automation inside your model provider's off-peak window; this
repo's instantiation uses 15:00–01:00 UTC (23:00–09:00 Asia/Singapore),
which idles across the Z.AI GLM peak-hour window (14:00–18:00
Asia/Singapore, where quota consumption multiplies ~3x). Keep the two-cron
shape — one cron for the window's full hours, one for its final partial
hour — and keep the last fire strictly BEFORE the window's end: the window
end is a hard stop and no operation may be initiated at or after it.

## Budget caps and the wall-clock ladder

Scheduled runs carry `--max-usd` (default `SelfhostDefaults.maxUsd`, 1 USD):
the budget cap is an honest stop (I9) — the governor halts the run when the
derived cost rollup crosses it and the run reports `stoppedEarly` rather
than pretending to have finished. The merge path also arms the governor's
wall-clock ladder (`SelfhostDefaults.perJobWallClockMs`, 5 minutes —
review-debt #137's arming): a wedged conflict-agent or fix-worker job is
escalated instead of stalling the scheduled slot forever. Each slot gets ONE
run of at most 20 minutes (`timeout-minutes: 20`); the next scheduled slot
re-enters with the persisted journal.

## The single-identity caveat (I2)

Until the adopting repo runs a SECOND identity, all automation replies,
resolutions, and merges happen as one shared account — there is no
independent reviewer of automation's work (I2's no-privileged-reviewer
acceptance is degraded, and this is a recorded deviation, not a
configuration error). Practically: every automation-eligible PR classifies
`awaiting`, and a human lane leader hand-merges it after full gates. A
hand-merge under this deviation is recorded processing, not an intervention
failure — a silent stall is the failure mode. Adopt automation-authored-PR
conventions (title prefix, distinguishing label) so the shared account's
work stays attributable.

## The evidence convention

Record self-hosting evidence in an evidence log at the repo root (this
repository's instantiation: `SELF-HOSTING.md`): the soak counter and its
acceptance criterion, the queue-promotion table, ratchet self-evidence, the
automation-authored-PR table, and the hand-merge log. Every entry is two
links — the PR URL and the workflow run URL; an entry without both is a
claim, not evidence.
