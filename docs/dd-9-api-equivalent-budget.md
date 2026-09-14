# DD-9 — the api-equivalent budget (T1.6b)

> **Plan identifiers:** `DD-9`, `T1.6b`, `ws-a`, `I9`, and `plan §6`/`§10`
> come from the toolkit's development plan, maintained outside this repo
> (private research notes). Inlined rules: DD-9 = "api-equivalent budget";
> plan §10 DD-9 = "`WorkerResult.costUSD` stays optional and marks
> `costBasis: 'modeled'` vs `'billed'` so a subscription run is never
> silently reported as spend; the governor must also enforce a token
> budget"; plan §6 = "a debt may ship unresolved, it may not ship
> unreviewed".

This file is DD-9's written disposition, as plan §6 requires for a debt
that ships closed.

## 1. The gap

The T1.3 governor merged with a USD-only cap that failed OPEN on
subscription-routed lanes: a lane routed through a coding-plan subscription
(e.g. Claude via a coding plan) reports real token usage but no billable
USD, so the driver honestly left `costUSD` undefined (DD-2's derived-only
rule — never fabricate), the governor's rollup never moved, and the cap
never tripped. The safety control was silently absent on exactly the lanes
the owner actually runs. The research lane flagged it with the acceptance
check in commit d02a107 ("a run whose driver results carry usage but
`costUSD: undefined` still stops at `maxTokens`"), and the owner gated it
into this goal (plan §10 DD-9; plan §6). A safety gap in merged code is a
debt like any other: it ships reviewed or it does not ship.

## 2. The mechanism, as implemented

- `WorkerResult.costBasis?: 'modeled' | 'billed'` (`src/driver/types.ts`;
  zod mirror in `src/kernel/schema.ts`) — present exactly when `costUSD` is
  present; a result with no cost carries no basis either. Both first-party
  drivers label their derived figure `costBasis: 'modeled'` (the
  `costField` helpers in `src/driver/ai-sdk/index.ts` and
  `src/driver/subprocess/index.ts`).
- `RunOptions.maxTokens?: number` (`src/kernel/types.ts`) — the run-level
  token rollup cap. No `Limits.maxTokens` half (see §5).
- `GovernorConfig.maxTokens?: number` (`src/kernel/governor.ts`), built by
  `governorConfig()` straight from `opts.maxTokens` (no precedence rule —
  there is no second surface to take a min() against). Validated: finite
  number > 0.
- `BudgetGovernor.observeUsage` checks the token rollup against
  `maxTokens` with the same exceeds-cap semantics as the USD cap (the trip
  fires when the fold EXCEEDS the cap; a fold at the cap does not).
- `BudgetGovernor.observeResult(jobKey, result)` — the canonical fold for
  ONE driver result at the folding point (a phase-2 registry layer calls
  this per `WorkerResult`; `observeUsage`/`observeCost` remain the
  streaming primitives the governed ladder reports through). Fold rules:
  real usage (any nonzero token count) rolls the token cap; a present
  `costUSD` rolls the USD cap; real usage with NO `costUSD` under a
  configured `maxUsd` TRIPS the budget (see §4); a zero-usage result folds
  nothing (nothing was measured — I9).
- Tripping gates admission exactly as before: refused dispatches return
  `{ status: 'budget-exhausted' }`, and `withBudgetStop` marks the
  never-run rows honestly (I9).
- The seeded resume path honors BOTH caps: `seedFromJournal` checks the
  journaled token rollup against `maxTokens` at seed time, right beside the
  seeded-USD check — a prior run's usage that already overruns either cap
  trips BEFORE the resumed run admits anything (without it, a resumed
  run whose seeded token rollup was over the cap would admit and dispatch,
  and never trip at all if no further usage-reporting op folded).

## 3. The modelling assumption, stated honestly

`costBasis: 'modeled'` means: the vendor's PUBLISHED LIST PRICE for the
tokens actually consumed, computed through the vendored models.dev table
(`src/driver/pricing`, MIT — license verified per DD-3) keyed by model id.
It is an api-equivalent proxy — what the same tokens would have cost on the
vendor's API.

It is NOT what the owner is billed. On a coding-plan subscription the
marginal cost of a run is approximately zero; the true constraint there is
a rate limit, not a bill. The caps DD-9 ships are SAFETY bounds — a
runaway-lane backstop with a comparable yardstick — not accounting claims.
A modeled figure is labeled as modeled everywhere it appears and is never
presented as spend; `RunReport.costUSD` remains the caller-side rollup and
carries no basis field in v1 (see §5) precisely so a report cannot quietly
assert invoice truth.

## 4. The unpriced-model path: fail loud, never fail open

One fail-open path remains in principle: a model no price map knows leaves
`costUSD` undefined, so a USD cap has nothing to bind. DD-9's rule: when a
real-usage result folds with NO `costUSD` while `config.maxUsd` is set, the
governor TRIPS the budget (honest stop — remaining jobs `budget-exhausted`,
I9) rather than run past an unenforceable cap. There is no opt-out knob in
v1; the escapes are the documented ones — price the model (the `pricing`
override exists on both drivers), or cap the run with `maxTokens`, which
binds regardless of any price. Without a USD cap the same fold is not a
budget event (the usage still rolls; `maxTokens` binds it).

## 5. Deliberate v1 omissions, and what triggers adding them

- **No `Limits.maxTokens`.** Add when a Limits-level token cap is actually
  needed; until then a second surface would only force a precedence rule
  nobody asked for.
- **No `RunReport.costBasis`.** v1 is all-modeled, so a report-level basis
  would be constant. Add it when billed and modeled results can mix inside
  ONE run — and at that point a report-level rollup MUST carry a basis or
  refuse to roll mixed rows (rolling a modeled and a billed figure into an
  unlabeled sum would manufacture exactly the false accounting DD-9
  exists to prevent).
- **No opt-out for the unpriced fail-loud.** The owner's preference order
  was fail-loud OR an explicit opt-out; fail-loud alone shipped. Add an
  explicit knob only with a recorded need — adding one later is additive.
- **Untouched frozen surfaces, recorded:** `Limits.maxTokens` (no
  breakdown line asks for it) and `RunReport.costBasis` (above). The two
  sanctioned frozen-type changes are `RunOptions.maxTokens?` and
  `WorkerResult.costBasis?`, both additive-optional.

## 6. Evidence

- `test/kernel/governor.test.ts`, describe `DD-9 (T1.6b): parallel token
  rollup + api-equivalent USD` — six cases:
  1. `maxTokens` trips independently of `maxUsd` (reason names the token
     rollup; admission refuses with reason `budget`; the governed dispatch
     returns `budget-exhausted`; a control governor under the cap never
     trips; the at-cap boundary fold does not trip — exceeds semantics).
  2. THE d02a107 acceptance check, full-run shape: three jobs reporting
     real usage and no cost under `maxTokens: 150` — the run stops at the
     cap (`stoppedEarly: true`, `earlyStopReason: 'budget'` via
     `withBudgetStop`), remaining jobs `budget-exhausted`, done rows keep
     real results, and the budget-tripped event carries the token reason.
  3. `maxUsd` stays PRIMARY and trips on MODELED cost (the
     subscription-shaped run that previously failed open).
  4. Unpriced usage under a USD cap trips loud; the same fold without a
     USD cap does not; a zero-usage result folds nothing.
  5. Independence cuts both ways — each trip reason names ITS cap.
  6. The SEED path honors `maxTokens`: a journal whose usage rollup
     already exceeds the cap trips at seed time with the seeded-token
     reason, and a subsequent `admit` rejects with `budget` (the r1 review
     fix — the resumed-run path cannot dispatch past an already-overrun
     token cap).
- Driver conformance legs g/h (`test/driver/conformance.ts`): g asserts
  `costUSD` AND `costBasis` ABSENT for the unpriced canonical model (no
  basis without a cost, never fabricated); h asserts a present, finite
  `costUSD` labeled `costBasis: 'modeled'` for a priced model.

## 7. Disposition

**CLOSED** per plan §6 ("a debt may ship unresolved, it may not ship
unreviewed"): the mechanism shipped in T1.6b with the evidence above, the
modelling assumption is on record in §3, and the omissions have named
triggers in §5. The release PR cites this file.
