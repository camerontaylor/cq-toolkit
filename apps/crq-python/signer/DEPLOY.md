# Review-ledger publisher deployment

The promotion daemon is retired. Follow the normal drained runner switch in
[HOST-DEPLOY.md](../ops/HOST-DEPLOY.md) as the runner user on queue-host, only after the
coordinator confirms direct-main merges. Stop and disable the system
`crq-signer.service` and drain its review child before installing the reviewed,
root-owned `/opt/cq-reviewer/crq-signer.py`. Verify its hash against the reviewed
commit. Preserve keys, validators, ledger records, outboxes, and the independent
root ledger socket/service. The executable now accepts only `ledger-publish`.
Do not invoke retired probe/override commands. Preserve queue and heartbeat
bytes across the runner switch; resume user timers and observe completed ticks.
Legacy private overlay promotion keys remain accepted but enable no activity.
