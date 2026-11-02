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
- [src/kernel/manifest.ts:75](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/manifest.ts#L75) currently hashes canonical `{input, op}`; [src/kernel/runner.ts:1761](https://github.com/camerontaylor/cq-toolkit/blob/6885bced3843260642aece2ff7b8b975ca293e30/src/kernel/runner.ts#L1761) skips only matching op/hash successful results. Hashing path-bearing input cannot support run-invariant re-drive.
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
fixtures together. Any change to normalization, span extraction, hash algorithm or
identity semantics increments `fingerprint.version`; different versions never silently
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

| Field / type                                                                                                                                                                                                                                                                                                                                                                                                          | Producer                                           | Consumers                                                         | Migration / version                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `journalVersion: 3`, `reportVersion: 2`                                                                                                                                                                                                                                                                                                                                                                               | journal writer; report assembler                   | parsers, replay, report readers                                   | J/R discriminators; never reinterpret v2 journal or old report as new                                     |
| `provenance.cqVersion: string`, `cqJsonHash: Hash`, `baseSha: SHA`, `runPrefix: string`                                                                                                                                                                                                                                                                                                                               | run-start resolver; copied to report               | replay diagnostics, audit, attribution                            | J/R; legacy provenance unknown; hash effective cq.json content, not filename                              |
| task `changed: boolean`                                                                                                                                                                                                                                                                                                                                                                                               | task loop comparing pre/post candidate content     | report, re-drive, nochange rendering                              | J/R; legacy unknown; a failed attempt can change content without being fixed                              |
| fingerprint `version: 1`, `checkId: string`, `rule: string                                                                                    \| null`, `path: string`, `spanContentHash: Hash`                                                                                                                                                                                                                       | shared adapter/fingerprint module                  | regression, ledger v2, ratchets, re-review                        | F plus J/R carriers; legacy identity retained separately; recompute only with evidence                    |
| `inputsHashVersion: 2`, `inputsHash: Hash` with semantic `baseSha: SHA`, `taskId: string`, `checkConfigHash: Hash`, `candidateTreeHash?: SHA`                                                                                                                                                                                                                                                                         | manifest semantic-input builder                    | replay skip, re-drive; future cache only if separately authorized | H/J; old hashes stay readable but never satisfy H2 equality                                               |
| gate `gate: string`, `verdict: 'pass'                                                                                                         \| 'fail'                                                                   \| 'indeterminate'                                                                              \| 'needs-human'`, `bail?: string`, `fingerprintVersion: number                 \| null`    | check runner / validation composition              | task loop, journal, report                                        | J/R; old gate names/reasons retained, unavailable version null                                            |
| attempt `model: ModelSpec                                                                                                                     \| null`, `tier: 'worker'                                                   \| 'rescue'`, `tokens: Count                                                                    \| null`, `wallMs: number                                                       \| null`    | driver result and monotonic attempt clock          | report, per-tier yield, cost analysis                             | J/R; copy known legacy usage, never infer missing tokens as zero                                          |
| attempt `stopReason: string`, `class: 'retriable'                                                                                             \| 'terminal'                                                               \| 'infrastructure'                                                                             \| 'budget'                                                                     \| 'human'` | attempt boundary classifier                        | retry policy, residue, measurement                                | J/R; legacy text retained, unclassifiable history stays unknown in adapter                                |
| attempt `budget: {tokenCap: Count                                                                                                             \| null, wallCapMs: number                                                  \| null, tokensUsed: Count                                                                      \| null, wallUsedMs: number                                                     \| null}`   | composition budget resolver and attempt settlement | timeout/token decisions, spend report on every exit               | J/R; unknown historical limits remain null; USD remains modeled only                                      |
| event `type: 'approval-granted'                                                                                                               \| 'approval-expired'`, `approvalId: string`, `reason: string`                                                                                                                                                                                                          | existing approval validator                        | journal audit, report diagnostics                                 | J; no raw token or signature material; absent legacy event proves nothing                                 |
| event `type: 'write-path-denied'                                                                                                              \| 'write-path-cap-tripped'`, `path: string`, `reason: string`, `cap: Count \| null`, `observed: Count                                                                      \| null`                                                                                    | existing write-path enforcement                    | journal, task residue, report                                     | J; redacted repo-relative path; legacy absence is not authorization                                       |
| disposition `fingerprint: FindingFingerprint`, `status: 'fixed'                                                                               \| 'rejected'                                                               \| 'deferred'`, `reason: string`, `owner: string`, `evidence: string[]`, `reviewTrigger: string \| null`                                                                                    | address adjudicator                                | durable findings artifact, report, later review                   | J/R; required for new terminal dispositions; deferred requires nonempty trigger; legacy omissions unknown |
| acceptance `headSha: SHA`, `reviewedBaseSha: SHA`, `reviewerId: string`, `authorId: string`, `independent: boolean`, `verdict: 'PASS'         \| 'HOLD'                                                                   \| 'RETRACT'`, `evidence: string[]`                                                                                                                                                         | independent reviewer evidence importer             | report and existing acceptance verifier                           | J/R; never infer legacy independence; stale head cannot accept a later head                               |
| review scope `baseSha: SHA`, `headSha: SHA`, `findingFingerprints: FindingFingerprint[]`, `coverage: string`                                                                                                                                                                                                                                                                                                          | review producer                                    | re-review denominator, acceptance audit                           | J/R; legacy incomplete scope explicit, empty set only when known empty                                    |
| metric `fixesPerRun: {numerator: Count                                                                                                        \| null, denominator: Count                                                 \| null}`, `verifiedCommits: SHA[]`, `baselineFailures: {unitId: string, count: Count           \| null}[]`                                                                                 | run assembler using verifier + baseline probes     | JSON report, human rendering, offline monthly roll-up             | R/J summary; old scalar retained only in legacy projection, never relabeled as this ratio                 |

The measurement handoff adds the following nested payloads to the same J/R
carriers, with the same strict-reader migration and version rules. Each legacy
omission uses the availability record below; no historic evidence is invented.

| Field / type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Producer                                                                                                           | Consumers                                          | Migration / version                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| provenance `producerVersion: string`, `repoId: string`, `startedAt: string`, `endedAt: string                                                 \| null`, `journalLink: string`, `reportLink: string`                                                                                                                                                                                                                                                                                                                                                                                                                          | run resolver and completion writer                                                                                 | offline attribution, report audit                  | J/R; legacy links/times only if observed                                                                                                                                 |
| witnesses `base: SHA`, `admitted: SHA                                                                                                         \| null`, `execution: SHA                                                                                                                                             \| null`, `reviewed: SHA              \| null`, `accepted: SHA                                                                                \| null`                                                                                                                                                   | admission, execution, review and acceptance boundaries                                                             | stale-state diagnosis, report                      | J/R; preserve distinct witnesses, never copy one into an unobserved other                                                                                                |
| attempt model detail `provider: string`, `requestedModel: string`, `servedModel: string                                                       \| null`, `invocation: string`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | driver adapter                                                                                                     | model/tier and cost analysis                       | J/R; served identity unavailable when provider omits it                                                                                                                  |
| attempt accounting `usageChannels: Record<string, Count                                                                                       \| null>`, `requests: Count                                                                                                                                           \| null`, `modeledUsd: number         \| null`, `priceTableRevision: string                                                                   \| null`, `priceCoverage: string                                                       \| null`                                                            | adapter usage settlement and price resolver                                                                        | cost roll-up, report on every exit                 | J/R; channels retain native meaning; modeled USD never becomes budget authority                                                                                          |
| attempt cause `stopCode: string`, `error: {type: string                                                                                       \| null, code: string                                                                                                                                                 \| null, providerFinishReason: string \| null, source: string, certainty: 'observed'                                                          \| 'inferred'                                                                          \| 'unknown'}                                             \| null`  | boundary classifier after redaction                                                                                | incident classification and residue                | J/R; sanitized underlying cause retained, unknown legacy cause/class stays unknown                                                                                       |
| timeout `scope: 'request'                                                                                                                     \| 'step'                                                                                                                                                             \| 'attempt'                          \| 'run'`, `boundMs: number`, `source: string`                                                                                                                                                                                                                     | boundary enforcing the specific timeout                                                                            | gate/report diagnosis                              | J/R; only present with observed timeout evidence, never inferred from elapsed wall                                                                                       |
| budget `allowed: {tokens: Count                                                                                                               \| null, wallMs: number                                                                                                                                               \| null}`, `spent: {tokens: Count     \| null, wallMs: number                                                                                 \| null}`, `remaining: {tokens: Count                                                  \| null, wallMs: number                                   \| null}` | budget resolver and settlement                                                                                     | attempt/report accounting                          | J/R; canonical nested accounting elaborates cap/used fields above; known remaining is clamped at zero, unknown remains unknown                                           |
| closure `commitSha: SHA`, `taskIds: string[]`, `findingFingerprints: FindingFingerprint[]`, `verificationEvidence: string[]`, `todo: boolean`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | commit verifier                                                                                                    | metric numerator                                   | J/R; only distinct verified non-todo commits count; legacy unproved closure cannot count as verified                                                                     |
| baseline evidence `unitId: string`, `probeHead: SHA                                                                                           \| null`, `completed: boolean`, `count: Count                                                                                                                         \| null`, `unknownReason: string      \| null`                                                                                                                                                                                                                                                           | baseline probe / planner for bailed units                                                                          | denominator and report                             | J/R; every planned unit represented even without a probe                                                                                                                 |
| disposition context `observedHead: SHA`, `observedAt: string`, `acceptedRisk: string                                                          \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | deliberate adjudicator                                                                                             | later review, offline analysis                     | J/R; old missing context unknown, never auto-dispose a finding on operational error                                                                                      |
| review population `initialBlocking: FindingFingerprint[]                                                                                      \| null`, `reviewerId: string`, `source: string`, `round: Count`, `delivered: string[]`, `completed: string[]`, `omissions: string[]`, `vendorCompletion: 'completed' \| 'not-completed'                    \| 'unknown'`                                                                                                                                                                                                                                                      | review producer / coverage validator                                                                               | per-head review denominator and net-value analysis | J/R; path/range or content-hash references; append each head/round, never overwrite history; empty population only if known empty                                        |
| correlation `workId: string`, `parentWorkId: string                                                                                           \| null`, `branch: string`, `commitSha: SHA                                                                                                                           \| null`, `sessionId: string          \| null`, `agentId: string                                                                              \| null`                                                                                                                                                   | composition dispatcher and resume loader                                                                           | journal/report/session joins                       | J/R; work and parent IDs persist across resume; branches alone never unique; attempt carries model provenance                                                            |
| availability `state: 'known-zero'                                                                                                             \| 'not-collected'                                                                                                                                                    \| 'unavailable'                      \| 'partial'                                                                                            \| 'n-a'                                                                               \| 'known'`, `reason: string`, `source: string            \| null`  | producer of each nullable/partial measurement, keyed by field path in `availability: Record<string, Availability>` | report and offline aggregation                     | J/R; legacy absent fields default not-collected with migration source; explicit zero requires known-zero, partial preserves known subtotal without claiming completeness |

Budget allowed/spent are the canonical accounting view of the cap/used values,
not additional independent counters. Availability accompanies unknown or partial
values and distinguishes absence from zero and inapplicability. Review delivered
and completed entries identify paths/ranges or content hashes in their pinned trees.
Author closure is never independent acceptance. An operational failure leaves a
finding open unless a deliberate disposition is recorded. Correlation IDs remain
stable across resume while each new run retains its own run ID.

New events also carry existing envelope identifiers `runId: string`, `at: string`
and, when scoped to work, `jobId: string`, `taskId: string`, `attempt: Count`.
The writer supplies these; the fold and report join on them. J migration preserves
existing envelopes; missing legacy joins are unknown. Attempt lifecycle records and
disposition/acceptance records are new discriminated v3 events (`attempt-finished`,
`finding-disposition`, `head-acceptance`); report rows carry the same payloads.
Task completion and gate evaluation use `task-finished` and `gate-verdict` events.
All new payload definitions and strict mirrors land together.

**Attempt persistence choice:** `attempt-finished` is the durable per-attempt
journal carrier, not an attempts array on `job-finished`. A worker/rescue inner
attempt is not a kernel job: one enclosing job can execute several such attempts.
The composition writes one event at each attempt boundary, including unsuccessful
spawn and cancellation paths, identified by run/job/task/attempt plus invocation
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
4. J/R columns authorize these fields only at journal 3/report 2. Every future
   persisted shape addition needs a schema revision and a dual-reader transition;
   required-field removal, reinterpretation or changed meaning needs a major wire
   version. F/H version independently whenever identity semantics change, even if
   the containing journal/report shape is unchanged. Ledger v2 and any strict
   findings artifact carrying the new identity/dispositions require their own
   versioned reader migration; do not write new fields into version-1 strict files.
5. Preserve old evidence without fabricated provenance, classes, ownership, zero
   usage or acceptance. Replay may skip only with a matching declared H version
   and semantic inputs; unresolved old evidence cannot become a passing verdict.
   No new lock, required check, approval flow or permission ledger follows from
   version negotiation.

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
`ac5373d88`. All handoff bullets are covered; field nesting and events are owned
here. Availability includes `known` for positive complete observations in addition
to the five special states requested by the handoff.
