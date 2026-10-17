# Tree snapshots (P5, work in progress)

Baseline: promoted P3 `57220fd757d26bfd4f43fcd8997ae253f5c2ddec`.
P4 worker transport is PR #332; it must merge before the transport extension.
The characterization tests record the current behavior before implementation:
commit objects plan without fetching; a raw tree OID currently passes the
40-hex admission shape but cannot plan as a commit and waits without dispatch;
an enrolled commit binding cannot be replaced by a tree binding.

The implementation will preserve v1 commit requests and existing persisted
bytes. Tree requests need a new, explicitly versioned envelope and immutable
snapshot metadata. A deterministic synthetic commit must bind the full tree to
the chosen base so the existing committed-review path can run unchanged.
Changing contents must change that identity. Workers must not alter HEAD,
their real index, or working files when capturing an immutable snapshot.

Client and Python server must ship at one SHA and be wire-tested together.
Transport remains the separate author endpoint, never the promotion spool.
Validate object types, base, tree, synthetic parent and payload digest before
admission. Bound transfer size, processing time and materialized object size;
quarantine imported objects until verification completes. Pin admitted objects
against garbage collection for the review/recovery lifetime. A malformed,
partial, conflicting or unscanned transfer must never create a pending request
or authorize fallback. Perform the operator's pre-upload secret scan before
transmitting snapshot content, and keep the runner's existing scan before any
review upload. Do not execute commands or hooks from snapshot content.

Enrollment and any persisted snapshot metadata remain under tick.lock. Reuse
P3 leases, timeout policy, quota reservations and recovery: the transport does
not start a reviewer, and a lost reply is not permission to retry a side effect.
Python remains the sole issuer. No signer, spool, service or deploy changes.

Before a draft PR: preserve the commit-path characterization, test real worker
capture through Python admission and planning, test corrupt/oversized/missing
objects, different trees under one request, concurrent delivery, interrupted
transfer and cleanup, then run one CodeRabbit CLI cycle with dispositions.
Only pnpm test:narrow is used for local tests. Nothing is deployed by P5.

Current slice adds characterization and this design only. No snapshot wire or
state changes are active, and tree transport is not yet implemented.
