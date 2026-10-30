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

| Spec obligation                                         | Mechanism evidence | Operational evidence                      |
| ------------------------------------------------------- | ------------------ | ----------------------------------------- |
| Deadlock and unknown ownership                          | pending            | stale release pending ruling              |
| Schema, append validation, four history classes         | pending            | owner branch/ruleset pending              |
| Reproducible ranking and complete tier inventory        | pending            | deployed limits verification pending      |
| Positive and conservative negative line mappings        | pending            | retained history import pending           |
| Bounded A/B subjects, residuals, immutable pins         | pending            | production pins pending                   |
| Retry families, cooldown, generations, quarantine       | pending            | rollout pending                           |
| Concurrent quota reserve, ordinary priority, shared cap | pending            | rollout pending                           |
| Crash/restart publication and artifact recovery         | pending            | runner App publication pending            |
| Findings triage and idempotent repair delivery          | pending            | repair acknowledgement pending            |
| Required-list per-path outcomes                         | pending            | all 128 rows pending evidence             |
| Baseline/current debt and capacity reporting            | pending            | T0 and 14-day target pending              |
| Six-hour deterministic timer                            | pending            | installation/activation pending ruling    |
| Stage 2 integrated inventory                            | pending            | separate timer retirement pending rollout |

## Validation record

`pnpm test:narrow apps/crq-python/test_review_ledger.py` passed: 6/6 tests,
`test:narrow result="pass" exit=0 files=1 projects="python" tests="6/6"`.
The run used nice=5, load=1.0, uptime=1056943s. Local tests use only named
`pnpm test:narrow` files on triton under the canonical host lock. Required full
checks and suite authority belong to CI on the exact candidate. Vendor HOLD is
retained; launch failure will never be recorded as completed review. Final
independent exact-head R4 and changed-oracle acceptance route through Queue's
existing reviewer capacity.
