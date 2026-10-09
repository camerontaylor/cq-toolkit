# CRQ implementation status and file leases

Sole conductor/integrator: 00000000-0000-4000-8000-000000000002.
Owner authorization: W0–W5, local ops commits and safe single-runner queue-host handover.
Baseline: clean main da295ce; legacy addressing; worker-host schedule schedule-example;
no owned test jobs. Live checkout remains main da295ce until handover.
Implementation: /srv/operator/repos/worktrees/crq-implementation-20261009,
branch impl/crq-review-repair-20261009. No toolkit v11 board changes.

| Lane | Owner and exclusive lease | Status |
|---|---|---|
| W0–W4 and integration | conductor; crq.py/config/README/status/ops/repair modules | implemented; final independent source binding pending |
| W5 | 00000000-0000-4000-8000-000000000006; coverage.py, ops/coverage.md | original 44d01d293318248cd8ae6227dbae2c6355d72c55 integrated as 667a159 |
| Independent review | 00000000-0000-4000-8000-000000000005; read-only | fourteen findings corrected; final exact-head follow-up |
| Identity seam | 00000000-0000-4000-8000-000000000001; toolkit #293–295 only | separate owner; queue writes remain conductor-only |

Milestones: W0 696bb67; repair contracts 45108dc; W5 667a159; integrated W1–W4
a412643; restart/publication review corrections fef6b54. Keep all unpushed worktrees.
Source checks: Python AST parsing, Node syntax, whitespace checks. No tests,
probes, CodeRabbit reviews or paid repair jobs executed during implementation.

queue-host prepared: dedicated CRQ clone; dedicated toolkit runtime clone built from
2d58441298f52561167166a88797b72ceb33582b with pure build and dependency scripts
disabled. Installed user units stopped and static-verified (exit 0). Both configured
Paseo endpoints returned valid JSON with exit 0; CodeRabbit/GitHub auth status exit
0; Codex auth file present. No credential values read back or recorded. queue-host has
runner-disabled marker and no imported queue at this preparation checkpoint.

The runbook is [CUTOVER.md](CUTOVER.md). Runtime handover observations and deployed
exact head are persisted in [state/implementation-deployment.json](../state/implementation-deployment.json).
The independent final attestation is [state/implementation-review.json](../state/implementation-review.json),
with review history in [REVIEW.md](REVIEW.md). These runtime records can update
without changing the reviewed code head.

Model-free cutover: requires final source head/config delivery, old-run drain,
locked consistent state snapshot and worker-host inert proof before enabling queue-host.
Fleet-reader compatibility mirror is prepared (legacy and XDG worker-host paths point
to queue-host data without refreshing its tick timestamp). Signer custody/key is coordinated with
the parent/identity lane; no plain-shell spool fallback or inferred identity.
24-hour >=95% tick acceptance remains pending actual observations after cutover.

Repair-only activation prerequisites: existing spend authorization, named ZAI
credential (not found in checked secrets files), verified hard-budget launchers
for Codex/Paseo and verified read-only judge mode. Repair enabled=false throughout.
Spend/ZAI are not model-free tick handover blockers. No testing or probes, including
automatic follow-up dispatches, are authorized. Promotion override and pacing stay.

Signer dependency correction: original PR-A source exists on identity/cq-reviewer-signer
@ f43b48f; earlier missing source meant deployed/main tree only. Conductor owns
signer/ and shared record mapping; original runtime/unit/override/transport recovered
and hardened, source-only independent review in progress. No install/key/probe/activation.
