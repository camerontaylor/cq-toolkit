# Current contract and backlog

- **Dated:** 2026-10-24.
- **Source:** seeded from toolkit-research `research/research-20261022-status-consolidation/consolidation.md` §2 (contract) and §3 (backlog triage), under owner decisions 5–7 of 2026-10-24 (`specs/cq-next-step-slice-decisions-20261024.md`).
- **Supersedes:** this page supersedes the 2026-09-12 spec (`specs/portable-code-quality-toolkit-spec.md` in toolkit-research) as the normative contract. The spec and all pre-2026-10-16 plans carry a historical header and are kept for reference.
- **Next step:** the approved next-step spec and plan live in toolkit-research at `specs/cq-next-step-slice-spec.md` and `plans/cq-next-step-slice-plan.md`.

## Current contract

1. **SDK first; every op runnable standalone from TS and the CLI.** Spec, 2026-09-12. _Amended:_ ADR-0005 (2026-10-16) found it "met in letter, missed in default wiring". The 2026-10-20 posture makes CLI usability the goal and fresh-repo transcripts the acceptance bar.
2. **I1 output contract.** JSON on stdout, narration on stderr, exits 0/1/2/3. _Extended_ on 2026-10-20 by `--fail-on-verdict` and a `--json` error artifact. Flags only, no positionals.
3. **Generic mechanism only, zero webfront-isms, webfront untouched** (2026-09-12). Unchanged.
4. **Public MIT; first npm release `0.2.0`, never 1.x.** The publication gate is CI green + packed-artifact smoke (#394); G2/G3 as written are retired (see [Retirements](#retirements-2026-10-24)).
5. **Topology.** A six-package monorepo absorbing crq and `packages/eval` (ADR-0005). Phase 2 is narrowed to `@cq/policy` + `@cq/ops` and comes after the acceptance exercise.
6. **Pluggable driver seam, vendor-neutral kernel.** _Amended_ from 4 lanes to 3 (ADR-0005).
7. **Model choice is configuration, never a literal** (owner, 2026-10-16). cq-toolkit's root cq.json is tsc-only until #411.
8. **Tokens are the source of truth; USD is modeled only; the governor enforces a token budget.** Spend must be reported on every exit path of the new agentic commands (#393).
9. **Remediation is approval-gated; nothing is auto-applied.** _Realised_ 2026-10-20 as an attended authority bound to the preview digest and a clean tree.
10. **Workers may not commit tests, runner config or snapshots** (W1.8). Enforced in sweep, not in `analyze.fix`.
11. **Baselines only tighten; a missing summary is non-passing; the monotonic guard is mandatory.**
12. **Review = one CodeRabbit CLI cycle, or visible durable vendor debt under approved DEC1, plus one independent head-bound review; P2s go to issues** (2026-10-16; DEC1, 2026-10-27). During vendor availability/rate-limit/login outages, development and merge may continue before vendor recovery after authorized durable enrollment. Vendor completion remains false; queue authorization/persistence, scan/tamper, stale identity, unknown failures, substantive blocking findings, CI, independence and privileged trust still block. Supersedes the 0.2 plan's two cycles. Lifecycle: [CodeRabbit protocol](coderabbit-review.md#6-completion-semantics-and-blockers).
13. **Acceptance = independent PASS on the exact head, not draft, right base; unresolved threads are reported, not blocking** (2026-10-20).
14. **Author evidence is a claim; verification uses only facts an owner credential cannot write** (2026-10-16).
15. **The PR is not development state; every checkable rule is a command** (2026-10-16).
16. **Gates are advisory; only the privileged list needs a human** (2026-10-20). `cq/policy` is not required; the `cq-override` label is parked.
17. **Must stay blocking:** fail-closed denylist before upload; core CI at the exact SHA; independent head-bound PASS with no P0/P1; FF-only promotion with no force-push of `main`/`cq/promoted`/replay markers; owner sign-off on credentials, signer custody and deploy trust. Unchanged.
18. **Merge commits only in the engine; promotion is FF-only.** Practice: `automerge.sh` merges; promotion needs break-glass FF until #376.
19. **Self-hosting proves the toolkit** (spec DoD 2). _Scaled back_ 2026-10-20: review loop off, self-merge off, re-enable only with a fixes-per-run metric.
20. **Freeze new self-host machinery until S1–S6 ship** (2026-10-20). S1–S6 shipped 2026-10-20; whether the freeze lifted is a GAP.
21. **Local tests are narrow, on triton, one run at a time; CI is the full-suite authority** (owner, 2026-10-11/10-14). Per-package suites come after the ops cut.
22. **Protect the deployed system, not in-development code** (2026-10-18).
23. **Greenfield, low vigilance: the chancellor merges, acks and FFs; the owner is asked only about credentials, settings and direction** (2026-10-19/20).
24. **"No staging, one coherent v1"** — dropped in practice by the 0.2 decision and incremental slices; not formally struck.
25. **Fixtures/eval must produce scored per-role comparisons** — deferred; owner-blocked on keys and spend.

## Backlog

Class key from consolidation.md §3: **C** = carry into the next step, **P** = park (issue filed), **R** = retire with a note ([Retirements](#retirements-2026-10-24)).

### Carried (C)

| Item                                                                                  | Notes                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ops standalone in default wiring                                                      | The gap behind every "No" in the capability register; the developer-loop slices address it |
| W2.1 spend on every exit path                                                         | #393                                                                                       |
| Packed-artifact smoke test (release gate)                                             | #394                                                                                       |
| #376 follow-up: crq deploy controller                                                 | #395, parallel, owner deploy-trust sign-off                                                |
| oxlint-json check adapter                                                             | #396; cq.json omits lint until Oxlint ships an eslint-format output                        |
| #378 configurable checks + Ruff/Knip adapters                                         | #378; blocks `review` portability                                                          |
| Phase 0.4 version alignment                                                           | Cheap; package.json 1.0.1 contradicts README                                               |
| `policy/dev-protocol.json`, `docs/dev-protocol.md`                                    | Not privileged any more; fold into this page over time                                     |
| #377 App merger (after), DS `pr.verify`/`pr.merge`/`pr.run`/`pr.review --independent` | Chancellor practice covers them; revisit with #377                                         |
| #381/#382/#385 P2 batches                                                             | Unchanged                                                                                  |
| #351/#362/#363 review-loop defects                                                    | Correctness of address-review                                                              |
| #352 agent fallback reviewer, #353 `--uncommitted`                                    | `review` usability                                                                         |
| #386 hex cluster ids, #387 analyze follow-ups                                         | #386 (being closed by the S0 merge), #387                                                  |
| Phase 1.8 contract revision                                                           | This page (merged into the "current contract")                                             |
| Phase 1 acceptance exercise                                                           | The test for address-review; plan S6                                                       |
| DS `pr.address`                                                                       | The address-review command itself (`review.address`, S6)                                   |
| Per-file fan-out                                                                      | In scope for S2 (not a not-planned issue)                                                  |
| Re-request review inside address-review                                               | Small forge action; decision 1                                                             |

### Not planned (owner decision 7, 2026-10-24)

Filed for the record, then closed as not planned; none is pulled into the developer-loop step (§3 class R).

| Item                                    | Issue |
| --------------------------------------- | ----- |
| Prep-only entry point                   | #397  |
| `recover` entry point                   | #398  |
| Run listing                             | #399  |
| merge-prs `--admin`                     | #400  |
| Three-tier command resolution           | #401  |
| Complexity ceilings                     | #402  |
| `trace`                                 | #403  |
| Sweep/orchestration/substrate benchmark | #404  |
| fleet-devenv                            | #405  |
| Watchlist R3–R5                         | #406  |

### Parked (P)

| Item                                                          | Issue | Rationale                                |
| ------------------------------------------------------------- | ----- | ---------------------------------------- |
| npm publication 0.2.0                                         | #394  | After the packed-artifact smoke test     |
| Fixtures/eval valid evidence (W6.5/W6.7, fixtures flip)       | —     | Owner-blocked on keys and spend          |
| W4.1 governed sweep composition                               | —     | Becomes the sweep slice                  |
| Slice F fixtures governance                                   | —     | Goes with eval absorption                |
| W1.2b F1 REST cross-check                                     | —     | Revisit inside address-review if needed  |
| Review debt #216/#241/#242, #225/#226                         | —     | Triage as ordinary issues                |
| Adversarial suite and certified backends                      | —     | Not needed for local commands            |
| External-contribution safeguards                              | —     | Only matters before outside contributors |
| Phase 1.1/1.3 helpers, 1.5–1.7, 1.9b ACP, 1.9c cost estimator | —     | They do not make a command work          |
| Phase 2 package cut; Phase 3/4                                | —     | After the slice                          |
| DS verification tier `pr.address` siblings                    | —     | See the `pr.*` parked row above          |
| Single crq review issuer                                      | —     | Depends on D-H                           |
| #354 diff-scoped denylist                                     | —     | Privileged; needs a human                |
| #341 stale ratchet proposal                                   | —     | Unrelated to the five commands           |
| D9 spend envelope                                             | —     | Revive with eval                         |
| v1 §6 publication checklist                                   | —     | Goes with publication                    |
| WB1 model-fidelity retraction                                 | —     | Cheap honesty item; file later           |
| Conflict-agent wall-clock #137                                | —     | merge-prs slice                          |
| Per-fix diff verification tier                                | —     | `verifyReviewOutcome` covers PR level    |

### Retired (R)

See [Retirements (2026-10-24)](#retirements-2026-10-24) below.

## Retirements (2026-10-24)

Dated per owner decision 6 (`specs/cq-next-step-slice-decisions-20261024.md`, 2026-10-24). The following are retired from the contract and backlog as written:

- **0.2 hardening W-items** (W2.5+W3.2 inventory, W3.1 export baseline, W0.11 hygiene, W8 decomposition, sweep-lifecycle shrink, file-size targets): overtaken by the migration and the Phase 0.2 deletions.
- **G2/G3 as written**: never redefined; the release gate is now **CI green at the exact SHA plus the packed-artifact smoke test** (#394).
- **WS-K soak** (self-host DoD 2 / hardening DoD 3 / W7.3 arming / 3-day dry run): replaced by the fixes-per-run metric; the waiver is recorded here.
- **Test-rationing P0–P7**: superseded by D-G (per-package suites at the ops cut) and the 2026-10-11 test rule.
- **Exec-policy A-baseline / E-audit**: superseded by D-G and the 2026-10-11 rule.
- **Runaway-remediation residuals**: fleet issue, belongs outside cq-toolkit.
- Also retired with a note: the "no staging" clause (dead in practice), HARD fixer demonstration (replaced by per-command fresh-repo transcripts), DS `lane.brief`/`lane.verify`/`quota.status` (orchestration tooling, not toolkit capability), crq repair-loop activation (absorbed by D-H, `repair.enabled=false`), D-T1/D-T2, COLLABORATOR trust, macOS-required, conductor restart (overtaken by C2/C3 and the posture).

**Release gate (normative, from 2026-10-24):** CI green at the exact SHA + packed-artifact smoke test (#394).
