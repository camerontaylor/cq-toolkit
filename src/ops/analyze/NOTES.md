# analyze family — adopt-vs-build notes: error clustering

Recorded: 2026-09-16 (phase 3, lane G, scope item 2). Question decided BEFORE
implementing `clusterErrors`: does an existing npm error-clustering/dedup
package, or an LLM-classify pass through the driver seam
(`src/driver/types.ts` `Driver`), beat hand-rolled signature clustering?

## Deciding constraint

The acceptance check is: the same failure set must always produce the SAME
stable cluster ids, property-tested (seeded shuffles of one fixture set yield
identical ids, confidences, and membership). Any option that cannot meet that
constraint unconditionally is disqualified, whatever its other merits.

## Packages surveyed (npm registry, read-only, 2026-09-16)

Every candidate below was looked up with `npm view` / `npm search` on the day
recorded; versions and last-modified dates are as returned by the registry
then.

| Package             | Version | Last modified | What it actually provides                                                                             |
| ------------------- | ------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| string-similarity   | 4.0.4   | 2023-05       | Dice-coefficient pair similarity between two strings. A METRIC, not a clusterer.                      |
| natural             | 8.1.1   | 2026-02       | General NLP toolkit: Jaro-Winkler, Levenshtein, Dice, tf-idf, naive-Bayes and other classifiers.      |
| density-clustering  | 1.3.0   | 2022-06       | DBSCAN / OPTICS / k-means over NUMERIC vectors.                                                       |
| hclust              | 1.0.2   | 2022-05       | Agglomerative hierarchical clustering over a distance matrix.                                         |
| fastest-levenshtein | 1.0.16  | 2022-08       | Levenshtein edit distance between two strings.                                                        |
| jaro-winkler        | 0.2.8   | 2022-06       | Jaro-Winkler string similarity.                                                                       |
| simhash             | 0.1.0   | 2022-06       | Simhash of a token list (near-duplicate detection).                                                   |
| minhash             | 0.0.9   | 2022-05       | MinHash document similarity.                                                                          |
| supercluster        | 9.1.0   | 2026-09       | Geospatial point clustering — wrong domain entirely (nearest search result, listed for completeness). |
| logparser           | 0.0.6   | —             | Parses nginx log files — unrelated despite the name.                                                  |
| error-stack-parser  | 2.1.4   | —             | Extracts frames from a JS error stack — no grouping.                                                  |

Searches for dedicated error-clustering / dedup / log-template-mining packages
(`npm search "error clustering"`, `npm search "error deduplication
fingerprint"`, plus direct lookups of the well-known log-template-mining
algorithm names) returned NO maintained npm package that mines message
templates or groups errors by rule+shape. The mature log-template-mining
algorithms from the research literature (the Drain/Spell family) were never
published to npm as maintained packages — the closest npm hits are nginx
parsers or abandoned experiments. The commercial error-trackers solve grouping
server-side with proprietary, unpublished algorithms; their SDKs expose no
clustering function.

## Assessment

1. **No candidate does the job.** Nothing surveyed takes typed tool failures
   and returns stable, content-derived cluster ids. Every candidate is at best
   a BUILDING BLOCK: a distance/similarity function (string-similarity,
   fastest-levenshtein, jaro-winkler, simhash, minhash) or a generic
   vector-clustering algorithm (density-clustering, hclust) that presumes the
   failures are already embedded as numeric vectors. Producing that embedding
   deterministically is exactly the hard part; handing it to a model or an
   embedding service reintroduces the non-determinism the constraint forbids.

2. **Even the useful block is not needed in v1.** A pairwise similarity
   threshold would only power CROSS-signature merging — which v1 deliberately
   does not do (see below). Adding a dependency for a code path the shipped
   design never executes cannot be justified: it widens the supply-chain
   surface (several candidates are unmaintained since 2022) for zero
   behavioral gain.

3. **Generic clusterers lose the identity property.** DBSCAN/hierarchical
   clustering make membership order- and parameter-sensitive (epsilon, linkage
   tie-breaking); pinning them to produce identical ids across runs means
   re-deriving a deterministic policy — hand-rolled work with a dependency
   attached.

## LLM-classify through the driver seam — assessed honestly

A batched "group these failures" prompt through `Driver.run()` was seriously
considered and rejected on three grounds:

- **Determinism (disqualifying).** A driver run samples from a model: the
  same failure set can cluster differently on repeat runs, and the model's
  grouping has no content-derived identity — cluster "ids" would be arbitrary
  labels, unstable across runs, models, and providers. The acceptance
  property test is structurally impossible to satisfy; it would have to be
  waived, which the rules do not allow for this check.
- **Budget.** Every clustering run spends input+output tokens scaling with
  the failure volume, plus reasoning tokens on some lanes, on an operation
  that is pure string shaping. The driver seam exists for work that needs a
  model (the family's later agentic remediation); routing deterministic data
  shaping through it converts a free, offline operation into a priced,
  network-dependent one that can also stop `aborted`/`budget` mid-run.
- **Failure surface.** A model-backed clusterer can refuse, hallucinate
  members that do not exist in the input, or drop members — each requiring
  its own detection and mapping onto the op-result taxonomy, for a result
  that is still not reproducible.

## Verdict

**Build hand-rolled.** v1 `clusterErrors` groups by EXACT signature only:
`tool + ruleId + message template` (volatile fragments — quoted strings,
paths, numbers — abstracted to placeholders; see `clusterErrors.ts` for the
precise, tested normalization). Cluster ids are FNV-1a 32-bit over the
canonical signature JSON, reusing `fnv1a32Hex` from the gates family — the
same house scheme as `fingerprint.ts`. No clustering dependency is added.

**Deliberately NOT in v1: cross-signature similarity merging.** Failures with
different signatures are never merged into one cluster, silently or
otherwise. Consequences, accepted and documented:

- Failure messages of the same rule that differ in SHAPE (not just volatile
  fragments) land in separate clusters — a burst of near-identical errors with
  slightly varied wording shows as several clusters instead of one.
- Confidence stays honest: every cluster's members agree on the exact
  signature, so a multi-member cluster is `high` and a singleton is `low`
  (one sample cannot distinguish signal from noise). The `medium` confidence
  value exists in the output contract for the future merge path — a
  similarity-merged cluster must be labeled `medium` and carry the merge
  explicitly — but v1 never emits it.

If a later slice wants similarity merging, the recorded options are: a
token-Dice or Levenshtein threshold over templates WITHIN one rule id (cheap,
deterministic, no dependency needed — the metric is ~15 lines and keeping it
in-tree beats a 2022-era micro-package), then gate the merged cluster at
`medium` confidence. Nothing in this survey changes the default: exact
signatures only, until evidence shows the split-cluster cost is real.

## G3 addendum — playbooks: format, verifier, quarantine, dispatch; the trace cut

Recorded: 2026-09-16 (phase 3, lane G, scope items 5–6). The playbook lane is
the authored-asset remediation path: a PLAYBOOK binds an ast-grep rule (the
codemod engine's rule, as a JSON object) to a VERIFIER command (the gates
CheckCommand shape), dispatch applies the rule over explicit targets and then
lets the playbook's OWN verifier decide whether the playbook remains
dispatchable.

### The trace cut (dispatch records vs the kernel journal)

The kernel journal seam (src/kernel/journal.ts) is PLAN-RUN-SHAPED: the frozen
`JournalEventSchema` union has no standalone dispatch event, and `append()`
requires `event.runId` to match the file's run. Faking a `runId`/`jobId` to
shoehorn a playbook dispatch into a run journal would inject false per-job
facts into the resume fold — disqualified. Decision: the dispatch RETURNS its
trace instead of persisting it. The exported `PlaybookDispatchRecord` shape
(discriminated by `kind: 'playbook-dispatch'`) rides `value.record` on the two
`ok` outcomes; the frozen OpResult taxonomy gives `indeterminate` no value
slot, so there the record rides `detail` as serialized JSON of the same shape;
an early `failed` termination (unknown id, containment fault, engine fault)
records no trace beyond the error string — nothing was applied, nothing was
quarantined. The full `trace` query op and a durable dispatch journal are
post-v1 (per the breakdown, this cut is recorded here and in the run journal
schema note above).

### Quarantine lane cuts

- **Process-scoped state.** The playbook registry and the quarantine ledger
  are in-memory singletons shared by all three playbook ops' importers. No
  file persistence in v1: registering a playbook and quarantining one are
  coherent within a process (one CLI invocation composing multiple
  dispatches, one SDK session, one test), not across processes.
- **No timestamps.** Records are exactly `{ playbookId, phase, reason }` and
  the ledger presents them sorted by id — the determinism contract. When a
  playbook entered quarantine is derivable, if a consumer needs it, from the
  dispatch trace records, not from the ledger.
- **`unquarantine` is deliberately library-only.** No op exposes it, so no
  autonomous path (plan or agent loop) can lift a quarantine; it is an
  explicit consumer action on the injected ledger, and nothing in the
  codebase calls it.
- **Phase tag.** `phase: 'verifier-failed'` is the only entry path in v1
  (an observed numeric non-zero verifier exit); the tag exists so a future
  entry path cannot masquerade as a verifier failure.

### Dispatch decisions worth recording

- **Verifier-failed maps to `ok`, not `failed`** (the regressionGate
  precedent): the dispatch ran to a DEFINITIVE verdict, and the verdict is the
  op's decision output — `outcome: 'verifier-failed'` with `quarantined: true`
  and the full per-file evidence. A bare `failed` error string could not carry
  the evidence, and the playbook's remediation WAS applied.
- **Verifier-indeterminate maps to `indeterminate` and quarantines NOTHING**
  (I5 in both directions): an unobservable verdict must not pass the
  remediation, and must not punish the playbook. The detail says plainly that
  edits are on disk but unverified.
- **The engine primitive's `approved: true` is satisfied inside dispatch.**
  Not a bypass: the gates that matter live around the engine — the quarantine
  consult before, the playbook's own verifier after — and dispatch is a
  consumer-invoked op (authored asset, registered by id, dispatched by id)
  that is NEVER in the shipped analyze plan (see src/plans/analyze.ts), so the
  plan runner's autonomous path cannot reach it (UC §1 row 9).
- **Schema split of labor.** The playbook format validates the rule as a
  non-empty JSON object (finite JSON values only, so the dispatch-time
  `JSON.stringify` is lossless) and the id against a safe-token pattern;
  global id uniqueness is the playbook registry's refusal at register time,
  and every ast-grep semantic is the engine's business at dispatch.
- **Same-playbook dispatches reject IN FLIGHT, not queue** (the registry's
  `withDispatch` slot): a dispatch of the SAME playbook arriving while
  another is unsettled is refused `needs-human` immediately, without
  running the engine or verifier — so a non-idempotent rule can never be
  double-applied, whatever the in-flight dispatch's verdict (queueing would
  re-apply after a PASS). After settlement the slot frees and a NEW
  dispatch proceeds normally through the quarantine check: a deliberate
  re-dispatch of a passed playbook is an explicit consumer action. Different
  playbooks dispatch unserialized. Process-scoped, like the registry and
  ledger themselves; the cross-process story is the same process-scoped cut.
- **Post-v1 cut: a verifier-only retry op.** The indeterminate-verifier
  outcome tells the consumer to re-run the VERIFIER on its own (never to
  blindly re-dispatch, which would re-apply the rule); a first-class
  verifier-only retry op is recorded here as post-v1, not built now.

### End-to-end acceptance evidence (test/e2e/analyze)

The flagship e2e runs the real chain on a temp fixture repo: real `tsc`
(via the typescript devDependency's own JS entry, so it does not depend on
PATH) reports three homogeneous TS2551 diagnostics across three files →
`gates.checkRunner` ('tsc-lines') → `analyze.collectFailures` →
`analyze.clusterErrors` (ONE high-confidence cluster) →
`analyze.renderAnalysisReport` (real sidecar on disk) →
`analyze.applyRemediation` (cluster id + approved + the consumer rule) →
re-run tsc clean → `gates.regressionGate` verdict 'no-regression'. The codemod
step runs the REAL ast-grep binary when it is on PATH (vitest runIf) and a
scripted runner returning the correct wire-shape plan for the same rule
otherwise (and always as a second, deterministic leg); the test logs which
mode ran. The quarantine miniature in the same file dispatches a playbook
whose verifier fails, asserts the quarantine record, and asserts the second
dispatch is refused.

### W4.3 — the approval token at the mutation, and rollback on a non-passing verifier

Recorded: B12 (branch `cq02/remediation`, from `dd247ca`). The two
reconciliation rows ADR-0003 §4c left open are resolved here, and both
resolutions are decisions with a stated alternative, not defaults.

- **O-5 — where the workspace mutation lock's RECORD lives: BESIDE the
  operator approval ledger, in the P1-trusted layer, keyed on
  `sha256(realpath(workspace))`** (`makeLedgerBesideMutationLocks`, built
  on the sweep lane's existing `makeGitMutex` — no new lock subsystem). The
  two candidates ADR-0003 rejected are excluded on evidence: an
  environment-derived location (`os.tmpdir()`, `$XDG_STATE_HOME`)
  reintroduces ADR §2.5's split-brain, and a record inside the workspace is
  tamper vector #26 — the very tree under approval. `approval.ts` also
  REFUSES a trusted layer that resolves inside the workspace it protects.
  The process-local lock is offered for tests and single-process callers and
  claims nothing cross-process; that claim is stated in its doc comment
  rather than left to be assumed.
- **O-6 — do non-approval writers take the lock: closed for THIS path, and
  it took two attempts to get right.** The first version of this patch
  claimed the question was vacuous because "every write holds the lock".
  That was wrong, and a security review caught it: a ROLLBACK is a write
  too. The dispatch released the lock when the engine call returned and
  only wrote the pre-apply bytes back after the verifier had run, so a
  concurrent approved dispatch of another playbook could land in that
  window and have its edit silently discarded by this one's rollback — a
  lost update between the ops' OWN writers, which no amount of "the
  workspace is under approval" excuses. Two changes close it:
  1. the restore runs under the SAME mutation lock (`withMutationLock`,
     exported from `approval.ts` precisely so a second mutation of the same
     workspace serializes like the first);
  2. the restore is CONDITIONAL — it writes the pre-apply bytes back only
     if the file still holds the exact bytes THIS dispatch wrote, compared
     by a `sha256` fingerprint read back inside the apply's own critical
     section. A file that no longer matches belongs to another writer and is
     reported STRANDED, UNTOUCHED, with both digests.
     A non-approval writer OUTSIDE the lock remains ADR §2.7's open residual
     (a post-mutation-hook hazard) and is NOT closed here: no such writer was
     modified to make it look closed. What is closed is the lost update
     between writes this module itself performs.
- **The trusted-layer containment guard was shipped reversed and is fixed.**
  `isInside(parent, child)` asks whether CHILD is nested in PARENT; the
  call site passed them the other way round, so it refused the harmless
  layouts (a ledger under `$HOME/state` beside a workspace under `$HOME`)
  and ALLOWED the actual tamper vector (a ledger inside the workspace). The
  argument order is now commented at the call site, and the three cases the
  reversal got wrong are pinned together in `approval.test.ts`: an ancestor
  trusted layer is allowed, a nested one is refused even through a symlink
  and before it exists on disk, and a prefix-sharing sibling (`/ws` vs
  `/ws-cq`) is not "inside". Path resolution for that comparison also
  resolves the longest EXISTING ancestor and rejoins the tail, because plain
  `realpathSync` throws on a not-yet-created ledger directory and the raw
  fallback compared `/var/...` against `/private/var/...` and missed the
  nesting — silently, in the most common configuration.
- **Rollback is a step, not a side effect.** The dispatch captures every
  target's pre-apply bytes before the engine runs, and a `fail` or an
  `indeterminate` verdict restores them through the same store, under the
  mutation lock, conditionally on the post-apply bytes (see O-6). A restore
  that cannot put a file back — a write fault OR a conflict with a
  concurrent writer — reports that file as STRANDED, and the prose then
  says the workspace is NOT at its pre-dispatch state; the report never
  claims a clean rollback it did not achieve. A post-apply re-read failure
  is its own outcome: the apply happened, the rollback cannot be proven
  safe, so NO restore is attempted and the op says exactly that.
- **A failed verifier is a `failed` dispatch, not an `ok` with a bad
  outcome.** This reverses the old regressionGate "a definitive verdict is
  the op's decision output" mapping, and the header says why: once step 5
  restores the workspace there is no applied state left to report, and a
  bare `ok` is exactly what a status-only reader takes as success. The
  structured evidence moved to serialized JSON in `error`/`detail` (the
  frozen `OpResult` taxonomy has no payload slot) under the
  `PlaybookDispatchUnverified` shape.
- **The signature half of ADR-0003 is NOT re-implemented here.** The kernel
  verifier owns the signer snapshot, the TTL and the `inputsHash` check; this
  patch consumes a `VerifiedApprovals` seam. The ops therefore default to
  the DENY-ALL authority: with no authority bound, an apply or a dispatch is
  refused `needs-human` and writes nothing, which is the A16 forged-
  `approved: true` state.

### Second security review — three state-binding corrections

- **The nonce seam now carries the SIGNED state, and admission compares
  it.** `VerifiedApprovals` returns `{ nonce, state }`, not a bare nonce.
  The kernel's signature check and this op's admission are two different
  instants; with only a nonce, a workspace mutated BETWEEN them had its
  post-mutation state silently adopted as the baseline the exercise then
  re-checked — the module re-verified itself against a state no human had
  ever seen. Admission now refuses on any difference between the claim's
  `state` and the state read at admission, with the nonce UNSPENT.
  _Integration contract:_ the adapter MUST source `state` from the
  verified claim. Re-reading it at call time collapses the two moments back
  into one and reopens the window; an adapter that cannot supply it must
  return `undefined` (refusal), not a guess.
- **A dirty workspace is not an approvable state** — and this is the
  ACCEPTED ADR's own requirement, not a local tightening of it. Verified
  against the accepted `bf5f540`
  `research/research-20260925-v11/adr-0003-approval-token.md`: §4c step 1
  requires the clean predicate to be EMPTY
  (`git status --porcelain=v1 --untracked-files=all`, untracked files
  counting as dirty), §4c's enumerated refusal reasons include
  `workspace dirty`, and §7 lists "a dirty tree from an untracked file" as a
  required `needs-human` case. The observable contract this module
  implements — `needs-human`, the `workspace dirty` reason, no write, no
  spend — is the ADR's, and the refusal reason quotes the ADR's own token
  so a refusal is traceable to the clause that requires it.
  CORRECTION: an earlier revision of this note described the refusal as a
  "deliberate tightening … a divergence needing the ADR owner's sign-off",
  and listed that sign-off as an open lease. That claim was WRONG — it
  misread the ADR's predicate as a bare boolean comparison rather than an
  emptiness requirement — and the conductor's ruling (on this accepted
  text) confirmed it. The behavior is unchanged and required; only the
  description and the phantom lease were wrong. The check sits at ADMISSION
  rather than only at the exercise because the claim's `treeClean` is a
  boolean that cannot distinguish one dirty state from another (same
  boolean, same HEAD, different bytes); refusing before a grant is minted
  means that comparison is never reached, and an earlier refusal spends
  nothing. Ignored files remain out of scope of the state predicate — the
  ADR's own stated residual, unchanged here.
- **The durable ledger is now actually durable.** `appendFileSync` returns
  once the bytes are in the OS page cache, so a machine crash could lose a
  spent nonce and leave the token REPLAYABLE — the exact outcome §4c's
  crash analysis exists to prevent, while the function claimed otherwise.
  The append now goes through an append-mode handle with `fdatasync`, and
  the ledger's directory is fsync'd once when the file is created, matching
  the journal's own `durable: true` idiom (src/kernel/journal.ts) rather
  than a hand-rolled idea. Two residuals remain and are stated in the code:
  macOS `F_FULLFSYNC` is not issued (a power-loss window the journal
  documents too), and the ledger is a plain file, not a MAC'd one — it is
  trusted because it lives in the P1-trusted layer (ADR §1), not because it
  is tamper-evident.
- **The append is write-ALL, fails closed, and a torn ledger is CORRUPTION
  — not history.** `fs.writeSync` RETURNS a byte count and does not promise
  the whole buffer, so the first version's single unchecked call could
  `fdatasync` a TRUNCATED line, report `consumed`, and leave the full nonce
  absent from the ledger — after which that same token replays cleanly, the
  exact outcome the ledger exists to prevent. The write now loops to
  completion, and a write that cannot make progress (or that over-reports)
  THROWS, which `exercise` turns into a `needs-human` refusal with the
  nonce UNSPENT.
  A torn record is deliberately NOT truncated away: the file is shared, and
  truncating to a remembered length could discard a CONCURRENT append,
  turning a safe failure into an unsafe replay of another writer's token.
  It is instead made DETECTABLE and fatal, because a torn tail is not inert
  after all — the next O_APPEND fuses the partial record with the following
  one into a line matching neither nonce, and a fresh instance absorbing
  that merged line would never see the real nonce as spent. So the durable
  ledger (a) refuses to append when the file ends with an unterminated
  record, and (b) validates EVERY record it reads against ADR-0003 §2's
  nonce shape (32 lowercase hex), failing the whole read closed on any
  malformed line. Reading history wrong is worse than refusing to read it:
  the operator must inspect and repair the file. The in-process ledger has
  no such corruption mode and validates nothing, which is stated on it.

### A lock fault reports the phase it actually reached

The exercise runs INSIDE the mutation lock, so a fault ACQUIRING the lock has
not spent the token, while a fault releasing or compromising it has. An
earlier handler claimed "already EXERCISED, so the token is spent" for every
lock fault, which is false for the acquire case — a message that asserts a
fact it cannot know. `applyRemediation` now records whether the write was
entered and reports the matching fate (UNSPENT and re-approvable vs spent
and unreplayable), while the dispatch's rollback still marks every applied
file STRANDED, because a section whose exclusivity cannot be proven proves
no restore either way.

### Open integration lease (for the #238 / kernel owner, NOT done here)

1. `src/ops/analyze/registry.ts` is #238's file and was deliberately not
   edited. Both call sites still compose the ops with no authority, so the
   shipped, registry-composed `analyze.applyRemediation` and
   `analyze.playbookDispatch` REFUSE every write until the kernel's verified
   approvals are bound. That is fail-closed by design, but it is a real
   functional change to the registry path and needs the adapter to land.
2. The generated op docs describe the pre-W4.3 approval semantics
   ("approved: true" as sufficient). `gen:op-docs` is generated from the
   registry description, so the text moves with (1).
3. `currentJobContext().approval` (ADR §4b step 7) and the journal's
   `approval-consumed` event are kernel work; this patch consumes the
   exercised grant at the op and leaves the durable audit record to that
   lane rather than inventing a second journal shape.
4. ADR-0003 §5's "same host, fresh `--journal-dir`" replay case is enforced
   by the DURABLE ledger (`makeFileNonceLedger`); the process-local ledger
   cannot enforce it and does not claim to.
5. **Not safe for production binding until (1) above is wired.** With the
   deny-all default the ops refuse every write, so there is no unsafe state
   in the tree today; the risk is the adapter that binds the kernel
   approvals. It inherits this contract: source `state` from the verified
   claim, refuse rather than guess, and keep the deny-all default for any
   subject the verifier has not approved.
6. The journal's `approval-consumed` audit record (kid, nonce, subject
   hash; token BYTES never) is still unwritten — this module consumes the
   grant durably in the operator ledger but emits no journal event, so the
   tamper-protection the journal fold would give is absent until the kernel
   lane writes it.
