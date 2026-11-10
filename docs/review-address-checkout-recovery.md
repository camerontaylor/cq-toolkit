# Recovering a review checkout

Stop admissions from old binaries before migrating their state. Establish that
all writers have stopped, including opaque children, before clearing a slot. If
you cannot establish quiescence, leave the slot incomplete and investigate.
Preserve candidate directories, reports, outstanding work and failed-attempt
refs; do not invent authenticated receipts for that work.

If bulk `review.addressMany` reports `legacy review checkout requires direct
reconciliation`, run `cq review.address --repoRoot=<source> --source=pr:<number>`
for that PR before retrying the bulk run. Direct address checks the legacy
checkout against the current PR head; if it refuses a stale or unsafe checkout,
preserve the checkout and reconcile it using the steps below.

Use the matching deployed toolkit build. List every participating persistent
slot from the report and saved metadata, in original PR, resolver PR, then
checkout order. For a local-only run, list its checkout slot alone. Do not
delete stale lock files or edit metadata by hand.

```sh
CQ_RECOVERY_LOCKS='["/absolute/source/.git/cq-review/slots/pr-123.lock","/absolute/clone/.git/cq-review/slots/pr-123.lock","/absolute/clone/.git/cq-review/slots/checkout-<64hex>.lock"]' \
CQ_RECOVERY_CHECKOUT=/absolute/checkout CQ_RECOVERY_MODE=inspect \
node scripts/recover-review-checkout.mjs
```

Inside the held shell inspect the actual paths and refs. `lsof` and `fuser`
are diagnostic only: they may show the recovery process and cannot prove that
an opaque writer is absent.

```sh
lsof /absolute/source/.git/cq-review/slots/pr-123.lock
# Linux alternative:
fuser /absolute/source/.git/cq-review/slots/pr-123.lock
git -C /absolute/checkout status --porcelain=v1 --ignored --untracked-files=all
git -C /absolute/checkout log --branches --not --remotes
git -C /absolute/checkout for-each-ref refs/cq-review/
git -C /absolute/checkout for-each-ref --format='%(refname) %(objectname)' refs/heads
git -C /absolute/source worktree list --porcelain
# Only after reconciling the intended clean checkout:
git -C /absolute/source worktree remove /absolute/checkout
exit
```

Inspect partial clone or target paths and saved reports for unbound or
partial-add state; do not run Git inside an absent directory. Failed attempts
are under `refs/heads/<runPrefix>/failed/.../aN`; match them to reports and
preserve them. Pin outstanding work before reconciling or removing only the
intended clean checkout using non-forced Git operations.

Inspect mode never clears metadata. Run the same command again with all the
same locks and checkout and mode `retain` or `removed`; inspect and reconcile
again inside that invocation's held shell. After closing it, acknowledge
`quiescent-and-reconciled` only after establishing actual writer quiescence.
An unsuccessful shell or missing acknowledgement reports an error and leaves
metadata unchanged.
The recovery script verifies retained checkout identity and cleanliness before
writing bound/false, or path absence before writing unbound/false, then closes
its descriptors. An earlier inspection does not authorize a later clear.
