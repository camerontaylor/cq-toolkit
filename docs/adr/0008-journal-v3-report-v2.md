# ADR-0008 — Journal v3 + report v2 batched contract amendment

- **Status:** proposed contract amendment; owner rulings recorded 2026-11-02; implementation follows separately
- **Date:** 2026-11-02
- **Amends:** ADR-0003 and its journal/approval annexes; report payloads under I1; complements ADR-0006 and ADR-0007
- **Evidence pin:** main `6885bced3843260642aece2ff7b8b975ca293e30`. Source citations below describe that snapshot, not completed implementation of this ADR.

## Context and evidence

The contract is opened once, before 0.2.0, for provenance, identity, attempt accounting,
verdicts and measurement. This document changes no source, required check, lock,
approval requirement or role. Existing authorization remains authoritative; new events
observe its decisions. The two-tier worker → rescue ladder stays unchanged, with no
new fan-out; rescue yield must be measured before changing it.

Current evidence at the pin:

- [src/kernel/types.ts:42](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/types.ts#L42) defines the five I1 statuses. [src/kernel/schema.ts:84](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/schema.ts#L84) mirrors them strictly; [policy/DOCTRINE.md:8](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/policy/DOCTRINE.md#L8) permits a JSON-lossless report on any status. These statuses remain `ok | failed | needs-human | budget-exhausted | indeterminate`. Flaky means `indeterminate` with a journal reason, never `FLAKY`.
- [src/kernel/types.ts:253](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/types.ts#L253) defines journal v2 events; [src/kernel/journal.ts:1061](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/journal.ts#L1061) folds absent-version v1 before sequenced v2. [docs/adr/0003-journal-migration.md:17](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/docs/adr/0003-journal-migration.md#L17) specifies strict schemas, complete-line validation, reservations and crash replay. The new version retains those safety semantics.
- [src/kernel/manifest.ts:74](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/manifest.ts#L74) currently hashes canonical `{input, op}`; [src/kernel/runner.ts:1761](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/runner.ts#L1761) skips only matching op/hash successful results. Hashing path-bearing input cannot support run-invariant re-drive.
- [src/ops/gates/fingerprint.ts:1](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/gates/fingerprint.ts#L1) uses position buckets or message/test-name keys and compact FNV display hashes; [src/ops/review/findings.ts:116](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/findings.ts#L116) deduplicates positioned review findings by file + line + rule. [src/ops/ledger/ledger.ts:36](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/ledger/ledger.ts#L36) stores version-1 signature counts. These are distinct current regimes, not the new shared identity.
- [src/ops/sweep/taskLoop.ts:36](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/sweep/taskLoop.ts#L36) already records tier, model, optional usage, wall and free-text reasons, but lacks the classed stop and per-attempt budget contract. [src/ops/fix/runFix.ts:58](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/fix/runFix.ts#L58) already has planned rows, counters and a numeric fixesPerRun; [src/ops/fix/report.ts:73](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/fix/report.ts#L73) includes undispatched units. The amendment refines the metric rather than claiming planned coverage is wholly absent.
- [src/ops/review/findings.ts:60](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/findings.ts#L60) already permits fixed/rejected/deferred with optional reason/evidence; [src/ops/review/address.ts:104](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/address.ts#L104) aggregates review rounds. Durable ownership, review triggers and exact-head acceptance need the contract below.
- [docs/adr/0006-fix-engine-cli-compositions.md:22](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/docs/adr/0006-fix-engine-cli-compositions.md#L22) places retries and escalation in compositions, not the kernel. [docs/adr/0007-fix-task-identity.md:8](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/docs/adr/0007-fix-task-identity.md#L8) already specifies digest extension and full-identity verification.

## Identity and replay

Intra-run review dedup stays file + line + rule (existing fallback remains for
unpositioned findings). Cross-run matching uses one `FindingFingerprint` object:
`{version, checkId, rule, path, spanContentHash}`. The regression gate, ledger v2,
ratchets and `review.address` re-review use the same versioned canonical tuple;
compact hashes alone are not equality proofs. Counts retain multiplicity.

Paths are repository-relative with POSIX separators. `checkId` names the configured
check; `rule` is its rule identifier or null; `spanContentHash` hashes pinned span
content, excluding line coordinates. Locationless diagnostics need an adapter-defined
stable content span (for example full test identity), not a guessed line. Missing
content is unknown and cannot prove equality. The initial fingerprint version is 1;
its implementation must publish canonical byte encoding and adapter span extraction
fixtures together. The dispatch registry fixes the version-bump rule; different versions never silently
match. Migration may recompute from pinned blobs, otherwise retains legacy identity
as legacy evidence, without suppressing a new finding on an unproved match.

`inputsHash` is content-keyed: canonical semantic input includes op, base SHA, task
identity, check-config hash, and candidate tree hash where relevant, plus every other
behavior-affecting input. It excludes worktree cwd, journal/report paths and run UUID.
Operational locations remain available for execution. A declared hash version prevents
legacy hashes from enabling new replay skips. This changes replay identity, not the
workspace binding or state checks on an approval token; approvals are never portable
merely because semantic hashes match.

**R1 reconciliation note:** ADR-0007 satisfies the identity-safety purpose of R1:
readable normalized prefix plus digest, exact raw-identity verification, and refusal
when uniqueness cannot be established. The literal residual difference is that it
extends conflicting short digests instead of immediately refusing. Keep ADR-0007's
existing extension/refusal behavior; do not introduce a second naming rule. Attempt
ordinals advance only for the same verified identity, never as collision suffixes.

## Wire fields and ownership

The following is the target wire contract. `SHA` is a Git object ID; `Hash` is a
versioned content digest; `Count` is a nonnegative integer. `null` means unknown,
never zero. Every row inherits the migration and version rules in §Migration;
**J** means journal v3, **R** report v2, **F** fingerprint v1, **H** hash v2.
Nested names are scoped to the containing record, not top-level OpResult keys.

| Field / type                                                                                                                                                                              | Producer                                                        | Consumers                                                         | Migration / version                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `journalVersion: 3`, `reportVersion: 2`                                                                                                                                                   | journal writer; report assembler                                | parsers, replay, report readers                                   | J/R discriminators; never reinterpret v2 journal or old report as new                                     |
| `provenance.cqVersion: string`, `cqJsonHash: Hash`, `baseSha: SHA`, `runPrefix: string`                                                                                                   | run-start resolver; copied to report                            | replay diagnostics, audit, attribution                            | J/R; legacy provenance unknown; hash effective cq.json content, not filename                              |
| task `changed: boolean`                                                                                                                                                                   | task loop comparing pre/post candidate content                  | report, re-drive, nochange rendering                              | J/R; legacy unknown; a failed attempt can change content without being fixed                              |
| fingerprint `version: 1`, `checkId: string`, `rule: string \| null`, `path: string`, `spanContentHash: Hash \| null`                                                                      | shared adapter/fingerprint module                               | regression, ledger v2, ratchets, re-review                        | F plus J/R carriers; legacy identity retained separately; recompute only with evidence                    |
| `inputsHashVersion: 2`, `inputsHash: Hash` with semantic `baseSha: SHA`, `taskId: string`, `checkConfigHash: Hash`, `candidateTreeHash?: SHA`                                             | manifest semantic-input builder                                 | replay skip, re-drive; future cache only if separately authorized | H/J; old hashes stay readable but never satisfy H2 equality                                               |
| gate `gate: string`, `verdict: 'pass' \| 'fail' \| 'indeterminate' \| 'needs-human'`, `bail?: string`, `fingerprintVersion: number \| null`                                               | check runner / validation composition                           | task loop, journal, report                                        | J/R; old gate names/reasons retained, unavailable version null                                            |
| attempt `model: ModelSpec \| null`, `tier: 'worker' \| 'rescue'`, `tokens: Count \| null`, `wallMs: number \| null`                                                                       | driver result and monotonic attempt clock                       | report, per-tier yield, cost analysis                             | J/R; copy known legacy usage, never infer missing tokens as zero                                          |
| attempt `stopReason: string`, `class: 'retriable' \| 'terminal' \| 'infrastructure' \| 'budget' \| 'human'`                                                                               | attempt boundary classifier                                     | retry policy, residue, measurement                                | J/R; legacy text retained, unclassifiable history stays unknown in adapter                                |
| event `type: 'approval-granted' \| 'approval-expired'`, `approvalId: string`, `reason: string`                                                                                            | existing approval authority for granted only; expiry reserved   | journal audit, report diagnostics                                 | J; expiry reserved, no raw token or signature material; absent legacy event proves nothing                |
| event `type: 'write-path-denied' \| 'write-path-cap-tripped'`, `path: string`, `reason: string`, `cap: Count \| null`, `observed: Count \| null`                                          | taskLoop/addressWorker path-policy refusals; cap event reserved | journal, task residue, report                                     | J; cap event reserved, redacted repo-relative path; legacy absence is not authorization                   |
| disposition `fingerprint: FindingFingerprint`, `status: 'fixed' \| 'rejected' \| 'deferred'`, `reason: string`, `owner: string`, `evidence: string[]`, `reviewTrigger: string \| null`    | address adjudicator                                             | durable findings artifact, report, later review                   | J/R; required for new terminal dispositions; deferred requires nonempty trigger; legacy omissions unknown |
| acceptance `headSha: SHA`, `reviewedBaseSha: SHA`, `reviewerId: string`, `authorId: string`, `independent: boolean`, `verdict: 'PASS' \| 'HOLD' \| 'RETRACT'`, `evidence: string[]`       | independent reviewer evidence importer                          | report and existing acceptance verifier                           | J/R; never infer legacy independence; stale head cannot accept a later head                               |
| review scope `baseSha: SHA`, `headSha: SHA`, `findingFingerprints: FindingFingerprint[]`, `coverage: string`                                                                              | review producer                                                 | re-review denominator, acceptance audit                           | J/R; legacy incomplete scope explicit, empty set only when known empty                                    |
| metric `metric.fixesPerRun: {numerator: Count \| null, denominator: Count \| null}`, `metric.verifiedCommits: SHA[]`, `metric.baselineFailures: {unitId: string, count: Count \| null}[]` | run assembler using verifier + baseline probes                  | JSON report, human rendering, offline monthly roll-up             | R/J summary; old scalar retained only in legacy projection, never relabeled as this ratio                 |

The measurement handoff adds the following nested payloads to the same J/R
carriers, with the same strict-reader migration and version rules. Each legacy
omission uses the availability record below; no historic evidence is invented.

| Field / type                                                                                                                                                                                                                                                    | Producer                                                                                                           | Consumers                                          | Migration / version                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| provenance `producerVersion: string`, `repoId: string \| null`, `startedAt: string`, `endedAt: string \| null`, `journalLink: string`, `reportLink: string`                                                                                                     | run resolver and completion writer                                                                                 | offline attribution, report audit                  | J/R; legacy links/times only if observed                                                                                                                                 |
| witnesses `base: SHA`, `admitted: SHA \| null`, `execution: SHA \| null`, `reviewed: SHA \| null`, `accepted: SHA \| null`                                                                                                                                      | admission, execution, review and acceptance boundaries                                                             | stale-state diagnosis, report                      | J/R; preserve distinct witnesses, never copy one into an unobserved other                                                                                                |
| attempt model detail `provider: string`, `requestedModel: string`, `servedModel: string \| null`, `invocation: string`                                                                                                                                          | driver adapter                                                                                                     | model/tier and cost analysis                       | J/R; served identity unavailable when provider omits it                                                                                                                  |
| attempt accounting `usageChannels: Record<string, Count \| null>`, `requests: Count \| null`, `modeledUsd: number \| null`, `priceTableRevision: string \| null`, `priceCoverage: string \| null`                                                               | adapter usage settlement and price resolver                                                                        | cost roll-up, report on every exit                 | J/R; channels retain native meaning; modeled USD never becomes budget authority                                                                                          |
| attempt cause `stopCode: string`, `error: {type: string \| null, code: string \| null, providerFinishReason: string \| null, source: string, certainty: 'observed' \| 'inferred' \| 'unknown'} \| null`                                                         | boundary classifier after redaction                                                                                | incident classification and residue                | J/R; sanitized underlying cause retained, unknown legacy cause/class stays unknown                                                                                       |
| timeout `scope: 'request' \| 'step' \| 'attempt' \| 'run'`, `boundMs: number`, `source: string`                                                                                                                                                                 | boundary enforcing the specific timeout                                                                            | gate/report diagnosis                              | J/R; only present with observed timeout evidence, never inferred from elapsed wall                                                                                       |
| budget `allowed: {tokens: Count \| null, wallMs: number \| null}`, `spent: {tokens: Count \| null, wallMs: number \| null}`, `remaining: {tokens: Count \| null, wallMs: number \| null}`                                                                       | budget resolver and settlement                                                                                     | attempt/report accounting                          | J/R; canonical nested accounting; known remaining is clamped at zero, unknown remains unknown                                                                            |
| closure `commitSha: SHA`, `taskIds: string[]`, `findingFingerprints: FindingFingerprint[]`, `verificationEvidence: string[]`, `todo: boolean`                                                                                                                   | commit verifier                                                                                                    | metric numerator                                   | J/R; only distinct verified non-todo commits count; legacy unproved closure cannot count as verified                                                                     |
| baseline evidence `unitId: string`, `probeHead: SHA \| null`, `completed: boolean`, `count: Count \| null`, `unknownReason: string \| null`                                                                                                                     | baseline probe / planner for bailed units                                                                          | denominator and report                             | J/R; every planned unit represented even without a probe                                                                                                                 |
| disposition context `observedHead: SHA`, `observedAt: string`, `acceptedRisk: string \| null`                                                                                                                                                                   | deliberate adjudicator                                                                                             | later review, offline analysis                     | J/R; old missing context unknown, never auto-dispose a finding on operational error                                                                                      |
| review population `initialBlocking: FindingFingerprint[] \| null`, `reviewerId: string`, `source: string`, `round: Count`, `delivered: string[]`, `completed: string[]`, `omissions: string[]`, `vendorCompletion: 'completed' \| 'not-completed' \| 'unknown'` | review producer / coverage validator                                                                               | per-head review denominator and net-value analysis | J/R; path/range or content-hash references; append each head/round, never overwrite history; empty population only if known empty                                        |
| correlation `workId: string`, `parentWorkId: string \| null`, `branch: string`, `commitSha: SHA \| null`, `sessionId: string \| null`, `agentId: string \| null`                                                                                                | composition dispatcher and resume loader                                                                           | journal/report/session joins                       | J/R; work and parent IDs are persisted for future R14 resume; branches alone never unique; attempt carries model provenance                                              |
| availability `state: 'known-zero' \| 'not-collected' \| 'unavailable' \| 'partial' \| 'n-a' \| 'known'`, `reason: string`, `source: string \| null`                                                                                                             | producer of each nullable/partial measurement, keyed by field path in `availability: Record<string, Availability>` | report and offline aggregation                     | J/R; legacy absent fields default not-collected with migration source; explicit zero requires known-zero, partial preserves known subtotal without claiming completeness |

Only `budget.allowed`, `budget.spent` and `budget.remaining` are written; cap/used aliases are not wire fields. Availability accompanies unknown or partial
values and distinguishes absence from zero and inapplicability. Review delivered
and completed entries identify paths/ranges or content hashes in their pinned trees.
Author closure is never independent acceptance. An operational failure leaves a
finding open unless a deliberate disposition is recorded. Correlation IDs are persisted now; R14 must restore them across resume while each new run retains its own run ID.

New events also carry existing envelope identifiers `runId: string`, `at: string`
and nullable scope fields `jobId: string | null`, `taskId: string | null`, `attempt: Count | null`, as fixed by the dispatch registry.
The writer supplies these; the fold and report join on them. J migration preserves
existing envelopes; missing legacy joins are unknown. Attempt lifecycle records and
disposition/acceptance records are new discriminated v3 events (`attempt-finished`,
`finding-disposition`, `head-acceptance`); report rows carry the same payloads.
Task completion and gate evaluation use `task-finished` and `gate-verdict` events.
All new payload definitions and strict mirrors land together.

**Attempt persistence choice:** `attempt-finished` is the durable per-attempt
journal carrier, not an attempts array on `job-finished`. A worker/rescue inner
attempt is not a kernel job: one enclosing job can execute several such attempts.
The composition writer receives one event at each attempt boundary, including unsuccessful
spawn and cancellation paths, identified by composition run/unit/task/attempt plus optional kernel job and invocation
and tier. Its payload contains model/provider identities, usage channels/tokens,
wall, budget, stop text/code/class, sanitized underlying error and timeout scope
from the tables above. Reports fold and mirror these events; they are never the
sole store. Separate events preserve completed inner-attempt evidence even if the
enclosing job crashes before `job-finished`; an interrupted attempt without a
terminal event remains explicitly incomplete, never an invented completion.
This adds observation at the composition boundary and no retries to the kernel.
The existing job-finished usage and retry ordinal remain job-level accounting,
not substitutes for these worker/rescue attempt records.

A spawn/DNS/provider failure produces an infrastructure stop and an indeterminate
gate with `bail` explaining why validation did not run; it never asserts candidate
failure. A completed candidate check can assert fail. A wall-cap expiry records
`gate: 'timeout'`, class budget when the configured cap trips; unrelated transport
timeout is infrastructure. The timeout failed-attempt path preserves evidence and
allows siblings to continue. Token fields report actual known usage; this ADR does
not introduce a new binding token cap. Human deferral remains class human, distinct
from model failure. Retriable is classification, not a new kernel retry facility.

Numerator counts distinct verified non-todo commits closing a finding or fixing a
unit; failed-attempt evidence commits and empty/nochange attempts do not count.
One commit closing multiple findings counts once. Denominator counts baseline
failures (or open blocking findings for review) across **all planned units**, including
bailed and undispatched ones. A unit placeholder is not a failure count: if a probe
never ran, mark its count unknown, and the aggregate denominator unknown rather
than zero. Print numerator and denominator on every agentic run, including non-ok
exit paths; zero denominator gives no success ratio. Keep per-run measurement in
reports, never a cross-run engine surface. Monthly analysis is observational and
offline; attribution does not establish causal review value.

## Migration and version rules

1. Ship a dual-reader before enabling v3 writers. Dispatch on run-started version:
   absent → v1, 2 → v2, 3 → v3; retain strict schemas for each version. Preserve
   historical bytes, complete-line validation, sequence claims, reservation recovery
   and quarantine semantics. v3 joins the existing sequenced v2 ordering, not a new
   timestamp-sorted era. Unknown future versions fail explicitly.
2. Unmodified v2 readers cannot parse v3: strict schemas forbid additive sleight of
   hand. Keep existing journals readable by the dual-reader; write new v3 data only
   to histories managed by upgraded readers. A legacy export may project known
   v2 events to a separate artifact, explicitly marked lossy outside its v2 stream.
   Such export is for display, never replay, approval or acceptance authority.
3. Report v2 is a versioned payload inside I1's existing report carrier; stdout
   remains one JSON artifact with the same statuses and exit rules. Readers select
   v2 explicitly; keep a legacy report projection for old consumers during rollout.
   Do not silently change the old scalar fixesPerRun into an object for old readers.
4. The dispatch registry below is the sole version-bump rule. The J/R/F/H
   annotations in the ownership tables refer to that registry, not separate
   permissions to change a strict schema. Ledger and findings artifacts also use
   the explicit versioned migrations named there.
5. Preserve old evidence without fabricated provenance, classes, ownership, zero
   usage or acceptance. Replay may skip only with a matching declared H version
   and semantic inputs; unresolved old evidence cannot become a passing verdict.
   No new lock, required check, approval flow or permission ledger follows from
   version negotiation.

## Dispatch contract: exact spelling and version registry

This registry is authoritative for nesting and versions; the ownership tables above
supply types and migration details. No alternate spellings or duplicate counters
are emitted. `E` means an event envelope; `P` means `E.payload`; `R` means the
report root. Braced lists below expand to separate fields at the stated prefix.
Every listed non-optional field is required on new records; unknown values are null
with availability. Within these new record definitions, use `schemaVersion` only for findings, `version` only
for fingerprint/ledger, and `reportVersion` for reports.

| Carrier                                               | Exact field paths / payload allocation                                                                                                                                                                                                                                                                                   | Initial version and future bump rule                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal header                                        | `E.type = 'run-started'`, `E.journalVersion = 3`, `E.provenance`, `E.correlation`, `E.availability`                                                                                                                                                                                                                      | Journal 3; any persisted shape or meaning change increments journalVersion; dual-reader first                                                                                                                                                                                                                                                                                    |
| Report                                                | `R.reportVersion = 2`, `R.provenance`, `R.correlation`, `R.tasks[]`, `R.attempts[]`, `R.gates[]`, `R.dispositions[]`, `R.acceptances[]`, `R.reviews[]`, `R.approvals[]`, `R.writeDecisions[]`, `R.metric`, `R.availability`                                                                                              | Report 2; any persisted shape or meaning change increments reportVersion; legacy projection explicit                                                                                                                                                                                                                                                                             |
| Composition header/link                               | `E.type = 'composition-started'`, `P.{journalVersion,provenance,correlation}`; `E.type = 'kernel-run-linked'`, `P.{kernelRunId,planId,round}`                                                                                                                                                                            | Journal 3; T29/T04; same persisted-shape bump rule                                                                                                                                                                                                                                                                                                                               |
| RunOptions handoff                                    | `RunOptions.provenance?: ProvenanceRecord`, `RunOptions.correlation?: CorrelationRecord`                                                                                                                                                                                                                                 | Optional runtime inputs copied only to v3 headers; extend strict RunOptionsSchema together                                                                                                                                                                                                                                                                                       |
| Shared provenance object                              | `provenance.{cqVersion,producerVersion,repoId,cqJsonHash,baseSha,runPrefix,startedAt,endedAt,journalLink,reportLink,witnesses}`; `witnesses.{base,admitted,execution,reviewed,accepted}`                                                                                                                                 | Governed by containing journal/report version; header endedAt null, report endedAt observed on completion                                                                                                                                                                                                                                                                        |
| Shared correlation object                             | `correlation.{workId,parentWorkId,branch,commitSha,sessionId,agentId}`                                                                                                                                                                                                                                                   | Containing version; work IDs UUIDs allocated once and persisted; R14 restores them on resume; parent null for root                                                                                                                                                                                                                                                               |
| Task                                                  | `E.type = 'task-finished'`, `P.{taskId,changed}`, `R.tasks[].{taskId,changed}`                                                                                                                                                                                                                                           | Journal 3 / report 2; changed compares trees before and after task, independent of outcome                                                                                                                                                                                                                                                                                       |
| Attempt                                               | `E.type = 'attempt-finished'`, `P.{tier,invocation,model,provider,requestedModel,servedModel,tokens,usageChannels,requests,wallMs,modeledUsd,priceTableRevision,priceCoverage,stopReason,stopCode,class,error,timeout,budget,availability}`; `R.attempts[]` mirrors envelope and payload                                 | Journal 3 / report 2; legacy costUSD stays only in legacy projection, new accounting uses modeledUsd                                                                                                                                                                                                                                                                             |
| Attempt cause                                         | `P.error.{type,code,providerFinishReason,source,certainty}`; `P.timeout.{scope,boundMs,source}`                                                                                                                                                                                                                          | Containing version; error and timeout are null if not observed; stopCode is stable kebab-case classifier code, text remains stopReason                                                                                                                                                                                                                                           |
| Attempt budget                                        | `P.budget.{allowed,spent,remaining}` each with `{tokens,wallMs}`                                                                                                                                                                                                                                                         | Containing version; no tokenCap/wallCapMs/tokensUsed/wallUsedMs aliases                                                                                                                                                                                                                                                                                                          |
| Gate                                                  | `E.type = 'gate-verdict'`, `P.{gate,verdict,bail,fingerprintVersion}`, `R.gates[]` mirrors envelope and payload                                                                                                                                                                                                          | Journal 3 / report 2; bail omitted if absent, fingerprintVersion null when no fingerprint used                                                                                                                                                                                                                                                                                   |
| Approval                                              | `E.type = 'approval-granted'` or `'approval-expired'`, `P.{approvalId,reason}`; `R.approvals[]` mirrors envelope and payload                                                                                                                                                                                             | Journal 3; approvalId is SHA-256 of opaque approval identifier, never raw capability; no new authority                                                                                                                                                                                                                                                                           |
| Write observation                                     | `E.type = 'write-path-denied'` or `'write-path-cap-tripped'`, `P.{path,reason,cap,observed}`; `R.writeDecisions[]` mirrors envelope and payload                                                                                                                                                                          | Journal 3; no new enforcement; cap/observed null for non-count denials                                                                                                                                                                                                                                                                                                           |
| Disposition                                           | `E.type = 'finding-disposition'`, `P.{fingerprint,status,reason,owner,evidence,reviewTrigger,observedHead,observedAt,acceptedRisk}`, `R.dispositions[]` mirrors payload                                                                                                                                                  | Journal 3 / report 2 / findings schemaVersion 2; required new provenance, legacy null only in read adapter                                                                                                                                                                                                                                                                       |
| Acceptance                                            | `E.type = 'head-acceptance'`, `P.{headSha,reviewedBaseSha,reviewerId,authorId,independent,verdict,evidence}`, `R.acceptances[]` mirrors payload                                                                                                                                                                          | Journal 3 / report 2; import verified evidence, never mint acceptance from author closure                                                                                                                                                                                                                                                                                        |
| Review                                                | `E.type = 'review-observed'`, `P.{baseSha,headSha,findingFingerprints,coverage,initialBlocking,reviewerId,source,round,delivered,completed,omissions,vendorCompletion}`, `R.reviews[]` mirrors payload                                                                                                                   | Journal 3 / report 2; append per source/head/round, including blocked vendor observations                                                                                                                                                                                                                                                                                        |
| Metric                                                | `E.type = 'measurement-summary'`, `P.metric`, `R.metric`; `metric.{fixesPerRun,verifiedCommits,closures,baselineFailures}`, `fixesPerRun.{numerator,denominator}`, `closures[].{commitSha,taskIds,findingFingerprints,verificationEvidence,todo}`, `baselineFailures[].{unitId,probeHead,completed,count,unknownReason}` | Journal 3 / report 2; verifiedCommits is deduplicated projection of verified non-todo closures, not independent evidence                                                                                                                                                                                                                                                         |
| Availability                                          | `availability[jsonPointer].{state,reason,source}` on R and every P carrying nullable measurements                                                                                                                                                                                                                        | Containing version; JSON Pointer is relative to its containing payload/report, source is evidence URI or null                                                                                                                                                                                                                                                                    |
| Fingerprint                                           | `fingerprint.{version,checkId,rule,path,spanContentHash}` (same object in fingerprint arrays)                                                                                                                                                                                                                            | Fingerprint 1; any byte encoding, normalization, span extraction or identity change increments fingerprint.version independently                                                                                                                                                                                                                                                 |
| Replay                                                | `job-started.inputsHashVersion`, `job-finished.inputsHashVersion`, manifest job `inputsHashVersion = 2`; each existing `inputsHash` is the H2 digest                                                                                                                                                                     | Hash 2; semantic-input changes increment inputsHashVersion independently; journal shape adds these under journal 3                                                                                                                                                                                                                                                               |
| Semantic input object (hashed, not operational paths) | `{op,baseSha,taskId,checkConfigHash,candidateTreeHash,input}`                                                                                                                                                                                                                                                            | Hash 2; candidateTreeHash null only for baseline/non-candidate work; input contains all remaining behavior-affecting data with operational paths removed                                                                                                                                                                                                                         |
| Ledger carrier                                        | ledger `version = 2`, entries `{signature,fingerprint,status,reason,bugLink,firstSeen,lastSeen,count,component,note}`                                                                                                                                                                                                    | Ledger 2; persisted shape or meaning change increments ledger version; no unproved signature conversion                                                                                                                                                                                                                                                                          |
| Findings record                                       | `src/ops/review/findings.ts` envelope `schemaVersion: 1 → 2`; findings gain `fingerprint`, disposition `owner`, `reviewTrigger`, `observedHead`, `observedAt`, `acceptedRisk`; existing status/reason retained, evidence becomes string array                                                                            | T19; strict dual-reader v1/v2. Adapt legacy evidence string to one-element array, absent to null; missing new provenance/identity null with availability. New v2 dispositions require full fields; never fabricate legacy identity. Old v1 readers reject v2 explicitly; no in-place rewrite of old artifacts                                                                    |
| Dev ledger                                            | `src/ops/dev/record.ts::DEV_LEDGER_VERSION: 2 → 3`; disposition adds `owner`, `evidence: string[]`, `reviewTrigger: string or null`, `fingerprint`, `acceptedRisk: string or null`                                                                                                                                       | T38; parseDevLedger dual-reads 2/3; existing v1 rejection remains. Legacy new fields null/unknown in read view; never manufacture owner/evidence. New v3 disposition requires owner/evidence and deferred trigger; serialize new writes as 3, old v2 reader rejects 3. Existing action/why/head/at map to status/reason/observedHead/observedAt without renaming the dev carrier |

Event envelopes for new event kinds are exactly
`{type,runId,at,unitId,jobId,taskId,attempt,payload}`. `unitId` is a stable composition unit identifier, not a jobId alias; it is required for unit-scoped observations and null otherwise. Scope fields are nullable on run-level
events, taskId required non-null on attempt/task/gate events, jobId nullable when enclosing kernel job is unknown; attempt is a positive integer
there and null otherwise. `at` is UTC ISO-8601 with milliseconds. All SHA fields use
lowercase repository-native full object IDs. All hashes use `sha256:` plus 64 lowercase
hex characters over UTF-8 bytes. `producerVersion` is the emitting package version;
`repoId` is the opaque archive-safe remote digest defined below, or null/unavailable when no remote exists. Links are repo-relative artifact paths, never absolute host
paths. In the header, `baseSha` and `witnesses.base` must agree.

For F1, serialize `[1,checkId,rule,path,spanContentHash]` as compact JSON without
whitespace; compare the entire tuple and pair duplicate tuples with sorted occurrence
ordinals as today. Hash exact pinned source bytes for the primary diagnostic span,
normalizing CRLF to LF only; no whitespace trimming. If only a line is available,
use its complete line excluding its newline. Vitest uses UTF-8 full test name;
locationless non-test diagnostics use the complete normalized diagnostic text with
CRLF → LF only. Unknown file uses empty repo-relative path; unprovable source span
is null/unavailable and cannot match. This fixes the F1 extraction policy now,
rather than letting each adapter choose. Check config hashes and H2 use
`canonicalJson` followed by SHA-256; cqJsonHash hashes canonical parsed effective
cq.json, not formatting or file location. H2 operational exclusions are exactly
`cwd`, `journalDir`, `reportPath` and generated `runPrefix`; nested semantic file
paths remain repo-relative. Approval workspace binding remains separate.

Stop-code mapping is fixed: `spawn`, `dns`, `transport`, `provider-outage` →
infrastructure; `wall-cap`, `token-cap` → budget; `human-deferred`,
`approval-expired` → human; `validation-failed`, `model-output`,
`nochange` → terminal; an explicitly retryable provider response → retriable with
code `provider-retryable`. `write-denied` carries the existing gate's class:
fail → terminal; needs-human or escalated-to-human → human (the explicit
escalated-to-human outcome takes precedence when present). addressWorker's
unfixed path-policy result is terminal. Successful attempts use terminal / `completed`.
An unrecognized live error is infrastructure / `unclassified` with certainty
unknown; it must not assert candidate failure. Historical unknown class stays null
in the migration view. The classifier preserves sanitized raw type/code/finish
reason; it must not reclassify by substring-matching human prose.

### Composition persistence and kernel header handoff

The kernel-owned `RunLog` is not exposed to ops. Choose a **separate composition
stream** written through new kernel-exported `openObservationWriter({journalDir,
workId,compositionRunId})`. It creates
`<journalDir>/observations/<workId>/<compositionRunId>.ndjson` exclusively and
appends/fsyncs complete v3 events serially; no new lock is introduced. The
composition owns writer lifetime and closes it in finally. A write failure makes
its result indeterminate. Without journalDir, the same writer API is memory-only
and the report declares persistence unavailable; it does not claim durability.

The composition allocates compositionRunId and uses it as observation `runId`.
One review.address invocation owns one stream across **all** rounds and their
multiple runPlan calls, not one stream per kernel plan. Add
`kernel-run-linked` with payload `{kernelRunId: string, planId: string, round: Count}`
after each runPlan result, including partial results when present. Unreturned
kernel runs remain unlinked/unknown, not guessed. The dual reader explicitly scans
the observations subtree, validates each stream separately, then joins by workId
and kernel-run-linked. Kernel replay consumes only kernel streams; observational
events never alter reservations, sequence claims or job statuses. Preserve file
order within each stream; do not manufacture cross-stream order from timestamps.
`readObservations` returns incomplete terminal evidence as partial.

For inner task events, T30 injects the writer through a new runtime registry
factory `makeRegistry({observationWriter})`, which passes it to makeSweepUnitOp
outside the serialized dispatch input. This is a **new makeRegistry factory**:
the pin exports a const registry array, not an existing factory. It closes over
the optional writer in the sweep.unit entry's importer, preserves the existing
OpRegistryEntry.importer(wiring?) alias-notice seam unchanged, and adds the writer
to the resolved runtime bindings only. The default exported registry is
makeRegistry({}) so existing callers retain their behavior. T31 injects it through AddressWorkerDeps.
No callback is added to plan JSON. Add `unitId: string|null` to each observation:
fix uses the planned unit identity, address uses the dispatch unit identity;
jobId names the enclosing kernel job only when actually known, otherwise null.
Task/attempt events require unitId and taskId, not a fabricated kernel jobId.

Choose **RunOptions metadata**, not kernel discovery: add optional
`provenance: ProvenanceRecord` and `correlation: CorrelationRecord` to RunOptions
and its strict schema. makeFixRun/makeReviewAddress resolve these once, pass them
to every runPlan invocation, and the v3 run-started writer copies them unchanged.
The composition stream starts with `composition-started`, payload
`{journalVersion: 3, provenance: ProvenanceRecord, correlation: CorrelationRecord}`.
This is the only composition header; its witnesses are composition-scoped, while
kernel execution witnesses remain on their own header. Missing metadata for a
standalone kernel invocation is null/unavailable, never synthesized cq.json state.
T04 owns both header handoff and composition header; T29 owns stream linkage.

### Observable events, metric evidence and redaction

At the pin only approval granted true/false is observable; T17 emits
approval-granted on granted:true. `approval-expired` is a **reserved schema member
with no producer**: no kernel approval verifier exists at the pin. Its missing
expiry/TTL verification is tracked separately in [#789](https://github.com/camerontaylor/cq-toolkit/issues/789);
implementation of that verifier must precede any expiry producer. #238 was a
driver seam/DriverFactory PR, not an approval verifier. There is no
write-path count cap at the pin; `write-path-cap-tripped` is likewise reserved,
with no producer or enforcement ticket. Review-size maxFiles is not a write cap.
T18 emits only existing path-policy refusals from taskLoop/addressWorker;
write-denied preserves the existing classification: gate fail → terminal;
needs-human/escalated-to-human → human. The taskLoop :504 recording site is
inside proposeOnly and escalates to human. The :518 non-propose-only throw has
**no write-path observation producer at the pin**; T18 adds observation immediately
before that throw, carrying the already computed row.validation verdict rather
than inferring class from the error text. addressWorker's unfixed refusal remains
terminal. This observes the existing decision without changing it.

A verified fix commit requires the corresponding `src/ops/sweep/taskLoop.ts::FixTaskReport` outcome to be
`fixed`, validation to be present with passing verdict, the SHA to appear in that
task's commits, and a closure link to the task or finding. Address normalizes its
worker validation into that same predicate. “Non-todo” means the commit has no
`Cq-Todo: true` trailer (case-insensitive key/value after trimming). This ADR
introduces that explicit exclusion marker; it does **not** guess TODO intent from
source text, skip markers or commit subjects. A fixed validation record without
closure evidence is unknown/unverified, not a numerator contribution. T34/T35
own this predicate and fixtures, including duplicate SHAs and excluded trailers.

Ledger **2 includes both F1 and R6**. `signature` is the full canonical F1 tuple
string, `fingerprint` is its structured form; status is open/accepted/resolved;
reason is required nonempty; bugLink is string or null; firstSeen/lastSeen are UTC
timestamps or null for unobserved legacy history; count preserves hit counts;
component/note remain optional legacy metadata. New hits default open with reason
“observed failure”, both times observed now. Migrated v1 entries retain their old
signature, fingerprint null, status open, reason “legacy count-only entry”, both
times null and existing count. Those entries cannot suppress an F1 match until
recomputed from pinned evidence. R6 decay/reopen behavior is a subsequent ticket
against this same version, not a second ledger-2 schema or an implicit ledger 3.

T12 owns **new** `src/ops/fix/attemptRecord.ts::sanitizeObservation`, recursively
applying `src/driver/error-text.ts::redactSensitiveText` to error fields, stopReason,
reason and provenance strings **before** journal/report persistence. Before that call, sanitizeObservation removes URL userinfo/query and replaces SCP-style credential prefixes in every persisted text field; redactSensitiveText then removes environment-secret values. T04 calls
that sanitizer for provenance too. The archive-safe repoId is
`sha256:` + SHA-256 of the normalized, credential-free remote, never the remote
hostname/path itself; no remote gives null/unavailable. Strip URL userinfo/query
and SCP-style user prefix before hashing, and never persist the unhashed input.
T12 adds `test/ops/fix/observation-redaction.test.ts` for environment secrets,
credential URLs, stop text and repo identifiers. The denylist upload scanner stays
an upload boundary; it is not a substitute for persistence redaction.

Nochange when budget expired mid-edit: **budget takes precedence**; nochange is
terminal only when completion was observed without a budget/cancellation stop.
Is a repo hostname acceptable in archived provenance.repoId: **no**, store the
opaque digest above. This does not alter any existing acceptance authority.

## Implementation tickets (one small PR each)

Keep T01–T24 stable; withdrawn IDs remain as dispatch aliases to their named replacements. Implement in dependency order, not numeric order. File/function names marked **new** are
specified additions, not claims about current source. Existing functions below
are grounded at the evidence pin in the source inventory. Each ticket changes only
its listed seam and fixture, uses fake providers, and leaves writers disabled until
its consumer is present. A named test file is future work, not a test run in this
ADR PR. Event rows refer to the complete exact payload in the registry above;
executors must not select a subset or invent alternative fields.

| Ticket / size | Fields or events; producer file/function                                                                                                                                 | Consumer file/function                                                                                                                                    | Migration step and focused test file to add                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T01 withdrawn | Original all-carrier schema ticket                                                                                                                                       | Replaced by T25–T28                                                                                                                                       | ID retained for dispatch references; do not execute                                                                                                                                                                                                                                                    |
| T03 withdrawn | Original shared sink injection ticket                                                                                                                                    | Replaced by T29–T31                                                                                                                                       | ID retained; use the separate composition stream, not kernel RunLog injection                                                                                                                                                                                                                          |
| T08 withdrawn | Original combined ledger ticket                                                                                                                                          | Replaced by T32–T33                                                                                                                                       | ID retained; complete R6 + F1 ledger 2                                                                                                                                                                                                                                                                 |
| T22 withdrawn | Original combined measurement ticket                                                                                                                                     | Replaced by T34–T35                                                                                                                                       | ID retained; separate fix/address caller scope                                                                                                                                                                                                                                                         |
| T24 withdrawn | Original combined fold/projection ticket                                                                                                                                 | Replaced by T36–T37                                                                                                                                       | ID retained; do not execute combined ticket                                                                                                                                                                                                                                                            |
| T25 S         | Header, correlation, attempt payload types: `src/kernel/types.ts`, **new** header/attempt types                                                                          | `src/kernel/schema.ts`, **new** header/attempt strict schemas                                                                                             | Schema-only, writer disabled; `test/kernel/journal-v3-header-attempt-schema.test.ts`                                                                                                                                                                                                                   |
| T26 S         | Gate/task/approval/write payload types: `src/kernel/types.ts`                                                                                                            | `src/kernel/schema.ts`, **new** strict schemas                                                                                                            | Keep reserved events parseable without producers; `test/kernel/journal-v3-gate-task-schema.test.ts`                                                                                                                                                                                                    |
| T27 S         | Disposition/acceptance/review types: `src/kernel/types.ts`                                                                                                               | `src/kernel/schema.ts`, **new** strict schemas                                                                                                            | No evidence importer or authority added; `test/kernel/journal-v3-review-schema.test.ts`                                                                                                                                                                                                                |
| T28 S         | Metric/availability/report root types: `src/kernel/types.ts`                                                                                                             | `src/kernel/schema.ts`, **new** metric and ReportV2Schema                                                                                                 | Compose previously landed payload schemas, writer disabled; `test/kernel/journal-v3-metric-schema.test.ts`                                                                                                                                                                                             |
| T02 S         | v1/v2/v3 dispatch: `src/kernel/journal.ts::parseLine`, `readEvents`                                                                                                      | same file `foldOrderRuns`, `deriveJobStatuses`                                                                                                            | Preserve seq/reservations and ignore observational events for job outcome derivation; unknown version rejects; `test/kernel/journal-v3-read.test.ts`                                                                                                                                                   |
| T29 S         | **new** `src/kernel/observation.ts::openObservationWriter`, `readObservations`                                                                                           | `src/kernel/journal.ts` dual reader; **new** `foldObservations`                                                                                           | Separate composition stream per mechanism below; kernel RunLog untouched; `test/kernel/observation.test.ts`                                                                                                                                                                                            |
| T30 S         | Fix caller writer: `src/ops/fix/runFix.ts::makeFixRun`; **new** `src/ops/sweep/registry.ts::makeRegistry({observationWriter})`                                           | `makeSweepUnitOp` runtime bindings, `runTaskLoopInner`                                                                                                    | Add new makeRegistry around the existing exported const registry array; exported default registry unchanged; never serialize callback in plan; `test/ops/fix/observation-wiring.test.ts`                                                                                                               |
| T31 S         | Address caller writer: `src/ops/review/address.ts::makeReviewAddress`                                                                                                    | `src/ops/review/addressWorker.ts::makeAddressWorker` runtime deps                                                                                         | One composition stream for all rounds/plans, explicit kernel run links; `test/ops/review/observation-wiring.test.ts`                                                                                                                                                                                   |
| T04 S         | **new** `src/ops/fix/provenance.ts::captureProvenance`; `makeFixRun`, `makeReviewAddress`                                                                                | `RunOptions.provenance`, `RunOptions.correlation` in `src/kernel/types.ts`; `runPlanUnderLease` header emitter                                            | Composition passes immutable metadata on every runPlan call; extend RunOptionsSchema; no kernel cq.json discovery; `test/ops/fix/provenance.test.ts`                                                                                                                                                   |
| T05 S         | Correlation persistence: **new** `src/ops/fix/correlation.ts::resolveCorrelation`                                                                                        | `makeFixRun`, `makeReviewAddress`, header options                                                                                                         | Allocate and persist UUIDs only; no resume loader yet; R14 must restore these exact IDs; `test/ops/fix/correlation.test.ts`                                                                                                                                                                            |
| T06 S         | F1 extraction/encoding: `src/ops/gates/fingerprint.ts`, **new** `fingerprintV1`                                                                                          | same file `fingerprintPairs`, `fingerprintSet`                                                                                                            | Keep old exported routines for old consumers; opt-in F1 uses registry bytes above; `test/ops/gates/fingerprint-v1.test.ts`                                                                                                                                                                             |
| T07 S         | Gate fingerprint adoption: `src/ops/gates/checkRunner.ts::makeCheckRunner`                                                                                               | `src/ops/gates/regressionGate.ts::regressionGate`                                                                                                         | Bind checkId/span content from pinned trees; mixed/unknown versions indeterminate; `test/ops/gates/regression-v1.test.ts`                                                                                                                                                                              |
| T32 S         | Ledger v2 complete shape: `src/ops/ledger/ledger.ts` types                                                                                                               | `src/adapters/store/ledgerStore.ts::parseLedger`, `serializeLedger`                                                                                       | v2 contains F1 plus all R6 fields as defined below, dual-read v1; `test/ops/ledger/ledger-v2-store.test.ts`                                                                                                                                                                                            |
| T33 S         | F1 ledger producers: `makeLedgerRecord`, `makeLedgerQuery`                                                                                                               | v2 store and existing dispatch suppression                                                                                                                | Populate R6 defaults/migration below, preserve thresholds; `test/ops/ledger/ledger-v2.test.ts`                                                                                                                                                                                                         |
| T09 S         | Re-review F1: `src/ops/review/findings.ts::merge`                                                                                                                        | `src/ops/review/address.ts::makeReviewAddress`                                                                                                            | Keep intra-run key unchanged; add separate cross-head F1 matcher; `test/ops/review/address-identity-v1.test.ts`                                                                                                                                                                                        |
| T10 S         | Ratchet F1: `src/ops/gates/fingerprint.ts::fingerprintV1`                                                                                                                | `src/ops/ratchet/checkRatchet.ts::createCheckRatchet`                                                                                                     | Record identity version for finding-based comparisons, leave scalar metric ratchets unchanged; `test/ops/ratchet/fingerprint-v1.test.ts`                                                                                                                                                               |
| T11 S         | H2 canonical inputs: `src/kernel/manifest.ts::hashInputs`, `makeManifest`                                                                                                | `src/kernel/runner.ts::runPlanUnderLease` replay branch                                                                                                   | Add inputsHashVersion to manifest/job events; H1 never skips H2; preserve original operational input for execution; `test/kernel/manifest-h2.test.ts`                                                                                                                                                  |
| T12 S         | Attempt normalization: **new** `src/ops/fix/attemptRecord.ts::finishAttempt`                                                                                             | `src/ops/sweep/taskLoop.ts::runTaskLoopInner`                                                                                                             | Populate every attempt field, budget/availability, redacted structured cause and explicit timeout; no journal writes yet; `test/ops/fix/attempt-record.test.ts`                                                                                                                                        |
| T13 S         | `attempt-finished` for fixes: `runTaskLoopInner`                                                                                                                         | T29 writer; **new** `src/ops/fix/reportFold.ts::foldObservations`                                                                                         | Emit in finally on each inner attempt, including spawn failure; completed prefix survives enclosing job crash; `test/ops/sweep/attempt-journal.test.ts`                                                                                                                                                |
| T14 S         | `attempt-finished` for address: `src/ops/review/addressWorker.ts::makeAddressWorker`                                                                                     | T29 writer and `foldObservations`                                                                                                                         | Reuse T12, no parallel counters; keep job retry ordinal separate; `test/ops/review/address-attempt-journal.test.ts`                                                                                                                                                                                    |
| T15 S         | `task-finished` changed: `runTaskLoopInner`                                                                                                                              | `src/ops/fix/report.ts::plannedTaskRowOf`, `foldObservations`                                                                                             | Compare before/after candidate trees, legacy changed unknown; `test/ops/fix/task-changed.test.ts`                                                                                                                                                                                                      |
| T16 S         | `gate-verdict` / timeout: `src/ops/fix/validate.ts::validateFix`, `runTaskLoopInner`                                                                                     | `foldObservations`, failed-attempt gate mapping `failedGateOf`                                                                                            | Add timeout gate without changing I1; spawn bail indeterminate, cap scope explicit; `test/ops/fix/gate-journal.test.ts`                                                                                                                                                                                |
| T17 S         | `approval-granted` only: `src/ops/analyze/approval.ts::makeApprovalAuthority` admit/exercise granted:true                                                                | runtime observation writer, `foldObservations`                                                                                                            | No observable expiry source at pin; no kernel approval verifier at pin; approval-expired reserved pending verifier tracked in #789; `test/ops/analyze/approval-journal.test.ts`                                                                                                                        |
| T18 S         | `write-path-denied`: `src/ops/sweep/taskLoop.ts::runTaskLoopInner` path-policy / `failedGateOf`; `src/ops/review/addressWorker.ts::makeAddressWorker` path-policy result | runtime observation writer, `foldObservations`                                                                                                            | Preserve verdict/outcome class (fail terminal; needs-human/escalated human); add observer before taskLoop :518 throw (none at pin); address unfixed terminal; cap/observed null. write-path-cap-tripped reserved with no producer at pin; no count cap added; `test/ops/fix/write-observation.test.ts` |
| T19 S         | `finding-disposition`: `src/ops/review/address.ts::makeReviewAddress`                                                                                                    | `src/ops/review/findings.ts::FindingsRecordSchema`, `foldObservations`                                                                                    | Dual-read schemaVersion 1/2; v2 new terminal dispositions complete; do not turn infrastructure failure into deferral; `test/ops/review/disposition-journal.test.ts`                                                                                                                                    |
| T20 deferred  | `head-acceptance` carrier schema is T27; **new** `src/ops/review/acceptanceRecord.ts::importAcceptance` is not implemented by these tickets                              | measurement-plan independent-acceptance slice owns the importer                                                                                           | Defer input-source and trust-adapter implementation to that slice; this ADR authorizes no PASS-comment parser or new authority. Until wired, report acceptances unknown, never empty-all-clear; `test/ops/review/acceptance-record.test.ts` belongs to that slice                                      |
| T21 S         | `review-observed`: `src/ops/review/address.ts::makeReviewAddress`                                                                                                        | `foldObservations`, report reviews                                                                                                                        | Snapshot every source/head/round population and delivered/completed coverage; never last-head overwrite; `test/ops/review/review-denominator.test.ts`                                                                                                                                                  |
| T34 S         | Fix closure/baseline evidence: `makeFixRun`, `FixTaskReport`                                                                                                             | **new** `src/ops/fix/measurement.ts::measureRun`                                                                                                          | Use exact verified/todo rule below, bailed baseline unknown; `test/ops/fix/measurement.test.ts`                                                                                                                                                                                                        |
| T35 S         | Review closure/baseline evidence: `makeReviewAddress`, `makeAddressWorker`                                                                                               | `measureRun`                                                                                                                                              | Normalize review validation into same predicate; no inference from commit subject; `test/ops/review/measurement.test.ts`                                                                                                                                                                               |
| T23 S         | `measurement-summary`, R.metric: `measureRun`                                                                                                                            | T29 writer, `foldObservations`, `makeFixRun`, `makeReviewAddress`                                                                                         | Print counts on every exit; no cross-run state or ratio for unknown denominator; `test/ops/fix/measurement-journal.test.ts`                                                                                                                                                                            |
| T36 S         | `src/ops/fix/reportFold.ts::foldObservations` (**new**)                                                                                                                  | `makeFixRun`, `makeReviewAddress` report v2                                                                                                               | Fold composition stream plus linked kernel streams, partial completion stays partial; `test/ops/fix/report-v2-fold.test.ts`                                                                                                                                                                            |
| T37 S         | **new** `src/ops/fix/reportFold.ts::legacyReportProjection`                                                                                                              | legacy fix/address report consumers                                                                                                                       | Separate lossy projection, old scalar only here, never replay evidence; `test/ops/fix/report-v2-legacy.test.ts`                                                                                                                                                                                        |
| T38 S         | Dev disposition v3: `src/ops/dev/disposition.ts::makeDevDisposition`                                                                                                     | `src/ops/dev/record.ts::parseDevLedger`, `serializeDevLedger`; `src/ops/dev/ready.ts` type/assembleReadiness consumer only (parsing remains in record.ts) | Dual-read ledger 2/3 with explicit legacy unknown fields, no v1 relaxation; `test/ops/dev/disposition-v3.test.ts`                                                                                                                                                                                      |

T25–T28, T02 and T29 precede event-producing tickets; T30/T31 wire the respective callers; T06 precedes T07–T10;
T12 sanitizer precedes T04 and T13–T14; T34/T35 precede T23; T36 follows active payload producers and precedes T37. T20 remains explicitly deferred, with its carrier schema present and unavailable acceptance data reported honestly.
Each S ticket targets at most 200 changed production lines plus focused fixtures.
If mechanical wiring exceeds that, split by fix/address caller without changing
this schema; report an actual missing contract decision to the coordinator rather
than letting an executor choose one. Rollout order is dual-read → opt-in writers →
report consumers → default v3/v2; legacy projections remain available for the 0.2
series and are never replay input. No task adds a required check, lock or approval.

## Consequences and implementation acceptance

Implement this as one coordinated schema amendment with small follow-up wiring PRs,
not multiple incompatible unions. Fixtures must cover v1/v2 readback, v3 crash/replay,
strict v2 rejection of v3, unknown versions, path-independent H2 equality and changed
content inequality, shared F1 identity with line drift and multiplicity, spawn bail
versus candidate fail, timeout classification, every-exit usage, deferred triggers,
stale-head acceptance and bailed-unit unknown denominators. These are future
implementation acceptance examples; this docs-only PR runs no tests.

Source decisions: owner R1–R5 in toolkit-research
`plans/upgrade-plans-20261102/fix-engine-rulings.md`; G1–G6 in
`plans/upgrade-plans-20261102/measurement-goals.md`; prior-art
`research/research-20261024-prior-art-landscape/recommendations.md` §3 R3/R13.
The expanded five-class owner ruling supersedes the older two-class research sketch.
Measurement-plan rollout and archive/trailer work remain separate implementation
planning; this ADR supplies their common wire vocabulary.

The field alignment above follows toolkit-research [PR #5](https://github.com/camerontaylor/toolkit-research/pull/5),
`measurement-plan.md`, “Contract handoff to the batched ADR”, at
`1d376717e`. All handoff bullets are covered; field nesting and events are owned
here. Availability includes `known` for positive complete observations in addition
to the five special states requested by the handoff.

### Ticket source inventory

The ticket function names refer to the same pinned main SHA as the evidence above:

- [src/kernel/journal.ts:837](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/journal.ts#L837)
- [src/kernel/manifest.ts:74](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/manifest.ts#L74)
- [src/kernel/runner.ts:520](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/runner.ts#L520)
- [src/ops/sweep/taskLoop.ts:147](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/sweep/taskLoop.ts#L147)
- [src/ops/sweep/unit.ts:545](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/sweep/unit.ts#L545)
- [src/ops/fix/runFix.ts:149](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/fix/runFix.ts#L149)
- [src/ops/fix/report.ts:181](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/fix/report.ts#L181)
- [src/ops/fix/validate.ts:41](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/fix/validate.ts#L41)
- [src/ops/review/address.ts:242](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/address.ts#L242)
- [src/ops/review/addressWorker.ts:229](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/addressWorker.ts#L229)
- [src/ops/review/findings.ts:167](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/findings.ts#L167)
- [src/ops/gates/fingerprint.ts:146](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/gates/fingerprint.ts#L146)
- [src/ops/gates/checkRunner.ts:196](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/gates/checkRunner.ts#L196)
- [src/ops/gates/regressionGate.ts:58](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/gates/regressionGate.ts#L58)
- [src/ops/ledger/ledger.ts:227](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/ledger/ledger.ts#L227)
- [src/adapters/store/ledgerStore.ts:137](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/adapters/store/ledgerStore.ts#L137)
- [src/ops/ratchet/checkRatchet.ts:105](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/ratchet/checkRatchet.ts#L105)
- [src/ops/analyze/approval.ts:632](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/analyze/approval.ts#L632)
- [src/driver/error-text.ts:32](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/driver/error-text.ts#L32)
- [src/ops/dev/record.ts:71](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/dev/record.ts#L71)
- [src/ops/dev/record.ts:268](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/dev/record.ts#L268)
- [src/ops/dev/disposition.ts:44](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/dev/disposition.ts#L44)
- [src/ops/sweep/registry.ts:406](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/sweep/registry.ts#L406)
- [src/ops/review/addressWorker.ts:861](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/review/addressWorker.ts#L861)
- [src/ops/sweep/taskLoop.ts:504](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/sweep/taskLoop.ts#L504)
- [src/ops/analyze/approval.ts:25](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/ops/analyze/approval.ts#L25)
