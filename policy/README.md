# policy — adoptable merge-queue doctrine and quality ratchets

`policy/` ships the toolkit's own policy as adoptable text: the eleven
behavioral invariants, parameterized workflow templates for the merge-queue
mechanics and required checks, the ratchet (monotonic baseline) pattern, and
the denylist that keeps must-never-publish content out. Nothing here is
toolkit-specific by construction — another repository can take the templates
whole or in part.

This file is the adoption path. [`policy/templates/README.md`](templates/README.md)
is the token-level reference and the single source of truth for the workflow
files themselves.

## What is here

- [`DOCTRINE.md`](DOCTRINE.md) — invariants I1–I11, canonical, each with its
  Rule, Why, and Enforcement. Adopt it as your policy text; the Enforcement
  column names the mechanism that makes each one mechanical.
- [`templates/`](templates/) — the merge-queue workflow templates plus the
  required-check, affected-tests, and ratchet patterns. `templates/README.md`
  carries the `{{TOKEN}}` table and the instantiation mechanics.
- [`denylist/patterns.yml`](denylist/patterns.yml) — the must-never-publish
  content classes (the corpus), consumed by `scripts/denylist-scan` to police
  the tree, the pack audit, and the I4 trigger rule.
- `baselines/` (repository root) — the committed per-`(target, metric)`
  ratchet baselines, one schemaVersion-1 JSON file each, written by
  `ratchet.captureBaseline`.

## Adopting the workflow templates

1. **Copy the templates into your repo.** Keep the `policy/templates/`
   directory as the single source of truth; the instantiated workflows live in
   `.github/workflows/`.
2. **Instantiate one template at a time.** Replace every literal `{{TOKEN}}`
   with its value per the table in [`templates/README.md`](templates/README.md)
   (runner label, Node version, install command, required-check names, secret
   _names_ — never values), then drop the result unchanged into
   `.github/workflows/` with the provenance header
   (`# instantiated from policy/templates/<file> — edit the template, not this file`).
   The `{{COMMANDS...}}` slot in `required-check.md` is hand-replaced with your
   own ordered run-steps; no placeholder is substituted there.
3. **Register every required check in all three places** — they are unlinked,
   and updating fewer than all three leaves the check advisory or dangles a
   branch-protection wait:
   - `REQUIRED_WORKFLOW_CHECKS` in `scripts/denylist-scan` (the I4 policy
     data: workflow file ↔ producing job name),
   - the gate's wait list (`{{GATE_CHECKS}}` in `merge-queue-gate.yml`),
   - branch protection required status contexts on **both** branches
     (`merge-queue` and `main`).
4. **Never edit an instantiated workflow directly.** Edit the template and
   re-instantiate — the bootstrap rule in `templates/README.md` is what keeps
   the repo from drifting from its own policy.
5. **Configure repo settings the templates cannot.** Disable squash and
   rebase merges (I3 is merge-commits-only); branch protection and the
   promote PAT are out-of-band by design.

The template files, in dependency order: `init-merge-queue.yml` (bootstrap the
queue branch), `merge-queue-gate.yml` (the only component that advances
`main`, behind the required-check wait and merge-base guards),
`sync-merge-queue.yml` (keep the branches level, never write `main`),
`required-check.md` (the I4 pattern), `affected-tests.md` (reduced-test
selection and its blind spot), `ratchet.yml` + `ratchet-propose.yml` (the
baseline ratchet), `live-merge.yml` (the live drill), and `self-host/` (the
scheduled review-loop and merge-prs automation).

## Adopting the ratchets (I5)

The ratchet is monotonic: a metric count may only go down, and a raising
edit is not a ratchet. A missing metrics summary is non-passing evidence,
never a pass.

- **Baselines live in `baselines/`**, one schemaVersion-1 file per
  `(target, metric)`, e.g. `typecheck--typecheck-count--<hash>.json` and
  `coverage--coverage--<hash>.json`, written by the `ratchet.captureBaseline`
  op. Baseline persistence belongs to the engine, never to the check that
  judges with it.
- **The required `ratchet` check** (`ratchet.yml`) runs the live
  `ratchet.checkRatchet` metrics and, on pull requests, the
  `ratchet.monotonicGuard` diff guard. A failing verdict is the op's _data_
  (the CLI exits 0), so the workflow asserts the verdict explicitly — a
  green no-op is impossible.
- **Tightening proposals** (`ratchet-propose.yml`) run after a merge to
  `main`, measure the live metrics against the committed baselines, and open
  exactly one idempotent proposal PR per improvement set. They need an
  automation token (`CQ_AUTOMATION_TOKEN` here): without it the job is a
  logged green no-op, because a `GITHUB_TOKEN`-authored PR would suppress the
  required check's own run.
- **Local drivers**: `scripts/ratchet-typecheck.mjs` (also the
  `check:static` gate) and `scripts/ratchet-check.mjs` drive the same engine
  the CLI subcommands expose.

To adopt: commit your own `baselines/` files (capture a first reading with
`ratchet.captureBaseline`), instantiate `ratchet.yml` and, if you want
post-merge proposals, `ratchet-propose.yml`, then register `ratchet` in the
three places above.

## Adopting the denylist and the I4 self-test

`policy/denylist/patterns.yml` is the pattern source: gitleaks is overlaid
with your classes, and `scripts/denylist-scan` runs the scan plus a
`--self-test` that proves every class is non-vacuous and the clean probes stay
clean. Add classes for your own must-never-publish strings (internal
hostnames, client names, key material, personal paths). The scan allowlists
the patterns file itself — it is the corpus, not a violation. The same script
enforces I4 over `REQUIRED_WORKFLOW_CHECKS`: every required workflow must
exist, declare its paired job, and carry unfiltered `push` and `pull_request`
triggers.

## This repository as the worked example

This repo instantiates its own templates: `.github/workflows/ci.yml` is
`required-check.md` instantiated, the queue workflows are the three queue
templates, the ratchet workflows are `ratchet.yml` + `ratchet-propose.yml`,
and `denylist.yml` (which predates the templates) carries the required-check
trigger shape with a provenance pointer. The generated per-op reference under
[`docs/ops/`](../docs/ops/) is regenerated by the required `static` job, which
fails on drift — the same "generated artifacts never drift from their source"
discipline the templates apply to workflows.
