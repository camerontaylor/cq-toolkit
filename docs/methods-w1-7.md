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
  into a scratch dir with no `node_modules` of its own, refusing tracked `node_modules`
  paths so head declarations cannot shadow the trust install, then run the **trust-ref** `tsc` over it.
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
3. Definitions + git plumbing: `baselines/ratchets.json`, `internal/definitions.ts`, `git.ts` + tests.
4. Verifier + recompute ops: `verifyRatchet.ts`, `recomputeTypecheck.ts`, registry entries + tests.
5. Workflows, templates, `scripts/ratchet-propose.mjs`, workflow tests, generated docs.

## Decisions and deviations

1. **Expand/contract, not replacement.** `ratchet.yml` stays the required `ratchet` check (the
   denylist pairing and the gate's `static,denylist,ratchet` list still name it). The trusted pair
   ships alongside in non-required mode, as ADR-0004 D-H.3 C1 prescribes. W1.10's C2 retires the
   legacy leg and makes `cq/ratchet` required. The legacy leg's target/metric pairs are
   test-pinned to `baselines/ratchets.json`, and its guard now runs in ref mode with the hardened
   argv.
2. **Interim verdict identity.** `cq-verify` posts `cq/ratchet` with its own `GITHUB_TOKEN`
   (`checks: write`). ADR-0004 D-F says such a check run is not a trust anchor, because any
   workflow can forge one. The verdict App and env `cq-verdict` are W1.10's (RS-11 B1–B6 are
   owner-blocked). `external_id` already carries `<trust-sha>:<subject-sha>`, so W1.10 changes
   only the posting identity.
3. **D11 records dormant.** The verifier returns `needs-human` for any definition-set change and
   honours no record. ADR-0004 D-G.4 honours records only after the C3 attestation, and W1.9
   owns the record checks.
4. **Toolchain lockfile (D-C.3).** The recompute always uses the trust ref's install. The
   merge-base/head-lockfile selection depends on authorized lockfile changes, which cannot exist
   until D11 records are valid. Until then any lockfile change is `needs-human`, and
   break-glass changes land on `main`, i.e. in the trust ref itself.
5. **Guard placement.** The monotonic guard runs inside `cq-verify` over the same range as the
   definition check. ADR-0004 files the guard under `cq-policy`, which is W1.9's; W1.9 can reuse
   `checkDiffMonotonicity` there unchanged.
6. **Unpaired adds pass the guard.** A new baseline file for a target the trust manifest does not
   list is inert: the verifier enumerates targets from the trust ref. Adding a ratchet means
   editing `baselines/ratchets.json`, which is in the definition set (`needs-human`).
7. **Rename-detected diffs fail closed.** The pairing needs `--no-renames`. A section with a
   `rename`/`copy` header naming a baseline is refused, so a baseline cannot be renamed out of
   `baselines/` unjudged by a caller that forgets the flag.
8. **Recompute skips symlinks and gitlinks** in the head tree, so a head symlink cannot point the
   trusted `tsc` at runner paths. A symlinked source file is not type-checked; like source-level
   suppression, this can lower the count and remains within ADR-0004 D-J's accepted residual.
9. **The privileged proposer never checks out the merge-queue tip.** It reads canonical baseline
   blobs with `cat-file`, materializes only those JSON files into a `--no-checkout` temporary
   worktree, loads the tip into the index with `read-tree`, then writes proposal blobs with
   `hash-object --no-filters` and commits the index with `write-tree`/`commit-tree`/`update-ref`.
   A tip-controlled `.gitattributes` cannot invoke a configured clean or smudge filter in the
   token-bearing job; the local-origin integration test pins this with a marker filter.

## Evidence

- Recompute on this branch's head (`93031a2`): `count 0` over 501 extracted files, equal to the
  committed typecheck baseline (0), so the C1 re-measure the ADR asks for changes nothing.
- R2-2 reproduction: a commit adding `src/w17bad.ts` (one type error) together with
  `.gitattributes: src/w17bad.ts export-ignore`. `git archive` drops the file; the attribute-free
  recompute counts `1`. The verifier also flags `.gitattributes` as a definition change.
