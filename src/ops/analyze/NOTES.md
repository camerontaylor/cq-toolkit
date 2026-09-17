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
