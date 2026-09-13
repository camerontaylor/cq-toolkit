# The affected-tests pattern

Pattern: available for instantiation from phase 1; this repo currently runs
the full suite everywhere (the suite is seconds-sized, so selection buys
nothing yet).

## The idea

Per-PR reduced test selection: detect the PR's changed files, map them to
the tests that own or import them, and run only that reduced set. On a
repo where the full suite takes minutes, this turns every docs-only PR
into a seconds-sized verification and every scoped change into a partial
run proportional to the diff.

## The blind spot

Selection is only as good as the map from changed files to tests. Runtime
dependencies that are invisible to the module graph — dynamic imports,
fixture coupling, global setup, behavior fixed by config or data files —
mean a change can break a test that no file-graph mapping would select.
That is why the full suite on merge-queue pushes is the safety net: by the
time a commit reaches the queue branch, everything runs against it before
promotion. Reduced selection is a per-PR convenience; the queue is where
completeness lives.

## The I4 interplay

A reduced-selection job must NEVER be the required check itself unless
paired with an unfiltered fallback reporting the same check name: a
required check that skips PRs by construction (I4: no status means the PR
hangs unmergeable) is exactly the failure mode the required-check pattern
forbids. Either keep the affected job as a non-required advisory, or make
its job body always report — running zero selected tests to a green
conclusion when nothing maps — and keep an unfiltered full-suite workflow
as the actual required check.

## Worked example — single-package TypeScript repo

Changed-file detection via `git diff --name-only` against the PR base,
`vitest related --run` for the reduction, and the full-suite fallback step
when the selection comes up empty (so the job always reports a real result;
see the I4 interplay above):

```yaml
  affected-tests:
    # Advisory by design — not a required check (see the I4 interplay). If
    # it ever becomes required, pair it with an unfiltered fallback that
    # reports on every PR.
    runs-on: {{RUNNER}}
    steps:
      - name: Check out the repo (full history)
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Set up Node {{NODE_VERSION}}
        uses: actions/setup-node@v5
        with:
          node-version: {{NODE_VERSION}}
          cache: npm
      - name: Install dependencies
        run: {{INSTALL_CMD}}
      - name: Detect changed files against the PR base
        run: |
          set -euo pipefail
          git fetch origin "${{ github.event.pull_request.base.sha }}"
          git diff --name-only \
            "${{ github.event.pull_request.base.sha }}" \
            "${{ github.event.pull_request.head.sha }}" \
            > "${RUNNER_TEMP}/changed.txt"
          cat "${RUNNER_TEMP}/changed.txt"
      - name: Run affected tests (vitest related)
        run: |
          set -euo pipefail
          if [ -s "${RUNNER_TEMP}/changed.txt" ]; then
            # shellcheck disable=SC2046
            npx vitest related --run $(cat "${RUNNER_TEMP}/changed.txt")
          else
            echo "no changed files selected — falling back to the full suite"
            npm run test
          fi
```

On merge-queue pushes, the same repo runs the full suite unconditionally —
that job (not this one) is the safety net the blind spot section requires.
