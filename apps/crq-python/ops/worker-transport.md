# Worker author transport (P4)

This is a separate, versioned SSH forced-command endpoint. It does not use the
promotion spool, modify signer files, install a service or start a reviewer.
Python's natural tick remains the only CLI issuer. P3 lease support must be
merged and deployed before this endpoint can admit work; older runners refuse
without writing an unleased request. No deployment is authorized by this PR.

The operator provisions a separate author-only SSH key, never the promotion
spool identity. Its authorized_keys entry uses `restrict` and a fixed command
that changes to the deployed runner root and executes
`/usr/bin/python3 -B -m author_transport`. Bind `CRQ_AUTHOR_REVIEW_POLICY` to the
operator-controlled policy file and `CRQ_AUTHOR_FALLBACK_REVIEWER` to the chosen
reviewer configuration in that fixed command/environment. Bind `CRQ_AUTHOR_TARGET`
to the sole operator-approved target (for example, the intended queue ref);
requests naming another target or missing this configuration are refused before
admission, preventing target aliases from charging twice for the same diff. Neither value is
accepted from the worker. No model or provider is hard-coded. Do not permit
arbitrary environment forwarding, PTYs, port/agent forwarding or a general shell.
The worker disables SSH connection multiplexing (`-S none`), so a shared master
cannot substitute another authenticated identity. It also sets `IdentitiesOnly=yes`
to exclude unrelated agent keys. Configure the alias with only the author key as
its `IdentityFile`; do not inherit additional `IdentityFile` entries. The exact SSH original command must be `author-v1`; spool commands are refused.

Configure the worker's `CQ_AUTHOR_SSH_ALIAS` for this separate identity. The CLI
uses the normal dotted-command flag grammar:

```sh
cq dev.review --action=enroll --requestId=branch-cycle-1 --base=<40hex> --head=<40hex> --target=origin/main --cycle=1 --json
```

Use `--action=status` with the same complete binding to observe the lease, and
`--action=fallback` to request the server's one-shot permission after its policy
deadline. This P4 command returns **admission**, not a completed review cycle;
it does not replace the review ledger/readiness orchestration. The chosen agent
may start only when a fallback response explicitly says `dispatch:true`.
SSH connection/initial handshake setup is limited to one 15-second attempt; the
client allows 45 seconds for that setup plus the server's 30-second operation
alarm. Configure a direct alias without interactive authentication or proxy
commands; unexpected authentication/network stalls still return an indeterminate
outcome. Timeout, disconnect, lock contention, malformed response, or `dispatch:false`
never authorizes any local CLI/agent run. Lost fallback replies sacrifice
liveness rather than duplicate an effect. Recover by inspecting the same
request; never create another request ID to bypass an uncertain outcome.

Wire v1 is one UTF-8 JSON object (maximum 8 KiB) followed by EOF:
`{v:1,op:enroll|status|fallback,binding:{request_id,base,head,target,cycle}}`.
Unknown fields/versions/operations and duplicate keys are refused. Both base
and head are immutable commits already available to the queue's review clone;
no worker path or shell fragment crosses the wire. For the versioned P5 tree
snapshot extension, see [tree-snapshots.md](tree-snapshots.md).
The response is exactly P3's version-1 lease decision with its immutable binding.
Every operation runs under the same `state/tick.lock`; enrollment only creates a
pending item, and P3 persists fallback before returning its permission. Existing
queue, run and spool bytes are unchanged; there are no new persisted fields.

Rollback removes worker access before withdrawing the endpoint. An old runner
does not support the endpoint and must not receive its requests. Existing P3
lease/state compatibility and uncertainty rules continue to apply.
