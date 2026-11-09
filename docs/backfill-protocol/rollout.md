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
4. The reviewed `submitted-hunks-v1` adapter supports CLI 0.8.2 and 0.9.2
   names-only confirmation (`backfill_history.REVIEWER_FORMATS` accepts both
   versions). The child records its actual CLI version and clean submitted
   base/head, attempt, run and head-side hunk manifest before spawning. Harvest
   verifies those identities, recomputes hunks, binds the vendor base context and
   requires successful non-skipped terminal completion. Credit is limited to
   submitted hunks in vendor-confirmed files. Unlisted files remain debt;
   unsubmitted vendor paths, unknown versions or output formats refuse credit.
   Deleted or otherwise interval-free submitted paths earn no line credit.
   The active limits in `policy/review-limits.json` select reviewer 0.9.2;
   the observed real-vendor bounds and raw evidence digest behind those limits
   are recorded in `reviewer-verification-092-20261031.json`, with conservative
   limits below that observed successful submission. The older
   `reviewer-verification-20261031.json` record covers the 0.8.2 submission and
   remains as historical evidence. Historical
   names-only receipts without bound submission evidence remain uncredited.
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
   Compute `queue_digest` using `backfill.queue_digest_v1` on the exact current
   queue snapshot: sorted compact JSON, ASCII escaping, finite numbers only,
   SHA-256 over UTF-8 bytes. Keep the original snapshot with the evidence.
   Q49 prospectively treats a positively verified terminal quota-only refusal as
   deferred without adding failure counts. Preserve consumed attempts, existing
   failures and reservations, and enforce all applicable cooldowns; unknown or
   conflicting run evidence remains held. No quota refund or review credit follows.
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

Inventory keeps a disposable `state/backfill/required-cache/<pr>.json` index
pointing to content-verified acquisition results in the durable artifact store.
Each entry is bound to the exact inventory target, freshly fetched PR response
and accounting-cache version. An unchanged second inventory reuses required-PR
path mappings without Git lineage work. A new target or changed forge response
recomputes them. Missing, malformed or stale index entries fall back to normal
acquisition; removing this index does not remove review evidence or coverage.
Only one current pointer is kept per required PR. The pointer is disposable;
the object it points to is not. Each recomputation keeps one more
content-addressed object in the durable artifact store, and nothing collects it
once the pointer moves on. Because the target changes on most runs, that is up
to one object per required PR per six-hour run. Durable-store collection is a
later operator task (#1064). Step 5 above retains artifacts at least as long
as every referencing ledger record; no ledger record references these objects,
only the disposable pointer does. Bump `LINEAGE_RESULT_EPOCH` in
`backfill_accounting.py` when lineage result semantics change, so that old
pointers stop matching. Historical lineage still
rejects intermediate deletions and ambiguous renames, including for coverage
and ownership carry callers. Its parsed first-parent steps are invocation-local
and bounded to 32 MiB. Between lineage endpoints, full trees are read only when
a relevant rename needs blob-uniqueness checks, not for unrelated edits at
every commit.
Inventory also keeps a disposable cross-run fact index at
`state/backfill/inventory-cache/facts/<kind>/<key>.json`. Its kinds are
first-parent lineage steps, path lineage, blame at a commit, carried line
mappings, verified review credit, and gap-free coverage per target and review
set. Every key includes only immutable object IDs, accounting options,
`backfill_cache.VERSION`, and a salt of the runner's `git --version` and
`LINEAGE_RESULT_EPOCH`. Upgrading git therefore invalidates every fact. Values
live in the artifact store and are verified on read: the index must point at an
in-store object whose bytes match its digest and whose embedded key matches.
Each kind's value shape is checked too, and a mismatch counts as a miss and is
recomputed. A run after `main` moves therefore repeats only the work for the new
target. Failed verifications and coverage with gaps are never stored. A cached
credit hit restores the review's bundles again if its target commit is missing
from the clone. Deleting the index is safe; bump `VERSION` when the meaning of
a fact changes.
Fact values are not collected (bounded prune not implemented here). One cold
inventory on frozen production state stored about 6.5k facts: 2.5k blame,
1.8k lineage, 1.6k carry, 0.6k lineage steps and 27 verified credits. Later
runs add only facts for new commits and targets, so growth follows history
churn rather than run count. Deleting the index frees no store bytes.
Collection or relocation is tracked in #1064.
The six-hour timer and 45-minute service timeout are unchanged.

All findings enter triage, including threadless/unanchored occurrences. The
repair drain's automatic triage phase checks the freshly fetched promoted tip
before repair selection. It handles deleted paths and exact duplicates first,
then judges up to `repair.triage.max_per_pass` findings (default 6), majors
first, using the configured triage role and provider fallbacks. Both
`untriaged` and `needs-retriage` findings are eligible. Provider limits leave
pending work for a later pass. `--triage-dry-run` runs triage only, without
recording events or delivering findings; use it for rollout evidence before
live enablement. This documentation change does not enable or deploy triage.

Only confirmed, verified current anchors of critical, major or minor severity
enter the repair inbox automatically. Canonical minor findings use the same
current delivered-receipt checks in normal drain and prepared selection;
legacy minor jobs remain excluded. Triage
never invents GitHub threads. Ambiguous judgements remain `needs-human`.
The inventory report's `finding_triage` and `crq status` show current counts by
status and the needs-human list (finding ID, canonical ID, path, title,
severity, target and event ID). Status previews retain at most 32 needs-human
entries and report `needs_human_count` and `needs_human_omitted`; durable rows
and inventory reports retain the full list. Malformed rows do not stop status
publication: `error_count`, a bounded `errors` list and `errors_omitted` expose
them, and `counts_complete: false` marks counts as partial (valid rows only).
The needs-human count is also partial in that case. Inventory remains strict
on malformed rows. The event ID links to the retained decision
evidence. Counts describe occurrences, including duplicates, rather than
unique repair jobs. `backfill.py triage` with an actor/reason remains the
operator override, and `backfill.py deliver` remains available for confirmed
findings. A receipt means delivered; `fixed` requires fixing commit and
verification evidence. Repair outcomes write back into the same finding-event
chain: merged fixes become `fixed`, stale jobs need retriage, invalid findings
are dismissed, and failures remain visible as `needs-human`. Duplicate linking
preserves each occurrence. These operations do not authorize the old draft
posting workflow.

For Stage 2, after separately reviewed live evidence, set `inventory_mode` to
`integrated` and retire the separate timer through the owner runbook. Full ticks
then run the same inventory under the existing lock; the ledger remains the
authority. Stop new admissions on an integrity alert and retain all artifacts
and ownership until reconciled; do not restore an old queue snapshot.
