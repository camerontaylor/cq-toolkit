# Affected current-code reviews (Q1)

This operator seam queues a missed merged PR for the sole natural tick. It reviews
full affected files as they exist at a dispatch-pinned target, with explicit path
dispositions. Source PR/merge history supplies scope provenance. It grants no
repair, independent acceptance, deployment or promotion authority.

## Enqueue and inspect

From the runner checkout, using its existing operator authority:

```sh
python3 apps/crq-python/crq.py enqueue-merged --pr=42 --merge-sha=<full-source-merge-sha> --request-id=outage-pr42
python3 apps/crq-python/crq.py report --request-id=outage-pr42
```

Enrollment verifies the forge PR is merged into `merge-queue` with exactly that
merge SHA, binds the stable request ID in the existing queue under `tick.lock`,
and starts nothing. Repeating the same binding, including through another request
ID, returns the same intent. Reusing an ID with a different binding refuses.
The normal tick alone selects work, respecting pause, cooldown, starts/hour,
inflight capacity, dependency gates and the pre-upload scan. Selective `start`
refuses merged-current dispatch. Generic `requeue` refuses: consumed or ambiguous
work requires an explicit ownership/lineage decision through the coordinator.

The default selector is `promoted-main`: the tick fetches, then captures full
`origin/main` commit `T` and tree under its dispatch lock. It waits with
`not-yet-promoted` until the source merge is an ancestor of that target. An explicit
`--target-selector=merge-queue` chooses the different, potentially unpromoted
queue target. The captured target never follows later ref movement, including
across restart, failed attempts or receipt reads. Request replay cannot repin a
finished intent; a future fresh-target lineage needs its own explicit contract.

## Current scope and CLI feasibility

All source changed paths, including deletions and rename origins, receive
current dispositions. Current full regular text files are eligible even if no
original blame survives. Later renames require Git rename evidence; duplicated
identical rename candidates remain ambiguous. Deleted paths, empty files,
nonregular entries, binary/non-UTF8 content, paths the scanner cannot safely parse,
and content exceeding 256 KiB/file or 2 MiB total remain explicit dispositions.
No symlink/submodule dereference occurs. All-vanished scope returns
`no-current-code`, with zero starts and no counted vendor review. Unsupported
scope stays unsupported; mixed supported/unsupported results say `partial-scope`.

The projection is `current-affected-files/full-file-addition-projection`:
synthetic base `B` derives from `T` by removing only included current files;
synthetic head `H` restores their exact blobs and has tree exactly `T.tree`.
`B..H` contains only additions of those full current files. Historical removed
text and unrelated files are absent from the comparison. The full additions are
scanned before worktree/reservation/spawn. The runner retains the pair under
`refs/crq/current/<item-id>/`, the full manifest/blob/mode/byte dispositions,
manifest digest, policy, CLI version and equivalence identity.

Local feasibility observation on an authorized worker host: installed CodeRabbit CLI `0.8.2` help
advertises `review --agent --committed --base-commit <commit>`. The runner uses
that documented argv on its clean synthetic worktree. Only version/help were
invoked during implementation. Offline temporary Git fixtures prove the exact
projection, unchanged affected content, rename/deletion and target pinning.
**Real CLI functional acceptance remains pending D1** on the approved installed
runner and an authorized missed PR. No live provider exercise, deployment or
repair activation is claimed by this source change.

## Immutable paged reports

Before a receipt exists, `report` returns bounded pending/reviewing/blocked status
and the request/source binding. After harvest it returns a receipt manifest:

```sh
python3 apps/crq-python/crq.py report --request-id=outage-pr42
python3 apps/crq-python/crq.py report --request-id=outage-pr42 --receipt-id=<sha256> --cursor=<sha256>:0
```

Receipts live under `STATE/receipts/<sha256>.json`, within the existing queue
state. The immutable document is canonical UTF-8 JSON; its exact bytes determine
the receipt ID/SHA256. Publication fsyncs bytes and directory and never overwrites
an existing receipt. Harvest writes it before finishing the queue item; restart
before or after publication re-harvests the retained run idempotently. An unreadable
or tampered receipt refuses reuse/read. A caller disconnect or repeated report
read starts nothing and consumes no quota.

The manifest gives `version`, `receipt_id`, `sha256`, `bytes`, `chunks`, `encoding`
and first `cursor`. Each cursor-bound chunk carries its zero-based `index`,
`chunk_sha256`, base64 `data`, and `next_cursor` (null at the end). Decoded chunks
are at most 3072 bytes, leaving envelope space below the existing 8 KiB wire cap.
Individual findings are never truncated: even a finding over 8 KiB spans chunks.
Consumers verify snapshot identity, chunk order/count/digests and final byte count
and whole digest before treating consumption as complete. Cursors are bindings,
not authorization tokens. Q3 owns authorized transport, consumption and import;
existing strict author admission is unchanged.

The v1 document contains original `request_id`, `item_id`, `source`, `capture`,
`outcome`, `classification`, `counted`, complete `findings`, `run_id`, `started_at`,
artifact byte digests, `remediation=disabled/deferred`,
`independent_acceptance=false`, and `cli_functional_acceptance=pending-D1`.
Aliases bind through the durable request index; a reused receipt retains its
original source/request identity and `reused_from` remains visible in status.
`source` has repository, PR, merge SHA, target selector and scope policy.
`capture` has `target`, `tree`, `paths`, `scope_digest`, `policy`, `projection`,
`reviewer`, `reviewer_version`, `captured_at`, `equivalence` and, when reviewable,
synthetic `base`/`head`. Each path has `source_path`, `path`, `resolution`,
`disposition`, with current `blob`/`mode`/`bytes` and a reason where applicable.

A genuinely terminal stream produces `terminal-clean`, `terminal-with-findings`
or `partial-scope`. No-fresh, malformed/unrecognized events, errors, action
requests, missing/nonzero exit, nonterminal status and trailing events never earn
counted credit. Blocked attempts retain findings and truthful outcomes; scan
failure produces `blocked-secret-scan` without a vendor start. Rate limits retain
the global cooldown; authentication/action-required still pause the queue.

Equivalent captured target/tree/scope/policy/reviewer-version evidence can link
another intent to one verified immutable receipt without another vendor call.
Legacy synthetic records remain available but cannot establish current-only
coverage without that proof. Pending legacy merged items link to current-mode
recovery rather than launch a competing historical comparison; alive/ambiguous
legacy ownership is retained until safely harvested. Findings never enter
`cycles` or repair backfill in this mode and never become independent acceptance.

The pure `review_receipt.current_equivalence(capture)` API recomputes identity
from target/tree, complete paths, scope digest, policy, projection, reviewer and
reviewer version. It excludes capture time and synthetic commit IDs. Incomplete
legacy captures refuse. `reusable_current(document, capture)` additionally
requires a v1 terminal counted classifier and verifies the retained equivalence;
callers first verify immutable bytes through `read_receipt`. An original author
full-diff report, grant or lease alone cannot satisfy this current-content proof.
A partial-scope receipt retains its explicit omissions when referenced.
