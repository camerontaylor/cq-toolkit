# Queue client protocol (Q3)

Stack parent/base: `queue/q1-merged-current` at
`c088ec6eb720d01d4c4739695ba71adc91384ef8` (Q1 documentation correction; preserving the frozen
`f3944022a8cebc622742c397cd7a756d818943cf` helper API). Queue baseline:
`1eea0b5b323de8b23a9388a72da4e97f8e631450`.

`queue-v1` is a separate forced-command capability. Deployment must explicitly
allow it; author-v1/v2 bytes and grants are unchanged. No credentials or custody
change is part of Q3. Old runners are unsupported and require a reviewed runner
capability deployment. No retry/drain or inline reviewer starts are provided.

The typed seam in `src/ops/review/internal/queueProtocol.ts` binds a stable
requestId to either merged-current provenance or a deferred-author intent.
Deferred intent carries repository, producer, immutable head, target branch and
target selector before PR publication. `enqueue` durably records `awaiting-pr`;
`bind` verifies forge repository/head/producer/target before attaching a PR
(`awaiting-merge`), and verifies the eventual merge before Q1 enrollment
(`ready-current`). Request replay must match the original binding. Cancellation
remains inspectable and never starts work. Q6 owns known-PR refresh/composition;
Q2 discovery is unnecessary for this lifecycle.

The operator supplies principal/repository/target and separate read/write
allowlists. No authority-bearing fields come from caller JSON. All frames,
including envelopes and newline, are at most 8192 bytes. Q1 immutable receipt
chunks carry at most 3072 raw bytes. The client verifies snapshot, order, count,
per-chunk and whole-document digests before import and consumption acknowledgement.
Queue evidence has its own versioned store; affected-current clean never supplies
full-branch readiness, independent acceptance or remediation completion.

## SDK and generated CLI

Import `makeConfiguredQueueClient` (uses operator `CQ_QUEUE_SSH_ALIAS`) or
`makeQueueClient(transport)` from the SDK review family. The client exposes
`enqueue(reference)`, `bind({...reference, pr, mergeSha?})`, `cancel(reference)`,
`status(reference)` and `report(reference, evidenceDir)`. Every call requires
the original immutable `{requestId, binding}`; a failed read creates no ID.
Producer is the forge PR author login; target is its base branch. Q6 owns the
known-PR refresh and unique author/head/base publication recovery. It preserves
server-only principal and delivery/consumption fields.

```sh
cq review.enqueue --requestId=missed-12 --binding='{"kind":"merged-current","repo":"owner/repo","pr":12,"mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","targetSelector":"promoted-main"}'
cq review.queueStatus --requestId=missed-12 --binding='{"kind":"merged-current","repo":"owner/repo","pr":12,"mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","targetSelector":"promoted-main"}'
cq review.report --requestId=missed-12 --binding='{"kind":"merged-current","repo":"owner/repo","pr":12,"mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","targetSelector":"promoted-main"}' --evidenceDir=.cq/queue-evidence
```

`review.enqueue --action=bind --pr=12 [--mergeSha=…]` attaches a deferred
binding; `--action=cancel` retains unpublished debt as cancelled. No positional
arguments or caller-selected remote paths/commands are supported. A command
success is distinct from review verdict. Stdout contains the I1 JSON artifact;
the generated CLI owns exit mapping and stderr narration.

Reports verify the entire receipt before create-only durable import and ack.
Interrupted readers restart at the manifest and safely replay bounded chunks;
server delivery progress survives caller restart. Local raw receipt bytes are
stored once as `<receipt SHA256>.json` in the chosen queue-evidence directory.
`readQueueEvidence(directory, receiptId)` validates both whole-document and
scope-manifest digest, returning the separate `cq-queue-evidence` v1 artifact.
It never writes a findings-v1 record. Each supported receipt is at most 64 MiB;
larger receipts refuse explicitly without truncation or acknowledgement.

Status separates enqueued/reviewed/consumed/fixed. `reason` is typed provenance
(`source`, `category`, `code`). Vendor continuation requires the runner's
`classification.failure_provenance` v1 proof with `complete: true` and a nonempty
`causes` list. Every cause must be exactly
`{source: "vendor", category: "vendor-rate-limited", code: "rate_limit"}`;
the runner sources this only from literal `errorType: "rate_limit"` plus
`recoverable: true`. Root and classifier outcomes must both be `rate_limited`,
both counted flags false, exit an integer 0 or 1, and `bad_lines` integer 0.
Missing, incomplete, malformed, mixed or unknown causes remain queue blockers.
Legacy outcome labels, prose, auth and unavailable guesses grant no vendor
continuation; older runners require the reviewed provenance producer update.
All error/action and hard causes must be retained by that producer. The proof
stays in the immutable receipt; status exposes one bounded reason.

Persistent Q6 `forge-identity` reasons project blocked
and prohibit receipt consumption until exact successful forge revalidation clears them. Full capture paths/findings are absent from status.
Receipt request IDs may name the original enqueue; durable alias bindings and
verified equivalence authorize reuse, never the cursor or original ID alone.

## Source capability deployment prerequisite

`apps/crq-python/capability_dispatcher.py` routes exactly `author-v1` to the
unchanged author transport and exactly `queue-v1` to the new capability. All
other commands refuse. It is source code only: Q3 changes no installed key,
credential, SSH configuration, signer or running service.

The operator provides `CRQ_QUEUE_PRINCIPAL` and an operator-owned JSON policy
path `CRQ_QUEUE_POLICY` through the existing trusted forced-command boundary.
Do not accept these environment variables from SSH clients. Example policy
keys: `enabled` (defaults false), `repo`, `read` and `write` principal lists,
`targets` selector list, `branches` forge base-branch list, `max_requests`
(default 10000). Both the dispatcher and transport validate policy types before
runner import or queue access: activation requires JSON boolean `true`; missing
or boolean `false` remains unsupported. Other activation types, non-object
policies, malformed repository/selector/capacity values, and allowlists that are
not arrays of nonempty strings refuse. Read covers status/report; write covers enqueue/bind/cancel/ack.
Requests are permanently principal/repository/source/target bound. Forge source
metadata is fetched with fixed API argv before attachment or Q1 enrollment.
The existing tick lock/process-group supervisor bounds each operation, and
queue state saves before a response. No reviewer dispatch occurs here.

D1C must review/activate that exact capability under existing deployment trust,
after compatible Q1 service/state and healthy dispatch. Disabled/old runners
return unsupported or a transport refusal with a deployment prerequisite.
Q3 source/test success alone does not establish activation or live acceptance.

## Operator activation (queue-v1)

Activation is an operator action under existing deployment trust. It changes no
runner code, signer or unit. Install exactly one restricted client identity per
calling principal:

1. Generate a dedicated client key on the calling host. The private key never
   leaves that host.
2. On the queue host, add one `authorized_keys` line for the account that owns
   the queue state. The line uses `restrict` and a fixed forced command, and sets
   the server-only principal and policy inside that command:

   ```text
   restrict,command="/usr/bin/env PATH=<cli-path> CRQ_QUEUE_PRINCIPAL=<principal> CRQ_QUEUE_POLICY=<policy.json> python3 <runner-root>/apps/crq-python/capability_dispatcher.py" ssh-ed25519 <public-key> <comment>
   ```

   Do not run the dispatcher with `python3 -I`: it imports its sibling transport
   modules. Never accept these variables from the client (`PermitUserEnvironment`
   stays off). `PATH` must resolve the CLI tools the runner uses for forge reads.
3. Create the policy file (mode 0600) disabled. Turn it on only for an approved
   window:

   ```json
   {"enabled": false, "repo": "<owner/repo>", "read": ["<principal>"], "write": ["<principal>"], "targets": ["promoted-main"], "branches": ["<base-branch>"], "max_requests": 50}
   ```

4. On the calling host, define the alias named by `CQ_QUEUE_SSH_ALIAS`. The
   transport passes its own non-interactive options but reads the user's SSH
   configuration, so make sure no catch-all `Host *` block adds other identity
   files, agent forwarding or connection sharing to the alias (for example
   `Host * !<alias>`). Check it offline with `ssh -G <alias>`: there must be a
   single `identityfile`, `forwardagent no` and `controlmaster false`.

Rollback: `"enabled": false` is the fast off. Otherwise-valid authorized requests
then return `unsupported` with no restart; malformed or unauthorized requests are
still refused earlier. For full rollback, revoke server authorization first by
commenting out the `authorized_keys` line, keep managed backups, then retire the
client key and alias. Queue requests and receipts are never deleted; deferred
debt stays inspectable and can be cancelled with `review.enqueue --action=cancel`.
