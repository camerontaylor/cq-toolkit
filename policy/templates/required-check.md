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
same happens if the required job is renamed, or given a job-level `name:`
that differs from the required check name: GitHub reports the check run
under the new name and the required context never arrives. Review catches
both; nothing polices them mechanically. Checkouts in required-check jobs are pinned to immutable commit SHAs
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

`test:unit` is the exception among those seven steps. It is about 90% of the
gate's wall time and runs with `fileParallelism: false` because the process
tests carry real startup deadlines, so this repo hedges it into four separate
runners: the `unit` matrix job runs `vitest --shard=i/4`, and the required
`static` job calls the composite with `unit: skip` and waits for all four. The
check name (`static`) and its job id do not change; a red shard makes `static`
red. The macOS venue calls the composite without the input, so its non-required
mirror still runs the suite whole, as one serial run.

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

# Invariant I4: keep required-workflow triggers unfiltered. Job-level
# selection runs every PR (including forks) and main pushes, avoiding
# duplicate suites on feature pushes. cq-state is a machine ledger.
on:
  push:
  pull_request:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

# Cancel obsolete PR updates only. Every push gets a unique group, avoiding
# case-insensitive ref/expression collisions; default-branch pushes all finish.
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

permissions:
  contents: read

# pnpm-workspace.yaml's global virtual store is a local-worktree speedup
# only: CI installs a conventional per-project node_modules, so no step
# inherits pnpm's NODE_PATH/NODE_OPTIONS resolve hook for shared stores.
env:
  PNPM_CONFIG_VIRTUAL_STORE_TYPE: project

jobs:
  changes:
    runs-on: {{RUNNER}}
    if: ${{ github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) }}
    outputs:
      typescript: ${{ steps.select.outputs.typescript }}
      python: ${{ steps.select.outputs.python }}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          package-manager-cache: false
          node-version: {{NODE_VERSION}}
      - name: Select coarse checks (failure falls back to full)
        id: select
        env:
          CHANGE_BASE: ${{ github.event.pull_request.base.sha }}
          CHANGE_HEAD: ${{ github.event.pull_request.head.sha }}
        run: node scripts/ci-select-checks.mjs
  crq-python:
    runs-on: {{RUNNER}}
    needs: changes
    if: ${{ always() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch))) && (needs.changes.result != 'success' || needs.changes.outputs.python != 'false') }}
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Set up production Python minor
        uses: actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6
        with:
          python-version: '3.14'
      - name: Python stdlib suite
        working-directory: apps/crq-python
        run: python3 -m unittest discover -p 'test_*.py'
      - name: Verify Python vector bytes
        run: python3 apps/crq-python/vector_emit.py --check
      - name: Set up pnpm
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: {{NODE_VERSION}}
          cache: pnpm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      - name: Compare TypeScript with Python vectors
        run: pnpm exec vitest run --project pure test/policy/crq/vectors.test.ts
  # The unit suite is the bulk of the static gate (about 20 minutes of the 23),
  # and it runs with fileParallelism: false because the process tests have real
  # startup deadlines. Four separate runners do not compete for those budgets,
  # so the suite runs as one matrix job with four vitest shards. `static` still
  # needs this job: a red shard is a red run, and the required check name and its
  # job id do not change. The composite action skips its own unit step when
  # `static` calls it with `unit: skip`; the macOS venue still runs it whole.
  unit:
    runs-on: {{RUNNER}}
    # Same event and coarse-selection guards as `static`. always() keeps the
    # full suite (rather than a skip) when the `changes` job failed.
    needs: changes
    if: ${{ always() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch))) && (needs.changes.result != 'success' || needs.changes.outputs.typescript != 'false') }}
    # Fail-fast false: every shard reports, so a red run names all failing
    # shards instead of the first one to finish. (Slice 3 adds per-shard
    # job-level concurrency here; it is deliberately not in this change.)
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - name: Check out the repo
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Set up pnpm (version from package.json packageManager)
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: {{NODE_VERSION}}
          cache: pnpm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      # The unit suite runs outside the static-gate composite, so it must
      # install the same harness dependency the composite's first step does.
      # Without real ripgrep the search-tool tests fail on CI by design
      # (test/driver/ai-sdk.rg-floor.test.ts refuses to skip).
      - name: Install ripgrep for harness search tools
        uses: ./.github/actions/install-ripgrep
      # pnpm forwards the flag verbatim; do not add `--` (pnpm 12 forwards a
      # literal `--`, which vitest reads as end-of-options). Vitest shards the
      # selection by hashing each test file's path, so the four shards are
      # disjoint and exhaustive.
      - name: Test unit (shard ${{ matrix.shard }}/4)
        run: pnpm run test:unit --shard=${{ matrix.shard }}/4
  static:
    runs-on: {{RUNNER}}
    # Every PR, default-branch push, nightly and manual full run. It now also
    # waits for the four unit shards: this job id is the required context, so
    # the aggregation must happen here and nowhere else.
    needs: [changes, unit]
    # Fail-closed. A skipped job counts as a SUCCESS for GitHub's required
    # checks, so `static` must never be skipped on a pull request: when a
    # shard is cancelled here, static runs and the first step below fails it.
    # Only a default-branch push may skip static, and only when its shards
    # were cancelled as superseded (slice 3), so that commit claims nothing.
    if: ${{ always() && !cancelled() && (needs.unit.result != 'cancelled' || github.event_name == 'pull_request') && (github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch))) }}
    steps:
      - name: Unit shards passed
        if: ${{ needs.unit.result == 'failure' || (github.event_name == 'pull_request' && needs.unit.result == 'cancelled') || needs.changes.result == 'cancelled' }}
        shell: bash
        run: exit 1
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
      # action is read from the checked-out workspace. `test:unit` was most of
      # the gate's wall time; it runs in the four `unit` shard jobs above, so
      # this call skips the composite's own copy of it.
      - name: Check formatting (prose/Python only)
        if: ${{ needs.changes.result == 'success' && needs.changes.outputs.typescript == 'false' }}
        run: pnpm run format:check
      - name: Static gate steps (.github/actions/static-gate)
        if: ${{ (needs.changes.result != 'success' || needs.changes.outputs.typescript != 'false') }}
        uses: ./.github/actions/static-gate
        with:
          # The four unit shards already ran the suite; running it again here
          # would double the cost and hide which shard failed.
          unit: skip

  # Stage-1 self-hosting (T1.7 / ws-k stage 1 item 6): CI runs the toolkit
  # FROM SOURCE — the built artifact drives a real governed plan (two jobs
  # through the subprocess driver and the fake agent CLI fixture) and the
  # script asserts the report shape, the journal evidence, and the I1 output
  # contract. A companion job, not a required check (the required checks
  # are `static` here and `denylist` in denylist.yml), so this job's
  # presence cannot dangle a branch-protection wait.
  from-source:
    runs-on: {{RUNNER}}
    # Match static event selection, with coarse PR ownership.
    needs: changes
    if: ${{ always() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch))) && (needs.changes.result != 'success' || needs.changes.outputs.typescript != 'false') }}
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
must run the same gate — then make the resulting job id (the check name) a
required status check on the default branch.

A portable (macOS) venue is a separate, non-required workflow file that is
NOT listed in the gate's verified workflows; keep it that way until a pilot
says otherwise, and promote it in one change across every declaration of
the required set (including the gate's workflow list). A job added to the
verified workflow without that discipline is a required wait.
