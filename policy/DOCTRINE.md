# cq-toolkit doctrine — the eleven behavioral invariants

Source: the toolkit plan's invariants table. Role: adoptable policy text, shipped in
`policy/`, instantiated by any repository the same way the merge-queue templates are
(`policy/templates/README.md`). Each invariant carries a Rule, a Why, and an
Enforcement. This repo enforces I4, I3, and part of I5 today.

## I1 — stdout is JSON, stderr is narration; exit codes 0/1/2/3

**Rule.** Every operation invocation writes machine-readable JSON to stdout and human
narration to stderr, never mixed. Exit codes: 0 clean, 1 thrown error, 2 arg error,
3 needs-human.

**Why.** Operations compose programmatically; narration on stdout makes the result
unparseable, and a caller parsing prose to tell "failed" from "misused" from "needs a
human" gets it wrong — the exit code is the composition-level signal.

**Enforcement.** Lands in phase 1 with the kernel op contract (`src/kernel`): a typed
result envelope; the plan runner treats non-JSON stdout or an unexpected exit code
as thrown. The phase-3 CLI (`src/cli`) maps arg errors to 2, escalations to 3.

## I2 — no-privileged-reviewer acceptance

**Rule.** A change is acceptable when any non-author review exists, plus either a
settle of ≥10 minutes since the last commit or an explicit all-clear postdating it.
Unresolved external threads block; truncated review data fails closed.

**Why.** Requiring a specific privileged reviewer deadlocks a queue the moment that
reviewer is unavailable, and evidence predating the last commit accepts code nobody
looked at. Truncated pagination silently reads as "no blocking threads" — never a
pass on absence of data.

**Enforcement.** The decision table is built and tested in phase 3 as specified, on
top of `src/ops/review` (phases 1–2). Known deviation today: this repo's automation
runs under a single identity — review supply is a fresh reviewer agent under the
same account, standing in for non-author review until a second identity exists.

## I3 — merge commits only; promotion to main is a pure fast-forward

**Rule.** History advances only by merge commits; `merge-queue` promotes to `main`
as a pure ff-push behind merge-base guards. Never squash-merge, never push no-ff
to `main`, never rewrite history, never force-push — the policy invariant, not just
a repo setting — and `main` is advanced by the gate alone.

**Why.** Squashing breaks the mapping between the commits that were checked and the
commits that land; rewrite or force-push moves `main` past commits whose check
evidence was collected for a different history — upstream gates stop describing
reality.

**Enforcement (today).** `policy/templates/merge-queue-gate.yml`, instantiated as
`.github/workflows/merge-queue-gate.yml`, is the only component that advances `main`,
behind two merge-base guards in order: an already-promoted sha is a logged no-op;
divergence refuses and a human merges `main` into `merge-queue`; only then
`<sha>:refs/heads/main`. The repo's merge settings allow merge commits only.

### Entitlement facts

- Personal GitHub accounts get HTTP 422 from the native merge-queue API (verified
  2026-09) — why this queue is branch-based: PRs target an ordinary branch and
  promotion is a push.
- The refs API PATCH with `force=false` is the server-side fast-forward invariant:
  the server itself rejects any non-ff update, so an ff-only queue needs no
  client-side trust. Cross-reference: `policy/templates/README.md`.

## I4 — required checks never filter triggers

**Rule.** A workflow behind a required check never gets `paths-ignore` — nor
`paths`, branch, or tag filters of any kind; it must report status on every pull
request. The only sanctioned skip mechanism is a job-level `if:`.

**Why.** A docs-only PR must still get every required check's status. A filtered
trigger means the workflow does not run for that PR, so the check reports no
status; branch protection waits forever and the PR hangs unmergeable with no red
check to point at — silently absent, worse than failing. A job-level `if:` is the
only skip because it still reports a conclusion.

**Enforcement (today).** The unfiltered `on: push / pull_request` triggers of
`.github/workflows/denylist.yml` and `.github/workflows/ci.yml` (both instantiated
from `policy/templates/required-check.md`), policed by the denylist-scan
self-test's workflow-I4 leg over `REQUIRED_WORKFLOW_FILES` in
`scripts/denylist-scan` — fail-closed on an empty list or a missing listed file.
Adopting repos: instantiate `required-check.md` and police triggers likewise.

## I5 — baselines only tighten; missing evidence is non-passing

**Rule.** Metrics baselines are a monotonic ratchet: counts may only go down; raising
a baseline to go green is not a ratchet. A missing metrics summary is non-passing
evidence, never a pass.

**Why.** A ratchet that loosens is indistinguishable from no gate, and a missing
summary read as zero lets a broken run — missing compiler, panicked tool, rejected
flag — certify cleanliness nobody measured.

**Enforcement (partial today).** `scripts/ratchet-typecheck.mjs` enforces both
halves for the typecheck baseline (`baselines/typecheck.json`): a missing baseline
fails with the I5 message, a count above baseline fails with "thresholds only
tighten", and `--update` refuses runs with no parsable error lines. Phase 2 (H4)
replaces it with `src/ops/ratchet`, the same rule over every metrics summary.

## I6 — every worker is a fresh isolated invocation

**Rule.** Each per-file or per-job worker is a fresh, isolated invocation; context
never leaks between workers.

**Why.** Shared state makes results order-dependent and irreproducible, and a
context poisoned by one input silently changes another's verdict — a failure
invisible in any single result.

**Enforcement.** Lands in phase 1 with the harness (`src/harness`, the minimal tool
surface and per-op allowlists) and the driver layer (`src/driver`): one worker, one
process, no cross-worker handles; the run manifest records each worker as isolated.

## I7 — no baseline caching on worktree reuse

**Rule.** A reused clean worktree re-probes its baselines from scratch; baseline
values are never carried over by cache.

**Why.** A cached "known clean" certifies a measurement of a tree the run is no
longer looking at — branch switches and fetched updates change the tree under the
reuse — so regressions hide behind stale evidence.

**Enforcement.** Lands with the worktree-managing ops (`src/ops/sweep`, phases 1–2):
reuse may save setup, never measurement; every baseline in the run manifest is marked
freshly probed.

## I8 — rescue and escalation live in the plan runner

**Rule.** Rescue and escalation policy is a plan-runner concern, never a driver
concern: drivers execute one invocation and report.

**Why.** A driver that rescues itself makes every composition's rescue policy an
accident of the transport — hidden retries, double rescue, and budget blowouts the
runner's governor cannot see.

**Enforcement.** Lands in phase 1 with the kernel plan runner and budget governor
(`src/kernel`) over the driver seam (ADR-0001, `src/driver`): driver types carry no
rescue vocabulary; exit-3 escalation is the runner's alone.

## I9 — fleet runs collect everything; budget stops are honest

**Rule.** Fleet runs collect all results and never bail mid-fleet. On budget
exhaustion they stop honestly: unrun members are marked budget-exhausted, never
fabricated as passed or not-applicable.

**Why.** Bailing on first failure hides the fleet's real shape — which members pass,
fail, or need a human — and fabricating results to fit a budget is worse: decisions
get made on invented evidence.

**Enforcement.** Lands with the kernel budget governor (`src/kernel`, phase 1) and
the sweep plans (`src/plans`, phase 2+): the NDJSON journal records every member's
outcome; budget-exhausted is a terminal marker, never silent truncation.

## I10 — the kernel stays vendor-neutral

**Rule.** No model-vendor or SDK vocabulary appears in kernel types or in persisted
data (run manifests, journals).

**Why.** Vendor vocabulary in persisted data locks every consumer of that data to one
vendor; kernel types referencing a vendor SDK make the core unportable and push its
dependency churn onto every adopter.

**Enforcement.** The boundary rule `eslint/rules/no-vendor-sdk-in-kernel.mjs` runs in
lint today as an error scoped to `src/kernel/**` (`eslint.config.js`); that tree is
still empty of code, so it turns load-bearing in phase 1. Vendor SDKs live only in
`src/driver/drivers/`; persisted-data neutrality lands with the phase-1 schemas.

## I11 — GitHub facts are carried as tests

**Rule.** Every GitHub-API behavioral fact an op relies on is carried as a named
test beside the op: REST lists paginate (`--paginate`, else truncated data);
GraphQL reviewThreads lag REST (verify via REST); reply-before-resolve ordering
makes resolution idempotent; personal accounts get merge-queue 422.

**Why.** These facts are load-bearing assumptions silently encoded in op logic; when
behavior changes or the op is refactored, the named test is what fails. Without it,
truncated data quietly reads as complete — I2's fail-closed rule fails open.

**Enforcement.** The tests land with the ops that touch them — `src/ops/pr` and
`src/ops/review` (phases 1–2) — each fact a fixture test in the op's suite, so
breaking one fails visibly; the 422 fact also lives in the templates README.
