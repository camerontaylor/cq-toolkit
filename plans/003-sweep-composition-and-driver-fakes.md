# Sweep composition extraction and driver-specific transport fakes

Status: follow-up to plan 002 (PRs #217/#218/#219/#227), authorized by the user 2026-09-25.

## Why this exists

Plan 002 halved the suite (1344s → ~700s over 2888 tests) but missed its goals (≤180s suite, ≤60s/file). Two residuals remain, both recorded as deviations in `docs/test-performance-notes.md`:

1. **`test/e2e/sweep/sweep.e2e.test.ts` — 190–480s.** PR-2 kept 19 real tests, not the five agreed contracts, because the sweep's caller-side composition — the rescue re-dispatch lane, the fleet gate, the marker filter, the tracker-branch + assembly recomposition, and salvage of the latest run — lives only in the e2e harness `test/e2e/sweep/run-sweep.ts` (≈ lines 206–460, `runSweepPlan`, `salvageInterruptedRun`). The harness itself says it is wired "the way the future CLI/runner layer is expected to wire it". Policy that exists only in a test file cannot be unit-tested without testing test code, so every decision in it was exercised through real git.
2. **`test/driver/acp.test.ts` — ~44s; `subprocess.test.ts` ~20s.** PR-4 moved only the shared conformance suite to the transport fakes in `test/helpers/transport-fakes.ts`; 57 of 58 ACP driver-specific tests still spawn the real fixture ("retained real until a case-specific boundary is named").

## Principles (unchanged from plan 002)

Shim OUR logic through injected seams; keep ≥1 real test per external boundary; batch rather than fake when the tool is the subject; no timeout inflation; no skip/skipIf added; no baseline loosened (I5); every moved assertion must still hold somewhere (name where).

## F1 — Production-owned sweep composition (the main lever)

- Move the caller-side composition out of `test/e2e/sweep/run-sweep.ts` into a production module (proposed `src/plans/sweep-run.ts`; choose the location that fits `src/plans/README.md` / the kernel layering and justify it). Behaviour-preserving move: same rescue semantics (`config.rescue.maxRedispatch`, non-retryable-class stop, attempt labelling), same fleet gate, same marker filter, same "no empty tracker" rule, same salvage scan. Do NOT redesign rescue onto `src/kernel/rescue.ts`'s policy table in this task — note it as a follow-up if the fit is obvious.
- Dependencies are injected: the planner (`sweep.planSweep`), the op registry view / overrides, `runPlan`, the assembler (`pr.assemblePrs` over a gh seam), journal access. Production defaults may exist but must not change any existing behaviour. I8: rescue stays a plan-runner concern — the new module is plan-runner composition, never driver code. I1/I9/I10 apply.
- **Do not export it from `src/index.ts`** (that is a public SDK decision for the user); keep it internal. Knip must stay green.
- `test/e2e/sweep/run-sweep.ts` becomes thin wiring: real subprocess planner + real registry + fake gh, calling the production composition.
- New in-process tests (e.g. `test/plans/sweep-run.test.ts`) cover every composition decision with fakes: rescue budget/attempts/non-retryable stop, rescued-unit counts as succeeded, a still-failed unit withholds the fleet, marker filter, all-no-op → no assemble, prep mode, salvage reuse/resume classification.
- Then narrow `sweep.e2e.test.ts` to the five contracts agreed in plan 002 (happy fleet with concurrency-2 overlap; interrupt → re-invoke with reuse + fresh re-probe; stranded push → later publish; added-file tamper staged before scan with salvage preserving the dirty tree; rename source in `diff --cached --name-status -z`), plus at most one registry-wiring smoke if a contract is not otherwise covered. For every removed e2e test, record in the PR body which new in-process test (or retained contract) now carries each of its assertions.
- Target: `sweep.e2e` ≤120s on this host (goal, measured three times).

## F2 — Driver-specific cases onto the transport fakes

- Classify each of the 57 real ACP driver-specific tests (and the real subprocess ones): does the assertion concern OUR folding/verdict/permission/replay/usage/evidence logic (→ transport fake), or an OS/stdio/signal/sidecar contract (→ keep real)? Record the classification as a table in `docs/test-performance-notes.md` (replacing "retained real until a case-specific boundary is named").
- Move the logic cases to `fakeAcpSpawn` / `fakeManagedSpawn`; extend the fakes only as needed (the doc already lists gaps: tail-cap modelling, wait-for-EOF). Keep the real contracts listed in the existing inventory, plus any newly identified OS-level ones.
- Consider splitting ACP into `acp.conformance/fake` and `acp.real` files (a recorded proposal) if it makes the lane membership honest.
- Target: `acp.test.ts` ≤15s, `subprocess.test.ts` ≤10s (goals).

## F3 — Honest lanes (package.json only, no CI edits)

- Make `test:unit` genuinely process-free by deriving its excludes from the committed process-entry inventory (`test/driver/process-inventory.test.ts`), and `test:e2e` the complement. Add a cheap test proving the two lanes are DISJOINT and their UNION is every test file, so CI still runs everything. Rename only if it doesn't require a workflow edit (`.github/workflows/ci.yml` is not template-regenerable; any CI edit needs a separate policy decision — propose, don't do).
- Remove `test/cli/plans.smoke.test.ts`'s redundant own build now that global setup builds once, if it is truly redundant.

## Acceptance

1. All gates green: `check:static`, `format:check`, `test`, `knip`.
2. Three full-suite runs, green, recorded with load (gate each run on the quiet-window rule in the project memory `cq-toolkit-host-load-gates`: load < 3.0 and no other `vitest run`, checked twice ~60s apart).
3. Goals (measured, advisory): suite ≤300s on this host; `sweep.e2e` ≤120s; no driver file >15s; `test:unit` spawns no real processes.
4. Every removed test's assertions are accounted for (PR body table).
5. Production behaviour unchanged; the new composition module is internal (not exported); no baseline loosened; no skips added; no timeouts raised.

## Delivery

Depends on the plan-002 stack (#217 → #218 → #219 → #227) merging into `merge-queue` first; those branches may be rebased before they merge, so re-base this work with `git rebase --onto origin/merge-queue <old-fork-point>` once they land. Suggested PRs: **PR-A** F1 (largest, most review attention); **PR-B** F2; **PR-C** F3 + docs. Each PR, in order: implement → gates → **independent Opus improvement pass (a separate fresh `claude/claude-opus-5-5` agent, not the implementor)** → gates → CodeRabbit CLI cycle 1 + addressing → gates → cycle 2 + addressing → gates → open against `merge-queue`, per `AGENTS.md` and `docs/coderabbit-review.md`.
