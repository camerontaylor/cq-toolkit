# Focused-checks contract — CI is the sole full-gate authority

Canonical operating policy for worker, coordinator and reviewer behaviour in this
repository. This document **supersedes the previous "three full local gates"
(3×) rule** everywhere it was stated. It is normative: no protocol step,
handoff record or review cycle may require a local full-suite run.

Slice 1 of `specs/optimise-test-suite-execution-policy-spec.md` (component **B —
Operating policy**, plus the **C — Gate venue** rule that makes required CI the
full-gate authority). The later slices measure, retime and parallelise the
suite; they do not revisit this contract.

## 1. The rule

- **Focused checks only, locally.** A worker runs the static gate
  (`npm run check:static`), the format check (`npm run format:check`) and the
  tests **affected by the diff** (`npx vitest run <affected test files>`).
  `npm run lint` and `npm run typecheck` are aliases of `npm run check:static` —
  run one, never several.
- **Knip's condition (canonical; other documents link here, none restates
  it).** `npm run knip` is whole-project, not file-scoped: run it when the diff
  touches entrypoints, exports, dependencies or configuration — where dead code
  can actually appear — and skip it otherwise.
- **Zero local full gates per PR.** No protocol step requires a local full
  `npm run test` or full `npm run test:unit`. A clean review adds **zero runs
  beyond the review protocol's own three fixed checkpoints** — before cycle 1,
  after cycle-1 addressing, after cycle-2 addressing
  (`docs/coderabbit-review.md` §5). Those three cheap deterministic gate sets
  are the cadence itself, not review-triggered work, and completing a review
  cycle is never a reason to run anything more.
- **The full suite is CI's job, and CI alone is the authority.** CI runs the
  whole suite on every push and pull request: the trigger surface is unfiltered
  (doctrine I4 — no path, branch or tag filter; the sole sanctioned skip is the
  job-level `cq-state` settle-ledger exclusion in `.github/workflows/ci.yml`),
  and the `static` job runs `test:unit` + `test:e2e`. The `ratchet` job re-runs
  the suite with coverage. The four declarations of the required set —
  `policy/protected-paths.json`, `scripts/denylist-scan`
  `REQUIRED_WORKFLOW_CHECKS`, the promotion gate's check list, and
  `policy/templates/github-settings.json` — all name `static` and `denylist`;
  they disagree about `ratchet`, `from-source` and `pack-audit`, and that
  disagreement is the reconciliation subject of the later CI-consolidation
  slice, not a claim this contract makes.
- **Candidate evidence is green required CI on the exact candidate SHA.** The
  candidate is the `merge-queue` commit the promotion gate resolves; its verdict
  is read from that SHA's check-runs against the gate's own check list, failing
  closed on a skipped or missing result.
- **A green PR head is not candidate evidence.**
  `strict_required_status_checks_policy` is `false`
  (`policy/templates/github-settings.json`), so a PR head can be green while
  stale against its base. Only CI on the resolved candidate SHA counts.

Local full runs survive in exactly two **coordinator-owned** roles, neither of
which is a per-PR gate: a **diagnostic** when CI failed and the failure needs a
reproduction, and a **rollback gate** when a classified gap (venue, exactness,
flake) demands one. A worker _requests_ one, naming the failure it answers; it
does not launch one. Both are recorded as coordinator obligations with a named
owner.

## 2. Selecting affected tests

1. Start from the files the diff actually touches.
2. Add the test files that statically import, or are imported by, the changed
   source — `npx vitest related <changed source files>` uses Vitest's
   static-import graph.
3. Add non-import dependents that do not appear in the import graph: fixtures,
   prompts, policy and workflow templates, generated docs, scripts.
4. **Escalate anything you cannot classify.** Shared interfaces,
   dependency/tooling and cross-cutting config changes — and any impact the
   steps above leave uncertain — **escalate** to the coordinator with the
   required check named and the reason recorded. Do not launch another owner's
   gate.
5. **Broad selection is the coordinator's decision, made after escalation** —
   never a silent worker fallback. An unclassified dependency never licenses
   skipping validation; it licenses escalation.

A passing focused test does not prove its dependents; that is exactly what the
candidate run is for.

## 3. `npm run fix` is not file-scoped

`npm run fix -- <owned-file...>` rewrites only the listed files, but it **always
ends by running the full-project static gate** (`scripts/fix.mjs` runs
`scripts/ratchet-typecheck.mjs` with no file list, including for deleted-only
inputs). It is therefore a full-project static gate wearing a file-scoped
costume — never use it as routine per-turn feedback.

Invoking the leaf tools directly **bypasses** the containment checks in
`scripts/lib/owned-files.mjs`, so validate the same list through that module
first; it rejects a path outside the repository, a `.git`/`node_modules`/
`.agents`/`.codex` entry, a symlink, and a non-regular file, and exits non-zero
before any tool runs:

```bash
# 1. validate the list through the same containment check (non-mutating, fails closed)
node --input-type=module -e 'import { ownedFiles } from "./scripts/lib/owned-files.mjs"; console.log(`owned-files OK: ${ownedFiles(process.argv.slice(1)).length} file(s)`);' -- <files>
# 2. safe lint fixes for that list (safe fixes only; suggestions and dangerous fixes are excluded)
node node_modules/oxlint/bin/oxlint --config .oxlintrc.json --disable-nested-config --fix <files>
# 3. formatting for exactly the same list
node node_modules/oxfmt/bin/oxfmt <files>
```

This is the canonical spelling of the leaf commands; `AGENTS.md` repeats it
verbatim rather than varying it. Invoke the pinned binaries through `node`
rather than `npx`, which can resolve a newer oxlint/oxfmt than the pinned
devDependency.

Validation is a separate process from the mutation, so this is check-then-act,
not a lock: re-run step 1 whenever the list changes. Batch supported files into
one invocation per tool, skip rewriting deleted files, never omit the file list,
and never substitute a repository-wide glob. `npm run format:check` remains the
read-only whole-tree formatting check — a candidate-level check, not per-turn
feedback.

Read-only syntactic feedback on an explicit list is genuinely file-scoped and
is the right default:

```bash
npm run lint:fast -- <owned-file...>
```

`scripts/fix.mjs` itself is tracked for a later change that gives it fix-only
behaviour; until then the three steps above are the supported route.

## 4. Records

Origin: workstream W1 ("Land the unified cadence and focused handoff") of the
superseded research plan `ralplan-agent-validation-efficiency.md` §1. These are
that workstream's record formats, stated in their current form.

**Handoff record** (worker → coordinator):

`subject + dirty/untracked state; changed paths; behavior/risk; selected checks + why; command/result/log; broader request + owner; remaining obligations`

**Coordinator record** — the handoff fields, plus:

`batch members; actual candidate/base; full obligation list; designated executor; acceptance/promotion state`

**One field is dropped, not carried: `slot ownership`.** Heavy-work admission is
a non-goal of this policy, and with zero local full gates there is no local full
run to admit. It returns only if a future policy reintroduces admission; until
then a coordinator record naming it describes a field that does not exist.

A record is complete when it names the exact state it describes (revision or
dirty/untracked state) and the exact commands that produced its results. A
handoff can be complete while integrated-candidate validation is still pending;
that is not a merge-readiness claim.

## 5. Evidence rules

- **Every local timing cited as evidence carries a load stamp** — host uptime
  and load average at measurement time, in the same record line as the timing:

  ```bash
  date -u '+%Y-%m-%dT%H:%M:%SZ'; uptime
  ```

  An unstamped local duration is not evidence; a loader on the same host is a
  measurement error, not a slow suite.

- **Never record or claim worker-count tuning.** `--maxWorkers` is a no-op under
  `vitest.config.ts`'s `fileParallelism: false`, which forces a single worker in
  Vitest 5. No protocol step, record or performance claim may cite it as a lever.
  This is the mechanism home for that rule: re-derive it whenever
  `vitest.config.ts` changes, because a later slice may enable file-level
  parallelism and flip the answer.
- **Never re-run an unchanged deterministic failure** to obtain a green result.
  Preserve the output, diagnose, change the relevant input, then run the targeted
  reproduction. An unexplained earlier failure is not erased by a later pass.
- Never alter source or baselines to hide a failure; baselines only tighten
  (doctrine I5).

## 6. Boundaries this contract does not move

Branch protection, the required-check declarations, the promotion gate's
fail-closed wait and the coverage ratchet are unchanged by this document — they
are the machinery that makes required CI trustworthy as the sole authority. The
`macos-latest` job and its promotion pilot, the vitest project split, the
per-file spawn work and the required-contexts reconciliation are separate slices
with their own change, their own review and their own records.
