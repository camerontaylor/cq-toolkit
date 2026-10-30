# Review and integration handoff

Candidate branch: `work/coderabbit-backfill-integration-20261030`.
Immutable base / intended target merge-base:
`5dd1b34a357f2ce687fed264eeeb9564241ed34e` against `origin/merge-queue`.
Implementation candidate before this receipt:
`f65bb69d5ced818ce6680f9641cd504be2dcdda1`.
Final receipt commit identity is supplied separately to Queue; acceptance must
bind that final head, including explicit Q32 oracle acceptance.

## Publication boundary and custody

The original implementation branch is LOCAL ONLY. Its local incremental commits
`6e1d1b25`, `fffd2676`, `ebeb6bf0` preserve execution evidence and original input
history. The pre-upload scan found 16 forbidden internal hostname/personal-path
matches in original input snapshots/provenance, and zero Gitleaks findings.
Original bytes were verified against the recorded hashes and moved to private
input custody. Published provenance retains relative source names, original
research head and digests. No evidence was destroyed and no history rewritten.

The integration branch was created in a new isolated worktree from the immutable
base, then the clean final binary diff was applied and committed ordinarily.
Its implementation tree exactly equals the original final implementation tree.
No original evidence-bearing commit is an ancestor of this clean candidate.
No push, live review, GitHub setting, ledger branch, timer installation or vendor
execution occurred. The final clean implementation patch passed the existing
repository denylist scanner and Gitleaks (zero hits each).

## Exact local command summaries

Commands ran on triton with named canonical tests, nice=5 and the host lock.
Full suites, builds, providers and credential/network access were not used by
these tests. Commands below are historical results from the initial implementation tree,
not evidence for later successor commits. Full exact-head CI remains authoritative.

```sh
pnpm test:narrow apps/crq-python/test_review_ledger.py apps/crq-python/test_backfill_accounting.py apps/crq-python/test_backfill_inventory.py apps/crq-python/test_backfill_subjects.py apps/crq-python/test_backfill_jobs.py apps/crq-python/test_backfill_history.py apps/crq-python/test_coverage.py apps/crq-python/test_backfill_runtime.py apps/crq-python/test_backfill_report.py apps/crq-python/test_finding_delivery.py
```

`test:narrow result="pass" exit=0 files=10 projects="python" tests="63/63" failed=0 skipped=0 wait="0.0s" duration="10.1s" nice=5 load="0.8" uptime="1059172s" source="explicit"`.

```sh
pnpm test:narrow apps/crq-python/test_backfill_history.py apps/crq-python/test_crq.py
```

`test:narrow result="pass" exit=0 files=2 projects="python" tests="80/80" failed=0 skipped=0 wait="0.0s" duration="14.4s" nice=5 load="0.4" uptime="1059011s" source="explicit"`.

```sh
pnpm test:narrow apps/crq-python/test_backfill.py
```

`test:narrow result="pass" exit=0 files=1 projects="python" tests="3/3" failed=0 skipped=0 wait="0.0s" duration="0.1s" nice=5 load="0.9" uptime="1059328s" source="explicit"`.

```sh
pnpm run check:static
pnpm run format:check
pnpm run knip
```

All exited zero: static ratchet 0 <= baseline 0; formatting matched 871 files;
Knip reported no findings. The explicit `pnpm fix` docs/JSON invocation formatted
its selected files but exited one because it had no lintable files; it is not
reported as a lint pass. Earlier fixture setup failures and corrected reruns are
retained in the implementation record.

In the fresh integration worktree, `pnpm fix` automatically performed a warm
dependency symlink bootstrap before formatting two owned files (79ms, already
up to date). No explicit install or build was requested and no tracked package
or lockfile changed. This readiness side effect was reported to Queue; it is
not presented as an authorized build or a verification result.

```sh
git diff --check 5dd1b34a357f2ce687fed264eeeb9564241ed34e HEAD
git diff --check --cached
git diff --check
```

All passed before the implementation commit. Final receipt checks are supplied
through Queue with the final head. Only CI is full-suite authority.

## Ownership and remaining acceptance

Debt group source327/575/641/649 remains unassigned for later deduplication.
Existing `crq.py` regions changed: imports, `build_synthetic`, `plan_merged`,
`inflight`, `launch`, `harvest_review`, `rank`, new `ordinary_review_eligible`,
`coverage_fallback`, `start_one`, `admit_available`, `tick`, synthetic CLI action.
`coverage.py` changes only the rank-4 active-owner guard. New backfill modules,
ledger, tests, policies and these implementation docs belong to this lane.
No signer, watchdog, narrow-runner, TypeScript runtime, protected-path source,
frozen source681/286/231/RI4 or unpublished original test expectations changed.

Q32: `test_coverage.py` changes the old unconditional blocked-capacity expectation
under approved revised spec section 7 / Stage 1 deadlock acceptance. Terminal
blocked/failed/quarantined jobs release execution; persisted runs and unknown
vendor state continue to hold it. Independent exact-head explicit oracle
acceptance is REQUIRED and remains pending. No implementation-output oracle is
being offered as authority.

Queue must arrange durable DEC1 author-review enrollment while the included-quota
vendor HOLD applies. There is no completed CLI cycle. Existing independent
reviewer capacity is unavailable; no replacement, retry, provider switch or
independent PASS is inferred. Final independent R4 and exact-candidate CI are
pending. This lane is not ready to merge or activate.

Owner actions and evidence are concrete in [rollout](rollout.md): branch/rulesets,
reviewer limits and explicit terminal scope adapter capability, durable artifact
volume and App identity, privileged deployment, exact no-live-run verification,
history imports, immutable T0, activation ruling, live delivery evidence and
conditional 14-day progress. Checked-in limits remain unverified and dispatch
fails closed. Fixture passes do not close operational targets.

## Proposed PR description

Title: `feat(crq): Implement scoped review backfill protocol`

Backfill now reviews bounded current-code subjects at a pinned promoted tip,
credits only explicit authenticated reviewed intervals, and retains durable
append-only review and finding evidence. Terminal blocked coverage work releases
execution capacity while unknown vendor ownership remains held. Deterministic
inventory, safe A/B projections, retry families, shared quota reservations,
history import, repair delivery and baseline/current reporting use the existing
locked runner admission path.

The rollout remains inert. Owner branch/ruleset creation, deployed reviewer
limits and terminal scope capability, privileged deployment and activation
require the evidence in the rollout runbook. Independent reviewers should focus
on credit mappings, append/publication recovery, quota ownership, and the Q32
blocked-capacity oracle change. Named offline checks pass; vendor debt enrollment,
independent exact-head acceptance and candidate CI remain pending.
