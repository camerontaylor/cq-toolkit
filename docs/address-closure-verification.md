# R4C closure evidence verification

Status: the pure verifier is wired into `review.address` behind the optional
`--verifyClosure` boolean flag (SDK input `verifyClosure: true`). The default
retains existing behavior. With the flag, each worker's fixed result is checked
before a fixed disposition or PR-thread resolution. Only `resolved` may close;
`unresolved` and `uncertain` keep the finding open and return `needs-human`.

The operation assembles the finding text, exact single-file patch and full
before/after snapshots using the worker-validated parent and fix commit, never live
working-tree content. Concurrent siblings may advance HEAD after the initial
worker observation; the packet uses `validatedParent`, not that earlier
observation. Custom legacy workers without it fall back to `observedHead` and
refuse if the actual commit parent differs. It records packets and verdicts in the report's
`closureVerifications` array. Missing objects, unsupported patches, cancellation
and budget refusal cannot close a finding. Dependency completeness is currently
**unattested**: the assembler supplies no dependencies and sets
`relevantDependenciesComplete: false`. Thus this opt-in path conservatively
cannot return `resolved` (`uncertain` or concrete `unresolved` instead); it does not offer a flag to invent
completeness. A future dependency-evidence producer is needed for resolved
runtime verdicts.

Example: `cq review.address --source=local --repoRoot=. --verifyClosure --json`.

## Problem

`review.address` closes a finding when a fixer claims success and the
configured checks pass. Checks prove the tree compiles and behaves; they do
not prove the finding's subject matter is gone. A fix can pass every check
while the defect's trigger survives, a cited dependency is missing from the
changed surface, or the fix deleted code whose consumers live elsewhere. The
engine therefore closes on evidence that is necessary but not sufficient.
Review-audit fixes show the failure mode: the fixer's own argument is
persuasive, the checks are green, and the original complaint is still true of
the tree.

## Packet

`ClosurePacket` carries plain data only: the finding (id, text, optional
file/line), the plain task text, the patch, the before/after content of the
touched file at the pinned revision, cited dependencies with their full
content, and the assembler's `relevantDependenciesComplete` attestation. The
revision identity (head, parent) lives in `metadata.revision`.

Three deliberate plainness decisions:

1. **Plain finding/task/patch text, not structured finding references.** The
   R3 evidence schema is reusable but not required (card); a legacy finding's
   text carries the citable trigger as a quoted span. Structured upgrades can
   wrap the packet later without breaking this surface.
2. **Completeness is attested, never inferred.** The helper cannot know what
   the relevant consumers of a change are; a wrong inference would mint false
   closure. So completeness is a boolean the assembler must set, and every
   path that lacks the attestation ends uncertain. Missing relevant
   consumer/dependency evidence can never resolve.
3. **The dependency list is stable data, not live views.** The
   `dependencies` property is read exactly once, every array entry reference
   is captured before any record field is read, and each field value is read
   exactly once from its own data descriptor. A slot or record field backed
   by an accessor (getter/setter), or a record missing an own data field, is
   rejected as unavailable evidence: closure must never rest on values a
   host can swap between reads, so getter-backed evidence is not trusted
   evidence and need not resolve. A throw escaping any read is recorded as
   unavailable by the enclosing step. No proxies, no traps, no generic
   object-integrity machinery: descriptor checks and the existing step catch
   are the whole mechanism.

## Check sequence

`verifyClosureEvidence(packet, gate?)` runs five checks in fixed order and
stops at the first non-pass, so the returned check list is always a prefix of
the canonical order with at most one non-pass entry, last:

1. `packet-complete`: every field present and well-formed, revision identity
   present. Malformed or missing evidence is `unavailable`, never an
   exception.
2. `revision-pinned`: head and parent are full SHA-1/SHA-256 literals and
   distinct. An unpinned packet cannot tie its contents to a revision.
3. `patch-coherent`: the patch parses, touches the finding's cited file when
   it cites one, and changes something. Ordered single-file unified hunks must
   match the exact before context/removals, positions and line counts, then
   reconstruct the complete after snapshot including untouched regions. Only
   ordinary existing-file text patches with matching literal paths are
   supported. Renames, multiple files, binary/mode changes, creation/deletion,
   newline markers/transitions and malformed hunks are unavailable; there is
   no fuzzy application or fallback to line membership. An unchanged final
   newline is preserved. Incoherent packets are `unavailable`.
4. `trigger-removed`: quoted spans from the finding text must not survive in
   the after content or in any cited dependency's content; symbols declared
   on removed lines must not be re-declared in the after content or in any
   cited dependency. Survival is concrete counter-evidence: verdict
   `unresolved`. Removed declarations supply counter-evidence only: their
   removal alone cannot establish a relationship to the finding. Without a
   supported quoted finding trigger, a packet with no survival counter-evidence is
   uncertain (`no-citable-trigger`), even when an unrelated declaration was
   removed. The helper refuses to guess what the finding was about, and
   uncertainty keeps the finding open without demanding a code edit. Positive
   evidence requires at least one quoted finding span present in the before
   snapshot and on a validated removed patch line. A quoted suggestion absent
   before the patch cannot establish closure merely by remaining absent after
   an unrelated edit. Survival checks still take precedence as counter-evidence.
   Quoted spans and unique removed declarations retain the scan caps of eight
   and sixteen. Evidence exceeding either cap is unavailable (`uncertain`),
   never silently truncated into closure. Declaration survival uses ASCII
   identifier continuation (letters, digits, underscore and dollar), so a
   dollar-ending name matches itself but not a longer identifier.
5. `dependencies-covered`: a deletion-only patch can never resolve (a
   deleted line alone never establishes closure), and the completeness
   attestation must be present. Otherwise pass.

All five pass resolve the packet. A `fail` at trigger-removed is
`unresolved`. Everything else is `uncertain`. Only `resolved` may close a
finding.

## Verdicts and reasons

- `resolved` via `closure-evidence-complete`: the finding may close.
- `unresolved` via `deleted-trigger-survives`: the finding stays open with
  concrete counter-evidence.
- `uncertain`: the finding stays open and no edit is demanded. Reasons:
  `unavailable-evidence`, `unpinned-revision`, `no-citable-trigger`,
  `deleted-line-alone`, `omitted-consumer-or-dependency`, or the gate's own
  message.

`checks[]` retains every check's outcome and detail so a report can show why
closure did or did not happen; `revision` is echoed for evidence retention.

## Gate

`VerificationGate.admit()` is called once before each check. A throw
(cancellation, budget exhaustion, ownership loss) stops the sequence and the
thrown message becomes the verdict reason, so the run's own budget/cancel
vocabulary flows through verbatim instead of the helper inventing a parallel
one. Cancellation and budget exhaustion are therefore observable as
`uncertain`, never as success. A no-op gate (or no gate) gives a complete
evaluation; the packet is pure data and every check is local computation.

Diagnostic reads and non-Error string conversion are captured once inside a
catch guard. If a message getter or coercion hook throws, the detail falls
back to `verification diagnostic unavailable`. A gate refusal retains the
stable `verification gate refused` reason in that case; evidence failures
retain `unavailable-evidence`. Ordinary Error messages and non-Error string
details are preserved. Diagnostic failure cannot establish closure.

## Integration contract

- Assemble the packet from the pinned execution revision: `before`/`after`
  from the tree at `metadata.revision.head` and `.parent`, patch from the
  attempt, dependencies from the finding's own citations plus the assembler's
  dependency analysis. Set `relevantDependenciesComplete` only when that
  analysis covered the changed surface.
- Map `resolved` to closure, `unresolved` to keep-open with the retained
  reason, `uncertain` to keep-open without demanding an edit. Persist
  `checks` and `reason` with the attempt evidence.
- Budget/cancel: pass the run's existing admission gate so stop conditions
  surface as uncertainty with their own message.
- Do not widen the vocabulary: consumers branch on the three verdicts and the
  stable reason strings. New evidence classes should extend reasons, not
  verdicts.

## Testing

`test/ops/review/addressVerification.test.ts` covers the mandated fixtures:
omitted consumer/dependency attestation, deleted trigger surviving in after
content, in a cited consumer and in a cited dependency, a valid fix
resolving, deletion-only never closing, missing citable trigger, unpinned
and missing revision identity, malformed packets, rename refusal,
before/after coherence mismatches, cancellation, budget exhaustion, a
non-Error gate refusal, a check-side storage failure and the cross-scenario
verdict invariants (resolved has five passes; uncertain never carries a
fail; check names are always a canonical prefix).

The helper tests are pure computation on literals. The op-path tests in
`address.test.ts` and `address-pr.test.ts` exercise opt-in uncertainty,
unchanged default behavior, pinned snapshots despite live-file drift,
report persistence and PR-thread resolution refusal. They script model
responses; the local composition test uses real git.

The CLI fixture in `test/fixtures/review-closure-cli/entry.mjs` uses production
CLI dispatch and the production operation with a scripted fixer. It demonstrates
the closure gate, not real model quality. Commits that pass existing worker
checks remain eligible for publication even when deterministic closure is
uncertain; `verifiedHead` denotes worker validation, not a resolved finding.
The packet patch covers the finding file only, consistent with the verifier's
single-file contract; it is not a claim of complete multi-file evidence.
