# Test suite viability: shim what is ours, keep one real contract per tool

Status: consensus draft after gpt-6-sol review, 2026-09-24. Implementation delivered as #217–#227; residual timing goals are carried by plan 003.

## Objective

Make `npm run test` cheap enough to run on every agent turn and every PR, so it does its job instead of being skipped or killed at a timeout. Do this by testing OUR logic (parsing, decisions, orchestration) through the injection seams the code already has, and by keeping exactly the real-process tests that prove an integration contract with an external tool — not by deleting behaviour, loosening assertions, or raising timeouts.

## Measured starting point (this worktree, 2026-09-24, HEAD 915f2b6)

Full `npx vitest run`: **1344s wall**, 574 suites / 2612 tests, 1 failure, 7 skipped + 1 todo. Five other vitest processes were running on the machine (load avg ~4.5), so absolute numbers are inflated; ordering is the signal.

| File                                      | Time     | Share | Driver                                                                                 |
| ----------------------------------------- | -------- | ----- | -------------------------------------------------------------------------------------- |
| `test/e2e/sweep/sweep.e2e.test.ts`        | **918s** | 71%   | 18 tests × ~51s: fresh scratch repo + bare origin per scenario, real unit runs         |
| `test/driver/acp.test.ts`                 | 105s     | 8%    | ~55 real `fake-acp-server.mjs` processes; **1 FAILURE** (hostile-cancel kill rung)     |
| `test/driver/subprocess.test.ts`          | 52s      | 4%    | real `fake-agent-cli.mjs` per test                                                     |
| `test/ops/sweep/worktreeFor.test.ts`      | 49s      | 4%    | 2 real-git tests = 49s; the other 48 tests total <1s                                   |
| `test/ops/ratchet/monotonicGuard.test.ts` | 45s      | 3%    | 5 real-git tests = 45s; ~60 literal-diff tests total <1s                               |
| `test/ops/sweep/cleanup.test.ts`          | 24s      | 2%    | 1 real-git test = 24s                                                                  |
| `test/plans/sweep.test.ts`                | 14s      | 1%    | 1 composition test builds a real repo only to observe `sandboxPolicy` reach the driver |
| `test/scripts/tooling-commands.test.ts`   | 14s      | 1%    | ~96 process layers (real tsc/oxlint/oxfmt per `it.each` row)                           |
| `test/workflows/merge-queue-gate.test.ts` | 14s      | 1%    | 18 awk + 4 bash, half redundant after the byte-identity assertion                      |
| everything else (~88 files)               | ~70s     | 5%    | already shimmed; not the problem                                                       |

### Root cause: per-exec cost, not CPU

Spawning git on this machine costs **~650ms per call through `/usr/bin/git`** (the macOS xcrun shim) and ~130ms through the resolved binary (`xcrun -f git`), with ~0% CPU — the time is spent waiting (exec policy checks / xcrun lookup), and it swings widely with load (34ms when idle, 1.6s under load). Spawning `node` from node costs ~80ms. So cost scales with **process count**, and the sweep e2e launches an estimated 450–600 children. Faster code will not help; fewer execs will.

### Skips and gaps found

- `test/scripts/demo-eval-axes.test.ts:113` — the spawn-wiring describe is `skipIf(!dist)`, and CI runs `test` before `build` (`.github/workflows/ci.yml:38,45`), so **CI never runs it**.
- `test/helpers/ratchet-fixture.ts:7-15` — runs `npm run build` inside whichever test first needs it: hidden cost charged to one test's timeout, racy if files ever parallelize.
- `test/ops/ratchet/monotonicGuard.test.ts:1028` — the whole real-git block is `describe.skip` when git is absent.
- Live suites (`LIVE_DRIVERS`, `LIVE_GH`, live merge) and `claude-agent.sdk-presence` are opt-in by design — **out of scope**, keep as-is.
- No explicit `testTimeout`; process-lifecycle tests inherit 5s and fail under load (`acp` failure above).

## Principles

1. **Classify each assertion first**: our logic → shim through an injected seam; an external tool's behaviour or our wire contract with it → keep real.
2. **One real contract per external boundary, never zero.** Each boundary we shim keeps ≥1 real test in the same file (or a named sibling) proving the shim's shape matches reality.
3. **Canned outputs are proved by a live twin.** Where real tool output is committed as a fixture, one real test regenerates one fixture and asserts byte-equality, so fixtures cannot drift from the tool.
4. **Batch, do not fake, when the external tool IS the subject** (Oxlint plugin boundaries, Knip, awk workflow programs): one invocation over a multi-case tree beats N invocations.
5. **No timeout inflation as a fix.** Explicit timeouts are allowed only for process-lifecycle tests whose budget is structural, and each must state why. A flaky test gets a root cause, not a bigger number.
6. **No coverage or assertion loss.** Coverage ratchet must not loosen (in-process seams should raise v8 coverage, since subprocess-executed src is currently invisible to it). No `skip`/`skipIf` added.

## Work units

Ordered by delivery. Each unit lists what stays real.

### U0 — Shared test infrastructure (lands with the PR that first needs it)

- **Build once, unconditionally** in a `vitest.config.ts` `globalSetup`: run `npm run build` before collection, fail the run hard if it fails (measured 5.1s). `test/helpers/ratchet-fixture.ts` consumes that build instead of building inside a test; remove the `skipIf(!dist)` in `test/scripts/demo-eval-axes.test.ts:113` so its spawn tests are mandatory (CI currently tests before building, so they never ran). Document that watch-mode reruns do not rebuild.
- `test/helpers/git-template.ts` (**measured optimization**, adopt only if it shows a real saving after process-count reduction): seed a repo (+ bare origin) once per file, `cloneTemplate()` copies it into a fresh tmpdir. Rules: copy only BEFORE any `git worktree add` (linked-worktree `.git` pointers and `.git/worktrees/*/gitdir` are absolute); rewrite `remote.origin.url` per clone; check hooks / `core.worktree` / alternates are not carried; assert `git status --porcelain` is empty right after cloning. Ships with one clone smoke: worktree add, commit, push, origin ref check.
- `test/helpers/fake-bin.ts`: generalize the argv-logging fake binary at `test/scripts/tooling-commands.test.ts:165-215`.
- Driver transport fakes — **two**, because the seams differ: ACP's returns a `ChildProcess` (`src/driver/acp/process.ts:55`), subprocess's returns a `ManagedChild` (`src/driver/subprocess/index.ts:228`, `src/driver/subprocess/process.ts:94`). Share the JSON-line scripting behind two adapters. Model write callbacks, backpressure where asserted, `error`/`close` ordering, and kill behaviour.
- REJECTED after testing: a darwin `PATH` symlink `git → $(xcrun -f git)` to bypass the xcrun shim. Apple git resolves `--exec-path` relative to argv0 (RUNTIME_PREFIX), so through a symlink it points at a nonexistent `libexec/git-core` and loses templates; measured no speedup under load (445ms/call).

### U1 — ACP failure root cause (PR-1)

- The failing test "a vendor that IGNORES session/cancel cannot hang the governed cancel: the kill rung reaches the child mid-prompt" (`test/driver/acp.test.ts:1348` area). Determine whether it is a race in the test (asserting before the child is observably mid-prompt) or a real driver bug. Fix the cause; do not raise the deadline. It must pass on all three acceptance runs.

### U2 — `sweep.e2e` (918s → target ≤120s) (PR-2)

The ≤60s/file criterion is a goal, not a delivered result: the residual
`sweep.e2e` runtime is carried by follow-up plan 003 (sweep composition
extraction), being implemented on branch `test-viability/followup-sweep-composition`.
U2's ≤120s is the current working target; the residual fix is planned, not
done.

- Add optional `worktreeEffects?: WorktreeEffects` to `SweepUnitBindings` (`src/ops/sweep/unit.ts:382-387` hardcodes `makeSubprocessWorktreeEffects`). Production default and dispatch schema unchanged. Fakes fresh per invocation, failures reported honestly, no vendor types in shared seams (I1/I5/I6/I10).
- **Retained real contracts** (full-plan runs through `runSweepPlan`, which stays real):
  1. Happy two-package fleet — dispatch, probe, stage, commit, push, marker, journal (`sweep.e2e.test.ts:331`). Fold the concurrency-2 case (`:878`) into it and make dispatch overlap observable, not just completion.
  2. Interrupt → re-invoke: real worktree reuse, fresh re-probe, surviving marker, snapshot rewrite, later assembly (`:430`, assertions `:481-519`).
  3. Push fault strands a local commit; a later run publishes it (`:840`), narrowed to one unit; the remote ref and ahead-count are the point (`src/ops/sweep/unit.ts:564`).
- **Retained focused real-git tests** (may drop the full plan, must keep real git): 4. Added-file tamper: a new file is staged before the tamper scan (`:600`); extend to assert salvage preserves the dirty tree, which lets the separate tamper-rescue scenario be shimmed. 5. Rename source is included in the staged-path check (`:779`) — git's `diff --cached --name-status -z` framing and rename detection feed the production parser (`src/ops/sweep/unit.ts:744`); a canned response would lose that.
- **Move in-process** to a new `test/ops/sweep/unit-scenarios.test.ts`: regression and dirty-preservation decisions, ordinary allowlist rejection, scoped-name normalization, all-no-op assembly, default package scope, rescue policy, prep mode. These build their own registry/planner entries from `makeSweepUnitOp` with injected `worktreeEffects`/`git`/`driver`/`runCheck`, instead of going through `runSweepPlan`'s real subprocess planner (`test/e2e/sweep/run-sweep.ts:189,224`).
- Journal-tail tests (`:1087`+) are already pure (<1ms); leave them.
- No assertion loss for staged rename, fresh re-probe, or stranded push.

### U3 — Real-git unit files and toolchain batching (PR-3)

- `monotonicGuard`: ONE real repo with all five baseline cases (tighten, loosen, clock-only, added, deleted) staged at once, one `git diff --cached`, split per file section; every case stays live, 25 spawns → 5, no committed canned output.
- `worktreeFor` / `cleanup`: keep the create→reuse round trip and the dirty-remove→force test real; drop the `worktreeFor` adapter smoke only if the round trip covers every assertion in it; seed via `cloneTemplate()` if U0 measured it worthwhile.
- `plans/sweep` composition test: use the `worktreeEffects` seam; it asserts `sandboxPolicy` propagation, which needs no real worktree.
- `tooling-commands`: replace the 5-row diagnostic `it.each` (5 fixtures × full gate) with ONE fixture holding all five sample files — one real full-gate run asserting all full-mode diagnostics, per-file `lint-fast` runs for per-mode status. Routing/argv/exit-propagation cases use `fake-bin.ts`.
- `static-conformance`: keep one real TS-diagnostic case and one real integrated compiler+Oxlint case; argument-rejection / immutable-baseline / repeat-run orchestration move to fake runners or canned `check-outputs`.
- `oxlint-boundaries`: one allowed tree and one rejected tree, per-file diagnostics asserted from one run each; separate runs remain for missing-plugin and invalid-config. 16 → ~6 launches, zero faking.
- `merge-queue-gate`: after the existing byte-identity assertion, run the awk matrix and guard cases against one copy. 22 → 11 spawns.
- `demo-eval-axes`: keep one spawned refusal as wiring proof (mandatory via U0); add a `spawnSync` timeout.

### U4 — Driver transports, inventory, docs (PR-4)

- Move ACP/subprocess protocol, parser, argv, sidecar and usage cases to the U0 transport fakes. Keep real fixture processes for: initialize→new→load, one split-frame, one resume+sidecar, EPIPE, the SIGTERM→SIGKILL ladder, the process-group grandchild kill. Those get explicit, commented timeouts (15–20s); no fake timers for OS signal deadlines.
- **Real-contract inventory** in `docs/test-performance-notes.md`: each shimmed boundary → the real test that proves the shim's shape.
- **Regression guards**: (a) where a recording seam exists (driver spawn wrappers `test/driver/acp.test.ts:106-140`, `test/driver/subprocess.test.ts:128-165`; injected fakes in `unit-scenarios`), assert exact spawn/call counts; (b) a cheap inventory test asserting that the set of test files able to launch real processes (matching `child_process` / `execFile` / `spawnSync` / known real-effect factories such as `makeSubprocessWorktreeEffects`, `generateScratchRepo`, `runSweepPlan`) equals the committed list in the inventory, so a new process-backed file needs a conscious inventory update. Limit, stated in the inventory: this guards KNOWN process entry points only; it cannot prove it finds a file that spawns through a new or transitive helper; (c) per-file durations recorded in the docs, advisory only.
- Update `docs/test-performance-notes.md` with before/after tables. Correct the stale premise in `policy/templates/affected-tests.md` only if the numbers warrant it (template edit then reinstantiate; never edit `.github/workflows` directly).

### Deferred — lanes

Vitest `projects` split (parallel `unit`, serial `integration`) only if post-PR-4 measurements justify it, and then with an explicit file inventory, not import sniffing. Parallelism needs evidence that shared env, temp paths and process deadlines tolerate it (`vitest.config.ts:17` is deliberate).

## Acceptance criteria

1. **Goals** (measured, not a single-run gate on this host): full `npm run test` build-inclusive wall ≤ 180s under comparable load (baseline 1344s); no file > 60s. Record wall time, per-file time and load average for **three consecutive full runs**.
2. All three runs green, including the fixed ACP test.
3. Skipped-test count does not increase; `demo-eval-axes` spawn tests run unconditionally, in CI too.
4. Every external boundary keeps ≥1 real test; the inventory and inventory test exist.
5. No assertion loss for staged rename, fresh re-probe, stranded push.
6. Coverage ratchet does not loosen; no baseline edited to pass (I5).
7. Gates green: `check:static`, `format:check`, `test`, `knip`.
8. No production behaviour change beyond optional, defaulted injection seams.

## Delivery

Target `origin/merge-queue` (merge-base `cad85e9`). Each PR is independently green, stacked in order:

- **PR-1** U1 (ACP root cause) + U0 build-once/demo unskip — small; makes the suite green.
- **PR-2** U2 (sweep seam, five retained contracts, unit scenarios) — biggest win.
- **PR-3** U3 (real-git unit files, toolchain batching, template copy if measured worthwhile).
- **PR-4** U4 (driver transports, inventory, guards, docs with final numbers).

Per PR, in order: implement → gates → **Opus improvement pass** (`claude/claude-opus-5-5`) over the full PR diff → gates → CodeRabbit cycle 1 + addressing → gates → CodeRabbit cycle 2 + addressing → gates → open PR. The Opus pass sits before CodeRabbit so both cycles review its changes. CodeRabbit protocol per `docs/coderabbit-review.md`, one pinned base per PR, stop after two cycles.

## Non-goals

Removing live opt-in suites; replacing git/tsc/Oxlint/Knip semantics with reimplementations; changing CI job structure or required checks; parallelizing process-backed files without evidence.
