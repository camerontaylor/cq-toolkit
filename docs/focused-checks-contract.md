# Focused-checks contract — CI is the sole full-gate authority

Canonical operating policy for worker, coordinator and reviewer behaviour in this
repository. This document **supersedes the previous "three full local gates"
(3×) rule** everywhere it was stated. It is normative: no protocol step,
handoff record or review cycle may require a local full-suite run.

Slice 1 of the execution-policy spec — `specs/optimise-test-suite-execution-policy-spec.md`
in the **toolkit-research** repo (this repository does not contain it; the path is
relative to that repo's root) — component **B —
Operating policy**, plus the **C — Gate venue** rule that makes required CI the
full-gate authority. The later slices measure, retime and parallelise the
suite; they do not revisit this contract.

## 1. The rule

- **Focused checks only, locally.** A worker runs the static gate
  (`pnpm run check:static`), the format check (`pnpm run format:check`) and the
  tests **affected by the diff** through `pnpm test:narrow` (§2), the only
  local test command.
  `pnpm run lint` and `pnpm run typecheck` are aliases of `pnpm run check:static` —
  run one, never several.
- **Knip's condition (canonical here; another document may restate it only
  alongside a link to this section).** `pnpm run knip` is whole-project, not
  file-scoped: run it when the diff
  touches entrypoints, exports, dependencies or configuration, adds a file,
  adds or changes an import, or removes or rewires the last import of a file or
  package (`knip.json` enables `files` and `dependencies`, so a source-only edit
  can orphan either, and a new file nothing imports is itself an orphan; it also
  enables `unlisted` and `unresolved`, so an import of a package missing from
  `package.json` — even one TypeScript resolves transitively — or of a path that
  does not resolve is a finding the static gate can miss) — where dead code
  can actually appear — and skip it otherwise.
- **Zero local full gates per PR.** No protocol step requires a local full
  `pnpm run test` or full `pnpm run test:unit`. A clean review adds **zero runs
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
  `policy/protected-paths.json`, `scripts/denylist-scan`'s
  `REQUIRED_WORKFLOW_CHECKS`, the promotion gate's check list, and
  `policy/templates/github-settings.json` — all name `static` and `denylist`;
  they disagree about `ratchet`, `from-source` and `pack-audit`, and that
  disagreement is the reconciliation subject of the later CI-consolidation
  slice, not a claim this contract makes.
- **Candidate evidence is green required CI on the exact candidate SHA.** On the
  queue route — the sanctioned one (doctrine I3: `main` advances only by the
  promotion gate's pure fast-forward) — the candidate is the `merge-queue`
  commit the gate resolves. The protocol still permits a direct-to-`main` PR
  when that is a task's actual target; there the candidate is the merge commit
  (never a squash or a rewrite, per I3) that the merge would produce, and it
  must be created and checked **before** `main` advances — for example a
  throwaway merge branch carrying that merge commit. Required CI is read on
  that exact SHA against the gate's own check list, failing closed on a skipped
  or missing result. No gate workflow resolves such a commit today, so a
  direct-to-`main` PR cannot claim readiness until that evidence exists; this
  contract states the rule and does not add the mechanism. Either way the PR head is not the
  candidate.
- **A green PR head is not candidate evidence.**
  `strict_required_status_checks_policy` is `false`
  (`policy/templates/github-settings.json`), so a PR head can be green while
  stale against its base. Only CI on the resolved candidate SHA counts.

**No local full run exists (owner rule, 2026-10-04).** The full suite is
CI-only on the shared host, for workers and coordinators alike. The two
coordinator-owned roles that used to license one — a **diagnostic** when CI
failed and the failure needs a reproduction, and a **rollback gate** when a
classified gap (venue, exactness, flake) demands one — now reproduce through
`pnpm test:narrow <failing test files>` or a CI re-run. A worker _requests_
either, naming the failure it answers; both are recorded as coordinator
obligations with a named owner.

## 2. Selecting affected tests

`pnpm test:narrow` (`scripts/test-narrow.mjs`) performs this selection; do not
make it by hand. `pnpm test:narrow --dry-run` prints it without running it.

1. Start from the files the diff actually touches: by default the changes
   since the merge-base with `origin/merge-queue` plus the working tree
   (`--base <ref>` and `--range <a>..<b>` change the range); explicit file
   arguments replace the range.
2. Add the test files that statically import, or are imported by, the changed
   source, via Vitest's static-import graph (the query behind
   `vitest related`, made without running any test).
3. Add non-import dependents that do not appear in the import graph: fixtures,
   prompts, policy and workflow templates, generated docs, scripts. The
   reviewed map is `NON_IMPORT_MAP` in `scripts/lib/affected-tests.mjs`.
4. **Escalate anything you cannot classify.** `test:narrow` refuses (exit 2)
   when a changed file has no mapping, a source file was deleted, the
   import-graph query failed, or the selection exceeds its file cap. That
   refusal is the escalation trigger: name the files you can justify
   explicitly, or escalate shared interfaces, dependency/tooling and
   cross-cutting config changes to the coordinator with the required check
   named and the reason recorded. Do not launch another owner's gate.
5. **Broad selection is the coordinator's decision, made after escalation**,
   and broad means CI: never a silent worker fallback. An unclassified
   dependency never licenses skipping validation; it licenses escalation.

A passing focused test does not prove its dependents; that is exactly what the
candidate run is for.

## 3. `pnpm fix` is file-scoped

`pnpm fix <owned-file...>` runs safe Oxlint fixes and Oxfmt on the listed
files **only**; it launches no static gate and no tests (`scripts/fix.mjs`,
fix-only since #255). It is the supported per-file fix route. The
project-wide static gate is its own explicit command, `pnpm run check:static`,
run at the checkpoints in §1 — a file-scoped fix never establishes the
correctness of dependents.

Before any tool runs, `scripts/fix.mjs` validates the list through
`scripts/lib/owned-files.mjs`, which rejects an empty list, a path outside the
repository, a `.git`/`node_modules`/`.agents`/`.codex` entry, a symlink, and a
non-regular file, and exits non-zero. `ownedFiles()` deliberately accepts a
deleted path and then omits it from its return value, and it de-duplicates, so
both tools receive exactly the surviving regular files: a deleted-only list is a
no-op (`fix: only deleted files; no files to rewrite`, on stdout), and a mixed
diff formats and fixes only the files that still exist. Suggestions and
dangerous fixes are excluded; formatting receives the same argument list as the
lint fixes.

Oxlint's exit 1 (findings left, nothing lintable — e.g. a docs-only list — or an
unreadable configuration) is tolerated and passed through as `pnpm fix`'s exit
status, so the formatting step still runs. Every failure — a rejected list, an
Oxlint exit above 1, an Oxfmt failure — **also** exits 1, reported as a
`fix: …` line on **stderr**, so the status alone cannot tell a tolerated lint
result from a failed command: read the output. A `pnpm fix` exit is never a lint
verdict; take that from `lint:fast` or the static gate.

Never invoke the leaf tools (`oxlint --fix`, `oxfmt`) directly: that bypasses
the containment checks above, and an invocation that omits the file list or
substitutes a repository-wide glob rewrites the whole tree. `pnpm run
format:check` remains the read-only whole-tree formatting check — a
candidate-level check, not per-turn feedback.

Read-only syntactic feedback on an explicit list is genuinely file-scoped and
is the right default:

```bash
pnpm lint:fast <owned-file...>
```

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
  The `test:narrow result=…` summary line carries its own stamp (`load=`, the
  1-minute load average when the run started, `uptime=`, the host uptime in
  seconds captured with it, and `nice=`).

- **Never record or claim worker-count tuning.** `--maxWorkers` is a no-op under
  `vitest.config.ts`'s `fileParallelism: false`, which forces a single worker in
  Vitest 5. No protocol step, record or performance claim may cite it as a lever.
  This is the mechanism home for that rule: re-derive it whenever
  `vitest.config.ts` changes, because a later slice may enable file-level
  parallelism and flip the answer. `test:narrow` passes `--maxWorkers=1` and
  `--no-file-parallelism` as a guard that keeps a narrow run serial if that
  happens: a host-safety pin, not a lever.
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
