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

## Worked example — this repo's static job, its macOS mirror, plus its from-source companion

`{{RUNNER}}`, `{{MACOS_RUNNER}}`, `{{NODE_VERSION}}`, and `{{INSTALL_CMD}}`
are the instantiation tokens; the seven command steps below are this repo's
`{{COMMANDS...}}` slot — the static gate (TS7 compiler ratchet and typed Oxlint), then
format check, `test:unit`, `test:e2e`, Knip, build, and the generated-op-docs drift
check. This repo's
`.github/workflows/ci.yml` IS this template
instantiated — nothing hand-carried; regenerate it by substituting the
tokens (`ubuntu-latest`, `macos-latest`, `24`, `npm ci`) and adding the
provenance header. Substitution is literal per token, so the instance is
byte-for-byte the fenced block below once the header line is prepended.
The `from-source` companion job below mirrors ci.yml's second job exactly
(tokens swapped) so a regeneration carries it instead of silently dropping
it; it is deliberately not a required check — see its comment.

### Two runners, two explicit job bodies — why not a matrix

The macOS job needs a runner the Linux job does not use, so a single
`{{RUNNER}}` slot cannot carry both, and the `{{COMMANDS...}}` slot is
hand-replaced anyway (no placeholder text is substituted). This template
therefore spells out **two job bodies** — `static` (Linux, required) and
`static-macos` (macOS, non-required) — each carrying the full command set,
with `{{RUNNER}}` and `{{MACOS_RUNNER}}` as the only difference between
them. A `strategy.matrix` over `runs-on` was rejected on purpose:

- a matrix reports one job whose name varies per leg (`static (ubuntu-latest)`),
  and GitHub reports a matrix job's check runs under the leg names — so a
  required matrix leg cannot be paired with a stable check name, and this
  template's own I4 pairing (workflow file + job id) is exactly a stable
  check name;
- a matrix collapses per-leg duration into one reported job, which is the
  per-OS timing this macOS leg exists to measure (`p90 <= 15 min`, `max < 20 min`);
- a shared matrix body makes the macOS-only reporter/upload steps of later
  revisions a conditional tangle, where a separate job is a plain
  step-level difference.

Instantiation stays deterministic either way (literal per-token
substitution); explicit bodies simply keep the check names stable and the
legs independently editable.

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
      # The split mirrors the two npm scripts (`test:unit` excludes the e2e
      # tree, `test:e2e` selects it), so a red unit run and a red e2e run
      # are two separate reports instead of one `npm run test` line.
      - name: Test unit
        run: npm run test:unit
      - name: Test e2e/acp
        run: npm run test:e2e
      - name: Check unused files and dependencies
        run: npm run knip
      # Emit gate: the ratchet step above is the typecheck gate; this step
      # emits dist/ and recompiles (checked emit, no --noCheck) — the
      # deliberate, boring-safe choice.
      - name: Build
        run: npm run build
      # Generated-artifact drift gate (ws-i scope item 5): the generator's
      # --check mode recomputes the per-op reference and fails on any drift
      # (missing, changed, or stale docs/ops/*.md) without writing. It reads
      # the BUILT registry, so this step follows the build above; its output
      # is deterministic (no timestamps, no absolute paths).
      - name: Check generated op docs
        run: npm run gen:op-docs:check

  # Portable-suite probe — the macOS gate venue, NON-REQUIRED. It runs the
  # SAME seven command steps as the static job above, on a macOS runner,
  # because a true full-gate mirror is the honest measurement: a
  # macOS-only failure in the compiler ratchet, the formatter, Knip, the
  # build or the generated-docs drift check is exactly as visible as a
  # macOS-only test failure. (The portable-suite criterion this job exists
  # to satisfy names `test:unit` and `test:e2e` specifically; narrowing the
  # job to just those two steps is part of the PROMOTION change below, not
  # of adding the venue.)
  #
  # NON-REQUIRED BY CONSTRUCTION. It is deliberately absent from
  # REQUIRED_WORKFLOW_CHECKS in scripts/denylist-scan, from
  # `requiredChecks` in policy/protected-paths.json, and from the ruleset
  # template policy/templates/github-settings.json, so no branch-protection
  # wait and no promotion-gate wait can key on a context this job produces.
  # Adding a context to one of those lists without the others is exactly
  # the four-way disagreement the promotion change must reconcile; adding
  # the job alone cannot dangle a wait.
  #
  # PROMOTION is a governed, outward-facing change and happens in ONE edit
  # across every declaration of the required set (this template,
  # protected-paths.json, denylist-scan's REQUIRED_WORKFLOW_CHECKS,
  # github-settings.json, the merge-queue-gate.yml template's check list,
  # and the live rulesets), gated on a 10-candidate pilot measured from the
  # merge of the suite's spawn-reduction work: p90 <= 15 min, max < 20 min
  # (the promotion gate's hard wait bound — see timeout-minutes below), and
  # zero infra-only failures. Any later breach demotes the job through the
  # same set of files, with the reason recorded. Runs before that merge are
  # BASELINE data, not pilot candidates.
  #
  # Queue time is expected and is NOT hidden here: macOS runner pools are
  # smaller than Linux's, so the wait counts toward time-to-verdict and is
  # recorded separately from run time by the baseline report. This job's
  # config says nothing about either number — it reports only its own run.
  static-macos:
    runs-on: {{MACOS_RUNNER}}
    # Same cq-state skip as the static job (review-debt #226): the ledger
    # push is not a reviewable change. Job-level, never a trigger filter.
    if: ${{ github.ref != 'refs/heads/cq-state' }}
    # The promotion gate refuses a candidate whose required checks have not
    # all reported within 20 minutes, so a PROMOTED macOS job must finish
    # under that bound: `max < 20 min` is a promotion test, not only
    # `p90 <= 15 min`. This is the documented ceiling — it reports a hang as
    # a red job with a timeout, it never converts a slow or failing run into
    # a pass.
    timeout-minutes: 20
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
      # Mirrored from the static job above, verbatim: the mirror is the
      # point, so an edit to one body's steps is an edit to both.
      - name: Static gate
        run: npm run check:static
      - name: Check formatting
        run: npm run format:check
      # Timing probe (baseline component A): this job alone also writes the
      # vitest JSON report (per-file durations) for each test invocation.
      # `--reporter=default` keeps the console output; `json` adds the file
      # (cac dot notation: `--outputFile.json=` targets only the json
      # reporter). The paths sit under $RUNNER_TEMP, outside the worktree, so
      # Knip and the build below never see them. `--coverage` stays OFF —
      # the ratchet is the instrumented Linux venue. These steps carry no
      # `if:`, exactly as in the static job: they remain the gate.
      - name: Test unit
        run: npm run test:unit -- --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/vitest-reports/vitest-unit.json"
      - name: Test e2e/acp
        run: npm run test:e2e -- --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/vitest-reports/vitest-e2e.json"
      - name: Check unused files and dependencies
        run: npm run knip
      - name: Build
        run: npm run build
      - name: Check generated op docs
        run: npm run gen:op-docs:check
      # The reporter writes in onFinished, so a red test run still leaves
      # both files. This step proves both exist and parse (it is what
      # catches a wrong reporter flag); it is a plain step, so it is skipped
      # after an earlier failure and never masks it.
      - name: Verify vitest JSON reports
        run: |
          for f in vitest-unit vitest-e2e; do
            node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$RUNNER_TEMP/vitest-reports/$f.json"
          done
      # Publishes whatever was written, even after a red run. Measurement
      # plumbing must not become a second gate: continue-on-error and
      # if-no-files-found: warn mean an upload problem can neither fail a
      # green job nor mask a red one. The baseline report (lane A) downloads
      # this artifact per run (`gh run download -n vitest-macos-<run_id>-<attempt>`)
      # and reads `testResults[].startTime/endTime` per file; name encodes
      # OS and run attempt so a re-run never collides.
      - name: Upload vitest JSON reports
        if: ${{ always() }}
        continue-on-error: true
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1 (immutable commit pin; repo policy)
        with:
          name: vitest-macos-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/vitest-reports/
          if-no-files-found: warn
          retention-days: 30

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
permissions shape exactly as shown, swap the tokens, and replace the seven
command steps with your own `{{COMMANDS...}}` — then add the resulting
workflow's file name and job id (the check name) as a pair in
`REQUIRED_WORKFLOW_CHECKS` so the I4 self-test polices it.

Drop the `static-macos` job entirely if you are not running a portable
venue. If you are, keep it non-required until a pilot says otherwise, and
promote it in one change across every declaration of the required set. A
job added here without that discipline is a job whose context nothing
declares — harmless, and useless: a check no gate waits for protects
nothing.
