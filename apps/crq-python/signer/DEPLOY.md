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

## Ledger-only forced-command transport

Owner-provisioned only; no probe or installation here grants itself access.
Install the reviewed `spool-shell` root-owned mode 0755 at
`/opt/cq-reviewer/spool-shell`, beside the root-owned signer it dials. The
socket unit listens at `/run/crq-ledger-publish.sock` owned
`root:crq-ledger-publish` mode 0660. Owner provisioning creates a dedicated
publisher SSH principal in that group plus a separate runner-only key; never
reuse the promotion spool identity, and never add the promotion spool account
to the publisher socket group. The runner-only key's `authorized_keys` line on
the queue host uses the existing SSH restrictions and pins the forced command:

```text
restrict,command="/opt/cq-reviewer/spool-shell ledger-only" ssh-ed25519 <publisher-public-key> <comment>
```

With no arguments `spool-shell` refuses every verb; with `ledger-only` it
accepts only `ledger-publish <base> <head>` (two 40-hex commits) plus a bounded
bundle on stdin, and dials the ledger socket above. The ordinary promotion key
keeps its existing forced command and cannot invoke ledger publication; the
ledger-only key cannot invoke promotion verbs. Private key provisioning and
public-key registration stay owner-only. Stop the socket to disable new ledger
publication; retain all ledger/outbox records and let active connections finish.
