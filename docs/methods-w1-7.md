# W1.7 methods note

W1.7 restructures the ratchet's provenance per ADR-0004 (reconciled at G1, `bf5f540`):
definitions and verifier code come from a ref the PR cannot change, the head's measurement is
credential-free and treated as untrusted evidence, the baseline guard pairs every delete with
an add, coverage is kept to one decimal place, and ratchet-propose targets `merge-queue`.

## Code map (before W1.7, `5ba3a7a`)

| Module                                                   | Responsibility                                                                                                                                                                                                                                                            | Call sites                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/ops/ratchet/format.ts`                              | baseline schema, byte-deterministic render, strict parse, `baselineRelPath` (`baselines/<target>--<metric>--<sha256[:12] of [target,metric]>.json`), `tightens`/`loosens`, and `normalizeBaselineDiffValues` (coverage sections of a diff rounded to **integer** percent) | every ratchet op; `scripts/ratchet-lib.mjs` via `loadEngine`                                   |
| `src/ops/ratchet/sources.ts`                             | `MetricSourceSpec` → `MetricSource`; `coverage-json` rounds `total.lines.pct` to **integer**; `tsc-text` evidence classification                                                                                                                                          | `registry.ts` importers                                                                        |
| `src/ops/ratchet/metricRegistry.ts`, `adapters/*`        | open adapter registry; `typecheck-count`, `coverage`, `complexity`                                                                                                                                                                                                        | ops, scripts                                                                                   |
| `src/ops/ratchet/checkRatchet.ts`                        | live reading vs the committed baseline **in the workspace** (the head)                                                                                                                                                                                                    | `ratchet.yml` (CLI), `scripts/ratchet-*.mjs`                                                   |
| `src/ops/ratchet/captureBaseline.ts`                     | write/prune baselines                                                                                                                                                                                                                                                     | CLI, tests                                                                                     |
| `src/ops/ratchet/monotonicGuard.ts`                      | pure unified-diff guard over `baselines/*.json`; **added and deleted files were skipped** (a delete was "prune lifecycle")                                                                                                                                                | `registry.ts` (`ratchet.monotonicGuard`), `scripts/ratchet-check.mjs`                          |
| `src/ops/ratchet/proposeBaselineUpdate.ts`, `effects.ts` | proposal op + gh/git effects                                                                                                                                                                                                                                              | `ratchet.proposeBaselineUpdate`, `scripts/ratchet-propose.mjs`                                 |
| `src/ops/ratchet/registry.ts`                            | CLI op registry (4 ops)                                                                                                                                                                                                                                                   | central scanner, `dist/cli.js`                                                                 |
| `scripts/ratchet-lib.mjs`                                | local driver helpers; `normalizeCoverageSummary` rounds to **integer**                                                                                                                                                                                                    | `ratchet-check.mjs`, `ratchet-propose.mjs`, `ratchet-typecheck.mjs` (`npm run check:static`)   |
| `.github/workflows/ratchet.yml` (+ template)             | `pull_request` + `push`; head-defined target/metric/source argv; runs head tests with `contents: read`; guard over `git diff origin/<base>...HEAD` (no hardened flags)                                                                                                    | required check `ratchet` (denylist `REQUIRED_WORKFLOW_CHECKS`, gate `static,denylist,ratchet`) |
| `.github/workflows/ratchet-propose.yml` (+ template)     | `push: main`; measures **and** holds `CQ_AUTOMATION_TOKEN` in one job; proposal PR **against `main`**                                                                                                                                                                     | —                                                                                              |

The flaws ADR-0004 names: the head's workflow file defines the metric (targets, sources,
baselines all read from the head); the guard lets a PR delete a baseline, or rename a target
and add a looser baseline (A5); the proposal job runs `npm ci` and the test suite in the job
that holds the write token, and bypasses merge-queue.

## Design (what W1.7 ships)

- **`baselines/ratchets.json`** is the definition manifest: the ratchets (target, metric,
  direction, unit, evidence kind: head `measurement` or trusted `recompute`) and the D-C.4
  definition set (anchored regex sources, the repo's path-pattern idiom). The verifier reads it
  **from the trust ref** with `git cat-file blob <trust>:baselines/ratchets.json`, never from
  the head. Baseline values are read from the trust ref the same way.
- **Ratchet git plumbing** (`src/ops/ratchet/git.ts`): every git call is `execFile` with an
  argv array, never a shell, prefixed with the closed-form hardening from #221's design note
  (`--no-pager --literal-pathspecs -c core.fsmonitor=false -c core.quotePath=true`). Diffs add
  W1.8's `--text --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/`.
  Head content is read attribute-free (`ls-tree -r -z` + `cat-file --batch`), never
  `git archive` or a checkout.
- **Verifier** `ratchet.verifyRatchet`: definition check (subject diff vs `merge-base` for a
  PR, vs the trust ref for a push subject) → `needs-human (D11)` on any definition-set path
  (D11 records are dormant until the C3 attestation, so none is honoured); the monotonic guard
  over the same diff; strict-schema, size-capped measurement artifact (numbers only); typecheck
  count from the trusted recompute; one-decimal coverage comparison.
- **Typecheck recompute** `ratchet.recomputeTypecheck`: extract the subject tree attribute-free
  into a scratch dir with no `node_modules` of its own, then run the **trust-ref** `tsc` over it.
- **Workflows** (expand/contract, ADR-0004 D-H.2): new `cq-measure.yml` (head leg,
  `permissions: {}`, no secrets) and `cq-verify.yml` (`workflow_run`, compute/judge split);
  `ratchet-propose` split into a credential-free measure leg and a `workflow_run` proposer in
  env `automation` that opens the PR against `merge-queue`. The legacy `ratchet.yml` stays the
  required check until W1.10's C2 retires it; its guard now uses the hardened diff.
- **Guard pairing**: a deleted baseline must be replaced, in the same diff, by an added
  baseline of the same `(target, metric)`, judged as a modification. An unreplaced delete fails.
- **Coverage granularity**: one decimal place, half-up, everywhere (source normalisation, diff
  re-basis, local scripts, verifier).

## Slices

1. Coverage one-decimal: `format.ts`, `sources.ts`, `scripts/ratchet-lib.mjs` + tests.
2. Guard pairing + hardened ref-mode diff: `monotonicGuard.ts`, `registry.ts` (guard entry) + tests.
3. Definitions + git plumbing: `baselines/ratchets.json`, `definitions.ts`, `git.ts` + tests.
4. Verifier + recompute ops: `verifyRatchet.ts`, `recomputeTypecheck.ts`, registry entries + tests.
5. Workflows, templates, `scripts/ratchet-propose.mjs`, workflow tests, generated docs.
