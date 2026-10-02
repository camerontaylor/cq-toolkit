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
- **Zero local full gates per PR.** No protocol step requires a local full
  `npm run test` or full `npm run test:unit`. A clean review requires zero new
  deterministic runs: completing a review cycle is not a reason to re-run
  anything.
- **The full suite is CI's job, and CI alone is the authority.** Required CI
  runs the whole suite on every push and pull request with no path or branch
  filters: the `static` job runs `test:unit` + `test:e2e`
  (`.github/workflows/ci.yml`), and the required `ratchet` job re-runs the
  suite with coverage.
- **Candidate evidence is green required CI on the exact candidate SHA.** The
  candidate is the `merge-queue` commit the promotion gate resolves; its verdict
  is read from that SHA's check-runs, failing closed on a skipped or missing
  result.
- **A green PR head is not candidate evidence.**
  `strict_required_status_checks_policy` is `false`
  (`policy/templates/github-settings.json`), so a PR head can be green while
  stale against its base. Only CI on the resolved candidate SHA counts.

Local full runs survive in exactly two roles, neither of which is a per-PR
gate: a **diagnostic** when CI failed and the failure needs a reproduction, and
a **coordinator rollback gate** when a classified gap (venue, exactness, flake)
demands one. Both are recorded as obligations with an owner. Nothing here
reinstates the 3× rule.

## 2. Selecting affected tests

1. Start from the files the diff actually touches.
2. Add the test files that statically import, or are imported by, the changed
   source — `npx vitest related <changed source files>` uses Vitest's
   static-import graph.
3. Add non-import dependents that do not appear in the import graph: fixtures,
   prompts, policy and workflow templates, generated docs, scripts.
4. **Unknown impact selects broadly** — an unclassified dependency never
   licenses skipping validation.
5. Shared-interface, dependency/tooling and cross-cutting config changes
   **escalate** to the coordinator with the required check named and the reason
   recorded. Do not launch another owner's gate.

A passing focused test does not prove its dependents; that is exactly what the
candidate run is for.

## 3. `npm run fix` is not file-scoped

`npm run fix -- <owned-file...>` rewrites only the listed files, but it **always
ends by running the full project static analysis** (`scripts/fix.mjs` runs
`scripts/ratchet-typecheck.mjs` with no file list, including for deleted-only
inputs). It is therefore a full gate wearing a file-scoped costume — never use
it as routine per-turn feedback.

Use the leaf tools on an explicit, non-empty list of owned regular files:

```bash
node node_modules/oxlint/bin/oxlint --config .oxlintrc.json --disable-nested-config --fix ./path/to/file.ts
node node_modules/oxfmt/bin/oxfmt ./path/to/file.ts
```

Batch supported files into one invocation. Keep the ownership and containment
checks in force (`scripts/lib/owned-files.mjs`), and skip rewriting deleted
files. Never omit the file list and never substitute a repository-wide glob —
including as a formatting command (`npm run format:check` is the read-only
whole-tree check; `oxfmt --check .` is the same obligation).

Read-only syntactic feedback on an explicit list is genuinely file-scoped and
is the right default:

```bash
npm run lint:fast -- <owned-file...>
```

`scripts/fix.mjs` itself is tracked for a later change that gives it fix-only
behaviour; until then the leaf commands above are the supported route. Local
feedback from them is not semantic validation — full validation remains the
candidate's obligation.

## 4. Records

Published verbatim from the superseded plan's workstream W1
(`ralplan-agent-validation-efficiency.md`, §"W1 — Land the unified cadence and
focused handoff"), which is the origin of these formats:

> Manual handoff record: `subject + dirty/untracked state; changed paths;
behavior/risk; selected checks + why; command/result/log; broader request +
owner; remaining obligations`. Coordinator record adds `batch members; actual
candidate/base; full obligation list; designated executor; slot ownership;
acceptance/promotion state`. These may be short structured Markdown records
> before any software is built.

One field is superseded on purpose: **slot ownership** and heavy-work admission
are non-goals for this policy — with zero local full gates there is no local
full run to admit — so the field is retained only for format compatibility until
a future policy reintroduces admission.

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
