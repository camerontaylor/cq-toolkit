# CRQ implementation status and file leases

Sole writer/integrator: conductor 00000000-0000-4000-8000-000000000002.
Owner authorization: implement W0–W5 from 2026-10-09 plan, local commits.
Baseline: clean main da295ce; legacy addressing; worker-host schedule schedule-example active;
no owned test processes observed. Branch impl/crq-review-repair-20261009.

| Lane | Owner | File lease | State |
|---|---|---|---|
| W0–W4 integration | conductor | crq.py, config.json, README.md, status_summary.py, ops/systemd, repair modules | W0 preparing |
| W5 | 00000000-0000-4000-8000-000000000006 | coverage.py, ops/coverage.md only | isolated worktree /srv/operator/repos/worktrees/crq-coverage-20261009 |
| Final source review | pending | read-only | after integration |

All testing suspended, including automatic follow-up steps and model probes.
Runtime repair dispatch must remain disabled until existing spend authorization
is verified. No independent CodeRabbit consumption. No webfront access.
No toolkit v11 board changes. Keep unpushed worktrees.

W0 acceptance requires 24 hours of observations; cannot be claimed at cutover.
Current deployment: worker-host active; queue-host has no CRQ clone/timers and no cq binary
on PATH. SSH access works; Python and GNU timeout available. Handover not executed.
