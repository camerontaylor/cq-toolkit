# The required-check pattern (invariant I4)

## The rule

A required check must report a status on EVERY pull request. Therefore the
workflow behind a required check never filters its triggers: no `paths`, no
`paths-ignore`, no `branches`/`branches-ignore`, no `tags`/`tags-ignore` —
nothing that could leave a PR without a status from this workflow. The only
sanctioned skip mechanism is a job-level `if:`; when in doubt, use not even
that.

## Why

A filtered trigger means the workflow simply does not run for some PRs — a
docs-only PR, say. The required check then never reports, GitHub waits
forever, and the PR hangs unmergeable with no red check to point at: the
check is silently absent, which is much worse than a failing check. The
self-test in `scripts/denylist-scan` enforces this mechanically: every
entry in `REQUIRED_WORKFLOW_CHECKS` (each pairing a required workflow file
with the check name of the job that must produce it) must exist, declare a
job with exactly that paired name, and carry both `push` and `pull_request`
in its top-level `on:` block with zero filter keys inside that block
(fail-closed on an empty or malformed list or a missing listed file). The
leg also fails a required workflow whose paired job carries a job-level
`name:` override that differs from the paired check name: GitHub reports a
job's check run under the `name:` when one is set, so a rename there
silently orphans the required context while every id-keyed check stays
green. Checkouts in required-check jobs are pinned to immutable commit SHAs
and set `persist-credentials: false` — they run repo code and never push.

## Worked example — this repo's static job, plus its from-source companion

`{{RUNNER}}`, `{{NODE_VERSION}}`, and `{{INSTALL_CMD}}` are the
instantiation tokens; the five command steps below are this repo's
`{{COMMANDS...}}` slot — the static gate (TS7 compiler ratchet and typed Oxlint), then
format check, test, Knip, build. This repo's `.github/workflows/ci.yml` IS this template
instantiated — nothing hand-carried; regenerate it by substituting the
tokens (`ubuntu-latest`, `24`, `npm ci`) and adding the provenance header.
The `from-source` companion job below mirrors ci.yml's second job exactly
(tokens swapped) so a regeneration carries it instead of silently dropping
it; it is deliberately not a required check — see its comment.

```yaml
name: ci

# Invariant I4: required checks never get paths-ignore — nor any path, branch,
# or tag filter at all. This workflow triggers on every push and on every
# pull_request, without exception. Skips, if ever needed, belong in job-level
# `if:` conditions only; no `if:` is needed here.
on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  static:
    runs-on: {{RUNNER}}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0 (immutable commit pin; repo policy)
        with:
          # npm runs repo code below, so the checkout token must not
          # survive checkout (persist-credentials: false).
          persist-credentials: false
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0 (immutable commit pin; repo policy)
        with:
          node-version: {{NODE_VERSION}}
          cache: npm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      # One compiler ratchet plus typed lint; aliases must not duplicate it.
      - name: Static gate
        run: npm run check:static
      - name: Check formatting
        run: npm run format:check
      - name: Test
        run: npm run test
      - name: Check unused files and dependencies
        run: npm run knip
      # Emit gate: the ratchet step above is the typecheck gate; this step
      # emits dist/ and recompiles (checked emit, no --noCheck) — the
      # deliberate, boring-safe choice.
      - name: Build
        run: npm run build

  # Stage-1 self-hosting (T1.7 / ws-k stage 1 item 6): CI runs the toolkit
  # FROM SOURCE — the built artifact drives a real governed plan (two jobs
  # through the subprocess driver and the fake agent CLI fixture) and the
  # script asserts the report shape, the journal evidence, and the I1 output
  # contract. A companion job, not a required check: REQUIRED_WORKFLOW_CHECKS
  # in scripts/denylist-scan stays {denylist.yml: denylist, ci.yml: static},
  # so this job's presence cannot dangle a branch-protection wait.
  from-source:
    runs-on: {{RUNNER}}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0 (immutable commit pin; repo policy)
        with:
          # npm runs repo code below, so the checkout token must not
          # survive checkout (persist-credentials: false).
          persist-credentials: false
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0 (immutable commit pin; repo policy)
        with:
          node-version: {{NODE_VERSION}}
          cache: npm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      # The smoke imports the BUILT barrel (dist/index.js) — emitting dist/
      # is the from-source point, so build runs unconditionally here (the
      # static job's build above is its own job's emit gate).
      - name: Build
        run: npm run build
      - name: From-source smoke (real governed plan through dist/)
        run: node scripts/smoke-run-plan.mjs
```

When adopting for another repository: keep the `on:` block and the
permissions shape exactly as shown, swap the tokens, and replace the five
command steps with your own `{{COMMANDS...}}` — then add the resulting
workflow's file name and job id (the check name) as a pair in
`REQUIRED_WORKFLOW_CHECKS` so the I4 self-test polices it.
