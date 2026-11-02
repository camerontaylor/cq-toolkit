# Backfill protocol implementation and acceptance

Authority: the approved revised spec retained in [inputs](inputs/provenance.json).
The implementation base and immutable review base are
`5dd1b34a357f2ce687fed264eeeb9564241ed34e`; intended PR target is
`origin/merge-queue`. Inventory targets promoted `origin/main` independently.

Execution order: validated ledger, durable artifacts and publication; scoped line
accounting and deterministic inventory; bounded immutable subject construction;
retry families and shared rank-4 admission; findings adapter; reports and inert
deployment artifacts. Each slice receives named offline acceptance tests before
integration. No source327/575/641/649 debt repair is claimed by this lane.

## Evidence boundary

Mechanism tests cannot satisfy owner branch/ruleset creation, no-live-run stale
release verification, privileged deployment, live vendor completions, baseline
burn-down, or exact-candidate CI. Those obligations remain explicitly pending.
No live vendor execution, timer activation, settings change or deployment is
authorized by this implementation task. No historical author CLI cycle grants
coverage. The superseded trace's commit-membership probe is not implemented.

## Acceptance matrix

| Spec obligation                                      | Named offline mechanism evidence                                                                                                                            | Operational evidence                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Deadlock and unknown ownership                       | `test_coverage`, `test_backfill_jobs`, `test_backfill`: terminal blocked releases execution; unknown/run retains it; exact release proofs                   | stale release pending ruling; Q32 oracle acceptance pending            |
| Schema, append validation, four history classes      | `test_review_ledger`, `test_backfill_history`: strict canonical schema, source conflict/deduplication, paginated source collection and conservative imports | owner branch/ruleset and actual history acquisition/import pending     |
| Reproducible ranking and complete tier inventory     | `test_backfill_inventory`: snapshot replay, all tracked objects, required rows/unions, tiers, ownership, churn and retry ordering                           | deployed limits verification pending                                   |
| Conservative line mappings                           | `test_backfill_accounting`: explicit diff intervals, surviving blame identity, edits/deletion/rename/copy/nonancestor refusals                              | retained production evidence pending                                   |
| Bounded A/B subjects and immutable pins              | `test_backfill_subjects`: target trees, multiple baselines, residuals, limits, literal untrusted context, pins after GC                                     | production pins and reviewer context consumption verification pending  |
| Retry families and quarantine                        | `test_backfill_jobs`, `test_backfill_inventory`: generations, cooldown, sibling failures, target moves and verified rename retention                        | rollout pending                                                        |
| Concurrent reserve, ordinary priority and shared cap | `test_backfill_jobs`, `test_backfill_runtime`: serialized admissions, fresh usage, outstanding reservations, terminal-window expiry and unknown launch      | vendor-terminal holds count as reflected after a later successful probe (#771); live holds stay subtracted |
| Publication and artifact recovery                    | `test_review_ledger`, `test_backfill_runtime`: real Git push race, lost acknowledgement, spool interruption, verified bundles and lost coverage cache       | runner App publication pending                                         |
| Findings triage and repair delivery                  | `test_finding_delivery`: threadless occurrences, stale anchors, explicit duplicates, acknowledged causal replay, idempotent repair inbox                    | production repair acknowledgement pending                              |
| Required-list per-path outcomes                      | `test_backfill_inventory`: all 128 rows, only explicit unions, missing source evidence remains pending                                                      | all rows pending actual evidence; no closure claimed                   |
| Baseline/current debt and capacity reporting         | `test_backfill_report`: surviving debt, removed/superseded lines, new debt and unresolved objects                                                           | T0 and conditional 14-day target pending                               |
| Six-hour timer and Stage 2                           | `test_backfill`: inert timer, shared locked CLI and explicit integrated mode                                                                                | install/activation and later timer retirement pending separate rulings |

## Validation record

Offline checks use named `pnpm test:narrow` selections on triton, nice=5,
under the canonical host lock. They use temporary local Git repositories and
fake provider/forge transports. No vendor review or production queue mutation
was performed. Exact command summaries and final head are recorded in the
handoff receipt. Earlier runs include 47/47 across seven mechanism modules,
34/34 across six modules, 16/16 across ledger/runtime/finding recovery, and
80/80 across historical collection plus unchanged existing `test_crq`.
Two earlier fixture setup failures (initial branch name and changed policy
between captures) were corrected and rerun; they were not mechanism passes.

Oracle change requiring final independent acceptance: `test_coverage.py` no
longer asserts that a blocked item always holds the global slot. Revised spec
§7 and Stage 1's deadlock acceptance explicitly require the opposite when no
live or unknown vendor execution remains. New negative cases retain capacity
for unknown vendor state or a persisted run. Q32 acceptance remains pending.

Static, formatting and Knip checks passed at the pre-handoff checkpoint.
Required full checks and suite authority belong to CI on the exact candidate.
Vendor HOLD is retained; launch failure never counts as completed review.
Final independent exact-head R4 and changed-oracle acceptance route through
Queue's existing reviewer capacity, currently unavailable. This implementation
has no independent PASS and is not ready to merge or activate.
