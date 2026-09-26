# W1.9 methods note

W1.9 implements D11, the protected-path approval policy (ADR-0004 D-G, as reconciled at G1,
`bf5f540`; key naming per RS-15 Annex B, `767819d`). A default-branch verifier, `cq-policy`,
computes a **base-ref policy diff** over a subject's judged range and posts `cq/policy`. The
posture key `CQ_MERGE_PROTECTED_PATHS` selects what needs a human. The `cq-override` label record
is evaluated and logged in the run report, but it stays dormant until the ADR-0004 D-H.3 C3
attestation is on the trust ref.

## Sources and composition

- **Taxonomy (#220, W1.8).** `src/ops/gates/protectedPaths.ts` is the one protected-path list.
  W1.9 adds `policy/**` and `lint/**` (ADR-0004 D-G.1) to `PROTECTED_CONFIG_PATH_PATTERNS`, so
  sweep workers are denied these paths too; before, policy templates were committable worker
  content. The D11 check calls `isProtectedPolicyPath`, which is the config patterns with no
  test-evidence patterns. Tests and snapshots are worker evidence (W1.8), not enforcement
  definitions, so a human-authored test change is not a D11 event.
- **No-shell git (#221 design note, as implemented for W1.7 in `src/ops/ratchet/git.ts`).** The
  policy op makes all its git calls through the same hardened helpers: `execFile` argv arrays,
  `GIT_HARDEN`, the scrubbed env, revision validation with `--end-of-options`, and
  `HARDENED_DIFF_FLAGS`. It adds one helper, `gitListPaths`, built the same way. Nothing from the
  head is checked out or executed.
- **`.git` containment (#224, W1.4).** A changed path with a `.git` segment (the
  `/^\.git[. ]*$/i` segment shape both modules use) fails `assertRepoRelPath`. The check reports
  it as an unsafe path and returns needs-human. It never reads such a path.
- **Config (P7/P8, §3.1, Annex B §B.1/§B.4).** `resolveProtectedPathsConfig({ env, optIn })`
  follows W1.11's pure-resolver precedent. Blank or unset means `human`, and any other value
  than `human|diff-check` throws. The per-call key is `merge.protectedPaths`. The resolved value
  and its layer (`default|env|call`) go into the run report. Op input, plan JSON and workspace
  files never carry the posture: the op input schema is strict and has no posture field.

## The check (`gates.policyDiff`)

Range: for a PR subject, `merge-base(subject, base)..subject`; for a push subject,
`merge-base(tip, main)..tip`. This matches `ratchet.verifyRatchet`. Lists come from the trust
ref: the `baselines/ratchets.json` definition set, the tsconfig `extends`/`references` graph,
and `policy/protected-paths.json` (`protectedPaths` regex sources plus `requiredChecks`).

Findings (each carries a kind, a path and a one-line reason):

| kind                   | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protected-path`       | any changed path in the protected set: taxonomy ∪ definition set ∪ tsconfig graph ∪ policy-file list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `baseline-loosened`    | the monotonic guard (`checkDiffMonotonicity`, one-decimal re-basis) rejects the `baselines/` diff: a loosened or unreplaced baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `target-removed`       | a ratchet `(target, metric)` present in the range base's manifest is absent from the subject's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `definition-changed`   | a definition-set or tsconfig-graph path changed, except canonical baseline value files, which the guard judges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `entry-removed`        | a `definitionSet`, `protectedPaths` or `requiredChecks` entry was removed, or the subject's list file is unparseable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `required-check`       | a produced required check loses every producer; a producing job's normalised text, its workflow's context or file parse changes; a job the range base lacks newly produces a required check (a phantom that could shadow it); or, when no producer resolves statically at the range base (matrix, dynamic name, reusable call), any changed workflow holds such a job or is unparseable                                                                                                                                                                                                                                                                            |
| `workflow-new`         | a workflow file absent at the range base                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `workflow-removed`     | a workflow file deleted, which removes its triggers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `trigger-changed`      | a workflow's top-level `on:` block or `name:` differs (a rename changes which `workflow_run` consumers fire)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `privileged-job`       | a job privileged at either end was added or changed: it has a permission other than `read`/`none` (or inherits one), uses a secret other than `GITHUB_TOKEN`, sets `environment:`, or calls a reusable workflow; also a workflow-level context change or a changed local `uses: ./` target under a privileged job                                                                                                                                                                                                                                                                                                                                                  |
| `workflow-unparseable` | a changed workflow is outside the scanner's recognised YAML subset (fails closed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `unsafe-path`          | a changed path fails `assertRepoRelPath` (#224's `.git` segment and others)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lint`                 | D-G.3, in both postures and always a failure, **regression-only**: a finding is keyed by rule, job and signal, and one already present at the range base is base-owned. The rules: a `pull_request_target` workflow with `environment:` or a non-`GITHUB_TOKEN` secret; in a `pull_request_target`/`workflow_run` workflow, a checkout whose `ref:`/`repository:` uses a non-base `${{ }}` expression or a head token, a `run:` moving the worktree to `FETCH_HEAD`, a head expression or a PR ref, or a checkout without `persist-credentials: false` in a job with `run:` steps; and `persist-credentials` other than literal `false` in a job with `run:` steps |

Verdict: `fail` if there is any lint finding. Otherwise the posture decides:

- `human`: `needs-human` for any finding.
- `diff-check`: `needs-human` for every kind except `protected-path`.

With no findings the verdict is `pass`. Every kind except `lint` is needs-human, never a plain
failure, per D11.

## The override record (D-G.4)

`evaluateOverrideLabel` reads the PR's timeline label events, which the workflow fetches from
the API; nothing is head-authored. The current `cq-override` application is the last `labeled`
event that no later `unlabeled` event follows. It is **valid** only if all of these hold:

- `actor.id` equals the repository owner id;
- `actor.type` is `User`;
- `performed_via_github_app` is null;
- the event is later than the head observation epoch. The epoch is the first observation of a
  settle-ledger record whose tuple head is the subject: the RS-3/W1.2 durable observed-head
  tuple on `cq-state`, never a commit timestamp. With no such record the label is invalid.

A valid record is **honoured**, turning needs-human into pass, only when the C3 attestation file
(`policy/attestations/c3.json`) is on the trust ref **and** has exactly the shape
`{ "schemaVersion": 1, "attests": "C3", "attestedAt": "<canonical ISO 8601 UTC>", "note"?: … }`.
A stray, empty or placeholder file does not arm records; the report notes why. Until then the
report logs the label as `dormant`, with every field it checked. The APPROVED-review record form belongs to W1.10,
alongside the acceptance check.

## Workflow wiring (expand, ADR-0004 D-H.2)

- `cq-signal.yml` is a wake-up only. Its triggers are `pull_request` (opened, synchronize,
  reopened, labeled, unlabeled, ready_for_review, edited), `pull_request_review`,
  `pull_request_review_comment` and `push: merge-queue`. It has `permissions: {}` and does
  nothing.
- `cq-policy.yml` runs on `workflow_run: [cq-signal]`, plus `workflow_dispatch` on the default
  ref, from the default-branch definition. It verifies the triggering run's path, event and
  repository id, resolves the subject from `head_sha`, and gets the PR from
  `commits/{sha}/pulls` with a base check. It builds the toolkit from the trust ref with
  `npm ci --ignore-scripts` and fetches the subject, base and `cq-state` as objects. It fetches
  the timeline label events, runs `gates.policyDiff`, and posts `cq/policy` with the report as
  the check-run summary and step summary. It maps `vars.CQ_MERGE_PROTECTED_PATHS`.
- `cq/policy` is **not required** in W1.9. W1.10's C2 makes it required and moves posting to the
  verdict App. As W1.7 recorded for `cq/ratchet`, a `GITHUB_TOKEN` check run is not yet a trust
  anchor (D-F).

## Decisions and deviations

1. **The YAML subset scanner has no parser dependency.** A dependency would change the lockfile
   and add a parser to the privileged path. The scanner recognises block-style workflows and
   fails closed on anything else (tabs, flow-style `jobs`/`on`, anchors, aliases, merge keys,
   multi-document files, duplicate keys). It also rejects every parser differential the Opus
   improvement pass found. That covers backslash escapes in double-quoted scalars, quoted keys
   other than `"on"`, and keys outside case-sensitive allow-lists at the top, job and step
   levels. It also covers line breaks other than `\n`/`\r\n` (lone CR, U+0085, U+2028,
   U+2029), control characters, and flow mappings other than inline `permissions`. Keys are
   matched by their parsed name, never by regex over text. Fail-closed output is needs-human.
   The intent is that the scanner only over-flags; the regression tests pin each differential
   found so far.
2. **Canonical baseline value files are judged by the guard, not the definition rule.** ADR-0004
   D-C.4 names only `baselines/ratchets.json`; D-G.1 names `baselines/**` for loosening only.
   W1.7's `^baselines/` definition entry still routes baseline edits to needs-human in
   `cq/ratchet`. The policy check follows the ADR text.
3. **Check-code paths are project data.** They go in the trust ref's
   `policy/protected-paths.json`, not the built-in taxonomy. The toolkit lists its verifier and
   gate code. That file and its required-check list are in the definition set.
4. **Scripts a privileged job runs are covered only through the lists.** Only local
   `uses: ./` targets are traced; `run:` references are not. Under `diff-check`, a script a
   privileged job runs is guarded only if the definition set or the policy list names it, which
   is the ADR's "normal acceptance" model.
5. **Lint is regression-only.** ADR-0004 D-G.3 says "always failure". Linting unchanged,
   base-owned violations would fail every edit to such a file; `cq-verify.yml`'s `fetch` job
   (W1.7) has two. Findings are keyed by rule, job and signal. So a new violation is still
   reported inside a job that already has one.
6. **The head-execution lint is static.** It catches:
   - checkouts of non-base expressions and head tokens, by any owner's `checkout` action;
   - `run:` scripts that move the worktree to `FETCH_HEAD` or a PR ref, or to anything a non-base
     `${{ }}` expression names. The expression counts anywhere inline, or through a step, job or
     workflow `env:` variable that a moving `git` row reads, directly or via one-line shell
     assignments followed to a fixed point (`R="$HEAD_REF"`).
   - Before those checks run, shell line continuations are joined. For a `>` block or a plain
     multi-line value, including one that starts on the next line, the YAML-folded reading is
     judged as well; a literal `|` block is never folded.

   It does not model arbitrary shell. These remain residuals: functions, `eval`, command
   substitution into files, and cross-step `$GITHUB_ENV` writes. Such a change still lands on a
   protected path (`.github/**`), and it is a definition change wherever `^\.github/` is in the
   set, as it is here.

7. **The configuration inputs of required checks are definitions.** The `static`, `denylist`
   and `ratchet` jobs read `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json`, `lint/**`, the `scripts/ratchet-*.mjs`,
   `gen-op-docs` and `copy-prompt-assets` scripts, and `policy/denylist/**`. All of them are now
   in the definition set and the taxonomy. Otherwise a PR could neuter a required check,
   for example by switching off Oxlint rules, and pass under `diff-check` (D-G.2: "neutering
   one isn't removing it").

   This covers their configuration, not the code they run. `static` loads the head-built
   `dist/ops/ratchet/*` engine through `ratchet-lib.mjs` `loadEngine`. The legacy `ratchet` job
   runs the head build of `dist/cli.js`. The rest of the head's `src/**` is in the same position.
   See the first residual in Decision 8.

8. **Residuals, recorded.**
   - **Folded-lint keys are by row (R2-3).** A folded match is keyed by the row its `git` starts
     on, so that edits elsewhere in a base-owned `>` block do not re-report an old violation.
     The flip side: editing the payload rows of an already-violating folded command (for
     example, swapping which head expression it checks out) does not re-lint. The edit still
     lands on `.github/**`, a protected and, here, a definition path.
   - **Required checks that execute head-built `src/**` can be neutered under `diff-check`
     until W1.10's C2.** A PR that makes, say, the typecheck-count adapter always pass yields
     only a `protected-path` finding for `src/ops/ratchet/**`. `src/kernel/**` and `src/cli.ts`
     yield no finding at all. What limits this today:
     - `cq/ratchet` is recomputed from a trust-built toolkit, which covers `ratchet` but not
       `static`;
     - the `human` posture (blank) routes `src/ops/ratchet/**` to a human through the project
       policy list.

     `^src/ops/ratchet/` was not added to the definition set, because the definition set is
     mirrored into the W1.8 worker-deny taxonomy, and that would also stop sweep workers editing
     the ratchet engine. W1.10's C2, trust-built required checks, closes the gap
     (composition review F3).

   - Local `uses: ./` tracing is one level deep. A chain that already exists can be edited at
     its second link; creating a new chain edits a traced file.
   - `cq-policy` concurrency is keyed per signal run, so a stale run can post after a newer one.
     The verdict is bound to `<trust>:<subject>` in `external_id`, and W1.10's gate selects by
     trust SHA.
   - Whether head-defined workflows with `contents: write` can write `cq-state`, and so forge a
     head epoch, is an RS-3/W1.10 question. It is moot while the record is dormant.
9. **The per-call opt-in uses the object shape**, `{ 'merge.protectedPaths': … }`, as W1.11's
   `SandboxOptIn` does and §3.1 describes. The CLI `--opt-in` flag is W3.6's.

## Evidence

- Hermetic op tests (`test/ops/gates/policyDiff.test.ts`) run in both postures. They cover
  every finding kind; the #224 composition, where a `.GIT` segment and a backslash path become
  `unsafe-path` and are never read; and the #221/W1.7 no-shell composition. In that test a
  repo configured with `diff.external`, a textconv driver selected by a head `.gitattributes`,
  `core.fsmonitor` and `core.pager` runs none of them, and the loosened baseline is still
  reported. They also cover the override record: dormant without the attestation, honoured
  with it, and an App-applied label invalid either way (the A14 row). Finally, they check that
  the registry schema rejects a posture field in op input.
- The scanner tests run every real workflow in this repo, and all of them scan.
- A smoke run of the built CLI over this branch, `main..HEAD` under `human`, returned
  `needs-human`. It listed the new workflows, the templates and `protectedPaths.ts`, and logged
  the override record as absent.
- CodeRabbit CLI cycles and gate runs are recorded in the PR body.
