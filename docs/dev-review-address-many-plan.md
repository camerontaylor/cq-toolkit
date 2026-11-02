# Bulk address planning contract

This package is the pure planning contract for the planned S8
`review.addressMany` operation (card R5). It adds three decisions as data —
selection, shared-allocation admission and per-PR aggregation — and nothing
else. It performs no I/O, has no runtime imports, reads no configuration and
dispatches no driver, forge, queue, provider or provider CLI. The source
baseline is `0a45e5c2951206b317858f07d349aed9732c7198`, targeting
`main`.

The module is `src/ops/review/internal/addressManyPlan.ts`, imported only by
`test/ops/review/addressManyPlan.test.ts`. It is not an op: it is absent from
the review family registry, the CLI grammar, `review/index.ts`, the package
exports and the generated op docs, and it establishes no new shared producer
witness.

## Selection

`selectAddressMany` reads a listing the caller asserts is complete and applies
an explicit policy: repository, owner, optional viewer and an optional bot
login allowlist. Rules:

- Logins and repositories compare case-insensitively and the listing's original
  spelling is preserved in the candidates.
- `author.type === 'Bot'` is never authority on its own. Only an explicit
  allowlist entry authorizes a bot, and that match requires the server-reported
  type to be `Bot`: a `User` or `Organization` entry reusing an allowlisted bot
  login stays an unauthorized author. An empty or absent allowlist authorizes
  no bot at all, owner and viewer authority are independent of the type, and no
  trusted bot names are invented.
- Candidate identity is `(repo, number)`; a repeated number refuses the listing
  (below). The **admission ledger** binds the admitted head alongside that
  identity, so the same PR at a different head is a different admission
  identity, while two PRs that share one branch stay two distinct candidates.
- Structural defects — an incomplete listing, a listing or entry for another
  repository, a missing draft flag, a blank head ref, a non-40-hex head, a
  non-positive number, a repeated number — **refuse the listing** with the
  offending entries. Refusal precedence is: incomplete listing, repo mismatch,
  invalid facts, duplicate PR. A refused listing is never an empty success.
- Valid PRs that policy excludes are reported individually: not open, draft,
  deleted head repository, or unauthorized author (with the author's server
  type). Malformed policy is a programmer error and throws.

## Admission

The ledger bounds an **allocation**, never spend. `limitTokens` is a positive
safe integer and reservations are positive safe integers; every state returned
with `stop === null` satisfies `observedTokens + Σ held ≤ limitTokens`, and a
state with a non-null `stop` is a truthful record of a breach or an unpriceable
hold that makes no such claim.

- Admission refuses, without mutating the ledger, an invalid reservation, a
  repeated reservation id, a second id for an identity already held
  (`repo`, `PR`, head), a stopped ledger, or a request above the remaining
  allocation. The exact boundary admits.
- A reservation settles exactly once, at its own identity and head. Known zero
  usage is legal and does not stop admission.
- Unknown usage keeps the **full allocation visibly held** as `unresolved`,
  sets a sticky `unknown-usage` stop, preserves every sibling and refunds
  nothing. Settling it again is refused.
- Overrun is exact: actual usage above the reservation's own allocation, or a
  post-settlement `observed + remaining held` above the cap (a defensive arm for
  hand-built ledgers). An overrun is recorded, reported and stops further
  admission.
- A stop gates **admission only**: held reservations still settle, so bounded
  in-flight work can land after the stop.
- `DEFAULT_ADDRESS_MANY_CONCURRENCY` (three) and
  `resolveAddressManyConcurrency` are planning inputs. Nothing here enforces
  provider spend, provider concurrency or a scheduler, and the governor's
  USD-only `reserve` is untouched.

## Aggregate

`aggregateAddressMany` requires the **exact selected candidate set**. An empty
set, a duplicate candidate, or an outcome that is missing, extra, duplicated or
self-contradictory is a refusal: a roll-up over a subset could otherwise report
`ok` for work that was never admitted.

- Every row carries its original per-PR result verbatim, including when
  attribution fails. The report itself follows the producer's asymmetric public
  shape: a successful (`ok`) result carries it in `value`, a non-ok result in
  `report`.
- A `needs-human` leg whose structured `report.stop` is `budget` is classified
  as the budget-stopped outcome (never success, never an ordinary needs-human
  refusal), with its original result and reason preserved; a bare
  `budget-exhausted` result maps to the same outcome.
- The only trusted head evidence is the producer's immutable
  `report.admissionHead` witness equalling the admitted head. `verifiedHead`
  advances with verified fix commits and `rounds[].record.head` is
  **overwritten** by a successful re-review, so neither is evidence and neither
  is a fallback. A missing report, a missing witness or a mismatch is
  `unattributed`, which is never success. A report that admitted earlier work
  keeps its witness through a later refusal; a refusal _before_ admission has
  none, and the injected-disposition bypass never fabricates one. This
  deliberately rejects an otherwise-good early report rather than inventing
  attribution.
- Findings are scoped by `repo`/`PR`/head and are never deduplicated, globally
  or within one PR: identical ids in two PRs both survive.
- `fixesPerRun` is counted only from a head-attributed report; the original
  value stays in the retained result. A `verifiedHead` that advanced past the
  admitted head is legitimate local work, never publication.
- Publication is always `unknown`: no exported structured per-range publication
  witness exists, and report `reasons` are prose that is never parsed.
- Enrollment is externally supplied advisory metadata with three states
  (not requested, enrolled, unavailable). `unavailable` is never completion and
  changes no status. A composition that needs enrollment to block requires its
  own explicit policy input and owner contract.
- Deferred vendor debt is reported separately: `present` only from a trusted
  report, `unknown` when the report's head is not attributable, `absent`
  otherwise.
- Status precedence is deterministic: a definitive failure (failed,
  indeterminate, exception) outranks a budget stop (sticky stop, any held
  allocation, over-cap accounting, a budget-exhausted leg, a budget-blocked
  leg), which outranks an incomplete or unattributed run; `ok` requires every
  candidate to be a head-attributed `settled-ok` with a clean ledger.

## Fixtures

`test/ops/review/addressManyPlan.test.ts` is scripted and offline: no git, no
child process, no forge, no queue and no provider. It covers owner/viewer/
allowlisted-bot selection with original spelling, an allowlisted login carried
by a `User` or `Organization` and a non-allowlisted `Bot` (all excluded), an
empty allowlist, closed,
merged, draft and deleted-head exclusions, incomplete listing, repo mismatch,
invalid facts, duplicate numbers, one branch on two numbers, the exact
admission boundary and its one-over refusal, invalid reservations, duplicate ids
and identities, single settlement, head-mismatched settlement, unknown usage
holding its allocation across sibling settlement, known zero usage, both overrun
arms, a factual initial breach, empty/duplicate/foreign coverage, missing,
extra, duplicate and contradictory outcomes, unattributed ok results, duplicate
finding ids across PRs, fixes against an advanced head, one unclean PR beside a
clean one, a held or unresolved sibling, failure outranking a budget stop,
exceptions and cancelled legs, advisory enrollment, deferred debt, and debt that
is unknown at an unattributed head.

## Not claimed

No `review.addressMany` operation, per-PR worktree dispatch, agent review or
thread handling, inline CodeRabbit call, enrollment transport, registry or CLI
wiring, run-token governor integration, package export or generated op doc
exists here. Admissions do not enforce spend, and the current runtime remains
**serial per Git common directory** because `review.address` holds the
common-dir `cq-review-address-ownership` lock for a whole invocation; resolving
linked worktrees is not concurrent address execution. These offline fixtures do
not satisfy the O2 live release gate, prove fixes per run, or establish live
usability, CodeRabbit credit, queue readiness or merge acceptance. Integration
still waits on coordinated ownership of the shared budget, registry and CLI
seams.
