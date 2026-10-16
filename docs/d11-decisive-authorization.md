# Decisive D11 authorization (C3 readiness T1/T2)

Status: design for the held PR that makes D11 override records decisive at
the promotion gate once C3 is attested. Normative sources: ADR-0004 D-C.3
(push-subject rule), D-G.4 (the record), D-H.3/D-H.4 (C3 attestation,
break-glass), D-K.3/D-K.4 (closure, recompute). Until
`policy/attestations/c3.json` is on the trust ref nothing here changes a
verdict: every valid record is `dormant`, logged, and the gate refuses.

## The decision

One pure module, `src/ops/gates/d11Authorization.ts`, owns the predicate.
Callers do the I/O and hand it plain data:

- `bindD11Authorization({ ownerId, attestation, prs })` builds the bound
  object `D11Authorization`. Per admitted PR it takes the merge `M`, the
  merged head `M^2`, the paths `diff(M^1, M)` changes (the PR's
  contribution), the PR's timeline label events, and the head-observation
  epoch. It evaluates each record with `evaluateOverrideLabel` (D-G.4:
  `actor.id === owner id`, `actor.type === 'User'`,
  `performed_via_github_app === null`, `created_at` strictly after the
  epoch). `attested` is `parseC3Attestation(text).armed` for the attestation
  as read **at the trust ref**, never the head or tip.
- `authorizePaths(auth, paths)` decides a set of paths that need a human. A
  path is authorized iff at least one admitted contribution changes it and
  **every** admitted contribution that changes it carries an `honoured`
  record. It returns `{ authorized, unauthorized: [{ path, why }], lines }`,
  naming the exact PRs, merges and paths that fail.

### Why attribution is by first-parent merge step

"Every commit in `main..tip` that introduces it" (D-C.3) is taken over the
first-parent chain: each admitted merge `M` contributes `diff(M^1, M)`.
The gate has already proved each such merge clean (step 4), so that diff
is exactly what the PR brought into the queue, and the union of the step
diffs covers `diff(main, subject)`. Per-commit attribution would be
ambiguous (a commit can be reachable from two PR heads) and would credit
the wrong PR for a change two PRs both touched. With step attribution, a
path two PRs changed needs both PRs' records, and one label never
authorizes another PR's change.

## policyDiff, `subjectKind: 'push'`

`PolicyDiffInput.authorization?: D11Authorization` is accepted in-process
only; the strict CLI schema (`PolicyDiffInputSchema`) cannot carry it.
policyDiff performs no new `gh` call. After the findings are computed:

- `lint` findings stay `fail`; a record never turns a fail into a pass.
- If the verdict is `needs-human` and an authorization is bound, the paths
  of the findings that made it needs-human (all findings under `human`;
  non-`protected-path` findings under `diff-check`) go to `authorizePaths`.
  All authorized → `pass`; otherwise `needs-human` and the report lists
  every unauthorized path with its reason. The outcome carries the decision
  (`d11`) so the gate can revalidate it.
- No authorization bound → today's behaviour (needs-human), with a note.
- PR subjects keep their existing path (label file, settle ref,
  attestation at the trust ref), which already uses the same record
  evaluator.

A finding whose `path` is not a changed path (`unsafe-path`, an
unresolvable `./action`, a multi-workflow required-check removal) is never
in any contribution, so it stays needs-human: fail closed.

## promote-gate becomes decisive

Step 7's logged-only `logOverrides` (which passed `headObservedAt:
undefined, attested: false`) is replaced by `d11Evidence`, run before the
policy pass:

1. owner id from `GET repos/{o}/{n}`;
2. the attestation via `git.readBlob(trustRef, C3_ATTESTATION_PATH)`;
3. per admitted PR: paginated timeline label events, and
   `git.changedPaths(M^1, M)`;
4. the epoch from the `cq-state` history (below).

The bound object is passed to `policyDiff` for `main..subject`. Every
record is echoed in the run report (D-G.4 "journalled and echoed"). Any
verdict but `pass` refuses, as today. After the waits (step 10a), when the
pass relied on records, the gate re-reads the evidence and re-runs the
policy pass; anything but `pass` refuses (an `unlabeled` during the wait
moves no ref, so the leases cannot catch it).

### The epoch: `cq-state` history, not the tip

The observer prunes the ledger to open PRs (`merge-recheck.ts`
`pruneToOpen`), so a merged PR's record can be gone from the `cq-state`
tip before the gate runs. The gate lists the ledger's commits newest first
(at most `SETTLE_HISTORY_MAX` versions) and reads versions until each
admitted PR is found. `headObservationEpochInHistory` takes the newest
version that holds a record for the PR: if that record's tuple head is
the merged head, the epoch is its first observation; otherwise there is
none. An older version holding an earlier head is never consulted, so a
superseded observation cannot anchor the label.

## verifyRatchet shares the same object

`VerifyRatchetInput.authorization?: D11Authorization` (in-process only;
the strict CLI schema is unchanged). When the subject changes definitions
and an authorization is bound, `authorizePaths(auth, definitionChanges)`
decides: authorized → the verdict is judged from the guard and the ratchet
results (the evidence was produced under the head's new definitions; lists
and baselines still come from the trust ref, the stricter baseline still
applies); unauthorized → needs-human naming the paths. There is no second
predicate. The `cq-verify` carrier does not yet gather the evidence, so the
`cq/ratchet` verdict stays needs-human for definition changes until a
follow-up wires it (open question 2).

## Fail-closed cases

Each of these leaves the affected path unauthorized (needs-human) and is
named in the report:

| Case                                                                                        | Mechanism                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Settle ledger absent or unreadable, or the PR not in the last `SETTLE_HISTORY_MAX` versions | no epoch → record `invalid`                       |
| Attestation absent, unreadable, or schema-invalid at the trust ref                          | `attested: false` → record `dormant`              |
| Label applied at or before the epoch                                                        | `invalid` (strictly after)                        |
| Label applied via a GitHub App, or by anyone but the owner's `User`                         | `invalid`                                         |
| Owner id unreadable                                                                         | every record `invalid`                            |
| Label events unreadable                                                                     | that PR's record `invalid`                        |
| Path changed by no admitted contribution (PR not in the closure)                            | `not contributed by any admitted PR`              |
| Two contributions claim the same merge, or one PR twice (ambiguous)                         | both records `invalid`                            |
| Closure violation, ambiguous merge PR, evil merge                                           | the gate refuses before any authorization (D-K.3) |
| `lint` finding                                                                              | `fail`, never authorizable                        |

The `absent` and `dormant` cases keep today's behaviour exactly.

## Not in this change

- The D-G.4 APPROVED-review record form (W1.10): only the label form is
  evaluated.
- The `cq-verify` carrier gathering D11 evidence, and the lockfile-driven
  typecheck toolchain choice (D-C.3): protected workflow templates.
- No new env keys, provider/model literals or `gh` calls in policyDiff.

## Open questions for the owner

1. D-D.2's outside-Actions residual: a non-Actions session holding the
   owner credential still produces a record these checks accept.
2. Whether the `cq-verify` carrier slice (T2 wiring) lands before C3, or
   authorized definition changes keep promoting by break-glass after C3
   until it does.
3. Sync PRs: a sync merge whose contribution touches a protected path
   needs its own record. That is conservative; confirm it is wanted.
