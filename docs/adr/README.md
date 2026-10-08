# Architecture decision records

The owner accepted ADR-0001 through ADR-0004 at G1 on 2026-09-26. These
files are published copies of the reconciled texts. They were drafted in the
private `toolkit-research` repository, so references to research paths,
critic verdicts and disposition files point at that repository and are not
published here.

Each ADR is a historical design record. The text records what was accepted
and is not rewritten when the implementation later diverges. A later
decision that changes or narrows an accepted one is recorded under
[Post-acceptance notes](#post-acceptance-notes), which point at the
superseding source.

| ADR                                                                           | Research source (commit:path)                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [0001 — worker/driver seam](0001-worker-driver-seam.md)                       | `bf5f540:plans/adr/0001-worker-driver-seam.md`                           |
| [0002 — worker/driver seam v2](0002-worker-driver-seam-v2.md)                 | `bf5f540:research/research-20260925-v11/adr-0002-draft.md`               |
| [0002 Annex A — MCP harness server](0002-annex-a-mcp-harness.md)              | `3953ad6:research/research-20260925-v11/adr-0002-annex-a-mcp-harness.md` |
| [0002 Annex B — configuration keys](0002-annex-b-config.md)                   | `767819d:research/research-20260925-v11/adr-0002-annex-b-config.md`      |
| [0003 — governed runner](0003-governed-runner.md)                             | `bf5f540:research/research-20260925-v11/adr-0003-draft.md`               |
| [0003 annex — approval token](0003-approval-token.md)                         | `bf5f540:research/research-20260925-v11/adr-0003-approval-token.md`      |
| [0003 annex — journal v2](0003-journal-migration.md)                          | `bf5f540:research/research-20260925-v11/adr-0003-journal-migration.md`   |
| [0004 — policy-check trust boundaries](0004-policy-check-trust-boundaries.md) | `bf5f540:research/research-20260925-v11/adr-0004-draft.md`               |

The copies differ from their sources only in a publication or acceptance
header, links to the annex files, references to unpublished files reworded
as private, and formatting. Rechecked on 2026-10-08: no source above has
changed since its listed commit.

## Post-acceptance notes

Recorded 2026-10-08 against `merge-queue` `4cf42d5`. Each note names the
accepted text, what changed or remains open, and where the current source of
truth lives.

### ADR-0003 §2.9 — `signal` exit codes conflict with doctrine I1

§2.9 maps the `signal` early stop to 130 (SIGINT) and 143 (SIGTERM) and
records a widening of the exit contract from four codes to six. Doctrine
[I1](../../policy/DOCTRINE.md) is canonical and fixes the codes at
`{0,1,2,3}`. The implementation follows I1: `signal` maps to 3, like a
needs-human stop ([`src/cli/exit.ts`](../../src/cli/exit.ts) header). The
130/143 row and the widening bullet are **not in force** unless I1 is
amended. That amendment is an owner decision and has not been taken.

### ADR-0002 Annex A §A.3 — `2026-07-28` is not a supported revision

§A.3 lists `2024-11-05` … `2026-07-28` as the supported set. The `2026-07-28`
MCP revision removes the `initialize` handshake and requires
`server/discover`, which this initialize-based server does not implement. The
server no longer advertises it: the newest supported revision is `2025-11-25`
([`src/harness/mcp/server.ts`](../../src/harness/mcp/server.ts),
`SUPPORTED_PROTOCOL_VERSIONS`). Serving `2026-07-28` needs a
`server/discover` implementation first.

### ADR-0002 Annex B §B.3 and §B.8.7 — `WINDOW_FRACTIONS` values

§B.3 restricts `map` values to `[a-z0-9*/-]+`, but §B.8.7 documents
`WINDOW_FRACTIONS` values such as `5h:0.2,weekly:0.5`. The worked examples
state the intent: the values are decimal fractions. The configuration
registry is not implemented yet. When it lands, its parser must accept a
decimal value for `WINDOW_FRACTIONS`, either through a fraction value type
for that key or a `.` in the map value grammar. The env-key `map` grammar for
`CQ_DRIVER_BINDINGS` is unaffected.

### ADR-0002 Annex B decision, §B.5 and §B.7 — secret source

The Decision section says secrets come from the env layer only, but §B.5's CQ
secret row allows an SDK typed option, and §B.7's
`secrets[...].layer` admits `'env' | 'call'`. The implementation follows the
env-only rule: `CQ_AUTOMATION_TOKEN` is read from the environment and nowhere
else ([`src/ops/ratchet/effects.ts`](../../src/ops/ratchet/effects.ts),
`ghEnv`). Until the registry defines a journaled `call` source, read the CQ
secret row as env-only and `layer` as `'env'`.

### ADR-0003 approval-token annex §7 — same-workspace non-approval writers

§4c leaves O-6 open (non-approval writers do not take the mutation lock), and
§7's concurrent-writer case tests "the O-6 rule". That case is conditional on
O-6 being decided and is not a closed guarantee. O-6 is resolved only for the
analyze remediation path, where every write is approval-gated and holds the
lock ([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts)
header). A writer outside the lock remains ADR-0003 §2.7's open residual.

### ADR-0003 §2.7 — which refusals are non-burning

§2.7 says "every pre-write refusal is non-burning". The approval-token annex
§4c appends the nonce to the operator ledger before the journal's
`approval-consumed` record, and says that a crash between the two burns the
token. Read §2.7 as: every refusal **before the operator-ledger append** is
non-burning. A failure after that append, including a failed journal append
or a ledger sync or close fault, may leave the token spent, and the operator
re-approves ([`src/ops/analyze/approval.ts`](../../src/ops/analyze/approval.ts),
`exercise`). The journal `approval-consumed` step is not implemented yet
([`src/ops/analyze/NOTES.md`](../../src/ops/analyze/NOTES.md)).

### ADR-0004 D-C.2 and D-F.2 — pagination and run conclusions

D-C.2's `GET /commits/{sha}/pulls` lookup is a REST list and must paginate.
`cq-verify` and `cq-policy` do
([`policy/templates/cq-verify.yml`](../../policy/templates/cq-verify.yml)).
D-F.2 lists the run lookup and the runner/step checks but not the
conclusions. The promotion gate also requires a completed run with
conclusion `success`, at least one job, and every job completed `success`; a
`skipped` job is not success
([`src/selfhost/promote-gate.ts`](../../src/selfhost/promote-gate.ts),
`checkVerifiedRun`).

### ADR-0004 D-D.2, D-H.3 C3 and Appendix C — the drill credential

D-D.2 bars any human-authenticating credential from the repository's
workflows and environments once W1.10 completes. Appendix A finding 4 and
Appendix C move the live-merge drill's credential to a non-collaborator
second identity, which cannot produce trust-set records, and keep its PAT in
the `drill` environment. D-D.2 states no exception for it, and C3 revokes
only `GH_TOKEN` and `PROMOTE_TOKEN`. The settings template allowlists the
drill PATs permanently, outside the interim set
([`policy/templates/github-settings.json`](../../policy/templates/github-settings.json),
`drill`). Before C3, the owner must decide one of two things: D-D.2 gains an
explicit exception for the second identity's drill PAT, or C3 also revokes it
and the drill moves to non-human authentication.
