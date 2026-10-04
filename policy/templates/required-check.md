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

## Worked example — this repo's static job plus its from-source companion

`{{RUNNER}}`, `{{NODE_VERSION}}`, and `{{INSTALL_CMD}}`
are the instantiation tokens; the static job's last step, the call to the
local action `./.github/actions/static-gate`, is this repo's `{{COMMANDS...}}`
slot. That repo-owned composite action holds the seven command steps — the
static gate (TS7 compiler ratchet and typed Oxlint), then format check,
`test:unit`, `test:e2e`, Knip, build, and the generated-op-docs drift
check — as the ONE definition the macOS venue below shares. It is not a
template: it runs this package's own scripts. This repo's
`.github/workflows/ci.yml` IS this template
instantiated — nothing hand-carried; regenerate it by substituting the
tokens (`ubuntu-latest`, `24`, `pnpm install --frozen-lockfile`) and adding the
provenance header. Substitution is literal per token, so the instance is
byte-for-byte the fenced block below once the header line is prepended.
The `from-source` companion job below mirrors ci.yml's second job exactly
(tokens swapped) so a regeneration carries it instead of silently dropping
it; it is deliberately not a required check — see its comment.

### The macOS venue is a separate workflow, on purpose

This repo's non-required macOS full-gate mirror (`static-macos`) lives in
its own workflow file, `.github/workflows/macos-venue.yml` (repo-owned,
listed under `nonTemplated` in `instances.json`), not in this template. It
runs the same `./.github/actions/static-gate` action as the static job
(with inputs for its vitest JSON timing reports), so the mirror is the
static gate by construction, not by hand-kept copy.
The promotion gate reads `ci.yml` by workflow path and requires the whole
run — every job in it — to have succeeded on the tip (`gate.yml`
`--verifiedWorkflows`, `checkVerifiedRun`). A job inside `ci.yml` is
therefore a required wait no matter which check-name lists omit it: a
macOS-only failure or timeout would block promotion. A job in a workflow
outside the verified list cannot.

```yaml
name: ci

# Invariant I4: required checks never get paths-ignore — nor any path, branch,
# or tag filter at all. This workflow triggers on every push and on every
# pull_request, without exception. Skips belong in job-level `if:` conditions
# only; the one sanctioned skip below is the `cq-state` settle-ledger branch
# (review-debt #226): a machine-written ledger push carries no reviewable
# change, so running the suite on it only burns runners. The trigger surface
# itself stays unfiltered — a skipped job on an unprotected branch has no
# merge consequence.
on:
  push:
  pull_request:

permissions:
  contents: read

# pnpm-workspace.yaml's global virtual store is a local-worktree speedup
# only: CI installs a conventional per-project node_modules, so no step
# inherits pnpm's NODE_PATH/NODE_OPTIONS resolve hook for shared stores.
env:
  PNPM_CONFIG_VIRTUAL_STORE_TYPE: project

jobs:
  static:
    runs-on: {{RUNNER}}
    # The `cq-state` settle ledger is machine-written (selfhost settle-state);
    # its pushes are not reviewable changes (review-debt #226). Job-level,
    # never a trigger filter — I4 keeps the trigger surface intact.
    if: ${{ github.ref != 'refs/heads/cq-state' }}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0 (immutable commit pin; repo policy)
        with:
          # pnpm runs repo code below, so the checkout token must not
          # survive checkout (persist-credentials: false).
          persist-credentials: false
      - name: Set up pnpm (version from package.json packageManager)
        # v6.1.0, immutable commit pin (repo policy)
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0 (immutable commit pin; repo policy)
        with:
          node-version: {{NODE_VERSION}}
          cache: pnpm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      # The hand-replaced COMMANDS slot: the static gate's seven command
      # steps live in ONE repo-owned composite action, shared with the
      # macOS venue's static-macos mirror (macos-venue.yml), so the two run
      # one step list. Checkout, toolchain and install stay above: a local
      # action is read from the checked-out workspace.
      - name: Static gate steps (.github/actions/static-gate)
        uses: ./.github/actions/static-gate

  # Stage-1 self-hosting (T1.7 / ws-k stage 1 item 6): CI runs the toolkit
  # FROM SOURCE — the built artifact drives a real governed plan (two jobs
  # through the subprocess driver and the fake agent CLI fixture) and the
  # script asserts the report shape, the journal evidence, and the I1 output
  # contract. A companion job, not a required check: REQUIRED_WORKFLOW_CHECKS
  # in scripts/denylist-scan stays {denylist.yml: denylist, ci.yml: static,
  # ratchet.yml: ratchet} (review-debt #120: the enumeration was stale
  # before the ratchet became a required check),
  # so this job's presence cannot dangle a branch-protection wait.
  from-source:
    runs-on: {{RUNNER}}
    # Same cq-state skip as the static job (review-debt #226): the ledger
    # push is not a reviewable change.
    if: ${{ github.ref != 'refs/heads/cq-state' }}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0 (immutable commit pin; repo policy)
        with:
          # pnpm runs repo code below, so the checkout token must not
          # survive checkout (persist-credentials: false).
          persist-credentials: false
      - name: Set up pnpm (version from package.json packageManager)
        # v6.1.0, immutable commit pin (repo policy)
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0 (immutable commit pin; repo policy)
        with:
          node-version: {{NODE_VERSION}}
          cache: pnpm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      # The smoke imports the BUILT barrel (dist/index.js) — emitting dist/
      # is the from-source point, so build runs unconditionally here (the
      # static job's build above is its own job's emit gate).
      - name: Build
        run: pnpm run build
      - name: From-source smoke (real governed plan through dist/)
        run: node scripts/smoke-run-plan.mjs
```

When adopting for another repository: keep the `on:` block and the
permissions shape exactly as shown, swap the tokens, and replace the
`./.github/actions/static-gate` step with your own `{{COMMANDS...}}` —
inline run-steps, or your own local composite action if a second venue
must run the same gate — then add the resulting
workflow's file name and job id (the check name) as a pair in
`REQUIRED_WORKFLOW_CHECKS` so the I4 self-test polices it.

A portable (macOS) venue is a separate, non-required workflow file that is
NOT listed in the gate's verified workflows; keep it that way until a pilot
says otherwise, and promote it in one change across every declaration of
the required set (including the gate's workflow list). A job added to the
verified workflow without that discipline is a required wait.
