# Architecture decision records

The owner accepted ADR-0001 through ADR-0004 at the G1 gate on 2026-09-26.
They were drafted and reviewed outside this repository. The texts here are
edited for publication: review history, internal process notes and private
references are removed, and no decision has been changed.

Each ADR is a historical design record. It states what was accepted and is
not rewritten when the implementation later diverges or a later decision
narrows it. Known changes of that kind are recorded below as
[post-acceptance notes](#post-acceptance-notes), and the affected section of
each ADR points to its note. The list is not exhaustive: where a note and the
code disagree with an ADR, the code and the notes are current.

| ADR                                                                               | Decides                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [ADR-0001 — Worker/driver seam](0001-worker-driver-seam.md)                       | The four driver lanes, the `Driver.run` seam contract and the served-model rule                            |
| [ADR-0002 — Worker/driver seam v2](0002-worker-driver-seam-v2.md)                 | Output schema, cancellation, workspace binding and error classes on the seam; `DriverFactory`              |
| [ADR-0002 Annex A — MCP harness server](0002-annex-a-mcp-harness.md)              | The shared harness tool surface and the stdio MCP server for the subprocess and claude-agent lanes         |
| [ADR-0002 Annex B — Configuration keys](0002-annex-b-config.md)                   | The `CQ_*` key namespace, precedence, secrets and CI mapping (it also defines ADR-0003's keys)             |
| [ADR-0003 — Governed runner](0003-governed-runner.md)                             | `runPlan` governance: budget reservations, admission, lane classification, crash and resume, exit contract |
| [ADR-0003 annex — Approval token](0003-approval-token.md)                         | The signed, single-use human approval for `approved: true` jobs                                            |
| [ADR-0003 annex — Journal v2](0003-journal-migration.md)                          | The journal v2 schema and replay rules                                                                     |
| [ADR-0004 — Policy-check trust boundaries](0004-policy-check-trust-boundaries.md) | Where policy checks get their code and definitions, credentials and identities, and promotion              |

## Terms and identifiers

The ADRs keep a few identifiers from the project's plan where they say when
something lands or which rule applies. The plan itself is not published.

- **Gates.** G1 accepts the ADRs. G2 is prepublication sign-off on the
  adversarial evidence ([adversarial suite](../adversarial-suite.md), rows
  A1–A20). G3 completes the postpublication proofs.
- **Doctrine invariants I1–I11** are in [policy/DOCTRINE.md](../../policy/DOCTRINE.md).
- **Principles.**
  - P1: trust inputs and the code that checks them come from outside the
    checked party.
  - P2: one published seam bump (ADR-0002 with ADR-0003), landed in internal
    slices.
  - P3: one real-environment test per invariant, besides unit tests.
  - P7: layered configuration, resolved built-in default → project env
    (`CQ_*`) → per-call opt-in, with the last layer winning.
  - P8: conservative by default, relaxed by configuration.
- **Owner decisions.**
  - D2: a dedicated automation identity replaces the owner's token, and it is
    never a trusted reviewer.
  - D3: the acceptance trust set is configurable and conservative when blank.
  - D5: budgets are ceilings in modeled API-equivalent units and include
    provider limits.
  - D11: protected-path changes need human approval, or a base-ref policy diff
    check where configured.
  - D13: repository settings are captured as code with a drift check.
  - D14: sandboxing is supported and conservative when blank.
- **Open points** O-1…O-8 were left open at acceptance. Each is stated where
  it arises: O-1 and O-2 in ADR-0002, O-3 to O-6 and O-8 in ADR-0003 §6 and
  the approval-token annex, O-7 in ADR-0004 D-K.
- **Design debts** DD-1…DD-9 are tracked limitations; some have their own
  notes, such as [DD-1](../dd-1-abort-spike.md),
  [DD-2](../dd-2-usd-normalization.md) and
  [DD-9](../dd-9-api-equivalent-budget.md).
- **Work labels.** `W<n>.<m>` are plan work items. S1–S6 are ADR-0002's
  landing slices (ADR-0002 §4). `RS-<n>` names the research study behind a
  section. These are labels only and need no lookup.

## Post-acceptance notes

Recorded 2026-10-08 (N1–N10) and 2026-10-11 (N11–N17), each set rechecked
against `merge-queue` the same day. Each note names the accepted text, what
changed or remains open, and where the current source of truth is.

### N1 — ADR-0003 §2.9: `signal` exit codes

§2.9 maps the `signal` early stop to 130 (SIGINT) and 143 (SIGTERM), widening
the exit contract from four codes to six. Doctrine
[I1](../../policy/DOCTRINE.md) is canonical and fixes the codes at
`{0,1,2,3}`. The implementation follows I1: `signal` maps to 3, like a
needs-human stop ([`src/cli/exit.ts`](../../src/cli/exit.ts) header). The
130/143 row and the widening are **not in force** unless the owner amends I1.

### N2 — Annex A §A.3: `2026-07-28` is not a supported revision

§A.3 lists `2024-11-05` … `2026-07-28` as the supported MCP revisions. The
`2026-07-28` revision replaces the `initialize` handshake with
`server/discover`, which this server does not implement, so the server does
not advertise it. The newest supported revision is `2025-11-25`
([`src/harness/mcp/server.ts`](../../src/harness/mcp/server.ts),
`SUPPORTED_PROTOCOL_VERSIONS`).

### N3 — Annex B §B.3 and §B.8.7: `WINDOW_FRACTIONS` values

§B.3 restricts `map` values to `[a-z0-9*/-]+`, but §B.8.7 gives
`WINDOW_FRACTIONS` values such as `5h:0.2,weekly:0.5`. The values are decimal
fractions. The resolver accepts a fraction from 0 to 1 as the value of a
`CQ_PROVIDER_<ID>_WINDOW_FRACTIONS` entry; every other `map` key keeps the
§B.3 grammar ([`src/config/resolve.ts`](../../src/config/resolve.ts)).

### N4 — Annex B Decision, §B.5 and §B.7: secrets are env-only

The Decision section says secrets come from the env layer only, but §B.5's
CQ secret row allows an SDK typed option, and §B.7 types
`secrets[...].layer` as `'env' | 'call'`. The implementation follows the
env-only rule: secret provenance is recorded with `layer: 'env'`
([`src/config/resolve.ts`](../../src/config/resolve.ts)), and
`CQ_AUTOMATION_TOKEN` is read from the environment and nowhere else
([`src/ops/ratchet/effects.ts`](../../src/ops/ratchet/effects.ts), `ghEnv`).
Read the CQ secret row as env-only and `layer` as `'env'`.

### N5 — Approval-token annex §4c and §7: writers outside the lock

§4c leaves open point O-6 open: writers that are not approval-gated do not
take the mutation lock. §7's concurrent-writer test assumes an O-6 rule, so it
is conditional, not a closed guarantee. O-6 is resolved only for the analyze
remediation path, where every write is approval-gated and holds the lock
([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts) header).
A writer outside the lock remains the open residual of ADR-0003 §2.7.

### N6 — ADR-0003 §2.7: which refusals are non-burning

§2.7 says every pre-write refusal is non-burning. The approval-token annex
§4c appends the nonce to the operator ledger before the journal's
`approval-consumed` record, so a crash between the two spends the token.
Read §2.7 as: every refusal **before the operator-ledger append** is
non-burning. A failure after the append, including a ledger sync or close
fault, may leave the token spent, and the operator re-approves
([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts),
`exercise`). The journal `approval-consumed` record is not implemented yet
([`src/ops/analyze/NOTES.md`](../../src/ops/analyze/NOTES.md)).

### N7 — ADR-0004 D-C.2 and D-F.2: pagination and run conclusions

D-C.2's `GET /commits/{sha}/pulls` lookup returns a REST list and must
paginate; `cq-verify` and `cq-policy` do
([`policy/templates/cq-verify.yml`](../../policy/templates/cq-verify.yml)).
D-F.2 lists the run lookup and the runner and step checks, but not the
conclusions. The promotion gate also requires a completed run with
conclusion `success`, at least one job, and every job completed with
`success`; a `skipped` job is not success
([`src/selfhost/promote-gate.ts`](../../src/selfhost/promote-gate.ts),
`checkVerifiedRun`).

### N8 — ADR-0004 D-D.2, D-D.3 and D-H.3 C3: the drill credential

D-D.2 bars any human-authenticating credential from the repository's
workflows and environments once cutover completes. D-D.3 (and Appendix C)
give the live-merge drill a credential of a non-collaborator second
identity, which cannot produce trust-set records, with its PAT kept in the
`drill` environment.
D-D.2 states no exception for it, and C3 revokes only `GH_TOKEN` and
`PROMOTE_TOKEN`. The settings template allowlists the drill PATs
permanently, outside the interim set
([`policy/templates/github-settings.json`](../../policy/templates/github-settings.json),
`drill`). **Open:** before C3, the owner decides whether D-D.2 gains an
explicit exception for the drill PAT, or C3 also revokes it and the drill
moves to non-human authentication.

### N9 — ADR-0004 D-B, D-C.4 and D-E: npm commands after the move to pnpm

ADR-0004 was written when the repository used npm, so it names
`npm ci --ignore-scripts`, `package-lock.json` and `npm-shrinkwrap.json`. The
repository now uses pnpm. The verifier templates install with
`pnpm install --frozen-lockfile --ignore-scripts`
([`policy/templates/cq-verify.yml`](../../policy/templates/cq-verify.yml)),
and the protected-path set also covers `pnpm-lock.yaml`,
`pnpm-workspace.yaml` and `.pnpmfile.*`
([`src/ops/gates/protectedPaths.ts`](../../src/ops/gates/protectedPaths.ts)).
The rules are unchanged: a frozen lockfile install with lifecycle scripts
disabled, and every lockfile and package-manager config in the definition
set. For this repository's own checks, read the npm names as the
equivalent pnpm ones. D-E's adopter install (`npm ci --ignore-scripts`, then
`npm audit signatures`) is unchanged.

### N10 — ADR-0002 §2.5 and §2.8: no `./driver` subpath yet

§2.5 and §2.8 ship the lane classes and `runDriverConformance` from a
`./driver` package subpath. The package does not export that subpath yet:
[`package.json`](../../package.json) `exports` has only `.`, so an import from
`@camerontaylor/cq-toolkit/driver` fails. The driver barrel
([`src/driver/index.ts`](../../src/driver/index.ts)), including the four lane
classes and `runDriverConformance`, is re-exported from the package root, so
consumers import them from `@camerontaylor/cq-toolkit` until the subpath is
added.

### N11 — ADR-0002 §3, ADR-0003 §2.5 and the approval-token annex §4c: O-1, O-5 and O-8 settled in code

Three points left open at acceptance are resolved by the implementation; none
rewrites a decision.

- **O-1 (ADR-0002 §3, the `RunOptions` collision).** The root barrel exports
  the seam's per-call options as `DriverRunOptions` — an explicit aliased
  export that beats the driver star-export at the barrel tail — and the kernel
  plan-run `RunOptions` keeps the root name. The seam's `BudgetReservation`
  gets the same treatment as `DriverBudgetReservation`
  ([`src/index.ts`](../../src/index.ts)).
- **O-5 (approval-token annex §4c, where the mutation lock's record lives).**
  The record lives beside the operator approval ledger in the P1-trusted
  layer, keyed on the sha256 of the workspace's enclosing git worktree root —
  the annex keyed the lock on `sha256(realpath(workspace))`, and the shipped
  key is the worktree root, so every path into the same workspace computes the
  same record. The annex's two rejected candidates are excluded on evidence:
  an environment-derived location reintroduces §2.5's split-brain, and a
  record inside the workspace is tamper vector #26
  ([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts),
  `makeLedgerBesideMutationLocks`).
- **O-8 (ADR-0003 §2.5 acquire step 4, the empty or half-written record).**
  §2.5's `open('wx')`-then-write publish could leave an empty canonical
  record. The implemented publish is whole-record: a synced temporary is
  published by exclusive `link(2)`, and replacing a record goes through an
  exclusive succession claim (`<lock>.<nonce>.claim`), so an empty or
  half-written canonical record cannot occur; an unparseable one refuses
  (`journal: corrupt or half-written plan lock …`) instead of being stolen
  ([`src/kernel/journal.ts`](../../src/kernel/journal.ts), `publishRecord`,
  `claimSuccession`).

### N12 — Approval-token annex §4c step 1: the clean predicate exempts the verified report pair

§4c step 1 requires `git status --porcelain=v1 --untracked-files=all` empty.
applyRemediation's own rendered report pair (markdown + sidecar) is
deliberately exempt, and narrowly: the exercise verifies the exact pair —
paths derived from a 16-hex fingerprint, bytes matched against SHA-256s
carried on the subject and bound into its `inputDigest` — at BOTH state reads
before granting the exception, and every other subject keeps the strict
predicate unchanged
([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts),
`verifiedAnalysisReportPaths`). Read the clean predicate as strict, with this
one byte-verified, input-bound exemption.

### N13 — ADR-0003 §2.3 and §2.5: the early-stop widening and `budget.breakLock` are descoped

§2.3 widens `RunEarlyStopReason` to six values and §2.5 names
`budget.breakLock=<runId>` as a journalled opt-in. Neither is in force,
deliberately: the type is still `'budget' | 'signal'`
([`src/kernel/types.ts`](../../src/kernel/types.ts)), and the kernel's
`GovernanceOptIn` union carries only the three ledger keys —
`budget.breakLock` exists as a per-call string in the config registry
([`src/config/registry.ts`](../../src/config/registry.ts), `CALL_ONLY_CONFIG`)
but not in the kernel union, so a foreign-host lock refusal cannot currently
be broken by opt-in. Recorded as a descope so the accepted lines are not read
as shipped behaviour.

### N14 — Annex A §A.4: the MCP config file name gains a per-run uuid

§A.4 names the binding file `<sessionsDir>/<sessionId>.cq-harness-mcp.json`.
The lane creates `<sessionsDir>/<sessionId>.<run-uuid>.cq-harness-mcp.json` —
unique per run; still created exclusively (`O_EXCL`) with mode 0600, never in
the workspace, deleted as soon as `system/init` reports the harness connected
and again at settle — so two concurrent runs over one session can never read,
replace or delete each other's binding. Deliberate hardening of the accepted
shape
([`src/driver/subprocess/index.ts`](../../src/driver/subprocess/index.ts),
`HARNESS_MCP_CONFIG_FILE`).

### N15 — Annex B §B.4, §B.6 and §B.9: the profile suffix and three CI-mapping rows

Two alignments with [`src/config/registry.ts`](../../src/config/registry.ts);
neither changes a decision.

- **Profiles ship as `.profile`, not `.env`.** §B.4.1 and §B.9 say
  `policy/profiles/<name>.env`; the bundled profiles are
  `policy/profiles/<name>.profile`, because `.env`-shaped files are
  deliberately scanned as key material by the denylist, so a profile must not
  be one. §B.4.1's rule is unchanged: profiles load only from the installed
  toolkit package, never from the workspace.
- **CI mapping.** §B.6.5's `ci: false` list reads, in code:
  `CQ_APPROVAL_MAX_TTL_MS` is `ci: 'vars'` (a duration, not a path — the
  blanket `CQ_APPROVAL_*` path rule does not cover it); every
  `CQ_PROVIDER_<ID>_PROFILE` is `ci: false` (not only `custom:` values); and
  `CQ_DRIVER_ACP_ENDPOINT` sits in the path/executable `ci: false` set beside
  `CQ_DRIVER_ACP_COMMAND`.

### N16 — ADR-0004 D-K.7: the gate sweep interval is every 15 minutes

D-K.7 left the gate sweep's interval unspecified (open point O-7). Decided:
every 15 minutes (`cron: '7,22,37,52 * * * *'`), so a missed wake-up delays
promotion by at most 15 minutes
([`policy/templates/gate.yml`](../../policy/templates/gate.yml)). The
`cq-signal` sweep's separate automation-window cadence is unchanged and still
does not bound promotion.

### N17 — ADR-0004 D-B: `cq-signal` also triggers on pushes to `merge-queue`

D-B lists `cq-signal`'s triggers as the seven `pull_request` types,
`pull_request_review` and `pull_request_review_comment`. The shipped template
adds `push: [merge-queue]`, so a queue advance re-fires the verifiers without
a PR event
([`policy/templates/cq-signal.yml`](../../policy/templates/cq-signal.yml)).
The trigger changes nothing about trust: `cq-signal` remains a wake-up only
(`permissions: {}`, empty body) — exactly D-A.4's head-defined
untrusted-producer class; D-A.2's push exclusion is for privileged or
deciding jobs, which `cq-signal` is not — and every verdict is still
recomputed from the API by `head_sha`.
