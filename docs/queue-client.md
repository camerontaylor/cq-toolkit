# Queue client protocol (Q3)

Stack parent/base: `queue/q1-merged-current` at
`f3944022a8cebc622742c397cd7a756d818943cf`. Queue baseline:
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
