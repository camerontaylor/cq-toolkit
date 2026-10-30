# Backfill deployment and operational acceptance

This is a prepared runbook, not deployment authorization. No ledger branch,
ruleset, timer, vendor execution, stale release, or 14-day target has been
completed by fixture tests. Preserve source681/286/231, RI4, original98254f99
and M2 holds. Spare included quota only; no paid retry and no LLM launcher.

## Owner and Queue actions before activation

1. Obtain the independent exact-head R4 review, including explicit Q32 acceptance
   of the coverage blocked-item oracle change, and green required CI on the
   actual integration candidate. Resolve substantive findings. Queue must
   durably enroll this lane's author review debt under DEC1 while vendor HOLD
   applies; a launch, agent review, or enrollment is not vendor completion.
2. Owner creates `cq/review-ledger` as an empty orphan branch in
   `camerontaylor/cq-toolkit`, using a temporary local repository with an empty
   tree and an ordinary initial push. No existing branch may be overwritten.
   Record the resulting commit, branch creation receipt, runner App identity
   and installation ID. Implementation never creates this branch implicitly.
3. Owner installs the two rulesets in
   `policy/review-ledger-rulesets.example.json` through GitHub's repository
   rulesets API after substituting the runner App ID. The first ruleset has
   **no bypass actors**, so the App cannot bypass force-push/deletion protection.
   Only the second ruleset gives the App a writer bypass. Record both returned
   ruleset IDs, fetched final payloads and digests. Test an unauthorized writer
   refusal separately. Rulesets do not enforce add-only content; readers and
   publishers validate every ledger commit and halt on modify/delete/tamper.
4. Verify the deployed reviewer's actual file/diff-byte limits and scope evidence
   format. Commit exact limits, evidence location/digest and reviewer version in
   `policy/review-limits.json`. Its checked-in `verified: false` is intentional.
   The adapter requires a successful terminal `review_completed` event that binds
   `head` and explicit `reviewedFiles` entries `{path, blob, intervals}`. If the
   deployed reviewer only emits path names, **do not activate**: path names
   cannot establish line credit or whole-file completion. Supply a verified
   reviewer scope adapter under a separately reviewed change; never synthesize
   vendor scope from requested files. Confirm untrusted PR context is included
   in the reviewer input adapter; context cannot affect argv or scope.
5. Provision a private durable artifact volume with retention at least as long
   as every referencing ledger record. Keep it separate from transient `runs/`.
   Back up the operational queue, publication and findings outboxes. Git bundles
   retain target and synthetic object ancestry; raw vendor/import bytes and
   manifests are content addressed and verified before credit/recovery.
6. Deploy the reviewed runner through the existing
   [HOST-DEPLOY](../../apps/crq-python/ops/HOST-DEPLOY.md) controller and annotated
   runner-tag process. Drain and verify exact owned processes; preserve the
   queue/receipts and custody rules. Do not restart a live stale job to deploy.
   The existing helper renders new `crq-*` unit templates stopped. Unit files
   committed here are inert; installing them does not authorize starting them.
7. Separately record the operational ruling permitting rollout and exact
   no-live-run verification for `coverage-ab612ba1a041484d`. Keep the current
   queue digest, checked-at UTC timestamp, item identity, every associated run
   identity and liveness result. The `backfill.py release` command requires
   `--operator`, `--reason`, and `--evidence` naming an external JSON file with
   `item`, `vendor_state: terminal`, `exact_no_live_run: true`, `queue_digest`
   and `checked_at` no older than 60 seconds. A run still present or unknown
   refuses release. This command is prepared, never executed by this lane.
8. After these actions, provision `state/backfill-rollout.json` from the inert
   example with evidence references and a durable artifact path. Keep
   `enabled: false` while collecting/importing historical sources and reports.
   `backfill.py collect-history <external-catalog> --github` inventories local
   cycles, receipts and promotion ranges plus paginated GitHub-app reviews.
   `backfill.py import-history <external-catalog>` spools every source outcome;
   `backfill.py publish` validates and appends. Source gaps remain uncredited.
   Preserve catalog bytes, acquisition references and all four class counts.
9. Run `backfill.py inventory --report-only`; examine every tier, unsupported
   object, required-list path outcome and retained manifest. Pin T0 once with
   `backfill.py baseline`. Never overwrite the baseline to reduce debt. Obtain
   the separate activation ruling, set `enabled: true`, and use the existing
   systemd owner activation process to start the six-hour timer. No vendor work
   starts from the inventory script: only crq's locked ordinary admission path
   launches reviews, with a fresh usage observation, shared reserve and cap.

## Operational evidence after activation

Retain each admission's ordinary eligibility, usage observation, outstanding
reservations, decision, run identity and publication acknowledgement. Unknown
launches retain execution ownership; publication-pending jobs retain scope but
release the execution slot. Three failures block a generation; six consecutive
family/scope failures or auth/integrity/unsupported failures quarantine. Release
quarantine only with a reasoned operator record. Target/partition changes cannot
erase the path/family journal. Never spend another review to repair publication.

`latest-report.json` separates surviving baseline debt, lines removed/superseded,
new debt, current T1/T2 counts, unresolved objects, required-list outcomes,
publication/quarantine and finding delivery backlog. Record spare admissions and
completed partitions daily. At day 14, report remaining debt, exclusions,
capacity shortfall/failures and the capacity estimate; zero cannot be claimed
from removed lines, exceptions or fixtures. Strict T1 zero includes zero
unresolved T1 objects at the reported tip.

All findings enter triage, including threadless/unanchored occurrences. Use
`backfill.py triage` with an actor/reason against a newly fetched promoted tip;
only confirmed mapped anchors may be delivered with `backfill.py deliver`.
Delivery uses the existing repair inbox, never invents GitHub threads and never
dispatches a fixer. A receipt means delivered; `fixed` requires fixing commit
and verification evidence. Duplicate linking is explicit and preserves each
occurrence. These operations do not authorize the old draft posting workflow.

For Stage 2, after separately reviewed live evidence, set `inventory_mode` to
`integrated` and retire the separate timer through the owner runbook. Full ticks
then run the same inventory under the existing lock; the ledger remains the
authority. Stop new admissions on an integrity alert and retain all artifacts
and ownership until reconciled; do not restore an old queue snapshot.
