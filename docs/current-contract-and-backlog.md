# Current contract and backlog

- **Dated:** 2026-10-24.
- **Source:** seeded from toolkit-research `research/research-20261022-status-consolidation/consolidation.md` §2 (contract) and §3 (backlog triage), under owner decisions 5–7 of 2026-10-24 (`specs/cq-next-step-slice-decisions-20261024.md`).
- **Supersedes:** this page supersedes the 2026-09-12 spec (`specs/portable-code-quality-toolkit-spec.md` in toolkit-research) as the normative contract. The spec and all pre-2026-10-16 plans carry a historical header and are kept for reference.
- **Next step:** the approved next-step spec and plan live in toolkit-research at `specs/cq-next-step-slice-spec.md` and `plans/cq-next-step-slice-plan.md`.

## Current contract

1. **SDK first; every op runnable standalone from TS and the CLI.** Spec, 2026-09-12. _Amended:_ ADR-0005 (2026-10-16) found it "met in letter, missed in default wiring". The 2026-10-20 posture makes CLI usability the goal and fresh-repo transcripts the acceptance bar.
2. **I1 output contract.** JSON on stdout, narration on stderr, exits 0/1/2/3. _Extended_ on 2026-10-20 by `--fail-on-verdict` and a `--json` error artifact. Flags only, no positionals.
3. **Generic mechanism only, zero webfront-isms, webfront untouched** (2026-09-12). Unchanged.
4. **Public MIT; first npm release `0.2.0`, never 1.x.** Publication is gated on the packed-artifact smoke test (#394); G2/G3 as written are retired (see [Retirements](#retirements-2026-10-24)).
5. **Topology.** A six-package monorepo absorbing crq and `packages/eval` (ADR-0005). Phase 2 is narrowed to `@cq/policy` + `@cq/ops` and comes after the acceptance exercise.
6. **Pluggable driver seam, vendor-neutral kernel.** _Amended_ from 4 lanes to 3 (ADR-0005).
7. **Model choice is configuration, never a literal** (owner, 2026-10-16).
8. **Tokens are the source of truth; USD is modeled only; the governor enforces a token budget.** Spend must be reported on every exit path of the new agentic commands (#393).
9. **Remediation is approval-gated; nothing is auto-applied.** _Realised_ 2026-10-20 as an attended authority bound to the preview digest and a clean tree.
10. **Workers may not commit tests, runner config or snapshots** (W1.8). Enforced in sweep, not in `analyze.fix`.
11. **Baselines only tighten; a missing summary is non-passing; the monotonic guard is mandatory.**
12. **Review = one CodeRabbit CLI cycle plus one independent head-bound review; P2s go to issues** (2026-10-16). Supersedes the 0.2 plan's two cycles.
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

| Item                                                        | Notes                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ops standalone in default wiring                            | The gap behind every "No" in the capability register; the developer-loop slices address it |
| W2.1 spend on every exit path                               | #393                                                                                       |
| Packed-artifact smoke test (release gate)                   | #394                                                                                       |
| #376 follow-up: crq deploy controller                       | #395, parallel, owner deploy-trust sign-off                                                |
| oxlint-json check adapter                                   | #396; cq.json omits lint until Oxlint ships an eslint-format output                        |
| #378 configurable checks + Ruff/Knip adapters               | #378; blocks `review` portability                                                          |
| Phase 0.4 version alignment                                 | Cheap; package.json 1.0.1 contradicts README                                               |
| #377 App merger (after), DS `pr.verify`/`pr.merge`/`pr.run` | Chancellor practice covers them; revisit with #377                                         |
| `policy/dev-protocol.json`, `docs/dev-protocol.md`          | Not privileged any more; fold into this page over time                                     |
| #381/#382/#385 P2 batches                                   | Unchanged                                                                                  |
| #351/#362/#363 review-loop defects                          | Correctness of address-review                                                              |
| #352 agent fallback reviewer, #353 `--uncommitted`          | `review` usability                                                                         |
| Per-file fan-out                                            | In scope for S2 (not a not-planned issue)                                                  |
| Re-request review inside address-review                     | Small forge action; decision 1                                                             |

### Parked (P) — issue filed

| Item                                                          | Issue | Rationale                                       |
| ------------------------------------------------------------- | ----- | ----------------------------------------------- |
| Prep-only entry point                                         | #397  | Sweep slice                                     |
| `recover` entry point                                         | #398  | Shipped composition/config-only answer ratified |
| Run listing                                                   | #399  | Sweep slice                                     |
| merge-prs `--admin`                                           | #400  | Conflicts with "no admin over red checks"       |
| Three-tier command resolution                                 | #401  | Shipped fail-closed answer ratified             |
| Complexity ceilings                                           | #402  | Not needed for the developer-loop step          |
| `trace`                                                       | #403  | Not needed for the developer-loop step          |
| Sweep/orchestration/substrate benchmark                       | #404  | Never performed; not needed locally             |
| fleet-devenv                                                  | #405  | Out of toolkit scope since Round 0              |
| Watchlist R3–R5                                               | #406  | Owner may rescue later                          |
| npm publication 0.2.0                                         | #394  | After the packed-artifact smoke test            |
| Fixtures/eval valid evidence (W6.5/W6.7, fixtures flip)       | —     | Owner-blocked on keys and spend                 |
| W4.1 governed sweep composition                               | —     | Becomes the sweep slice                         |
| Slice F fixtures governance                                   | —     | Goes with eval absorption                       |
| W1.2b F1 REST cross-check                                     | —     | Revisit inside address-review if needed         |
| Review debt #216/#241/#242, #225/#226                         | —     | Triage as ordinary issues                       |
| Adversarial suite and certified backends                      | —     | Not needed for local commands                   |
| External-contribution safeguards                              | —     | Only matters before outside contributors        |
| Phase 1.1/1.3 helpers, 1.5–1.7, 1.9b ACP, 1.9c cost estimator | —     | They do not make a command work                 |
| Phase 2 package cut; Phase 3/4                                | —     | After the slice                                 |
| DS verification tier `pr.address` siblings                    | —     | See `pr.*` row above                            |
| Single crq review issuer                                      | —     | Depends on D-H                                  |
| #354 diff-scoped denylist                                     | —     | Privileged; needs a human                       |
| #341 stale ratchet proposal                                   | —     | Unrelated to the five commands                  |
| Runaway-remediation residuals                                 | —     | Fleet issue, belongs outside cq-toolkit         |
| D9 spend envelope                                             | —     | Revive with eval                                |
| v1 §6 publication checklist                                   | —     | Goes with publication                           |
| WB1 model-fidelity retraction                                 | —     | Cheap honesty item; file later                  |
| Conflict-agent wall-clock #137                                | —     | merge-prs slice                                 |
| Per-fix diff verification tier                                | —     | `verifyReviewOutcome` covers PR level           |

### Retired (R)

See [Retirements (2026-10-24)](#retirements-2026-10-24) below.

## Retirements (2026-10-24)

Dated per owner decision 6 (`specs/cq-next-step-slice-decisions-20261024.md`, 2026-10-24). The following are retired from the contract and backlog as written:

- **0.2 hardening W-items** (W2.5+W3.2 inventory, W3.1 export baseline, W0.11 hygiene, W8 decomposition, sweep-lifecycle shrink, file-size targets): overtaken by the migration and the Phase 0.2 deletions.
- **G2/G3 as written**: never redefined; the release gate is now **CI green at the exact SHA plus the packed-artifact smoke test** (#394).
- **WS-K soak** (self-host DoD 2 / hardening DoD 3 / W7.3 arming / 3-day dry run): replaced by the fixes-per-run metric; the waiver is recorded here.
- **Test-rationing P0–P7**: superseded by D-G (per-package suites at the ops cut) and the 2026-10-11 test rule.
- **Exec-policy A-baseline / E-audit**: superseded by D-G and the 2026-10-11 rule.
- **Runaway-remediation residuals**: fleet issue, belongs outside cq-toolkit (#405-adjacent; parked item above records the class P variant).
- Also retired with a note: the "no staging" clause (dead in practice), HARD fixer demonstration (replaced by per-command fresh-repo transcripts), DS `lane.brief`/`lane.verify`/`quota.status` (orchestration tooling, not toolkit capability), crq repair-loop activation (absorbed by D-H, `repair.enabled=false`), D-T1/D-T2, COLLABORATOR trust, macOS-required, conductor restart (overtaken by C2/C3 and the posture).

**Release gate (normative, from 2026-10-24):** CI green at the exact SHA + packed-artifact smoke test (#394).
